import * as fs from 'fs';
import * as path from 'path';
import { DATA_ROOT, dataPath } from '../../utils/dataRoot';
import { containerPath } from '../../bot/internalSetup/utils/folderChain';
import { readSnapshot, snapshotsRoot } from '../../bot/internalSetup/utils/backups/snapshotList';
import { testFolderName } from '../../bot/internalSetup/utils/backups/snapshotNames';
import { copySnapshot, countsDifferText, verifyTree, type VerifyAnswer } from '../../bot/internalSetup/utils/backups/snapshotVerify';
import { backupWorkRunning, restoreGate, setBackupWorkRunning } from './restoreState';
import type { BackupState, TestResult } from './state';

// NB8 decision 9 as C10, decision 47's V7 row and code review 1 amend it: the daily test restore of the newest backup
// into a scratch folder, checked against its manifest. It runs in the web UI process and reads only _snapshots.

const FREE_MARGIN_BYTES = 256 * 1024 * 1024;
const timing = { copyMs: 10 * 60_000, checkMs: 5 * 60_000 };

/** Tests only: the copy's and the check's bounds; the texts keep "10" and "5" minutes. */
export function _setTestTimingForTests(next: Partial<typeof timing> = {}): void {
  Object.assign(timing, { copyMs: 10 * 60_000, checkMs: 5 * 60_000 }, next);
}

export const CUT_TWICE_TEXT = 'The test was cut short twice (the web panel restarted during it).';

export interface TestRequest {
  name: string;
  attempt: number;
  /** The daily window's date, written as `test.day`. */
  day: string;
}

/** The scheduler's write of state.json: true once written, false when it was kept in memory. */
export type SaveState = (state: BackupState) => boolean;

class Late extends Error {
  constructor(readonly minutes: number) {
    super(`The test took longer than ${minutes} minutes and was stopped.`);
  }
}

const errnoOf = (error: unknown): string | undefined => (error as { code?: unknown } | null)?.code as string | undefined;
const mib = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

/** One call with its own timer (code review 1): the signal is read only between files, so the timer fails the step. */
async function bounded<T>(ms: number, minutes: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Late(minutes));
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The detail of a copy or check step that threw: the timer's text, or the step's own text with the path and errno. */
function stepDetail(error: unknown, step: 'copy' | 'check', fallback: string): string {
  if (error instanceof Late) return error.message;
  const code = errnoOf(error);
  if (code === undefined) return error instanceof Error ? error.message : String(error);
  const where = containerPath(typeof (error as { path?: unknown }).path === 'string' ? (error as { path: string }).path : fallback);
  return step === 'copy' ? `Could not copy the backup into the test folder: ${where} (${code}).` : `Could not read the test copy: ${where} (${code}).`;
}

function mismatchDetail(answer: Exclude<VerifyAnswer, { ok: true }>): string {
  const first = answer.differences[0];
  if (first) return `The copy differs from what was recorded when the backup was taken: ${answer.count} difference${answer.count === 1 ? '' : 's'}, first ${first.path} (${first.reason}).`;
  return countsDifferText(answer.counts);
}

/** Removes every `.test-*` folder at the top of _snapshots; a removal that fails is logged. */
async function removeScratch(): Promise<void> {
  let names: string[];
  try {
    names = await fs.promises.readdir(snapshotsRoot());
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith('.test-')) continue;
    try {
      await fs.promises.rm(path.join(snapshotsRoot(), name), { recursive: true, force: true });
    } catch (error) {
      console.warn(`[Backup] Could not remove the test folder ${name} (${errnoOf(error) ?? String(error)}); it is removed before the next test`);
    }
  }
}

/** The copy and its check; null when the copy matched its manifest, else the detail. */
async function copyAndCheck(name: string): Promise<string | null> {
  const entry = readSnapshot(name);
  if (entry.state !== 'complete') return `The backup's record (manifest.json) cannot be read: ${entry.cause}.`;
  const need = entry.manifest.counts.bytes + FREE_MARGIN_BYTES;
  try {
    const st = await fs.promises.statfs(DATA_ROOT);
    const free = st.bavail * st.bsize;
    if (free < need) return `Not enough free disk space under /data: ${mib(free)} free, ${mib(need)} needed (the data's size plus 256 MiB kept free for the bot's own writes).`;
  } catch { /* a statfs that throws skips the check, as the take's */ }
  const dest = dataPath('_snapshots', testFolderName(name), 'data');
  try {
    await bounded(timing.copyMs, 10, signal => copySnapshot(name, dest, { signal }));
  } catch (error) {
    return stepDetail(error, 'copy', snapshotsRoot());
  }
  let verdict: VerifyAnswer;
  try {
    verdict = await bounded(timing.checkMs, 5, signal => verifyTree(dest, entry.manifest, { signal }));
  } catch (error) {
    return stepDetail(error, 'check', dest);
  }
  return verdict.ok ? null : mismatchDetail(verdict);
}

function finish(state: BackupState, req: TestRequest, detail: string | null, save: SaveState): void {
  const last: TestResult = detail === null
    ? { name: req.name, at: Date.now(), result: 'passed' }
    : { name: req.name, at: Date.now(), result: 'failed', detail };
  state.test = { ...state.test, running: null, last, day: req.day, ...(detail === null ? { lastPassed: req.name } : {}) };
  save(state);
  console.log(detail === null ? `[Backup] Test restore of ${req.name} passed` : `[Backup] Test restore of ${req.name} failed: ${detail}`);
}

/**
 * Runs one daily test: in one turn the restore gate, `test.running` written and `backupWorkRunning()` set; then the
 * scratch folders removed, the copy and its check, the scratch removed again, and the result. A third attempt of a
 * test cut short twice records the failure without a copy. Answers whether the test ran.
 */
export async function runDailyTest(req: TestRequest, state: BackupState, save: SaveState): Promise<boolean> {
  if (backupWorkRunning()) return false;
  if (restoreGate().state !== 'clear') return false;
  if (req.attempt > 2) {
    finish(state, req, CUT_TWICE_TEXT, save);
    return true;
  }
  const before = state.test.running;
  state.test = { ...state.test, running: { name: req.name, startedAt: Date.now(), attempt: req.attempt } };
  if (!save(state)) {
    state.test = { ...state.test, running: before };
    return false;
  }
  setBackupWorkRunning('test');
  try {
    let detail: string | null;
    try {
      await removeScratch();
      detail = await copyAndCheck(req.name);
    } finally {
      await removeScratch();
    }
    finish(state, req, detail, save);
  } finally {
    setBackupWorkRunning(null);
  }
  return true;
}
