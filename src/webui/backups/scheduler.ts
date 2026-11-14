import * as fs from 'fs';
import * as path from 'path';
import { containerPath, diskError, noteReportedFolderSyncFailure, timeText, type DiskError } from '../../bot/internalSetup/utils/folderChain';
import { listSnapshots, pruneVerdict, restoreLeftovers, snapshotsRoot, type SnapshotEntry } from '../../bot/internalSetup/utils/backups/snapshotList';
import { deleteFolderName, formatSnapshotName, parseSnapshotName } from '../../bot/internalSetup/utils/backups/snapshotNames';
import { takeSnapshotLocal, type LocalTakeHost, type TakeKind } from '../../bot/internalSetup/utils/backups/snapshotTake';
import { migrationState, type RunningMigration } from '../../bot/internalSetup/utils/dataMigration';
import { clearAlerts, updateAlerts } from './alerts';
import { runDailyTest } from './dailyTest';
import { isJsonBot, recordReplacedData, restartSwitch } from './restore';
import { backupWorkRunning, restoreGate, setBackupWorkRunning } from './restoreState';
import {
  readSettings, readState, settingsUnreadableText, stateUnreadableText, stateWriteFailedLine, writeState,
  type BackupSettings, type BackupState,
} from './state';
import type { TakeViaAnswer } from '../botManager';

// NB8 decision 8 as decisions 19, 23, 33, 37, 47, 50, 57, 69, C14, C15 and C20 amend it: a 60 s single-flight tick in
// the web UI process. Each tick: step 8 of a placed restore; then, while the switch is on, the bot keeps JSON data and
// no data migration runs or is unfinished, the take when due, the prune after an attempt, the daily test when due and
// the alerts.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const TICK_MS = 60_000;
const TMP_LEFTOVER_MS = HOUR_MS;
const MAX_TRIES = 3;

export type SchedulerHost = LocalTakeHost & {
  takeSnapshotVia(req: { name: string; kind: TakeKind }): Promise<TakeViaAnswer>;
  migrationRunning(): RunningMigration | null;
};

export interface DueTake {
  name: string;
  kind: TakeKind;
  /** This try's number in its UTC hour (decision 23). */
  tries: number;
}

export interface DueTest {
  name: string;
  attempt: number;
  day: string;
}

export interface Due {
  take: DueTake | null;
  test: DueTest | null;
}

const isTaken = (s: SnapshotEntry): s is Extract<SnapshotEntry, { state: 'complete' }> =>
  s.state === 'complete' && (s.kind === 'hourly' || s.kind === 'daily') && s.time !== null;

/** The latest daily hour at or before now (UTC). */
export function latestDailyHour(now: number, hour: number): number {
  const d = new Date(now);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour);
  return today <= now ? today : today - DAY_MS;
}

function attemptTime(state: BackupState): number | null {
  const a = state.lastAttempt;
  if (!a) return null;
  return parseSnapshotName(a.name)?.time ?? (typeof a.at === 'number' ? a.at : null);
}

/**
 * Decisions 8, 9 and 23: what is due at `now`. A take when the current UTC hour has no complete hourly or daily backup
 * and no attempt, or its attempt failed because the data kept changing and fewer than 3 tries were made; a daily when
 * no complete daily is dated at or after the latest daily hour. The test when a test found running was cut short
 * (attempt + 1), or once per daily window after that window's daily is complete, of the newest complete backup.
 */
