// Co-worker sync apply engine (bot child). One code path serves boot
// reconcile AND live deltas: reconcile(manifest) is single-flight with
// latest-wins re-run, diffs by content hash, pulls changed bytes over the
// control channel into staging, verifies sha256, swaps atomically and
// hot-applies. awaitSyncReady() gates module loading at boot.

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { Client } from 'discord.js';
import { dataPath } from '../../../utils/dataRoot';
import { getBuildModulesDir, getModulesDir, getSourceModulesDir } from '../utils/pathHelpers';
import { recompileTypeScript, reloadModules, unloadModuleFromMemory } from '../utils/moduleReloader';
import { getModuleRegistry } from '../utils/moduleRegistry';
import { resetAppStoreManager } from '../utils/appStoreManager';
import { clearSchemaCache } from '../utils/settings/settingsDiscovery';
import { FLEET_DIR, SYNC_MAX_FILE_BYTES, SYNC_STAGING_DIRNAME } from './constants';
import { atomicWriteFileSync } from './fileControlStore';
import {
  MSG,
  SyncFileEntry,
  SyncFileScope,
  SyncManifest,
  SyncStatePayload,
} from './protocol';
import {
  assertSyncableSize,
  computeScopeHashes,
  hashFileSet,
  isPathInScope,
  isValidModuleName,
  listDirFileSet,
  listModuleDirs,
  listScopeFiles,
  manifestHashesEqual,
  moduleContentHash,
  resolveScopeFile,
} from './syncManifest';

const FILE_SCOPES: SyncFileScope[] = ['appstore', 'config', 'settings', 'globaldata'];
const VERIFY_ATTEMPTS = 3;

export type SyncStatus = 'waiting-master' | 'syncing' | 'in-sync' | 'degraded';

export interface SyncEngineState {
  revision?: number;
  appliedRevision?: number;
  status: SyncStatus;
  lastError?: string;
}

interface PersistedApplied {
  revision: number;
  manifest: SyncManifest;
  appliedAt: number;
  /** Modules whose reload/compile failed on verified bytes; restored on boot so a restart retries instead of trusting the stamp. */
  degraded?: string[];
}

export interface SyncEngineHooks {
  request: (type: string, data: any) => Promise<any>;
  getTerm: () => number;
  sendReport: (data: any) => void;
}

function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (attempt >= 3) throw error;
      const waitUntil = Date.now() + 25 * (attempt + 1);
      while (Date.now() < waitUntil) { /* Windows EPERM on rename-over-open */ }
    }
  }
}

