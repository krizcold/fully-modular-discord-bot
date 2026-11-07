import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB9 test 8: BotManager's standby, the retire and promote() (18, 26, 30, 39, 40, 49, 50, 53, 62, 65, C6, C7), driven
// through a real start() with the forkMock children and the IPC messages the bot process and the standby send.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { fork } from 'child_process';
import {
  BotManager, ROUTE_TEXT, B4_LINE, B7_LINE, b1Line, b2Line, b3Line, b5Line, b6Line, b8Line, b9Line, b15Line,
} from '../../src/webui/botManager';
import { EXIT_DEPOSED } from '../../src/bot/internalSetup/utils/dataManager';
import { acceptAddressList, resetAddressesForTests } from '../../src/utils/databaseAddress';
import { forkLogin, forks, forkStage } from '../helpers/forkMock';
import { exitChild, freshWriterLock, logged, resetForks, sentTo, tick } from '../helpers/nb10Rig';

let warn: ReturnType<typeof vi.spyOn>;
let log: ReturnType<typeof vi.spyOn>;
let managers: BotManager[] = [];

beforeEach(() => {
  resetForks();
  forkStage.stages = ['shared', 'guild'];
  freshWriterLock('webui');
  resetAddressesForTests();
  safety.recordCrash.mockClear();
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
  vi.restoreAllMocks();
});

const ATTEMPT = 'a-1';
const lines = (): string[] => [...logged(log), ...logged(warn)];

function fresh(): BotManager {
  const manager = new BotManager();
  managers.push(manager);
  return manager;
}

async function started(manager = fresh()): Promise<{ manager: BotManager; child: any }> {
  const result = await manager.start();
  expect(result.success).toBe(true);
  await tick(5);
  return { manager, child: forks.children.at(-1) };
}

function roomy(manager: BotManager, room: boolean | null = true, at = new Date().toISOString(), error?: string): void {
  manager.noteMemoryReading({ room, useMb: 300, freeMb: 900, at, ...(error !== undefined ? { error } : {}) });
}

function ask(child: any, extra: Record<string, unknown> = {}): void {
  child.emit('message', { type: 'control:reshard-standby', data: { attempt: ATTEMPT, to: 8, intents: 513, maxConcurrency: 1, entry: 'postgres://db-a/x', ...extra } });
}

const answers = (child: any): any[] => sentTo(child, 'reshard:standby-state').map(m => m.data);

/** A bot process with a standby of ATTEMPT forked by its ask. */
async function withStandby(manager = fresh()): Promise<{ manager: BotManager; child: any; standby: any }> {
  const { child } = await started(manager);
  roomy(manager);
  ask(child);
  const standby = forks.children.at(-1);
  expect(standby).not.toBe(child);
  await tick(5);
  return { manager, child, standby };
}

/** The bot process's retire, its stop and its exit; the standby promoted when every check holds. */
async function retired(manager: BotManager, child: any, attempt: string | null = ATTEMPT): Promise<void> {
  child.emit('message', { type: 'control:reshard-retire', data: { attempt } });
  await tick(40);
}

/** The fields C6 names, read from the manager. */
function perChild(manager: BotManager): Record<string, unknown> {
  const m = manager as any;
  return {
    childMode: m.childMode, childHeld: m.childHeld, childMaintenanceBoot: m.childMaintenanceBoot,
    childModeReported: m.childModeReported, childStoreReported: m.childStoreReported, childLoggedIn: m.childLoggedIn,
    childEnterAnswer: m.childEnterAnswer, childStage: m.childStage, childWaitHolder: m.childWaitHolder,
    childWaitCause: m.childWaitCause, childWaitReadCause: m.childWaitReadCause, childDeposedHolder: m.childDeposedHolder,
    stopKind: m.stopKind, lastChildExited: m.lastChildExited, crashed: m.crashed, stopRequested: m.stopRequested,
  };
}

