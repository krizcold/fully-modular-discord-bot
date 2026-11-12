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
  readRaw as readRawFile,
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
import { globalKeyRefusal, globalTextRefusal, keyRefusal, pathKeyOf, sizeRefusal, textRefusal, valueText } from './storableData';
import {
  dropGlobalKey,
  forgetGlobalTree,
  globalPlacement,
  globalRelOf,
  isLinesKey,
  mirrorBytes,
  noteGlobalKey,
  configureRowFlush,
  flushRows,
  kickRows,
  ROOT_CONFIG_KEY,
  rowChange,
  rowCommitOwed,
  rowOpsLanded,
  rowQueue,
  rowTicketState,
  shaOf,
  sharedKeyFor,
  sharedKeyOf,
  type CarriedLines,
  type RowBackend,
  type RowOp,
  type RowTicket,
  type UpdateStep,
  unconfirmUnansweredRows,
  webuiSessionsOpen,
} from './sharedStore';
import { appendLine } from './sharedLines';

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
  readRawStrict as readRawStrictFile,
  sweepGraveyard as sweepFileGraveyard,
  listGuilds as listGuildDirs,
} from './dataBackends/fileBackend';
import { commitAnswerOwed, getWorkingSet, DataBackendUnavailableError, resaveTargetOf } from './dataBackends/workingSet';
import type { WsTicket } from './dataBackends/workingSet';
import type { FileRestoreOutcome, FileTicket } from './dataBackends/fileBackend';
import { deadlineIn, msLeft } from './dataBackends/postgresBackend';
import type { DataBackend, FenceToken, LateCommit, ReplacedBatch, RestoreOutcome, RestoreStop, RetireOutcome } from './dataBackends/backend';
import { resolveDataBackend, useSharedDocReader } from '../../../utils/envLoader';
import { currentLedger, currentSince, recordRefusal, recordTicket } from './dataBackends/writeLedger';
import { markBarrier, noteScopeRefusal, noteScopeTicket, pendingFor, saveMark, stampOf, type SaveMark } from './dataBackends/scopeRecord';
import { canonicalGuildKey, GuildKeyError, type GuildKey } from './dataKeys';
import { isMaintenanceGateClosed } from './maintenanceGate';
import { stoppedServing } from './servingGate';
import type { HeldCounts } from './heldWords';
import { noteExitDrain } from './dataBackends/mainDatabase';

export { listGlobalDataFiles, saveMark };
export type { SaveMark };
export { DataBackendUnavailableError } from './dataBackends/workingSet';
export {
  flushFailing,
  getFlushFailures,
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
  kickRows();
}

// NB6: the row queue's flush sends on the data pool and re-runs updates with the accept's checks.
configureRowFlush({
  backend: () => (pgBackend && typeof (pgBackend as Partial<RowBackend>).sharedTx === 'function' ? pgBackend as unknown as RowBackend : null),
  rerun: (what, fn, stored) => rerunUpdate(what, fn, stored),
});

// NB6 decision 57: the payment providers read the credentials doc as the facade holds it.
useSharedDocReader(absPath => (sharedKeyOf(absPath) === null ? undefined : readRawStrict(absPath)));

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
    flushRows(),
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
  const holding = pgBackend?.holdWords?.() ?? null;
  if (left.length > 0) console.warn(`[Data] ${what} left ${left.length} guild(s) with unflushed writes${holding === null ? '' : ` (${holding})`}: ${left.join(', ')}`);
  const resave = getWorkingSet()?.resaveGuilds() ?? [];
  if (what === 'Shutdown drain' && resave.length > 0) {
    console.warn(`[Data] Shutdown drain left ${resave.length} guild(s) not re-saved on ${resaveTarget()}: ${resave.join(', ')}`);
  }
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

/** The writes a deposition cancels: their answers, and the line for each one still unanswered at the exit. */
export interface DeposedWrites {
  answered(): Promise<void>;
  nameLeft(): void;
}

let deposedWrites: DeposedWrites | null = null;

/** Set by the writer lock (it imports this module): the exit drain waits for these answers within its bound. */
export function useDeposedWrites(given: DeposedWrites | null): void {
  deposedWrites = given;
}

/** Right before an exit: a line for each write a deposition lost and named neither saved nor not saved yet. */
export function nameDeposedWritesLeft(): void {
  deposedWrites?.nameLeft();
}
// The JSON restores between K4's rename and their end: the exit drain waits for every one.
const restoreRenameSections = new Set<Promise<void>>();

/** Opens a restore's rename section; answers its end, which its own finally runs. */
function openRenameSection(): () => void {
  let end!: () => void;
  const section = new Promise<void>(resolve => { end = resolve; });
  restoreRenameSections.add(section);
  return () => {
    restoreRenameSections.delete(section);
    end();
  };
}

const pause = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, Math.max(0, ms)); });

/**
 * C6: the row ops this process holds. unsaved: queued or on the wire with no unknown id; unanswered: holding an unknown
 * id with no attempt on the wire. An op whose mirror write is pending is in the database and counts in neither.
 */
function rowOpsHeld(): { unsaved: RowOp[]; unanswered: RowOp[]; onTheWire: boolean } {
  const unsaved: RowOp[] = [];
  const unanswered: RowOp[] = [];
  let onTheWire = false;
  for (const key of rowQueue.keys()) {
    for (const op of rowQueue.ops(key)) {
      if (op.state === 'wire') onTheWire = true;
      if ((op.state === 'queued' || op.state === 'wire') && op.unknown.length === 0) unsaved.push(op);
      else if (op.state === 'queued' && op.unknown.length > 0) unanswered.push(op);
    }
  }
  return { unsaved, unanswered, onTheWire };
}

/** The mirror paths of the row ops not stored, beside the file queue's unsaved paths in the held log. */
export function unsavedRowPaths(): string[] {
  return rowOpsHeld().unsaved.map(op => op.path);
}

/** The row ops holding a save the database did not answer, which may have landed, with no check on the wire. */
export function unansweredRowOps(): number {
  return rowOpsHeld().unanswered.length;
}

/** Decision 39: no op in the row queue, stored or not, and no web UI session's mark (S3's wait in the web UI process). */
export function sharedWritesSettled(): boolean {
  return rowQueue.keys().length === 0 && webuiSessionsOpen() === 0;
}

// Row ops are database writes: while latched (filesOnly) they are left out, as the working set is.
function writesSettled(filesOnly = false): boolean {
  const ws = filesOnly ? null : getWorkingSet();
  return queuedFileWrites() === 0 && (!ws || ws.writesSettled()) && (filesOnly || sharedWritesSettled());
}

const landedFlushes = () => fileFlushesLanded() + (getWorkingSet()?.landedFlushes() ?? 0) + rowOpsLanded();
const flushOnTheWire = (filesOnly = false) => fileFlushOnTheWire() || (!filesOnly && ((getWorkingSet()?.flushOnTheWire() ?? false) || rowOpsHeld().onTheWire));

// A pass flushes what is queued when it starts: a write accepted during it and
// a flush already on the wire are the next pass's, and the pause hands a flush
// on the wire the event loop. A store that refuses (down, a failing
// disk) is retried until nothing has landed for EXIT_DRAIN_GIVEUP_MS and
// nothing is on the wire, so a blip drains and a dead store costs that window,
// not the bound.
/** Where a set pending re-save goes: the database in use once the latch is down, else the main still to be found. */
export function resaveTarget(): string {
  return resaveTargetOf(pgBackend);
}

