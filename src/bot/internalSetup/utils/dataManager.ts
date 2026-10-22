// Data Manager - Centralized guild-aware data storage
// Handles per-guild data isolation with optional global data access.
//
// This is the module-facing facade: loadData/saveData/dataExists/deleteData
// and every helper keep their exact signatures and return values. The facade
// owns freeze checks, IO metrics, and .owner stamping; physical storage lives
// behind it (dataBackends/fileBackend.ts today: an async atomic queue where
// saveData stringifies synchronously, enqueues, and returns immediately, and
// a per-path flusher writes temp+fsync+rename so a crash never leaves a torn
// JSON file). Reads consult the queue first so a caller reading right after a
// write still sees its own bytes.

import * as path from 'path';
import { getMetricsCollector } from './metrics/metricsCollector';
import { DATA_ROOT } from '../../../utils/dataRoot';
import {
  ensureDirectory,
  getPending,
  enqueueWrite,
  enqueueAppend,
  enqueueDelete,
  fileTicket,
  confirmFile,
  existsOnDisk,
  readFileUtf8,
  readRaw,
  freezeSentinelExists,
  guildDirExists,
  dropPendingForGuild,
  graveyardGuildDir,
  restoreGuildDirFromGraveyard,
  writeRawAtomic as writeRawAtomicFile,
  deleteRawAtomic as deleteRawAtomicFile,
  listGuildDataFiles as listGuildDataFilesFs,
  listGlobalDataFiles,
} from './dataBackends/fileBackend';

import {
  flushAll as flushAllFiles,
  queuedFileWrites,
  fileFlushOnTheWire,
  fileFlushesLanded,
  flushGuild as flushGuildFiles,
  pendingGuildFiles,
  filesPending,
  sweepGraveyard as sweepFileGraveyard,
  listGuilds as listGuildDirs,
  sizeOfGuildData as sizeOfGuildDir,
} from './dataBackends/fileBackend';
import { routeFor } from './dataBackends/routeResolver';
import { carryOf, getWorkingSet, DataBackendUnavailableError } from './dataBackends/workingSet';
import type { WsTicket } from './dataBackends/workingSet';
import type { FileTicket } from './dataBackends/fileBackend';
import { sweepGraveyardRows, PostgresBackend } from './dataBackends/postgresBackend';
import type { DataBackend, FenceToken } from './dataBackends/backend';
import { loadCredentials } from '../../../utils/envLoader';
import { currentSince, recordRefusal, recordTicket } from './dataBackends/writeLedger';
import { firstSeqOf, noteScopeRefusal, noteScopeTicket, pendingFor, saveMark, stampOf, type SaveMark } from './dataBackends/scopeRecord';

export { listGlobalDataFiles, saveMark };
export type { SaveMark };
export { DataBackendUnavailableError } from './dataBackends/workingSet';
export {
  getFlushFailures,
  readRaw,
  sizeOfGlobalData,
  listGraveyardEntries,
} from './dataBackends/fileBackend';

// ============================================================================
// BACKEND RUNTIME (postgres mode only; null in pure file mode)
// ============================================================================

let pgBackend: DataBackend | null = null;

/** Wired at boot when the deployment's backend is postgres. */
export function setGuildDataBackend(backend: DataBackend | null): void {
  pgBackend = backend;
}

export function getGuildDataBackend(): DataBackend | null {
  return pgBackend;
}

// Owned-guild catalog snapshot (refreshed at every grant delta and on a timer
// by the data-readiness driver) so the sync listGuilds answers the OWNED set.
let ownedCatalog: string[] = [];
export function setOwnedGuildCatalog(guilds: string[]): void {
  ownedCatalog = guilds;
}

// Postgres-routed guild-scope calls answer from the Working Set; a missing
// manager (the webui parent process, or a not-yet-wired boot) REFUSES rather
// than falling through to files - a file write for a postgres-routed guild is
// always a bug.
function wsRouted(options: DataOptions): string | null {
  if ((options.scope || 'guild') !== 'guild') return null;
  const guildId = options.guildId;
  if (!guildId) return null;
  return routeFor(guildId) === 'postgres' ? guildId : null;
}

export function fenceFromOwnerInfo(guildId: string): FenceToken | null {
  const info = ownerInfoProvider?.();
  if (!info) return null;
  return {
    nodeId: info.nodeId,
    term: info.term,
    epoch: info.epoch,
    shardId: guildIdToShardId(guildId, info.shardCount),
    shardCount: info.shardCount,
  };
}

export function getBackendHealth(): { state: string; oldestDirtyMs: number; dirtyBytes: number; lastError: string | null } {
  const ws = getWorkingSet();
  if (!ws) return { state: 'healthy', oldestDirtyMs: 0, dirtyBytes: 0, lastError: null };
  return ws.getBackendHealth();
}

/**
 * Flush every queued write to durable storage, one pass; in postgres mode any
 * guilds still dirty after it are logged.
 */
export async function flushAll(): Promise<void> {
  const ws = getWorkingSet();
  const [, leftover] = await Promise.all([
    flushAllFiles(),
    ws ? ws.flushAllDirty() : Promise.resolve([] as string[]),
  ]);
  if (leftover.length > 0) {
    console.warn(`[Data] A full flush left ${leftover.length} guild(s) with unflushed writes: ${leftover.join(', ')}`);
  }
}

const EXIT_DRAIN_POLL_MS = 100;
const EXIT_DRAIN_GIVEUP_MS = 3000;
let exitDrain: Promise<void> | null = null;
let closedForExit = false;

const pause = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, Math.max(0, ms)); });

function writesSettled(): boolean {
  const ws = getWorkingSet();
  return queuedFileWrites() === 0 && (!ws || ws.writesSettled());
}

const landedFlushes = () => fileFlushesLanded() + (getWorkingSet()?.landedFlushes() ?? 0);
const flushOnTheWire = () => fileFlushOnTheWire() || (getWorkingSet()?.flushOnTheWire() ?? false);