describe("the ask, 'control:reshard-standby' (18, 33, 50, 65)", () => {
  it.each([
    ['no reading', (_m: BotManager) => undefined, 'the manager has sent no memory reading'],
    ['a reading 20 min old', (m: BotManager) => roomy(m, true, new Date(Date.now() - 20 * 60_000).toISOString()), 'the memory reading is 20 min old'],
    ['room false', (m: BotManager) => roomy(m, false), 'the memory reading shows no room (900 MB free, 300 MB used)'],
    ['room null with the error', (m: BotManager) => roomy(m, null, new Date().toISOString(), 'docker stats failed'), "can't confirm there is room: the manager could not take the memory reading (docker stats failed)"],
  ])("%s: 'refused', kind 'memory', B2 logged, no fork", async (_name, setup, reason) => {
    const { manager, child } = await started();
    setup(manager);
    ask(child);
    expect(answers(child)).toEqual([{ attempt: ATTEMPT, state: 'refused', kind: 'memory', reason }]);
    expect(lines()).toContain(b2Line(reason));
    expect(forks.children).toHaveLength(1);
  });

  it("the web UI exiting: 'refused', 'passing'", async () => {
    const { manager, child } = await started();
    roomy(manager);
    manager.beginExit();
    ask(child);
    expect(answers(child)).toEqual([{ attempt: ATTEMPT, state: 'refused', kind: 'passing', reason: 'the web UI is shutting down' }]);
    expect(forks.children).toHaveLength(1);
  });

  it("an operation in progress: 'refused', 'passing'", async () => {
    const { manager, child } = await started();
    roomy(manager);
    (manager as any).operationInProgress = true;
    ask(child);
    (manager as any).operationInProgress = false;
    expect(answers(child)).toEqual([{ attempt: ATTEMPT, state: 'refused', kind: 'passing', reason: 'another operation is in progress' }]);
  });

  it("a restart in flight: 'refused', 'passing', the bot being stopped or restarted", async () => {
    const { manager, child } = await started();
    roomy(manager);
    forks.holdExit = true;
    const restarting = manager.restart();
    await tick(5);
    ask(child);
    expect(answers(child)).toEqual([{ attempt: ATTEMPT, state: 'refused', kind: 'passing', reason: 'the bot is being stopped or restarted' }]);
    exitChild(child, 0);
    forks.holdExit = false;
    await restarting;
  });

  it("forks the standby with the env of 7 and 27, logs B1 and answers 'started'", async () => {
    const { manager, child } = await started();
    acceptAddressList('postgres://db-a/x,postgres://db-b/x');
    roomy(manager);
    ask(child);
    expect(answers(child)).toEqual([{ attempt: ATTEMPT, state: 'started' }]);
    expect(forks.children).toHaveLength(2);
    const env = (fork as any).mock.calls.at(-1)[2].env;
    expect(env).toMatchObject({
      SMDB_RESHARD_STANDBY: ATTEMPT, SMDB_RESHARD_COUNT: '8', SMDB_RESHARD_INTENTS: '513', SMDB_RESHARD_MC: '1',
      SMDB_RESHARD_DB: 'postgres://db-a/x', BOT_PROCESS_ROLE: 'bot', DATA_BACKEND_URL: 'postgres://db-a/x,postgres://db-b/x', DISCORD_TOKEN: 'token',
    });
    expect(lines()).toContain(b1Line(8));
    expect(lines().join('\n')).not.toContain('postgres://db-a/x');
  });

  it("a JSON ask forks with no SMDB_RESHARD_DB", async () => {
    const { manager, child } = await started();
    roomy(manager);
    ask(child, { json: true, entry: undefined });
    expect((fork as any).mock.calls.at(-1)[2].env.SMDB_RESHARD_DB).toBeUndefined();
  });

  it.each([
    [4, '4'],
    [undefined, undefined],
    [0, undefined],
    ['x', undefined],
  ])("an ask with from %s forks with SMDB_RESHARD_FROM %s (B4's seed of 'done')", async (from, env) => {
    const { manager, child } = await started();
    roomy(manager);
    ask(child, { json: true, entry: undefined, ...(from !== undefined ? { from } : {}) });
    expect(forks.children).toHaveLength(2);
    expect((fork as any).mock.calls.at(-1)[2].env.SMDB_RESHARD_FROM).toBe(env);
  });

  it("a living standby of the attempt: 'running' with no memory test, even with a stale or false reading", async () => {
    const { manager, child } = await withStandby();
    roomy(manager, false);
    ask(child);
    roomy(manager, true, new Date(Date.now() - 20 * 60_000).toISOString());
    ask(child);
    expect(answers(child).slice(1)).toEqual([{ attempt: ATTEMPT, state: 'running' }, { attempt: ATTEMPT, state: 'running' }]);
    expect(forks.children).toHaveLength(2);
  });

  it("a re-fork for the same attempt after its standby exited is not judged again (forkedFor)", async () => {
    const { manager, child, standby } = await withStandby();
    (manager as any).memoryReading = null;
    exitChild(standby, 1);
    ask(child);
    expect(answers(child).at(-1)).toEqual({ attempt: ATTEMPT, state: 'started' });
    expect(forks.children).toHaveLength(3);
  });

  it('a standby of another attempt is stopped first (B6), then the new one forked', async () => {
    const { child, standby } = await withStandby();
    ask(child, { attempt: 'a-2' });
    expect(standby.signals).toEqual(['SIGTERM']);
    expect(lines()).toContain(b6Line('the second bot process is not the one for this reshard'));
    expect(answers(child).at(-1)).toEqual({ attempt: 'a-2', state: 'started' });
    expect(forks.children).toHaveLength(3);
  });

  it('the standby is in unexitedChildren from its fork and leaves it at its exit (C6)', async () => {
    const { manager, standby } = await withStandby();
    expect((manager as any).unexitedChildren.get(standby.pid)).toBe(standby);
    exitChild(standby, 0);
    expect((manager as any).unexitedChildren.has(standby.pid)).toBe(false);
  });

  it("the standby's output carries '[Standby] '", async () => {
    const { manager, standby } = await withStandby();
    standby.stdout.emit('data', Buffer.from('[Shards] hello\n'));
    expect(manager.getLogs().current).toContain('[Standby] [Shards] hello\n');
  });
});

