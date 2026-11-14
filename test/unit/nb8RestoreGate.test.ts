import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB8 test 23, part 7's rows (decisions 46, 47, 56, 65; the state table at sheet 2063-2078 with the delta review's row):
// one row per row of the restore's state table, asserting the gates part 7 builds: start() with and without its own
// op, restart() with no child, writerRoute, routeProbe, hopFailure and getStatus().backups.restoring. The journal is
// written by state.ts's writer; the op and the latch are set through restoreState.ts (restore.ts, part 11, sets them
// in the build). The other gates of the row are their own parts' rows.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});

import { syncBuiltinESMExports } from 'module';
import { BotManager } from '../../src/webui/botManager';
import { hopFailure } from '../../src/webui/routes/hopFailure';
import { writeRestoreJournal } from '../../src/webui/backups/state';
import { beginRecovery, recordReplacedData } from '../../src/webui/backups/restore';
import { timeText } from '../../src/bot/internalSetup/utils/folderChain';
import { _resetRestoreStateForTests, setRestoreLatch, setRestoreOp, type RestoreOp } from '../../src/webui/backups/restoreState';
import { restoreJournalPath, type RestoreStage } from '../../src/bot/internalSetup/utils/backups/restoreJournal';
import { releaseWriterLock, writerLockDepth } from '../../src/bot/internalSetup/utils/writerLock';
import { dataPath } from '../../src/utils/dataRoot';
import { writeMaintenanceFile } from '../../src/utils/maintenanceFile';
import { forks } from '../helpers/forkMock';
import { freshWriterLock, quiet, resetForks } from '../helpers/nb10Rig';

const NAME = 'hourly-2026-11-13T04-00-00-000Z';
const RUNNING_WRITE = 'A backup restore is running; nothing was saved. Save again once it has finished.';
const STUCK_WRITE = 'The last backup restore stopped part way; nothing was saved. The Dashboard tab says what to do.';
const STUCK_START = 'The last backup restore stopped part way, so the bot does not start; the Dashboard tab says what to do.';
const UNKNOWN_WRITE = "can't confirm whether a backup restore is running (/data/_snapshots/restore.json: not valid JSON); nothing was saved. Save again once that file can be read.";
const UNKNOWN_START = "can't confirm the state of the last backup restore: /data/_snapshots/restore.json cannot be read (not valid JSON). The bot does not start until it can be read; if no restore ran, remove that file.";
const WORDS = {
  running: 'a backup restore was starting or running.',
  stuck: 'the last backup restore did not finish.',
  unknown: "can't confirm whether a backup restore was running (/data/_snapshots/restore.json: not valid JSON).",
};

function journal(stage: RestoreStage | 'unreadable' | 'none'): void {
  if (stage === 'none') return;
  if (stage === 'unreadable') {
    fs.mkdirSync(dataPath('_snapshots'), { recursive: true });
    fs.writeFileSync(restoreJournalPath(), '{"format":1,"stage":');
    return;
  }
  const fields = stage === 'stuck' ? { stuckAt: 'placing', path: '123', cause: 'rename', errno: 'EACCES' } : stage === 'placed' ? { placedAt: 2 } : {};
  writeRestoreJournal({ format: 1, name: NAME, startedAt: 1, stage, staging: '.restore-x', preRestore: 'pre-restore-x', ...fields });
}

// The latch of each row, set by its real path (code review 3, A4): the `staging` write throwing leaves no open journal,
// so its latch is set as that write sets it; the others come from recovery or step 8 with the journal write throwing.
type LatchPath = 'staging' | 'placed write' | 'write back to stuckAt' | "step 8's done write";

async function setLatch(how: LatchPath): Promise<void> {
  if (how === 'staging') {
    setRestoreLatch({ at: 1, name: NAME, kind: 'journal', stage: 'staging', errno: 'EIO', preRestore: 'pre-restore-x' });
    return;
  }
  if (how === "step 8's done write") {
    fs.mkdirSync(dataPath('_snapshots', '.pre-restore-x', 'data', '123'), { recursive: true });
    fs.writeFileSync(dataPath('_snapshots', '.pre-restore-x', 'data', '123', 'a.json'), '{"a":1}');
  }
  const real = fs.renameSync;
  const spy = vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === restoreJournalPath()) throw Object.assign(new Error('EIO'), { code: 'EIO' });
    return real(from, to);
  }) as typeof fs.renameSync);
  syncBuiltinESMExports();
  try {
    if (how === "step 8's done write") expect(await recordReplacedData()).toBe('latched');
    else expect(await beginRecovery(new BotManager())).toBe('ended');
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
    setRestoreOp(null);
    while (writerLockDepth() > 0) releaseWriterLock();
  }
}

