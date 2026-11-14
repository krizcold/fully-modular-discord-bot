import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB8 test 14, BotManager's rows (decisions 47, 56, 62, 65, 70, C13, C15, C19, E2, F1, F2): the start gate and the
// starts it refuses during a POST's op, restart() and requestRestart() before any stop, the standby and the retire,
// backupRefusal(), getStatus().backups, and the restore op's helpers (runRestoreOp, shutdown()'s answer,
// awaitNoChildren). The op's start at its end is part 11's (restore.ts).

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
const testPost = vi.hoisted(() => ({ posts: 0, during: null as null | (() => void) }));
vi.mock('../../src/utils/ownerMessages', async orig => {
  const real = await orig<typeof import('../../src/utils/ownerMessages')>();
  const postInPlace = async (place: { id?: string }) => {
    testPost.posts++;
    testPost.during?.();
    return { ok: true, channelId: place.id, messageId: 'm1', askedChannel: place.id };
  };
  return { ...real, postInPlace };
});

import { BotManager, b6Line, b8Line } from '../../src/webui/botManager';
import { createManagedRoutes } from '../../src/webui/routes/managed';
import { ownerChannelFile, putOwnerChannel, _resetOwnerChannel } from '../../src/webui/utils/ownerChannel';
import { migrationState } from '../../src/bot/internalSetup/utils/dataMigration';
import { readDataFacts } from '../../src/bot/internalSetup/utils/dataBackends/recognitionGuard';
import { maintenanceFilePath, writeMaintenanceFile } from '../../src/utils/maintenanceFile';
import { FakeDb } from '../helpers/fakePg';
import { FakeHost, JOURNAL, MARKER, PG_URL, freshJsonBot, seedFile, serviceFor, useDatabaseUrl, wipeRoot, writeJson } from '../helpers/migrationRig';
import { call, startApp } from '../helpers/configRig';
import { writeRestoreJournal, writeState, defaultState, readState } from '../../src/webui/backups/state';
import { runTick, _resetSchedulerForTests } from '../../src/webui/backups/scheduler';
import { listSnapshots } from '../../src/bot/internalSetup/utils/backups/snapshotList';
import { _resetRestoreStateForTests, restoreOp, setBackupWorkRunning, setRestoreOp } from '../../src/webui/backups/restoreState';
import { restoreJournalPath, type RestoreStage } from '../../src/bot/internalSetup/utils/backups/restoreJournal';
import { EXIT_DEPOSED } from '../../src/bot/internalSetup/utils/dataManager';
import { releaseWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { dataPath } from '../../src/utils/dataRoot';
import { forks, forkStage } from '../helpers/forkMock';
import { exitChild, freshWriterLock, logged, resetForks, sentTo, tick } from '../helpers/nb10Rig';
import { bundleRefusal, importBundle } from '../../src/bot/internalSetup/utils/dataInterchange';
import { setBackendKind } from '../helpers/backendKind';

const NAME = 'hourly-2026-11-13T04-00-00-000Z';
const STOPPED_LINE = `[Backup] Restore of ${NAME}: the bot stopped during the restore and was not started again; the restore starts it when it finishes; if the restore stops part way, the bot starts once a restart of the bot's container has finished the restore`;
const RESTART_TEXT = {
  running: 'A backup restore is running, so the bot was not restarted; it was not stopped. Restart it once the restore has finished.',
  stuck: 'The last backup restore stopped part way, so the bot was not restarted; it was not stopped. The Dashboard tab says what to do.',
  unknown: "can't confirm whether a backup restore is running (/data/_snapshots/restore.json: not valid JSON), so the bot was not restarted; it was not stopped.",
};
const BEGAN_TEXT = 'A backup restore began while the bot restarted: the bot was stopped, and the restore starts it again when it finishes.';
const GATE_REASON = 'a backup restore is running or did not finish';

let warn: ReturnType<typeof vi.spyOn>;
let log: ReturnType<typeof vi.spyOn>;
let managers: BotManager[] = [];

function journal(stage: RestoreStage | 'unreadable'): void {
  if (stage === 'unreadable') {
    fs.mkdirSync(dataPath('_snapshots'), { recursive: true });
    fs.writeFileSync(restoreJournalPath(), '{"format":1,"stage":');
    return;
  }
  writeRestoreJournal({ format: 1, name: NAME, startedAt: 1, stage, staging: '.restore-x', preRestore: 'pre-restore-x' });
}

/** The state a POST's first turn leaves: restoreOp of kind restore. */
const postOp = () => setRestoreOp({ kind: 'restore', name: NAME });

function fresh(): BotManager {
  const manager = new BotManager();
  managers.push(manager);
  return manager;
}

const lines = (): string[] => [...logged(log), ...logged(warn)];

async function started(manager = fresh()): Promise<{ manager: BotManager; child: any }> {
  const result = await manager.start();
  expect(result.success).toBe(true);
  await tick(5);
  return { manager, child: forks.children.at(-1) };
}

/** start() under fake timers: its readiness wait polls every 500 ms. */
async function startedFake(manager = fresh()): Promise<{ manager: BotManager; child: any }> {
  const pending = manager.start();
  await vi.advanceTimersByTimeAsync(600);
  expect((await pending).success).toBe(true);
  return { manager, child: forks.children.at(-1) };
}

beforeEach(() => {
  resetForks();
  forkStage.stages = ['shared', 'guild'];
  freshWriterLock('webui');
  _resetRestoreStateForTests();
  fs.rmSync(dataPath('_snapshots'), { recursive: true, force: true });
  fs.rmSync(dataPath('maintenance.json'), { force: true });
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  managers = [];
});

afterEach(() => {
  vi.useRealTimers();
  for (const manager of managers) manager.cancelCrashRestart();
  for (const child of forks.children) if (child.exitCode === null && child.signalCode === null) exitChild(child, 0);
  while (writerLockDepth() > 0) releaseWriterLock();
  _resetRestoreStateForTests();
  vi.restoreAllMocks();
});

describe("the automatic starts refused during a POST's op (C13, decisions 56 and 65)", () => {
  const cases: Array<[string, (m: BotManager, child: any) => Promise<void>]> = [
    ['the deposed-exit timer', async (_m, child) => {
      postOp();
      exitChild(child, EXIT_DEPOSED);
      await vi.advanceTimersByTimeAsync(5_100);
    }],
    ['the crash timer', async (_m, child) => {
      postOp();
      exitChild(child, 1);
      await vi.advanceTimersByTimeAsync(5_100);
    }],
    ["the deferred crash start at the migration lock's release", async (m, child) => {
      m.takeMigrationLock({ jobId: 'j1', to: 'postgres' } as any);
      exitChild(child, 1);
      await vi.advanceTimersByTimeAsync(5_100);
      postOp();
      m.releaseMigrationLock();
      await vi.advanceTimersByTimeAsync(10);
    }],
    ["promote()'s start after a retire that began before the POST", async (_m, child) => {
      forks.holdExit = true;
      child.emit('message', { type: 'control:reshard-retire', data: { attempt: 'a-1' } });
      await vi.advanceTimersByTimeAsync(10);
      postOp();
      exitChild(child, 0);
      await vi.advanceTimersByTimeAsync(10);
    }],
    ['the restart start left for after a migration', async (m, child) => {
      forks.holdExit = true;
      const restarting = m.restart();
      await vi.advanceTimersByTimeAsync(10);
      m.takeMigrationLock({ jobId: 'j1', to: 'postgres' } as any);
      exitChild(child, 0);
      await vi.advanceTimersByTimeAsync(10);
      expect((await restarting).reason).toBe('migration_running');
      postOp();
      m.releaseMigrationLock();
      await vi.advanceTimersByTimeAsync(10);
    }],
  ];

  it.each(cases)('%s: refused, stopped set and logged', async (_name, run) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { manager, child } = await startedFake();
    const before = forks.children.length;
    await run(manager, child);
    expect(forks.children).toHaveLength(before);
    expect(restoreOp()?.stopped).toBe(true);
    expect(lines().filter(l => l === STOPPED_LINE)).toHaveLength(1);
  });

  it('a crash start refused unknown during the op sets stopped too', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { child } = await startedFake();
    journal('unreadable');
    postOp();
    exitChild(child, 1);
    await vi.advanceTimersByTimeAsync(5_100);
    expect(restoreOp()?.stopped).toBe(true);
    expect(lines()).toContain(STOPPED_LINE);
  });

  it('a crash start refused with no POST op (an unfinished journal) sets nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { child } = await startedFake();
    journal('swapping');
    exitChild(child, 1);
    await vi.advanceTimersByTimeAsync(5_100);
    expect(forks.children).toHaveLength(1);
    expect(restoreOp()).toBeNull();
    expect(lines()).not.toContain(STOPPED_LINE);
  });

  it("an operator's Start during the op is refused and sets nothing", async () => {
    postOp();
    const answer = await fresh().start();
    expect(answer).toEqual({ success: false, reason: 'restoring', error: 'A backup restore is running' });
    expect(restoreOp()?.stopped).toBeUndefined();
    expect(lines()).not.toContain(STOPPED_LINE);
  });
});