describe('the standby stopped with its bot process (18, B6)', () => {
  it.each([
    ['an operator Stop', (m: BotManager) => m.shutdown(false), 'the bot process stopped'],
    ['an operator Restart', (m: BotManager) => m.restart(), 'the bot is restarting'],
  ])('%s', async (_name, act, cause) => {
    const { manager, standby } = await withStandby();
    await act(manager);
    expect(standby.signals).toEqual(['SIGTERM']);
    expect(lines()).toContain(b6Line(cause));
  });

  it("the bot process's crash: B6, the mark, no 'ended' notice for the asked stop", async () => {
    const { manager, child, standby } = await withStandby();
    exitChild(child, 1);
    expect(standby.signals).toEqual(['SIGTERM']);
    expect(lines()).toContain(b6Line('the bot process exited'));
    expect((manager as any).overlapEnded).toEqual({ attempt: ATTEMPT, code: 1, signal: null });
  });

  it("the web UI's exit", async () => {
    const { manager, standby } = await withStandby();
    manager.beginExit();
    expect(standby.signals).toEqual(['SIGTERM']);
    expect(lines()).toContain(b6Line('the web UI is shutting down'));
  });
});

describe("a standby's own exit (B5, 49)", () => {
  it("a crash: B5 and 'ended' with the exit to the bot process", async () => {
    const { child, standby } = await withStandby();
    standby.signalCode = 'SIGKILL';
    standby.emit('exit', null, 'SIGKILL');
    expect(lines()).toContain(b5Line(null, 'SIGKILL', null));
    expect(answers(child).at(-1)).toEqual({ attempt: ATTEMPT, state: 'ended', reason: 'exit code null, signal SIGKILL' });
  });

  it("a ready standby's crash also sends 'ended'", async () => {
    const { child, standby } = await withStandby();
    standby.emit('message', { type: 'reshard:standby-progress', data: { attempt: ATTEMPT, held: 2, ready: 2 } });
    exitChild(standby, 1);
    expect(answers(child).at(-1)).toEqual({ attempt: ATTEMPT, state: 'ended', reason: 'exit code 1, signal null' });
  });

  it("a 'failed' self-stop: answered false, B5 with the reason, 'ended' with the reason", async () => {
    const { child, standby } = await withStandby();
    standby.emit('message', { type: 'reshard:standby-stopping', data: { attempt: ATTEMPT, reason: 'no claim renewal for 31 s', kind: 'failed' } });
    expect(sentTo(standby, 'reshard:standby-stop-answer').map(m => m.data)).toEqual([{ promoted: false }]);
    exitChild(standby, 0);
    expect(lines()).toContain(b5Line(0, null, 'no claim renewal for 31 s'));
    expect(answers(child).at(-1)).toEqual({ attempt: ATTEMPT, state: 'ended', reason: 'no claim renewal for 31 s' });
  });

  it("a 'called-off' self-stop: no 'ended'", async () => {
    const { child, standby } = await withStandby();
    standby.emit('message', { type: 'reshard:standby-stopping', data: { attempt: ATTEMPT, reason: 'the attempt was called off', kind: 'called-off' } });
    exitChild(standby, 0);
    expect(answers(child).map(a => a.state)).toEqual(['started']);
  });

  it("a standby stopped by B6: no 'ended' and no B5", async () => {
    const { manager, child, standby } = await withStandby();
    await manager.shutdown(false);
    await tick(20);
    expect(standby.exitCode).toBe(0);
    expect(answers(child).map(a => a.state)).toEqual(['started']);
    expect(lines().some(l => l.includes('exited (code'))).toBe(false);
  });
});