const DID_NOT_START = `The restore of ${NAME} did not start: its record (/data/_snapshots/restore.json) could not be written (EIO). Nothing was changed. No restore can start until the bot's container is restarted; check the disk first.`;
const PART_WAY = `The restore of ${NAME} stopped part way: its record (/data/_snapshots/restore.json) could not be written (EIO), so can't confirm the disk took the restore's last step. Until the bot's container is restarted, nothing more is moved, no change to the data is saved and the bot cannot be started. Check the disk, then restart the bot's container: the web panel takes the restore up again from its record when it starts, before it starts the bot; when the record says swapping, it finishes the restore, or ends it failed with the data unchanged if no data had been moved yet.`;
const STEP_8 = (): string => `Restored ${NAME} at ${timeText(2)}. The data it replaced is in /data/_snapshots/pre-restore-x, but the restore's record (/data/_snapshots/restore.json) could not be written (EIO). No other restore can start until the bot's container is restarted; check the disk first. After the restart the web panel tries again to write the record within a minute.`;

type Answer = 'clear' | 'running' | 'stuck' | 'unknown';
interface Row {
  row: string;
  stage: RestoreStage | 'unreadable' | 'none';
  latch: LatchPath | null;
  latchText?: () => string;
  op: RestoreOp | null;
  answer: Answer;
  ownStarts: boolean;
}

const restoreOp = (over: Partial<RestoreOp> = {}): RestoreOp => ({ kind: 'restore', name: NAME, ...over });

const rows: Row[] = [
  { row: '2065 failed, no latch, no op', stage: 'failed', latch: null, op: null, answer: 'clear', ownStarts: false },
  { row: '2066 no journal, the staging latch, no op', stage: 'none', latch: 'staging', latchText: () => DID_NOT_START, op: null, answer: 'clear', ownStarts: false },
  { row: 'delta: done, the staging latch, the op starting its bot', stage: 'done', latch: 'staging', latchText: () => DID_NOT_START, op: restoreOp({ stopped: true }), answer: 'running', ownStarts: true },
  { row: '2067 placed, no latch, the op after placed', stage: 'placed', latch: null, op: restoreOp(), answer: 'running', ownStarts: true },
  { row: '2068 swapping, no latch, the op', stage: 'swapping', latch: null, op: restoreOp(), answer: 'running', ownStarts: false },
  { row: '2069 stuck, no latch, recovery', stage: 'stuck', latch: null, op: restoreOp({ kind: 'recovery' }), answer: 'running', ownStarts: false },
  { row: '2070 staged, no latch, no op', stage: 'staged', latch: null, op: null, answer: 'stuck', ownStarts: false },
  { row: '2071 placing, the latch (the placed write), no op', stage: 'placing', latch: 'placed write', latchText: () => PART_WAY, op: null, answer: 'stuck', ownStarts: false },
  { row: '2072 stuck, no latch, no op', stage: 'stuck', latch: null, op: null, answer: 'stuck', ownStarts: false },
  { row: '2073 stuck, the latch (the write back to stuckAt), no op', stage: 'stuck', latch: 'write back to stuckAt', latchText: () => PART_WAY, op: null, answer: 'stuck', ownStarts: false },
  { row: '2074 placed, no latch, no op', stage: 'placed', latch: null, op: null, answer: 'clear', ownStarts: false },
  { row: "2075 placed, the latch (step 8's done write), no op", stage: 'placed', latch: "step 8's done write", latchText: STEP_8, op: null, answer: 'clear', ownStarts: false },
  { row: '2076 unreadable, no latch, no op', stage: 'unreadable', latch: null, op: null, answer: 'unknown', ownStarts: false },
  { row: '2077 unreadable, no latch, main() waiting', stage: 'unreadable', latch: null, op: restoreOp({ kind: 'recovery', name: null }), answer: 'unknown', ownStarts: false },
  { row: '2078 unreadable, the latch, no op', stage: 'unreadable', latch: 'staging', latchText: () => DID_NOT_START, op: null, answer: 'unknown', ownStarts: false },
];

const startText: Record<Exclude<Answer, 'clear'>, string> = { running: 'A backup restore is running', stuck: STUCK_START, unknown: UNKNOWN_START };
const writeText: Record<Exclude<Answer, 'clear'>, string> = { running: RUNNING_WRITE, stuck: STUCK_WRITE, unknown: UNKNOWN_WRITE };