// A pass flushes what is queued when it starts: a write accepted during it and
// a flush already on the wire are the next pass's, and the pause hands a flush
// on the wire the event loop. A store that refuses (down, read-only, a failing
// disk) is retried until nothing has landed for EXIT_DRAIN_GIVEUP_MS and
// nothing is on the wire, so a blip drains and a dead store costs that window,
// not the bound.
async function drainUntilSettled(deadline: number, progress: { at: number; landed: number }): Promise<void> {
  while (!writesSettled() && Date.now() < deadline) {
    const ws = getWorkingSet();
    await Promise.race([
      Promise.all([flushAllFiles(), ws ? ws.flushAllDirty() : null]).catch(() => undefined),
      pause(deadline - Date.now()),
    ]);
    if (writesSettled()) return;
    if (landedFlushes() !== progress.landed) {
      progress.landed = landedFlushes();
      progress.at = Date.now();
    } else if (!flushOnTheWire() && Date.now() - progress.at >= EXIT_DRAIN_GIVEUP_MS) return;
    await pause(Math.min(EXIT_DRAIN_POLL_MS, deadline - Date.now()));
  }
}

/**
 * The exit drain, within boundMs: flush until nothing is queued or on the wire,
 * then refuse every later write and flush once more, so the exit drops no write
 * it accepted. Only for an exit: writes stay refused after it.
 */
export function drainForExit(boundMs: number): Promise<void> {
  if (!exitDrain) {
    exitDrain = (async () => {
      const deadline = Date.now() + boundMs;
      const progress = { at: Date.now(), landed: landedFlushes() };
      // A refused write in code that does not catch it must not end the
      // process before the drain does.
      process.on('uncaughtException', error => console.error('[Data] Error during the exit drain (the drain goes on):', error));
      await drainUntilSettled(deadline - Math.floor(boundMs / 5), progress);
      closedForExit = true;
      await drainUntilSettled(deadline, progress);
      const left = getWorkingSet()?.dirtyGuildIds() ?? [];
      if (left.length > 0) console.warn(`[Data] Shutdown drain left ${left.length} guild(s) with unflushed writes: ${left.join(', ')}`);
      const files = queuedFileWrites();
      if (files > 0) console.warn(`[Data] Shutdown drain left ${files} file(s) with queued writes`);
    })();
  }
  return exitDrain;
}

/** Whether the exit drain has closed the facade: every write from now on is refused as node-stopping. */
export function isClosedForExit(): boolean {
  return closedForExit;
}

let stopBegun = false;

/** The process's shutdown handler: runs its steps once, the stop marked begun before the first of them. */
export function stopHandler(steps: () => Promise<void>): () => Promise<void> {
  return async () => {
    if (stopBegun) return;
    stopBegun = true;
    await steps();
  };
}

/** A stop has begun or the exit drain runs: a write not saved by now may never be retried, and may be lost. */
export function isStopping(): boolean {
  return stopBegun || exitDrain !== null;
}

/**
 * Flush every queued op for one guild (migration drain primitive).
 */
export async function flushGuild(guildId: string): Promise<void> {
  await flushGuildFiles(guildId);
  const ws = getWorkingSet();
  if (ws && routeFor(guildId) === 'postgres') {
    await ws.flushGuildNow(guildId, 30000);
  }
}

/**
 * List guild ids this node serves: guild dirs in file mode, the owned set
 * (ready working sets + the owned-catalog snapshot) in postgres mode.
 */
export function listGuilds(): string[] {
  const ws = getWorkingSet();
  if (!ws || routeFor('0') !== 'postgres') return listGuildDirs();
  const ids = new Set<string>(ws.readyGuilds());
  for (const id of ownedCatalog) ids.add(id);
  return [...ids].filter(id => /^\d+$/.test(id));
}

/**
 * List a guild's data files (top-level .json, non-recursive) from whichever
 * backend routes the guild.
 */
export function listGuildDataFiles(guildId: string, category?: string): string[] {
  const ws = getWorkingSet();
  if (ws && routeFor(guildId) === 'postgres') {
    return ws.listFiles(guildId, category ?? '') ?? [];
  }
  return listGuildDataFilesFs(guildId, category);
}

/**
 * Deadline-bounded durability confirmation for one guild (operator writes:
 * 'ok' = committed, 'pending' = accepted but still retrying, 'held' = the store
 * refused it, kept and retried, 'deposed' = the store refused a batch for a
 * newer owner, so the set's unlanded writes were dropped and none was carried,
 * 'unavailable' = the writes left this manager's hold before they landed (a
 * recycle, an evict or a replacement), so whether they are stored is unknown).
 * It answers for the writes this node's current manager holds for the guild
 * when it is called: one not quiesced that holds no unlanded write of the
 * guild, carried or its own, and no set of it fenced within its drain, answers
 * 'ok', also while a predecessor's batch of the guild is still on the wire
 * (open_items.md, "A recycle's batch on the wire") or after a prune dropped a
 * carry of its writes (R8-J10); confirmSaved answers for those, by its lost
 * marks.
 */
export async function flushGuildOutcome(guildId: string, deadlineMs: number): Promise<'ok' | 'pending' | 'held' | 'deposed' | 'unavailable'> {
  // Only the files queued when this call began are its to answer for: a write
  // to another file meanwhile is its writer's, one to the same file carries this.
  const queued = pendingGuildFiles(guildId);
  await flushGuildFiles(guildId);
  if (filesPending(queued)) return 'held';
  const ws = getWorkingSet();
  if (ws && routeFor(guildId) === 'postgres') {
    // The set the flush answers for: one read here later (a replacement) holds
    // none of its writes.
    const set = ws.setOf(guildId);
    const outcome = await ws.flushGuildNow(guildId, deadlineMs);
    if (outcome !== 'unavailable') return outcome;
    // Recycled: pending while carries a later manager keeps hold every write
    // that set had not landed; a write in none, or a carry landed or dropped,
    // leaves this side unable to tell.
    return set && ws.setCarries(set)?.every(fate => fate.outcome() === 'kept') ? 'pending' : 'unavailable';
  }
  return 'ok';
}

/**
 * flushGuildOutcome for one accepted write: a later write of the same
 * document landing counts for it, and other writes of the guild still
 * queued do not.
 */
export async function confirmWrite(ticket: WriteTicket, deadlineMs: number): Promise<'ok' | 'pending' | 'held' | 'deposed' | 'unavailable'> {
  return confirmFrom(ticket, deadlineMs, ticket.seq);
}

/** confirmWrite for a ticket that answers for its key's writes from the seq from on (a scope or ledger entry's). */
export async function confirmFrom(ticket: WriteTicket, deadlineMs: number, from: number): Promise<'ok' | 'pending' | 'held' | 'deposed' | 'unavailable'> {
  if (ticket.kind === 'file') return confirmFile(ticket, deadlineMs);
  const outcome = await ticket.manager.confirm(ticket, deadlineMs);
  if (outcome !== 'unavailable') return outcome;
  // Recycled: pending while a later manager keeps the carry that took the write
  // off. One that landed answers unavailable too, as one dropped does: a write
  // the successor took before applying it may have replaced it unseen.
  return carryOf(ticket, from)?.outcome() === 'kept' ? 'pending' : 'unavailable';
}

