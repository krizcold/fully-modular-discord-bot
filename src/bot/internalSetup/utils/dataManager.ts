// Data Manager - Centralized guild-aware data storage
// Handles per-guild data isolation with optional global data access.
//
// This is the module-facing facade: loadData/saveData/dataExists/deleteData
// and every helper keep their exact signatures and return values. The facade
// owns IO metrics and the write records; physical storage lives
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
  guildDirExists,
  guildHasQueuedOps,
  guildFailingWrite,
  fsyncDataDirs,
  graveyardGuildDir,
  restoreGuildDirFromGraveyard,
  writeRawAtomic as writeRawAtomicFile,
  deleteRawAtomic as deleteRawAtomicFile,
  lastRawRefusal,
  listGuildDataFiles as listGuildDataFilesFs,
  listGlobalDataFiles,
  placeGuildWrite,
  guildWriteCollision,
  noteGuildWrite,
  guildKeyStored,
  noteGuildDelete,
} from './dataBackends/fileBackend';
import { keyRefusal, pathKeyOf, sizeRefusal, textRefusal, valueText } from './storableData';

import {
  flushAll as flushAllFiles,
  failReplacedTriesAtExit,
  forgetDurableFiles,
  forgetGuildDurableFiles,
  fileTicketState,
  queuedFileWrites,
  unconfirmedFiles,
  unsavedFileWrites,
  fileFlushOnTheWire,
  fileFlushesLanded,
  flushGuild as flushGuildFiles,
  filesPending,
  flushFailing as flushFailingFiles,
  readRawStrict,
  sweepGraveyard as sweepFileGraveyard,
  listGuilds as listGuildDirs,
} from './dataBackends/fileBackend';
import { commitAnswerOwed, getWorkingSet, DataBackendUnavailableError } from './dataBackends/workingSet';
import type { WsTicket } from './dataBackends/workingSet';
import type { FileRestoreOutcome, FileTicket } from './dataBackends/fileBackend';
import { deadlineIn, msLeft } from './dataBackends/postgresBackend';
import type { DataBackend, FenceToken, RestoreOutcome, RestoreStop, RetireOutcome } from './dataBackends/backend';
import { resolveDataBackend } from '../../../utils/envLoader';
import { currentLedger, currentSince, recordRefusal, recordTicket } from './dataBackends/writeLedger';
import { markBarrier, noteScopeRefusal, noteScopeTicket, pendingFor, saveMark, stampOf, type SaveMark } from './dataBackends/scopeRecord';
import { canonicalGuildKey, GuildKeyError, type GuildKey } from './dataKeys';
import { isMaintenanceGateClosed } from './maintenanceGate';
import { stoppedServing } from './servingGate';
import type { HeldCounts } from './heldWords';

export { listGlobalDataFiles, saveMark };
export type { SaveMark };
export { DataBackendUnavailableError } from './dataBackends/workingSet';
export {
  flushFailing,
  getFlushFailures,
  readRaw,
  readRawStrict,
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

const servedByPostgres = (): boolean => resolveDataBackend() === 'postgres';

// Postgres-routed guild-scope calls answer from the Working Set; a missing
// manager (the webui parent process, or a not-yet-wired boot) REFUSES rather
// than falling through to files - a file write for a postgres-routed guild is
// always a bug.
function wsRouted(options: DataOptions): string | null {
  if ((options.scope || 'guild') !== 'guild') return null;
  const guildId = options.guildId;
  if (!guildId) return null;
  return servedByPostgres() ? guildId : null;
}

export function fenceFromOwnerInfo(guildId: string): FenceToken | null {
  const info = ownerInfoProvider?.();
  if (!info) return null;
  const shardId = guildIdToShardId(guildId, info.shardCount);
  return {
    nodeId: info.nodeId,
    claim: info.claimOf(shardId),
    processId: info.processId,
    shardId,
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
  logDrainLeft('A full flush', leftover);
}

/**
 * NB13 decision 6: the held guilds less those holding only a save the database did not answer, then those holding
 * such a save, each in a line of its own.
 */
function logDrainLeft(what: 'Shutdown drain' | 'A full flush', held: string[]): void {
  const unanswered = getWorkingSet()?.unansweredGuilds() ?? { all: [], only: [] };
  const left = held.filter(guildId => !unanswered.only.includes(guildId));
  if (left.length > 0) console.warn(`[Data] ${what} left ${left.length} guild(s) with unflushed writes: ${left.join(', ')}`);
  if (unanswered.all.length > 0) {
    console.warn(`[Data] ${what} left guild(s) ${unanswered.all.join(', ')} holding a save whose COMMIT got no answer, which may have landed`);
  }
}

const EXIT_DRAIN_POLL_MS = 100;
const EXIT_DRAIN_GIVEUP_MS = 3000;
// The working set had the exit drain's bound; the pass after it waits only on the file lines it queued, inside BotManager's 40 s.
const AFTER_DRAIN_BOUND_MS = 5000;
let exitDrain: Promise<void> | null = null;
let closedForExit = false;

const pause = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, Math.max(0, ms)); });

function writesSettled(filesOnly = false): boolean {
  const ws = filesOnly ? null : getWorkingSet();
  return queuedFileWrites() === 0 && (!ws || ws.writesSettled());
}

const landedFlushes = () => fileFlushesLanded() + (getWorkingSet()?.landedFlushes() ?? 0);
const flushOnTheWire = (filesOnly = false) => fileFlushOnTheWire() || (!filesOnly && (getWorkingSet()?.flushOnTheWire() ?? false));

// A pass flushes what is queued when it starts: a write accepted during it and
// a flush already on the wire are the next pass's, and the pause hands a flush
// on the wire the event loop. A store that refuses (down, a failing
// disk) is retried until nothing has landed for EXIT_DRAIN_GIVEUP_MS and
// nothing is on the wire, so a blip drains and a dead store costs that window,
// not the bound.
async function drainUntilSettled(deadline: number, progress: { at: number; landed: number }, filesOnly = false): Promise<void> {
  while (!writesSettled(filesOnly) && Date.now() < deadline) {
    const ws = filesOnly ? null : getWorkingSet();
    await Promise.race([
      Promise.all([flushAllFiles(), ws ? ws.flushAllDirty() : null]).catch(() => undefined),
      pause(deadline - Date.now()),
    ]);
    if (writesSettled(filesOnly)) return;
    if (landedFlushes() !== progress.landed) {
      progress.landed = landedFlushes();
      progress.at = Date.now();
    } else if (!flushOnTheWire(filesOnly) && Date.now() - progress.at >= EXIT_DRAIN_GIVEUP_MS) return;
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
      try {
        await drainUntilSettled(deadline - Math.floor(boundMs / 5), progress);
        closedForExit = true;
        await drainUntilSettled(deadline, progress);
        logDrainLeft('Shutdown drain', getWorkingSet()?.dirtyGuildIds() ?? []);
        const files = queuedFileWrites();
        if (files > 0) console.warn(`[Data] Shutdown drain left ${files} file(s) with queued writes`);
      } finally {
        failReplacedTriesAtExit();
        // A loss whose leave never ended logs what it dropped here.
        for (const line of getWorkingSet()?.takeDropLines() ?? []) console.error(line);
      }
    })();
  }
  return exitDrain;
}

/** The exit drain has started: it owns the process from here to its exit. */
export function isExitDraining(): boolean {
  return exitDrain !== null;
}

/**
 * Maintenance's save: flushes the working set and the queued file writes until nothing is held, nothing lands for the
 * drain's give-up window, or boundMs passes. Unlike the exit drain it closes nothing. Answers what is still held.
 */
export async function saveHeldWrites(boundMs: number): Promise<HeldCounts> {
  await drainUntilSettled(Date.now() + boundMs, { at: Date.now(), landed: landedFlushes() });
  const ws = getWorkingSet();
  const unanswered = ws?.unansweredGuilds() ?? { all: [], only: [] };
  return {
    unsavedGuilds: (ws?.dirtyGuildIds() ?? []).filter(guildId => !unanswered.only.includes(guildId)).length,
    unsavedFiles: unsavedFileWrites(),
    unansweredGuilds: unanswered.all.length,
    unconfirmedFiles: unconfirmedFiles(),
  };
}

let guildWritesClosed = false;

/** The data layer refused to serve: every guild-scope write from now on is refused, so none lands in a store the deployment's data does not live in. */
export function closeGuildWrites(): void {
  guildWritesClosed = true;
}

/** Whether closeGuildWrites ran: every guild-scope write is refused. */
export function areGuildWritesClosed(): boolean {
  return guildWritesClosed;
}

let guildDataServing = false;

/** The data boot verified the database and its schema: the graveyard sweep may touch it from now on. */
export function noteGuildDataServing(): void {
  guildDataServing = true;
}

/** A guild write while the maintenance gate is closed: the data may be moving, so nothing is accepted. */
function refuseInMaintenance(options: DataOptions): void {
  if ((options.scope || 'guild') === 'guild') refuseGuildChangeInMaintenance();
}

/** A guild change (a write, a move to or from the graveyard) while the gate is closed would land after the confirmed save. */
function refuseGuildChangeInMaintenance(): void {
  if (isMaintenanceGateClosed()) throw new DataBackendUnavailableError('maintenance');
}

function guildWriteClosed(options: DataOptions, what: string): boolean {
  if (!guildWritesClosed || (options.scope || 'guild') !== 'guild') return false;
  console.warn(`[Data] ${what} for guild ${options.guildId ?? ''} while the data layer refuses to serve; refused`);
  return true;
}

/** Whether the exit drain has closed the facade: every write from now on is refused as node-stopping. */
export function isClosedForExit(): boolean {
  return closedForExit;
}

