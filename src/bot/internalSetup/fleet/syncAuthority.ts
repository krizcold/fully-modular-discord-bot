// Master-side sync revision authority (fleet mode only; never constructed
// standalone). Owns the monotonic revision persisted to
// /data/global/fleet/sync.json, recomputes the manifest on debounced bump()
// and on the 15s backstop, and pushes SYNC_STATE to workers. Persist or push
// failures must never take the master down.

import * as fs from 'fs';
import * as path from 'path';
import { FLEET_DIR, SYNC_BUMP_DEBOUNCE_MS, SYNC_CHUNK_BYTES, SYNC_RECONCILE_MS } from './constants';
import { atomicWriteFileSync } from './fileControlStore';
import { dataPath } from '../../../utils/dataRoot';
import { getSourceModulesDir } from '../utils/pathHelpers';
import { assertSyncableSize, buildModuleEntries, isPathInScope, isValidModuleName, listModuleFiles, listScopeFiles, manifestHashesEqual, buildSyncManifest, resolveScopeFile } from './syncManifest';
import { MSG, SyncFileScope, SyncManifest, SyncModuleBeginRequest, SyncReadRequest } from './protocol';

interface PersistedSync {
  revision: number;
  hashes: {
    appstoreHash: string;
    configHash: string;
    settingsHash: string;
    globalDataHash: string;
    modules: { name: string; contentHash: string }[];
  };
  updatedAt: number;
}

export interface SyncAuthorityHooks {
  /** Connected co-worker nodeIds with their last heartbeat sync fields. */
  listWorkers: () => { nodeId: string; nodeName: string; syncAppliedRevision: number | null; syncOk: boolean | null }[];
  /** SYNC_STATE push (request/ack); rejection means the worker will be caught by the backstop. */
  pushToNode: (nodeId: string, state: { term: number; manifest: SyncManifest }) => Promise<any>;
  getTerm: () => number;
}

const FILE_SCOPES: SyncFileScope[] = ['appstore', 'config', 'settings', 'globaldata'];

/**
 * Serve a worker's pull request. Reads are stateless fs.open/read at offset
 * (fully resumable); every path resolves through the traversal guard.
 */
export async function serveSyncRequest(authority: SyncAuthority, type: string, data: any): Promise<any> {
  switch (type) {
    case MSG.SYNC_FILES: {
      const scope = data?.scope as SyncFileScope;
      if (!FILE_SCOPES.includes(scope)) throw new Error(`unknown sync scope: ${scope}`);
      return { revision: authority.getRevision(), files: listScopeFiles(scope) };
    }
    case MSG.SYNC_MODULE_BEGIN: {
      const { name } = data as SyncModuleBeginRequest;
      if (!isValidModuleName(name)) {
        throw new Error(`invalid module name: ${name}`);
      }
      if (!fs.existsSync(path.join(getSourceModulesDir(), name))) {
        throw new Error(`module not present on master: ${name}`);
      }
      const entry = buildModuleEntries().find(m => m.name === name);
      if (!entry) throw new Error(`module not present on master: ${name}`);
      return {
        revision: authority.getRevision(),
        name,
        version: entry.version,
        commit: entry.commit,
        contentHash: entry.contentHash,
        files: listModuleFiles(name),
      };
    }
    case MSG.SYNC_READ: {
      const req = data as SyncReadRequest;
      const scope = req?.scope;
      if (scope !== 'module' && !FILE_SCOPES.includes(scope as SyncFileScope)) {
        throw new Error(`unknown sync scope: ${scope}`);
      }
      // Membership gate: the traversal guard only blocks escaping the scope
      // ROOT, but the config/globaldata/settings roots (/data, /data/global)
      // are far broader than the files each scope legitimately exposes. A file
      // must be an advertised member of its scope, or a registered worker could
      // read /data/.env, /data/{guildId}/**, or /data/global/fleet/** which are
      // NEVER synced. This mirrors the worker-side apply-path filter.
      if (scope === 'module') {
        if (!isValidModuleName(req.module)) throw new Error(`invalid module name: ${req.module}`);
        if (!listModuleFiles(req.module).some(f => f.path === req.path)) {
          throw new Error(`sync path not in module scope: ${req.path}`);
        }
      } else if (!isPathInScope(scope as SyncFileScope, req.path)) {
        throw new Error(`sync path not in scope: ${req.path}`);
      }
      const file = resolveScopeFile(scope, req.path, req.module);
      const offset = Number(req.offset);
      if (!Number.isInteger(offset) || offset < 0) throw new Error(`invalid offset: ${req.offset}`);
      const stat = fs.statSync(file);
      assertSyncableSize(req.path, stat.size);
      const fd = fs.openSync(file, 'r');
      try {
        const buffer = Buffer.alloc(Math.min(SYNC_CHUNK_BYTES, Math.max(0, stat.size - offset)));
        const bytesRead = buffer.length > 0 ? fs.readSync(fd, buffer, 0, buffer.length, offset) : 0;
        return {
          dataB64: buffer.subarray(0, bytesRead).toString('base64'),
          eof: offset + bytesRead >= stat.size,
        };
      } finally {
        fs.closeSync(fd);
      }
    }
    default:
      throw new Error(`unknown sync request: ${type}`);
  }
}