describe('restart() and requestRestart() before any stop (decisions 56, 62, 65, 70)', () => {
  const closed: Array<[keyof typeof RESTART_TEXT | 'unfinished', () => void, string]> = [
    ['running', postOp, RESTART_TEXT.running],
    ['stuck', () => journal('stuck'), RESTART_TEXT.stuck],
    ['unfinished', () => journal('swapping'), RESTART_TEXT.stuck],
    ['unknown', () => journal('unreadable'), RESTART_TEXT.unknown],
  ];

  it.each(closed)('restart() with a child, the gate %s: its text and no stop', async (_answer, close, text) => {
    const { manager, child } = await started();
    close();
    expect(await manager.restart()).toEqual({ success: false, reason: 'restoring', error: text });
    expect(child.signals).toEqual([]);
    expect(manager.isRunning()).toBe(true);
    expect(restoreOp()?.stopped).toBeUndefined();
  });

  it('requestRestart() is refused in its first turn, with nothing queued', async () => {
    const { manager, child } = await started();
    postOp();
    const answer = manager.requestRestart();
    expect((manager as any).queuedRestart).toBeNull();
    expect(await answer).toEqual({ success: false, reason: 'restoring', error: RESTART_TEXT.running });
    expect(child.signals).toEqual([]);
  });

  it('requestRestart() is refused at its queue turn when the gate closed while it waited', async () => {
    const { manager, child } = await started();
    (manager as any).operationInProgress = true;
    const answer = manager.requestRestart();
    await tick(20);
    postOp();
    (manager as any).operationInProgress = false;
    expect(await answer).toEqual({ success: false, reason: 'restoring', error: RESTART_TEXT.running });
    expect(child.signals).toEqual([]);
  });

  it('a restart whose stop began before the POST: its start refused, stopped set, the began text; a joined restart too', async () => {
    const { manager, child } = await started();
    forks.holdExit = true;
    const first = manager.restart();
    const joined = manager.restart();
    await tick(5);
    expect(child.signals).toEqual(['SIGTERM']);
    postOp();
    exitChild(child, 0);
    expect(await first).toEqual({ success: false, reason: 'restoring', error: BEGAN_TEXT });
    expect(await joined).toEqual({ success: false, reason: 'restoring', error: BEGAN_TEXT });
    expect(restoreOp()?.stopped).toBe(true);
    expect(forks.children).toHaveLength(1);
  });
});