let stopBegun = false;
let processStop: (() => Promise<void>) | null = null;

/**
 * The process's shutdown handler: runs its steps once, the stop marked begun before the first of them. The one built
 * last is the process's stop, which stopProcess runs.
 */
export function stopHandler(steps: () => Promise<void>): () => Promise<void> {
  const handler = async () => {
    if (stopBegun) return;
    stopBegun = true;
    await steps();
  };
  processStop = handler;
  return handler;
}

/** NB4 decision 16: a process that nothing can restart ends through its own stop handler. */
export function stopProcess(): void {
  if (!processStop) {
    console.error('[Data] No stop handler is built yet; the bot process exits');
    process.exit(0);
  }
  void processStop();
}

/** A stop has begun or the exit drain runs: a write not saved by now may never be retried, and may be lost. */
export function isStopping(): boolean {
  return stopBegun || exitDrain !== null;
}

/** The bot process's exit code when another process took the data files' lock (decision 20 of NB10). */
export const EXIT_DEPOSED = 75;

type StopStep = () => void | Promise<void>;
const stopSteps: StopStep[] = [];
const finalStopSteps: StopStep[] = [];
let finalStepsRan = false;
let stopExitCode = 0;
let stopRunner: (() => Promise<void>) | null = null;

/** A step the stop runs before the final steps, in registration order (the samplers, the gateway close). */
export function addStopStep(step: StopStep): void {
  stopSteps.push(step);
}

/** A step the stop runs after every other step; one added once the final steps ran runs at once. */
export function addFinalStopStep(step: StopStep): void {
  if (finalStepsRan) {
    void Promise.resolve().then(step).catch(error => console.error('[Data] A stop step failed:', error));
    return;
  }
  finalStopSteps.push(step);
}

const afterDrainSteps: Array<() => boolean> = [];

/** A step run once the exit drain ended; one that queued a write answers true, and the stop runs one more drain pass. */
export function addAfterDrainStep(step: () => boolean): void {
  afterDrainSteps.push(step);
}

export function runAfterDrainSteps(): boolean {
  let queued = false;
  for (const step of afterDrainSteps) {
    try {
      if (step()) queued = true;
    } catch (error) {
      console.error('[Data] A step after the exit drain failed:', error);
    }
  }
  return queued;
}

async function runSteps(steps: StopStep[]): Promise<void> {
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      console.error('[Data] A stop step failed:', error);
    }
  }
}

const releaseSteps: StopStep[] = [];

/** A step the stop runs after the exit drain and the pass after it, right before the exit (the shard claims' release). */
export function addReleaseStep(step: StopStep): void {
  releaseSteps.push(step);
}

/**
 * The bot process's one stop: SIGTERM and SIGINT run the stop steps, the final steps, the exit drain, the release
 * steps, then exit; a step that throws still exits.
 */
export function installStopHandler(): void {
  if (stopRunner) return;
  stopRunner = stopHandler(async () => {
    try {
      await runSteps(stopSteps);
      finalStepsRan = true;
      await runSteps(finalStopSteps.splice(0));
      await drainForExit(getWorkingSet() ? 30000 : 5000);
      if (runAfterDrainSteps()) await drainUntilSettled(Date.now() + AFTER_DRAIN_BOUND_MS, { at: Date.now(), landed: landedFlushes() }, true);
      await runSteps(releaseSteps);
    } catch (error) {
      console.error('[Data] A stop step failed; the bot process exits:', error);
    } finally {
      process.exit(stopExitCode);
    }
  });
  process.on('SIGTERM', () => void stopRunner?.());
  process.on('SIGINT', () => void stopRunner?.());
}

/** Starts the stop as a signal would; deposed: another process took the lock, so the exit code is EXIT_DEPOSED. */
export function beginStop(deposed = false): Promise<void> {
  if (deposed && !stopBegun) stopExitCode = EXIT_DEPOSED;
  return stopRunner ? stopRunner() : Promise.resolve();
}

// The web UI process installs the shared gate (none in the bot process): outside a change it applies itself, every
// file write of that process is refused, sessions excepted. A process another one deposed closes every shared write.
let sharedWriteGate: (() => boolean) | null = null;
let sharedWritesLost = false;
const SESSIONS_DIR = path.resolve(DATA_ROOT, '_sessions') + path.sep;

export function setSharedWriteGate(gate: (() => boolean) | null): void {
  sharedWriteGate = gate;
}

/** The web UI's gate is installed and closed here: this context is outside a change the web UI applies itself. */
export function sharedWritesGatedHere(): boolean {
  return sharedWriteGate !== null && !sharedWriteGate();
}

/** Another process took the data files' lock: every shared write of this process is refused from now on. */
export function closeSharedWritesLost(): void {
  sharedWritesLost = true;
}

/** The deposed web UI took the lock again. */
export function reopenSharedWrites(): void {
  sharedWritesLost = false;
}

export function sharedWritesClosedLost(): boolean {
  return sharedWritesLost;
}

/** Whether a write of this path is a shared-file write (every file write but a session's). */
export function isSharedPath(absPath: string): boolean {
  return !path.resolve(absPath).startsWith(SESSIONS_DIR);
}

/** The cause the shared gate refuses this path with, or null when it passes. */
function sharedRefusal(absPath: string): 'writer-lost' | 'not-ready' | null {
  if (!isSharedPath(absPath)) return null;
  if (sharedWritesLost) {
    console.error(`[Data] Write of ${absPath} refused: another process took the data files`);
    return 'writer-lost';
  }
  if (sharedWriteGate && !sharedWriteGate()) {
    console.error(`[Data] Write of ${absPath} refused: the web UI process writes data files only inside a change it applies itself (the bot process applies writes while it runs)`);
    return 'not-ready';
  }
  return null;
}

const writerTakeSteps: Array<() => void> = [];

/** A step run at every take of the writer lock from depth 0: what this process knew of a shared file may be stale. */
export function onWriterTake(step: () => void): void {
  writerTakeSteps.push(step);
}

/** Clears what this process knows of the shared files' contents; run by the writer lock at each take. */
export function forgetSharedFileKnowledge(): void {
  forgetDurableFiles();
  for (const step of writerTakeSteps) {
    try {
      step();
    } catch (error) {
      console.error('[Data] A writer-take step failed:', error);
    }
  }
}

/**
 * Flush every queued op for one guild.
 */
export async function flushGuild(guildId: string): Promise<void> {
  await flushGuildFiles(guildId);
  const ws = getWorkingSet();
  if (ws && servedByPostgres()) {
    await ws.flushGuildNow(guildId, 30000);
  }
}

/**
 * List guild ids this node serves: guild dirs in file mode, the owned set
 * (ready working sets + the owned-catalog snapshot) in postgres mode.
 */
export function listGuilds(): string[] {
  const ws = getWorkingSet();
  if (!ws || !servedByPostgres()) return listGuildDirs();
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
  if (ws && servedByPostgres()) {
    return ws.listFiles(guildId, category ?? '') ?? [];
  }
  return listGuildDataFilesFs(guildId, category);
}

/**
 * Deadline-bounded durability confirmation for one accepted write: 'ok' =
 * committed, 'pending' = accepted but still retrying, 'held' = the store
 * refused it, kept and retried, 'deposed' = the store refused a batch for a
 * newer owner, so the set's unlanded writes were dropped, 'unavailable' = the
 * write left this manager's hold before it landed (an evict or a
 * replacement), so whether it is stored is unknown. A later write of the same
 * document landing counts for it, and other writes of the guild still queued
 * do not.
 */
