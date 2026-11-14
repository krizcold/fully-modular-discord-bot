// The data files' writer lock: the process /data/.writer.lock names is the only one that writes the shared files (the
// root config, the global data files, a JSON bot's guild files). The bot process holds it for its life, the web UI
// while its local chain runs, a bundle import while it imports.

import * as fs from 'fs';
import { dataPath } from '../../../utils/dataRoot';
import { ProcessLock, parseHolder, realSeams, type LockHolder, type LockSeams, type Staleness, type TakeResult } from './processLock';
import { answerEndedTries, cancelQueued, queuedFilePaths, queuedFileWrites, fileFlushOnTheWire, pathOnTheWire, type CancelOutcome } from './dataBackends/fileBackend';
import { closeSharedWritesLost, forgetSharedFileKnowledge, isSharedPath, reopenSharedWrites, useDeposedWrites, useWriterLockCheck } from './dataManager';
import { deposeRows, reopenRows } from './sharedStore';
import { stopCrashWrites } from './moduleCrashes';
import { syncWords, type SyncKind } from './folderChain';

export type WriterRole = 'bot' | 'webui' | 'import';

export const WRITER_CHECK_MS = 5_000;
const UNPARSABLE_STALE_MS = 10_000;
const TAKEOVER_STALE_MS = 5_000;

export function writerLockPath(): string {
  return dataPath('.writer.lock');
}

let role: WriterRole = process.env.BOT_PROCESS_ROLE === 'bot' ? 'bot' : 'webui';
let seams: LockSeams = realSeams;
let lock: ProcessLock | null = null;
let checkTimer: NodeJS.Timeout | null = null;
let readErrorLogged: string | null = null;
let releaseRetry: { timer: NodeJS.Timeout; text: string; logged: string } | null = null;
let deposedBy: LockHolder | null = null;
let recreates = 0;
const deposedListeners: Array<(holder: LockHolder) => void> = [];
// The paths a deposition cancelled and has not named yet, each with the words of the process that took the lock.
const unnamedLost = new Map<string, string>();
const pendingAnswers = new Set<Promise<void>>();

const deposedWrites = {
  answered: () => Promise.allSettled([...pendingAnswers]).then(() => undefined),
  nameLeft: () => {
    try {
      answerEndedTries();
    } catch (error) {
      console.error('[Data] Could not read the answers of the writes a deposition cancelled:', error);
    }
    for (const [p, words] of unnamedLost) {
      console.error(pathOnTheWire(p)
        ? `[Data] Can't confirm whether ${p} is saved: its write was still running when another process (${words}) took the data files' lock, and this process exits before it ends`
        : `[Data] Can't confirm whether ${p} is saved: another process (${words}) took the data files' lock, and this process exits before it knows how the write ended`);
    }
    unnamedLost.clear();
  },
};

function theLock(): ProcessLock {
  if (!lock) {
    lock = new ProcessLock({
      lockPath: writerLockPath(),
      takeoverPath: `${writerLockPath()}.takeover`,
      unparsableStaleMs: UNPARSABLE_STALE_MS,
      takeoverStaleMs: TAKEOVER_STALE_MS,
      extra: () => ({ role }),
      seams,
    });
  }
  return lock;
}

/** Sets this process's role (and, for tests, the process facts); before the first take. */
export function configureWriterLock(nextRole: WriterRole, nextSeams?: LockSeams): void {
  role = nextRole;
  if (nextSeams) seams = nextSeams;
  if (lock && lock.depth > 0) throw new Error('[Data] The writer lock is configured while it is held');
  lock = null;
}

export function writerRole(): WriterRole {
  return role;
}

/** The words a log or a refusal names a holder by. */
export function holderWords(holder: { role?: string } | null): string {
  switch (holder?.role) {
    case 'webui':
      return 'the web UI';
    case 'import':
      return 'a data bundle import';
    case 'bot':
      return 'a bot process';
    default:
      return 'another process';
  }
}