describe('the standby and the retire while the gate is closed (C19)', () => {
  it("a standby ask is refused 'passing' and nothing is forked", async () => {
    const { manager, child } = await started();
    manager.noteMemoryReading({ room: true, useMb: 300, freeMb: 900, at: new Date().toISOString() });
    journal('stuck');
    child.emit('message', { type: 'control:reshard-standby', data: { attempt: 'a-1', to: 8, intents: 513, maxConcurrency: 1, json: true } });
    await tick(5);
    expect(sentTo(child, 'reshard:standby-state').map(m => m.data)).toEqual([{ attempt: 'a-1', state: 'refused', kind: 'passing', reason: GATE_REASON }]);
    expect(forks.children).toHaveLength(1);
  });

  it('a retire is held with the b8 line once, and nothing is stopped', async () => {
    const { child } = await started();
    postOp();
    child.emit('message', { type: 'control:reshard-retire', data: { attempt: 'a-1' } });
    child.emit('message', { type: 'control:reshard-retire', data: { attempt: 'a-1' } });
    await tick(5);
    expect(logged(warn).filter(l => l === b8Line(GATE_REASON))).toHaveLength(1);
    expect(child.signals).toEqual([]);
  });
});

describe('backupRefusal() (C15)', () => {
  const RUNNING = 'A backup restore is running or did not finish; start the migration once it has finished.';
  const cases: Array<[string, () => void, string | null]> = [
    ['the gate clear and no backup work', () => undefined, null],
    ['a restore op', postOp, RUNNING],
    ['a stuck journal', () => journal('stuck'), RUNNING],
    ['an unreadable journal', () => journal('unreadable'), "can't confirm the state of the last backup restore: /data/_snapshots/restore.json cannot be read (not valid JSON). The bot does not start until it can be read; if no restore ran, remove that file."],
    ['a take running', () => setBackupWorkRunning('take'), 'A backup is being taken now; start the migration once it has finished.'],
    ['the daily test running', () => setBackupWorkRunning('test'), null],
  ];
  it.each(cases)('%s', (_name, set, expected) => {
    set();
    expect(fresh().backupRefusal()).toBe(expected);
  });
});