beforeEach(() => {
  quiet();
  resetForks();
  freshWriterLock();
  _resetRestoreStateForTests();
  fs.rmSync(dataPath('_snapshots'), { recursive: true, force: true });
});

afterEach(async () => {
  for (const child of forks.children) if (child.exitCode === null) { child.exitCode = 0; child.emit('exit', 0, null); }
  while (writerLockDepth() > 0) releaseWriterLock();
  _resetRestoreStateForTests();
  vi.restoreAllMocks();
});

describe("the restore's state table, part 7's gates", () => {
  it.each(rows)('$row', async r => {
    journal(r.stage);
    if (r.latch) await setLatch(r.latch);
    setRestoreOp(r.op);

    const status = new BotManager().getStatus();
    expect(status.backups.restoring).toBe(r.answer === 'clear' ? false : r.answer === 'unknown' ? 'unknown' : true);

    const probe = new BotManager().routeProbe('shared');
    const route = new BotManager().writerRoute('shared');
    while (writerLockDepth() > 0) releaseWriterLock();
    if (r.answer === 'clear') {
      expect(probe).toEqual({ route: 'local' });
      expect(route).toEqual({ route: 'local' });
    } else {
      const words = WORDS[r.answer];
      const text = writeText[r.answer];
      expect(probe).toEqual({ ok: false, status: 503, code: 'restoring', error: text, words });
      expect(route).toEqual({ ok: false, status: 503, code: 'restoring', error: text });
      expect(hopFailure((route as { code: string }).code, (route as { error: string }).error)).toEqual({ status: 503, error: text });
    }

    const plain = new BotManager();
    const started = await plain.start();
    if (r.answer === 'clear') {
      expect(started.success).toBe(true);
    } else {
      expect(started).toEqual({ success: false, reason: 'restoring', error: startText[r.answer] });
      expect(forks.children).toHaveLength(0);
      expect(await new BotManager().restart()).toEqual({ success: false, reason: 'restoring', error: startText[r.answer] });
    }
    expect(r.op?.stopped ?? false).toBe(r.row.startsWith('delta'));

    if (r.op) {
      const own = await new BotManager().start({ restoreOp: r.op });
      if (r.ownStarts) expect(own.success).toBe(true);
      else expect(own).toMatchObject({ success: false, reason: 'restoring' });
    }
  });

  it('hopFailure answers restoring with its default text when the refusal names none', () => {
    expect(hopFailure('restoring')).toEqual({ status: 503, error: RUNNING_WRITE });
  });
});

describe("the restore's state table, part 11's gates: the POST and step 8", () => {
  it.each(rows)('$row', async r => {
    const restore = await import('../../src/webui/backups/restore');
    const state = await import('../../src/webui/backups/restoreState');
    const { readRestoreJournal } = await import('../../src/bot/internalSetup/utils/backups/restoreJournal');
    journal(r.stage);
    if (r.latch) await setLatch(r.latch);
    setRestoreOp(r.op);

    const answer = await restore.postRestore(new BotManager(), NAME);
    const read = readRestoreJournal();
    const held = state.restoreLatch();
    expect(held !== null).toBe(r.latch !== null);
    if (held) {
      expect(answer).toEqual({ status: 409, body: { success: false, error: r.latchText?.() } });
    } else if (r.answer === 'running') {
      expect(answer).toEqual({ status: 202, body: { success: true, state: 'running', name: NAME, note: `A restore of ${NAME} is already running.` } });
    } else if (r.answer === 'unknown') {
      expect(answer).toEqual({ status: 409, body: { success: false, error: UNKNOWN_START } });
    } else if (r.stage === 'stuck' && read.state === 'read') {
      expect(answer).toEqual({ status: 409, body: { success: false, error: restore.stuckText(read.journal) } });
    } else if (r.answer === 'stuck' && read.state === 'read') {
      expect(answer).toEqual({ status: 409, body: { success: false, error: restore.unfinishedText(read.journal) } });
    } else if (r.stage === 'placed') {
      expect(answer).toEqual({ status: 409, body: { success: false, error: 'The last restore is still recording the data it replaced; try again in a minute.' } });
    } else {
      expect(answer).toEqual({ status: 404, body: { success: false, error: `No complete backup is named ${NAME}.` } });
    }
    expect(state.restoreOp()).toBe(r.op);

    const step8 = await restore.recordReplacedData();
    expect(step8 !== 'not-run').toBe(r.row.startsWith('2074'));
  });
});