export type SaveOutcome = 'ok' | 'pending' | 'held' | 'deposed' | 'unavailable' | 'refused';

/** confirmSaved's default bound, the reply gate's CONFIRM_MS (BT-1's bound). */
const CONFIRM_SAVED_MS = 8000;

// Worst first.
const SAVE_RANK: SaveOutcome[] = ['refused', 'deposed', 'unavailable', 'held', 'pending', 'ok'];
const worstSave = (answers: SaveOutcome[]): SaveOutcome =>
  answers.reduce((a, b) => (SAVE_RANK.indexOf(b) < SAVE_RANK.indexOf(a) ? b : a), 'ok');

/**
 * For a module that handles its own save outcomes (dataContract 2 in module.json): 'ok' only once every write the
 * facade accepted for this scope (a guild id, or 'global') after since is held by the store and none was refused;
 * otherwise the worst true answer: 'refused' for a refused write (or 'unavailable' once its document was rewritten
 * whole, which may carry the change), then confirmWrite's answers. since defaults to the start of the handler's run
 * for the interaction, panel action or console invoke in scope (for an interaction the dispatch gate held, its
 * admission; for a listener it never held, the interaction's opening), and outside every one of them to 0 (every
 * write since the process started): a timer takes saveMark() before its writes and passes it. A since that is not a mark of this run (a
 * number, or a mark kept from before a restart) answers 'unavailable'. It answers for every writer of the scope, not
 * the caller alone. category narrows file writes and refusals to that module's folder; a guild served from the
 * database answers for its whole working set, so another module's slower write can make it 'pending'. Raw atomic
 * writes are not counted. A working set's writes in the scope are answered together from the first of them: when
 * that one was on the wire as a recycle carried the set off, the answer is 'unavailable', even for a since after it
 * whose later writes the successor keeps (a cautious answer, as for a carry that landed).
 */
export async function confirmSaved(scope: string, options: { since?: SaveMark; deadlineMs?: number; category?: string } = {}): Promise<SaveOutcome> {
  const mark = options.since ?? currentSince();
  const since = mark === undefined ? 0 : stampOf(mark);
  if (since === null) return 'unavailable';
  const deadlineMs = options.deadlineMs ?? CONFIRM_SAVED_MS;
  const { tickets, lost, refused, pruned } = pendingFor(scope, since);
  const answers: SaveOutcome[] = pruned ? ['unavailable'] : [];
  for (const mark of lost) {
    answers.push(mark.deposed ? 'deposed' : mark.carry?.outcome() === 'kept' ? 'pending' : 'unavailable');
  }
  const docPrefix = options.category === undefined ? null : `${scope === 'global' ? 'global' : `guild:${scope}`}:${options.category}/`;
  for (const refusal of refused) {
    if (docPrefix === null || refusal.doc.startsWith(docPrefix)) answers.push(refusal.rewritten ? 'unavailable' : 'refused');
  }
  const folder = options.category === undefined
    ? null
    : getDataDirectory(scope === 'global' ? { scope: 'global', category: options.category } : { guildId: scope, category: options.category }) + path.sep;
  const judged = tickets.filter(ticket => ticket.kind === 'ws' || folder === null || ticket.path.startsWith(folder));
  // Each ticket answers for its entry's writes from the first, which a recycle may have left out of its carry.
  const froms = judged.map(ticket => firstSeqOf(scope, ticket));
  const first = await Promise.all(judged.map((ticket, i) => confirmFrom(ticket, deadlineMs, froms[i]).catch(() => 'unavailable' as const)));
  // A held write is retried while slower confirms finish, so it is read again when the answer is taken.
  const now = await Promise.all(first.map((answer, i) => answer !== 'held'
    ? answer
    : confirmFrom(judged[i], 0, froms[i]).then(again => (again === 'pending' ? 'held' as const : again), () => 'unavailable' as const)));
  return worstSave([...answers, ...now]);
}

/**
 * Raw JSON text of one guild doc from whichever backend routes the guild;
 * null = absent (or the working set is not ready).
 */
export function readGuildDocRaw(guildId: string, module: string, filename: string): string | null {
  const ws = getWorkingSet();
  if (ws && routeFor(guildId) === 'postgres') {
    return ws.readDocRaw(guildId, module, filename);
  }
  const filePath = getDataFilePath(filename, module ? { guildId, category: module } : { guildId });
  return readRaw(filePath);
}

/**
 * Every doc key a postgres-routed guild holds in its working set, or null when
 * the guild is file-routed or the set is not ready (caller uses its fs scan).
 */
export function listGuildDataKeys(guildId: string): { module: string; filename: string }[] | null {
  const ws = getWorkingSet();
  if (ws && routeFor(guildId) === 'postgres') {
    return ws.listAllKeys(guildId);
  }
  return null;
}

/**
 * Total size in bytes of a guild's data in its routing backend.
 */
export function sizeOfGuildData(guildId: string): Promise<number> {
  if (pgBackend && routeFor(guildId) === 'postgres') {
    return pgBackend.sizeOfGuildData(guildId);
  }
  return sizeOfGuildDir(guildId);
}

/**
 * Graveyard TTL sweep: always sweeps the file _graveyard (transformation-
 * retired file copies keep their TTL); in postgres mode the single janitor
 * (any non-co-worker role) additionally sweeps tombstoned rows.
 */
export async function sweepGraveyard(): Promise<void> {
  await sweepFileGraveyard();
  if (!pgBackend || routeFor('0') !== 'postgres') return;
  const explicitRole = (process.env.BOT_NODE_ROLE || '').trim().toLowerCase();
  const isCoWorker = explicitRole === 'co-worker' || explicitRole === 'backup-master';
  if (isCoWorker) return;
  const url = loadCredentials().DATA_BACKEND_URL;
  if (!url) return;
  const ttlDays = Number(process.env.GRAVEYARD_TTL_DAYS);
  const ttlMs = (Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays : 14) * 24 * 60 * 60 * 1000;
  try {
    const swept = await sweepGraveyardRows(url, Date.now() - ttlMs);
    if (swept > 0) console.log(`[Data] Swept ${swept} expired graveyard row(s)`);
  } catch (error) {
    console.warn('[Data] Graveyard row sweep failed:', error instanceof Error ? error.message : error);
  }
}