export function dueWork(now: number, list: readonly SnapshotEntry[], state: BackupState, settings: BackupSettings): Due {
  if (!settings.enabled) return { take: null, test: null };
  const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS;
  const inHour = (t: number) => t >= hourStart && t < hourStart + HOUR_MS;
  const taken = list.filter(isTaken);
  const windowStart = latestDailyHour(now, settings.hour);
  const dailyDone = taken.some(s => s.kind === 'daily' && (s.time as number) >= windowStart);

  let take: DueTake | null = null;
  if (!taken.some(s => inHour(s.time as number))) {
    const at = attemptTime(state);
    const a = state.lastAttempt;
    const tried = at !== null && inHour(at);
    const tries = tried && a ? (typeof a.tries === 'number' ? a.tries : 1) : 0;
    const retry = tried && a?.result === 'failed' && a.cause === 'writes' && tries < MAX_TRIES;
    if (!tried || retry) {
      const kind: TakeKind = dailyDone ? 'hourly' : 'daily';
      take = { name: formatSnapshotName(kind, now), kind, tries: retry ? tries + 1 : 1 };
    }
  }

  const day = new Date(windowStart).toISOString().slice(0, 10);
  let test: DueTest | null = null;
  const running = state.test?.running;
  if (running && typeof running.name === 'string') {
    test = { name: running.name, attempt: (typeof running.attempt === 'number' ? running.attempt : 1) + 1, day };
  } else if (dailyDone && state.test?.day !== day) {
    const newest = taken.reduce<SnapshotEntry | null>((n, s) => (!n || (s.time as number) >= (n.time as number) ? s : n), null);
    if (newest) test = { name: newest.name, attempt: 1, day };
  }
  return { take, test };
}

// ---------------------------------------------------------------------------------------------------------------
// state.json in memory
// ---------------------------------------------------------------------------------------------------------------

/** The state this process holds that state.json does not (a write that threw, or a file that cannot be read). */
let unsaved: BackupState | null = null;
/** Whether `unsaved` was built on a read that had a cause (the default state), not on a readable file. */
let unsavedFromCause = false;
type Overlay = 'lastAttempt' | 'lastRefusal' | 'watchingSince';
/** The fields this process changed while state.json could not be read; only these are laid over the file once it reads. */
const overlay = new Set<Overlay>();
let fileCause: string | null = null;

function changed(field: Overlay): void {
  if (fileCause !== null) overlay.add(field);
}

/** The tick's starting state: the file's, with only this process's changes laid over it when they were made on defaults. */
function startState(read: BackupState): BackupState {
  if (!unsaved) return read;
  if (fileCause !== null || !unsavedFromCause) return unsaved;
  const held = unsaved;
  const state: BackupState = {
    ...read,
    ...(overlay.has('lastAttempt') ? { lastAttempt: held.lastAttempt } : {}),
    ...(overlay.has('lastRefusal') ? { lastRefusal: held.lastRefusal } : {}),
    ...(overlay.has('watchingSince') ? { watchingSince: held.watchingSince } : {}),
  };
  if (state.watchingSince === null) state.watchingSince = held.watchingSince;
  return state;
}

