/**
 * IPC Data Handler - the webui parent's write-through-owner and read hops
 * (spec 6.3). The parent never writes a postgres-routed guild itself: every
 * guild data op lands here, is applied locally when this node owns the guild,
 * and is otherwise forwarded by the master to the owning worker over the
 * control channel. Operator writes are durability-immediate (confirmed before
 * the ok), so 'ok' means committed and 'pending' means accepted-but-retrying;
 * a delete that finds nothing, with no earlier delete of it still to land, is
 * done at once.
 */

import * as fs from 'fs';
import * as path from 'path';
import { dataPath } from '../../../utils/dataRoot';
import {
  confirmWrite,
  deleteDataTracked,
  deleteGuildNamespace,
  isGuildWriteFrozen,
  listGuildDataFiles,
  listGuildDataKeys,
  flushFailing,
  guildDocFileQueue,
  readGuildDocRaw,
  readRawStrict,
  restoreGuildFromGraveyard,
  saveDataTracked,
} from './dataManager';
import type { WriteTicket } from './dataManager';
import { filesPending } from './dataBackends/fileBackend';
import { ROOT_CONFIG_PATH } from './configManager';
import { isInternalGlobalRel } from './configDiscovery';
import { DataBackendUnavailableError, getWorkingSet } from './dataBackends/workingSet';
import { awaitGuildDataReady } from './dataBackends/boot';
import { getFleetState } from '../fleet/state';
import { guildIdToShardId } from '../fleet/placement';
import type { DataReadReply, DataWriteReply } from '../fleet/protocol';

export interface GuildDataWriteRequest {
  guildId: string;
  module: string;
  /** Ignored for delete-namespace. */
  filename: string;
  op: 'write' | 'delete' | 'delete-namespace' | 'restore-graveyard';
  /** Raw JSON text, 2-space pretty like the facade writes. For restore-graveyard it carries {retiredAt}. */
  contentJson?: string;
}

/** One global file the Config tab reads: the root config, or a .json path under /data/global as 'module/file.json'. */
export interface GlobalDataReadRequest {
  root?: 'config';
  rel?: string;
}

/** pending: this process still holds a queued write or delete of the file; failing: that write's last flush failed. */
export type GlobalDataReadReply = DataReadReply & { pending?: boolean; failing?: boolean };

export interface GuildDataReadRequest {
  guildId: string;
  module: string;
  /** No filename = list the module's files. */
  filename?: string;
  /** With no filename: list every guild data key as 'module/filename' (guild-root files are bare filenames); ignores module. */
  scope?: 'all';
}

/**
 * Master-only forwarder to the owning worker (registered by fleet bootstrap,
 * which stamps the wire term; module-level so a fleet re-init keeps the
 * latest hop).
 */
export type DataOpForwarder = (kind: 'write' | 'read', request: GuildDataWriteRequest | GuildDataReadRequest) => Promise<DataWriteReply | DataReadReply>;
let forwarder: DataOpForwarder | null = null;
export function setDataOpForwarder(cb: DataOpForwarder | null): void {
  forwarder = cb;
}

function validSegment(value: string, allowSubpath: boolean): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return false;
  if (value.includes('\\') || value.includes('..') || value.startsWith('/')) return false;
  if (!allowSubpath && value.includes('/')) return false;
  return true;
}

function validateWrite(req: GuildDataWriteRequest): string | null {
  if (!/^\d+$/.test(req.guildId ?? '')) return 'invalid guildId';
  if (req.op !== 'write' && req.op !== 'delete' && req.op !== 'delete-namespace' && req.op !== 'restore-graveyard') return 'invalid op';
  if (req.op === 'delete-namespace' || req.op === 'restore-graveyard') return null;
  if (!validSegment(req.module, false)) return 'invalid module';
  if (!validSegment(req.filename, true)) return 'invalid filename';
  if (req.op === 'write' && typeof req.contentJson !== 'string') return 'contentJson is required';
  return null;
}

/** True when this node serves the guild itself (standalone counts as local). */
function servedLocally(guildId: string): boolean {
  const fleet = getFleetState();
  if (!fleet.initialized || fleet.standalone || fleet.shardCount <= 0) return true;
  const shardId = guildIdToShardId(guildId, fleet.shardCount);
  return fleet.leases.some(l => l.shardId === shardId);
}

/**
 * Owner-side apply (identical on master and worker): freeze check, facade
 * write so coalescing/metrics/fencing engage, then a bounded durability flush.
 */
// Inside the master's 10 s hop to the owner (and the web UI's 15 s wait),
// so the delete's answer is the one the operator sees.
const OPERATOR_FLUSH_MS = 5000;