/**
 * Base data directory for all bot data
 */
const BASE_DATA_DIR = DATA_ROOT;

/**
 * Data scope - either guild-specific or global
 */
export type DataScope = 'guild' | 'global';

/**
 * Options for loading/saving data
 */
export interface DataOptions {
  /**
   * Guild ID for guild-scoped data (required if scope is 'guild')
   */
  guildId?: string | null;

  /**
   * Data scope - defaults to 'guild'
   */
  scope?: DataScope;

  /**
   * Custom subdirectory within guild/global folder
   * Example: 'giveaways', 'responses', 'users'
   */
  category?: string;
}

/**
 * Get the directory path for data storage
 */
function getDataDirectory(options: DataOptions): string {
  const scope = options.scope || 'guild';

  if (scope === 'global') {
    // Global data: /data/global/
    const dir = path.join(BASE_DATA_DIR, 'global');
    if (options.category) {
      return path.join(dir, options.category);
    }
    return dir;
  }

  // Guild data: /data/{guildId}/
  if (!options.guildId) {
    throw new Error('[DataManager] guildId is required for guild-scoped data');
  }

  const dir = path.join(BASE_DATA_DIR, options.guildId);
  if (options.category) {
    return path.join(dir, options.category);
  }
  return dir;
}

/**
 * Get the full file path for a data file
 */
function getDataFilePath(filename: string, options: DataOptions): string {
  const dir = getDataDirectory(options);
  return path.join(dir, filename);
}

// ============================================================================
// FREEZE (migration drain choke point)
// ============================================================================

// Cached: the write path only consults the .freeze sentinel when NOT standalone,
// so a standalone box (incl. a master with BOT_NODE_ROLE=master and no
// CONTROL_SECRET) pays zero extra per-write syscalls. This mirrors
// nodeIdentity.isStandalone (master role + no CONTROL_SECRET); the role
// resolution is duplicated locally to keep dataManager free of a fleet import.
let cachedFleetEnv: boolean | null = null;
function hasFleetEnv(): boolean {
  if (cachedFleetEnv === null) {
    const explicitRole = (process.env.BOT_NODE_ROLE || '').trim().toLowerCase();
    const isCoWorker = explicitRole === 'co-worker' || explicitRole === 'backup-master';
    const isStandalone = !isCoWorker && (process.env.CONTROL_SECRET || '').trim() === '';
    cachedFleetEnv = !isStandalone;
  }
  return cachedFleetEnv;
}

const frozenGuilds = new Set<string>();
let frozenWriteRejections = 0;
const rejectionsAtFreeze = new Map<string, number>();

export function freezeGuildWrites(guildId: string): void {
  frozenGuilds.add(guildId);
  rejectionsAtFreeze.set(guildId, frozenWriteRejections);
}

export function unfreezeGuildWrites(guildId: string): void {
  const atFreeze = rejectionsAtFreeze.get(guildId);
  rejectionsAtFreeze.delete(guildId);
  if (frozenGuilds.delete(guildId) && atFreeze !== undefined) {
    // Counter is facade-global, so with several guilds frozen at once the
    // delta attributes all rejections in the window to each; observability
    // only, exact counts live with the rejecting writer's own handling.
    const dropped = frozenWriteRejections - atFreeze;
    if (dropped > 0) console.log(`[Data] Guild ${guildId} unfrozen; ${dropped} frozen-write rejection(s) during the freeze window`);
  }
}

export function getFrozenStats(): { frozenGuilds: string[]; frozenWriteRejections: number } {
  return { frozenGuilds: [...frozenGuilds], frozenWriteRejections };
}

// Returns true when writes to this guild must be rejected (in-memory freeze set,
// or the cross-process .freeze sentinel when fleet env is present).
function isGuildFrozen(options: DataOptions): boolean {
  if ((options.scope || 'guild') !== 'guild') return false;
  const guildId = options.guildId;
  if (!guildId) return false;
  if (frozenGuilds.has(guildId)) return true;
  if (hasFleetEnv() && freezeSentinelExists(guildId)) return true;
  return false;
}

/**
 * Route-visible freeze check: the same gate the facade rejects writes with,
 * including the cross-process .freeze sentinel, so the webui process can refuse
 * an operator save instead of silently dropping it.
 */
export function isGuildWriteFrozen(guildId: string): boolean {
  return isGuildFrozen({ guildId });
}

// ============================================================================
// .owner MANIFESTS
// ============================================================================

export interface OwnerInfo {
  nodeId: string;
  term: number;
  epoch: number;
  shardCount: number;
}

let ownerInfoProvider: (() => OwnerInfo | null) | null = null;
// Guilds whose .owner has been stamped this process lifetime (no per-write cost).
const ownerStamped = new Set<string>();

/**
 * Wire the owner-info source (fleet/bootstrap after init). dataManager cannot
 * import fleet, so ownership is injected. Provider null (early boot) -> skip.
 */
export function setOwnerInfoProvider(fn: () => OwnerInfo | null): void {
  ownerInfoProvider = fn;
}

// Local copy of the guild->shard formula (placement.ts) to avoid an import
// cycle (fleet imports the facade, not vice versa).
function guildIdToShardId(guildId: string, shardCount: number): number {
  try {
    return Number((BigInt(guildId) >> 22n) % BigInt(Math.max(1, shardCount)));
  } catch {
    return 0;
  }
}

/**
 * Stamp /data/{guildId}/.owner if not yet done this process lifetime. Enqueued
 * through the same atomic queue. No-op when no provider is wired.
 */
export function stampOwner(guildId: string): void {
  // Postgres-routed guilds are stamped by the hydration claim (the ownership
  // row IS the manifest); a lazy write-time stamp would let a non-owner mint
  // a row and out-fence the real owner.
  if (routeFor(guildId) === 'postgres') return;
  if (ownerStamped.has(guildId)) return;
  const info = ownerInfoProvider?.();
  if (!info) return;
  ownerStamped.add(guildId);
  const manifest = {
    guildId,
    shardId: guildIdToShardId(guildId, info.shardCount),
    nodeId: info.nodeId,
    term: info.term,
    epoch: info.epoch,
    updatedAt: Date.now(),
  };
  const target = path.join(BASE_DATA_DIR, guildId, '.owner');
  writeRawAtomicFile(target, JSON.stringify(manifest, null, 2));
}

