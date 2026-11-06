/**
 * IPC Data Handler - the webui parent's guild data writes and reads. The
 * parent never writes a postgres-routed guild itself: every guild data op
 * lands here and is applied by this process. Operator writes are durability-immediate (confirmed before
 * the ok), so 'ok' means committed and 'pending' means accepted-but-retrying;
 * a delete that finds nothing, with no earlier delete of it still to land, is
 * done at once.
 */

import * as path from 'path';
import { createHash } from 'crypto';
import { dataPath } from '../../../utils/dataRoot';
import {
  confirmWrite,
  deleteDataTracked,
  deleteGuildNamespace,
  DELETE_TEXTS,
  guildDataOpOf,
  listGuildDataFiles,
  RESTORE_TEXTS,
  isUnconfirmedReply,
  flushFailing,
  GuildFrozenError,
  guildDocFileQueue,
  guildWritePlacement,
  readGuildDocRaw,
  readRawStrict,
  restoreGuildFromGraveyard,
  saveDataTracked,
} from './dataManager';
import type { WriteTicket } from './dataManager';
import { filesPending } from './dataBackends/fileBackend';
import { carryWrites, NO_WRITES, type LedgerCause } from './dataBackends/writeLedger';
import { maintenanceIpcRefusal } from './maintenance';
import { maintenanceText, runTracked } from './maintenanceGate';
import { ROOT_CONFIG_PATH } from './configManager';
import { isInternalGlobalRel } from './configDiscovery';
import { DataBackendUnavailableError, getWorkingSet } from './dataBackends/workingSet';
import { awaitGuildDataReady, servedElsewhere } from './dataBackends/boot';
import { getDataReadiness } from './dataBackends/dataReadiness';
import { canonicalGuildKey } from './dataKeys';
import { stoppedServing } from './servingGate';
import { truthText } from './dataBackends/replyGate';
import { checkWriterLock, deposedHolder, deposedText } from './writerLock';
import { monoNow } from './dataBackends/postgresBackend';
import { resolveDataBackend } from '../../../utils/envLoader';

type DataOpCode = 'frozen' | 'not-owner' | 'backend-unavailable' | 'bot-down' | 'invalid' | 'io-error' | 'maintenance' | 'changed' | 'changed-since-open' | 'held-elsewhere' | 'not-held';

/** A read a write was built on: the sha256 hex of the raw text read, or 'absent'. */
export type ExpectSha = string;

export const CHANGED_TEXT = 'This file changed while the save was being made; nothing was saved. Reload it to see the current values.';
export const CHANGED_SINCE_OPEN_TEXT = 'This file changed since you opened it; nothing was saved. Reload it to see the current values.';

export function shaOfRaw(raw: string | null): ExpectSha {
  return raw === null ? 'absent' : createHash('sha256').update(raw, 'utf8').digest('hex');
}

export interface DataWriteReply {
  ok: boolean;
  code?: DataOpCode;
  error?: string;
  /** Accepted, flush still retrying. */
  pending?: boolean;
  /** Why an accepted write is not durable yet. */
  note?: string;
  /** changed: whether the target or its global twin changed since the read the body was built on. */
  which?: 'target' | 'twin';
  /** A graveyard restore's entry, its reason and, on a database, the rows it moved. */
  retiredAt?: number;
  reason?: string;
  moved?: number;
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
  /** A postgres-routed doc: why a write of it would be refused against the guild's other keys (rule P). */
  unstorable?: string;
}

export interface GuildDataWriteRequest {
  guildId: string;
  module: string;
  /** Ignored for delete-namespace. */
  filename: string;
  op: 'write' | 'delete' | 'delete-namespace' | 'restore-graveyard';
  /** Raw JSON text, 2-space pretty like the facade writes. For restore-graveyard it carries {retiredAt}. */
  contentJson?: string;
  /** write: the sha of the stored text the body was built on; compared in the write's own turn. */
  expectSha?: ExpectSha;
  /** write: the global twin the body was built on ('module/file.json' under /data/global, or the root config). */
  twin?: { rel?: string; root?: 'config'; expectSha: ExpectSha };
  /** write: the expectSha is the data editor's loaded body, answered as changed-since-open. */
  sinceOpen?: boolean;
  /** restore-graveyard and delete-namespace: the web UI's process.hrtime.bigint() at the send plus 45 s, in nanoseconds. */
  answerByMono?: string;
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
  try {
    canonicalGuildKey('', value);
  } catch {
    return false;
  }
  return true;
}