export async function applyOperatorDataWrite(req: GuildDataWriteRequest): Promise<DataWriteReply> {
  const invalid = validateWrite(req);
  if (invalid) return { ok: false, code: 'invalid', error: invalid };
  const { guildId, module, filename, op } = req;
  if (isGuildWriteFrozen(guildId)) return { ok: false, code: 'frozen' };
  if (!(await awaitGuildDataReady(guildId))) {
    return { ok: false, code: 'backend-unavailable', error: 'guild data is not ready' };
  }
  let ticket: WriteTicket;
  try {
    if (op === 'restore-graveyard') {
      let retiredAt: number | undefined;
      if (req.contentJson !== undefined) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(req.contentJson);
        } catch {
          return { ok: false, code: 'invalid', error: 'contentJson is not valid JSON' };
        }
        const value = (parsed as { retiredAt?: unknown } | null)?.retiredAt;
        if (value !== undefined) {
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            return { ok: false, code: 'invalid', error: 'retiredAt must be a number (ms)' };
          }
          retiredAt = value;
        }
      }
      const restored = await restoreGuildFromGraveyard(guildId, retiredAt);
      if (!restored.ok) return { ok: false, code: 'invalid', error: restored.error || 'restore refused' };
      return { ok: true };
    }
    if (op === 'delete-namespace') {
      // Its working set frozen (a move's drain, a lease leaving): deleting
      // it now would drop that freeze and the data mid-move.
      if (getWorkingSet()?.stateOf(guildId) === 'frozen-retained') return { ok: false, code: 'frozen' };
      const moved = await deleteGuildNamespace(guildId, 'webui-operator-delete', OPERATOR_FLUSH_MS);
      if (!moved) return { ok: false, code: 'io-error', error: 'guild data delete failed; nothing was removed' };
      return { ok: true };
    }
    const options = module ? { guildId, category: module } : { guildId };
    if (op === 'delete') {
      // Nothing to delete is done, with nothing to confirm; an earlier delete
      // of it not landed yet is confirmed as this one. A frozen guild or a
      // refusal is not done.
      const deleted = deleteDataTracked(filename, options);
      if (deleted.outcome === 'frozen') return { ok: false, code: 'frozen' };
      if (deleted.outcome === 'refused') return { ok: false, code: 'backend-unavailable', error: 'delete not accepted' };
      if (!deleted.ticket) return { ok: true };
      ticket = deleted.ticket;
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(req.contentJson!);
      } catch {
        return { ok: false, code: 'invalid', error: 'contentJson is not valid JSON' };
      }
      const saved = saveDataTracked(filename, options, parsed);
      if (saved.outcome === 'frozen') return { ok: false, code: 'frozen' };
      if (saved.outcome === 'refused') return { ok: false, code: 'backend-unavailable', error: 'write not accepted' };
      ticket = saved.ticket;
    }
  } catch (error) {
    if (error instanceof DataBackendUnavailableError) {
      return { ok: false, code: 'backend-unavailable', error: error.message };
    }
    return { ok: false, code: 'io-error', error: error instanceof Error ? error.message : String(error) };
  }
  // This write's own confirmation: other writers' queued writes to the guild are theirs.
  const outcome = await confirmWrite(ticket, 8000);
  if (outcome === 'ok') return { ok: true };
  if (outcome === 'pending') return { ok: true, pending: true };
  if (outcome === 'deposed') return { ok: false, code: 'not-owner', error: 'guild ownership moved mid-write' };
  // Refused by the store, the write is kept and retried: no failure, and the
  // operator learns it is not durable yet.
  if (outcome === 'held') return { ok: true, pending: true, note: 'it is not saved yet; this node retries while it serves this guild, and loses it if the bot stops, the guild moves or the node loses its database first' };
  return { ok: false, code: 'backend-unavailable', error: 'this write left this node before it was confirmed saved (the guild moved or was unloaded, its data was deleted or restored from the graveyard, or the node switched databases), so whether it was saved is unknown; reload the data to check' };
}

/**
 * Every data key of the guild namespace as 'module/filename' strings (guild-
 * root files are bare filenames). A file-routed guild is answered by a disk
 * scan mirroring configDiscovery's orphan rules: top-level *.json plus each
 * non-underscore subdirectory's *.json, non-recursive.
 */
function listAllGuildDataKeys(guildId: string): string[] {
  const backendKeys = listGuildDataKeys(guildId);
  if (backendKeys !== null) {
    return backendKeys.map(key => (key.module ? `${key.module}/${key.filename}` : key.filename));
  }
  const keys: string[] = [];
  const guildDir = dataPath(guildId);
  if (!fs.existsSync(guildDir)) return keys;
  for (const entry of fs.readdirSync(guildDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.json')) {
      keys.push(entry.name);
    } else if (entry.isDirectory() && !entry.name.startsWith('_')) {
      for (const inner of fs.readdirSync(dataPath(guildId, entry.name), { withFileTypes: true })) {
        if (inner.isFile() && inner.name.endsWith('.json')) {
          keys.push(`${entry.name}/${inner.name}`);
        }
      }
    }
  }
  return keys;
}