// ============================================================================
// RAW PATHS (root config, session files and other files outside the namespaces)
// ============================================================================

/** Queue an atomic write to an absolute path; refused once the exit drain has closed. */
export function writeRawAtomic(absPath: string, contents: string): boolean {
  if (closedForExit) {
    recordRefusal('node-stopping', `file:${absPath}`);
    throw new DataBackendUnavailableError('node-stopping');
  }
  const accepted = writeRawAtomicFile(absPath, contents);
  if (accepted) recordTicket(fileTicket(absPath), `file:${absPath}`);
  else recordRefusal('io', `file:${absPath}`);
  return accepted;
}

/** Queue an atomic delete of an absolute path (false: nothing to delete); refused once the exit drain has closed. */
export function deleteRawAtomic(absPath: string): boolean {
  if (closedForExit) {
    recordRefusal('node-stopping', `file:${absPath}`);
    throw new DataBackendUnavailableError('node-stopping');
  }
  const accepted = deleteRawAtomicFile(absPath);
  // A delete still queued for the path has not landed: it answers for this one.
  if (accepted || getPending(absPath)?.op === 'delete') recordTicket(fileTicket(absPath), `file:${absPath}`);
  return accepted;
}

/** The ticket for the raw op still queued on this path, taken right after writeRawAtomic or deleteRawAtomic; none once it landed. */
export function rawTicket(absPath: string): FileTicket | undefined {
  return getPending(absPath) ? fileTicket(absPath) : undefined;
}

// ============================================================================
// LOAD / SAVE
// ============================================================================

/**
 * Load JSON data from file
 * Returns defaultValue if file doesn't exist or on error
 */
export function loadData<T = any>(
  filename: string,
  options: DataOptions,
  defaultValue: T
): T {
  try {
    const wsGuild = wsRouted(options);
    if (wsGuild !== null) {
      getMetricsCollector().recordIO('read', options.guildId ?? null, options.category ?? null);
      const ws = getWorkingSet();
      if (!ws) {
        console.warn(`[Data] Read for postgres-routed guild ${wsGuild} outside the bot process; serving default`);
        return defaultValue;
      }
      const res = ws.read(wsGuild, options.category ?? '', filename);
      if (res.status === 'not-ready' || res.value === undefined) return defaultValue;
      return res.value as T;
    }
    const filePath = getDataFilePath(filename, options);
    getMetricsCollector().recordIO('read', options.scope === 'global' ? null : options.guildId ?? null, options.category ?? null);

    // Read-your-writes: a queued op is authoritative over disk.
    const pending = getPending(filePath);
    if (pending) {
      if (pending.op === 'delete') return defaultValue;
      if (pending.op === 'write') return JSON.parse(pending.content);
      // append ops fall through to disk (jsonl callers use readRaw, not loadData)
    }

    if (!existsOnDisk(filePath)) {
      console.log(`[DataManager] File not found: ${filePath} - returning default value`);
      return defaultValue;
    }

    const rawData = readFileUtf8(filePath);
    return JSON.parse(rawData || JSON.stringify(defaultValue));
  } catch (error) {
    console.error(`[DataManager] Error loading ${filename}:`, error);
    return defaultValue;
  }
}

/** One accepted write, as confirmWrite answers for it. */
export type WriteTicket = WsTicket | FileTicket;

/** Why a write was refused without a throw: its guild's working set is not ready (or not in this process), or storage failed. */
export type WriteRefusal = 'not-ready' | 'io';

export type SaveTracked = { outcome: 'saved'; ticket: WriteTicket } | { outcome: 'frozen' } | { outcome: 'refused'; cause: WriteRefusal };
export type AppendTracked = { outcome: 'appended'; ticket: WriteTicket } | { outcome: 'frozen' } | { outcome: 'refused'; cause: WriteRefusal };
/** An absent delete carries a ticket while an earlier delete of the same document has not landed. */
export type DeleteTracked = { outcome: 'deleted'; ticket: WriteTicket } | { outcome: 'absent'; ticket?: WriteTicket } | { outcome: 'frozen' } | { outcome: 'refused'; cause: WriteRefusal };

/** The document a facade write names, for the ledger's refusals. */
function docOf(filename: string, options: DataOptions): string {
  const owner = options.scope === 'global' ? 'global' : `guild:${options.guildId ?? ''}`;
  return `${owner}:${options.category ?? ''}/${filename}`;
}

/** The scope confirmSaved answers a facade write under: 'global', or its guild id. */
const scopeOf = (options: DataOptions): string => (options.scope === 'global' ? 'global' : options.guildId ?? '');

/**
 * Records a tracked write's outcome in the entry's ledger (writeLedger.ts), and a refusal's cause before its throw;
 * the write, accepted or refused, is also noted in its scope's record (scopeRecord.ts) for confirmSaved.
 * whole: the write replaces the whole document (a save or a delete); an earlier refusal of that document then cannot
 * be confirmed either way, since the rewrite may or may not carry the refused change.
 */
function recorded<R extends SaveTracked | AppendTracked | DeleteTracked>(doc: string, scope: string, whole: boolean, accept: () => R): R {
  let result: R;
  try {
    result = accept();
  } catch (error) {
    if (error instanceof DataBackendUnavailableError) {
      recordRefusal(error.causeKey, doc);
      noteScopeRefusal(scope, doc);
    }
    throw error;
  }
  const outcome: SaveTracked | AppendTracked | DeleteTracked = result;
  if ('ticket' in outcome && outcome.ticket) {
    recordTicket(outcome.ticket, whole ? doc : undefined);
    noteScopeTicket(scope, outcome.ticket, whole ? doc : undefined);
  } else if (outcome.outcome === 'frozen' || outcome.outcome === 'refused') {
    recordRefusal(outcome.outcome === 'frozen' ? 'frozen' : outcome.cause, doc);
    noteScopeRefusal(scope, doc);
  }
  return result;
}

/**
 * Save JSON data to file
 * Automatically creates directory if needed
 */
export function saveData<T = any>(
  filename: string,
  options: DataOptions,
  data: T
): boolean {
  return saveDataOutcome(filename, options, data) === 'saved';
}

/** A save that says whether it was accepted, met a frozen guild, or was refused (a set not ready, an I/O error). */
export function saveDataOutcome<T = any>(filename: string, options: DataOptions, data: T): 'saved' | 'frozen' | 'refused' {
  return saveDataTracked(filename, options, data).outcome;
}