function copyDirRecursive(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirRecursive(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

export class SyncEngine {
  private client: Client | null = null;
  private latest: SyncManifest | null = null;
  private running = false;
  private pending = false;
  private status: SyncStatus = 'waiting-master';
  private lastError: string | undefined;
  private applied: PersistedApplied | null;
  // Modules whose reload/compile failed on verified bytes; retried on every
  // subsequent reconcile (any push or backstop re-push) instead of crashing.
  private readonly degradedModules = new Set<string>();
  private stagingCounter = 0;
  private lastReportOk: boolean | null = null;
  private readyResolve: (() => void) | null = null;
  private readonly ready: Promise<void>;

  constructor(private readonly hooks: SyncEngineHooks) {
    this.ready = new Promise<void>(resolve => { this.readyResolve = resolve; });
    this.applied = this.loadApplied();
    // Restore the degraded set persisted with the stamp: without it a restart
    // after a compile-failure apply would boot with an empty set, hit the
    // idempotent guard on the master's re-push and report in-sync while the
    // loader keeps serving the stale compiled module.
    for (const name of this.applied?.degraded ?? []) this.degradedModules.add(name);
  }

  /** Resolves on the first fully-completed reconcile (verified, or degraded on verified bytes). */
  awaitSyncReady(): Promise<void> {
    return this.ready;
  }

  setClient(client: Client): void {
    this.client = client;
    // Drain any manifest that arrived in the gate-open -> attachClient window
    // (deferred by run() to keep the boot path from rewriting dist while the
    // loader reads it). Now that the client is attached, reconcile takes the
    // runtime-apply path (hot-unload + reloadModules).
    if (this.latest) void this.run();
  }

  getSyncState(): SyncEngineState {
    return {
      revision: this.latest?.revision,
      appliedRevision: this.applied?.revision,
      status: this.status,
      lastError: this.lastError,
    };
  }

  onSyncState(payload: SyncStatePayload): void {
    if (!payload?.manifest || !Number.isInteger(payload.manifest.revision)) return;
    this.latest = payload.manifest;
    void this.run();
  }

  private async run(): Promise<void> {
    // Post-gate quiescence: once the boot reconcile has completed (gate open,
    // readyResolve cleared) but the client is not yet attached, module loading
    // is reading dist. A boot-mode reconcile here would rewrite dist under the
    // loader (recompile vs loadModules race) and could stamp applied while the
    // in-memory modules stay stale. Stash the manifest; setClient() drains it
    // through the runtime-apply path. The pre-gate boot reconcile is unaffected
    // (readyResolve is still set), and loadModules cannot be running then.
    if (this.readyResolve === null && this.client === null) {
      this.pending = false;
      return;
    }
    if (this.running) {
      this.pending = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.pending = false;
        const manifest = this.latest;
        if (!manifest) break;
        await this.reconcile(manifest);
        // Boot reconcile just opened the gate but the client is not attached
        // yet: stop here even if a newer manifest queued mid-run. setClient()
        // drains this.latest through the runtime-apply path.
        if (this.readyResolve === null && this.client === null) break;
      } while (this.pending);
    } finally {
      this.running = false;
    }
  }

  private async reconcile(manifest: SyncManifest): Promise<void> {
    this.status = 'syncing';
    try {
      // A malicious/compromised master could push a module name that is not a
      // plain path segment ('..', an absolute path) which fetchModule/removeModule
      // would join straight into an fs path and escape the module root. Refuse
      // the WHOLE manifest before any fs move so a poisoned entry cannot even
      // partially apply, and leave the boot gate closed (never a verified state).
      if (!Array.isArray(manifest.modules) || !manifest.modules.every(m => isValidModuleName(m?.name))) {
        this.lastError = 'manifest rejected: invalid module name';
        this.status = 'degraded';
        this.report(false);
        console.error('[Fleet] Sync manifest rejected: a module entry has an invalid name; aborting reconcile');
        return;
      }

      // Idempotent re-entry: nothing to move, only degraded modules to retry.
      // The degraded set is restored from sync-applied.json on boot, so a
      // restart after a compile-failure apply lands here with a non-empty set
      // and actually refreshes the stale module instead of trusting the stamp.
      if (this.applied && manifest.revision <= this.applied.revision
          && manifestHashesEqual(manifest, this.applied.manifest)) {
        if (this.degradedModules.size > 0) {
          const before = this.degradedModules.size;
          if (this.client) {
            await this.applyRuntime(manifest, []);
          } else if (path.resolve(getBuildModulesDir()) !== path.resolve(getModulesDir())) {
            // Boot mode: dist is stale for the degraded module(s). Make build
            // coherent, then recompile so the loader picks up fresh dist. A
            // clean recompile from a coherent build clears the whole set; a
            // genuine env-skew failure keeps them degraded (surfaced, retried).
            this.healBuildTree(manifest);
            const compile = await recompileTypeScript();
            if (compile.success) {
              this.degradedModules.clear();
            } else {
              this.lastError = `sync recompile failed: ${compile.error ?? 'unknown'}`;
              console.error('[Fleet] Sync recompile failed on degraded retry; modules stay unloaded:', compile.error);
            }
          }
          if (this.degradedModules.size !== before) this.persistApplied(this.applied.revision, this.applied.manifest);
        }
        this.finishOk(manifest, this.applied.revision);
        return;
      }

      this.cleanupStaging();

      let removed: string[] = [];
      let fetched: string[] = [];
      let filesChanged = 0;
      let verified = false;
      for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt++) {
        if (this.pending) return;
        for (const scope of FILE_SCOPES) {
          filesChanged += await this.syncFileScope(scope);
          if (this.pending) return;
        }
        const diff = this.diffModules(manifest);
        for (const name of diff.toRemove) {
          await this.removeModule(name);
          this.degradedModules.delete(name);
        }
        for (const name of diff.toFetch) {
          await this.fetchModule(name);
          if (this.pending) return;
        }
        removed = removed.concat(diff.toRemove);
        fetched = fetched.concat(diff.toFetch);
        if (this.verifyAgainst(manifest)) {
          verified = true;
          break;
        }
      }
      if (!verified) {
        // Bytes refuse to settle (concurrent local writes?); do not stamp the
        // revision AND keep the boot gate closed - loading modules from a tree
        // whose hashes never matched any manifest is exactly the unverified
        // state the gate exists to prevent. The backstop re-push heals within
        // ~15s once the master rehashes to the settled bytes, then finishOk
        // opens the gate. Mirrors the transport/disk catch path below.
        this.lastError = 'scope hash verify failed after retries';
        this.status = 'degraded';
        this.report(false);
        console.warn('[Fleet] Sync verify failed after retries; gate stays closed until the next push heals it');
        return;
      }

      // Self-heal a build tree left stale by a crash between source-swap and
      // build-copy on a prior run (source already matches, so the module was
      // not re-fetched above). Repaired modules join the fetched set so the
      // boot recompile / runtime reload re-derives dist from the fresh build.
      const repairedBuild = this.healBuildTree(manifest);
      const uniqueFetched = [...new Set([...fetched, ...repairedBuild])];
      if (this.client) {
        await this.applyRuntime(manifest, uniqueFetched);
        if (filesChanged > 0 || uniqueFetched.length > 0 || removed.length > 0) {
          // Both singletons cache files this reconcile may have overwritten
          // (installed.json, settings schemas); per-call readers need nothing.
          resetAppStoreManager();
          clearSchemaCache();
        }
      } else if (uniqueFetched.length > 0 && path.resolve(getBuildModulesDir()) !== path.resolve(getModulesDir())) {
        // Boot mode, prod split: dist must contain the fetched modules before
        // the loader runs. A compile failure leaves the old dist serving and
        // marks the modules degraded - never a crash-loop trip.
        const compile = await recompileTypeScript();
        if (!compile.success) {
          for (const name of uniqueFetched) this.degradedModules.add(name);
          this.lastError = `sync recompile failed: ${compile.error ?? 'unknown'}`;
          console.error('[Fleet] Sync recompile failed; fetched modules stay unloaded:', compile.error);
        } else {
          for (const name of uniqueFetched) this.degradedModules.delete(name);
        }
      }

      this.persistApplied(manifest.revision, manifest);
      this.notifyApplied(manifest.revision);
      this.finishOk(manifest, manifest.revision);
      console.log(`[Fleet] Sync applied: revision ${manifest.revision} (${uniqueFetched.length} fetched, ${removed.length} removed${this.degradedModules.size > 0 ? `, degraded: ${[...this.degradedModules].join(', ')}` : ''})`);
    } catch (error) {
      // Transport loss, disk full, sha mismatch mid-pull: abort with the
      // applied revision unbumped; the reconnect/backstop re-push resumes by
      // hash diff. The boot gate stays closed on this path.
      this.lastError = error instanceof Error ? error.message : String(error);
      this.status = 'degraded';
      this.report(false);
      console.warn(`[Fleet] Sync reconcile aborted at revision ${manifest.revision}: ${this.lastError}`);
    }
  }

  private finishOk(manifest: SyncManifest, appliedRevision: number): void {
    this.lastError = this.degradedModules.size > 0 ? this.lastError : undefined;
    this.status = this.degradedModules.size > 0 ? 'degraded' : 'in-sync';
    this.report(this.degradedModules.size === 0, appliedRevision);
    this.resolveReady();
  }

  private resolveReady(): void {
    if (this.readyResolve) {
      this.readyResolve();
      this.readyResolve = null;
    }
  }

  /** Last reconcile outcome for the heartbeat decorator; null before the first completed run. */
  getLastReportOk(): boolean | null {
    return this.lastReportOk;
  }

  private report(ok: boolean, appliedRevision?: number): void {
    this.lastReportOk = ok;
    this.hooks.sendReport({
      term: this.hooks.getTerm(),
      appliedRevision: appliedRevision ?? this.applied?.revision ?? 0,
      ok,
      degraded: this.degradedModules.size > 0 ? [...this.degradedModules] : undefined,
    });
  }

  private notifyApplied(revision: number): void {
    if (!process.send) return;
    try {
      process.send({ type: 'sync:applied', data: { revision } });
    } catch { /* webui refresh is best-effort */ }
  }

  // pull plumbing

  private async request(type: string, data: any): Promise<any> {
    const reply = await this.hooks.request(type, data);
    if (!reply || reply.ok === false) {
      throw new Error(reply?.reason ? `${type} refused: ${reply.reason}` : `${type} failed`);
    }
    return reply;
  }

  private stagingRoot(): string {
    return dataPath('global', FLEET_DIR, SYNC_STAGING_DIRNAME);
  }

  private appliedFile(): string {
    return dataPath('global', FLEET_DIR, 'sync-applied.json');
  }

  private persistApplied(revision: number, manifest: SyncManifest): void {
    this.applied = {
      revision,
      manifest,
      appliedAt: Date.now(),
      degraded: this.degradedModules.size > 0 ? [...this.degradedModules] : undefined,
    };
    atomicWriteFileSync(this.appliedFile(), JSON.stringify(this.applied, null, 2));
  }

  private loadApplied(): PersistedApplied | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.appliedFile(), 'utf-8')) as PersistedApplied;
      if (!Number.isInteger(parsed?.revision) || !parsed.manifest) return null;
      parsed.degraded = Array.isArray(parsed.degraded)
        ? parsed.degraded.filter((n): n is string => typeof n === 'string')
        : undefined;
      return parsed;
    } catch {
      return null;
    }
  }

  private cleanupStaging(): void {
    fs.rmSync(this.stagingRoot(), { recursive: true, force: true });
    const sourceDir = getSourceModulesDir();
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(sourceDir, { withFileTypes: true });
    } catch { /* no source dir yet */ }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.endsWith('.sync-old')) {
        fs.rmSync(path.join(sourceDir, entry.name), { recursive: true, force: true });
      }
    }
    // Drop torn build-copy temporaries from a crash mid copyModuleToBuild.
    const buildDir = getBuildModulesDir();
    if (path.resolve(buildDir) !== path.resolve(sourceDir)) {
      let buildEntries: fs.Dirent[] = [];
      try {
        buildEntries = fs.readdirSync(buildDir, { withFileTypes: true });
      } catch { /* no build dir yet */ }
      for (const entry of buildEntries) {
        if (entry.isDirectory() && entry.name.endsWith('.sync-tmp')) {
          fs.rmSync(path.join(buildDir, entry.name), { recursive: true, force: true });
        }
      }
    }
  }

  /** Pull one file into staging (per-chunk ping-pong), verify sha256, rename into place. */
  private async fetchFile(scope: 'module' | SyncFileScope, moduleName: string | undefined, entry: SyncFileEntry, targetAbs: string): Promise<void> {
    assertSyncableSize(entry.path, entry.size);
    fs.mkdirSync(this.stagingRoot(), { recursive: true });
    const stagingFile = path.join(this.stagingRoot(), `dl-${process.pid}-${++this.stagingCounter}.tmp`);
    const hash = createHash('sha256');
    const fd = fs.openSync(stagingFile, 'w');
    try {
      let offset = 0;
      for (;;) {
        const reply = await this.request(MSG.SYNC_READ, {
          term: this.hooks.getTerm(),
          scope,
          module: moduleName,
          path: entry.path,
          offset,
        });
        if (typeof reply.dataB64 !== 'string') throw new Error(`sync:read malformed reply for ${entry.path}`);
        const chunk = Buffer.from(reply.dataB64, 'base64');
        if (chunk.length > 0) {
          fs.writeSync(fd, chunk);
          hash.update(chunk);
          offset += chunk.length;
        }
        if (offset > SYNC_MAX_FILE_BYTES) throw new Error(`sync:read overran size cap for ${entry.path}`);
        if (reply.eof) break;
        if (chunk.length === 0) throw new Error(`sync:read stalled (empty non-eof chunk) for ${entry.path}`);
      }
    } finally {
      fs.closeSync(fd);
    }
    if (hash.digest('hex') !== entry.sha256) {
      fs.rmSync(stagingFile, { force: true });
      throw new Error(`sha256 mismatch for ${entry.path}`);
    }
    fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
    renameWithRetry(stagingFile, targetAbs);
  }

  /** Returns the number of files changed (fetched or deleted) in this scope. */
  private async syncFileScope(scope: SyncFileScope): Promise<number> {
    const reply = await this.request(MSG.SYNC_FILES, { term: this.hooks.getTerm(), scope });
    if (!Array.isArray(reply.files)) throw new Error(`sync:files malformed reply for scope ${scope}`);
    const masterFiles = (reply.files as SyncFileEntry[]).filter(f => isPathInScope(scope, f.path));
    const local = new Map(listScopeFiles(scope).map(e => [e.path, e]));
    let changed = 0;
    for (const file of masterFiles) {
      const current = local.get(file.path);
      if (current && current.sha256 === file.sha256) continue;
      await this.fetchFile(scope, undefined, file, resolveScopeFile(scope, file.path));
      changed++;
    }
    const masterPaths = new Set(masterFiles.map(f => f.path));
    for (const rel of local.keys()) {
      if (masterPaths.has(rel)) continue;
      fs.rmSync(resolveScopeFile(scope, rel), { force: true });
      changed++;
    }
    return changed;
  }

  // module orchestration

  private diffModules(manifest: SyncManifest): { toRemove: string[]; toFetch: string[] } {
    const wanted = new Map(manifest.modules.map(m => [m.name, m]));
    const localDirs = listModuleDirs();
    const toRemove = localDirs.filter(name => !wanted.has(name));
    const toFetch: string[] = [];
    for (const [name, entry] of wanted) {
      if (!localDirs.includes(name) || moduleContentHash(name) !== entry.contentHash) {
        toFetch.push(name);
      }
    }
    return { toRemove, toFetch };
  }

  private async removeModule(name: string): Promise<void> {
    if (!isValidModuleName(name)) throw new Error(`refusing to remove invalid module name: ${name}`);
    if (this.client) {
      await unloadModuleFromMemory(this.client, name);
    }
    const dirs = new Set([
      path.join(getSourceModulesDir(), name),
      path.join(getBuildModulesDir(), name),
      path.join(getModulesDir(), name),
    ]);
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    console.log(`[Fleet] Sync removed module ${name}`);
  }

  private async fetchModule(name: string): Promise<void> {
    if (!isValidModuleName(name)) throw new Error(`refusing to fetch invalid module name: ${name}`);
    const begin = await this.request(MSG.SYNC_MODULE_BEGIN, { term: this.hooks.getTerm(), name });
    if (!Array.isArray(begin.files)) throw new Error(`sync:module:begin malformed reply for ${name}`);
    const stageDir = path.join(this.stagingRoot(), name);
    fs.rmSync(stageDir, { recursive: true, force: true });
    fs.mkdirSync(stageDir, { recursive: true });
    const stageRoot = path.resolve(stageDir);
    for (const file of begin.files as SyncFileEntry[]) {
      const target = path.resolve(stageDir, file.path);
      if (target !== stageRoot && !target.startsWith(stageRoot + path.sep)) {
        throw new Error(`module file path escapes staging: ${file.path}`);
      }
      await this.fetchFile('module', name, file, target);
    }
    const sourceDir = path.join(getSourceModulesDir(), name);
    const oldDir = `${sourceDir}.sync-old`;
    fs.rmSync(oldDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(sourceDir), { recursive: true });
    if (fs.existsSync(sourceDir)) renameWithRetry(sourceDir, oldDir);
    renameWithRetry(stageDir, sourceDir);
    fs.rmSync(oldDir, { recursive: true, force: true });
    this.copyModuleToBuild(name);
    console.log(`[Fleet] Sync fetched module ${name} (${begin.files.length} file(s))`);
  }

  /**
   * Refresh a module's build dir from its (authoritative) source dir via a
   * staged copy + rename, so a crash mid-copy never leaves a torn build tree.
   * No-op in dev where build == source.
   */
  private copyModuleToBuild(name: string): void {
    const sourceDir = path.join(getSourceModulesDir(), name);
    const buildDir = path.join(getBuildModulesDir(), name);
    if (path.resolve(buildDir) === path.resolve(sourceDir)) return;
    const tmpDir = `${buildDir}.sync-tmp`;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    copyDirRecursive(sourceDir, tmpDir);
    fs.rmSync(buildDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(buildDir), { recursive: true });
    renameWithRetry(tmpDir, buildDir);
  }

  /**
   * Self-heal a stale build tree. fetchModule makes source authoritative before
   * copying it into build; a crash/FS error in between (or an interrupted copy)
   * leaves source=new, build=old/torn while diff/verify (which hash only source)
   * report in-sync. For each manifest module whose source matches, re-derive
   * build when its build-dir hash differs, and return the repaired names so the
   * caller recompiles/reloads dist from them. Prod-split only.
   */
  private healBuildTree(manifest: SyncManifest): string[] {
    const sourceBase = getSourceModulesDir();
    const buildBase = getBuildModulesDir();
    if (path.resolve(buildBase) === path.resolve(sourceBase)) return [];
    const repaired: string[] = [];
    for (const m of manifest.modules) {
      if (m.enabled === false) continue;
      const sourceDir = path.join(sourceBase, m.name);
      if (!fs.existsSync(sourceDir)) continue;
      if (moduleContentHash(m.name) !== m.contentHash) continue;
      const buildDir = path.join(buildBase, m.name);
      let buildHash: string | null = null;
      if (fs.existsSync(buildDir)) buildHash = hashFileSet(listDirFileSet(buildDir));
      if (buildHash === m.contentHash) continue;
      this.copyModuleToBuild(m.name);
      repaired.push(m.name);
    }
    return repaired;
  }

  private async applyRuntime(manifest: SyncManifest, fetched: string[]): Promise<void> {
    const client = this.client!;
    const registry = getModuleRegistry();
    const disabled = new Set(manifest.modules.filter(m => m.enabled === false).map(m => m.name));
    const enabledNames = new Set(manifest.modules.filter(m => m.enabled !== false).map(m => m.name));

    for (const name of disabled) {
      if (registry.getModule(name)) {
        await unloadModuleFromMemory(client, name);
      }
      this.degradedModules.delete(name);
    }

    const toReload = new Set<string>();
    for (const name of fetched) {
      if (enabledNames.has(name)) toReload.add(name);
    }
    for (const name of this.degradedModules) {
      if (enabledNames.has(name)) toReload.add(name);
    }
    if (toReload.size > 0) {
      const result = await reloadModules(client, [...toReload]);
      for (const name of result.reloaded) this.degradedModules.delete(name);
      for (const failure of result.failed) {
        this.degradedModules.add(failure.moduleName);
        console.error(`[Fleet] Sync reload of ${failure.moduleName} failed: ${failure.error}`);
      }
      if (result.failed.length > 0) {
        this.lastError = `module reload failed: ${result.failed.map(f => f.moduleName).join(', ')}`;
      }
    }
  }

  private verifyAgainst(manifest: SyncManifest): boolean {
    const hashes = computeScopeHashes();
    if (hashes.appstoreHash !== manifest.appstoreHash) return false;
    if (hashes.configHash !== manifest.configHash) return false;
    if (hashes.settingsHash !== manifest.settingsHash) return false;
    if (hashes.globalDataHash !== manifest.globalDataHash) return false;
    const localDirs = new Set(listModuleDirs());
    if (localDirs.size !== manifest.modules.length) return false;
    for (const m of manifest.modules) {
      if (!localDirs.has(m.name)) return false;
      if (moduleContentHash(m.name) !== m.contentHash) return false;
    }
    return true;
  }
}