function validateWrite(req: GuildDataWriteRequest): string | null {
  if (!/^\d+$/.test(req.guildId ?? '')) return 'invalid guildId';
  if (req.op !== 'write' && req.op !== 'delete' && req.op !== 'delete-namespace' && req.op !== 'restore-graveyard') return 'invalid op';
  if (req.op === 'delete-namespace' || req.op === 'restore-graveyard') return null;
  if (req.module !== '' && !validSegment(req.module, false)) return 'invalid module';
  if (!validSegment(req.filename, true)) return 'invalid filename';
  if (req.op === 'write' && typeof req.contentJson !== 'string') return 'contentJson is required';
  return null;
}

/**
 * Facade write so coalescing/metrics/fencing engage, then a
 * bounded durability flush.
 */
// The delete's flush, inside its deadline.
const OPERATOR_FLUSH_MS = 5000;
const OPERATION_BOUND_NS = 40_000_000_000n;
const ANSWER_MARGIN_NS = 5_000_000_000n;
const WHOLE_MS_TEXT = 'retiredAt must be a whole number of milliseconds';

/**
 * A restore's or a delete's deadline on the monotonic clock: the earlier of the web UI's answerByMono less 5 s (40 s
 * after its send) and this process's receipt plus 40 s.
 */
export function operationDeadline(answerByMono: unknown, receivedAt: bigint): bigint {
  const byReceipt = receivedAt + OPERATION_BOUND_NS;
  if (typeof answerByMono !== 'string' || !/^\d{1,30}$/.test(answerByMono)) return byReceipt;
  const bySend = BigInt(answerByMono) - ANSWER_MARGIN_NS;
  return bySend < byReceipt ? bySend : byReceipt;
}

export async function applyOperatorDataWrite(req: GuildDataWriteRequest): Promise<DataWriteReply> {
  const receivedAt = monoNow();
  const own: { ticket?: WriteTicket; threw?: boolean } = {};
  const reply = await operatorDataWrite(req, own, receivedAt);
  return own.threw ? reply : carryWrites(reply, { ...NO_WRITES, tickets: own.ticket ? [own.ticket] : [] });
}

/** restore-graveyard's retiredAt from its body: undefined for the newest entry, or the reply that refuses it. */
function retiredAtOf(req: GuildDataWriteRequest): { retiredAt?: number } | DataWriteReply {
  if (req.contentJson === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.contentJson);
  } catch {
    return { ok: false, code: 'invalid', error: 'contentJson is not valid JSON' };
  }
  const value = (parsed as { retiredAt?: unknown } | null)?.retiredAt;
  if (value === undefined) return {};
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return { ok: false, code: 'invalid', error: WHOLE_MS_TEXT };
  return { retiredAt: value };
}

/**
 * NB7 decision 2: a Postgres process whose set lease leaves out the guild's shard, or that stopped serving, never
 * serves the guild again in its life. Synchronous, so nothing is read, hydrated, held or written before it answers.
 */
function notHeldHere(guildId: string): boolean {
  if (resolveDataBackend() !== 'postgres' || !getDataReadiness()?.leaseSet()) return false;
  return servedElsewhere(guildId) || stoppedServing();
}

const NOT_HELD: DataWriteReply = { ok: false, code: 'not-held' };