export async function applyOperatorDataRead(req: GuildDataReadRequest): Promise<DataReadReply> {
  if (!/^\d+$/.test(req.guildId ?? '')) return { ok: false, code: 'invalid', error: 'invalid guildId' };
  if (req.module !== '' && !validSegment(req.module, false)) return { ok: false, code: 'invalid', error: 'invalid module' };
  if (req.filename !== undefined && !validSegment(req.filename, true)) return { ok: false, code: 'invalid', error: 'invalid filename' };
  if (!(await awaitGuildDataReady(req.guildId))) {
    return { ok: false, code: 'backend-unavailable', error: 'guild data is not ready' };
  }
  try {
    if (req.filename === undefined) {
      if (req.scope === 'all') {
        return { ok: true, files: listAllGuildDataKeys(req.guildId) };
      }
      return { ok: true, files: listGuildDataFiles(req.guildId, req.module || undefined) };
    }
    const raw = readGuildDocRaw(req.guildId, req.module, req.filename);
    // A file-routed doc: whether this process's own queued write of it could still land.
    const queue = guildDocFileQueue(req.guildId, req.module, req.filename);
    return { ok: true, ...(raw === null ? {} : { contentJson: raw }), ...(queue ?? {}) };
  } catch (error) {
    if (error instanceof DataBackendUnavailableError) {
      return { ok: false, code: 'backend-unavailable', error: error.message };
    }
    const unreadable = unreadableReply(error);
    if (unreadable) return unreadable;
    return { ok: false, code: 'io-error', error: error instanceof Error ? error.message : String(error) };
  }
}

/** A file that exists and could not be read: never answered as absent. */
function unreadableReply(error: unknown): DataReadReply | null {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === 'string' ? { ok: false, code: 'unreadable', error: code } : null;
}

/**
 * The web UI's queue-first read of a global file: the body this process last
 * accepted for it (queued or on disk), so the editor and a backup never start
 * from a body older than a write the bot accepted.
 */
export function applyOperatorGlobalRead(req: GlobalDataReadRequest): GlobalDataReadReply {
  let absPath: string;
  if (req.root === 'config') {
    absPath = ROOT_CONFIG_PATH;
  } else {
    const rel = req.rel;
    if (typeof rel !== 'string' || !validSegment(rel, true) || !rel.endsWith('.json') || isInternalGlobalRel(rel)) {
      return { ok: false, code: 'invalid', error: 'invalid global file' };
    }
    const globalDir = dataPath('global');
    absPath = path.join(globalDir, ...rel.split('/'));
    if (!absPath.startsWith(globalDir + path.sep)) return { ok: false, code: 'invalid', error: 'invalid global file' };
  }
  let raw: string | null;
  try {
    raw = readRawStrict(absPath);
  } catch (error) {
    return unreadableReply(error) ?? { ok: false, code: 'io-error', error: error instanceof Error ? error.message : String(error) };
  }
  const state = { pending: filesPending([absPath]), failing: flushFailing([absPath]) };
  return raw === null ? { ok: true, ...state } : { ok: true, contentJson: raw, ...state };
}

async function handleGuildWrite(req: GuildDataWriteRequest): Promise<DataWriteReply> {
  const invalid = validateWrite(req);
  if (invalid) return { ok: false, code: 'invalid', error: invalid };
  if (servedLocally(req.guildId)) return applyOperatorDataWrite(req);
  const fleet = getFleetState();
  if (fleet.role === 'master' && forwarder) {
    return forwarder('write', req) as Promise<DataWriteReply>;
  }
  return { ok: false, code: 'not-owner', error: 'this node does not serve this guild' };
}

async function handleGuildRead(req: GuildDataReadRequest): Promise<DataReadReply> {
  if (!/^\d+$/.test(req.guildId ?? '')) return { ok: false, code: 'invalid', error: 'invalid guildId' };
  if (servedLocally(req.guildId)) return applyOperatorDataRead(req);
  const fleet = getFleetState();
  if (fleet.role === 'master' && forwarder) {
    return forwarder('read', req) as Promise<DataReadReply>;
  }
  return { ok: false, code: 'not-owner', error: 'this node does not serve this guild' };
}

export function setupDataIPCHandlers(): void {
  if (!process.send) {
    console.warn('[IPCDataHandler] process.send not available - guild data IPC not registered');
    return;
  }
  console.log('[IPCDataHandler] Setting up IPC handlers for guild data ops');

  process.on('message', async (message: unknown) => {
    if (!message || typeof message !== 'object') return;
    const { type, requestId, data } = message as { type?: string; requestId?: string; data?: any };
    if ((type !== 'data:guild-write' && type !== 'data:guild-read' && type !== 'data:global-read') || !requestId) return;
    try {
      const response = type === 'data:guild-write'
        ? await handleGuildWrite((data || {}) as GuildDataWriteRequest)
        : type === 'data:guild-read'
          ? await handleGuildRead((data || {}) as GuildDataReadRequest)
          : applyOperatorGlobalRead((data || {}) as GlobalDataReadRequest);
      process.send!({ requestId, data: response });
    } catch (error) {
      process.send!({ requestId, data: { ok: false, code: 'io-error', error: error instanceof Error ? error.message : 'Unknown error' } });
    }
  });
}