describe('getStatus().backups', () => {
  it("names the standing alert from state.json, and none while that file cannot be read", () => {
    const state = defaultState();
    state.alerts['snapshot-failed'] = { since: 1, key: 'k', text: 'No backup of this bot has succeeded.', message: { state: 'sent' } };
    writeState(state);
    expect(fresh().getStatus().backups).toEqual({ alert: { case: 'snapshot-failed', text: 'No backup of this bot has succeeded.' }, restoring: false });
    fs.writeFileSync(dataPath('_snapshots', 'state.json'), '{');
    expect(fresh().getStatus().backups).toEqual({ alert: null, restoring: false });
  });
});

describe("the restore op's helpers (decisions 27, 29, C19, E2, F1, F2)", () => {
  it('runRestoreOp takes the lock in its turn, runs the op inside the chain and releases the lock', async () => {
    const manager = fresh();
    let depth = -1;
    const answer = manager.runRestoreOp(async () => { depth = writerLockDepth(); return 'done'; });
    expect(fs.existsSync(writerLockPath())).toBe(true);
    expect(await answer).toEqual({ taken: true, value: 'done' });
    expect(depth).toBe(1);
    expect(fs.existsSync(writerLockPath())).toBe(false);
  });

  it('runRestoreOp runs nothing when another live process holds the lock', async () => {
    freshWriterLock('webui', new Set([process.pid, 4242]));
    fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: 4242, start: null, role: 'import', at: Date.now() }));
    let ran = false;
    const answer = await fresh().runRestoreOp(async () => { ran = true; });
    expect(answer).toEqual({ taken: false, take: { kind: 'held', holder: { pid: 4242, start: null, role: 'import', at: expect.any(Number) } } });
    expect(ran).toBe(false);
  });

  it('a child that outlived its kill: shutdown answers killed, and runRestoreOp releases the lock and names that child', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { manager, child } = await startedFake();
    forks.holdExit = true;
    const stop = manager.shutdown(false);
    await vi.advanceTimersByTimeAsync(46_000);
    expect(await stop).toEqual({ killed: true });
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    let ran = false;
    const answer = await manager.runRestoreOp(async () => { ran = true; });
    expect(answer).toEqual({ taken: false, take: { kind: 'previous', pid: child.pid } });
    expect(ran).toBe(false);
    expect(fs.existsSync(writerLockPath())).toBe(false);
  });

  it('shutdown answers killed false for a child that stopped by itself', async () => {
    const { manager } = await started();
    expect(await manager.shutdown(false)).toEqual({ killed: false });
  });

  it('awaitNoChildren stops a standby, answers running while the bot runs, and gone once every child exited', async () => {
    const { manager, child } = await started();
    manager.noteMemoryReading({ room: true, useMb: 300, freeMb: 900, at: new Date().toISOString() });
    child.emit('message', { type: 'control:reshard-standby', data: { attempt: 'a-1', to: 8, intents: 513, maxConcurrency: 1, json: true } });
    await tick(5);
    const standby = forks.children.at(-1);
    expect(standby).not.toBe(child);
    expect(await manager.awaitNoChildren(Date.now() + 20)).toBe('running');
    expect(logged(warn)).toContain(b6Line('a backup restore is starting'));
    expect(standby.signals).toContain('SIGTERM');
    await manager.shutdown(false);
    expect(await manager.awaitNoChildren(Date.now() + 5_000)).toBe('gone');
  });

  it("awaitNoChildren answers channel when a child exited with its channel still open, running when one has not exited", async () => {
    const { manager, child } = await started();
    forks.holdExit = true;
    child.connected = true;
    expect(await manager.awaitNoChildren(Date.now() + 50)).toBe('running');
    child.exitCode = 0;
    child.emit('exit', 0, null);
    expect(await manager.awaitNoChildren(Date.now() + 50)).toBe('channel');
    child.connected = false;
    child.emit('disconnect');
    expect(await manager.awaitNoChildren(Date.now() + 50)).toBe('gone');
  });

  it("awaitNoChildren answers gone for a child whose spawn failed with 'error' and no 'exit'", async () => {
    const { manager, child } = await started();
    forks.holdExit = true;
    child.exitCode = -11;
    child.connected = false;
    child.emit('error', Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' }));
    expect(await manager.awaitNoChildren(Date.now() + 50)).toBe('gone');
  });
});