describe('the retire and promote() (26, 39, 40, 53, C6, C7)', () => {
  it('promotes the standby at the retiring child exit: B3, the stop of kind restart, B4, adoptAsCurrent, reshard:promoted', async () => {
    const { manager, child, standby } = await withStandby();
    forks.holdExit = true;
    child.emit('message', { type: 'control:reshard-retire', data: { attempt: ATTEMPT } });
    await tick(5);
    expect(child.signals).toEqual(['SIGTERM']);
    expect(lines()).toContain(b3Line(8));
    expect(manager.writerRoute('guild')).toMatchObject({ code: 'stopping', error: ROUTE_TEXT.restarting });
    const reroute = vi.spyOn(manager as any, 'rerouteQueued');
    exitChild(child, 0);
    forks.holdExit = false;
    await tick(5);
    expect((manager as any).botProcess).toBe(standby);
    expect((manager as any).standby).toBe(null);
    expect((manager as any).retiring).toBe(null);
    expect((manager as any).lastChild).toBe(standby);
    expect(reroute).toHaveBeenCalledTimes(1);
    expect(lines()).toContain(B4_LINE);
    expect(sentTo(standby, 'reshard:promoted').map(m => m.data)).toEqual([{ attempt: ATTEMPT }]);
    expect(standby.signals).toEqual([]);
    expect(safety.recordCrash).not.toHaveBeenCalled();
    expect(forks.children).toHaveLength(2);
  });

  it("C6: the per-child fields after promote() equal those after a real start() of a fresh child, stopRequested false", async () => {
    // A fresh child that reports nothing: the fields are what start() itself set.
    forkLogin.on = false;
    forkStage.stages = [];
    const first = fresh();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const starting = first.start();
    await vi.advanceTimersByTimeAsync(6_000);
    await starting;
    vi.useRealTimers();
    const afterStart = perChild(first);
    forkLogin.on = true;
    forkStage.stages = ['shared', 'guild'];
    const { manager, child } = await withStandby();
    (manager as any).childEnterAnswer = { saved: true };
    (manager as any).childMode = 'maintenance';
    (manager as any).crashed = true;
    await retired(manager, child);
    expect(perChild(manager)).toEqual(afterStart);
    expect(afterStart).toMatchObject({ stopRequested: false, crashed: false, stopKind: null, childStage: 'none', lastChildExited: false });
  });

  it('after promotion migrationBotState reads the promoted child (C6)', async () => {
    const { manager, child } = await withStandby();
    await retired(manager, child);
    expect(manager.migrationBotState()).toEqual({ ok: false, error: "The bot process is still starting; can't confirm whether it boots in maintenance; try again once it has started" });
  });

  it("C7: 'data:addresses' with hookListInUse() before 'reshard:promoted'", async () => {
    const { manager, child, standby } = await withStandby();
    acceptAddressList('postgres://db-a/x,postgres://db-b/x');
    await retired(manager, child);
    const sends = sentTo(standby).map(m => m.type).filter(t => t === 'data:addresses' || t === 'reshard:promoted');
    expect(sends).toEqual(['data:addresses', 'reshard:promoted']);
    expect(sentTo(standby, 'data:addresses')[0].data).toEqual({ id: expect.stringMatching(/^addresses-\d+$/), url: 'postgres://db-a/x,postgres://db-b/x' });
  });

  it("C7: none when hookListInUse() is null", async () => {
    const { manager, child, standby } = await withStandby();
    await retired(manager, child);
    expect(sentTo(standby, 'data:addresses')).toEqual([]);
    expect(sentTo(standby, 'reshard:promoted')).toHaveLength(1);
  });

  it('C7: a list the old child acked during the overlap reaches the standby at promotion', async () => {
    const { manager, child, standby } = await withStandby();
    child.send = vi.fn((message: any) => {
      if (message?.type === 'data:addresses') setTimeout(() => child.emit('message', { type: 'data:addresses-ack', data: { id: message.data.id, accepted: true } }), 1);
      return true;
    });
    const answer = await manager.applyAddressList('postgres://db-c/x');
    expect(answer.status).toBe(200);
    await retired(manager, child);
    expect(sentTo(standby, 'data:addresses').map(m => m.data.url)).toEqual(['postgres://db-c/x']);
  });

  it('the promoted child later exit 0 starts nothing; its nonzero exit is a crash restart', async () => {
    const { manager, child, standby } = await withStandby();
    await retired(manager, child);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    exitChild(standby, 1);
    expect(safety.recordCrash).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6_000);
    vi.useRealTimers();
    expect(forks.children).toHaveLength(3);
    const again = forks.children.at(-1);
    exitChild(again, 0);
    await tick(10);
    expect(forks.children).toHaveLength(3);
  });

  it('the crash row from a real retire: the old child exit 0, the promoted exit 1, one start() after 5 s (39)', async () => {
    const { manager, child, standby } = await withStandby();
    await retired(manager, child);
    expect(child.exitCode).toBe(0);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    exitChild(standby, 1);
    await vi.advanceTimersByTimeAsync(4_900);
    expect(forks.children).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_100);
    vi.useRealTimers();
    expect(forks.children).toHaveLength(3);
  });

  it("(yes) the promoted child killed with code null and no stop: one start() after 5 s", async () => {
    const { manager, child, standby } = await withStandby();
    await retired(manager, child);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    standby.signalCode = 'SIGKILL';
    standby.emit('exit', null, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(6_000);
    vi.useRealTimers();
    expect(forks.children).toHaveLength(3);
  });

  it('a web UI exiting during the 40 s: B6, nothing started', async () => {
    const { manager, child, standby } = await withStandby();
    forks.holdExit = true;
    child.emit('message', { type: 'control:reshard-retire', data: { attempt: ATTEMPT } });
    await tick(5);
    (manager as any).exiting = true;
    exitChild(child, 0);
    forks.holdExit = false;
    await tick(5);
    expect(lines()).toContain(b6Line('the web UI is shutting down'));
    expect(standby.signals).toEqual(['SIGTERM']);
    expect(forks.children).toHaveLength(2);
    expect(manager.isRunning()).toBe(false);
  });

  it('a Stop during the 40 s: B6, nothing started', async () => {
    const { manager, child, standby } = await withStandby();
    forks.holdExit = true;
    child.emit('message', { type: 'control:reshard-retire', data: { attempt: ATTEMPT } });
    await tick(5);
    const stopping = manager.shutdown(false);
    await tick(5);
    exitChild(child, 0);
    forks.holdExit = false;
    await stopping;
    await tick(5);
    expect(lines()).toContain(b6Line('a stop or restart was asked during the hand-over'));
    expect(standby.signals).toEqual(['SIGTERM']);
    expect(forks.children).toHaveLength(2);
  });

  it('test 18: the retiring child killed with SIGKILL during a Stop: B6, no promotion, no crash restart', async () => {
    const { manager, child, standby } = await withStandby();
    forks.holdExit = true;
    child.emit('message', { type: 'control:reshard-retire', data: { attempt: ATTEMPT } });
    await tick(5);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stopping = manager.shutdown(false);
    await vi.advanceTimersByTimeAsync(5);
    child.signalCode = 'SIGKILL';
    child.emit('exit', null, 'SIGKILL');
    forks.holdExit = false;
    await stopping;
    await vi.advanceTimersByTimeAsync(6_000);
    vi.useRealTimers();
    expect(lines()).toContain(b6Line('a stop or restart was asked during the hand-over'));
    expect(lines()).not.toContain(B4_LINE);
    expect(standby.signals).toEqual(['SIGTERM']);
    expect(safety.recordCrash).not.toHaveBeenCalled();
    expect(forks.children).toHaveLength(2);
    expect(manager.isRunning()).toBe(false);
  });

  it("a Restart during the 40 s: B6 and one start() (the restart's own)", async () => {
    const { manager, child, standby } = await withStandby();
    forks.holdExit = true;
    child.emit('message', { type: 'control:reshard-retire', data: { attempt: ATTEMPT } });
    await tick(5);
    const restarting = manager.restart();
    await tick(5);
    exitChild(child, 0);
    forks.holdExit = false;
    await restarting;
    await tick(5);
    expect(lines()).toContain(b6Line('a stop or restart was asked during the hand-over'));
    expect(standby.signals).toEqual(['SIGTERM']);
    expect(forks.children).toHaveLength(3);
  });

  it('a dead standby: B7 and start()', async () => {
    const { manager, child, standby } = await withStandby();
    exitChild(standby, 1);
    await retired(manager, child);
    expect(lines()).toContain(B7_LINE);
    expect(forks.children).toHaveLength(3);
    expect((manager as any).botProcess).toBe(forks.children.at(-1));
  });

  it('a standby of another attempt: B6, B7 and start()', async () => {
    const { manager, child, standby } = await withStandby();
    await retired(manager, child, 'a-other');
    expect(lines()).toContain(b6Line('the second bot process is not the one for this reshard'));
    expect(lines()).toContain(B7_LINE);
    expect(standby.signals).toEqual(['SIGTERM']);
    expect(forks.children).toHaveLength(3);
  });

  it('an abandoning standby: B7 and start(), no promotion', async () => {
    const { manager, child, standby } = await withStandby();
    standby.emit('message', { type: 'reshard:standby-stopping', data: { attempt: ATTEMPT, reason: 'r', kind: 'failed' } });
    await retired(manager, child);
    expect(lines()).toContain(B7_LINE);
    expect((manager as any).botProcess).not.toBe(standby);
    expect(sentTo(standby, 'reshard:promoted')).toEqual([]);
    expect(forks.children).toHaveLength(3);
  });

  it('with no standby: B7 and start()', async () => {
    const { manager, child } = await started();
    await retired(manager, child, null);
    expect(lines()).toContain(B7_LINE);
    expect(forks.children).toHaveLength(2);
  });

  it.each([
    ['during an operation', (m: BotManager) => { (m as any).operationInProgress = true; }, 'another operation is in progress'],
    ['during a restart in flight', (m: BotManager) => { (m as any).queuedRestart = Promise.resolve({ success: true }); }, 'a restart is under way'],
  ])('a retire %s: B8 once per cause, nothing changes', async (_name, busy, cause) => {
    const { manager, child } = await withStandby();
    busy(manager);
    child.emit('message', { type: 'control:reshard-retire', data: { attempt: ATTEMPT } });
    child.emit('message', { type: 'control:reshard-retire', data: { attempt: ATTEMPT } });
    expect(lines().filter(l => l === b8Line(cause))).toHaveLength(1);
    expect((manager as any).retiring).toBe(null);
    expect(child.signals).toEqual([]);
    (manager as any).operationInProgress = false;
    (manager as any).queuedRestart = null;
  });

  it('a retire from a child already signalled does nothing', async () => {
    const { manager, child } = await withStandby();
    forks.holdExit = true;
    const stopping = manager.shutdown(false);
    await tick(5);
    child.emit('message', { type: 'control:reshard-retire', data: { attempt: ATTEMPT } });
    expect((manager as any).retiring).toBe(null);
    exitChild(child, 0);
    forks.holdExit = false;
    await stopping;
  });

  it('exit dispatch takes retiring first, also after the child left botProcess (40)', async () => {
    const { manager, child, standby } = await withStandby();
    forks.holdExit = true;
    child.emit('message', { type: 'control:reshard-retire', data: { attempt: ATTEMPT } });
    await tick(5);
    expect((manager as any).retiring?.child).toBe(child);
    exitChild(child, 0);
    forks.holdExit = false;
    await tick(5);
    expect((manager as any).botProcess).toBe(standby);
    expect(lines().some(l => l.includes('A previous bot child exited'))).toBe(false);
  });

  it('a retiring child that outlives its SIGKILL: retiring null, B6, B9, one start(); its later exit logs the stale line (40)', async () => {
    const { manager, child, standby } = await withStandby();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    forks.holdExit = true;
    child.emit('message', { type: 'control:reshard-retire', data: { attempt: ATTEMPT } });
    await vi.advanceTimersByTimeAsync(46_000);
    forks.holdExit = false;
    await vi.advanceTimersByTimeAsync(6_000);
    vi.useRealTimers();
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect((manager as any).retiring).toBe(null);
    expect(lines()).toContain(b6Line('the old bot process did not exit 5 s after it was killed'));
    expect(lines()).toContain(b9Line(5));
    expect(standby.signals).toContain('SIGTERM');
    expect(forks.children).toHaveLength(3);
    exitChild(child, 0);
    expect(lines()).toContain('[BotManager] A previous bot child exited with code: 0, signal: null');
  });
});

