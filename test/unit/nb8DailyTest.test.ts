import fs from 'fs';
import { syncBuiltinESMExports } from 'module';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB8 test 10 (decision 9 with C10, decision 47's V7 row, cells D1 to D3, code review 1's timers and the ruling on a
// count-only mismatch of 2026-11-13): the daily test restore through runDailyTest() and through the tick, of a backup
// taken by the real local take.

const safety = vi.hoisted(() => ({ recordCrash: () => undefined, isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
vi.mock('../../src/webui/utils/ownerNotify', async orig => ({
  ...(await orig<any>()),
  postOwnerMessage: async () => ({ status: 200, body: { success: true, posted: true, place: 'dm' } }),
}));

import { BotManager } from '../../src/webui/botManager';
import { CUT_TWICE_TEXT, runDailyTest, _setTestTimingForTests } from '../../src/webui/backups/dailyTest';
import { runTick, _resetSchedulerForTests, type SchedulerHost } from '../../src/webui/backups/scheduler';
import { _resetRestoreStateForTests, backupWorkRunning, setRestoreOp } from '../../src/webui/backups/restoreState';
import { _resetAlertsForTests } from '../../src/webui/backups/alerts';
import { defaultState, readState, statePath, writeRestoreJournal, writeState, type BackupState } from '../../src/webui/backups/state';
import { readSnapshot } from '../../src/bot/internalSetup/utils/backups/snapshotList';
import { formatSnapshotName } from '../../src/bot/internalSetup/utils/backups/snapshotNames';
import { _setTakeTimingForTests, takeSnapshotLocal } from '../../src/bot/internalSetup/utils/backups/snapshotTake';
import { restoreJournalPath } from '../../src/bot/internalSetup/utils/backups/restoreJournal';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';
import { freshWriterLock, logged } from '../helpers/nb10Rig';

const seams = { pid: () => process.pid, alive: () => true, startOf: (pid: number) => `start-${pid}`, now: () => Date.now() };
const at = (day: number, hh: number, mm = 0): number => Date.UTC(2026, 10, day, hh, mm);
const NOW = at(13, 10, 30);

/** A clock set to t that runs on with real time, so a bounded busy wait in src still ends. */
function setClock(t: number): void {
  const p0 = performance.now();
  vi.spyOn(Date, 'now').mockImplementation(() => t + Math.floor(performance.now() - p0));
}
/** A time at or up to 5 s after t. */
const near = (t: number) => ({ asymmetricMatch: (v: unknown) => typeof v === 'number' && v >= t && v < t + 5000, toString: () => `near(${t})` });
const DAILY = formatSnapshotName('daily', at(13, 4, 10));
const DAY = '2026-11-13';
const err = (code: string) => Object.assign(new Error(`${code}: stubbed`), { code });

let managers: BotManager[] = [];
let logs: ReturnType<typeof vi.spyOn>;
let warns: ReturnType<typeof vi.spyOn>;
let errors: ReturnType<typeof vi.spyOn>;
const lines = (): string[] => [...logged(logs), ...logged(warns), ...logged(errors)];
const snaps = (): string => dataPath('_snapshots');
const top = (): string[] => (fs.existsSync(snaps()) ? fs.readdirSync(snaps()) : []);
const onDisk = (): BackupState => readState().state;
const save = (s: BackupState): boolean => {
  writeState(s);
  return true;
};

function fresh(): BotManager {
  const m = new BotManager();
  managers.push(m);
  return m;
}

async function taken(name = DAILY, kind: 'hourly' | 'daily' = 'daily'): Promise<string> {
  expect(await takeSnapshotLocal({ name, kind }, fresh())).toMatchObject({ ok: true });
  return name;
}

/** A child that takes each requested backup for real and answers with the take's answer; onTake runs after the take. */
function quietHost(onTake?: () => void): SchedulerHost {
  return {
    routeProbe: () => ({ route: 'child' }),
    takeSnapshotVia: async (req: { name: string; kind: 'hourly' | 'daily' }) => {
      const answer = await takeSnapshotLocal(req, fresh());
      onTake?.();
      return answer;
    },
    queueFinalOp: async () => ({ ran: false, words: 'none.' }),
    isExiting: () => false,
    migrationRunning: () => null,
  } as unknown as SchedulerHost;
}

beforeEach(() => {
  for (const e of fs.readdirSync(dataPath())) fs.rmSync(dataPath(e), { recursive: true, force: true });
  fs.mkdirSync(dataPath('123', 'mod'), { recursive: true });
  fs.writeFileSync(dataPath('123', 'mod', 'a.json'), '{"a":1}');
  fs.mkdirSync(dataPath('global', 'mod'), { recursive: true });
  fs.writeFileSync(dataPath('global', 'mod', 'x.json'), '{"x":1}');
  freshWriterLock('webui');
  setBackendKind('file');
  _setTakeTimingForTests({ pollMs: 5 }, seams);
  _setTestTimingForTests();
  _resetSchedulerForTests();
  _resetRestoreStateForTests();
  _resetAlertsForTests();
  logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  warns = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
    vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const m of managers) {
    m.beginExit();
    await m.endLocalChain();
  }
  managers = [];
  _setTestTimingForTests();
  _resetSchedulerForTests();
  _resetRestoreStateForTests();
});

const req = (name = DAILY, attempt = 1) => ({ name, attempt, day: DAY });

describe('runDailyTest', () => {
  it('passes: test.last, test.day and test.lastPassed written, the scratch removed, the log line', async () => {
    await taken();
    fs.mkdirSync(path.join(snaps(), '.test-old', 'data'), { recursive: true });
    const state = defaultState();
    expect(await runDailyTest(req(), state, save)).toBe(true);
    expect(onDisk().test).toMatchObject({ running: null, day: DAY, lastPassed: DAILY, last: { name: DAILY, result: 'passed' } });
    expect(onDisk().test.last).not.toHaveProperty('detail');
    expect(top().filter(n => n.startsWith('.test-'))).toEqual([]);
    expect(lines()).toContain(`[Backup] Test restore of ${DAILY} passed`);
    expect(backupWorkRunning()).toBeNull();
  });

  const failing: Array<[string, () => void, string | ((name: string) => string)]> = [
    ['a changed byte', () => fs.writeFileSync(path.join(snaps(), DAILY, 'data', '123', 'mod', 'a.json'), '{"a":2}'),
      'The copy differs from what was recorded when the backup was taken: 1 difference, first 123/mod/a.json (content).'],
    ['a missing file', () => fs.rmSync(path.join(snaps(), DAILY, 'data', 'global', 'mod', 'x.json')),
      name => `Could not copy the backup into the test folder: /data/_snapshots/${name}/data/global/mod/x.json (ENOENT).`],
    ['counts alone', () => {
      const file = path.join(snaps(), DAILY, 'manifest.json');
      const m = JSON.parse(fs.readFileSync(file, 'utf8'));
      m.counts.files += 1;
      fs.writeFileSync(file, JSON.stringify(m));
    }, "The copy differs from what was recorded when the backup was taken: 1 count differs, first the number of files (2 found, 3 recorded)."],
    ['a damaged manifest', () => fs.writeFileSync(path.join(snaps(), DAILY, 'manifest.json'), '{'),
      "The backup's record (manifest.json) cannot be read: not valid JSON."],
  ];

  it.each(failing)('fails with %s: the detail, no lastPassed, the scratch removed', async (_t, damage, detail) => {
    await taken();
    damage();
    const text = typeof detail === 'function' ? detail(DAILY) : detail;
    expect(await runDailyTest(req(), defaultState(), save)).toBe(true);
    expect(onDisk().test).toMatchObject({ running: null, day: DAY, lastPassed: null, last: { name: DAILY, result: 'failed', detail: text } });
    expect(top().filter(n => n.startsWith('.test-'))).toEqual([]);
    expect(lines()).toContain(`[Backup] Test restore of ${DAILY} failed: ${text}`);
  });

  it('fails with the free space text when the disk has less than the backup plus 256 MiB', async () => {
    await taken();
    vi.spyOn(fs.promises, 'statfs').mockResolvedValue({ bavail: 100, bsize: 1024 } as any);
    await runDailyTest(req(), defaultState(), save);
    expect(onDisk().test.last?.detail).toMatch(/^Not enough free disk space under \/data: 0\.1 MiB free, 256\.0 MiB needed \(the data's size plus 256 MiB kept free for the bot's own writes\)\.$/);
  });

  it('a read error in the check of the finished copy names the test copy, not the copy step (fix 3B)', async () => {
    await taken();
    const open = fs.promises.open.bind(fs.promises);
    let bad = '';
    vi.spyOn(fs.promises, 'open').mockImplementation((async (p: fs.PathLike, flags?: any, mode?: any) => {
      if (String(p).includes(`${path.sep}.test-`) && flags === 'r') {
        bad = String(p);
        throw Object.assign(err('EIO'), { path: String(p) });
      }
      return open(p, flags, mode);
    }) as typeof fs.promises.open);
    await runDailyTest(req(), defaultState(), save);
    const rel = path.relative(snaps(), bad).split(path.sep).join('/');
    expect(onDisk().test.last).toMatchObject({ result: 'failed', detail: `Could not read the test copy: /data/_snapshots/${rel} (EIO).` });
  });

  it('a copy that runs past its bound fails the test with the 10-minute text', async () => {
    await taken();
    _setTestTimingForTests({ copyMs: 50 });
    vi.spyOn(fs.promises, 'copyFile').mockImplementation((() => new Promise(() => undefined)) as typeof fs.promises.copyFile);
    await runDailyTest(req(), defaultState(), save);
    expect(onDisk().test.last).toMatchObject({ result: 'failed', detail: 'The test took longer than 10 minutes and was stopped.' });
    expect(backupWorkRunning()).toBeNull();
  });

  it('a check that runs past its bound fails the test with the 5-minute text', async () => {
    await taken();
    _setTestTimingForTests({ checkMs: 50 });
    const real = fs.promises.lstat.bind(fs.promises);
    vi.spyOn(fs.promises, 'lstat').mockImplementation(((p: fs.PathLike, o?: any) =>
      (String(p).includes(`${path.sep}.test-`) ? new Promise(() => undefined) : real(p, o))) as typeof fs.promises.lstat);
    await runDailyTest(req(), defaultState(), save);
    expect(onDisk().test.last).toMatchObject({ result: 'failed', detail: 'The test took longer than 5 minutes and was stopped.' });
  });

  it('D1.c: in one turn the gate, test.running written and backupWorkRunning() set', async () => {
    await taken();
    let seen: unknown[] = [];
    const real = fs.promises.copyFile.bind(fs.promises);
    vi.spyOn(fs.promises, 'copyFile').mockImplementation((async (a: fs.PathLike, b: fs.PathLike, mode?: number) => {
      if (!seen.length) seen = [onDisk().test.running, backupWorkRunning()];
      return real(a, b, mode);
    }) as typeof fs.promises.copyFile);
    await runDailyTest(req(), defaultState(), save);
    expect(seen).toEqual([{ name: DAILY, startedAt: expect.any(Number), attempt: 1 }, 'test']);
  });

  it.each([
    ['running', () => setRestoreOp({ kind: 'restore', name: DAILY })],
    ['unfinished', () => writeRestoreJournal({ format: 1, name: DAILY, startedAt: 1, stage: 'staged', staging: '.restore-x', preRestore: 'pre-restore-x' })],
    ['stuck', () => writeRestoreJournal({ format: 1, name: DAILY, startedAt: 1, stage: 'stuck', staging: '.restore-x', preRestore: 'pre-restore-x', stuckAt: 'placing', cause: 'rename', path: '/data/123', errno: 'EIO' })],
    ['unknown', () => fs.writeFileSync(restoreJournalPath(), '{')],
  ] as Array<[string, () => void]>)('D1.w: the gate %s: no test, nothing written', async (_t, close) => {
    await taken();
    close();
    expect(await runDailyTest(req(), defaultState(), save)).toBe(false);
    expect(fs.existsSync(statePath())).toBe(false);
    expect(top().filter(n => n.startsWith('.test-'))).toEqual([]);
  });

  it('a third attempt records the cut-short text without a copy', async () => {
    await taken();
    const copy = vi.spyOn(fs.promises, 'copyFile');
    await runDailyTest(req(DAILY, 3), defaultState(), save);
    expect(copy).not.toHaveBeenCalled();
    expect(onDisk().test).toMatchObject({ running: null, day: DAY, last: { name: DAILY, result: 'failed', detail: CUT_TWICE_TEXT } });
  });
});

describe('the daily test at the tick', () => {
  beforeEach(() => {
    setClock(NOW);
  });

  it('a test cut short once runs again as attempt 2 and passes; cut twice it fails', async () => {
    await taken();
    writeState({ ...defaultState(), test: { day: null, running: { name: DAILY, startedAt: 1, attempt: 1 }, last: null, lastPassed: null } });
    const running: unknown[] = [];
    const real = fs.promises.copyFile.bind(fs.promises);
    vi.spyOn(fs.promises, 'copyFile').mockImplementation((async (a: fs.PathLike, b: fs.PathLike, mode?: number) => {
      if (!running.length) running.push(onDisk().test.running);
      return real(a, b, mode);
    }) as typeof fs.promises.copyFile);
    await runTick(quietHost());
    expect(running).toEqual([{ name: DAILY, startedAt: near(NOW), attempt: 2 }]);
    expect(onDisk().test).toMatchObject({ running: null, day: DAY, last: { result: 'passed' } });

    _resetSchedulerForTests();
    writeState({ ...defaultState(), test: { day: null, running: { name: DAILY, startedAt: 1, attempt: 2 }, last: null, lastPassed: null } });
    await runTick(quietHost());
    expect(onDisk().test).toMatchObject({ running: null, day: DAY, last: { result: 'failed', detail: CUT_TWICE_TEXT } });
  });

  it('the snapshot the running test reads is kept by the prune', async () => {
    const old = await taken(formatSnapshotName('hourly', at(10, 9)), 'hourly');
    await taken();
    writeState({ ...defaultState(), test: { day: null, running: { name: old, startedAt: 1, attempt: 1 }, last: null, lastPassed: null } });
    await runTick(quietHost());
    expect(onDisk().lastAttempt).toMatchObject({ result: 'ok' });
    expect(readSnapshot(old).state).toBe('complete');
    expect(onDisk().test).toMatchObject({ running: null, last: { name: old, result: 'passed' } });
  });

  it.each([
    ['a POST', () => setRestoreOp({ kind: 'restore', name: DAILY })],
    ['an unreadable journal', () => fs.writeFileSync(restoreJournalPath(), '{')],
  ] as Array<[string, () => void]>)("V7: %s between the tick's take and its test: no test, no test.running", async (_t, between) => {
    await taken();
    const copy = vi.spyOn(fs.promises, 'copyFile');
    await runTick(quietHost(between));
    expect(onDisk().lastAttempt).toMatchObject({ result: 'ok' });
    expect(onDisk().test).toMatchObject({ running: null, last: null, day: null });
    expect(copy).not.toHaveBeenCalled();
    expect(top().filter(n => n.startsWith('.test-'))).toEqual([]);
  });

  it('D1.f: the test.running write throws: the test does not start, the line is logged', async () => {
    await taken();
    const real = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === statePath()) throw err('EIO');
      return real(from, to);
    }) as typeof fs.renameSync);
    syncBuiltinESMExports();
    const copy = vi.spyOn(fs.promises, 'copyFile');
    await runTick(quietHost());
    expect(copy).not.toHaveBeenCalled();
    expect(top().filter(n => n.startsWith('.test-'))).toEqual([]);
    expect(logged(errors)).toContain('[Backup] The backup record (/data/_snapshots/state.json) could not be written (EIO: stubbed); the web panel keeps the change in memory and writes it at its next check.');
  });

  it('D3.f: the result write throws: kept in memory and logged, written at the next tick, and the test is not run again', async () => {
    await taken();
    const real = fs.renameSync;
    let fail = true;
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (fail && String(to) === statePath() && JSON.parse(fs.readFileSync(from, 'utf8')).test.last) throw err('EIO');
      return real(from, to);
    }) as typeof fs.renameSync);
    syncBuiltinESMExports();
    await runTick(quietHost());
    const newest = onDisk().lastAttempt?.name;
    expect(newest).toMatch(/^hourly-2026-11-13T10-30-/);
    expect(onDisk().test).toMatchObject({ running: { name: newest, attempt: 1 }, last: null });
    expect(logged(errors).some(l => l.startsWith('[Backup] The backup record (/data/_snapshots/state.json) could not be written (EIO'))).toBe(true);
    fail = false;
    const copy = vi.spyOn(fs.promises, 'copyFile');
    setClock(NOW + 60_000);
    await runTick(quietHost());
    expect(copy).not.toHaveBeenCalled();
    expect(onDisk().test).toMatchObject({ running: null, day: DAY, lastPassed: newest, last: { name: newest, result: 'passed' } });
  });

  it('D3.f: after a restart with test.day unwritten the test runs again this window (attempt 2)', async () => {
    await taken();
    const real = fs.renameSync;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === statePath() && JSON.parse(fs.readFileSync(from, 'utf8')).test.last) throw err('EIO');
      return real(from, to);
    }) as typeof fs.renameSync);
    syncBuiltinESMExports();
    await runTick(quietHost());
    spy.mockRestore();
    syncBuiltinESMExports();
    vi.resetModules();
    const next = await import('../../src/webui/backups/scheduler');
    const running: unknown[] = [];
    const copy = fs.promises.copyFile.bind(fs.promises);
    vi.spyOn(fs.promises, 'copyFile').mockImplementation((async (a: fs.PathLike, b: fs.PathLike, mode?: number) => {
      if (!running.length) running.push(onDisk().test.running?.attempt);
      return copy(a, b, mode);
    }) as typeof fs.promises.copyFile);
    setClock(NOW + 60_000);
    await next.runTick(quietHost());
    next._resetSchedulerForTests();
    expect(running).toEqual([2]);
    expect(onDisk().test).toMatchObject({ running: null, day: DAY, last: { result: 'passed' } });
  });
});
