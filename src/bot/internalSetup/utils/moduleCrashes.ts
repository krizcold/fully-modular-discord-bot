// The starts of module versions and the bot's own crash count (NB6 decisions 66, 89, 99 to 101, 105, 107, 109, 112 and
// 114): a version whose code stopped the bot twice while it started is held back by the boot rule.

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dataPath } from '../../../utils/dataRoot';
import { atomicWriteFileSync } from './atomicWrite';
import { FolderSyncError, logFolderSyncError } from './folderChain';
import { recordLoadFailure } from './loadFailures';
import { readStoreRecord, writeStoreRecord } from './sharedRecords';

/** One start of one module version: opened before its code runs, ended once. Compared by identity. */
export interface ModuleStart {
  module: string;
  /** The store entry's version (its `applying.to` while an apply runs); null for a module with no entry, never counted. */
  sha: string | null;
  version: string;
  /** The folder the version's files are imported from. */
  dir: string;
  boot: boolean;
  turnAt: number | null;
  late: boolean;
}

export type StartResult = 'ok' | 'bound' | 'replaced' | { rejected: unknown } | { failed: unknown };

export type StartAnswer = ModuleStart | 'held' | 'starting';

export interface CrashLine {
  sha: string;
  n: number;
  version: string;
  error: string;
  at: string;
}

type CrashLines = Record<string, CrashLine>;

/** The open start of each module. */
export const openStarts = new Map<string, ModuleStart>();
/** The starts whose window is open: their code runs now. */
export const starting = new Set<ModuleStart>();
/** A start the boot loop handed to its module's initializer turn. */
const bootStarts = new Map<string, ModuleStart>();
/** A module whose start ended while the disk refused its crash line's delete, with that start's sha. */
export const keptEnds = new Map<string, string>();
/** 'running' while a start's end runs its functions; 'failed' once one threw with the module's `applying` still set. */
export const startEnds = new Map<string, 'running' | 'failed'>();
/** The error a module's latest start ended with, `{ rejected }` or `{ failed }`. */
const startFailures = new Map<string, string>();
const failuresByStart = new WeakMap<ModuleStart, string>();
/** Modules the boot leaves unloaded after a throw in one of its steps for them (102's rule). */
const leftOut = new Set<string>();

const endListeners: Array<(start: ModuleStart, result: StartResult) => void | Promise<void>> = [];
let retryArmed = false;
let crashWritesStopped = false;

const COUNT_FAILED = '[Error] The module crash count could not be written';
const MESSAGE_LIMIT = 300;
/** A turn's wait for its initializers before it passes (decision 67), and the late task's bound (78). */
export const INITIALIZER_WAIT_MS = 60_000;
export const INITIALIZER_LATE_MS = 10 * 60_000;