/** saveDataOutcome with the ticket of an accepted write, or the cause of a refusal. */
export function saveDataTracked<T = any>(filename: string, options: DataOptions, data: T): SaveTracked {
  return recorded(docOf(filename, options), scopeOf(options), true, () => acceptSave(filename, options, data));
}

function acceptSave<T>(filename: string, options: DataOptions, data: T): SaveTracked {
  if (closedForExit) throw new DataBackendUnavailableError('node-stopping');
  try {
    if (isGuildFrozen(options)) {
      frozenWriteRejections += 1;
      return { outcome: 'frozen' };
    }
    const wsGuild = wsRouted(options);
    if (wsGuild !== null) {
      const ws = getWorkingSet();
      if (!ws) {
        console.warn(`[Data] Write for postgres-routed guild ${wsGuild} outside the bot process; refused`);
        return { outcome: 'refused', cause: 'not-ready' };
      }
      const content = JSON.stringify(data, null, 2);
      const result = ws.save(wsGuild, options.category ?? '', filename, content);
      if (result === 'accepted') {
        const ticket = ws.ticketFor(wsGuild);
        getMetricsCollector().recordIO('write', options.guildId ?? null, options.category ?? null);
        return { outcome: 'saved', ticket };
      }
      if (result === 'frozen-window') { frozenWriteRejections += 1; return { outcome: 'frozen' }; }
      if (result === 'not-ready') return { outcome: 'refused', cause: 'not-ready' };
      throw result === 'fenced' ? new DataBackendUnavailableError('guild-fenced')
        : result === 'read-only' ? new DataBackendUnavailableError('database-read-only')
          : ws.refusal();
    }
    const dir = getDataDirectory(options);
    const filePath = getDataFilePath(filename, options);
    const scope = options.scope || 'guild';

    // Ensure the dir synchronously so the guild dir exists (and .owner can be
    // stamped) the moment the save is accepted, matching today's create timing.
    ensureDirectory(dir);
    if (scope === 'guild' && options.guildId) stampOwner(options.guildId);

    const content = JSON.stringify(data, null, 2);
    enqueueWrite(filePath, content);
    const ticket = fileTicket(filePath);
    getMetricsCollector().recordIO('write', scope === 'global' ? null : options.guildId ?? null, options.category ?? null);

    console.log(`[DataManager] Saved ${filename} to ${filePath}`);
    return { outcome: 'saved', ticket };
  } catch (error) {
    if (error instanceof DataBackendUnavailableError) throw error;
    console.error(`[DataManager] Error saving ${filename}:`, error);
    return { outcome: 'refused', cause: 'io' };
  }
}

/**
 * Append a line to a data file (serialized through the same queue). A torn tail
 * line on crash is tolerated by callers (they skip bad lines on read).
 */
export function appendData(filename: string, options: DataOptions, line: string): boolean {
  return appendDataTracked(filename, options, line).outcome === 'appended';
}

/** appendData with the ticket of an accepted append, or the cause of a refusal. */
export function appendDataTracked(filename: string, options: DataOptions, line: string): AppendTracked {
  return recorded(docOf(filename, options), scopeOf(options), false, () => acceptAppend(filename, options, line));
}

function acceptAppend(filename: string, options: DataOptions, line: string): AppendTracked {
  if (closedForExit) throw new DataBackendUnavailableError('node-stopping');
  try {
    if (isGuildFrozen(options)) {
      frozenWriteRejections += 1;
      return { outcome: 'frozen' };
    }
    const wsGuild = wsRouted(options);
    if (wsGuild !== null) {
      const ws = getWorkingSet();
      if (!ws) {
        console.warn(`[Data] Append for postgres-routed guild ${wsGuild} outside the bot process; refused`);
        return { outcome: 'refused', cause: 'not-ready' };
      }
      const result = ws.append(wsGuild, options.category ?? '', filename, line);
      if (result === 'accepted') {
        const ticket = ws.ticketFor(wsGuild);
        getMetricsCollector().recordIO('write', options.guildId ?? null, options.category ?? null);
        return { outcome: 'appended', ticket };
      }
      if (result === 'frozen-window') { frozenWriteRejections += 1; return { outcome: 'frozen' }; }
      if (result === 'not-ready') return { outcome: 'refused', cause: 'not-ready' };
      throw result === 'fenced' ? new DataBackendUnavailableError('guild-fenced')
        : result === 'read-only' ? new DataBackendUnavailableError('database-read-only')
          : ws.refusal();
    }
    const dir = getDataDirectory(options);
    const filePath = getDataFilePath(filename, options);
    const scope = options.scope || 'guild';
    ensureDirectory(dir);
    if (scope === 'guild' && options.guildId) stampOwner(options.guildId);

    enqueueAppend(filePath, line);
    const ticket = fileTicket(filePath);
    getMetricsCollector().recordIO('write', scope === 'global' ? null : options.guildId ?? null, options.category ?? null);
    return { outcome: 'appended', ticket };
  } catch (error) {
    if (error instanceof DataBackendUnavailableError) throw error;
    console.error(`[DataManager] Error appending ${filename}:`, error);
    return { outcome: 'refused', cause: 'io' };
  }
}

/**
 * Check if data file exists
 */
export function dataExists(filename: string, options: DataOptions): boolean {
  const wsGuild = wsRouted(options);
  if (wsGuild !== null) {
    return getWorkingSet()?.exists(wsGuild, options.category ?? '', filename) ?? false;
  }
  const filePath = getDataFilePath(filename, options);
  const pending = getPending(filePath);
  if (pending) {
    if (pending.op === 'delete') return false;
    return true;
  }
  return existsOnDisk(filePath);
}

/**
 * Delete data file
 */
export function deleteData(filename: string, options: DataOptions): boolean {
  return deleteDataOutcome(filename, options) === 'deleted';
}

/** A delete that says whether it was done, found nothing to delete, met a frozen guild, or was refused (a set not ready, an I/O error). */
export function deleteDataOutcome(filename: string, options: DataOptions): 'deleted' | 'absent' | 'frozen' | 'refused' {
  return deleteDataTracked(filename, options).outcome;
}

/** deleteDataOutcome with the ticket of an accepted delete, or the cause of a refusal. */
export function deleteDataTracked(filename: string, options: DataOptions): DeleteTracked {
  return recorded(docOf(filename, options), scopeOf(options), true, () => acceptDelete(filename, options));
}