export class SyncAuthority {
  private manifest: SyncManifest;
  private bumpTimer: NodeJS.Timeout | null = null;
  private backstopTimer: NodeJS.Timeout | null = null;
  private recomputing = false;

  constructor(private readonly hooks: SyncAuthorityHooks) {
    const stored = this.load();
    // Boot recompute: offline edits bump the revision even with no live worker.
    const computed = buildSyncManifest(stored?.revision ?? 1);
    if (stored && this.sameHashes(stored, computed)) {
      this.manifest = computed;
    } else {
      this.manifest = { ...computed, revision: (stored?.revision ?? 0) + 1 };
      this.persist();
    }
    console.log(`[Fleet] Sync authority ready (revision ${this.manifest.revision}, ${this.manifest.modules.length} module(s))`);
    this.backstopTimer = setInterval(() => this.backstop(), SYNC_RECONCILE_MS);
    this.backstopTimer.unref();
  }

  getManifest(): SyncManifest {
    return this.manifest;
  }

  getRevision(): number {
    return this.manifest.revision;
  }

  /** Debounced recompute-and-publish; rapid mutations converge on the final bytes. */
  bump(scope?: string): void {
    if (this.bumpTimer) return;
    this.bumpTimer = setTimeout(() => {
      this.bumpTimer = null;
      this.recomputeAndPush(scope);
    }, SYNC_BUMP_DEBOUNCE_MS);
    this.bumpTimer.unref();
  }

  async pushTo(nodeId: string): Promise<void> {
    try {
      await this.hooks.pushToNode(nodeId, { term: this.hooks.getTerm(), manifest: this.manifest });
    } catch (error) {
      console.warn(`[Fleet] Sync state push to ${nodeId} failed (backstop retries):`, error instanceof Error ? error.message : error);
    }
  }

  private recomputeAndPush(scope?: string): void {
    if (this.recomputing) return;
    this.recomputing = true;
    try {
      const computed = buildSyncManifest(this.manifest.revision);
      if (manifestHashesEqual(computed, this.manifest)) return;
      this.manifest = { ...computed, revision: this.manifest.revision + 1 };
      this.persist();
      console.log(`[Fleet] Sync revision ${this.manifest.revision}${scope ? ` (${scope})` : ''}; pushing to workers`);
      for (const worker of this.hooks.listWorkers()) {
        void this.pushTo(worker.nodeId);
      }
    } catch (error) {
      console.warn('[Fleet] Sync manifest recompute failed:', error instanceof Error ? error.message : error);
    } finally {
      this.recomputing = false;
    }
  }

  // Catches un-instrumented write sites (Discord settings panels, payment
  // entitlements, manual edits) and re-pushes to workers that are behind or
  // reported a degraded apply.
  private backstop(): void {
    this.recomputeAndPush();
    for (const worker of this.hooks.listWorkers()) {
      const behind = (worker.syncAppliedRevision ?? -1) < this.manifest.revision;
      if (behind || worker.syncOk === false) void this.pushTo(worker.nodeId);
    }
  }

  private file(): string {
    return dataPath('global', FLEET_DIR, 'sync.json');
  }

  private load(): PersistedSync | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file(), 'utf-8')) as PersistedSync;
      if (!Number.isInteger(parsed?.revision) || parsed.revision < 1) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private sameHashes(stored: PersistedSync, computed: SyncManifest): boolean {
    const h = stored.hashes;
    if (!h) return false;
    if (h.appstoreHash !== computed.appstoreHash || h.configHash !== computed.configHash
      || h.settingsHash !== computed.settingsHash || h.globalDataHash !== computed.globalDataHash) return false;
    const storedModules = Array.isArray(h.modules) ? h.modules : [];
    if (storedModules.length !== computed.modules.length) return false;
    const byName = new Map(storedModules.map(m => [m.name, m.contentHash]));
    return computed.modules.every(m => byName.get(m.name) === m.contentHash);
  }

  private persist(): void {
    const record: PersistedSync = {
      revision: this.manifest.revision,
      hashes: {
        appstoreHash: this.manifest.appstoreHash,
        configHash: this.manifest.configHash,
        settingsHash: this.manifest.settingsHash,
        globalDataHash: this.manifest.globalDataHash,
        modules: this.manifest.modules.map(m => ({ name: m.name, contentHash: m.contentHash })),
      },
      updatedAt: Date.now(),
    };
    try {
      atomicWriteFileSync(this.file(), JSON.stringify(record, null, 2));
    } catch (error) {
      console.warn('[Fleet] Sync revision persist failed:', error instanceof Error ? error.message : error);
    }
  }
}