describe("the stop handshake's answer (30)", () => {
  it("answers promoted true from the promoted child", async () => {
    const { manager, child, standby } = await withStandby();
    await retired(manager, child);
    standby.emit('message', { type: 'reshard:standby-stopping', data: { attempt: ATTEMPT, reason: 'r', kind: 'failed' } });
    expect(sentTo(standby, 'reshard:standby-stop-answer').map(m => m.data)).toEqual([{ promoted: true }]);
  });
});

describe('the mark after an unasked exit during the overlap (65, 76) and the crash test (62, yes)', () => {
  const MARK_REASON = "the previous bot process ended (code 1, signal null) while the second bot process ran, so room for both can't be confirmed";

  it("a crash with code 1 while a standby of a lives: the mark, B6, and the next child's ask for a is refused 'memory'", async () => {
    const { manager, child } = await withStandby();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    exitChild(child, 1);
    await vi.advanceTimersByTimeAsync(6_000);
    vi.useRealTimers();
    await tick(5);
    const next = forks.children.at(-1);
    expect(forks.children).toHaveLength(3);
    roomy(manager);
    ask(next);
    expect(answers(next)).toEqual([{ attempt: ATTEMPT, state: 'refused', kind: 'memory', reason: MARK_REASON }]);
    expect(lines()).toContain(b2Line(MARK_REASON));
    expect(forks.children).toHaveLength(3);
    ask(next, { attempt: 'b-1' });
    expect(answers(next).at(-1)).toEqual({ attempt: 'b-1', state: 'started' });
  });

  it("with the standby still stopping (it ignores SIGTERM): 'refused', not 'running'", async () => {
    const { manager, child, standby } = await withStandby();
    standby.kill = vi.fn((signal: string) => { standby.signals.push(signal); standby.killed = true; return true; });
    exitChild(child, 1);
    manager.cancelCrashRestart();
    const { child: next } = await started(manager);
    ask(next);
    expect(answers(next).at(-1)).toMatchObject({ state: 'refused', kind: 'memory' });
  });

  it("an operator Restart: no mark; the new child's ask for a answers 'started' with no memory test once the standby exited", async () => {
    const { manager, standby } = await withStandby();
    await manager.restart();
    await tick(20);
    expect((manager as any).overlapEnded).toBe(null);
    expect(standby.exitCode).toBe(0);
    (manager as any).memoryReading = null;
    const next = forks.children.at(-1);
    ask(next);
    expect(answers(next).at(-1)).toEqual({ attempt: ATTEMPT, state: 'started' });
  });

  it('an operator Stop whose child ignores SIGTERM and is killed at 40 s: no mark, a clean exit, no start', async () => {
    const { manager, child } = await withStandby();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    child.kill = vi.fn((signal: string) => {
      child.signals.push(signal);
      child.killed = true;
      if (signal === 'SIGKILL') setTimeout(() => { child.signalCode = 'SIGKILL'; child.emit('exit', null, 'SIGKILL'); }, 10);
      return true;
    });
    const stopping = manager.shutdown(false);
    await vi.advanceTimersByTimeAsync(41_000);
    await stopping;
    await vi.advanceTimersByTimeAsync(6_000);
    vi.useRealTimers();
    expect((manager as any).overlapEnded).toBe(null);
    expect(safety.recordCrash).not.toHaveBeenCalled();
    expect(forks.children).toHaveLength(2);
  });

  it("a code 1 after a Stop: today's line and no start", async () => {
    const { manager, child } = await started();
    forks.holdExit = true;
    const stopping = manager.shutdown(false);
    await tick(5);
    exitChild(child, 1);
    forks.holdExit = false;
    await stopping;
    await tick(10);
    expect(lines()).toContain('[BotManager] The exit followed a requested stop; not starting the bot again');
    expect(forks.children).toHaveLength(1);
  });

  it("the retire's exit: no mark", async () => {
    const { manager, child } = await withStandby();
    await retired(manager, child);
    expect((manager as any).overlapEnded).toBe(null);
  });

  it('an exit with code 75: no mark, no crash, one start() after 5 s', async () => {
    const { manager, child } = await withStandby();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    exitChild(child, EXIT_DEPOSED);
    await vi.advanceTimersByTimeAsync(6_000);
    vi.useRealTimers();
    expect((manager as any).overlapEnded).toBe(null);
    expect(safety.recordCrash).not.toHaveBeenCalled();
    expect(forks.children).toHaveLength(3);
  });

  it("E9: a Restart before the 5 s after code 75 calls off the automatic start; the new child's exit 0 starts nothing", async () => {
    const { manager, child } = await started();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    exitChild(child, EXIT_DEPOSED);
    let settled = false;
    const restarted = manager.restart().finally(() => { settled = true; });
    for (let i = 0; i < 40 && !settled; i++) await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(true);
    expect((await restarted).success).toBe(true);
    expect(forks.children).toHaveLength(2);
    exitChild(forks.children[1], 0);
    await vi.advanceTimersByTimeAsync(6_000);
    vi.useRealTimers();
    expect(forks.children).toHaveLength(2);
    expect(lines().filter(l => l === '[BotManager] The automatic start after the crash was called off: the bot is being started now')).toHaveLength(1);
  });

  it("a second mark for b replaces a's", async () => {
    const { manager, child } = await withStandby();
    exitChild(child, 1);
    manager.cancelCrashRestart();
    const { child: next } = await started(manager);
    roomy(manager);
    ask(next, { attempt: 'b-1' });
    exitChild(next, 1);
    expect((manager as any).overlapEnded).toEqual({ attempt: 'b-1', code: 1, signal: null });
  });

  it("(yes) code null, signal SIGKILL, no stop asked, a standby of a living: the mark, B15, recordCrash(null, 'SIGKILL'), one start() after 5 s, its ask for a refused", async () => {
    const { manager, child } = await withStandby();
    const crashes: unknown[] = [];
    (manager as any).wsManager = { broadcast: (type: string, data: unknown) => { if (type === 'bot:crash') crashes.push(data); } };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    child.signalCode = 'SIGKILL';
    child.emit('exit', null, 'SIGKILL');
    expect((manager as any).overlapEnded).toEqual({ attempt: ATTEMPT, code: null, signal: 'SIGKILL' });
    expect(manager.getLogs().current.some(l => l.includes(b15Line('SIGKILL')))).toBe(true);
    expect(safety.recordCrash).toHaveBeenCalledWith(null, 'SIGKILL', expect.any(Array));
    expect(crashes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(6_000);
    vi.useRealTimers();
    expect(forks.children).toHaveLength(3);
    const next = forks.children.at(-1);
    roomy(manager);
    ask(next);
    expect(answers(next).at(-1)).toMatchObject({ state: 'refused', kind: 'memory' });
  });

  it("(yes) a current child killed by a signal with no standby and no stop asked: B15, a crash, one start() after 5 s", async () => {
    const { manager, child } = await started();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    child.signalCode = 'SIGKILL';
    child.emit('exit', null, 'SIGKILL');
    expect(manager.getStatus().crashed).toBe(true);
    expect(safety.recordCrash).toHaveBeenCalledWith(null, 'SIGKILL', expect.any(Array));
    await vi.advanceTimersByTimeAsync(6_000);
    vi.useRealTimers();
    expect(forks.children).toHaveLength(2);
  });
});

describe("a JSON standby (15)", () => {
  async function jsonStandby(): Promise<{ manager: BotManager; child: any; standby: any }> {
    const { manager, child } = await started();
    roomy(manager);
    ask(child, { json: true, entry: undefined, maxConcurrency: 1 });
    const standby = forks.children.at(-1);
    await tick(5);
    return { manager, child, standby };
  }

  it("'reshard:standby-ready' asks the bot process 'reshard:retire'; accepted: nothing stopped", async () => {
    const { child, standby } = await jsonStandby();
    child.send = vi.fn((message: any) => {
      if (message?.type === 'reshard:retire') setTimeout(() => child.emit('message', { requestId: message.requestId, data: { accepted: true } }), 1);
      return true;
    });
    standby.emit('message', { type: 'reshard:standby-ready', data: { attempt: ATTEMPT } });
    await tick(20);
    expect((child.send as any).mock.calls.map((c: any[]) => c[0]).filter((m: any) => m.type === 'reshard:retire').map((m: any) => m.data)).toEqual([{ attempt: ATTEMPT }]);
    expect(standby.signals).toEqual([]);
  });

  it("accepted: false stops the standby (B6)", async () => {
    const { child, standby } = await jsonStandby();
    child.send = vi.fn((message: any) => {
      if (message?.type === 'reshard:retire') setTimeout(() => child.emit('message', { requestId: message.requestId, data: { accepted: false, key: 'gate' } }), 1);
      return true;
    });
    standby.emit('message', { type: 'reshard:standby-ready', data: { attempt: ATTEMPT } });
    await tick(20);
    expect(standby.signals).toEqual(['SIGTERM']);
    expect(lines()).toContain(b6Line('the reshard was called off'));
  });

  it("no answer within 5 s stops the standby (B6)", async () => {
    const { standby } = await jsonStandby();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    standby.emit('message', { type: 'reshard:standby-ready', data: { attempt: ATTEMPT } });
    await vi.advanceTimersByTimeAsync(5_100);
    vi.useRealTimers();
    expect(standby.signals).toEqual(['SIGTERM']);
    expect(lines()).toContain(b6Line('the reshard was called off'));
  });

  it('not ready by its deadline U: B6 with the minutes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const manager = fresh();
    const start = manager.start();
    await vi.advanceTimersByTimeAsync(600);
    await start;
    const child = forks.children.at(-1);
    roomy(manager);
    ask(child, { json: true, entry: undefined, maxConcurrency: 1 });
    const standby = forks.children.at(-1);
    await vi.advanceTimersByTimeAsync((600 + 11 * 8) * 1000 - 1000);
    expect(standby.signals).toEqual([]);
    await vi.advanceTimersByTimeAsync(2000);
    vi.useRealTimers();
    expect(standby.signals).toEqual(['SIGTERM']);
    expect(lines()).toContain(b6Line('not every new shard was connected within 11 min'));
  });
});