function acceptDelete(filename: string, options: DataOptions): DeleteTracked {
  if (closedForExit) throw new DataBackendUnavailableError('node-stopping');
  try {
    if (isGuildFrozen(options)) {
      frozenWriteRejections += 1;
      return { outcome: 'frozen' };
    }
    const wsGuild = wsRouted(options);
    if (wsGuild !== null) {
      const ws = getWorkingSet();
      if (!ws) {
        console.warn(`[Data] Delete for postgres-routed guild ${wsGuild} outside the bot process; refused`);
        return { outcome: 'refused', cause: 'not-ready' };
      }
      const result = ws.delete(wsGuild, options.category ?? '', filename);
      if (result === 'absent') {
        console.log(`[DataManager] File not found for deletion: ${wsGuild}/${options.category ?? ''}/${filename}`);
        const earlier = ws.unlandedDeleteTicket(wsGuild, options.category ?? '', filename);
        return earlier ? { outcome: 'absent', ticket: earlier } : { outcome: 'absent' };
      }
      if (result === 'accepted') {
        const ticket = ws.ticketFor(wsGuild);
        console.log(`[DataManager] Deleted ${wsGuild}/${options.category ?? ''}/${filename}`);
        return { outcome: 'deleted', ticket };
      }
      if (result === 'frozen-window') { frozenWriteRejections += 1; return { outcome: 'frozen' }; }
      if (result === 'not-ready') return { outcome: 'refused', cause: 'not-ready' };
      throw result === 'fenced' ? new DataBackendUnavailableError('guild-fenced')
        : result === 'read-only' ? new DataBackendUnavailableError('database-read-only')
          : ws.refusal();
    }
    const filePath = getDataFilePath(filename, options);

    const pending = getPending(filePath);
    const existsNow = existsOnDisk(filePath);
    // Nothing to delete: neither a queued write nor a file on disk. A queued
    // delete has not landed, and an op on the wire ahead of it may create the file.
    if (!existsNow && (!pending || pending.op === 'delete')) {
      console.log(`[DataManager] File not found for deletion: ${filePath}`);
      return pending ? { outcome: 'absent', ticket: fileTicket(filePath) } : { outcome: 'absent' };
    }

    // Enqueue a delete tombstone (serialized with in-flight writes so a queued
    // write cannot resurrect the file).
    enqueueDelete(filePath);
    const ticket = fileTicket(filePath);
    console.log(`[DataManager] Deleted ${filePath}`);
    return { outcome: 'deleted', ticket };
  } catch (error) {
    if (error instanceof DataBackendUnavailableError) throw error;
    console.error(`[DataManager] Error deleting ${filename}:`, error);
    return { outcome: 'refused', cause: 'io' };
  }
}

// ============================================================================
// GUILD NAMESPACE DELETION (graveyard)
// ============================================================================

/**
 * Retire a guild namespace to the graveyard (same volume). Flushes and drops
 * any pending state for the guild, then renames the dir under _graveyard and
 * writes a .graveyard.json reason marker inside.
 */
export async function deleteGuildNamespace(guildId: string, reason: string, flushMs = 30000): Promise<boolean> {
  if (routeFor(guildId) === 'postgres') {
    if (!pgBackend) return false;
    const ws = getWorkingSet();
    if (ws) {
      // Writes that did not reach the store are kept, and nothing removed.
      const flushed = await ws.flushGuildNow(guildId, flushMs);
      if (flushed !== 'ok') {
        console.error(`[DataManager] Cannot retire guild ${guildId}: its unflushed writes did not reach the store (${flushed}); nothing was removed`);
        return false;
      }
      ws.evict(guildId);
    }
    frozenGuilds.delete(guildId);
    ownerStamped.delete(guildId);
    const token = fenceFromOwnerInfo(guildId);
    if (!token) {
      console.warn(`[DataManager] Cannot retire guild ${guildId}: no owner info wired`);
      return false;
    }
    const res = await pgBackend.retireGuild(guildId, reason, token);
    if (!res.ok) {
      console.error(`[DataManager] Failed to retire guild ${guildId} (${res.reason})`);
      return false;
    }
    if (res.moved > 0) console.log(`[DataManager] Guild ${guildId} moved to graveyard (${reason})`);
    return res.moved > 0;
  }
  if (!guildDirExists(guildId)) return false;

  await flushGuild(guildId);
  // Drop pending entries + freeze/stamp state for this guild.
  dropPendingForGuild(guildId);
  frozenGuilds.delete(guildId);
  ownerStamped.delete(guildId);

  return graveyardGuildDir(guildId, reason);
}

/**
 * Restore a retired guild namespace from the graveyard. Refusals (live data
 * exists, no matching entry) come back as {ok:false, error}; backend outages
 * throw DataBackendUnavailableError and IO failures throw plain errors.
 * retiredAt absent = the guild's newest graveyard batch/entry.
 */
export async function restoreGuildFromGraveyard(guildId: string, retiredAt?: number): Promise<{ ok: boolean; error?: string; moved?: number }> {
  if (routeFor(guildId) === 'postgres') {
    if (!pgBackend) throw new DataBackendUnavailableError('database-unreachable');
    let batch = retiredAt;
    if (batch === undefined) {
      if (!(pgBackend instanceof PostgresBackend)) throw new DataBackendUnavailableError('database-unreachable');
      let newest: number | null;
      try {
        newest = await pgBackend.latestGraveyardBatch(guildId);
      } catch {
        throw new DataBackendUnavailableError('database-unreachable');
      }
      if (newest === null) return { ok: false, error: 'no graveyard entry for this guild' };
      batch = newest;
    }
    const token = fenceFromOwnerInfo(guildId)
      ?? { nodeId: '', term: 0, epoch: 0, shardId: 0, shardCount: 1 };
    const res = await pgBackend.restoreGuild(guildId, batch, token);
    if (res.ok) {
      // The pre-restore ready gate hydrated the guild EMPTY (claim-then-read
      // saw no rows); evict that set so the next access rehydrates with the
      // restored docs instead of serving the stale emptiness.
      getWorkingSet()?.evict(guildId);
      return { ok: true, moved: res.moved };
    }
    if (res.reason === 'live-rows') return { ok: false, error: 'live guild data exists; delete it before restoring' };
    throw new DataBackendUnavailableError('database-unreachable');
  }
  return restoreGuildDirFromGraveyard(guildId, retiredAt);
}

/**
 * Helper: Load guild-scoped data
 */
export function loadGuildData<T = any>(
  filename: string,
  guildId: string,
  defaultValue: T,
  category?: string
): T {
  return loadData(filename, { guildId, scope: 'guild', category }, defaultValue);
}