/** The deposed answer, named by the holder the lock check read. */
export function deposedText(holder: { role?: string; pid: number }): string {
  return `Another process took the data files (${holderWords(holder)}, pid ${holder.pid}); nothing was saved. Stop that process or wait until it ends, then try again.`;
}

export function writerLockDepth(): number {
  return lock?.depth ?? 0;
}

/** The exact text this process wrote at its take, while it holds the lock; null otherwise. */
export function heldText(): string | null {
  return lock?.heldText ?? null;
}

/** The logged re-creates of an absent lock file since this process started. */
export function recreateCount(): number {
  return recreates;
}

/** The lock file's text as it stands; throws as the read does. */
export function readLockText(): string {
  return fs.readFileSync(writerLockPath(), 'utf-8');
}

/** The lock file read as a taker reads it (absent, stale, held or unreadable), with no take, create or write. */
export function probeWriterLock(): Staleness {
  return theLock().staleness();
}

/** The holder another process deposed this one with, once it happened. */
export function deposedHolder(): LockHolder | null {
  return deposedBy;
}

/** A cancelled path whose lines may be in the file (NB13 C9, D3), in the words of the deposition and the web UI logs. */
export function unconfirmedWords(result: { path: string; errno: string | null; cut: boolean; what?: 'lines' | 'whole'; kind?: SyncKind; dir?: string }): string {
  if (result.kind) {
    const done = result.what === 'whole' ? 'the file is in place whole' : 'its lines are in the file and synced';
    return `[Data] Can't confirm whether ${result.path} is saved (${result.errno ?? 'no error code'}): ${done}, but ${syncWords(result.kind, result.dir!, result.errno ?? 'no error code').why}`;
  }
  const what = result.cut
    ? 'a write of its lines was cut short, so some of them may be in the file, whole or in part, and the disk did not confirm them'
    : 'some of its lines are in the file, but the disk did not confirm them';
  return `[Data] Can't confirm whether ${result.path} is saved (${result.errno ?? 'no error code'}): ${what}`;
}

/** Runs at a deposition, after the shared gate closed and the queue was cancelled. */
export function onDeposed(fn: (holder: LockHolder) => void): void {
  deposedListeners.push(fn);
}

/** Takes the writer lock; a take from depth 0 forgets what this process knew of the shared files and starts the check. */
export function takeWriterLock(): TakeResult {
  const l = theLock();
  const fresh = l.depth === 0;
  const taken = l.tryTake();
  if (taken.kind === 'taken' && fresh) {
    stopReleaseRetry();
    deposedBy = null;
    readErrorLogged = null;
    reopenSharedWrites();
    reopenRows();
    useWriterLockCheck(() => checkWriterLock().kind === 'deposed');
    forgetSharedFileKnowledge();
    startCheck();
  }
  return taken;
}

export function releaseWriterLock(): void {
  const l = lock;
  if (!l || l.depth === 0) return;
  const text = l.heldText;
  const failed = l.release();
  if (l.depth > 0) return;
  stopCheck();
  if (failed !== null && text !== null) startReleaseRetry(l, text, failed);
}

/** A release whose read or unlink failed leaves a file naming this process: tried again every 5 s until it is gone. */
function startReleaseRetry(l: ProcessLock, text: string, errno: string): void {
  stopReleaseRetry();
  console.error(`[Data] Could not remove ${writerLockPath()} (${errno}); it still names this process, so no other process can take the data files. Trying again in 5 s`);
  const timer = setInterval(() => {
    const retry = releaseRetry;
    if (!retry || l !== lock || l.depth > 0) {
      stopReleaseRetry();
      return;
    }
    const again = l.unlinkIfText(retry.text);
    if (again === null) {
      console.log(`[Data] Removed ${writerLockPath()} on a later try`);
      stopReleaseRetry();
    } else if (again !== retry.logged) {
      retry.logged = again;
      console.error(`[Data] Could not remove ${writerLockPath()} (${again}); trying again in 5 s`);
    }
  }, WRITER_CHECK_MS);
  timer.unref();
  releaseRetry = { timer, text, logged: errno };
}