async function operatorDataWrite(req: GuildDataWriteRequest, own: { ticket?: WriteTicket; threw?: boolean }, receivedAt: bigint): Promise<DataWriteReply> {
  const invalid = validateWrite(req);
  if (invalid) return { ok: false, code: 'invalid', error: invalid };
  if (notHeldHere(req.guildId)) return { ...NOT_HELD };
  const { guildId, module, filename, op } = req;
  const check = checkWriterLock();
  if (check.kind === 'deposed') return { ok: false, code: 'held-elsewhere', error: deposedText(check.holder) };
  if (op === 'restore-graveyard' || op === 'delete-namespace') return graveyardOp(req, receivedAt);
  if (!(await awaitGuildDataReady(guildId))) {
    return { ok: false, code: 'backend-unavailable', error: 'guild data is not ready' };
  }
  // From here to the facade write is one synchronous turn: the compare reads what the write replaces.
  if (op === 'write') {
    const changed = compareRead(req);
    if (changed) return changed;
  }
  let ticket: WriteTicket;
  try {
    const options = module ? { guildId, category: module } : { guildId };
    if (op === 'delete') {
      // Nothing to delete is done, with nothing to confirm; an earlier delete
      // of it not landed yet is confirmed as this one. A frozen guild or a
      // refusal is not done.
      const deleted = deleteDataTracked(filename, options);
      if (deleted.outcome === 'frozen') return { ok: false, code: 'frozen' };
      if (deleted.outcome === 'refused' && deleted.cause === 'unstorable') return { ok: false, code: 'invalid', error: `The data was not saved: ${deleted.reason}` };
      if (deleted.outcome === 'refused') return { ok: false, code: 'backend-unavailable', error: truthText(deleted.cause as LedgerCause, false) };
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
      if (saved.outcome === 'refused' && saved.cause === 'unstorable') return { ok: false, code: 'invalid', error: `The data was not saved: ${saved.reason}` };
      if (saved.outcome === 'refused' && saved.cause === 'io' && saved.reason) return { ok: false, code: 'backend-unavailable', error: `The data was not saved: ${saved.reason}. Please try again.` };
      if (saved.outcome === 'refused') return { ok: false, code: 'backend-unavailable', error: truthText(saved.cause as LedgerCause, false) };
      ticket = saved.ticket;
    }
  } catch (error) {
    if (error instanceof GuildFrozenError) return { ok: false, code: 'frozen' };
    if (error instanceof DataBackendUnavailableError && error.causeKey === 'maintenance') {
      return { ok: false, code: 'maintenance', error: maintenanceText() };
    }
    if (error instanceof DataBackendUnavailableError) {
      return { ok: false, code: 'backend-unavailable', error: error.message };
    }
    own.threw = true;
    return { ok: false, code: 'io-error', error: error instanceof Error ? error.message : String(error) };
  }
  own.ticket = ticket;
  // This write's own confirmation: other writers' queued writes to the guild are theirs.
  const outcome = await confirmWrite(ticket, 8000);
  if (outcome === 'ok') return { ok: true };
  if (outcome === 'pending') return { ok: true, pending: true };
  if (outcome === 'deposed') return { ok: false, code: 'not-owner', error: 'another bot process took ownership of this guild mid-write; it was not saved' };
  // Refused by the store, the write is kept and retried: no failure, and the
  // operator learns it is not durable yet.
  if (outcome === 'held') return { ok: true, pending: true, note: 'it is not saved yet; this node retries while it serves this guild, and loses it if the bot stops or loses its database first' };
  if (outcome === 'unavailable' && deposedHolder()) return { ok: false, code: 'held-elsewhere', error: deposedText(deposedHolder()!) };
  return { ok: false, code: 'backend-unavailable', error: 'this write left this node before it was confirmed saved (the guild was unloaded, its data was deleted or restored from the graveyard), so whether it was saved is unknown; reload the data to check' };
}

/**
 * A graveyard restore or a namespace delete: refused before the ready wait while either holds the guild or once its
 * deadline passed, since the ready wait would read a guild a delete is moving.
 */
async function graveyardOp(req: GuildDataWriteRequest, receivedAt: bigint): Promise<DataWriteReply> {
  const { guildId, op } = req;
  const restore = op === 'restore-graveyard';
  const deadline = operationDeadline(req.answerByMono, receivedAt);
  const running = guildDataOpOf(guildId);
  if (running) {
    const text = restore
      ? (running === 'restore' ? RESTORE_TEXTS.alreadyRunning : RESTORE_TEXTS.deleteRunning)
      : (running === 'restore' ? DELETE_TEXTS.restoreRunning : DELETE_TEXTS.alreadyRunning);
    return { ok: false, code: 'invalid', error: text };
  }
  if (monoNow() >= deadline) return { ok: false, code: 'backend-unavailable', error: restore ? RESTORE_TEXTS.outOfTime : DELETE_TEXTS.outOfTime };
  const parsed: { retiredAt?: number } | DataWriteReply = restore ? retiredAtOf(req) : {};
  if ('ok' in parsed) return parsed as DataWriteReply;
  if (!(await awaitGuildDataReady(guildId))) {
    return { ok: false, code: 'backend-unavailable', error: restore ? RESTORE_TEXTS.notLoaded : DELETE_TEXTS.notLoaded };
  }
  // NB4 decision 6: no write after the claims lapsed or a shard was lost, and a frozen set keeps its writes.
  if (stoppedServing() || getWorkingSet()?.stateOf(guildId) === 'frozen-retained') return { ok: false, code: 'frozen' };
  try {
    if (restore) {
      const restored = await restoreGuildFromGraveyard(guildId, parsed.retiredAt, deadline);
      // An evicted set: its read starts now, so the events it holds replay on the restored data; the answer does not wait on it.
      if (resolveDataBackend() === 'postgres' && getWorkingSet() && !getWorkingSet()!.has(guildId)) await awaitGuildDataReady(guildId);
      if (!restored.ok && deposedHolder() && !isUnconfirmedReply(restored)) return { ok: false, code: 'held-elsewhere', error: deposedText(deposedHolder()!) };
      return restored.ok ? { ok: true, retiredAt: restored.retiredAt, reason: restored.reason, ...(restored.moved === undefined ? {} : { moved: restored.moved }) } : restored;
    }
    const deleted = await deleteGuildNamespace(guildId, 'webui-operator-delete', OPERATOR_FLUSH_MS, deadline);
    if (!deleted.ok && deposedHolder() && !isUnconfirmedReply(deleted)) return { ok: false, code: 'held-elsewhere', error: deposedText(deposedHolder()!) };
    return deleted;
  } catch (error) {
    if (error instanceof GuildFrozenError) return { ok: false, code: 'frozen' };
    if (error instanceof DataBackendUnavailableError && error.causeKey === 'maintenance') {
      return { ok: false, code: 'maintenance', error: maintenanceText() };
    }
    if (error instanceof DataBackendUnavailableError) return { ok: false, code: 'backend-unavailable', error: error.message };
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, code: 'io-error', error: restore ? RESTORE_TEXTS.error(message) : DELETE_TEXTS.error(message) };
  }
}