describe("'identify:slot' (16)", () => {
  it('grants per bucket on one clock across both children', async () => {
    const { child, standby } = await withStandby();
    child.emit('message', { type: 'identify:slot', data: { nonce: 'n1', bucket: 0 } });
    standby.emit('message', { type: 'identify:slot', data: { nonce: 'n2', bucket: 0 } });
    standby.emit('message', { type: 'identify:slot', data: { nonce: 'n3', bucket: 1 } });
    expect(sentTo(child, 'identify:slot').map(m => m.data)).toEqual([{ nonce: 'n1', waitMs: 0 }]);
    const [second, third] = sentTo(standby, 'identify:slot').map(m => m.data);
    expect(second.nonce).toBe('n2');
    expect(second.waitMs).toBeGreaterThan(5_000);
    expect(second.waitMs).toBeLessThanOrEqual(5_500);
    expect(third).toEqual({ nonce: 'n3', waitMs: 0 });
  });
});

describe("the Recent Crashes list, UpdateStatus.jsx (62, yes)", () => {
  async function crashItems(crash: Record<string, unknown>): Promise<string[]> {
    const { mount, settle, heldApi } = await import('../helpers/jsxRig');
    const { fileURLToPath } = await import('url');
    const file = fileURLToPath(new URL('../../src/webui/public/components/update/UpdateStatus.jsx', import.meta.url));
    const { api } = heldApi();
    const view = mount(file, 'UpdateStatus', { api, status: { safety: { crashHistory: [{ timestamp: '2026-11-07T03:00:00.000Z', ...crash }] } }, onRefresh: () => undefined }, { window: { location: {} }, disabledButtonStyle: () => ({}) });
    await settle();
    return view.all(el => el.type === 'span' && el.children.length > 0).map(el => view.text(el)).filter(t => t.startsWith('Exit Code') || t.startsWith('Signal'));
  }

  it('shows no Exit Code for a null code and names the signal', async () => {
    expect(await crashItems({ exitCode: null, signal: 'SIGKILL' })).toEqual(['Signal: SIGKILL']);
  });

  it('shows the Exit Code when there is one', async () => {
    expect(await crashItems({ exitCode: 1, signal: null })).toEqual(['Exit Code: 1']);
  });
});