export function crashFilePath(): string {
  return dataPath('global', 'appstore', 'cache', 'module-crashes.json');
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function logCountFailed(error: unknown): void {
  console.error(`${COUNT_FAILED} (${messageOf(error)})`);
}

/** Absent or not parseable reads as no lines; any other read error throws. */
function readCrashLines(): CrashLines {
  let text: string;
  try {
    text = fs.readFileSync(crashFilePath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return {};
    throw error;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The one write of the crash file; after a deposition it writes nothing and answers false. True when the bytes are in place. */
function writeCrashLines(lines: CrashLines): boolean {
  if (crashWritesStopped) {
    console.error(`${COUNT_FAILED} (another process took the data files)`);
    return false;
  }
  try {
    atomicWriteFileSync(crashFilePath(), JSON.stringify(lines, null, 2));
  } catch (error) {
    if (!(error instanceof FolderSyncError)) throw error;
    logFolderSyncError('[Error] The module crash count', error);
  }
  return true;
}

/** Another process took the data files: this process writes the crash file no more. */
export function stopCrashWrites(): void {
  crashWritesStopped = true;
}

/** The sha a start of the module counts against: the store entry's `applying.to` while set, else its `sha`. */
export function startShaOf(module: string): string | null {
  const read = readStoreRecord();
  if (!read.ok) return null;
  const entry = read.record.modules[module];
  if (!entry) return null;
  return entry.applying ? entry.applying.to : entry.sha;
}

/** Decision 80: held in place means the entry's `heldSha` is that sha and no apply is under way. */
export function isHeld(module: string, sha: string): boolean {
  const read = readStoreRecord();
  if (!read.ok) return false;
  const entry = read.record.modules[module];
  return !!entry && entry.heldSha === sha && !entry.applying;
}

/** The module's crash line; null when it has none or the file cannot be read. */
export function crashLineOf(module: string): CrashLine | null {
  try {
    return readCrashLines()[module] ?? null;
  } catch (error) {
    logCountFailed(error);
    return null;
  }
}

/**
 * Decision 66's boot rule as 80 amends it, run under the store lock in the block of the boot recoveries: a version in
 * place whose line reached 2 is held there (`heldSha`) with a 'failed' status, in one record write. T1's in-place form.
 */
export function applyBootRule(): void {
  let lines: CrashLines;
  try {
    lines = readCrashLines();
  } catch (error) {
    logCountFailed(error);
    return;
  }
  const read = readStoreRecord();
  if (!read.ok) return;
  const record = read.record;
  const held: Array<[string, CrashLine]> = [];
  for (const [module, line] of Object.entries(lines)) {
    const entry = record.modules[module];
    if (!line || line.n < 2 || !entry || entry.sha !== line.sha || entry.heldSha === line.sha) continue;
    const seq = (record.statusSeq ?? 0) + 1;
    record.statusSeq = seq;
    const error = `the bot stopped twice while it was starting it (${line.error})`;
    record.modules[module] = { ...entry, heldSha: line.sha, status: { state: 'failed', sha: line.sha, error, at: new Date().toISOString(), seq } };
    held.push([module, line]);
  }
  if (held.length === 0) return;
  try {
    writeStoreRecord(record);
  } catch (error) {
    for (const [module] of held) {
      leaveOutAtBoot(module);
      startEndFailed({ module }, error);
    }
    return;
  }
  for (const [module, line] of held) {
    console.error(`[Shared] The bot stopped twice while it was starting ${module} ${line.version} on this machine (the error at the second stop: ${line.error}); this machine does not load ${module} until it is updated, or uninstalled and installed again`);
  }
}

/**
 * Decision 80's 49 step 7: a line whose sha is none of `keep(module)` (the row's sha, the entry's sha and its
 * `applying.to`) is deleted, in one write when any goes. After a deposition nothing is written (114).
 */
export function pruneCrashLines(keep: (module: string) => Array<string | null | undefined>): void {
  try {
    const lines = readCrashLines();
    let gone = false;
    for (const [module, line] of Object.entries(lines)) {
      if (keep(module).includes(line?.sha)) continue;
      delete lines[module];
      gone = true;
    }
    if (gone) writeCrashLines(lines);
  } catch (error) {
    logCountFailed(error);
  }
}

export type StartState = 'a' | 'c' | 'd' | 'e' | 'f';

/** An apply's start: its module's entry has `applying` whose `to` is the start's sha (decision 99). */
export function applyOfStart(start: ModuleStart): { from: string; to: string; version: string | null } | null {
  if (start.sha === null) return null;
  const read = readStoreRecord();
  const applying = read.ok ? read.record.modules[start.module]?.applying : null;
  return applying && applying.to === start.sha ? { from: applying.from, to: applying.to, version: applying.version } : null;
}

/** The apply tails of T27 and T29 for an apply's start (decision 98's T27, 89's T29). */
export function applyTails(start: ModuleStart): { t27: string; t29: string } {
  const apply = applyOfStart(start);
  if (!apply) return { t27: '', t29: '' };
  const version = apply.version ?? start.version;
  const kept = apply.from === 'absent' ? `no copy of ${start.module}` : 'the previous version';
  return {
    t27: `; this machine finishes applying ${version} when they finish without an error, or at 10 minutes; an error makes it keep ${kept}`,
    t29: ` and keeps ${version}`,
  };
}

/**
 * The state of a module's start for T18 and T31 (decision 109): (a) its turn began; (c) a boot start before its turn;
 * (d) a start of a running bot before its turn; (e) no open start with a sha, the entry's `applying` set outside an
 * apply's run, and its end failed; (f) the same while its end runs. Null: nothing defers the module.
 */
export function startStateOf(module: string): StartState | null {
  const open = openStarts.get(module);
  if (open && open.sha !== null) return open.turnAt !== null ? 'a' : open.boot ? 'c' : 'd';
  if (!applyingSet(module)) return null;
  return startEnds.get(module) === 'failed' ? 'e' : 'f';
}

/** Opens a start of a module version before any of its code runs and before any copy of it is unloaded. */
export function startModule(module: string, sha: string | null, version: string, dir: string, opts?: { boot: true }): StartAnswer {
  if (sha !== null && isHeld(module, sha)) return 'held';
  const open = openStarts.get(module);
  if (open && open.sha !== null) return 'starting';
  if (open) void endStart(open, 'replaced');
  const start: ModuleStart = { module, sha, version, dir, boot: opts?.boot === true, turnAt: null, late: false };
  openStarts.set(module, start);
  startFailures.delete(module);
  return start;
}

/** The error a start ended with (a module name: its latest start); undefined while it is open or when it ended otherwise. */
export function startFailureOf(of: string | ModuleStart): string | undefined {
  return typeof of === 'string' ? startFailures.get(of) : failuresByStart.get(of);
}

export function leaveOutAtBoot(module: string): void {
  leftOut.add(module);
}

/**
 * ModuleLoader's boot loop, before a module's load: its start, or 'skip' when the module may not load now (held, a
 * start's end that failed with `applying` still set, or left out by a boot step that threw).
 */
export function onModuleCode(m: { name: string; path: string; version: string }): ModuleStart | 'skip' {
  if (startEnds.get(m.name) === 'failed' || leftOut.has(m.name)) {
    recordLoadFailure(m.name);
    return 'skip';
  }
  const answer = startModule(m.name, startShaOf(m.name), m.version, m.path, { boot: true });
  return typeof answer === 'string' ? 'skip' : answer;
}

export function openWindow(start: ModuleStart): void {
  starting.add(start);
}

export function closeWindow(start: ModuleStart): void {
  starting.delete(start);
}

/** The start's turn passed its 60 s bound while its initializers still run. */
export function markLate(start: ModuleStart): void {
  start.late = true;
}

export function lateStarts(): ModuleStart[] {
  return [...openStarts.values()].filter(start => start.late);
}

export function handToBootTurn(start: ModuleStart): void {
  bootStarts.set(start.module, start);
}

export function bootStartOf(module: string): ModuleStart | undefined {
  return bootStarts.get(module);
}

/** Registers a step run after each start ends; answers its removal. */
export function onStartEnded(fn: (start: ModuleStart, result: StartResult) => void | Promise<void>): () => void {
  endListeners.push(fn);
  return () => {
    const at = endListeners.indexOf(fn);
    if (at >= 0) endListeners.splice(at, 1);
  };
}

function applyingSet(module: string): boolean {
  const read = readStoreRecord();
  return read.ok && !!read.record.modules[module]?.applying;
}

/** T33: a throw while a start ends, or while the boot puts back an apply (102's rule); it never ends the process. */
export function startEndFailed(start: Pick<ModuleStart, 'module'>, error: unknown): void {
  const message = messageOf(error);
  if (applyingSet(start.module)) {
    startEnds.set(start.module, 'failed');
    console.error(`[Error] ${start.module}: finishing its start failed (${message}); the bot finishes it at its next start, and until then this machine applies no change of ${start.module}`);
  } else {
    console.error(`[Error] ${start.module}: finishing its start failed (${message})`);
  }
}

function armRetry(): void {
  if (retryArmed) return;
  retryArmed = true;
  process.prependOnceListener('exit', retryKeptEnds);
}

/** Ends a start once: only the start `openStarts` holds for its module; any later call returns at once. */
export async function endStart(start: ModuleStart, result: StartResult): Promise<void> {
  if (openStarts.get(start.module) !== start) return;
  openStarts.delete(start.module);
  startEnds.set(start.module, 'running');
  if (typeof result === 'object') {
    const failure = messageOf('rejected' in result ? result.rejected : result.failed);
    startFailures.set(start.module, failure);
    failuresByStart.set(start, failure);
  }
  if (start.sha !== null) {
    try {
      const lines = readCrashLines();
      if (lines[start.module]?.sha === start.sha) {
        delete lines[start.module];
        if (writeCrashLines(lines)) keptEnds.delete(start.module);
      } else {
        keptEnds.delete(start.module);
      }
    } catch (error) {
      logCountFailed(error);
      keptEnds.set(start.module, start.sha);
      armRetry();
    }
  }
  try {
    for (const fn of [...endListeners]) {
      try {
        await fn(start, result);
      } catch (error) {
        startEndFailed(start, error);
      }
    }
  } finally {
    if (startEnds.get(start.module) === 'running') startEnds.delete(start.module);
  }
}

const FRAME_IN_PARENS = /\((.+):\d+:\d+\)$/;
const FRAME_BARE = /^\s*at (.+):\d+:\d+$/;

/** A line of the error's stack after the first names a file under `dir`. */
export function frameUnder(error: unknown, dir: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const stack = (error as { stack?: unknown }).stack;
  if (typeof stack !== 'string') return false;
  const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const root = fold(path.resolve(dir) + path.sep);
  for (const line of stack.split('\n').slice(1)) {
    const trimmed = line.trimEnd();
    const match = FRAME_IN_PARENS.exec(trimmed) ?? FRAME_BARE.exec(trimmed);
    if (!match) continue;
    let file = match[1];
    if (file.startsWith('file://')) {
      try {
        file = fileURLToPath(file);
      } catch {
        continue;
      }
    }
    if (fold(path.resolve(file)).startsWith(root)) return true;
  }
  return false;
}

function pickStart(error: unknown): ModuleStart | null {
  if (starting.size === 1) return [...starting][0];
  if (starting.size > 1) return null;
  const late = lateStarts();
  if (late.length !== 1) return null;
  return frameUnder(error, late[0].dir) ? late[0] : null;
}

/** `guardUncaught`'s count, before the exit: one more crash of the start whose code ran. Never throws. */
export function countCrash(error: unknown): void {
  const start = pickStart(error);
  if (!start || start.sha === null) return;
  try {
    const lines = readCrashLines();
    const line = lines[start.module];
    const kept = keptEnds.get(start.module) === start.sha;
    const n = line && line.sha === start.sha && !kept ? line.n + 1 : 1;
    lines[start.module] = { sha: start.sha, n, version: start.version, error: messageOf(error).slice(0, MESSAGE_LIMIT), at: new Date().toISOString() };
    if (writeCrashLines(lines)) keptEnds.delete(start.module);
  } catch (error) {
    logCountFailed(error);
  }
}

/** The `exit` listener: removes each line a start's end could not delete. Synchronous; never throws. */
export function retryKeptEnds(): void {
  if (keptEnds.size === 0) return;
  try {
    const lines = readCrashLines();
    const removed: string[] = [];
    const gone: string[] = [];
    for (const [module, sha] of keptEnds) {
      if (lines[module]?.sha === sha) {
        delete lines[module];
        removed.push(module);
      } else {
        gone.push(module);
      }
    }
    if (removed.length > 0 && !writeCrashLines(lines)) return;
    for (const module of [...removed, ...gone]) keptEnds.delete(module);
  } catch (error) {
    logCountFailed(error);
  }
}

export function _resetModuleCrashes(): void {
  openStarts.clear();
  starting.clear();
  bootStarts.clear();
  keptEnds.clear();
  startEnds.clear();
  startFailures.clear();
  leftOut.clear();
  process.removeListener('exit', retryKeptEnds);
  retryArmed = false;
  crashWritesStopped = false;
}