/** The stored text of the target and its twin against the reads the body was built on; a reply when either changed. */
function compareRead(req: GuildDataWriteRequest): DataWriteReply | null {
  const changed = (): DataWriteReply => req.sinceOpen
    ? { ok: false, code: 'changed-since-open', error: CHANGED_SINCE_OPEN_TEXT }
    : { ok: false, code: 'changed', which: 'target', error: CHANGED_TEXT };
  try {
    if (req.expectSha !== undefined && shaOfRaw(readGuildDocRaw(req.guildId, req.module, req.filename)) !== req.expectSha) return changed();
    if (req.twin) {
      const twin = applyOperatorGlobalRead({ root: req.twin.root, rel: req.twin.rel });
      if (!twin.ok) return { ok: false, code: 'invalid', error: twin.error ?? 'the global twin cannot be read' };
      if (shaOfRaw(twin.contentJson ?? null) !== req.twin.expectSha) return { ok: false, code: 'changed', which: 'twin', error: CHANGED_TEXT };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return { ok: false, code: 'io-error', error: `the stored file cannot be read (${typeof code === 'string' ? code : 'unknown error'}); nothing was saved` };
  }
  return null;
}

export async function applyOperatorDataRead(req: GuildDataReadRequest): Promise<DataReadReply> {
  if (!/^\d+$/.test(req.guildId ?? '')) return { ok: false, code: 'invalid', error: 'invalid guildId' };
  if (req.module !== '' && !validSegment(req.module, false)) return { ok: false, code: 'invalid', error: 'invalid module' };
  if (req.filename !== undefined && !validSegment(req.filename, true)) return { ok: false, code: 'invalid', error: 'invalid filename' };
  if (notHeldHere(req.guildId)) return { ok: false, code: 'not-held' };
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
    const unstorable = guildWritePlacement(req.guildId, req.module, req.filename);
    return { ok: true, ...(raw === null ? {} : { contentJson: raw }), ...(queue ?? {}), ...(unstorable === null ? {} : { unstorable }) };
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

/**
 * One guild change as the bot process answers it, from the web UI's IPC message or from a request row another
 * machine's web panel sent (NB7 decision 7): the maintenance refusal first, then the tracked executor.
 */
export async function answerGuildWrite(data: GuildDataWriteRequest): Promise<DataWriteReply> {
  const refusal = maintenanceIpcRefusal('data:guild-write');
  if (refusal) return refusal as DataWriteReply;
  try {
    return await runTracked(() => applyOperatorDataWrite((data || {}) as GuildDataWriteRequest));
  } catch (error) {
    return { ok: false, code: 'io-error', error: error instanceof Error ? error.message : 'Unknown error' };
  }
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
    if ((type !== 'data:guild-write' && type !== 'data:guild-read') || !requestId) return;
    if (type === 'data:guild-write') {
      process.send!({ requestId, data: await answerGuildWrite((data || {}) as GuildDataWriteRequest) });
      return;
    }
    const refusal = maintenanceIpcRefusal(type);
    if (refusal) {
      process.send!({ requestId, data: refusal });
      return;
    }
    try {
      process.send!({ requestId, data: await applyOperatorDataRead((data || {}) as GuildDataReadRequest) });
    } catch (error) {
      process.send!({ requestId, data: { ok: false, code: 'io-error', error: error instanceof Error ? error.message : 'Unknown error' } });
    }
  });
}