function stopReleaseRetry(): void {
  if (releaseRetry) clearInterval(releaseRetry.timer);
  releaseRetry = null;
}

/** The exit handler's release: only when nothing is queued and no flush is on the wire; otherwise the file stays for takeover. */
export function releaseWriterLockAtExit(): void {
  const l = lock;
  if (!l || l.depth === 0) return;
  if (queuedFileWrites() !== 0 || fileFlushOnTheWire()) return;
  let failed: string | null = null;
  while (l.depth > 0) failed = l.release();
  stopCheck();
  stopReleaseRetry();
  if (failed !== null) console.error(`[Data] Could not remove ${writerLockPath()} at exit (${failed}); the next process takes it over once this one has ended`);
}

export type HolderRead =
  | { kind: 'free' }
  | { kind: 'held'; holder: LockHolder }
  | { kind: 'unparsable' }
  | { kind: 'unreadable'; errno: string };

/** The lock file's holder as it stands, without taking it. */
export function readWriterHolder(): HolderRead {
  let raw: string;
  try {
    raw = fs.readFileSync(writerLockPath(), 'utf-8');
  } catch (error: any) {
    return error?.code === 'ENOENT' ? { kind: 'free' } : { kind: 'unreadable', errno: String(error?.code ?? 'EIO') };
  }
  const holder = parseHolder(raw);
  return holder ? { kind: 'held', holder } : { kind: 'unparsable' };
}

export type CheckResult = { kind: 'held' } | { kind: 'deposed'; holder: LockHolder } | { kind: 'not-held' };

/** The holder's check against the text it wrote: every 5 s while held and before each shared op. */
export function checkWriterLock(): CheckResult {
  const l = lock;
  const written = l?.heldText ?? null;
  if (!l || written === null) return deposedBy ? { kind: 'deposed', holder: deposedBy } : { kind: 'not-held' };
  const path = writerLockPath();
  let raw: string | null = null;
  // A re-create that finds the file again (EEXIST) means another process just created it: read it and compare.
  for (let attempt = 0; raw === null; attempt++) {
    try {
      raw = fs.readFileSync(path, 'utf-8');
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        try {
          const fd = fs.openSync(path, 'wx');
          try { fs.writeSync(fd, written); } finally { fs.closeSync(fd); }
          recreates += 1;
          console.error(`[Data] ${path} was removed while this process held it; re-created it. Never delete it while a bot, web UI or import of this data runs.`);
          return { kind: 'held' };
        } catch (createError: any) {
          if (createError?.code === 'EEXIST' && attempt === 0) continue;
          console.error(`[Data] ${path} was removed while this process held it and could not be re-created (${createError?.code ?? 'EIO'}); checking again in 5 s`);
          return { kind: 'held' };
        }
      }
      const errno = String(error?.code ?? 'EIO');
      if (readErrorLogged !== errno) {
        readErrorLogged = errno;
        console.error(`[Data] Cannot read ${path} (${errno}); this process keeps writing and checks again in 5 s`);
      }
      return { kind: 'held' };
    }
  }
  readErrorLogged = null;
  if (raw === written) return { kind: 'held' };
  const mine = parseHolder(written);
  const other = parseHolder(raw);
  if (!other || (mine && other.pid === mine.pid && other.start === mine.start)) {
    console.error(`[Data] ${path} holds text this process did not write; it keeps writing and checks again in 5 s`);
    return { kind: 'held' };
  }
  depose(other);
  return { kind: 'deposed', holder: other };
}