describe("the restore's state table: a property over restores, journal writes that throw, crash restarts and new main() runs", () => {
  const SNAP = 'hourly-2026-11-13T03-00-00-000Z';
  const STAGES = ['staging', 'staged', 'swapping', 'placing', 'placed', 'failed', 'stuck', null] as const;
  // The bot child crashes as the op writes this stage; its crash timer fires at once (fake timers for that turn only).
  const CRASHES = ['staging', 'staged', null] as const;

  it('restoreGate() never answers clear while the journal on disk is open or unreadable, no start or write passes unless it does, and a child stopped during an op that ends failed or placed runs again', async () => {
    const fc = (await import('fast-check')).default;
    const restore = await import('../../src/webui/backups/restore');
    const state = await import('../../src/webui/backups/restoreState');
    const { readRestoreJournal, isOpenStage } = await import('../../src/bot/internalSetup/utils/backups/restoreJournal');
    const take = await import('../../src/bot/internalSetup/utils/backups/snapshotTake');
    const { syncBuiltinESMExports } = await import('module');

    const check = async (): Promise<void> => {
      const read = readRestoreJournal();
      const gate = state.restoreGate();
      const open = read.state === 'unreadable' || (read.state === 'read' && isOpenStage(read.journal.stage));
      if (open) expect(gate.state).not.toBe('clear');
      if (gate.state !== 'clear') {
        expect(new BotManager().writerRoute('shared')).toMatchObject({ code: 'restoring' });
        expect(await new BotManager().start()).toMatchObject({ success: false, reason: 'restoring' });
      }
      while (writerLockDepth() > 0) releaseWriterLock();
    };

    await fc.assert(fc.asyncProperty(fc.array(fc.record({ fail: fc.constantFrom(...STAGES), crash: fc.constantFrom(...CRASHES), restart: fc.boolean() }), { minLength: 1, maxLength: 3 }), async steps => {
      fs.rmSync(dataPath('_snapshots'), { recursive: true, force: true });
      for (const e of fs.readdirSync(dataPath())) if (!e.startsWith('.')) fs.rmSync(dataPath(e), { recursive: true, force: true });
      fs.mkdirSync(dataPath('123', 'mod'), { recursive: true });
      fs.writeFileSync(dataPath('123', 'mod', 'a.json'), '{"a":1}');
      _resetRestoreStateForTests();
      expect(await take.takeSnapshotLocal({ name: SNAP, kind: 'hourly' }, new BotManager())).toMatchObject({ ok: true });
      fs.writeFileSync(dataPath('123', 'mod', 'a.json'), '{"a":2}');
      writeMaintenanceFile('maintenance', 'restoring');
      for (const child of forks.children) if (child.exitCode === null) { child.exitCode = 0; child.emit('exit', 0, null); }
      const bot = new BotManager();
      const crashNow = (): void => {
        const child = forks.children.at(-1);
        if (!bot.isRunning() || !child) return;
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
          child.exitCode = 1;
          child.emit('exit', 1, null);
          vi.advanceTimersByTime(5_100);
        } finally {
          vi.useRealTimers();
        }
      };
      for (const step of steps) {
        if (step.crash && !bot.isRunning()) await bot.start();
        const wasRunning = bot.isRunning();
        const real = fs.renameSync;
        const spy = vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
          const stage = String(to) === restoreJournalPath() ? JSON.parse(fs.readFileSync(from, 'utf8')).stage : null;
          if (step.crash && stage === step.crash) crashNow();
          if (step.fail && stage === step.fail) throw Object.assign(new Error('EIO'), { code: 'EIO' });
          if (step.fail === 'stuck' && String(from).includes('.restore-') && !String(to).includes('_snapshots')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
          return real(from, to);
        }) as typeof fs.renameSync);
        syncBuiltinESMExports();
        const answer = await restore.postRestore(bot, SNAP);
        await restore.restoreSettled();
        const ended = readRestoreJournal();
        if (answer.body.state === 'started' && wasRunning && ended.state === 'read' && (ended.journal.stage === 'failed' || ended.journal.stage === 'placed')) {
          expect(bot.isRunning()).toBe(true);
        }
        await check();
        await restore.recordReplacedData();
        await check();
        spy.mockRestore();
        syncBuiltinESMExports();
        if (step.restart) {
          _resetRestoreStateForTests();
          const m = new BotManager();
          const recovery = restore.beginRecovery(m);
          if (recovery) await recovery;
          await check();
          state.setRestoreOp(null);
          await check();
        }
      }
      while (writerLockDepth() > 0) releaseWriterLock();
    }), { numRuns: 12 });
  }, 120_000);
});