// Part 8a: the gates outside BotManager (decisions 44, 47 and 54, C14 to C16).

const CLOSED: Array<['running' | 'stuck' | 'unfinished' | 'unknown', () => void]> = [
  ['running', postOp],
  ['stuck', () => journal('stuck')],
  ['unfinished', () => journal('swapping')],
  ['unknown', () => journal('unreadable')],
];

describe("the maintenance hook 'running' (decisions 44, 47 and 54)", () => {
  const TOKEN = 'nb8-token';
  const WRITE_TEXT = {
    running: 'A backup restore is running; nothing was saved. Save again once it has finished.',
    stuck: 'The last backup restore stopped part way; nothing was saved. The Dashboard tab says what to do.',
    unfinished: 'The last backup restore stopped part way; nothing was saved. The Dashboard tab says what to do.',
    unknown: "can't confirm whether a backup restore is running (/data/_snapshots/restore.json: not valid JSON); nothing was saved. Save again once that file can be read.",
  };
  const bot = { enter: vi.fn(async (_text: string) => ({ saved: true })), leave: vi.fn(async () => ({ restarting: true })) };
  const fakeBot = {
    isServingNormally: () => false,
    migrationRunning: () => null,
    enterMaintenance: (text: string) => bot.enter(text),
    leaveMaintenance: () => bot.leave(),
  } as unknown as BotManager;
  let app: { url: string; close: () => Promise<void> };

  beforeEach(async () => {
    process.env.BOT_MANAGER_UPDATE_TOKEN = TOKEN;
    app = await startApp(a => a.use('/api/managed', createManagedRoutes(fakeBot)));
    bot.enter.mockClear();
    bot.leave.mockClear();
    writeMaintenanceFile('maintenance', 'Restoring.');
  });
  afterEach(async () => {
    await app.close();
    delete process.env.BOT_MANAGER_UPDATE_TOKEN;
    fs.rmSync(maintenanceFilePath(), { force: true });
  });

  const hook = async (state: string) => {
    const res = await fetch(`${app.url}/api/managed/maintenance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bot-token': TOKEN },
      body: JSON.stringify({ state }),
    });
    return { status: res.status, body: await res.json() };
  };

  it.each(CLOSED)('the gate %s: 409 with its text, maintenance.json and the bot unchanged', async (answer, close) => {
    const before = fs.readFileSync(maintenanceFilePath(), 'utf-8');
    close();
    expect(await hook('running')).toEqual({ status: 409, body: { success: false, error: WRITE_TEXT[answer] } });
    expect(fs.readFileSync(maintenanceFilePath(), 'utf-8')).toBe(before);
    expect(bot.leave).not.toHaveBeenCalled();
  });

  it("'maintenance' during a restore is not refused", async () => {
    postOp();
    const res = await hook('maintenance');
    expect(res.status).toBe(200);
    expect(bot.enter).toHaveBeenCalledTimes(1);
  });
});

describe("NB5's owner channel PUT (C16, decision 44's NB5 forms)", () => {
  const C = '500000000000000001';
  const D = '500000000000000002';
  const PUT_TEXT = {
    running: 'A backup restore is running; change the setting once it has finished; nothing was changed',
    stuck: 'The last backup restore stopped part way (the Dashboard tab says what to do); change the setting once it has finished; nothing was changed',
    unfinished: 'The last backup restore stopped part way (the Dashboard tab says what to do); change the setting once it has finished; nothing was changed',
    unknown: "can't confirm whether a backup restore is running (/data/_snapshots/restore.json: not valid JSON); change the setting once that file can be read; nothing was changed",
  };
  const PREFIX = `The test message was posted in channel ${C}, but the setting was not saved: `;

  beforeEach(() => {
    _resetOwnerChannel();
    testPost.posts = 0;
    testPost.during = null;
    fs.rmSync(ownerChannelFile(), { force: true });
  });
  afterEach(() => fs.rmSync(ownerChannelFile(), { force: true }));

  it.each(CLOSED)('the gate %s: a channel id is refused before any test post', async (answer, close) => {
    close();
    const manager = fresh();
    expect(await putOwnerChannel(manager, C)).toEqual({ status: 409, body: { success: false, error: PUT_TEXT[answer] } });
    expect(testPost.posts).toBe(0);
    expect(fs.existsSync(ownerChannelFile())).toBe(false);
    expect(manager.ownerChannelWriteSettled()).toBe(true);
  });

  it.each(CLOSED)('the gate %s: a clear is refused at ownerChannelWriteStart(), the file kept', async (answer, close) => {
    fs.writeFileSync(ownerChannelFile(), JSON.stringify({ channelId: D }));
    close();
    const manager = fresh();
    expect(await putOwnerChannel(manager, null)).toEqual({ status: 409, body: { success: false, error: PUT_TEXT[answer] } });
    expect(JSON.parse(fs.readFileSync(ownerChannelFile(), 'utf-8'))).toEqual({ channelId: D });
    expect(manager.ownerChannelWriteSettled()).toBe(true);
  });

  it.each(CLOSED)('the gate closing %s during the test post refuses the write with the prefix', async (answer, close) => {
    testPost.during = close;
    const manager = fresh();
    expect(await putOwnerChannel(manager, C)).toEqual({ status: 409, body: { success: false, error: PREFIX + PUT_TEXT[answer] } });
    expect(testPost.posts).toBe(1);
    expect(fs.existsSync(ownerChannelFile())).toBe(false);
    expect(manager.ownerChannelWriteSettled()).toBe(true);
  });

  it('ownerChannelWriteStart() reads the restore gate before the migration lock and marks nothing', () => {
    const manager = fresh();
    manager.takeMigrationLock({ jobId: 'job-held-0001', to: 'postgres' } as any);
    journal('stuck');
    const mark = manager.ownerChannelWriteStart();
    manager.releaseMigrationLock();
    expect(mark.ok).toBe(false);
    expect(mark.ok === false && 'restore' in mark ? mark.restore.state : null).toBe('stuck');
    expect(manager.ownerChannelWriteSettled()).toBe(true);
  });

  it('with the gate clear the PUT saves as before', async () => {
    journal('done');
    const manager = fresh();
    expect((await putOwnerChannel(manager, C)).status).toBe(200);
    expect(JSON.parse(fs.readFileSync(ownerChannelFile(), 'utf-8'))).toEqual({ channelId: C });
    expect(manager.ownerChannelWriteSettled()).toBe(true);
  });
});

describe('migrationState() (C14)', () => {
  const G = '161616161616161616';
  beforeEach(() => {
    freshJsonBot();
    seedFile(`${G}/mod/a.json`, '{"a":1}');
    useDatabaseUrl(PG_URL);
    delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  });
  afterEach(() => {
    delete process.env.DATA_BACKEND_URL;
    wipeRoot();
  });

  const runJob = async (jobId: string, fault?: (point: string) => void) => {
    const service = serviceFor(new FakeDb(), new FakeHost(), fault ? { fault } : {});
    expect((await service.post({ jobId, to: 'postgres' })).body.state).toBe('started');
    await service.idle();
  };

  it('no journal: none', () => {
    expect(migrationState(null)).toEqual({ kind: 'none' });
  });

  it('a held lock with no journal: running with its job id', () => {
    const manager = fresh();
    manager.takeMigrationLock({ jobId: 'job-held-0001', to: 'postgres' } as any);
    const state = migrationState(manager.migrationRunning());
    manager.releaseMigrationLock();
    expect(state).toEqual({ kind: 'running', jobId: 'job-held-0001' });
  });

  it('a real job stopped at a fault: unfinished with its job id and stage', async () => {
    await runJob('job-stop-0001', point => {
      if (point === 'S4') throw Object.assign(new Error('the process died'), { simulateDeath: true });
    });
    expect(migrationState(null)).toEqual({ kind: 'unfinished', jobId: 'job-stop-0001', stage: 'reading' });
  });

  it('a job that failed, and one that finished: none', async () => {
    await runJob('job-fail-0001', point => {
      if (point === 'S4') throw new Error('injected failure');
    });
    expect(migrationState(null)).toEqual({ kind: 'none' });
    await runJob('job-done-0001');
    expect(migrationState(null)).toEqual({ kind: 'none' });
  });

  it("facts that cannot be confirmed: unknown with the read's error", () => {
    fs.writeFileSync(MARKER, '{');
    const facts = readDataFacts();
    expect(facts.ok).toBe(false);
    expect(migrationState(null)).toEqual({ kind: 'unknown', cause: facts.ok ? '' : facts.reason });
  });

  it('an interrupted journal written by a real job stopped at a fault: the tick takes nothing', async () => {
    _resetSchedulerForTests();
    await runJob('job-stop-0002', point => {
      if (point === 'S4') throw Object.assign(new Error('the process died'), { simulateDeath: true });
    });
    const manager = fresh();
    const probe = vi.spyOn(manager, 'routeProbe');
    await runTick(manager);
    expect(probe).not.toHaveBeenCalled();
    expect(readState().state).toMatchObject({ lastAttempt: null, lastRefusal: null });
    expect(await listSnapshots()).toEqual([]);
  });

  it('an interrupted journal written by a real job stopped at a fault refuses the POST with the unfinished text', async () => {
    await runJob('job-stop-0003', point => {
      if (point === 'S4') throw Object.assign(new Error('the process died'), { simulateDeath: true });
    });
    const { createBackupRoutes } = await import('../../src/webui/routes/backups');
    const app = await startApp(a => a.use('/api/backups', createBackupRoutes(fresh())));
    try {
      expect(await call(app.url, 'POST', '/api/backups/restore', { name: 'hourly-2026-11-13T04-00-00-000Z' })).toEqual({
        status: 409, body: { success: false, error: 'A data migration is running or unfinished; restore once it has finished.' },
      });
    } finally {
      await app.close();
    }
    expect(fs.existsSync(restoreJournalPath())).toBe(false);
  });

  it("C15: a take whose start turn follows post()'s lock starts nothing", async () => {
    _resetSchedulerForTests();
    const manager = fresh();
    const real = fs.promises.readdir.bind(fs.promises);
    let taken = false;
    vi.spyOn(fs.promises, 'readdir').mockImplementation((async (p: fs.PathLike, o?: any) => {
      if (!taken && String(p) === dataPath('_snapshots')) {
        taken = true;
        manager.takeMigrationLock({ jobId: 'job-held-0002', to: 'postgres' } as any);
      }
      return real(p, o);
    }) as typeof fs.promises.readdir);
    const probe = vi.spyOn(manager, 'routeProbe');
    await runTick(manager);
    manager.releaseMigrationLock();
    expect(taken).toBe(true);
    expect(probe).not.toHaveBeenCalled();
    expect(readState().state).toMatchObject({ lastAttempt: null, lastRefusal: null });
    expect(await listSnapshots()).toEqual([]);
  });

  it('a done journal the marker does not name: unknown with that error', async () => {
    await runJob('job-done-0002');
    writeJson(MARKER, { live: 'file', storeId: null, flippedAt: 1 });
    expect(migrationState(null)).toEqual({
      kind: 'unknown',
      cause: "can't confirm; migration job-done-0002 says done, but /data/.backend.json does not name it",
    });
  });
});

describe('post() and backupRefusal() (C15)', () => {
  const TAKE_TEXT = 'A backup is being taken now; start the migration once it has finished.';
  const RUNNING_TEXT = 'A backup restore is running or did not finish; start the migration once it has finished.';
  const UNKNOWN_TEXT = "can't confirm the state of the last backup restore: /data/_snapshots/restore.json cannot be read (not valid JSON). The bot does not start until it can be read; if no restore ran, remove that file.";
  const cases: Array<[string, () => void, string]> = [
    ['a take running', () => setBackupWorkRunning('take'), TAKE_TEXT],
    ['a restore op', postOp, RUNNING_TEXT],
    ['an unfinished journal', () => journal('swapping'), RUNNING_TEXT],
    ['an unreadable journal', () => journal('unreadable'), UNKNOWN_TEXT],
  ];
  beforeEach(() => {
    freshJsonBot();
    useDatabaseUrl(PG_URL);
  });
  afterEach(() => {
    delete process.env.DATA_BACKEND_URL;
    wipeRoot();
  });

  it.each(cases)('%s: 409 with its text, no lock taken and no journal written', async (_name, set, text) => {
    set();
    const manager = fresh();
    const take = vi.spyOn(manager, 'takeMigrationLock');
    const answer = await serviceFor(new FakeDb(), manager).post({ jobId: 'job-gate-0001', to: 'postgres' });
    expect(answer).toEqual({ status: 409, body: { success: false, error: text } });
    expect(take).not.toHaveBeenCalled();
    expect(manager.migrationRunning()).toBeNull();
    expect(fs.existsSync(JOURNAL)).toBe(false);
  });

  it('a host without backupRefusal starts the job as before', async () => {
    setBackupWorkRunning('take');
    const host = new FakeHost();
    const service = serviceFor(new FakeDb(), host);
    expect((await service.post({ jobId: 'job-gate-0002', to: 'postgres' })).body.state).toBe('started');
    await service.idle();
    expect(host.calls[0]).toBe('take');
  });
});

describe('bundleRefusal() with the restore answer (C18)', () => {
  const RESTORING = 'a backup restore is running or did not finish; run the import or export once it has finished';
  const RESTORING_UNKNOWN = "can't confirm whether a backup restore is running (the web panel's status did not confirm it); run the import or export once it does";
  const BOT_UNKNOWN = 'could not confirm the bot is stopped (the panel did not answer or gave no clear reply); start the panel (/webui start) or stop the bot first';
  afterEach(() => setBackendKind(null));
  it.each([
    ["restoring 'yes'", 'no', 'yes', RESTORING],
    ["restoring 'unknown'", 'no', 'unknown', RESTORING_UNKNOWN],
    ["bot 'unknown' and restoring 'unknown': the bot text first", 'unknown', 'unknown', BOT_UNKNOWN],
  ] as const)('%s', (_name, bot, restoring, text) => {
    setBackendKind('file');
    expect(bundleRefusal('111222333', bot, 'no', restoring)).toBe(text);
  });
});

describe("importBundle()'s read of restore.json after its lock take (decisions 26, 31 and 47)", () => {
  const OPEN = '[DataInterchange] a backup restore is running or did not finish (/data/_snapshots/restore.json); run the import once it has finished';
  const UNREADABLE = "[DataInterchange] can't confirm whether a backup restore is running (/data/_snapshots/restore.json: not valid JSON); run the import once that file can be read";
  const bundle = () => dataPath('nb8-missing.dbex');

  it.each(['staging', 'staged', 'swapping', 'placing', 'stuck'] as const)('a journal at %s refuses the import and releases the lock', async stage => {
    journal(stage);
    const error = await importBundle(bundle()).then(() => null, (e: unknown) => e as Error);
    expect(error?.message).toBe(OPEN);
    expect(writerLockDepth()).toBe(0);
    expect(fs.existsSync(writerLockPath())).toBe(false);
  });

  it('a journal that cannot be read refuses the import with its cause and releases the lock', async () => {
    journal('unreadable');
    const error = await importBundle(bundle()).then(() => null, (e: unknown) => e as Error);
    expect(error?.message).toBe(UNREADABLE);
    expect(writerLockDepth()).toBe(0);
    expect(fs.existsSync(writerLockPath())).toBe(false);
  });

  it.each(['placed', 'done', 'failed', 'none'] as const)('a journal at %s lets the import go on to its bundle', async stage => {
    if (stage !== 'none') journal(stage);
    const error = await importBundle(bundle()).then(() => null, (e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).not.toContain('restore');
    expect(writerLockDepth()).toBe(0);
  });
});