/** Another process took the lock: close every shared write, drop the queued ones, and tell the role's listeners. */
function depose(holder: LockHolder): void {
  if (deposedBy) return;
  deposedBy = holder;
  closeSharedWritesLost();
  const words = `${holderWords(holder)}, pid ${holder.pid}`;
  deposeRows(words);
  if (role === 'bot') stopCrashWrites();
  lock?.drop();
  stopCheck();
  console.error(`[Data] Another process (${words}) took the data files' lock; this process writes no data file from now on`);
  const paths = queuedFilePaths().filter(isSharedPath);
  for (const p of paths) unnamedLost.set(p, words);
  const name = (result: CancelOutcome): void => {
    if (!unnamedLost.delete(result.path)) return;
    if (result.outcome === 'cancelled') console.error(`[Data] Not saved: ${result.path}; another process (${words}) took the data files' lock`);
    if (result.outcome === 'unconfirmed') console.error(`${unconfirmedWords(result)}; another process (${words}) took the data files' lock`);
  };
  const answers: Promise<void> = cancelQueued(paths, undefined, { freeze: true, onAnswer: name })
    .then(results => { for (const result of results) name(result); })
    .finally(() => { pendingAnswers.delete(answers); });
  pendingAnswers.add(answers);
  useDeposedWrites(deposedWrites);
  for (const listener of deposedListeners) {
    try {
      listener(holder);
    } catch (error) {
      console.error('[Data] A step after the data files were taken failed:', error);
    }
  }
}

export type WriterStage = 'waiting' | 'opening' | 'shared' | 'guild' | 'deposed';

/** The bot process's report of where it stands, sent to the web UI that forked it (none in a `dev:bot` run). */
export function reportWriterStage(stage: WriterStage, extra: { holder?: { role: string | null; pid: number } | null; cause?: string; readCause?: string } = {}): void {
  try {
    process.send?.({ type: 'data:writer', data: { stage, ...extra } });
  } catch (error) {
    console.error('[Data] Could not tell the web UI where the bot stands:', error);
  }
}

const WAIT_LOG_MS = 30_000;
const POLL_MS = 100;
const UNWRITABLE_RETRY_MS = 1_000;

/**
 * The bot process's take at its start: it polls with no deadline while another process holds the lock, sending a
 * `waiting` report when the holder changes and logging at once and every 30 s.
 */
export async function takeWriterLockForBoot(sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)), now: () => number = Date.now): Promise<void> {
  let lastKey: string | null = null;
  let lastLog = -Infinity;
  const path = writerLockPath();
  for (;;) {
    const taken = takeWriterLock();
    if (taken.kind === 'taken') {
      if (lastKey !== null) {
        reportWriterStage('opening');
        console.log('[Data] The data files were released; the bot holds them now and opens them');
      }
      return;
    }
    let key: string;
    let line: string;
    let retryMs = POLL_MS;
    let report: { holder?: { role: string | null; pid: number } | null; cause?: string; readCause?: string };
    if (taken.kind === 'unwritable' || taken.kind === 'unreadable') {
      key = `${taken.kind}:${taken.errno}`;
      report = taken.kind === 'unwritable' ? { cause: taken.errno } : { readCause: taken.errno };
      line = taken.kind === 'unwritable'
        ? `[Data] Cannot create ${path} (${taken.errno}); the bot waits until /data takes writes`
        : `[Data] Cannot read ${path} (${taken.errno}); the bot waits until it can tell which process holds the data files`;
      retryMs = UNWRITABLE_RETRY_MS;
    } else if (taken.kind === 'held' && taken.holder) {
      key = `holder:${taken.holder.pid}:${taken.holder.role ?? ''}`;
      report = { holder: { role: taken.holder.role ?? null, pid: taken.holder.pid } };
      line = `[Data] Waiting for ${holderWords(taken.holder)} (pid ${taken.holder.pid}) to release the data files before the bot opens them`;
    } else {
      key = 'holder:unknown';
      report = { holder: null };
      line = '[Data] Waiting for another process that is taking the data files at this moment to release them before the bot opens them';
    }
    if (key !== lastKey) {
      lastKey = key;
      reportWriterStage('waiting', report);
      console.warn(line);
      lastLog = now();
    } else if (now() - lastLog >= WAIT_LOG_MS) {
      console.warn(line);
      lastLog = now();
    }
    await sleep(retryMs);
  }
}

function startCheck(): void {
  stopCheck();
  checkTimer = setInterval(() => { checkWriterLock(); }, WRITER_CHECK_MS);
  checkTimer.unref();
}

function stopCheck(): void {
  if (checkTimer) clearInterval(checkTimer);
  checkTimer = null;
}