/**
 * Helper: Save guild-scoped data
 */
export function saveGuildData<T = any>(
  filename: string,
  guildId: string,
  data: T,
  category?: string
): boolean {
  return saveData(filename, { guildId, scope: 'guild', category }, data);
}

/**
 * Helper: Load global data
 */
export function loadGlobalData<T = any>(
  filename: string,
  defaultValue: T,
  category?: string
): T {
  return loadData(filename, { scope: 'global', category }, defaultValue);
}

/**
 * Helper: Save global data
 */
export function saveGlobalData<T = any>(
  filename: string,
  data: T,
  category?: string
): boolean {
  return saveData(filename, { scope: 'global', category }, data);
}

// ============================================================================
// MODULE-NAMESPACED DATA HELPERS
// ============================================================================

/**
 * Load module-scoped data (guild-specific)
 * Automatically namespaces data by module name
 *
 * @param filename - Data filename (supports subfolders: 'archive/2024.json')
 * @param guildId - Guild ID
 * @param moduleName - Module name (used as namespace)
 * @param defaultValue - Default value if file doesn't exist
 * @returns Loaded data or default value
 *
 * @example
 * // Loads from: /data/{guildId}/giveaway/data.json
 * loadModuleData('data.json', '123456', 'giveaway', {})
 *
 * // Loads from: /data/{guildId}/giveaway/archive/2024.json
 * loadModuleData('archive/2024.json', '123456', 'giveaway', [])
 */
export function loadModuleData<T = any>(
  filename: string,
  guildId: string,
  moduleName: string,
  defaultValue: T
): T {
  return loadGuildData(filename, guildId, defaultValue, moduleName);
}

/**
 * Save module-scoped data (guild-specific)
 * Automatically namespaces data by module name
 *
 * @param filename - Data filename (supports subfolders: 'archive/2024.json')
 * @param guildId - Guild ID
 * @param moduleName - Module name (used as namespace)
 * @param data - Data to save
 * @returns True once the write is accepted: queued to be stored, not stored yet (confirmSaved(guildId) says when it
 * is). False for a frozen guild, a set not ready or a storage error. A stopping bot or a database refusal
 * (unreachable, read-only, fenced) throws DataBackendUnavailableError.
 *
 * @example
 * // Saves to: /data/{guildId}/giveaway/data.json
 * saveModuleData('data.json', '123456', 'giveaway', { active: true })
 */
export function saveModuleData<T = any>(
  filename: string,
  guildId: string,
  moduleName: string,
  data: T
): boolean {
  return saveGuildData(filename, guildId, data, moduleName);
}

/**
 * Load global module data
 * Automatically namespaces data by module name
 *
 * @param filename - Data filename (supports subfolders)
 * @param moduleName - Module name (used as namespace)
 * @param defaultValue - Default value if file doesn't exist
 * @returns Loaded data or default value
 *
 * @example
 * // Loads from: /data/global/analytics/stats.json
 * loadGlobalModuleData('stats.json', 'analytics', {})
 */
export function loadGlobalModuleData<T = any>(
  filename: string,
  moduleName: string,
  defaultValue: T
): T {
  return loadGlobalData(filename, defaultValue, moduleName);
}

/**
 * Save global module data
 * Automatically namespaces data by module name
 *
 * @param filename - Data filename (supports subfolders)
 * @param moduleName - Module name (used as namespace)
 * @param data - Data to save
 * @returns True once the write is accepted: queued to be stored, not stored yet (confirmSaved('global') says when it
 * is). False for a storage error. A stopping bot throws DataBackendUnavailableError.
 *
 * @example
 * // Saves to: /data/global/analytics/stats.json
 * saveGlobalModuleData('stats.json', 'analytics', { totalUsers: 100 })
 */
export function saveGlobalModuleData<T = any>(
  filename: string,
  moduleName: string,
  data: T
): boolean {
  return saveGlobalData(filename, data, moduleName);
}

/**
 * List all data files for a module (guild-specific)
 *
 * @param guildId - Guild ID
 * @param moduleName - Module name
 * @returns Array of filenames
 *
 * @example
 * listModuleDataFiles('123456', 'giveaway')
 * // Returns: ['data.json', 'archive/2024.json', ...]
 */
export function listModuleDataFiles(guildId: string, moduleName: string): string[] {
  return listGuildDataFiles(guildId, moduleName);
}

/**
 * List all global data files for a module
 *
 * @param moduleName - Module name
 * @returns Array of filenames
 *
 * @example
 * listGlobalModuleDataFiles('analytics')
 * // Returns: ['stats.json', 'reports.json', ...]
 */
export function listGlobalModuleDataFiles(moduleName: string): string[] {
  return listGlobalDataFiles(moduleName);
}

/**
 * Check if module data file exists (guild-specific)
 *
 * @param filename - Data filename
 * @param guildId - Guild ID
 * @param moduleName - Module name
 * @returns True if file exists
 */
export function moduleDataExists(
  filename: string,
  guildId: string,
  moduleName: string
): boolean {
  return dataExists(filename, { guildId, scope: 'guild', category: moduleName });
}

/**
 * Check if global module data file exists
 *
 * @param filename - Data filename
 * @param moduleName - Module name
 * @returns True if file exists
 */
export function globalModuleDataExists(filename: string, moduleName: string): boolean {
  return dataExists(filename, { scope: 'global', category: moduleName });
}

/**
 * Delete module data file (guild-specific)
 *
 * @param filename - Data filename
 * @param guildId - Guild ID
 * @param moduleName - Module name
 * @returns True once the delete is accepted: queued, not stored yet (confirmSaved(guildId) says when it is). False
 * when the file was absent, for a frozen guild, a set not ready or a storage error. A stopping bot or a database
 * refusal (unreachable, read-only, fenced) throws DataBackendUnavailableError.
 */
export function deleteModuleData(
  filename: string,
  guildId: string,
  moduleName: string
): boolean {
  return deleteData(filename, { guildId, scope: 'guild', category: moduleName });
}

/**
 * Delete global module data file
 *
 * @param filename - Data filename
 * @param moduleName - Module name
 * @returns True once the delete is accepted: queued, not stored yet (confirmSaved('global') says when it is). False
 * when the file was absent or for a storage error. A stopping bot throws DataBackendUnavailableError.
 */
export function deleteGlobalModuleData(filename: string, moduleName: string): boolean {
  return deleteData(filename, { scope: 'global', category: moduleName });
}
