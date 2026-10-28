/**
 * IPC Data Handler - the webui parent's guild data writes and reads. The
 * parent never writes a postgres-routed guild itself: every guild data op
 * lands here and is applied by this process. Operator writes are durability-immediate (confirmed before
 * the ok), so 'ok' means committed and 'pending' means accepted-but-retrying;
 * a delete that finds nothing, with no earlier delete of it still to land, is
 * done at once.
 */

import * as path from 'path';
import { dataPath } from '../../../utils/dataRoot';
import {
  confirmWrite,
  deleteDataTracked,
  deleteGuildNamespace,
  listGuildDataFiles,
  flushFailing,
  guildDocFileQueue,
  readGuildDocRaw,
  readRawStrict,
  restoreGuildFromGraveyard,
  saveDataTracked,
} from './dataManager';
import type { WriteTicket } from './dataManager';
import { filesPending } from './dataBackends/fileBackend';
import { maintenanceIpcRefusal } from './maintenance';
import { maintenanceText, runTracked } from './maintenanceGate';
import { ROOT_CONFIG_PATH } from './configManager';
import { isInternalGlobalRel } from './configDiscovery';
import { DataBackendUnavailableError, getWorkingSet } from './dataBackends/workingSet';
import { awaitGuildDataReady } from './dataBackends/boot';

type DataOpCode = 'frozen' | 'not-owner' | 'backend-unavailable' | 'bot-down' | 'invalid' | 'io-error' | 'maintenance';

export interface DataWriteReply {
  ok: boolean;
  code?: DataOpCode;
  error?: string;
  /** Accepted, flush still retrying. */
  pending?: boolean;
  /** Why an accepted write is not durable yet. */
  note?: string;
}

export interface DataReadReply {
  ok: boolean;
  /** Raw JSON text of the requested file; absent for a listing. */
  contentJson?: string;
  /** Listing when no filename was requested. */
  files?: string[];
  /** A file-routed doc: the answering process still holds a queued write of it; failing: that write's last flush failed. */
  pending?: boolean;
  failing?: boolean;
  /** unreadable: the file exists and could not be read (error holds the errno code). no-answer (web UI side): the child never answered. */
  code?: DataOpCode | 'unreadable' | 'no-answer';
  /** no-answer only: the read timed out, the child stopped before answering, or the message could not be sent. */
  cause?: 'timeout' | 'stopped' | 'failed';
  error?: string;
}

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

/**
 * Facade write so coalescing/metrics/fencing engage, then a
 * bounded durability flush.
 */
// Inside the web UI's 15 s wait, so the delete's answer is the one the operator sees.
const OPERATOR_FLUSH_MS = 5000;

export async function applyOperatorDataWrite(req: GuildDataWriteRequest): Promise<DataWriteReply> {
  const invalid = validateWrite(req);
  if (invalid) return { ok: false, code: 'invalid', error: invalid };
  const { guildId, module, filename, op } = req;
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
      // Its working set frozen (its lease left): deleting it now would drop
      // that freeze and the data still being flushed.
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
    if (error instanceof DataBackendUnavailableError && error.causeKey === 'maintenance') {
      return { ok: false, code: 'maintenance', error: maintenanceText() };
    }
    if (error instanceof DataBackendUnavailableError) {
      return { ok: false, code: 'backend-unavailable', error: error.message };
    }
    return { ok: false, code: 'io-error', error: error instanceof Error ? error.message : String(error) };
  }
  // This write's own confirmation: other writers' queued writes to the guild are theirs.
  const outcome = await confirmWrite(ticket, 8000);
  if (outcome === 'ok') return { ok: true };
  if (outcome === 'pending') return { ok: true, pending: true };
  if (outcome === 'deposed') return { ok: false, code: 'not-owner', error: 'another bot process took ownership of this guild mid-write; it was not saved' };
  // Refused by the store, the write is kept and retried: no failure, and the
  // operator learns it is not durable yet.
  if (outcome === 'held') return { ok: true, pending: true, note: 'it is not saved yet; this node retries while it serves this guild, and loses it if the bot stops or loses its database first' };
  return { ok: false, code: 'backend-unavailable', error: 'this write left this node before it was confirmed saved (the guild was unloaded, its data was deleted or restored from the graveyard), so whether it was saved is unknown; reload the data to check' };
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
    const refusal = maintenanceIpcRefusal(type);
    if (refusal) {
      process.send!({ requestId, data: refusal });
      return;
    }
    try {
      const response = type === 'data:guild-write'
        ? await runTracked(() => applyOperatorDataWrite((data || {}) as GuildDataWriteRequest))
        : type === 'data:guild-read'
          ? await applyOperatorDataRead((data || {}) as GuildDataReadRequest)
          : applyOperatorGlobalRead((data || {}) as GlobalDataReadRequest);
      process.send!({ requestId, data: response });
    } catch (error) {
      process.send!({ requestId, data: { ok: false, code: 'io-error', error: error instanceof Error ? error.message : 'Unknown error' } });
    }
  });
}