/** Writes state.json; a write that throws is logged and the state kept in memory for the next tick (T5.d, D1.f, D3.f). */
function save(state: BackupState): boolean {
  if (fileCause !== null) {
    if (!unsaved) unsavedFromCause = true;
    unsaved = state;
    return false;
  }
  overlay.clear();
  unsavedFromCause = false;
  try {
    writeState(state);
    unsaved = null;
    return true;
  } catch (error) {
    console.error(stateWriteFailedLine(error));
    unsaved = state;
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The take
// ---------------------------------------------------------------------------------------------------------------

/** C20's refusal words while a disk error stands, with B6's restart switch. */
export function diskTakeWords(d: DiskError): string {
  const until = "so no backup is taken until the bot's container is restarted; check the disk first.";
  if (d.unreadable) {
    return restartSwitch(`no folder sync is trusted since ${containerPath(d.files[0] ?? d.dir)} records a disk error on this machine, and that record cannot be read, ${until}`);
  }
  if (d.files.length === 0 && d.at === null) {
    return restartSwitch(`no folder sync is trusted since ${containerPath(d.dir)} could not be read (${d.errno}) to look for a disk error record, ${until}`);
  }
  const at = d.at === null ? '' : ` at ${timeText(d.at)}`;
  return restartSwitch(`the data disk reported an error when ${containerPath(d.dir)} was synced${at} (${d.errno}), ${until}`);
}

function refusal(state: BackupState, words: string, startedAt?: number): void {
  state.lastRefusal = { at: Date.now(), words, ...(startedAt !== undefined ? { startedAt } : {}) };
  changed('lastRefusal');
  save(state);
}

const BUSY_WORDS = 'the bot was still taking the previous backup.';
const STOPPING_WORDS = 'the bot began stopping during the backup.';

/**
 * The take at the tick (decisions 19, 37, 57, C15, C20). One turn reads the migration, the disk error and the route,
 * sets `backupWorkRunning()` to `take` and sends `backup:take` or starts the local take. Answers whether an attempt was
 * made (an answer that names a result, or one that cannot be confirmed).
 */
async function takeStep(host: SchedulerHost, due: DueTake, state: BackupState): Promise<boolean> {
  justTaken = null;
  if (backupWorkRunning()) return false;
  if (migrationState(host.migrationRunning()).kind !== 'none') return false;
  const standing = diskError();
  if (standing) {
    refusal(state, diskTakeWords(standing));
    return false;
  }
  const probe = host.routeProbe('shared');
  if (probe.route !== 'child' && probe.route !== 'local') {
    refusal(state, probe.words);
    return false;
  }
  const req = { name: due.name, kind: due.kind };
  const startedAt = Date.now();
  setBackupWorkRunning('take');
  try {
    const answer: TakeViaAnswer = probe.route === 'child' ? await host.takeSnapshotVia(req) : await takeSnapshotLocal(req, host);
    const at = Date.now();
    if (answer.ok) {
      state.lastAttempt = { name: due.name, at, result: 'ok', tries: due.tries };
      justTaken = takenEntry(due, answer.counts);
    } else if ('unknown' in answer) {
      state.lastAttempt = { name: due.name, at, result: 'unknown', error: answer.error, tries: due.tries };
      console.warn(`[Backup] ${answer.error}`);
    } else if ('notSent' in answer) {
      const words = `the backup request could not be sent to the bot (${answer.error}).`;
      console.warn(`[Backup] No backup was started: ${words}`);
      refusal(state, words);
      return false;
    } else if ('error' in answer) {
      const error = answer.cause === 'writes'
        ? `${answer.error} It is tried again ${due.tries < MAX_TRIES ? 'in a minute' : 'at the next hour'}.`
        : answer.error;
      state.lastAttempt = { name: due.name, at, result: 'failed', error, ...(answer.cause ? { cause: answer.cause } : {}), tries: due.tries };
    } else if ('busy' in answer) {
      refusal(state, BUSY_WORDS);
      return false;
    } else if ('stopping' in answer) {
      refusal(state, STOPPING_WORDS, startedAt);
      return false;
    } else if ('lockLost' in answer) {
      refusal(state, answer.words, startedAt);
      return false;
    } else if ('refused' in answer) {
      refusal(state, answer.words, answer.startedAt);
      return false;
    } else if ('diskFlag' in answer) {
      const flag = answer.diskFlag;
      if (typeof flag.at === 'number') noteReportedFolderSyncFailure({ dir: flag.dir, errno: flag.errno, at: flag.at });
      refusal(state, diskTakeWords(flag));
      return false;
    } else {
      return false;
    }
    changed('lastAttempt');
    save(state);
    return true;
  } finally {
    setBackupWorkRunning(null);
  }
}

/** The backup this tick's take answered ok, for the alerts when the list read after it throws. */
let justTaken: SnapshotEntry | null = null;

/** A complete entry for a backup the take answered ok: its name, kind and the time its name carries. */
function takenEntry(due: DueTake, counts: Extract<SnapshotEntry, { state: 'complete' }>['manifest']['counts']): SnapshotEntry {
  const time = parseSnapshotName(due.name)?.time ?? Date.now();
  return {
    name: due.name, kind: due.kind, time, state: 'complete',
    manifest: { format: 1, name: due.name, kind: due.kind, takenAt: time, botVersion: '', counts, files: [], dirs: [] },
  };
}

/** Decision 19: an attempt the bot could not confirm, found complete by a later tick, is recorded as taken. */
function resolveUnknown(state: BackupState, list: readonly SnapshotEntry[]): void {
  const a = state.lastAttempt;
  if (!a || a.result !== 'unknown' || !list.some(s => s.name === a.name && s.state === 'complete')) return;
  const stopped = typeof a.error === 'string' && a.error.includes('the bot stopped before answering');
  state.lastAttempt = { name: a.name, at: a.at, result: 'ok', ...(typeof a.tries === 'number' ? { tries: a.tries } : {}) };
  changed('lastAttempt');
  save(state);
  if (stopped) console.log(`[Backup] Took ${a.name} (found complete after the bot stopped before answering)`);
}

// ---------------------------------------------------------------------------------------------------------------
// The prune
// ---------------------------------------------------------------------------------------------------------------

const errnoOf = (error: unknown): string => String((error as { code?: unknown } | null)?.code ?? 'EIO');
const gateClear = (): boolean => restoreGate().state === 'clear';

async function remove(folder: string): Promise<void> {
  await fs.promises.rm(path.join(snapshotsRoot(), folder), { recursive: true, force: true });
}

/**
 * Decisions 7, 26 and 69: removes the backups past their keep (each renamed to `.delete-<name>` first), the `.delete-*`
 * leftovers, `*.tmp` files older than an hour and `.restore-<t>` folders no restore uses. The restore gate is read in
 * the turn each rename or removal starts; any answer but `clear` stops the prune.
 */
export async function prune(now: number, list: readonly SnapshotEntry[], state: BackupState): Promise<void> {
  const gate = restoreGate();
  if (gate.state !== 'clear') return;
  const verdict = pruneVerdict(list, now, {
    lastPassed: state.test?.lastPassed ?? null,
    testing: state.test?.running?.name ?? null,
    restoring: gate.journal?.name ?? null,
  });
  if (verdict.ahead) {
    console.warn(`[Backup] Not deleting old backups: ${verdict.ahead.name} is dated ${verdict.ahead.minutes} minutes ahead of the clock`);
  }
  const root = snapshotsRoot();
  let names: string[];
  try {
    names = await fs.promises.readdir(root);
  } catch {
    names = [];
  }
  for (const name of verdict.remove) {
    if (!gateClear()) return;
    const aside = deleteFolderName(name);
    try {
      fs.renameSync(path.join(root, name), path.join(root, aside));
    } catch (error) {
      console.warn(`[Backup] Could not remove ${name} (${errnoOf(error)}); it is tried again at the next prune`);
      continue;
    }
    try {
      await remove(aside);
      console.log(`[Backup] Removed ${name} (past its keep)`);
    } catch (error) {
      console.warn(`[Backup] Could not remove ${aside} (${errnoOf(error)}); it is tried again at the next prune`);
    }
  }

  for (const name of names) {
    if (!name.startsWith('.delete-')) continue;
    if (!gateClear()) return;
    try {
      await remove(name);
    } catch (error) {
      console.warn(`[Backup] Could not remove ${name} (${errnoOf(error)}); it is tried again at the next prune`);
    }
  }
  for (const name of names) {
    if (!name.endsWith('.tmp')) continue;
    try {
      const st = await fs.promises.lstat(path.join(root, name));
      if (!st.isFile() || now - st.mtimeMs <= TMP_LEFTOVER_MS) continue;
      if (!gateClear()) return;
      await fs.promises.unlink(path.join(root, name));
    } catch (error) {
      console.warn(`[Backup] Could not remove ${name} (${errnoOf(error)}); it is tried again at the next prune`);
    }
  }
  const latest = restoreGate();
  if (latest.state !== 'clear') return;
  const leftover = latest.stage === 'failed' ? (latest.journal?.leftover as { path?: unknown } | undefined)?.path : undefined;
  const keep = typeof leftover === 'string' ? path.posix.basename(leftover) : null;
  for (const name of restoreLeftovers(names, now, keep)) {
    if (!gateClear()) return;
    try {
      await remove(name);
      console.log(`[Backup] Removed ${name}, a restore's copy that no restore uses (made more than an hour ago)`);
    } catch (error) {
      console.warn(`[Backup] Could not remove ${name} (${errnoOf(error)}); it is tried again at the next prune`);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------------------------------------------

let ticking = false;
let watching: boolean | null = null;
let notes: string[] = [];
let timer: NodeJS.Timeout | null = null;
/** This process's last good read of the backup list, for the alerts while the folder cannot be read. */
let lastList: SnapshotEntry[] = [];
/** The phase and errno of the last list read that threw, so each is logged once until a read succeeds. */
let listFailure: string | null = null;

/**
 * The backup list, or null when _snapshots cannot be read (not ENOENT). Before the take the read error is the refusal
 * and "No backup was started"; after it, only the list line. Each is logged once per errno.
 */
async function readList(state: BackupState, beforeTake: boolean): Promise<SnapshotEntry[] | null> {
  try {
    lastList = await listSnapshots();
    listFailure = null;
    return lastList;
  } catch (error) {
    const errno = errnoOf(error);
    const words = `the backup folder (${containerPath(snapshotsRoot())}) could not be read (${errno}).`;
    const failure = `${beforeTake ? 'before' : 'after'}:${errno}`;
    if (failure !== listFailure) {
      console.warn(beforeTake
        ? `[Backup] No backup was started: ${words}`
        : `[Backup] The backup list could not be read (${errno}); the prune and the test wait for the next tick.`);
    }
    listFailure = failure;
    if (beforeTake) refusal(state, words);
    return null;
  }
}

/** Logs the can't-read notes when they change. */
function noteCauses(settingsCause: string | null, stateCause: string | null): void {
  const next = [
    ...(settingsCause !== null ? [settingsUnreadableText(settingsCause)] : []),
    ...(stateCause !== null ? [stateUnreadableText(stateCause)] : []),
  ];
  if (next.join('\n') !== notes.join('\n')) for (const note of next) console.warn(`[Backup] ${note}`);
  notes = next;
}

async function tickBody(host: SchedulerHost): Promise<void> {
  try {
    await recordReplacedData();
  } catch (error) {
    console.error('[Backup] Recording the replaced data of the last restore failed:', error);
  }

  const { settings, cause: settingsCause } = readSettings();
  const read = readState();
  noteCauses(settingsCause, read.cause);
  fileCause = read.cause;
  const state = startState(read.state);
  if (unsaved) save(state);

  const json = isJsonBot();
  const watch = settings.enabled && json;
  if (!watch) {
    watching = false;
    if (!json) clearAlerts(state, fileCause);
    return;
  }
  if (state.watchingSince === null || watching === false) {
    state.watchingSince = Date.now();
    if (watching === false) changed('watchingSince');
    save(state);
  }
  watching = true;
  if (migrationState(host.migrationRunning()).kind !== 'none') return;

  const snapshots = await backupWork(host, state, settings, settingsCause === null && read.cause === null);
  await updateAlerts({ now: Date.now(), state, snapshots, fileCause });
}

/**
 * The take, the prune and the daily test of one tick; a list read that throws ends them (code review 3, B2). Answers
 * the list for the alerts: the last good read, with the backup just taken when the read after the take threw.
 */
async function backupWork(host: SchedulerHost, state: BackupState, settings: BackupSettings, mayPrune: boolean): Promise<SnapshotEntry[]> {
  let list = await readList(state, true);
  if (!list) return lastList;
  resolveUnknown(state, list);
  const due = dueWork(Date.now(), list, state, settings);
  if (due.take) {
    const attempted = await takeStep(host, due.take, state);
    list = await readList(state, false);
    if (!list) {
      const taken = justTaken;
      return taken && !lastList.some(s => s.name === taken.name) ? [...lastList, taken] : lastList;
    }
    if (attempted && mayPrune) {
      await prune(Date.now(), list, state);
      list = await readList(state, false);
      if (!list) return lastList;
    }
  }
  const test = dueWork(Date.now(), list, state, settings).test;
  if (test && restoreGate().state === 'clear') {
    await runDailyTest(test, state, save);
    await readList(state, false);
  }
  return lastList;
}

/** One tick; a tick that finds the previous one still running does nothing. */
export async function runTick(host: SchedulerHost): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await tickBody(host);
  } catch (error) {
    console.error('[Backup] The backup check failed:', error);
  } finally {
    ticking = false;
  }
}

/** Starts the 60 s tick (decision 57: right after startWebUI, before main() awaits recovery). */
export function startScheduler(host: SchedulerHost): void {
  if (timer) return;
  timer = setInterval(() => { void runTick(host); }, TICK_MS);
  timer.unref?.();
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Tests only. */
export function _resetSchedulerForTests(): void {
  stopScheduler();
  ticking = false;
  watching = null;
  notes = [];
  lastList = [];
  listFailure = null;
  justTaken = null;
  unsaved = null;
  unsavedFromCause = false;
  overlay.clear();
  fileCause = null;
}