// NB5 decision 13: while held, the drain asks for the confirmation, counts the hold as work on the wire, and measures
// its give-up from the later of its last landing and the hold's last confirmation.
// While latched only the database writes are refused: the drain goes on with the files alone.
async function drainUntilSettled(deadline: number, progress: { at: number; landed: number }, filesOnlyAsked = false): Promise<void> {
  const onlyFiles = () => filesOnlyAsked || (pgBackend?.latchReason?.() ?? null) !== null;
  while (!writesSettled(onlyFiles()) && Date.now() < deadline) {
    const filesOnly = onlyFiles();
    const held = !filesOnly && (pgBackend?.holdWords?.() ?? null) !== null;
    if (held) pgBackend!.confirmNow?.();
    const ws = filesOnly ? null : getWorkingSet();
    await Promise.race([
      Promise.all([flushAllFiles(), ws ? ws.flushAllDirty() : null, filesOnly ? null : flushRows()]).catch(() => undefined),
      pause(deadline - Date.now()),
    ]);
    if (writesSettled(filesOnly)) return;
    if (landedFlushes() !== progress.landed) {
      progress.landed = landedFlushes();
      progress.at = Date.now();
    } else if (!held && !flushOnTheWire(filesOnly) && Date.now() - Math.max(progress.at, (filesOnly ? null : pgBackend?.heldUntil?.()) ?? 0) >= EXIT_DRAIN_GIVEUP_MS) return;
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
      noteExitDrain();
      const deadline = Date.now() + boundMs;
      const progress = { at: Date.now(), landed: landedFlushes() };
      // A refused write in code that does not catch it must not end the
      // process before the drain does.
      process.on('uncaughtException', error => console.error('[Data] Error during the exit drain (the drain goes on):', error));
      try {
        await drainUntilSettled(deadline - Math.floor(boundMs / 5), progress);
        closedForExit = true;
        await Promise.allSettled([...restoreRenameSections]);
        await drainUntilSettled(deadline, progress);
        if (deposedWrites) await Promise.race([deposedWrites.answered(), pause(deadline - Date.now())]);
        logDrainLeft('Shutdown drain', getWorkingSet()?.dirtyGuildIds() ?? []);
        const files = queuedFileWrites() + rowOpsHeld().unsaved.length;
        if (files > 0) console.warn(`[Data] Shutdown drain left ${files} file(s) with queued writes`);
      } finally {
        unconfirmUnansweredRows('the bot process stopped before the database answered a check');
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
 * Maintenance's save: flushes the working set, the row ops and the queued file writes until nothing is held, nothing
 * lands for the drain's give-up window, or boundMs passes. Unlike the exit drain it closes nothing. Answers what is
 * still held.
 */
export async function saveHeldWrites(boundMs: number): Promise<HeldCounts> {
  await drainUntilSettled(Date.now() + boundMs, { at: Date.now(), landed: landedFlushes() });
  const ws = getWorkingSet();
  const unanswered = ws?.unansweredGuilds() ?? { all: [], only: [] };
  const rows = rowOpsHeld();
  return {
    unsavedGuilds: (ws?.dirtyGuildIds() ?? []).filter(guildId => !unanswered.only.includes(guildId)).length,
    unsavedFiles: unsavedFileWrites() + rows.unsaved.length,
    unansweredGuilds: unanswered.all.length,
    unconfirmedFiles: unconfirmedFiles(),
    ...((ws?.resaveGuilds().length ?? 0) > 0 ? { resaveGuilds: ws!.resaveGuilds().length } : {}),
    ...(rows.unanswered.length > 0 ? { unansweredFiles: rows.unanswered.length } : {}),
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
    nameDeposedWritesLeft();
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
      nameDeposedWritesLeft();
      process.exit(stopExitCode);
    }
  });
  process.on('SIGTERM', () => void stopRunner?.());
  process.on('SIGINT', () => void stopRunner?.());
}

/** Tests only: forgets the stop handler, its steps and a stop that ran, as a fresh process has them. */
export function _resetStopHandler(): void {
  stopBegun = false;
  processStop = null;
  stopRunner = null;
  finalStepsRan = false;
  stopExitCode = 0;
  for (const steps of [stopSteps, finalStopSteps, releaseSteps]) steps.length = 0;
}

/** Starts the stop as a signal would; deposed: another process took the lock, so the exit code is EXIT_DEPOSED. */
export function beginStop(deposed = false): Promise<void> {
  if (deposed && !stopBegun) stopExitCode = EXIT_DEPOSED;
  return stopRunner ? stopRunner() : Promise.resolve();
}

// The web UI process installs the shared gate (none in the bot process): outside a change it applies itself, every
// file write of that process is refused, sessions excepted. A process another one deposed closes every shared write.
let sharedWriteGate: ((absPath?: string) => boolean) | null = null;
let sharedWritesLost = false;
const SESSIONS_DIR = path.resolve(DATA_ROOT, '_sessions') + path.sep;

/** gate answers whether this context may write absPath; with no path, whether it may write shared files at all. */
export function setSharedWriteGate(gate: ((absPath?: string) => boolean) | null): void {
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

let writerLockCheck: (() => boolean) | null = null;

/** How a restore reads the lock file itself; the writer lock sets it at a fresh take (it imports this module). */
export function useWriterLockCheck(check: (() => boolean) | null): void {
  writerLockCheck = check;
}

/** Another process took the data files: the cached flag, or the lock file read now. */
export function writerTakenNow(): boolean {
  return sharedWritesLost || (writerLockCheck?.() ?? false);
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
  if (sharedWriteGate && !sharedWriteGate(absPath)) {
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
  forgetGlobalTree();
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
export async function confirmWrite(ticket: WriteTicket, deadlineMs: number): Promise<'ok' | 'pending' | 'held' | 'deposed' | 'unavailable' | 'refused'> {
  if (ticket.kind === 'file') return confirmFile(ticket, deadlineMs);
  if (ticket.kind === 'row') return confirmRow(ticket, deadlineMs);
  return ticket.manager.confirm(ticket, deadlineMs);
}

/**
 * NB6 D1: a row ticket waits until its op settles, a try of the op ends without an outcome (before the call or during
 * the wait), or the deadline. 'refused' is the flush's refusal (its cause is on the op). An op still open after a try
 * ended without an outcome answers 'pending' while one of its attempts may be stored, else 'held'; at the deadline,
 * 'pending'.
 */
async function confirmRow(ticket: RowTicket, deadlineMs: number): Promise<'ok' | 'pending' | 'held' | 'unavailable' | 'refused'> {
  const end = performance.now() + deadlineMs;
  for (;;) {
    const state = rowTicketState(ticket);
    if (state === 'landed') return 'ok';
    if (state === 'refused') return 'refused';
    if (state === 'unconfirmed') return 'unavailable';
    if (ticket.op.triesFailed > 0) return rowCommitOwed(ticket) ? 'pending' : 'held';
    const left = end - performance.now();
    if (left <= 0) return 'pending';
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([rowChange(ticket), new Promise<void>(resolve => { timer = setTimeout(resolve, left); })]);
    clearTimeout(timer);
  }
}

/** A re-read 'pending' stays pending while a COMMIT that may carry the write owes its answer (NB13 decision 6, D1). */
export function commitOwed(ticket: WriteTicket): boolean {
  return (ticket.kind === 'ws' && commitAnswerOwed(ticket)) || (ticket.kind === 'row' && rowCommitOwed(ticket));
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
  const judged = tickets.filter(ticket => ticket.kind === 'ws' || folder === null || (ticket.kind === 'row' ? ticket.op.path : ticket.path).startsWith(folder));
  const first = await Promise.all(judged.map(ticket => confirmWrite(ticket, deadlineMs).catch(() => 'unavailable' as const)));
  // A held write is retried while slower confirms finish, so it is read again when the answer is taken. Its 'pending'
  // stays pending while a COMMIT that may carry it owes its answer.
  const now = await Promise.all(first.map((answer, i) => {
    if (answer !== 'held') return answer;
    const ticket = judged[i];
    return confirmWrite(ticket, 0).then(again => (again === 'pending' && !commitOwed(ticket) ? 'held' as const : again), () => 'unavailable' as const);
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
  return readRawStrictFile(guildDocFilePath(guildId, module, filename));
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

/** How long a graveyard entry is kept after its delete or its newest restore: GRAVEYARD_TTL_DAYS, 14 days by default. */
function graveyardTtlMs(): number {
  const ttlDays = Number(process.env.GRAVEYARD_TTL_DAYS);
  return (Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays : 14) * 24 * 60 * 60 * 1000;
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
  const served = pgBackend as { servesData?: () => boolean; sweepGraveyard?: (ttlMs: number) => Promise<number> };
  if (!served.servesData?.() || !served.sweepGraveyard) return;
  try {
    const swept = await served.sweepGraveyard(graveyardTtlMs());
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

  /**
   * The sha of the bytes this write was built on, for a shared key on a Postgres bot (NB6 decision 22): the write is
   * stored only over that version. Ignored elsewhere.
   */
  baseSha?: string;

  /**
   * Lines of a lines key the save's op stores in its own transaction (NB6 decision 47: premium's audit lines), on a
   * Postgres bot only; the caller writes them itself elsewhere.
   */
  lines?: CarriedLines;

  /**
   * Other shared keys this write was built on, with the sha each had then (null: no row), on a Postgres bot only (NB6
   * decision 102): the write is stored only while each still has that sha.
   */
  check?: Record<string, string | null>;
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

/** NB6 decision 19: the migration lock refuses a write of a shared key on a Postgres bot as it refuses a guild write. */
function refuseSharedWhileGated(filename: string, options: DataOptions): void {
  if (options.scope === 'global' && sharedKeyOf(getDataFilePath(filename, options))) refuseWhileGated();
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
  | { accepted: false; cause: 'unstorable' | 'storage-failing' | 'database-backlog' | 'io' | 'not-ready' | 'writer-lost'; reason?: string };

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
  const rel = globalRelOf(absPath);
  if (rel !== null || sharedKeyFor(absPath) === ROOT_CONFIG_KEY) {
    const refusal = globalTextRefusal(contents) ?? (rel === null ? null : globalKeyRefusal(rel, 'save'));
    return refusal ? refuseRaw(absPath, 'unstorable', refusal) : null;
  }
  const guild = guildRawKey(absPath);
  if (!guild) return null;
  const refusal = textRefusal(contents, 'text') ?? keyRefusal(guild.key, 'save');
  return refusal ? refuseRaw(absPath, 'unstorable', refusal) : null;
}

/** Rule P for a raw write under /data/global, against the global keys. */
function globalRawCollision(absPath: string): RawRefused | null {
  const rel = globalRelOf(absPath);
  const collision = rel === null ? null : globalPlacement(rel);
  return collision ? refuseRaw(absPath, 'unstorable', collision.reason) : null;
}

/**
 * The rules a write of contents to an absolute path meets, for a process that is not the file's writer: S; under a
 * guild folder T, K and P read only; under /data/global and for the root config T, K and P. It changes nothing on
 * disk; the writer checks again under its lock.
 */
export function rawCheckRefusal(absPath: string, contents: string): RawRefused | null {
  const refused = storableRawRefusal(absPath, contents) ?? globalRawCollision(absPath);
  if (refused) return refused;
  const guild = guildRawKey(absPath);
  if (!guild) return null;
  const collision = guildWriteCollision(guild.guildId, guild.key);
  return collision ? refuseRaw(absPath, 'unstorable', collision) : null;
}

/**
 * The rules a write of contents to an absolute path meets (S; under a guild folder T, K and P; under /data/global and
 * for the root config T, K and P), queuing nothing: the refusal, recorded and logged as the write's would be, or null
 * when the write may go ahead. Rule P removes a keyless folder in the way under a guild folder, so only the writer
 * calls this.
 */
export function rawWriteRefusal(absPath: string, contents: string): RawRefused | null {
  const refused = storableRawRefusal(absPath, contents) ?? globalRawCollision(absPath);
  if (refused) return refused;
  const guild = guildRawKey(absPath);
  if (!guild) return null;
  const placement = placeGuildWrite(guild.guildId, guild.key);
  if (!placement.ok) return refuseRaw(absPath, placement.cause, placement.reason);
  return null;
}

/** The base of a write without a caller base: what the facade holds for the file now (decision 22). */
function rowBase(absPath: string, baseSha: string | undefined): { sha: string; caller: boolean } {
  return baseSha === undefined ? { sha: baseOf(absPath), caller: false } : { sha: baseSha, caller: true };
}

/** Queue an atomic write to an absolute path, answering why it was refused; throws once the exit drain has closed. */
export function writeRawAtomicTracked(absPath: string, contents: string, options: { baseSha?: string } = {}): RawWriteTracked {
  if (closedForExit) {
    recordRefusal('node-stopping', `file:${absPath}`);
    throw new DataBackendUnavailableError('node-stopping');
  }
  const rowKey = sharedKeyOf(absPath);
  if (isGuildDataPath(absPath) || rowKey) refuseWhileGated();
  if (rawRefusedWhileHeld(absPath)) return { accepted: false, cause: 'not-ready' };
  const shared = sharedRefusal(absPath);
  if (shared) {
    recordRefusal(shared, `file:${absPath}`);
    return { accepted: false, cause: shared };
  }
  const refused = rawWriteRefusal(absPath, contents);
  if (refused) return refused;
  const rel = globalRelOf(absPath);
  if (rowKey) {
    if (rowQueue.closed()) {
      recordRefusal('database-backlog', `file:${absPath}`);
      return { accepted: false, cause: 'database-backlog' };
    }
    recordTicket(rowQueue.accept(rowKey, absPath, { body: Buffer.from(contents, 'utf8') }, rowBase(absPath, options.baseSha)), `file:${absPath}`);
    if (rel !== null) noteGlobalKey(rel);
    return { accepted: true };
  }
  const guild = guildRawKey(absPath);
  const accepted = writeRawAtomicFile(absPath, contents);
  if (accepted) {
    if (guild) noteGuildWrite(guild.guildId, guild.key);
    if (rel !== null) noteGlobalKey(rel);
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

/**
 * An update of a shared key's JSON text on a Postgres bot (NB6 decision 34): fn gets a private copy of the value held
 * now (defaultValue's when there is none) and returns the new value, which is written as the facade writes JSON; the
 * flush re-runs fn on the stored value when another machine stored a newer one. fn must be synchronous and write no
 * data; a throw from it reaches the caller and nothing is queued. A path that is no shared key on this bot throws.
 */
export function updateRawTracked(absPath: string, defaultValue: unknown, fn: (current: any) => unknown): RawWriteTracked {
  if (closedForExit) {
    recordRefusal('node-stopping', `file:${absPath}`);
    throw new DataBackendUnavailableError('node-stopping');
  }
  const rowKey = sharedKeyOf(absPath);
  if (!rowKey) throw new TypeError(`[Data] ${absPath} is not a shared key on this bot, so it has no raw update`);
  refuseWhileGated();
  if (rawRefusedWhileHeld(absPath)) return { accepted: false, cause: 'not-ready' };
  const shared = sharedRefusal(absPath);
  if (shared) {
    recordRefusal(shared, `file:${absPath}`);
    return { accepted: false, cause: shared };
  }
  let current: unknown;
  let base: string;
  try {
    const entry = rowQueue.entryOf(rowKey);
    const bytes = entry ? entry.body : mirrorBytes(absPath);
    current = bytes === null ? structuredClone(defaultValue) : JSON.parse(bytes.toString('utf8'));
    base = bytes === null ? 'absent' : shaOf(bytes);
  } catch (error) {
    return refuseRaw(absPath, 'io', `the stored text could not be read whole (${error instanceof Error ? error.message : String(error)})`);
  }
  let next: unknown;
  try {
    next = runUpdateFn(absPath, fn, current);
  } catch (error) {
    if (error instanceof UpdateFnError) throw error.error;
    throw error;
  }
  const value = valueText(next);
  if (!value.ok) return refuseRaw(absPath, 'unstorable', value.reason);
  const refused = rawWriteRefusal(absPath, value.text);
  if (refused) return refused;
  if (rowQueue.closed()) {
    recordRefusal('database-backlog', `file:${absPath}`);
    return { accepted: false, cause: 'database-backlog' };
  }
  recordTicket(rowQueue.accept(rowKey, absPath, { body: Buffer.from(value.text, 'utf8'), update: { fn, defaultValue } }, { sha: base, caller: false }), `file:${absPath}`);
  const rel = globalRelOf(absPath);
  if (rel !== null) noteGlobalKey(rel);
  return { accepted: true };
}

/** Queue an atomic delete of an absolute path (false: nothing to delete); refused once the exit drain has closed. */
export function deleteRawAtomic(absPath: string, options: { baseSha?: string } = {}): boolean {
  return deleteRawAtomicTracked(absPath, options).accepted;
}

/** deleteRawAtomic with why nothing was queued: 'absent' when there was nothing to delete, else the refusal's cause. */
export function deleteRawAtomicTracked(absPath: string, options: { baseSha?: string } = {}): { accepted: boolean; cause?: string } {
  if (closedForExit) {
    recordRefusal('node-stopping', `file:${absPath}`);
    throw new DataBackendUnavailableError('node-stopping');
  }
  const rowKey = sharedKeyOf(absPath);
  if (isGuildDataPath(absPath) || rowKey) refuseWhileGated();
  if (rawRefusedWhileHeld(absPath)) return { accepted: false, cause: 'not-ready' };
  const shared = sharedRefusal(absPath);
  if (shared) {
    recordRefusal(shared, `file:${absPath}`);
    return { accepted: false, cause: shared };
  }
  const rel = globalRelOf(absPath);
  if (rowKey) {
    const entry = rowQueue.entryOf(rowKey);
    if (!(entry ? entry.body !== null : existsOnDisk(absPath))) return { accepted: false, cause: 'absent' };
    if (rowQueue.closed()) {
      recordRefusal('database-backlog', `file:${absPath}`);
      return { accepted: false, cause: 'database-backlog' };
    }
    recordTicket(rowQueue.accept(rowKey, absPath, { body: null }, rowBase(absPath, options.baseSha)), `file:${absPath}`);
    if (rel !== null) dropGlobalKey(rel);
    return { accepted: true };
  }
  const accepted = deleteRawAtomicFile(absPath);
  if (accepted && rel !== null) dropGlobalKey(rel);
  // A delete still queued for the path has not landed: it answers for this one.
  if (accepted || getPending(absPath)?.op === 'delete') recordTicket(fileTicket(absPath), `file:${absPath}`);
  else {
    const cause = lastRawRefusal();
    if (cause) recordRefusal(cause, `file:${absPath}`);
    return { accepted, ...(cause ? { cause } : {}) };
  }
  return { accepted };
}

/** What this process holds for a shared key ahead of its mirror: the text (null for a delete), or undefined for nothing. */
function rowHeld(absPath: string): string | null | undefined {
  const key = sharedKeyOf(absPath);
  const entry = key ? rowQueue.entryOf(key) : undefined;
  if (!entry) return undefined;
  return entry.body === null ? null : entry.body.toString('utf8');
}

/** A file's text: this process's row op of it first, then its queued write, then the disk; null when absent or unreadable. */
export function readRaw(absPath: string): string | null {
  const held = rowHeld(absPath);
  return held === undefined ? readRawFile(absPath) : held;
}

/** readRaw for a caller that must tell absent from unreadable: a read error other than absence throws. */
export function readRawStrict(absPath: string): string | null {
  const held = rowHeld(absPath);
  return held === undefined ? readRawStrictFile(absPath) : held;
}

/**
 * The sha of the bytes the facade holds for a file now (NB6 decisions 22 and 50): this process's row op or queued
 * write first, then the disk; 'absent' for none, 'unreadable' when the file cannot be read.
 */
export function baseOf(absPath: string): string {
  const key = sharedKeyOf(absPath);
  const entry = key ? rowQueue.entryOf(key) : undefined;
  if (entry) return entry.body === null ? 'absent' : shaOf(entry.body);
  const pending = key ? undefined : getPending(absPath);
  if (pending?.op === 'delete') return 'absent';
  if (pending?.op === 'write') return shaOf(Buffer.from(pending.content, 'utf8'));
  try {
    const bytes = mirrorBytes(absPath);
    return bytes === null ? 'absent' : shaOf(bytes);
  } catch {
    return 'unreadable';
  }
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
    const held = rowHeld(filePath);
    if (held !== undefined) return held === null ? defaultValue : JSON.parse(held);
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
export type WriteTicket = WsTicket | FileTicket | RowTicket;

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

/** A global-scope write's path and its key below /data/global (null outside it) after rule K, or its refusal. */
function storableGlobal(filename: string, options: DataOptions, kind: 'save' | 'append'): { file: string; rel: string | null } | Refused {
  const file = getDataFilePath(filename, options);
  const rel = globalRelOf(file);
  const refusal = rel === null ? null : globalKeyRefusal(rel, kind);
  return refusal ? unstorable(filename, options, refusal) : { file, rel };
}

/** Rule P for a global-scope write against the global keys; null when it fits. */
function placeGlobal(filename: string, options: DataOptions, rel: string | null): Refused | null {
  const collision = rel === null ? null : globalPlacement(rel);
  return collision ? unstorable(filename, options, collision.reason) : null;
}

/** An update's part of a row op: its fn, and the sha of the bytes readForUpdate gave it. */
interface RowUpdate {
  step: UpdateStep;
  base: string;
}

const rowTicketOf = (op: RowOp): RowTicket => ({ kind: 'row', key: op.key, op, seq: op.writes });

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
  const ticket = 'ticket' in outcome ? outcome.ticket : undefined;
  if (ticket) {
    recordTicket(ticket, whole ? doc : undefined);
    noteScopeTicket(scope, ticket, whole ? doc : undefined);
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

function acceptSave<T>(filename: string, options: DataOptions, data: T, update?: RowUpdate): SaveTracked {
  refuseInsideUpdate();
  if (filename.endsWith('.jsonl')) {
    throw new TypeError(`[Data] ${filename} is an append-only file; write it with appendData. The value was not saved`);
  }
  if (closedForExit) throw new DataBackendUnavailableError('node-stopping');
  refuseInMaintenance(options);
  refuseGuildWhileGated(options);
  refuseSharedWhileGated(filename, options);
  if (guildWriteClosed(options, 'Write')) return { outcome: 'refused', cause: 'not-ready' };
  if (refusedWhileHeld(options, 'Write') || refusedBeforeRestore(options, 'Write')) return { outcome: 'refused', cause: 'not-ready' };
  const guildScope = (options.scope || 'guild') === 'guild';
  const checked = guildScope ? storableKey(filename, options, 'save') : null;
  if (checked && isRefused(checked)) return checked;
  const global = guildScope ? null : storableGlobal(filename, options, 'save');
  if (global && 'outcome' in global) return global;
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
    const placed = checked ? placeOnFiles(filename, options, checked as GuildKey) : placeGlobal(filename, options, global?.rel ?? null);
    if (placed) return placed;

    const rowKey = sharedKeyOf(filePath);
    if (rowKey) {
      if (rowQueue.closed()) throw new DataBackendUnavailableError('database-backlog');
      const base = update ? { sha: update.base, caller: false } : { ...rowBase(filePath, options.baseSha), ...(options.check ? { check: options.check } : {}) };
      const ticket = rowQueue.accept(rowKey, filePath, { body: Buffer.from(content, 'utf8'), update: update?.step, ...(options.lines ? { lines: options.lines } : {}) }, base);
      if (global?.rel) noteGlobalKey(global.rel);
      getMetricsCollector().recordIO('write', null, options.category ?? null);
      return { outcome: 'saved', ticket };
    }

    // Ensure the dir synchronously so the guild dir exists the moment the save
    // is accepted.
    ensureDirectory(dir);

    enqueueWrite(filePath, content);
    if (checked) noteGuildWrite(options.guildId ?? '', pathKeyOf((checked as GuildKey).module, (checked as GuildKey).filename));
    if (global?.rel) noteGlobalKey(global.rel);
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

/** base: for a shared key, the sha of the bytes read ('absent' for none), which the row op is built on. */
type UpdateRead = { status: 'absent'; base?: string } | { status: 'present'; value: unknown; base?: string } | { status: 'refused'; cause: 'not-ready' | 'io' };

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
    const rowKey = sharedKeyOf(filePath);
    if (rowKey) {
      const entry = rowQueue.entryOf(rowKey);
      const bytes = entry ? entry.body : mirrorBytes(filePath);
      if (bytes === null) return { status: 'absent', base: 'absent' };
      return { status: 'present', value: JSON.parse(bytes.toString('utf8')), base: shaOf(bytes) };
    }
    const pending = getPending(filePath);
    if (pending?.op === 'delete') return { status: 'absent' };
    if (pending?.op === 'write') return { status: 'present', value: JSON.parse(pending.content) };
    if (pending?.op === 'append') {
      console.error(`[DataManager] Update of ${filename} refused: appended lines are still queued for it, and a whole write would replace them`);
      return { status: 'refused', cause: 'io' };
    }
    // A folder at the key's name, or a file at one of its folders, under a guild folder is no document: the save's rule P removes or refuses it.
    const stored = readRawStrictFile(filePath);
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
  refuseSharedWhileGated(filename, options);
  if (guildWriteClosed(options, 'Update')) return { outcome: 'refused', cause: 'not-ready' };
  if (refusedWhileHeld(options, 'Update') || refusedBeforeRestore(options, 'Update')) return { outcome: 'refused', cause: 'not-ready' };
  if ((options.scope || 'guild') === 'guild') {
    const checked = storableKey(filename, options, 'save');
    if (isRefused(checked)) return checked;
  } else {
    const global = storableGlobal(filename, options, 'save');
    if ('outcome' in global) return global;
  }
  const read = readForUpdate(filename, options);
  if (read.status === 'refused') return { outcome: 'refused', cause: read.cause };
  const current = (read.status === 'present' ? read.value : structuredClone(defaultValue)) as T;
  const next = runUpdateFn(filename, fn, current);
  return acceptSave(filename, options, next, read.base === undefined ? undefined : { step: { fn, defaultValue }, base: read.base });
}

/**
 * Runs an update's fn on current inside an update frame and applies its checks in order: a throw (carried as
 * UpdateFnError), a data write inside fn, a promise, undefined. Answers fn's result.
 */
function runUpdateFn(what: string, fn: (current: any) => unknown, current: unknown): unknown {
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
        console.error(`[Data] An async update function for ${what} failed after it was refused:`, error);
      });
    } catch { /* a then that throws leaves nothing pending */ }
  }
  if (frame.nested) throw new TypeError('[Data] The update function made a data write of its own; the update was not saved');
  if (next === undefined) throw new TypeError('[Data] The update function returned undefined; it must return the new value. The update was not saved');
  if (thenable) {
    throw new TypeError('[Data] The update function returned a promise; it must return the new value without awaiting. The update was not saved');
  }
  return next;
}

export type UpdateRerun = { ok: true; text: string; value: unknown } | { ok: false; cause: 'changed-elsewhere'; reason: string };

/**
 * The flush's re-run of an update's fn on the stored value (NB6 decision 5, C11): the accept's checks in their order,
 * then NB12's value rules. A failure refuses the op 'changed-elsewhere' with decision 5's text; what names the module
 * or file.
 */
export function rerunUpdate(what: string, fn: (current: any) => unknown, stored: unknown): UpdateRerun {
  const refused = (error: string): UpdateRerun => ({
    ok: false,
    cause: 'changed-elsewhere',
    reason: `${what}: the update could not be applied to the newer version another machine saved (${error})`,
  });
  let next: unknown;
  try {
    next = runUpdateFn(what, fn, stored);
  } catch (error) {
    const thrown = error instanceof UpdateFnError ? error.error : error;
    return refused(thrown instanceof Error ? thrown.message : String(thrown));
  }
  const value = valueText(next);
  if (!value.ok) return refused(value.reason);
  const tooLarge = sizeRefusal(value.text);
  if (tooLarge) return refused(tooLarge);
  return { ok: true, text: value.text, value: next };
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
  refuseSharedWhileGated(filename, options);
  if (guildWriteClosed(options, 'Append')) return { outcome: 'refused', cause: 'not-ready' };
  if (refusedWhileHeld(options, 'Append') || refusedBeforeRestore(options, 'Append')) return { outcome: 'refused', cause: 'not-ready' };
  const guildScope = (options.scope || 'guild') === 'guild';
  const checked = guildScope ? storableKey(filename, options, 'append') : null;
  if (checked && isRefused(checked)) return checked;
  const global = guildScope ? null : storableGlobal(filename, options, 'append');
  if (global && 'outcome' in global) return global;
  const textRefused = (global?.rel != null ? globalTextRefusal(line, 'line') : textRefusal(line)) ?? sizeRefusal(line);
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
    const placed = checked ? placeOnFiles(filename, options, checked as GuildKey) : placeGlobal(filename, options, global?.rel ?? null);
    if (placed) return placed;
    // NB6 decision 8: a lines key on a Postgres bot is one shared_lines row a line, with no file.
    const linesKey = checked ? null : sharedKeyOf(filePath);
    if (linesKey !== null && isLinesKey(linesKey)) {
      if (rowQueue.closed()) throw new DataBackendUnavailableError('database-backlog');
      const ticket = appendLine(linesKey, line.endsWith('\n') ? line.slice(0, -1) : line);
      if (global?.rel) noteGlobalKey(global.rel);
      getMetricsCollector().recordIO('write', null, options.category ?? null);
      return { outcome: 'appended', ticket };
    }
    ensureDirectory(dir);

    enqueueAppend(filePath, line);
    if (checked) noteGuildWrite(options.guildId ?? '', pathKeyOf((checked as GuildKey).module, (checked as GuildKey).filename));
    if (global?.rel) noteGlobalKey(global.rel);
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
  const held = rowHeld(filePath);
  if (held !== undefined) return held !== null;
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
  refuseSharedWhileGated(filename, options);
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
    const rel = options.scope === 'global' ? globalRelOf(filePath) : null;

    const rowKey = sharedKeyOf(filePath);
    if (rowKey) {
      const entry = rowQueue.entryOf(rowKey);
      if (!(entry ? entry.body !== null : existsOnDisk(filePath))) {
        console.log(`[DataManager] File not found for deletion: ${filePath}`);
        return entry ? { outcome: 'absent', ticket: rowTicketOf(entry) } : { outcome: 'absent' };
      }
      if (rowQueue.closed()) throw new DataBackendUnavailableError('database-backlog');
      const ticket = rowQueue.accept(rowKey, filePath, { body: null }, rowBase(filePath, options.baseSha));
      if (rel !== null) dropGlobalKey(rel);
      return { outcome: 'deleted', ticket };
    }

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
    if (rel !== null) dropGlobalKey(rel);
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

/** A write or an append from a run whose ledger is still open and began before the guild's restore ended. */
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
  schemaMismatch: 'this bot refused the database at boot (its log says why); nothing was restored',
  noClaim: 'this bot process holds no usable claim on the database; nothing was restored; restart the bot',
  notProvisioned: 'the database is not provisioned yet; nothing was restored; try again once the bot has started',
  outOfTime: 'the restore ran out of its 40 s before it could commit; nothing was restored; try again in a moment',
  deposed: "another bot process now serves this server's data; nothing was restored",
  nodeStopping: '[Data] This process is stopping; nothing was restored',
  live: (guildId: string, retiredAt: number) => `server ${guildId} has data saved since entry ${retiredAt} was deleted; nothing was restored. To put entry ${retiredAt} in place and move the current data to the graveyard as a new entry, run: smdb graveyard restore ${guildId} ${retiredAt} --replace`,
  changed: "the server's data changed during the replace; nothing was restored; try again in a moment",
  incomplete: (put: number, taken: number) => `the restore stopped: the database put ${put} of ${taken} row(s) in place; nothing was restored; see the bot log`,
  unavailable: (detail: string) => `[Data] The database did not answer or ended the connection (${detail}); nothing was restored; try again in a moment`,
  refused: (detail: string, code?: string) => `the database refused the restore (${detail}); nothing was restored; ${code === '40P01' || code === '57014' ? 'try again in a moment' : 'see the bot log'}`,
  /** replaced: the move-out's batch (null: it moved nothing), undefined for a plain restore or a move-out with no answer. */
  unknown: (guildId: string, retiredAt: number | undefined, replaced?: ReplacedBatch) => `${replaced
    ? `can't confirm whether server ${guildId} was restored: the database did not confirm the commit. Within a minute, if it was restored, \`smdb graveyard list\` lists entry ${replaced.retiredAt}, which holds the server's data from before, and entry ${retiredAt} was copied in; if not, no entry ${replaced.retiredAt} is listed and nothing changed.`
    : `can't confirm whether server ${guildId} was restored: the database did not confirm the commit; the outcome is fixed within a minute.${replaced === null ? ' The server had no data, so no entry was added.' : ''}`} ${restoreTail(guildId, retiredAt)} ${RESTORE_MAIN}`,
  error: (message: string) => `the restore stopped on an error in the bot (${message}); nothing was restored; see the bot log`,
  failing: (file: string, code: string) => `a file of this server keeps failing to save (${file}: ${code}); nothing was restored; free disk space or fix the file's permissions, then try again`,
  stamp: (x: number, code: string) => `entry ${x} could not be marked as restored (${code}); nothing was restored; try again in a moment`,
  copy: (x: number, code: string) => (code === 'ENOSPC'
    ? `entry ${x} could not be copied (ENOSPC); nothing was restored; free disk space, then try again`
    : `entry ${x} could not be copied (${code}); nothing was restored; try again in a moment`),
  copyDeadline: (x: number, copied: number) => `entry ${x} could not be copied before the restore's deadline (${copied} file(s) copied); nothing was restored`,
  copySync: (x: number, code: string, kind: 'sync' | 'open' | 'earlier', dir: string) => (kind === 'sync'
    ? `the disk did not confirm the copy of entry ${x} (${code}); nothing was restored; check the disk, then restart the machine and try again`
    : kind === 'earlier'
      ? `the copy of entry ${x} is not trusted, since the disk did not confirm a folder sync earlier in this process (${code}); nothing was restored; check the disk, then restart the machine and try again`
      : `${dir} could not be opened for the sync of the copy of entry ${x} (${code}); nothing was restored; try again`),
  move: (code: string) => `the server's current data could not be moved to the graveyard (${code}); nothing was restored; try again in a moment`,
  put: (x: number, code: string) => `the copy of entry ${x} could not be put in place (${code}); nothing was restored; try again in a moment`,
  undo: (x: number, code: string) => `the copy of entry ${x} could not be put in place (${code}); nothing was restored; the server's data is back in place; try again in a moment`,
  undoTaken: (x: number, code: string) => `the copy of entry ${x} could not be put in place (${code}); nothing was restored. The server's data was moved back, but another process took over the bot's data files at the same moment: can't confirm that it saved nothing over those files, and a file it replaced then is in no graveyard entry. Entry ${x} stays listed. Check the server's data before you try again.`,
  undoUnconfirmed: (guildId: string, r: number, code: string) => ` The disk did not confirm the move back (${code}), so after a power cut the server's data can be in graveyard entry ${r} instead; it stays listed there, and smdb graveyard restore ${guildId} ${r} --replace puts it back.`,
  half: (guildId: string, x: number, r: number, code: string, undoCode: string) => `the server's data was moved to graveyard entry ${r}, but the copy of entry ${x} could not be put in place (${code}) and the data could not be moved back (${undoCode}). The server had no data when this answer was made; nothing is lost: entries ${r} and ${x} are both in \`smdb graveyard list\`. To put the server's data back, run: smdb graveyard restore ${guildId} ${r} --replace; to restore entry ${x} instead: smdb graveyard restore ${guildId} ${x} --replace`,
  halfTaken: (guildId: string, x: number, r: number, code: string) => `another process took over the bot's data files during the restore, after the server's data was moved to graveyard entry ${r}: the copy of entry ${x} could not be put in place (${code}), and this process did not move the data back. Can't confirm what the server holds now: no data, entry ${x}'s data (if the bot that took over finished this restore when it started), or data that process saved since. Nothing is lost: entries ${r} and ${x} are both in \`smdb graveyard list\`. To put the server's data back, run: smdb graveyard restore ${guildId} ${r} --replace; to restore entry ${x} instead: smdb graveyard restore ${guildId} ${x} --replace`,
  afterMove: (guildId: string, r: number, message: string, x: number | undefined) => `can't confirm whether server ${guildId} was restored: the restore stopped on an error in the bot (${message}) after the server's data was moved to graveyard entry ${r}; see the bot log. If \`smdb graveyard list\` lists entry ${r}, it holds the server's data from before. ${restoreTail(guildId, x)}`,
  latched: (why: string) => `this bot process stopped writing to its database (${why}); nothing was restored; try again once the bot runs on its main database`,
  held: (detail: string) => `this bot process is not writing to its database for now (${detail}); nothing was restored; try again in a moment`,
  late: (guildId: string, late: LateCommit, retiredAt: number | undefined, replaced?: ReplacedBatch) => {
    const x = retiredAt === undefined ? '<its retiredAt>' : String(retiredAt);
    return `${late.committed
      ? `can't confirm whether server ${guildId} was restored on the main database: ${late.old} confirmed the restore only after this process stopped writing there (${late.why}).`
      : `can't confirm whether server ${guildId} was restored: the database did not confirm the commit, and this process stopped writing to ${late.old} while it waited (${late.why}).`}${replaced
      ? ` If the restore landed on ${late.old}, the server's data from before is entry ${replaced.retiredAt} there.`
      : ''} Once the bot runs on the main database, run: smdb graveyard restore ${guildId} ${x} --replace. It is safe whether or not this restore reached that database: it copies entry ${x} in and moves whatever the server holds into a new entry, so nothing is lost; if that database lists no entry ${x}, the restore answers "no graveyard entry for this guild" and changes nothing.`;
  },
};

const RESTORE_MAIN = 'The list reads the data of the bot behind the web panel it asks; if the main database was replaced meanwhile, check once that bot runs on the new main.';

/** The end of every can't confirm text of a restore: entry X stays listed, and the replace of X is safe to run. */
function restoreTail(guildId: string, retiredAt: number | undefined): string {
  if (retiredAt === undefined) {
    return `The entry it restored, if any, stays listed either way, unless it had passed the graveyard's keep time (GRAVEYARD_TTL_DAYS, 14 days by default) and the graveyard sweep removed it, data and all. Running smdb graveyard restore ${guildId} <its retiredAt> --replace is then safe: it copies that entry in and moves whatever the server holds into a new entry, so nothing is lost.`;
  }
  return `Entry ${retiredAt} stays listed either way, unless it had passed the graveyard's keep time (GRAVEYARD_TTL_DAYS, 14 days by default) and the graveyard sweep removed it, data and all. Running smdb graveyard restore ${guildId} ${retiredAt} --replace is then safe: it copies entry ${retiredAt} in and moves whatever the server holds into a new entry, so nothing is lost.`;
}

/**
 * The end of the route's no-answer text and of the CLI's cut answer: x is the request's retiredAt, else n, the guild's
 * newest entry read before the send (undefined: none).
 */
export function restoreNoAnswerEnding(guildId: string, x: number | undefined, n: number | undefined, replace: boolean): string {
  if (!replace) return `The outcome is fixed within a minute. ${restoreTail(guildId, x)} ${RESTORE_MAIN}`;
  const which = x === undefined
    ? 'whose reason starts with replaced-by-restore- or is empty'
    : `${n === undefined ? '' : `newer than ${n} `}whose reason is replaced-by-restore-${x} or empty`;
  return `Within a minute the outcome is fixed (if the bot stopped mid-step, once it has started again). If \`smdb graveyard list\` then lists an entry for this server ${which}, the replace moved the server's data from before into that entry (an empty reason means its note could not be written). If not, either the server had no data or nothing changed. ${restoreTail(guildId, x)} ${RESTORE_MAIN}`;
}

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
  unknown: "can't confirm whether this server's data was deleted: the database did not confirm the commit. Within a minute, `smdb graveyard list` lists a new entry for this server with the reason webui-operator-delete if it was deleted; if no such entry is listed by then, it was not. The list reads the data of the bot behind the web panel it asks; if the main database was replaced meanwhile, check once that bot runs on the new main.",
  noClaim: 'this bot process holds no usable claim on the database; nothing was removed; restart the bot',
  unavailable: (detail: string) => `the database did not answer or ended the connection (${detail}); nothing was removed; try again in a moment`,
  failing: (file: string, code: string) => `a file of this server keeps failing to save (${file}: ${code}); nothing was removed; free disk space or fix the file's permissions, then try again`,
  latched: (why: string) => `this bot process stopped writing to its database (${why}); nothing was removed; try again once the bot runs on its main database`,
  held: (detail: string) => `this bot process is not writing to its database for now (${detail}); nothing was removed; try again in a moment`,
  late: (late: LateCommit) => `${late.committed
    ? `can't confirm whether this server's data was deleted on the main database: ${late.old} confirmed the delete only after this process stopped writing there (${late.why}).`
    : `can't confirm whether this server's data was deleted: the database did not confirm the commit, and this process stopped writing to ${late.old} while it waited (${late.why}).`} \`smdb graveyard list\` reads the data of the bot behind the web panel it asks: once that bot runs on the main database, look there for a new entry of this server with the reason webui-operator-delete, and repeat the delete if there is none.`,
};

/**
 * A restore's answer. ok: keptUntil is the date entry retiredAt stays listed until; copied, the rows a database copied
 * in; replaced, set only for a replace (null when the server had no data); replaced.reason only when it is stored.
 * refusal 'live-data' with retiredAt: a plain restore refused because the server has data.
 */
export type GraveyardReply =
  | { ok: true; retiredAt: number; reason: string; keptUntil: number; copied?: number; replaced?: { retiredAt: number; moved?: number; reason?: string } | null; moveUnconfirmed?: string }
  | { ok: false; code: 'invalid' | 'backend-unavailable' | 'not-owner' | 'frozen' | 'io-error'; error?: string; refusal?: 'live-data'; retiredAt?: number };

export type DeleteReply = { ok: true; moveUnconfirmed?: string } | { ok: false; code: 'invalid' | 'backend-unavailable' | 'not-owner' | 'io-error'; error: string };

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const unconfirmedReplies = new WeakSet<object>();

/** An answer about a change that may have landed, or landed in part: no later refusal text may replace it. */
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
  const epoch = pgBackend?.databaseEpoch?.() ?? 0;
  try {
    return postgres ? await retireRows(guildId, reason, flushMs, deadline, pgBackend!, epoch) : await retireFiles(guildId, reason, deadline);
  } finally {
    guildDataOps.delete(guildId);
  }
}

// NB5 G4: each retire's call by guild, kept past a moved epoch until the move's step (e) settles it.
const retiresOnWire = new Map<string, { epoch: number; answer: Promise<RetireOutcome> }>();

/** G4: the retires whose epoch differs from the one given, for step (e). */
export function retiresToSettle(epoch: number): Array<{ guildId: string; answer: Promise<RetireOutcome> }> {
  return [...retiresOnWire].filter(([, entry]) => entry.epoch !== epoch).map(([guildId, entry]) => ({ guildId, answer: entry.answer }));
}

/** Step (e) settled the guild's retire. */
export function settledRetire(guildId: string): void {
  retiresOnWire.delete(guildId);
}

async function retireRows(guildId: string, reason: string, flushMs: number, deadline: bigint, backend: DataBackend, epoch: number): Promise<DeleteReply> {
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
  let res: RetireOutcome | undefined;
  const answer = backend.retireGuild(guildId, reason, token, deadline);
  retiresOnWire.set(guildId, { epoch, answer });
  try {
    res = await answer;
  } finally {
    // An answer that arrived before the epoch moved: the set holds nothing unsaved and goes, unless the backend's own
    // state refused the retire. After the epoch moved the set stays, flagged, for step (e) (D4, G4).
    if ((backend.databaseEpoch?.() ?? 0) === epoch) {
      retiresOnWire.delete(guildId);
      if (!res || res.ok || (res.reason !== 'latched' && res.reason !== 'held')) ws?.evict(guildId);
    }
  }
  if (res.ok) {
    if (res.moved > 0) {
      console.log(`[DataManager] Guild ${guildId} moved to graveyard (${reason})`);
      return { ok: true };
    }
    return { ok: false, code: 'io-error', error: DELETE_TEXTS.failed };
  }
  if (res.reason === 'unknown' && res.late) {
    const text = DELETE_TEXTS.late(res.late);
    console.error(`[Data] Guild ${guildId}: ${text}`);
    return unconfirmed({ ok: false, code: 'backend-unavailable', error: text });
  }
  if (res.reason === 'unknown') {
    console.error(`[DataManager] Can't confirm whether guild ${guildId} was retired: the database did not confirm the commit`);
  } else {
    console.error(`[DataManager] Failed to retire guild ${guildId} (${res.reason})`);
  }
  switch (res.reason) {
    case 'unknown': return unconfirmed({ ok: false, code: 'backend-unavailable', error: DELETE_TEXTS.unknown });
    case 'no-claim': return { ok: false, code: 'backend-unavailable', error: DELETE_TEXTS.noClaim };
    case 'latched': return { ok: false, code: 'backend-unavailable', error: DELETE_TEXTS.latched(res.detail) };
    case 'held': return { ok: false, code: 'backend-unavailable', error: DELETE_TEXTS.held(res.detail) };
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
 * replace: the server's current data moves to a new graveyard entry in the same step, instead of refusing the restore.
 */
export async function restoreGuildFromGraveyard(guildId: string, retiredAt?: number, deadline: bigint = deadlineIn(OPERATION_BOUND_MS), replace = false): Promise<GraveyardReply> {
  refuseGuildChangeInMaintenance();
  if (closedForExit) throw new DataBackendUnavailableError('node-stopping', RESTORE_TEXTS.nodeStopping);
  const running = guildDataOps.get(guildId);
  if (running) return { ok: false, code: 'invalid', error: running === 'restore' ? RESTORE_TEXTS.alreadyRunning : RESTORE_TEXTS.deleteRunning };
  return servedByPostgres() ? restoreRows(guildId, retiredAt, deadline, replace) : restoreFiles(guildId, retiredAt, deadline, replace);
}

/** A plain restore refused because the server has data: the field the route and the panel decide on, and the text. */
function liveDataRefusal(guildId: string, retiredAt: number): GraveyardReply {
  return { ok: false, code: 'invalid', refusal: 'live-data', retiredAt, error: RESTORE_TEXTS.live(guildId, retiredAt) };
}

async function restoreRows(guildId: string, retiredAt: number | undefined, deadline: bigint, replace: boolean): Promise<GraveyardReply> {
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
      ws.noteRestoreSent(guildId);
      outcome = await backend.restoreGuild(guildId, retiredAt ?? null, fence, () => operationStop(deadline, COMMIT_FLOOR_MS), deadline, replace);
    }
  } catch (error) {
    failure = { error };
    if (called) console.error(`[DataManager] Can't confirm whether guild ${guildId} was restored: the restore stopped on an error once it was sent to the database:`, error);
    else console.error(`[Data] The restore of guild ${guildId} stopped on an error:`, error);
  }
  if (outcome && !outcome.ok && outcome.reason === 'unknown' && outcome.late) {
    console.error(`[Data] Guild ${guildId}: ${RESTORE_TEXTS.late(guildId, outcome.late, outcome.retiredAt ?? retiredAt, outcome.replaced)}`);
  } else if (outcome && !outcome.ok && outcome.reason === 'unknown') {
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
  if (outcome.ok) {
    return {
      ok: true, retiredAt: outcome.retiredAt, reason: outcome.reason, keptUntil: outcome.usedAt + graveyardTtlMs(), copied: outcome.copied,
      ...(outcome.replaced === undefined ? {} : { replaced: outcome.replaced }),
    };
  }
  switch (outcome.reason) {
    case 'deposed': return { ok: false, code: 'not-owner', error: RESTORE_TEXTS.deposed };
    case 'live-rows': return liveDataRefusal(guildId, outcome.retiredAt);
    case 'changed': return { ok: false, code: 'invalid', error: RESTORE_TEXTS.changed };
    case 'incomplete':
      console.error(`[DataManager] The restore of guild ${guildId} stopped at its ${outcome.step}: the database put ${outcome.put} of ${outcome.taken} row(s) in place; rolled back`);
      return { ok: false, code: 'backend-unavailable', error: RESTORE_TEXTS.incomplete(outcome.put, outcome.taken) };
    case 'no-entry': return { ok: false, code: 'invalid', error: RESTORE_TEXTS.noEntry };
    case 'schema-mismatch': return { ok: false, code: 'invalid', error: RESTORE_TEXTS.schemaMismatch };
    case 'refused': return { ok: false, code: 'backend-unavailable', error: RESTORE_TEXTS.refused(outcome.detail, outcome.code) };
    case 'no-claim': return { ok: false, code: 'backend-unavailable', error: RESTORE_TEXTS.noClaim };
    case 'not-provisioned': return { ok: false, code: 'backend-unavailable', error: RESTORE_TEXTS.notProvisioned };
    case 'latched': return { ok: false, code: 'backend-unavailable', error: RESTORE_TEXTS.latched(outcome.detail) };
    case 'held': return { ok: false, code: 'backend-unavailable', error: RESTORE_TEXTS.held(outcome.detail) };
    case 'unknown': {
      const x = outcome.retiredAt ?? retiredAt;
      return unconfirmed({ ok: false, code: 'backend-unavailable', error: outcome.late ? RESTORE_TEXTS.late(guildId, outcome.late, x, outcome.replaced) : RESTORE_TEXTS.unknown(guildId, x, outcome.replaced) });
    }
    case 'maintenance':
    case 'node-stopping':
    case 'out-of-time':
      return stopAnswer(outcome.reason, 'restore');
    default:
      throw new DataBackendUnavailableError('database-unreachable', RESTORE_TEXTS.unavailable(outcome.detail ?? 'no detail'));
  }
}

async function restoreFiles(guildId: string, retiredAt: number | undefined, deadline: bigint, replace: boolean): Promise<GraveyardReply> {
  guildDataOps.set(guildId, 'restore');
  const progress: { renamed: boolean; moved: { r: number; x: number } | null } = { renamed: false, moved: null };
  let outcome: FileRestoreOutcome | undefined;
  let failure: { error: unknown } | null = null;
  try {
    outcome = await restoreGuildDirFromGraveyard(guildId, retiredAt, {
      stop: (floorMs = 0) => operationStop(deadline, floorMs),
      writerLost: sharedWritesClosedLost,
      writerTaken: writerTakenNow,
      replace,
      enterSection: openRenameSection,
      progress,
    });
  } catch (error) {
    failure = { error };
    console.error(`[Data] The restore of guild ${guildId} stopped on an error:`, error);
  }
  // One synchronous run, whatever the exit: the barrier, the guild released, its events replayed in order.
  if (progress.renamed || progress.moved !== null) restoredAt.set(guildId, markBarrier().stamp);
  guildDataOps.delete(guildId);
  replayRestoreEvents(guildId);

  const reply = fileRestoreReply(guildId, outcome, failure, progress.moved);
  return !reply.ok && progress.moved !== null ? unconfirmed(reply) : reply;
}

function fileRestoreReply(guildId: string, outcome: FileRestoreOutcome | undefined, failure: { error: unknown } | null, moved: { r: number; x: number } | null): GraveyardReply {
  if (failure || !outcome) {
    const message = errorMessage(failure?.error);
    if (moved) return { ok: false, code: 'io-error', error: RESTORE_TEXTS.afterMove(guildId, moved.r, message, moved.x) };
    return { ok: false, code: 'io-error', error: RESTORE_TEXTS.error(message) };
  }
  if (outcome.ok) {
    return {
      ok: true, retiredAt: outcome.retiredAt, reason: outcome.reason, keptUntil: outcome.usedAt + graveyardTtlMs(),
      ...(outcome.replaced === undefined ? {} : { replaced: outcome.replaced }),
      ...(outcome.moveUnconfirmed === undefined ? {} : { moveUnconfirmed: outcome.moveUnconfirmed }),
    };
  }
  switch (outcome.why) {
    case 'no-entry': return { ok: false, code: 'invalid', error: RESTORE_TEXTS.noEntry };
    case 'live': return liveDataRefusal(guildId, outcome.retiredAt);
    case 'stopped': return stopAnswer(outcome.stop, 'restore');
    case 'writer-lost':
      recordRefusal('writer-lost', guildId);
      return { ok: false, code: 'invalid', error: WRITER_LOST_RESTORE_TEXT };
    case 'failing': return { ok: false, code: 'backend-unavailable', error: RESTORE_TEXTS.failing(outcome.file, outcome.code) };
    case 'unflushed': return { ok: false, code: 'backend-unavailable', error: RESTORE_TEXTS.flush };
    case 'stamp': return { ok: false, code: 'io-error', error: RESTORE_TEXTS.stamp(outcome.x, outcome.code) };
    case 'copy': return { ok: false, code: 'io-error', error: RESTORE_TEXTS.copy(outcome.x, outcome.code) };
    case 'copy-deadline': return { ok: false, code: 'backend-unavailable', error: RESTORE_TEXTS.copyDeadline(outcome.x, outcome.copied) };
    case 'copy-sync': return { ok: false, code: 'io-error', error: RESTORE_TEXTS.copySync(outcome.x, outcome.code, outcome.kind, outcome.dir) };
    case 'move': return { ok: false, code: 'io-error', error: RESTORE_TEXTS.move(outcome.code) };
    case 'put': return { ok: false, code: 'io-error', error: RESTORE_TEXTS.put(outcome.x, outcome.code) };
    case 'undone': {
      const clause = outcome.syncCode ? RESTORE_TEXTS.undoUnconfirmed(guildId, outcome.r, outcome.syncCode) : '';
      return { ok: false, code: 'io-error', error: RESTORE_TEXTS.undo(outcome.x, outcome.code) + clause };
    }
    case 'undone-taken': {
      const clause = outcome.syncCode ? RESTORE_TEXTS.undoUnconfirmed(guildId, outcome.r, outcome.syncCode) : '';
      return { ok: false, code: 'io-error', error: RESTORE_TEXTS.undoTaken(outcome.x, outcome.code) + clause };
    }
    case 'half': return { ok: false, code: 'io-error', error: RESTORE_TEXTS.half(guildId, outcome.x, outcome.r, outcome.code, outcome.undoCode) };
    case 'half-taken': return { ok: false, code: 'io-error', error: RESTORE_TEXTS.halfTaken(guildId, outcome.x, outcome.r, outcome.code) };
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

// ============================================================================
// HOOKS AFTER A SHARED KEY IS APPLIED (NB6 decision 9)
// ============================================================================

const sharedAppliedHooks = new Set<{ prefix: string; fn: (key: string) => void }>();

/**
 * Runs fn(key) each time this machine's applier writes or removes the mirror of a shared key starting with keyPrefix
 * from another version stored in the database (a cache drops what it loaded). Answers a function that removes it.
 */
export function onSharedApplied(keyPrefix: string, fn: (key: string) => void): () => void {
  const hook = { prefix: keyPrefix, fn };
  sharedAppliedHooks.add(hook);
  return () => { sharedAppliedHooks.delete(hook); };
}

/** The applier's call after a mirror change: each hook whose prefix the key starts with; a throw is logged. */
export function runSharedAppliedHooks(key: string): void {
  for (const hook of [...sharedAppliedHooks]) {
    if (!key.startsWith(hook.prefix)) continue;
    try {
      hook.fn(key);
    } catch (error) {
      console.error(`[Shared] A step run after ${key} was brought up to date failed:`, error);
    }
  }
}
