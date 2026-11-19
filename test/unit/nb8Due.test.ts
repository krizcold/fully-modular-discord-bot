import fs from 'fs';
import { syncBuiltinESMExports } from 'module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB8 test 5 (decisions 8, 9, 23, 50, 57, C20, H2, H3, L3). Part 10a's rows (N4): under a set flag a state.json and a
// restore.json write return with the new bytes in place (`chain: false`), and a settings.json write throws a
// FolderSyncError with the new settings in place. Part 10b's rows: `dueWork`, and the tick through runTick() with a real
// BotManager (the local take) or a stub host for the child's answers (cells T1, T5), test 11's tick rows and test 12's
// rerun of step 8 at a fresh module's tick.

const h = vi.hoisted(() => ({ syncFolder: null as null | ((dir: string) => unknown) }));
const safety = vi.hoisted(() => ({ recordCrash: () => undefined, isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
const owner = vi.hoisted(() => ({ posts: [] as Array<{ text: string; key: string }> }));
vi.mock('../../src/webui/utils/ownerNotify', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    postOwnerMessage: async (msg: { text: string; key: string }) => {
      owner.posts.push(msg);
      return { status: 200, body: { success: true, posted: true, place: 'dm' } };
    },
  };
});

// The folder syncs answer 'earlier' once the flag is set, as on Linux, so the rows run on Windows too.
vi.mock('../../src/bot/internalSetup/utils/folderChain', async orig => {
  const real = await orig<any>();
  const earlier = () => {
    const flag = real.folderSyncFlag();
    return { failed: true, kind: 'earlier', dir: flag.dir, errno: flag.errno, error: null };
  };
  return {
    ...real,
    syncFolder: async (dir: string) => h.syncFolder?.(dir) ?? real.syncFolder(dir),
    syncFolderSync: (dir: string) => (real.folderSyncFailed() ? earlier() : real.syncFolderSync(dir)),
    syncFolderChainSync: (dir: string) => (real.folderSyncFailed() ? earlier() : real.syncFolderChainSync(dir)),
  };
});

import { readRestoreJournal, restoreJournalPath, type RestoreJournal } from '../../src/bot/internalSetup/utils/backups/restoreJournal';
import {
  FolderSyncError, _setBootIdForTests, folderSyncFlag, noteFolderSyncFailure, resetFolderSyncFailureForTests, setDiskRole, timeText,
} from '../../src/bot/internalSetup/utils/folderChain';
import {
  defaultState, readSettings, readState, settingsPath, settingsUnreadableText, statePath, stateUnreadableText,
  writeRestoreJournal, writeSettings, writeState, type BackupState,
} from '../../src/webui/backups/state';
import { dataPath } from '../../src/utils/dataRoot';
import { BotManager } from '../../src/webui/botManager';
import { dueWork, runTick, _resetSchedulerForTests, type SchedulerHost } from '../../src/webui/backups/scheduler';
import {
  _resetRestoreStateForTests, backupWorkRunning, gateTakeWords, restoreGate, restoreLatch, setRestoreLatch, setRestoreOp,
} from '../../src/webui/backups/restoreState';
import { _resetAlertsForTests } from '../../src/webui/backups/alerts';
import { listSnapshots, readSnapshot, type SnapshotEntry } from '../../src/bot/internalSetup/utils/backups/snapshotList';
import { formatSnapshotName } from '../../src/bot/internalSetup/utils/backups/snapshotNames';
import { _setTakeTimingForTests, takeSnapshotLocal, type TakeAnswer } from '../../src/bot/internalSetup/utils/backups/snapshotTake';
import { setBackendKind } from '../helpers/backendKind';
import { freshWriterLock, logged } from '../helpers/nb10Rig';

const journal = (stage: RestoreJournal['stage']): RestoreJournal => ({
  format: 1, name: 'hourly-2026-11-13T10-00-00-000Z', startedAt: 1_000, stage, staging: '.restore-x', preRestore: '.pre-restore-x',
});

describe('state.ts writes under a set flag (N4)', () => {
  afterEach(() => fs.rmSync(dataPath('_snapshots'), { recursive: true, force: true }));

  it('a state.json write returns and the file holds the new bytes', () => {
    writeState({ ...defaultState(), watchingSince: 1 });
    noteFolderSyncFailure(dataPath('123'), 'EIO');
    let thrown: unknown = null;
    try { writeState({ ...defaultState(), watchingSince: 2 }); } catch (e) { thrown = e; }
    expect(thrown).toBeNull();
    expect(JSON.parse(fs.readFileSync(statePath(), 'utf8')).watchingSince).toBe(2);
    expect(readState().state.watchingSince).toBe(2);
  });

  it('a restore.json write returns and the file holds the new bytes', () => {
    writeRestoreJournal(journal('swapping'));
    noteFolderSyncFailure(dataPath('123'), 'EIO');
    let thrown: unknown = null;
    try { writeRestoreJournal(journal('placing')); } catch (e) { thrown = e; }
    expect(thrown).toBeNull();
    expect(JSON.parse(fs.readFileSync(restoreJournalPath(), 'utf8')).stage).toBe('placing');
    expect(readRestoreJournal()).toEqual({ state: 'read', journal: journal('placing') });
  });

  it('a settings.json write throws a FolderSyncError and the file holds the new settings', () => {
    writeSettings({ enabled: true, hour: 4 });
    noteFolderSyncFailure(dataPath('123'), 'EIO');
    let thrown: unknown = null;
    try { writeSettings({ enabled: false, hour: 6 }); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(FolderSyncError);
    expect((thrown as FolderSyncError).kind).toBe('earlier');
    expect((thrown as FolderSyncError).file).toBe(settingsPath());
    expect(readSettings()).toEqual({ settings: { enabled: false, hour: 6 }, cause: null });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// dueWork
// ---------------------------------------------------------------------------------------------------------------

const at = (day: number, hh: number, mm = 0): number => Date.UTC(2026, 10, day, hh, mm);
const NOW = at(13, 10, 30);

/** A clock set to t that runs on with real time, so a bounded busy wait in src still ends. */
function setClock(t: number): void {
  const p0 = performance.now();
  vi.spyOn(Date, 'now').mockImplementation(() => t + Math.floor(performance.now() - p0));
}
/** A time at or up to 5 s after t. */
const near = (t: number) => ({ asymmetricMatch: (v: unknown) => typeof v === 'number' && v >= t && v < t + 5000, toString: () => `near(${t})` });
/** The name of a backup the tick took in the minute of NOW (the clock runs on during a row). */
const tickName = (kind: 'hourly' | 'daily', minute = 30) => expect.stringMatching(new RegExp(`^${kind}-2026-11-13T10-${minute}-\\d{2}-\\d{3}Z$`));

function entry(kind: 'hourly' | 'daily' | 'pre-restore', time: number, state: 'complete' | 'damaged' = 'complete'): SnapshotEntry {
  const name = formatSnapshotName(kind, time);
  if (state === 'damaged') return { name, kind, time, state, cause: 'no format field' };
  return {
    name, kind, time, state,
    manifest: { format: 1, name, kind, takenAt: time, botVersion: '1', counts: { files: 0, bytes: 0, dirs: 0, guilds: 0, graveyardEntries: 0 }, files: [], dirs: [] },
  };
}

const st = (over: Partial<BackupState> = {}): BackupState => ({ ...defaultState(), ...over });
const ON = { enabled: true, hour: 4 };
const due = (kind: 'hourly' | 'daily', now: number, tries = 1) => ({ name: formatSnapshotName(kind, now), kind, tries });
const failedAt = (time: number, over: object = {}) => ({ name: formatSnapshotName('hourly', time), at: time + 60_000, result: 'failed' as const, error: 'x.', ...over });

describe('dueWork (decisions 8, 9 and 23)', () => {
  const daily = entry('daily', at(13, 4, 10));
  it.each([
    ['the first take is a daily', NOW, [], st(), due('daily', NOW)],
    ['a backup this hour: none', NOW, [daily, entry('hourly', at(13, 10, 5))], st(), null],
    ['the next hour: an hourly', NOW, [daily, entry('hourly', at(13, 9, 5))], st(), due('hourly', NOW)],
    ["before the daily hour, yesterday's daily stands: an hourly", at(13, 3, 30), [entry('daily', at(12, 4, 10))], st(), due('hourly', at(13, 3, 30))],
    ['after the daily hour: a daily', at(13, 4, 30), [entry('daily', at(12, 4, 10)), entry('hourly', at(13, 3, 10))], st(), due('daily', at(13, 4, 30))],
    ['a daily hour the web panel missed: a daily at the first due take', NOW, [entry('daily', at(12, 4, 10)), entry('hourly', at(13, 9, 10))], st(), due('daily', NOW)],
    ['a daily taken this hour stands for its hour', NOW, [entry('daily', at(13, 10, 1))], st(), null],
    ['a damaged folder of this hour does not count', NOW, [daily, entry('hourly', at(13, 10, 5), 'damaged')], st(), due('hourly', NOW)],
    ['a pre-restore backup of this hour does not count', NOW, [daily, entry('pre-restore', at(13, 10, 5))], st(), due('hourly', NOW)],
    ['an attempt that failed this hour: none', NOW, [daily], st({ lastAttempt: failedAt(at(13, 10, 1), { tries: 1 }) }), null],
    ['an attempt that cannot be confirmed this hour: none', NOW, [daily], st({ lastAttempt: { ...failedAt(at(13, 10, 1)), result: 'unknown' } }), null],
    ['the data kept changing, try 1: try 2', NOW, [daily], st({ lastAttempt: failedAt(at(13, 10, 1), { cause: 'writes', tries: 1 }) }), due('hourly', NOW, 2)],
    ['the data kept changing, try 3: none until the next hour', NOW, [daily], st({ lastAttempt: failedAt(at(13, 10, 1), { cause: 'writes', tries: 3 }) }), null],
    ['the data kept changing 3 times last hour: try 1 of this hour', NOW, [daily], st({ lastAttempt: failedAt(at(13, 9, 1), { cause: 'writes', tries: 3 }) }), due('hourly', NOW)],
    ['a refusal is no attempt', NOW, [daily], st({ lastRefusal: { at: at(13, 10, 1), words: 'the bot was stopping.' } }), due('hourly', NOW)],
  ] as Array<[string, number, SnapshotEntry[], BackupState, unknown]>)('%s', (_t, now, list, state, take) => {
    expect(dueWork(now, list, state, ON).take).toEqual(take);
  });

  it('with the switch off nothing is due', () => {
    expect(dueWork(NOW, [], st(), { enabled: false, hour: 4 })).toEqual({ take: null, test: null });
  });

  it('the daily hour follows settings.json', () => {
    const list = [entry('daily', at(13, 4, 10))];
    expect(dueWork(at(13, 6, 30), list, st(), { enabled: true, hour: 6 }).take?.kind).toBe('daily');
    expect(dueWork(at(13, 5, 30), list, st(), { enabled: true, hour: 6 }).take?.kind).toBe('hourly');
  });

  it("the test is due once per window, after that window's daily, of the newest backup", () => {
    const newest = entry('hourly', at(13, 10, 5));
    const list = [entry('daily', at(13, 4, 10)), newest];
    const tested = st({ test: { day: '2026-11-13', running: null, last: null, lastPassed: null } });
    expect(dueWork(NOW, list, st(), ON).test).toEqual({ name: newest.name, attempt: 1, day: '2026-11-13' });
    expect(dueWork(NOW, list, tested, ON).test).toBeNull();
    expect(dueWork(NOW, [entry('daily', at(12, 4, 10)), newest], st(), ON).test).toBeNull();
    expect(dueWork(at(14, 4, 30), list, tested, ON).test).toBeNull();
  });

  it('a test found running was cut short: it runs again with the next attempt', () => {
    const list = [entry('daily', at(13, 4, 10))];
    const running = (attempt: number) => st({ test: { day: null, running: { name: 'daily-x', startedAt: 1, attempt }, last: null, lastPassed: null } });
    expect(dueWork(NOW, list, running(1), ON).test).toEqual({ name: 'daily-x', attempt: 2, day: '2026-11-13' });
    expect(dueWork(NOW, list, running(2), ON).test).toEqual({ name: 'daily-x', attempt: 3, day: '2026-11-13' });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------------------------------------------

const seams = { pid: () => process.pid, alive: () => true, startOf: (pid: number) => `start-${pid}`, now: () => Date.now() };
let logs: ReturnType<typeof vi.spyOn>;
let warns: ReturnType<typeof vi.spyOn>;
let errors: ReturnType<typeof vi.spyOn>;
const lines = (): string[] => [...logged(logs), ...logged(warns), ...logged(errors)];
const onDisk = (): BackupState => readState().state;
const err = (code: string) => Object.assign(new Error(`${code}: stubbed`), { code });
const snapshotsDir = (): string[] => (fs.existsSync(dataPath('_snapshots')) ? fs.readdirSync(dataPath('_snapshots')) : []);

function writeLive(): void {
  fs.mkdirSync(dataPath('123', 'mod'), { recursive: true });
  fs.writeFileSync(dataPath('123', 'mod', 'a.json'), '{"a":1}');
}

/** A complete backup of the live data, taken by the real local take. */
async function taken(m: BotManager, kind: 'hourly' | 'daily', time: number): Promise<string> {
  const name = formatSnapshotName(kind, time);
  expect(await takeSnapshotLocal({ name, kind }, m)).toMatchObject({ ok: true });
  return name;
}

/** A fake child's ok answer: the backup taken for real under the requested name, as the real child answers. */
const took = (req: { name: string; kind: 'hourly' | 'daily' }): Promise<TakeAnswer> => takeSnapshotLocal(req, fresh());

type Next = TakeAnswer | { ok: false; unknown: true; error: string } | ((req: any) => Promise<unknown>);

/** A stub host whose route is the child, answering each `backup:take` with the next answer given. */
function childHost(...answers: Next[]): SchedulerHost & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    routeProbe: () => ({ route: 'child' }),
    takeSnapshotVia: async (req: unknown) => {
      sent.push(req);
      const next = answers.shift();
      return typeof next === 'function' ? next(req) : next;
    },
    queueFinalOp: async () => ({ ran: false, words: 'none.' }),
    isExiting: () => false,
    migrationRunning: () => null,
  } as unknown as SchedulerHost & { sent: unknown[] };
}

const OLD_HOURLY = at(10, 9, 0);
const DAILY = at(13, 4, 10);

/** The placed journal and its aside folder as the op leaves them, before step 8. */
function placedRestore(): RestoreJournal {
  const j: RestoreJournal = {
    format: 1, name: formatSnapshotName('daily', DAILY), startedAt: at(13, 9, 0), stage: 'placed',
    staging: '.restore-2026-11-13T09-00-00-000Z', preRestore: 'pre-restore-2026-11-13T09-00-00-000Z', placedAt: at(13, 9, 1),
  };
  fs.mkdirSync(dataPath('_snapshots', `.${j.preRestore}`, 'data', '123', 'mod'), { recursive: true });
  fs.writeFileSync(dataPath('_snapshots', `.${j.preRestore}`, 'data', '123', 'mod', 'a.json'), '{"a":0}');
  writeRestoreJournal(j);
  return j;
}

let managers: BotManager[] = [];
function fresh(): BotManager {
  const m = new BotManager();
  managers.push(m);
  return m;
}

function quiet(): void {
  logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  warns = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
}

function freshTree(): void {
  for (const e of fs.readdirSync(dataPath())) fs.rmSync(dataPath(e), { recursive: true, force: true });
  writeLive();
  freshWriterLock('webui');
  setBackendKind('file');
  _setTakeTimingForTests({ pollMs: 5 }, seams);
  _resetSchedulerForTests();
  _resetRestoreStateForTests();
  _resetAlertsForTests();
  owner.posts = [];
  h.syncFolder = null;
}

async function endAll(): Promise<void> {
    vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const m of managers) {
    m.beginExit();
    await m.endLocalChain();
  }
  managers = [];
  _resetSchedulerForTests();
  _resetRestoreStateForTests();
  _setBootIdForTests(null);
  resetFolderSyncFailureForTests();
  h.syncFolder = null;
}

describe('the tick', () => {
  beforeEach(() => {
    freshTree();
    setClock(NOW);
    quiet();
  });
  afterEach(endAll);

  it('T1.c (local): the first tick takes a daily through the local take, records it ok and sets watchingSince', async () => {
    await runTick(fresh());
    const name = onDisk().lastAttempt?.name ?? '';
    expect(name).toEqual(tickName('daily'));
    expect(readSnapshot(name).state).toBe('complete');
    expect(onDisk()).toMatchObject({ lastAttempt: { name, result: 'ok', tries: 1 }, lastRefusal: null, watchingSince: near(NOW) });
    expect(backupWorkRunning()).toBeNull();
  });

  it('P1.c: the prune after an attempt removes an hourly past its keep and keeps the newest', async () => {
    const m = fresh();
    const old = await taken(m, 'hourly', OLD_HOURLY);
    await runTick(m);
    const names = (await listSnapshots()).map(s => s.name);
    expect(names).not.toContain(old);
    expect(names).toContain(onDisk().lastAttempt?.name);
    expect(onDisk().lastAttempt?.name).toEqual(tickName('daily'));
    expect(snapshotsDir().some(n => n.startsWith('.delete-'))).toBe(false);
    expect(lines()).toContain(`[Backup] Removed ${old} (past its keep)`);
  });

  it('with no take due there is no attempt and no prune', async () => {
    const m = fresh();
    const old = await taken(m, 'hourly', OLD_HOURLY);
    await taken(m, 'daily', at(13, 10, 1));
    await runTick(m);
    expect(onDisk().lastAttempt).toBeNull();
    expect(readSnapshot(old).state).toBe('complete');
  });

  it.each([
    ['the switch off', () => writeSettings({ enabled: false, hour: 4 })],
    ['a Postgres bot', () => setBackendKind('postgres')],
  ] as const)('with %s: no take, no prune, no test, no alert, and watchingSince stays unset', async (_t, close) => {
    const m = fresh();
    close();
    const probe = vi.spyOn(m, 'routeProbe');
    await runTick(m);
    expect(probe).not.toHaveBeenCalled();
    expect(onDisk()).toEqual(defaultState());
    expect(snapshotsDir().filter(n => !n.endsWith('.json'))).toEqual([]);
  });

  const standing = (): BackupState => st({
    test: { day: null, running: null, last: { name: 'daily-2026-11-13T04-10-00-000Z', at: NOW - 60_000, result: 'failed', detail: 'x.' }, lastPassed: null },
    alerts: {
      'test-failed': { since: NOW - 60_000, key: 'k1', text: 'The test failed.', message: { state: 'sent', at: NOW - 60_000, place: 'dm' } },
      'snapshot-failed': { since: NOW - 60_000, key: 'k2', text: 'No backup.', message: { state: 'failed', at: NOW - 2 * 3_600_000, error: 'e' } },
    },
  });

  it('D4 (fix 13): a bot that is not a JSON bot clears both standing alerts once, with nothing sent; the badge goes', async () => {
    writeState(standing());
    const m = fresh();
    expect(m.getStatus().backups.alert).toEqual({ case: 'snapshot-failed', text: 'No backup.' });
    setBackendKind('postgres');
    await runTick(m);
    expect(onDisk().alerts).toEqual({});
    expect(onDisk().test.last?.result).toBe('failed');
    expect(owner.posts).toEqual([]);
    expect(m.getStatus().backups.alert).toBeNull();
    const before = fs.statSync(statePath()).mtimeMs;
    const bytes = fs.readFileSync(statePath(), 'utf8');
    setClock(NOW + 60_000);
    await runTick(m);
    expect(fs.readFileSync(statePath(), 'utf8')).toBe(bytes);
    expect(fs.statSync(statePath()).mtimeMs).toBe(before);
  });

  it('D4 (fix 13): the switch turned off clears no alert', async () => {
    writeState(standing());
    writeSettings({ enabled: false, hour: 4 });
    await runTick(fresh());
    expect(Object.keys(onDisk().alerts).sort()).toEqual(['snapshot-failed', 'test-failed']);
    expect(owner.posts).toEqual([]);
  });

  it('a data migration that runs: no take, and nothing written but watchingSince', async () => {
    const m = fresh();
    m.takeMigrationLock({ jobId: 'job-held-0001', to: 'postgres' } as any);
    const probe = vi.spyOn(m, 'routeProbe');
    await runTick(m);
    m.releaseMigrationLock();
    expect(probe).not.toHaveBeenCalled();
    expect(onDisk()).toEqual({ ...defaultState(), watchingSince: near(NOW) });
  });

  it.each([
    ['the switch off', () => writeSettings({ enabled: false, hour: 4 })],
    ['a Postgres bot', () => setBackendKind('postgres')],
    ['a data migration', (m: BotManager) => m.takeMigrationLock({ jobId: 'job-held-0001', to: 'postgres' } as any)],
  ] as Array<[string, (m: BotManager) => void]>)('step 8 of a placed restore runs with %s', async (_t, close) => {
    const m = fresh();
    const j = placedRestore();
    close(m);
    await runTick(m);
    m.releaseMigrationLock();
    expect(readRestoreJournal()).toMatchObject({ state: 'read', journal: { stage: 'done' } });
    expect(readSnapshot(j.preRestore).state).toBe('complete');
  });

  it.each([
    ['a restore op runs', () => setRestoreOp({ kind: 'restore', name: 'daily-x' })],
    ['the latch is set', () => setRestoreLatch({ at: 1, name: 'daily-x', kind: 'journal', stage: 'swapping', errno: 'EIO' })],
  ] as const)('step 8 does not run while %s', async (_t, close) => {
    const m = fresh();
    placedRestore();
    close();
    await runTick(m);
    expect(readRestoreJournal()).toMatchObject({ state: 'read', journal: { stage: 'placed' } });
  });

  const closedGates: Array<[string, () => void]> = [
    ['running', () => setRestoreOp({ kind: 'restore', name: 'daily-x' })],
    ['stuck', () => writeRestoreJournal({ ...journal('stuck'), stuckAt: 'swapping', cause: 'rename', path: '/data/123', errno: 'EIO' })],
    ['unfinished', () => writeRestoreJournal(journal('swapping'))],
    ['unknown', () => { fs.mkdirSync(dataPath('_snapshots'), { recursive: true }); fs.writeFileSync(restoreJournalPath(), '{'); }],
  ];

  it.each(closedGates)('T1.c: the gate %s with a take due: one probe, no attempt, the refusal words; no prune or test; the alerts run', async (_t, close) => {
    const m = fresh();
    const old = await taken(m, 'hourly', OLD_HOURLY);
    await taken(m, 'daily', DAILY);
    writeState({ ...defaultState(), test: { day: null, running: null, last: { name: 'daily-x', at: 1, result: 'failed', detail: 'x.' }, lastPassed: null } });
    close();
    const gate = restoreGate();
    const probe = vi.spyOn(m, 'routeProbe');
    await runTick(m);
    expect(probe).toHaveBeenCalledTimes(1);
    const state = onDisk();
    expect(state.lastAttempt).toBeNull();
    expect(state.lastRefusal).toEqual({ at: near(NOW), words: gateTakeWords(gate as Exclude<typeof gate, { state: 'clear' }>) });
    expect(readSnapshot(old).state).toBe('complete');
    expect(state.test.running).toBeNull();
    expect(snapshotsDir().some(n => n.startsWith('.test-'))).toBe(false);
    expect(owner.posts.map(p => p.key)).toEqual([expect.stringMatching(/^bot-backup:test-failed:2026-11-13T10:30:/)]);
  });

  it('the tick while main() waits for a held lock: the running refusal, and no step 8', async () => {
    const m = fresh();
    writeRestoreJournal(journal('swapping'));
    setRestoreOp({ kind: 'recovery', name: journal('swapping').name, waiting: { cause: 'held', holder: { role: 'import', pid: 4242 } } });
    await runTick(m);
    expect(onDisk().lastRefusal).toEqual({ at: near(NOW), words: 'a backup restore was starting or running.' });
    expect(readRestoreJournal()).toMatchObject({ state: 'read', journal: { stage: 'swapping' } });
  });

  it("L3: this boot's disk error record: no take runs, and the refusal names the machine's restart", async () => {
    _setBootIdForTests('b1');
    setDiskRole('web panel');
    setClock(at(13, 10, 20));
    noteFolderSyncFailure(dataPath('123'), 'EIO');
    resetFolderSyncFailureForTests();
    _setBootIdForTests('b1');
    setDiskRole('web panel');
    expect(folderSyncFlag()).toMatchObject({ source: 'record' });
    setClock(NOW);
    const m = fresh();
    const probe = vi.spyOn(m, 'routeProbe');
    await runTick(m);
    expect(probe).not.toHaveBeenCalled();
    expect(onDisk().lastAttempt).toBeNull();
    expect(onDisk().lastRefusal).toEqual({
      at: near(NOW),
      words: `the data disk reported an error when /data/123 was synced at ${timeText(at(13, 10, 20))} (EIO), so no backup is taken until the machine the bot runs on is restarted (a restart of the bot's container is not enough after a disk error); check the disk first.`,
    });
    expect((await listSnapshots()).length).toBe(0);
  });

  it('T5.c (child): the take is sent with the due name; backupWorkRunning() is take until the answer, then ok is recorded', async () => {
    let during: unknown = 'unset';
    const host = childHost(async (req: { name: string; kind: 'hourly' | 'daily' }) => {
      during = backupWorkRunning();
      return took(req);
    });
    await runTick(host);
    const name = (host.sent[0] as { name: string }).name;
    expect(host.sent).toEqual([{ name: tickName('daily'), kind: 'daily' }]);
    expect(during).toBe('take');
    expect(backupWorkRunning()).toBeNull();
    expect(onDisk().lastAttempt).toEqual({ name, at: near(NOW), result: 'ok', tries: 1 });
  });

  it.each([
    ['failed', { ok: false, error: 'Could not read /data/123/mod/a.json (EIO); the backup was not kept.' }, { result: 'failed', error: 'Could not read /data/123/mod/a.json (EIO); the backup was not kept.' }, null],
    ['stopping', { ok: false, stopping: true }, null, { words: 'the bot began stopping during the backup.', startedAt: near(NOW) }],
    ['busy', { ok: false, busy: true }, null, { words: 'the bot was still taking the previous backup.' }],
    ['lockLost', { ok: false, lockLost: true, words: "the data files' lock (/data/.writer.lock) was removed or changed during the backup." }, null, { words: "the data files' lock (/data/.writer.lock) was removed or changed during the backup.", startedAt: near(NOW) }],
    ['the 12-minute timeout', { ok: false, unknown: true, error: "can't confirm whether the backup was taken: the bot did not answer within 12 minutes." }, { result: 'unknown', error: "can't confirm whether the backup was taken: the bot did not answer within 12 minutes." }, null],
  ] as Array<[string, Next, object | null, object | null]>)('T5.f: the child answers %s', async (_t, answer, attempt, refused) => {
    await runTick(childHost(answer));
    const state = onDisk();
    expect(state.lastAttempt).toEqual(attempt ? { name: tickName('daily'), at: near(NOW), tries: 1, ...attempt } : null);
    expect(state.lastRefusal).toEqual(refused ? { at: near(NOW), ...refused } : null);
  });

  it('T5.f: a take request that never reached the bot: no attempt, the refusal names the error, and the log line', async () => {
    await runTick(childHost({ ok: false, notSent: true, error: 'The bot process is not running' } as unknown as Next));
    expect(onDisk().lastAttempt).toBeNull();
    expect(onDisk().lastRefusal).toEqual({ at: near(NOW), words: 'the backup request could not be sent to the bot (The bot process is not running).' });
    expect(lines()).toContain('[Backup] No backup was started: the backup request could not be sent to the bot (The bot process is not running).');
  });

  it('B2 (fix 3B): an EACCES list read for over 3 hours raises the alert with its words; the next good read takes a backup', async () => {
    const m = fresh();
    const readdir = fs.promises.readdir.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, 'readdir').mockImplementation((async (p: fs.PathLike, o?: any) => {
      if (String(p) === dataPath('_snapshots')) throw err('EACCES');
      return readdir(p, o);
    }) as typeof fs.promises.readdir);
    const HOUR = 60 * 60 * 1000;
    for (const t of [NOW, NOW + HOUR, NOW + 2 * HOUR, NOW + 3 * HOUR, NOW + 3 * HOUR + 60_000]) {
      setClock(t);
      await runTick(m);
    }
    const words = 'the backup folder (/data/_snapshots) could not be read (EACCES).';
    expect(owner.posts.length).toBe(1);
    expect(owner.posts[0].text).toBe(`No backup of this bot's data has succeeded since the web panel began backing it up at ${timeText(NOW)}. No backup could be started at ${timeText(NOW + 3 * HOUR + 60_000)}: ${words} The Dashboard tab of the bot's web panel lists the backups.`);
    expect(onDisk().lastAttempt).toBeNull();
    expect(lines().filter(l => l.includes(words)).length).toBe(1);
    spy.mockRestore();
    setClock(NOW + 3 * HOUR + 120_000);
    await runTick(m);
    const name = onDisk().lastAttempt?.name ?? '';
    expect(onDisk().lastAttempt).toMatchObject({ result: 'ok' });
    expect(readSnapshot(name).state).toBe('complete');
  });

  /** Makes the list reads of _snapshots throw EIO from the call of `failAfter()` on. */
  function listFailsAfterTake(): { failAfter: () => void } {
    let failing = false;
    const readdir = fs.promises.readdir.bind(fs.promises);
    vi.spyOn(fs.promises, 'readdir').mockImplementation((async (p: fs.PathLike, o?: any) => {
      if (failing && String(p) === dataPath('_snapshots')) throw err('EIO');
      return readdir(p, o);
    }) as typeof fs.promises.readdir);
    return { failAfter: () => { failing = true; } };
  }

  it('B4-1 (fix 3B b): the list read after an ok take throws: the backup-list line, no refusal, no "No backup was started"', async () => {
    const list = listFailsAfterTake();
    await runTick(childHost(async (req: { name: string; kind: 'hourly' | 'daily' }) => {
      const answer = await took(req);
      list.failAfter();
      return answer;
    }));
    expect(onDisk().lastAttempt).toMatchObject({ name: tickName('daily'), result: 'ok' });
    expect(onDisk().lastRefusal).toBeNull();
    expect(lines()).toContain('[Backup] The backup list could not be read (EIO); the prune and the test wait for the next tick.');
    expect(lines().some(l => l.startsWith('[Backup] No backup was started'))).toBe(false);
  });

  it('B4-2 (fix 3B b): no backup for over 3 hours, an ok take, then the list read throws: no snapshot-failed DM', async () => {
    const HOUR = 60 * 60 * 1000;
    setClock(NOW - 3 * HOUR - 2 * 60_000);
    await runTick(childHost({ ok: false, busy: true }));
    expect(onDisk().watchingSince).toEqual(near(NOW - 3 * HOUR - 2 * 60_000));
    const list = listFailsAfterTake();
    setClock(NOW);
    await runTick(childHost(async (req: { name: string; kind: 'hourly' | 'daily' }) => {
      const answer = await took(req);
      list.failAfter();
      return answer;
    }));
    expect(onDisk().lastAttempt).toMatchObject({ name: tickName('daily'), result: 'ok' });
    expect(owner.posts).toEqual([]);
    expect(onDisk().alerts['snapshot-failed']).toBeUndefined();
  });

  it("T5.f: the child's diskFlag: no attempt, C20's words, and the web panel's flag noted from the report", async () => {
    _setBootIdForTests('b1');
    const flag = { dir: '/data/123', errno: 'EIO', at: at(13, 10, 0), by: 'bot', files: [], unreadable: false };
    await runTick(childHost({ ok: false, diskFlag: flag } as TakeAnswer));
    expect(onDisk().lastAttempt).toBeNull();
    expect(onDisk().lastRefusal?.words).toBe(`the data disk reported an error when /data/123 was synced at ${timeText(at(13, 10, 0))} (EIO), so no backup is taken until the machine the bot runs on is restarted (a restart of the bot's container is not enough after a disk error); check the disk first.`);
    expect(folderSyncFlag()).toMatchObject({ dir: '/data/123', errno: 'EIO', source: 'report', by: 'bot' });
  });

  it('T5.w: the child stopped before answering; a later tick that finds the backup complete records it ok and logs it', async () => {
    const m = fresh();
    await runTick(childHost({ ok: false, unknown: true, error: "can't confirm whether the backup was taken: the bot stopped before answering." }));
    const name = onDisk().lastAttempt?.name ?? '';
    expect(onDisk().lastAttempt).toMatchObject({ name: tickName('daily'), result: 'unknown' });
    expect(await takeSnapshotLocal({ name, kind: 'daily' }, m)).toMatchObject({ ok: true });
    setClock(NOW + 60_000);
    await runTick(childHost());
    expect(onDisk().lastAttempt).toEqual({ name, at: near(NOW), result: 'ok', tries: 1 });
    expect(lines()).toContain(`[Backup] Took ${name} (found complete after the bot stopped before answering)`);
  });

  it('decision 23: a take that could not catch up is tried at the next tick, at most 3 times in the hour', async () => {
    const cap = 'The data kept changing faster than one backup step can copy (200 files, 1.0 MiB in the last of 10 catch-up passes, the largest /data/123/mod/a.json at 0.1 MiB; the limit is 128 files and 64.0 MiB); the backup was not kept.';
    const host = childHost(...[1, 2, 3].map(() => ({ ok: false, error: cap, cause: 'writes' }) as TakeAnswer));
    const errorsOf: string[] = [];
    for (let i = 0; i < 4; i++) {
      setClock(NOW + i * 60_000);
      await runTick(host);
      errorsOf.push(onDisk().lastAttempt?.error ?? '');
    }
    expect(host.sent.length).toBe(3);
    expect(errorsOf.slice(0, 3)).toEqual([`${cap} It is tried again in a minute.`, `${cap} It is tried again in a minute.`, `${cap} It is tried again at the next hour.`]);
    expect(onDisk().lastAttempt).toMatchObject({ cause: 'writes', tries: 3 });
  });

  it('T5.d: a state.json write that throws is logged, kept in memory and written at the next tick', async () => {
    const real = fs.renameSync;
    let fail = true;
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (fail && String(to) === statePath()) throw err('EIO');
      return real(from, to);
    }) as typeof fs.renameSync);
    syncBuiltinESMExports();
    const host = childHost(took);
    await runTick(host);
    expect(fs.existsSync(statePath())).toBe(false);
    expect(logged(errors)).toContain('[Backup] The backup record (/data/_snapshots/state.json) could not be written (EIO: stubbed); the web panel keeps the change in memory and writes it at its next check.');
    fail = false;
    setClock(NOW + 60_000);
    await runTick(host);
    expect(host.sent.length).toBe(1);
    expect(onDisk().lastAttempt).toEqual({ name: tickName('daily'), at: near(NOW), result: 'ok', tries: 1 });
  });

  it('T1.f: settings.json cannot be read: the take runs, the prune does not, and the note is logged once', async () => {
    const m = fresh();
    const old = await taken(m, 'hourly', OLD_HOURLY);
    fs.writeFileSync(settingsPath(), 'not json');
    await runTick(m);
    setClock(NOW + 60_000);
    await runTick(m);
    expect(readSnapshot(onDisk().lastAttempt?.name ?? '').state).toBe('complete');
    expect(readSnapshot(old).state).toBe('complete');
    expect(lines().filter(l => l === `[Backup] ${settingsUnreadableText('not valid JSON')}`).length).toBe(1);
  });

  it('T1.f: state.json cannot be read: the take runs, the prune does not, the note is logged and the file is left as it is', async () => {
    const m = fresh();
    const old = await taken(m, 'hourly', OLD_HOURLY);
    fs.writeFileSync(statePath(), 'not json');
    await runTick(m);
    expect((await listSnapshots()).map(s => s.name)).toContainEqual(tickName('daily'));
    expect(readSnapshot(old).state).toBe('complete');
    expect(lines()).toContain(`[Backup] ${stateUnreadableText('not valid JSON')}`);
    expect(fs.readFileSync(statePath(), 'utf8')).toBe('not json');
    setClock(NOW + 60_000);
    const probe = vi.spyOn(m, 'routeProbe');
    await runTick(m);
    expect(probe).not.toHaveBeenCalled();
  });

  it.each([
    ['an attempt', took,
      (s: BackupState) => expect(s.lastAttempt).toEqual({ name: tickName('daily'), at: near(NOW), result: 'ok', tries: 1 })],
    ['a refusal', { ok: false, busy: true },
      (s: BackupState) => expect(s.lastRefusal).toEqual({ at: near(NOW), words: 'the bot was still taking the previous backup.' })],
  ] as Array<[string, Next, (s: BackupState) => void]>)('state.json reads again after %s kept in memory: the file keeps its test record and gains the change', async (_t, answer, gained) => {
    const last = { name: 'daily-2026-11-12T04-00-00-000Z', at: at(12, 4, 30), result: 'passed' as const };
    writeState({ ...defaultState(), test: { day: '2026-11-12', running: null, last, lastPassed: 'daily-2026-11-12T04-00-00-000Z' } });
    const good = fs.readFileSync(statePath(), 'utf8');
    fs.writeFileSync(statePath(), 'not json');
    await runTick(childHost(answer));
    expect(fs.readFileSync(statePath(), 'utf8')).toBe('not json');
    fs.writeFileSync(statePath(), good);
    writeSettings({ enabled: false, hour: 4 });
    setClock(NOW + 60_000);
    await runTick(childHost());
    const s = onDisk();
    expect(s.test).toEqual({ day: '2026-11-12', running: null, last, lastPassed: 'daily-2026-11-12T04-00-00-000Z' });
    gained(s);
  });

  it('a tick while one runs does nothing (single flight)', async () => {
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const host = childHost(async (req: { name: string; kind: 'hourly' | 'daily' }) => {
      await hold;
      return took(req);
    });
    const first = runTick(host);
    await new Promise(r => setTimeout(r, 20));
    await runTick(host);
    release();
    await first;
    expect(host.sent.length).toBe(1);
  });
});

describe('test 11 at the tick: a restore that does not finish raises the snapshot-failed DM after 3 hours', () => {
  beforeEach(() => {
    freshTree();
    setClock(NOW);
    quiet();
  });
  afterEach(endAll);

  it.each([
    ['an unreadable journal', () => { fs.mkdirSync(dataPath('_snapshots'), { recursive: true }); fs.writeFileSync(restoreJournalPath(), '{'); },
      "can't confirm whether a backup restore was running (/data/_snapshots/restore.json: not valid JSON)."],
    ['a stuck journal', () => writeRestoreJournal({ ...journal('stuck'), stuckAt: 'swapping', cause: 'rename', path: '/data/123', errno: 'EIO' }),
      'the last backup restore did not finish.'],
  ] as const)('%s: one DM naming the refusal of its tick', async (_t, close, words) => {
    close();
    const m = fresh();
    const HOUR = 60 * 60 * 1000;
    for (const t of [NOW, NOW + HOUR, NOW + 2 * HOUR, NOW + 3 * HOUR, NOW + 3 * HOUR + 60_000, NOW + 4 * HOUR]) {
      setClock(t);
      await runTick(m);
    }
    expect(owner.posts.length).toBe(1);
    expect(owner.posts[0].text).toBe(`No backup of this bot's data has succeeded since the web panel began backing it up at ${timeText(NOW)}. No backup could be started at ${timeText(NOW + 3 * HOUR + 60_000)}: ${words} The Dashboard tab of the bot's web panel lists the backups.`);
    expect((await listSnapshots()).length).toBe(0);
  });

  it('state.json cannot be read: the alert raised then leaves the file as it is, and the first tick after it reads again writes the alert', async () => {
    writeRestoreJournal({ ...journal('stuck'), stuckAt: 'swapping', cause: 'rename', path: '/data/123', errno: 'EIO' });
    fs.writeFileSync(statePath(), 'not json');
    const m = fresh();
    const HOUR = 60 * 60 * 1000;
    for (const t of [NOW, NOW + HOUR, NOW + 2 * HOUR, NOW + 3 * HOUR, NOW + 3 * HOUR + 60_000]) {
      setClock(t);
      await runTick(m);
    }
    expect(owner.posts.length).toBe(1);
    expect(fs.readFileSync(statePath(), 'utf8')).toBe('not json');
    writeState(defaultState());
    setClock(NOW + 3 * HOUR + 120_000);
    await runTick(m);
    expect(onDisk().alerts['snapshot-failed']).toMatchObject({ key: owner.posts[0].key, message: { state: 'sent' } });
    expect(owner.posts.length).toBe(1);
  });
});

describe("test 12 at the tick: step 8's sync error latches, and a fresh module's tick reruns step 8", () => {
  beforeEach(() => {
    freshTree();
    quiet();
  });
  afterEach(endAll);

  it('EIO on the sync after the rename: the latch, no done; the next process syncs, then writes done only', async () => {
    const j = placedRestore();
    const host = childHost();
    vi.spyOn(host, 'routeProbe').mockReturnValue({ words: 'the bot was stopping.' } as never);
    h.syncFolder = (dir: string) => (dir === dataPath('_snapshots') ? { failed: true, kind: 'sync', dir, errno: 'EIO', error: err('EIO') } : null);
    await runTick(host);
    expect(restoreLatch()).toMatchObject({ kind: 'fsync', stage: 'placed', errno: 'EIO' });
    expect(readRestoreJournal()).toMatchObject({ state: 'read', journal: { stage: 'placed' } });
    expect(readSnapshot(j.preRestore).state).toBe('complete');
    const manifest = fs.readFileSync(dataPath('_snapshots', j.preRestore, 'manifest.json'), 'utf8');

    const synced: string[] = [];
    h.syncFolder = (dir: string) => { synced.push(dir); return null; };
    vi.resetModules();
    const scheduler = await import('../../src/webui/backups/scheduler');
    await scheduler.runTick(host);
    scheduler._resetSchedulerForTests();
    expect(synced).toContain(dataPath('_snapshots'));
    expect(readRestoreJournal()).toMatchObject({ state: 'read', journal: { stage: 'done', result: 'done' } });
    expect(fs.readFileSync(dataPath('_snapshots', j.preRestore, 'manifest.json'), 'utf8')).toBe(manifest);
  });
});