export async function confirmWrite(ticket: WriteTicket, deadlineMs: number): Promise<'ok' | 'pending' | 'held' | 'deposed' | 'unavailable'> {
  if (ticket.kind === 'file') return confirmFile(ticket, deadlineMs);
  return ticket.manager.confirm(ticket, deadlineMs);
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
 * writes are not counted.
 */
export async function confirmSaved(scope: string, options: { since?: SaveMark; deadlineMs?: number; category?: string } = {}): Promise<SaveOutcome> {
  const mark = options.since ?? currentSince();
  const since = mark === undefined ? 0 : stampOf(mark);
  if (since === null) return 'unavailable';
  const deadlineMs = options.deadlineMs ?? CONFIRM_SAVED_MS;
  const { tickets, files = [], lost, refused, pruned } = pendingFor(scope, since);
  const answers: SaveOutcome[] = pruned ? ['unavailable'] : [];
  for (const mark of lost) answers.push(mark.deposed ? 'deposed' : 'unavailable');
  const docPrefix = options.category === undefined ? null : `${scope === 'global' ? 'global' : `guild:${scope}`}:${options.category}/`;
  for (const refusal of refused) {
    if (docPrefix === null || refusal.doc.startsWith(docPrefix)) answers.push(refusal.rewritten ? 'unavailable' : 'refused');
  }
  const folder = options.category === undefined
    ? null
    : getDataDirectory(scope === 'global' ? { scope: 'global', category: options.category } : { guildId: scope, category: options.category }) + path.sep;
  const judged = tickets.filter(ticket => ticket.kind === 'ws' || folder === null || ticket.path.startsWith(folder));
  const first = await Promise.all(judged.map(ticket => confirmWrite(ticket, deadlineMs).catch(() => 'unavailable' as const)));
  // A held write is retried while slower confirms finish, so it is read again when the answer is taken. Its 'pending'
  // stays pending while a COMMIT that may carry it owes its answer.
  const now = await Promise.all(first.map((answer, i) => {
    if (answer !== 'held') return answer;
    const ticket = judged[i];
    return confirmWrite(ticket, 0).then(again => (again === 'pending' && !(ticket.kind === 'ws' && commitAnswerOwed(ticket)) ? 'held' as const : again), () => 'unavailable' as const);
  }));
  // NB13 decision 8: a file line whose sync the disk did not confirm is 'unavailable' for good, also one found so while
  // the confirms above waited.
  for (const group of files) {
    if (folder !== null && !group.path.startsWith(folder)) continue;
    if (group.failed || group.tickets.some(ticket => fileTicketState(ticket) === 'unconfirmed')) answers.push('unavailable');
  }
  return worstSave([...answers, ...now]);
}

/**
 * Raw JSON text of one guild doc from whichever backend routes the guild;
 * null = absent (or the working set is not ready). A file that exists but
 * cannot be read throws.
 */
export function readGuildDocRaw(guildId: string, module: string, filename: string): string | null {
  const ws = getWorkingSet();
  if (ws && servedByPostgres()) {
    const key = canonicalGuildKey(module, filename);
    return ws.readDocRaw(guildId, key.module, key.filename);
  }
  return readRawStrict(guildDocFilePath(guildId, module, filename));
}

function guildDocFilePath(guildId: string, module: string, filename: string): string {
  return getDataFilePath(filename, module ? { guildId, category: module } : { guildId });
}

/**
 * For a file-routed guild doc, whether this process still holds a queued
 * write of it and whether that write's flush is failing; null when the
 * working set serves the guild.
 */
export function guildDocFileQueue(guildId: string, module: string, filename: string): { pending: boolean; failing: boolean } | null {
  if (getWorkingSet() && servedByPostgres()) return null;
  const filePath = guildDocFilePath(guildId, module, filename);
  return { pending: filesPending([filePath]), failing: flushFailingFiles([filePath]) };
}

/**
 * Every doc key a postgres-routed guild holds in its working set, or null when
 * the guild is file-routed or the set is not ready (caller uses its fs scan).
 */
export function listGuildDataKeys(guildId: string): { module: string; filename: string }[] | null {
  const ws = getWorkingSet();
  if (ws && servedByPostgres()) {
    return ws.listAllKeys(guildId);
  }
  return null;
}

/**
 * Rule P for a write of a postgres-routed guild's doc against its working set's other keys, writing nothing: the
 * collision's reason, or null when the key fits, the set is not loaded or the guild is file-routed.
 */
export function guildWritePlacement(guildId: string, module: string, filename: string): string | null {
  const ws = getWorkingSet();
  if (!ws || !servedByPostgres()) return null;
  const key = canonicalGuildKey(module, filename);
  return ws.placementOf(guildId, key.module, key.filename);
}

/**
 * Graveyard TTL sweep: always sweeps the file _graveyard; in postgres mode it
 * also sweeps graveyard rows, through the served backend's own pool.
 */
export async function sweepGraveyard(): Promise<void> {
  if (isMaintenanceGateClosed()) return;
  await sweepFileGraveyard(guildId => guildDataOps.get(guildId) === 'restore');
  if (!pgBackend || !servedByPostgres()) return;
  if (!guildDataServing || guildWritesClosed) return;
  const served = pgBackend as { servesData?: () => boolean; sweepGraveyard?: (cutoffMs: number) => Promise<number> };
  if (!served.servesData?.() || !served.sweepGraveyard) return;
  const ttlDays = Number(process.env.GRAVEYARD_TTL_DAYS);
  const ttlMs = (Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays : 14) * 24 * 60 * 60 * 1000;
  try {
    const swept = await served.sweepGraveyard(Date.now() - ttlMs);
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
  if ((options.scope || 'guild') === 'guild') canonicalGuildKey(options.category, filename);
  const dir = getDataDirectory(options);
  return path.join(dir, filename);
}

/** The canonical key of a guild-scope call; throws GuildKeyError for a key that leaves the guild folder or ends in '/'. */
function guildKeyOf(filename: string, options: DataOptions): GuildKey {
  return canonicalGuildKey(options.category, filename);
}

// Installed by the web UI process (none in the bot process): while it answers a reason, every guild write of that
// process is refused, checked in the same turn as the write's enqueue.
let guildWriteGate: (() => string | null) | null = null;

export function setGuildWriteGate(gate: (() => string | null) | null): void {
  guildWriteGate = gate;
}

/** A path under a guild folder or the graveyard of the data root. */
export function isGuildDataPath(absPath: string): boolean {
  const rel = path.relative(BASE_DATA_DIR, path.resolve(absPath));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const first = rel.split(path.sep)[0];
  return /^\d+$/.test(first) || first === '_graveyard';
}

function refuseWhileGated(): void {
  const reason = guildWriteGate?.();
  if (reason) throw new DataBackendUnavailableError('maintenance', `[Data] ${reason}; the write was not saved`);
}

function refuseGuildWhileGated(options: DataOptions): void {
  if ((options.scope || 'guild') === 'guild') refuseWhileGated();
}

// ============================================================================
// OWNER INFO (the fence token source)
// ============================================================================

export interface OwnerInfo {
  nodeId: string;
  /** This boot's process id; null on a JSON bot. */
  processId: string | null;
  shardCount: number;
  /** The claim this process holds on a shard; null for a shard it does not hold. */
  claimOf(shardId: number): number | null;
}

let ownerInfoProvider: (() => OwnerInfo | null) | null = null;

/**
 * Wire the owner-info source (the shard boot after init). dataManager cannot
 * import fleet, so ownership is injected. Provider null (early boot) -> skip.
 */
export function setOwnerInfoProvider(fn: () => OwnerInfo | null): void {
  ownerInfoProvider = fn;
}

// Discord's guild->shard formula; dataReadiness.ts holds the same copy.
function guildIdToShardId(guildId: string, shardCount: number): number {
  try {
    return Number((BigInt(guildId) >> 22n) % BigInt(Math.max(1, shardCount)));
  } catch {
    return 0;
  }
}

// ============================================================================
// RAW PATHS (root config, session files and other files outside the namespaces)
// ============================================================================

export type RawWriteTracked =
  | { accepted: true }
  | { accepted: false; cause: 'unstorable' | 'storage-failing' | 'io' | 'not-ready' | 'writer-lost'; reason?: string };

/** A path under a numeric guild folder: the guild and the key in path form, relative to that folder. */
function guildRawKey(absPath: string): { guildId: string; key: string } | null {
  const rel = path.relative(BASE_DATA_DIR, path.resolve(absPath));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  if (parts.length < 2 || !/^\d+$/.test(parts[0])) return null;
  return { guildId: parts[0], key: parts.slice(1).join('/') };
}

type RawRefused = { accepted: false; cause: 'unstorable' | 'io'; reason: string };

function refuseRaw(absPath: string, cause: 'unstorable' | 'io', reason: string): RawRefused {
  console.error(`[Data] Refused a write of file:${absPath}: ${reason}; nothing was saved`);
  recordRefusal(cause, `file:${absPath}`, reason);
  return { accepted: false, cause, reason };
}

function storableRawRefusal(absPath: string, contents: string): RawRefused | null {
  if (typeof contents !== 'string') return refuseRaw(absPath, 'unstorable', 'the text is not a string');
  const tooLarge = sizeRefusal(contents);
  if (tooLarge) return refuseRaw(absPath, 'unstorable', tooLarge);
  const guild = guildRawKey(absPath);
  if (!guild) return null;
  const refusal = textRefusal(contents, 'text') ?? keyRefusal(guild.key, 'save');
  return refusal ? refuseRaw(absPath, 'unstorable', refusal) : null;
}

/**
 * The rules a write of contents to an absolute path meets, for a process that is not the file's writer: S, and under
 * a guild folder T, K and P read only. It changes nothing on disk; the writer checks again under its lock.
 */
export function rawCheckRefusal(absPath: string, contents: string): RawRefused | null {
  const refused = storableRawRefusal(absPath, contents);
  if (refused) return refused;
  const guild = guildRawKey(absPath);
  if (!guild) return null;
  const collision = guildWriteCollision(guild.guildId, guild.key);
  return collision ? refuseRaw(absPath, 'unstorable', collision) : null;
}

/**
 * The rules a write of contents to an absolute path meets (S, and under a guild folder T, K and P), queuing nothing:
 * the refusal, recorded and logged as the write's would be, or null when the write may go ahead. Rule P removes a
 * keyless folder in the way, so only the writer calls this.
 */
export function rawWriteRefusal(absPath: string, contents: string): RawRefused | null {
  const refused = storableRawRefusal(absPath, contents);
  if (refused) return refused;
  const guild = guildRawKey(absPath);
  if (!guild) return null;
  const placement = placeGuildWrite(guild.guildId, guild.key);
  if (!placement.ok) return refuseRaw(absPath, placement.cause, placement.reason);
  return null;
}

/** Queue an atomic write to an absolute path, answering why it was refused; throws once the exit drain has closed. */
export function writeRawAtomicTracked(absPath: string, contents: string): RawWriteTracked {
  if (closedForExit) {
    recordRefusal('node-stopping', `file:${absPath}`);
    throw new DataBackendUnavailableError('node-stopping');
  }
  if (isGuildDataPath(absPath)) refuseWhileGated();
  if (rawRefusedWhileHeld(absPath)) return { accepted: false, cause: 'not-ready' };
  const shared = sharedRefusal(absPath);
  if (shared) {
    recordRefusal(shared, `file:${absPath}`);
    return { accepted: false, cause: shared };
  }
  const refused = rawWriteRefusal(absPath, contents);
  if (refused) return refused;
  const guild = guildRawKey(absPath);
  const accepted = writeRawAtomicFile(absPath, contents);
  if (accepted) {
    if (guild) noteGuildWrite(guild.guildId, guild.key);
    recordTicket(fileTicket(absPath), `file:${absPath}`);
    return { accepted: true };
  }
  const cause = lastRawRefusal() ?? 'io';
  recordRefusal(cause, `file:${absPath}`);
  return { accepted: false, cause };
}

/** Queue an atomic write to an absolute path; refused once the exit drain has closed. */
export function writeRawAtomic(absPath: string, contents: string): boolean {
  return writeRawAtomicTracked(absPath, contents).accepted;
}

/** Queue an atomic delete of an absolute path (false: nothing to delete); refused once the exit drain has closed. */
export function deleteRawAtomic(absPath: string): boolean {
  if (closedForExit) {
    recordRefusal('node-stopping', `file:${absPath}`);
    throw new DataBackendUnavailableError('node-stopping');
  }
  if (isGuildDataPath(absPath)) refuseWhileGated();
  if (rawRefusedWhileHeld(absPath)) return false;
  const shared = sharedRefusal(absPath);
  if (shared) {
    recordRefusal(shared, `file:${absPath}`);
    return false;
  }
  const accepted = deleteRawAtomicFile(absPath);
  // A delete still queued for the path has not landed: it answers for this one.
  if (accepted || getPending(absPath)?.op === 'delete') recordTicket(fileTicket(absPath), `file:${absPath}`);
  else {
    const cause = lastRawRefusal();
    if (cause) recordRefusal(cause, `file:${absPath}`);
  }
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
      const key = guildKeyOf(filename, options);
      const res = ws.read(wsGuild, key.module, key.filename);
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

/**
 * Why a write was refused without a throw: its guild's working set is not ready (or not in this process), storage
 * failed, another process took the data files ('writer-lost'), or neither store can keep the value or key
 * ('unstorable', with the reason; a retry gives the same answer).
 */
export type WriteRefusal = 'not-ready' | 'io' | 'writer-lost' | 'unstorable';

export type Refused =
  | { outcome: 'refused'; cause: 'not-ready' | 'io' | 'writer-lost'; reason?: string }
  | { outcome: 'refused'; cause: 'unstorable'; reason: string };
export type SaveTracked = { outcome: 'saved'; ticket: WriteTicket } | { outcome: 'frozen' } | Refused;
export type AppendTracked = { outcome: 'appended'; ticket: WriteTicket } | { outcome: 'frozen' } | Refused;
/** An absent delete carries a ticket while an earlier delete of the same document has not landed. */
export type DeleteTracked = { outcome: 'deleted'; ticket: WriteTicket } | { outcome: 'absent'; ticket?: WriteTicket } | { outcome: 'frozen' } | Refused;

/** A write neither store can keep: logged without its content, and answered with the reason. */
function unstorable(filename: string, options: DataOptions, reason: string): Refused {
  console.error(`[Data] Refused a write of ${docOf(filename, options)}: ${reason}; nothing was saved`);
  return { outcome: 'refused', cause: 'unstorable', reason };
}

/** The key of a guild-scope write after rule K, or its refusal. */
function storableKey(filename: string, options: DataOptions, kind?: 'save' | 'append'): GuildKey | Refused {
  let key: GuildKey;
  try {
    key = guildKeyOf(filename, options);
  } catch (error) {
    if (!(error instanceof GuildKeyError)) throw error;
    const reason = error.message.replace(/^\[Data\] /, '').replace(/; refused$/, '');
    return unstorable(filename, options, reason.charAt(0).toLowerCase() + reason.slice(1));
  }
  const refusal = keyRefusal(pathKeyOf(key.module, key.filename), kind);
  return refusal ? unstorable(filename, options, refusal) : key;
}

const isRefused = (value: GuildKey | Refused): value is Refused => 'outcome' in value;

/** Rule P on the file route, before anything is queued or a folder made; null when the write may go ahead. */
function placeOnFiles(filename: string, options: DataOptions, key: GuildKey): Refused | null {
  const placement = placeGuildWrite(options.guildId ?? '', pathKeyOf(key.module, key.filename));
  if (placement.ok) return null;
  if (placement.cause === 'unstorable') return unstorable(filename, options, placement.reason);
  console.error(`[Data] A write of ${docOf(filename, options)} was not taken: ${placement.reason}; nothing was saved`);
  return { outcome: 'refused', cause: 'io', reason: placement.reason };
}

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
    if (outcome.outcome === 'frozen') recordRefusal('frozen', doc);
    else recordRefusal(outcome.cause, doc, outcome.reason);
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
  refuseInsideUpdate();
  if (filename.endsWith('.jsonl')) {
    throw new TypeError(`[Data] ${filename} is an append-only file; write it with appendData. The value was not saved`);
  }
  if (closedForExit) throw new DataBackendUnavailableError('node-stopping');
  refuseInMaintenance(options);
  refuseGuildWhileGated(options);
  if (guildWriteClosed(options, 'Write')) return { outcome: 'refused', cause: 'not-ready' };
  if (refusedWhileHeld(options, 'Write') || refusedBeforeRestore(options, 'Write')) return { outcome: 'refused', cause: 'not-ready' };
  const guildScope = (options.scope || 'guild') === 'guild';
  const checked = guildScope ? storableKey(filename, options, 'save') : null;
  if (checked && isRefused(checked)) return checked;
  const value = valueText(data);
  if (!value.ok) return unstorable(filename, options, value.reason);
  const tooLarge = sizeRefusal(value.text);
  if (tooLarge) return unstorable(filename, options, tooLarge);
  const content = value.text;
  try {
    const wsGuild = wsRouted(options);
    if (wsGuild !== null) {
      const ws = getWorkingSet();
      if (!ws) {
        console.warn(`[Data] Write for postgres-routed guild ${wsGuild} outside the bot process; refused`);
        return { outcome: 'refused', cause: 'not-ready' };
      }
      const key = checked as GuildKey;
      const result = ws.save(wsGuild, key.module, key.filename, content);
      if (typeof result === 'object') return unstorable(filename, options, result.collision);
      if (result === 'accepted') {
        const ticket = ws.ticketFor(wsGuild);
        getMetricsCollector().recordIO('write', options.guildId ?? null, options.category ?? null);
        return { outcome: 'saved', ticket };
      }
      if (result === 'frozen-window') return { outcome: 'frozen' };
      if (result === 'not-ready') return { outcome: 'refused', cause: 'not-ready' };
      throw result === 'fenced' ? new DataBackendUnavailableError('guild-fenced') : ws.refusal();
    }
    const dir = getDataDirectory(options);
    const filePath = getDataFilePath(filename, options);
    const scope = options.scope || 'guild';
    const shared = sharedRefusal(filePath);
    if (shared) return { outcome: 'refused', cause: shared };
    const placed = checked ? placeOnFiles(filename, options, checked as GuildKey) : null;
    if (placed) return placed;

    // Ensure the dir synchronously so the guild dir exists the moment the save
    // is accepted.
    ensureDirectory(dir);

    enqueueWrite(filePath, content);
    if (checked) noteGuildWrite(options.guildId ?? '', pathKeyOf((checked as GuildKey).module, (checked as GuildKey).filename));
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

// ============================================================================
// UPDATE (read, change and save one document in one synchronous run)
// ============================================================================

// Set while an update's fn runs: a write it makes would be overwritten by the update's own save.
let insideUpdate: { nested: boolean } | null = null;

function refuseInsideUpdate(): void {
  if (!insideUpdate) return;
  insideUpdate.nested = true;
  throw new TypeError('[Data] A data write was made inside an update function; neither it nor the update was saved');
}

/** A throw from an update's fn, carried past recorded() so it is recorded nowhere and reaches the caller as it was. */
class UpdateFnError {
  constructor(readonly error: unknown) {}
}

type UpdateRead = { status: 'absent' } | { status: 'present'; value: unknown } | { status: 'refused'; cause: 'not-ready' | 'io' };

/** The stored document read whole, or why it cannot be: a default stands in only for a document that is absent. */
function readForUpdate(filename: string, options: DataOptions): UpdateRead {
  try {
    const wsGuild = wsRouted(options);
    if (wsGuild !== null) {
      const ws = getWorkingSet();
      if (!ws) {
        console.warn(`[Data] Update for postgres-routed guild ${wsGuild} outside the bot process; refused`);
        return { status: 'refused', cause: 'not-ready' };
      }
      getMetricsCollector().recordIO('read', wsGuild, options.category ?? null);
      const key = guildKeyOf(filename, options);
      const res = ws.readForUpdate(wsGuild, key.module, key.filename);
      if (res.status === 'not-ready') return { status: 'refused', cause: 'not-ready' };
      if (res.status === 'stream') {
        console.error(`[DataManager] Update of ${filename} refused: it is written by appends, and a whole write would replace its lines`);
        return { status: 'refused', cause: 'io' };
      }
      return res.value === undefined ? { status: 'absent' } : { status: 'present', value: res.value };
    }
    const filePath = getDataFilePath(filename, options);
    getMetricsCollector().recordIO('read', options.scope === 'global' ? null : options.guildId ?? null, options.category ?? null);
    const pending = getPending(filePath);
    if (pending?.op === 'delete') return { status: 'absent' };
    if (pending?.op === 'write') return { status: 'present', value: JSON.parse(pending.content) };
    if (pending?.op === 'append') {
      console.error(`[DataManager] Update of ${filename} refused: appended lines are still queued for it, and a whole write would replace them`);
      return { status: 'refused', cause: 'io' };
    }
    // A folder at the key's name, or a file at one of its folders, under a guild folder is no document: the save's rule P removes or refuses it.
    const stored = readRawStrict(filePath);
    if (stored === null) return { status: 'absent' };
    return { status: 'present', value: JSON.parse(stored) };
  } catch (error) {
    console.error(`[DataManager] Update of ${filename} refused: the stored document could not be read whole:`, error);
    return { status: 'refused', cause: 'io' };
  }
}

function acceptUpdate<T>(filename: string, options: DataOptions, defaultValue: T, fn: (current: T) => T): SaveTracked {
  refuseInsideUpdate();
  if (filename.endsWith('.jsonl')) {
    throw new TypeError(`[Data] ${filename} is an append-only file; it is never updated whole. The update was not saved`);
  }
  if (closedForExit) throw new DataBackendUnavailableError('node-stopping');
  refuseInMaintenance(options);
  if (guildWriteClosed(options, 'Update')) return { outcome: 'refused', cause: 'not-ready' };
  if (refusedWhileHeld(options, 'Update') || refusedBeforeRestore(options, 'Update')) return { outcome: 'refused', cause: 'not-ready' };
  if ((options.scope || 'guild') === 'guild') {
    const checked = storableKey(filename, options, 'save');
    if (isRefused(checked)) return checked;
  }
  const read = readForUpdate(filename, options);
  if (read.status === 'refused') return { outcome: 'refused', cause: read.cause };
  const current = (read.status === 'present' ? read.value : structuredClone(defaultValue)) as T;
  const frame = { nested: false };
  insideUpdate = frame;
  let next: unknown;
  try {
    next = fn(current);
  } catch (error) {
    throw new UpdateFnError(error);
  } finally {
    insideUpdate = null;
  }
  const thenable = typeof (next as { then?: unknown } | null)?.then === 'function';
  if (thenable) {
    try {
      (next as PromiseLike<unknown>).then(undefined, error => {
        console.error(`[Data] An async update function for ${filename} failed after it was refused:`, error);
      });
    } catch { /* a then that throws leaves nothing pending */ }
  }
  if (frame.nested) throw new TypeError('[Data] The update function made a data write of its own; the update was not saved');
  if (next === undefined) throw new TypeError('[Data] The update function returned undefined; it must return the new value. The update was not saved');
  if (thenable) {
    throw new TypeError('[Data] The update function returned a promise; it must return the new value without awaiting. The update was not saved');
  }
  return acceptSave(filename, options, next);
}

/**
 * Read a document, change it with fn and save the result in one synchronous run, so no other write of it by this
 * process lands in between. fn gets a private copy of the stored value (of defaultValue when absent) and returns the
 * new value; it must not be async and must not write data. An async fn is refused with a TypeError and the update
 * writes nothing; anything that function does after its first await is outside the update. A filename ending in
 * .jsonl is append-only and throws a TypeError without running fn. A document that cannot be read whole (unparsable,
 * unreadable, or written by appends) is refused 'io' and a guild whose working set is not ready, or a data layer that
 * refused to serve, 'not-ready', in both cases without running fn. Otherwise the answer is the save's, with its
 * throws; a throw from fn reaches the caller as it was and nothing is written.
 */
export function updateData<T = any>(filename: string, options: DataOptions, defaultValue: T, fn: (current: T) => T): SaveTracked {
  try {
    return recorded(docOf(filename, options), scopeOf(options), true, () => acceptUpdate(filename, options, defaultValue, fn));
  } catch (error) {
    if (error instanceof UpdateFnError) throw error.error;
    throw error;
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
  refuseInsideUpdate();
  if (!filename.endsWith('.jsonl')) {
    throw new TypeError(`[Data] ${filename} does not end in .jsonl; appendData writes only .jsonl files. The line was not saved`);
  }
  // Every stream line ends in a newline, so the next line starts one of its own on either backend.
  if (typeof line === 'string' && !line.endsWith('\n')) line += '\n';
  if (closedForExit) throw new DataBackendUnavailableError('node-stopping');
  refuseInMaintenance(options);
  refuseGuildWhileGated(options);
  if (guildWriteClosed(options, 'Append')) return { outcome: 'refused', cause: 'not-ready' };
  if (refusedWhileHeld(options, 'Append')) return { outcome: 'refused', cause: 'not-ready' };
  const checked = (options.scope || 'guild') === 'guild' ? storableKey(filename, options, 'append') : null;
  if (checked && isRefused(checked)) return checked;
  const textRefused = textRefusal(line) ?? sizeRefusal(line);
  if (textRefused) return unstorable(filename, options, textRefused);
  try {
    const wsGuild = wsRouted(options);
    if (wsGuild !== null) {
      const ws = getWorkingSet();
      if (!ws) {
        console.warn(`[Data] Append for postgres-routed guild ${wsGuild} outside the bot process; refused`);
        return { outcome: 'refused', cause: 'not-ready' };
      }
      const key = checked as GuildKey;
      const result = ws.append(wsGuild, key.module, key.filename, line);
      if (typeof result === 'object') return unstorable(filename, options, result.collision);
      if (result === 'accepted') {
        const ticket = ws.ticketFor(wsGuild);
        getMetricsCollector().recordIO('write', options.guildId ?? null, options.category ?? null);
        return { outcome: 'appended', ticket };
      }
      if (result === 'frozen-window') return { outcome: 'frozen' };
      if (result === 'not-ready') return { outcome: 'refused', cause: 'not-ready' };
      throw result === 'fenced' ? new DataBackendUnavailableError('guild-fenced') : ws.refusal();
    }
    const dir = getDataDirectory(options);
    const filePath = getDataFilePath(filename, options);
    const scope = options.scope || 'guild';
    const shared = sharedRefusal(filePath);
    if (shared) return { outcome: 'refused', cause: shared };
    const placed = checked ? placeOnFiles(filename, options, checked as GuildKey) : null;
    if (placed) return placed;
    ensureDirectory(dir);

    enqueueAppend(filePath, line);
    if (checked) noteGuildWrite(options.guildId ?? '', pathKeyOf((checked as GuildKey).module, (checked as GuildKey).filename));
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
  let key: GuildKey | null = null;
  try {
    if ((options.scope || 'guild') === 'guild') key = guildKeyOf(filename, options);
  } catch (error) {
    if (error instanceof GuildKeyError) return false;
    throw error;
  }
  const wsGuild = wsRouted(options);
  if (wsGuild !== null && key) {
    return getWorkingSet()?.exists(wsGuild, key.module, key.filename) ?? false;
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
  refuseInsideUpdate();
  if (closedForExit) throw new DataBackendUnavailableError('node-stopping');
  refuseInMaintenance(options);
  refuseGuildWhileGated(options);
  if (guildWriteClosed(options, 'Delete')) return { outcome: 'refused', cause: 'not-ready' };
  if (refusedWhileHeld(options, 'Delete') || refusedBeforeRestore(options, 'Delete')) return { outcome: 'refused', cause: 'not-ready' };
  try {
    const wsGuild = wsRouted(options);
    if (wsGuild !== null) {
      const ws = getWorkingSet();
      if (!ws) {
        console.warn(`[Data] Delete for postgres-routed guild ${wsGuild} outside the bot process; refused`);
        return { outcome: 'refused', cause: 'not-ready' };
      }
      const key = guildKeyOf(filename, options);
      const result = ws.delete(wsGuild, key.module, key.filename);
      if (result === 'absent') {
        console.log(`[DataManager] File not found for deletion: ${wsGuild}/${options.category ?? ''}/${filename}`);
        const earlier = ws.unlandedDeleteTicket(wsGuild, key.module, key.filename);
        return earlier ? { outcome: 'absent', ticket: earlier } : { outcome: 'absent' };
      }
      if (result === 'accepted') {
        const ticket = ws.ticketFor(wsGuild);
        console.log(`[DataManager] Deleted ${wsGuild}/${options.category ?? ''}/${filename}`);
        return { outcome: 'deleted', ticket };
      }
      if (result === 'frozen-window') return { outcome: 'frozen' };
      if (result === 'not-ready') return { outcome: 'refused', cause: 'not-ready' };
      throw result === 'fenced' ? new DataBackendUnavailableError('guild-fenced') : ws.refusal();
    }
    const filePath = getDataFilePath(filename, options);
    const shared = sharedRefusal(filePath);
    if (shared) return { outcome: 'refused', cause: shared };

    const pending = getPending(filePath);
    const guildKey = (options.scope || 'guild') === 'guild' ? guildKeyOf(filename, options) : null;
    // A guild key is deleted only when stored under the exact name given, every part included.
    const existsNow = guildKey
      ? guildKeyStored(options.guildId ?? '', pathKeyOf(guildKey.module, guildKey.filename))
      : existsOnDisk(filePath);
    // Nothing to delete: neither a queued write nor a file on disk. A queued
    // delete has not landed, and an op on the wire ahead of it may create the file.
    if (!existsNow && (guildKey || !pending || pending.op === 'delete')) {
      console.log(`[DataManager] File not found for deletion: ${filePath}`);
      return pending?.op === 'delete' ? { outcome: 'absent', ticket: fileTicket(filePath) } : { outcome: 'absent' };
    }

    // Enqueue a delete tombstone (serialized with in-flight writes so a queued
    // write cannot resurrect the file).
    enqueueDelete(filePath);
    if (guildKey) noteGuildDelete(options.guildId ?? '', pathKeyOf(guildKey.module, guildKey.filename));
    const ticket = fileTicket(filePath);
    console.log(`[DataManager] Deleted ${filePath}`);
    return { outcome: 'deleted', ticket };
  } catch (error) {
    if (error instanceof DataBackendUnavailableError) throw error;
    if (error instanceof GuildKeyError) {
      const reason = error.message.replace(/^\[Data\] /, '').replace(/; refused$/, '');
      return unstorable(filename, options, reason.charAt(0).toLowerCase() + reason.slice(1));
    }
    console.error(`[DataManager] Error deleting ${filename}:`, error);
    return { outcome: 'refused', cause: 'io' };
  }
}

// ============================================================================
// GUILD NAMESPACE DELETION (graveyard)
// ============================================================================

/** The process stopped serving, or the guild's set is frozen with kept writes: an operator delete or restore is refused. */
export class GuildFrozenError extends Error {
  constructor(guildId: string) {
    super(`guild ${guildId} is frozen: this process stopped serving it`);
    this.name = 'GuildFrozenError';
  }
}

// NB4 decision 6: asked after the last await before the write.
function refuseFrozenGuild(guildId: string): void {
  if (stoppedServing() || getWorkingSet()?.stateOf(guildId) === 'frozen-retained') throw new GuildFrozenError(guildId);
}

// A guild a graveyard restore or a namespace delete holds: its writes are refused and its actions held until the
// operation ends, and the other operation is refused meanwhile.
export type GuildDataOp = 'restore' | 'delete';
const guildDataOps = new Map<string, GuildDataOp>();

export function guildDataOpOf(guildId: string): GuildDataOp | undefined {
  return guildDataOps.get(guildId);
}

// Per guild, the barrier taken when a restore changed or may have changed its store; kept for the process's life.
const restoredAt = new Map<string, number>();

/** A guild write while an operation holds its guild: logged, and refused as not ready. */
function refusedWhileHeld(options: DataOptions, what: string): boolean {
  if ((options.scope || 'guild') !== 'guild' || !options.guildId) return false;
  const op = guildDataOps.get(options.guildId);
  if (!op) return false;
  console.warn(`[Data] ${what} for guild ${options.guildId} refused: ${op === 'restore' ? 'its data is being restored from the graveyard' : 'its data is being deleted'}`);
  return true;
}

/** A whole-document write from a run whose ledger is still open and began before the guild's restore ended. */
function refusedBeforeRestore(options: DataOptions, what: string): boolean {
  if ((options.scope || 'guild') !== 'guild' || !options.guildId) return false;
  const barrier = restoredAt.get(options.guildId);
  if (barrier === undefined) return false;
  const ledger = currentLedger();
  if (!ledger || ledger.sealed) return false;
  const since = stampOf(currentSince());
  if (since === null || since >= barrier) return false;
  console.warn(`[Data] ${what} for guild ${options.guildId} refused: it comes from a command that started before the server's data was restored from the graveyard`);
  return true;
}

/** The guild whose folder holds this path, or null. */
function guildOfPath(absPath: string): string | null {
  const rel = path.relative(BASE_DATA_DIR, path.resolve(absPath));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const first = rel.split(path.sep)[0];
  return /^\d+$/.test(first) ? first : null;
}

/** A raw write under a guild folder while an operation holds the guild: refused, as the facade's writes are. */
function rawRefusedWhileHeld(absPath: string): boolean {
  const guildId = guildOfPath(absPath);
  const op = guildId === null ? undefined : guildDataOps.get(guildId);
  if (!op) return false;
  recordRefusal('not-ready', `file:${absPath}`);
  console.warn(`[Data] Write of ${absPath} refused: ${op === 'restore' ? 'its guild\'s data is being restored from the graveyard' : 'its guild\'s data is being deleted'}`);
  return true;
}

// The events of a file-routed guild under restore, replayed in order when the restore ends.
const EVENT_BUFFER_CAP = 256;
const restoreEvents = new Map<string, Array<() => void>>();
let restoreEventDrops = 0;

/** Holds an event of a guild a restore holds (true); false when no restore holds it. */
export function bufferRestoreEvent(guildId: string, replay: () => void): boolean {
  if (guildDataOps.get(guildId) !== 'restore') return false;
  let queue = restoreEvents.get(guildId);
  if (!queue) {
    queue = [];
    restoreEvents.set(guildId, queue);
  }
  if (queue.length >= EVENT_BUFFER_CAP) {
    queue.shift();
    restoreEventDrops += 1;
    if (restoreEventDrops % 50 === 1) {
      console.warn(`[Data] Event buffer overflow for guild ${guildId} (${restoreEventDrops} drop(s) total); oldest dropped`);
    }
  }
  queue.push(replay);
  return true;
}

function replayRestoreEvents(guildId: string): void {
  const queue = restoreEvents.get(guildId);
  restoreEvents.delete(guildId);
  for (const replay of queue ?? []) {
    try {
      replay();
    } catch (error) {
      console.error(`[Data] Buffered event replay failed for guild ${guildId}:`, error);
    }
  }
}

/** A restore's and a delete's bound when the request names none: 40 s from now on the monotonic clock. */
const OPERATION_BOUND_MS = 40_000;
const RESTORE_FLUSH_MS = 5000;
const COMMIT_FLOOR_MS = 2000;

/** What stops a restore or a delete before its change: the maintenance gate, the exit drain, or the deadline. */
function operationStop(deadline: bigint, floorMs: number): RestoreStop | null {
  if (isMaintenanceGateClosed()) return 'maintenance';
  if (closedForExit) return 'node-stopping';
  if (msLeft(deadline) < floorMs) return 'out-of-time';
  return null;
}

export const RESTORE_TEXTS = {
  noEntry: 'no graveyard entry for this guild',
  alreadyRunning: 'a restore of this server is already running; nothing was restored; its answer comes within a minute',
  deleteRunning: "a delete of this server's data is running; nothing was restored; try again once it ends",
  notLoaded: "this server's data is not loaded in this bot process; nothing was restored; try again in a moment",
  flush: "the server's unsaved changes are not confirmed saved yet; nothing was restored; try again in a moment",
  schemaMismatch: 'the database holds another schema version than this bot reads; nothing was restored',
  noClaim: 'this bot process holds no usable claim on the database; nothing was restored; restart the bot',
  notProvisioned: 'the database is not provisioned yet; nothing was restored; try again once the bot has started',
  outOfTime: 'the restore ran out of its 40 s before it could commit; nothing was restored; try again in a moment',
  deposed: "another bot process now serves this server's data; nothing was restored",
  nodeStopping: '[Data] This process is stopping; nothing was restored',
  live: (retiredAt: number) => `live guild data exists; nothing was restored. To restore entry ${retiredAt}, delete this server's data, then restore with retiredAt ${retiredAt} before the bot saves anything new for the server; data it saves in between blocks the restore again. While the server's members are active, remove the bot from the server first and add it back after the restore.`,
  unavailable: (detail: string) => `[Data] The database did not answer or ended the connection (${detail}); nothing was restored; try again in a moment`,
  refused: (detail: string, code?: string) => `the database refused the restore (${detail}); nothing was restored; ${code === '40P01' || code === '57014' ? 'try again in a moment' : 'see the bot log'}`,
  unknown: (guildId: string, retiredAt?: number) => `can't confirm whether server ${guildId} was restored: the database did not confirm the commit. Within a minute, if it was restored, the server's data is back and ${retiredAt === undefined ? 'its entry' : `entry ${retiredAt}`} is gone from \`smdb graveyard list\`; if not, the entry is still listed, unless it had passed the graveyard's keep time (GRAVEYARD_TTL_DAYS, 14 days by default) and the graveyard sweep removed it, data and all.`,
  error: (message: string) => `the restore stopped on an error in the bot (${message}); nothing was restored; see the bot log`,
  rename: (code: string) => `the graveyard entry could not be moved back (${code}); nothing was restored; try again in a moment`,
  note: (code: string, step: 'read' | 'remove' = 'remove') => `the graveyard entry's note could not be ${step === 'read' ? 'read' : 'removed'} (${code}); nothing was restored; try again in a moment`,
};

export const DELETE_TEXTS = {
  failed: 'guild data delete failed; nothing was removed',
  alreadyRunning: "a delete of this server's data is already running; nothing was removed",
  restoreRunning: 'a restore of this server from the graveyard is running; nothing was removed; try again once it ends',
  flush: "the server's unsaved changes are not confirmed saved yet; nothing was removed; try again in a moment",
  deposed: "another bot process now serves this server's data; nothing was removed",
  notLoaded: "this server's data is not loaded in this bot process; nothing was removed; try again in a moment",
  error: (message: string) => `the delete stopped on an error in the bot (${message}); nothing was removed; see the bot log`,
  timeout: 'the database did not finish the delete within its 40 s; nothing was removed; try again in a moment',
  outOfTime: 'the delete ran out of its 40 s before it could commit; nothing was removed; try again in a moment',
  nodeStopping: '[Data] This process is stopping; nothing was removed',
  unknown: "can't confirm whether this server's data was deleted: the database did not confirm the commit. Within a minute, `smdb graveyard list` lists a new entry for this server if it was deleted; if no new entry is listed by then, it was not.",
  noClaim: 'this bot process holds no usable claim on the database; nothing was removed; restart the bot',
  unavailable: (detail: string) => `the database did not answer or ended the connection (${detail}); nothing was removed; try again in a moment`,
  failing: (file: string, code: string) => `a file of this server keeps failing to save (${file}: ${code}); nothing was removed; free disk space or fix the file's permissions, then try again`,
};

export type GraveyardReply =
  | { ok: true; retiredAt: number; reason: string; moved?: number; moveUnconfirmed?: string }
  | { ok: false; code: 'invalid' | 'backend-unavailable' | 'not-owner' | 'frozen' | 'io-error'; error?: string };

export type DeleteReply = { ok: true; moveUnconfirmed?: string } | { ok: false; code: 'invalid' | 'backend-unavailable' | 'not-owner' | 'io-error'; error: string };

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const unconfirmedReplies = new WeakSet<object>();

/** A can't confirm answer: the change may have landed, so no later refusal text may replace it. */
function unconfirmed<T extends object>(reply: T): T {
  unconfirmedReplies.add(reply);
  return reply;
}

export function isUnconfirmedReply(reply: object): boolean {
  return unconfirmedReplies.has(reply);
}

/** A stop read before the change: maintenance and the exit drain throw as every refused guild change does. */
function stopAnswer(stop: RestoreStop, what: 'restore' | 'delete'): { ok: false; code: 'backend-unavailable'; error: string } {
  if (stop === 'maintenance') throw new DataBackendUnavailableError('maintenance');
  if (stop === 'node-stopping') throw new DataBackendUnavailableError('node-stopping', what === 'restore' ? RESTORE_TEXTS.nodeStopping : DELETE_TEXTS.nodeStopping);
  return { ok: false, code: 'backend-unavailable', error: what === 'restore' ? RESTORE_TEXTS.outOfTime : DELETE_TEXTS.outOfTime };
}

/**
 * Retire a guild namespace to the graveyard. The guild is held from the first await to the end, so no write of it is
 * accepted meanwhile, and it goes on only once every write accepted before is saved: on Postgres the set's flush
 * answered ok (the set is evicted once the retire returned), on JSON no op under its folder is queued or on the wire.
 * deadline: a process.hrtime.bigint() reading; nothing is retired or renamed after it.
 */
export async function deleteGuildNamespace(guildId: string, reason: string, flushMs = 30000, deadline: bigint = deadlineIn(OPERATION_BOUND_MS)): Promise<DeleteReply> {
  refuseGuildChangeInMaintenance();
  const running = guildDataOps.get(guildId);
  if (running === 'delete') return { ok: false, code: 'invalid', error: DELETE_TEXTS.alreadyRunning };
  if (running === 'restore') return { ok: false, code: 'invalid', error: DELETE_TEXTS.restoreRunning };
  const postgres = servedByPostgres();
  if (postgres ? !pgBackend : !guildDirExists(guildId)) return { ok: false, code: 'io-error', error: DELETE_TEXTS.failed };
  guildDataOps.set(guildId, 'delete');
  try {
    return postgres ? await retireRows(guildId, reason, flushMs, deadline, pgBackend!) : await retireFiles(guildId, reason, deadline);
  } finally {
    guildDataOps.delete(guildId);
  }
}

async function retireRows(guildId: string, reason: string, flushMs: number, deadline: bigint, backend: DataBackend): Promise<DeleteReply> {
  const ws = getWorkingSet();
  if (ws) {
    const flushed = await ws.flushGuildNow(guildId, Math.min(flushMs, Math.max(0, msLeft(deadline))));
    if (flushed === 'deposed') {
      console.error(`[DataManager] Cannot retire guild ${guildId}: another bot process now serves its data; nothing was removed`);
      return { ok: false, code: 'not-owner', error: DELETE_TEXTS.deposed };
    }
    if (flushed !== 'ok') {
      const why = flushed === 'held'
        ? 'its unflushed writes did not reach the store (held)'
        : `can't confirm that its writes reached the store (${flushed})`;
      console.error(`[DataManager] Cannot retire guild ${guildId}: ${why}; nothing was removed`);
      return { ok: false, code: 'backend-unavailable', error: DELETE_TEXTS.flush };
    }
    refuseGuildChangeInMaintenance();
    refuseFrozenGuild(guildId);
  }
  const token = fenceFromOwnerInfo(guildId);
  if (!token) {
    console.warn(`[DataManager] Cannot retire guild ${guildId}: no owner info wired`);
    return { ok: false, code: 'io-error', error: DELETE_TEXTS.failed };
  }
  let res: RetireOutcome;
  try {
    res = await backend.retireGuild(guildId, reason, token, deadline);
  } finally {
    // Whatever the retire answered: the set holds nothing unsaved, and the next access reads the store.
    ws?.evict(guildId);
  }
  if (res.ok) {
    if (res.moved > 0) {
      console.log(`[DataManager] Guild ${guildId} moved to graveyard (${reason})`);
      return { ok: true };
    }
    return { ok: false, code: 'io-error', error: DELETE_TEXTS.failed };
  }
  if (res.reason === 'unknown') {
    console.error(`[DataManager] Can't confirm whether guild ${guildId} was retired: the database did not confirm the commit`);
  } else {
    console.error(`[DataManager] Failed to retire guild ${guildId} (${res.reason})`);
  }
  switch (res.reason) {
    case 'unknown': return unconfirmed({ ok: false, code: 'backend-unavailable', error: DELETE_TEXTS.unknown });
    case 'no-claim': return { ok: false, code: 'backend-unavailable', error: DELETE_TEXTS.noClaim };
    case 'deposed': return { ok: false, code: 'not-owner', error: DELETE_TEXTS.deposed };
    case 'out-of-time': return { ok: false, code: 'backend-unavailable', error: DELETE_TEXTS.outOfTime };
    case 'unavailable':
      return { ok: false, code: 'backend-unavailable', error: res.timedOut ? DELETE_TEXTS.timeout : DELETE_TEXTS.unavailable(res.detail ?? 'no detail') };
    default: return { ok: false, code: 'io-error', error: DELETE_TEXTS.failed };
  }
}

async function retireFiles(guildId: string, reason: string, deadline: bigint): Promise<DeleteReply> {
  await flushGuild(guildId);
  refuseGuildChangeInMaintenance();
  if (sharedWritesLost) {
    recordRefusal('writer-lost', guildId);
    console.error(`[DataManager] Cannot retire guild ${guildId}: another process took the data files; nothing was removed`);
    return { ok: false, code: 'io-error', error: DELETE_TEXTS.failed };
  }
  const early = operationStop(deadline, 0);
  if (early) return stopAnswer(early, 'delete');
  // With the guild held, an op still queued is one whose flush keeps failing: it stays queued and retried.
  if (guildHasQueuedOps(guildId)) {
    const failing = guildFailingWrite(guildId);
    console.error(`[DataManager] Cannot retire guild ${guildId}: ${failing ? `${failing.file} keeps failing to save (${failing.code})` : 'a write of it is not saved yet'}; nothing was removed`);
    return { ok: false, code: 'backend-unavailable', error: failing ? DELETE_TEXTS.failing(failing.file, failing.code) : DELETE_TEXTS.flush };
  }
  let stop: RestoreStop | null = null;
  const moved = await graveyardGuildDir(guildId, reason, sharedWritesClosedLost, () => (stop = operationStop(deadline, 0)) !== null);
  if (!moved) {
    if (stop) return stopAnswer(stop, 'delete');
    return { ok: false, code: 'io-error', error: DELETE_TEXTS.failed };
  }
  const synced = await fsyncDataDirs();
  if (synced.failed) {
    forgetGuildDurableFiles(guildId);
    console.error(`[DataManager] Guild ${guildId} moved to graveyard, but the disk did not confirm the sync of ${synced.dir} (${synced.code}), so a power cut can bring its folder back live`);
  }
  return synced.failed ? { ok: true, moveUnconfirmed: synced.code } : { ok: true };
}

/**
 * Restore a retired guild namespace from the graveyard (retiredAt absent: the guild's newest entry). The guild is held
 * from the admission to the end: its writes are refused, its interactions held and its events wait. Refusals and
 * outcomes come back as a reply with its code; maintenance, the exit drain and a database that did not answer throw
 * DataBackendUnavailableError. deadline: a process.hrtime.bigint() reading; nothing commits or is renamed after it.
 */
export async function restoreGuildFromGraveyard(guildId: string, retiredAt?: number, deadline: bigint = deadlineIn(OPERATION_BOUND_MS)): Promise<GraveyardReply> {
  refuseGuildChangeInMaintenance();
  if (closedForExit) throw new DataBackendUnavailableError('node-stopping', RESTORE_TEXTS.nodeStopping);
  const running = guildDataOps.get(guildId);
  if (running) return { ok: false, code: 'invalid', error: running === 'restore' ? RESTORE_TEXTS.alreadyRunning : RESTORE_TEXTS.deleteRunning };
  return servedByPostgres() ? restoreRows(guildId, retiredAt, deadline) : restoreFiles(guildId, retiredAt, deadline);
}

async function restoreRows(guildId: string, retiredAt: number | undefined, deadline: bigint): Promise<GraveyardReply> {
  const backend = pgBackend;
  if (!backend) throw new DataBackendUnavailableError('database-unreachable', RESTORE_TEXTS.unavailable('no database backend in this process'));
  const ws = getWorkingSet();
  const state = ws?.stateOf(guildId) ?? null;
  if (stoppedServing() || state === 'frozen-retained') return { ok: false, code: 'frozen' };
  if (state === 'fenced') return { ok: false, code: 'not-owner', error: RESTORE_TEXTS.deposed };
  if (!ws || !ws.beginRestore(guildId)) return { ok: false, code: 'backend-unavailable', error: RESTORE_TEXTS.notLoaded };
  guildDataOps.set(guildId, 'restore');
  let flushed: string | undefined;
  let outcome: RestoreOutcome | undefined;
  let called = false;
  let stopped = false;
  let failure: { error: unknown } | null = null;
  const fence = ws.fenceOf(guildId);
  // A set whose shard left this process while it was held is not served again: it is frozen.
  const stillHeld = (): boolean => {
    if (stoppedServing()) return false;
    const now = fenceFromOwnerInfo(guildId);
    return !now || !fence || now.claim === fence.claim;
  };
  try {
    flushed = await ws.flushGuildNow(guildId, Math.min(RESTORE_FLUSH_MS, Math.max(0, msLeft(deadline))));
    stopped = stoppedServing();
    if (flushed === 'ok' && fence && !stopped) {
      called = true;
      outcome = await backend.restoreGuild(guildId, retiredAt ?? null, fence, () => operationStop(deadline, COMMIT_FLOOR_MS), deadline);
    }
  } catch (error) {
    failure = { error };
    if (called) console.error(`[DataManager] Can't confirm whether guild ${guildId} was restored: the restore stopped on an error once it was sent to the database:`, error);
    else console.error(`[Data] The restore of guild ${guildId} stopped on an error:`, error);
  }
  if (outcome && !outcome.ok && outcome.reason === 'unknown') {
    const batch = outcome.retiredAt ?? retiredAt;
    console.error(`[DataManager] Can't confirm whether guild ${guildId} was restored${batch === undefined ? '' : ` from graveyard batch ${batch}`}: the database did not confirm the commit`);
  }
  // One synchronous run, whatever the exit: the set ends, the barrier is taken, the guild is released.
  const deposedOwner = outcome && !outcome.ok && outcome.reason === 'deposed' ? { owner: outcome.currentOwner } : null;
  if (flushed === 'deposed' || deposedOwner) {
    ws.depose(guildId, deposedOwner?.owner);
  } else if (called && (failure || outcome?.ok || (outcome && !outcome.ok && outcome.reason === 'unknown'))) {
    ws.endRestore(guildId, 'evict');
    restoredAt.set(guildId, markBarrier().stamp);
  } else {
    ws.endRestore(guildId, 'reopen', stillHeld);
  }
  guildDataOps.delete(guildId);

  if (failure) {
    return called
      ? unconfirmed({ ok: false, code: 'backend-unavailable', error: RESTORE_TEXTS.unknown(guildId, retiredAt) })
      : { ok: false, code: 'io-error', error: RESTORE_TEXTS.error(errorMessage(failure.error)) };
  }
  if (flushed === 'deposed') return { ok: false, code: 'not-owner', error: RESTORE_TEXTS.deposed };
  if (flushed !== 'ok') return { ok: false, code: 'backend-unavailable', error: RESTORE_TEXTS.flush };
  if (stopped) return { ok: false, code: 'frozen' };
  if (!outcome) return { ok: false, code: 'backend-unavailable', error: RESTORE_TEXTS.notLoaded };
  if (outcome.ok) return { ok: true, retiredAt: outcome.retiredAt, reason: outcome.reason, moved: outcome.moved };
  switch (outcome.reason) {
    case 'deposed': return { ok: false, code: 'not-owner', error: RESTORE_TEXTS.deposed };
    case 'live-rows': return { ok: false, code: 'invalid', error: RESTORE_TEXTS.live(outcome.retiredAt) };
    case 'no-entry': return { ok: false, code: 'invalid', error: RESTORE_TEXTS.noEntry };
    case 'schema-mismatch': return { ok: false, code: 'invalid', error: RESTORE_TEXTS.schemaMismatch };
    case 'refused': return { ok: false, code: 'backend-unavailable', error: RESTORE_TEXTS.refused(outcome.detail, outcome.code) };
    case 'no-claim': return { ok: false, code: 'backend-unavailable', error: RESTORE_TEXTS.noClaim };
    case 'not-provisioned': return { ok: false, code: 'backend-unavailable', error: RESTORE_TEXTS.notProvisioned };
    case 'unknown': return unconfirmed({ ok: false, code: 'backend-unavailable', error: RESTORE_TEXTS.unknown(guildId, outcome.retiredAt ?? retiredAt) });
    case 'maintenance':
    case 'node-stopping':
    case 'out-of-time':
      return stopAnswer(outcome.reason, 'restore');
    default:
      throw new DataBackendUnavailableError('database-unreachable', RESTORE_TEXTS.unavailable(outcome.detail ?? 'no detail'));
  }
}

async function restoreFiles(guildId: string, retiredAt: number | undefined, deadline: bigint): Promise<GraveyardReply> {
  guildDataOps.set(guildId, 'restore');
  const progress = { renamed: false };
  let outcome: FileRestoreOutcome | undefined;
  let failure: { error: unknown } | null = null;
  try {
    outcome = await restoreGuildDirFromGraveyard(guildId, retiredAt, { stop: () => operationStop(deadline, 0), writerLost: sharedWritesClosedLost, progress });
  } catch (error) {
    failure = { error };
    console.error(`[Data] The restore of guild ${guildId} stopped on an error:`, error);
  }
  // One synchronous run, whatever the exit: the barrier, the guild released, its events replayed in order.
  if (progress.renamed) restoredAt.set(guildId, markBarrier().stamp);
  guildDataOps.delete(guildId);
  replayRestoreEvents(guildId);

  if (failure || !outcome) return { ok: false, code: 'io-error', error: RESTORE_TEXTS.error(errorMessage(failure?.error)) };
  if (outcome.ok) return { ok: true, retiredAt: outcome.retiredAt, reason: outcome.reason, ...(outcome.moveUnconfirmed === undefined ? {} : { moveUnconfirmed: outcome.moveUnconfirmed }) };
  switch (outcome.why) {
    case 'no-entry': return { ok: false, code: 'invalid', error: RESTORE_TEXTS.noEntry };
    case 'live': return { ok: false, code: 'invalid', error: RESTORE_TEXTS.live(outcome.retiredAt) };
    case 'stopped': return stopAnswer(outcome.stop, 'restore');
    case 'writer-lost':
      recordRefusal('writer-lost', guildId);
      return { ok: false, code: 'invalid', error: WRITER_LOST_RESTORE_TEXT };
    case 'note': return { ok: false, code: 'io-error', error: RESTORE_TEXTS.note(outcome.code, outcome.step) };
    default: return { ok: false, code: 'io-error', error: RESTORE_TEXTS.rename(outcome.code) };
  }
}

const WRITER_LOST_RESTORE_TEXT = "Another process took over the bot's data files, so nothing was restored. Please try again in a moment.";

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
 * Helper: Update guild-scoped data in one step (updateData)
 */
export function updateGuildData<T = any>(
  filename: string,
  guildId: string,
  defaultValue: T,
  fn: (current: T) => T,
  category?: string
): SaveTracked {
  return updateData(filename, { guildId, scope: 'guild', category }, defaultValue, fn);
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

/**
 * Helper: Update global data in one step (updateData)
 */
export function updateGlobalData<T = any>(
  filename: string,
  defaultValue: T,
  fn: (current: T) => T,
  category?: string
): SaveTracked {
  return updateData(filename, { scope: 'global', category }, defaultValue, fn);
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
 * (unreachable, fenced) throws DataBackendUnavailableError.
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
 * Update module-scoped data (guild-specific) in one step: fn gets a copy of the stored value (of defaultValue when
 * absent) and returns the new value, and no other write of the document by this process lands in between.
 *
 * @param filename - Data filename (supports subfolders: 'archive/2024.json')
 * @param guildId - Guild ID
 * @param moduleName - Module name (used as namespace)
 * @param defaultValue - What fn gets when the file does not exist
 * @param fn - Returns the new value; must not be async and must not save, append or delete data
 * @returns 'saved' with its ticket once the write is accepted (confirmSaved(guildId) says when it is stored), 'frozen'
 * for a frozen guild, 'refused' with cause 'not-ready' (fn did not run) or 'io' (the document could not be read whole
 * and fn did not run, or the save failed); 'not-ready' also answers while the data layer refuses to serve. A stopping
 * bot, a failing disk (storage-failing) or a database refusal (unreachable, backlog, fenced) throws
 * DataBackendUnavailableError; fn returning a promise or undefined, fn writing data, or a filename ending in .jsonl
 * throws a TypeError. Anything an async fn does after its first await is outside the update.
 *
 * @example
 * // Counts one more entry in /data/{guildId}/giveaway/stats.json
 * updateModuleData('stats.json', '123456', 'giveaway', { entries: 0 }, s => ({ ...s, entries: s.entries + 1 }))
 */
export function updateModuleData<T = any>(
  filename: string,
  guildId: string,
  moduleName: string,
  defaultValue: T,
  fn: (current: T) => T
): SaveTracked {
  return updateGuildData(filename, guildId, defaultValue, fn, moduleName);
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
 * Update global module data in one step, as updateModuleData does for a guild.
 *
 * @param filename - Data filename (supports subfolders)
 * @param moduleName - Module name (used as namespace)
 * @param defaultValue - What fn gets when the file does not exist
 * @param fn - Returns the new value; must not be async and must not save, append or delete data
 * @returns 'saved' with its ticket once the write is accepted (confirmSaved('global') says when it is stored), or
 * 'refused' with cause 'io'. A stopping bot or a failing disk (storage-failing) throws DataBackendUnavailableError;
 * fn returning a promise or undefined, fn writing data, or a filename ending in .jsonl throws a TypeError. Anything
 * an async fn does after its first await is outside the update.
 *
 * @example
 * // Adds a user to /data/global/analytics/stats.json
 * updateGlobalModuleData('stats.json', 'analytics', { totalUsers: 0 }, s => ({ ...s, totalUsers: s.totalUsers + 1 }))
 */
export function updateGlobalModuleData<T = any>(
  filename: string,
  moduleName: string,
  defaultValue: T,
  fn: (current: T) => T
): SaveTracked {
  return updateGlobalData(filename, defaultValue, fn, moduleName);
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
 * refusal (unreachable, fenced) throws DataBackendUnavailableError.
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
