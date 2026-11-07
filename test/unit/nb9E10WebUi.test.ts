import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB9 E10 (the web UI's side, a JSON standby only) and code review round 1's lane C finding 3 (E9 after the
// credentials check), through a real start() with the forkMock children and the IPC messages the bot sends.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { fork } from 'child_process';
import { BotManager, B4_LINE, b6Line } from '../../src/webui/botManager';
import { EXIT_DEPOSED } from '../../src/bot/internalSetup/utils/dataManager';
import { resetAddressesForTests } from '../../src/utils/databaseAddress';
import { forks, forkStage } from '../helpers/forkMock';
import { exitChild, freshWriterLock, logged, resetForks, sentTo, tick } from '../helpers/nb10Rig';

let warn: ReturnType<typeof vi.spyOn>;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
let managers: BotManager[] = [];
let token: string | undefined;

beforeEach(() => {
  resetForks();
  forkStage.stages = ['shared', 'guild'];
  freshWriterLock('webui');
  resetAddressesForTests();
  safety.recordCrash.mockClear();
  token = process.env.DISCORD_TOKEN;
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  managers = [];
});

afterEach(() => {
  vi.useRealTimers();
  if (token === undefined) delete process.env.DISCORD_TOKEN; else process.env.DISCORD_TOKEN = token;
  for (const manager of managers) manager.cancelCrashRestart();
  for (const child of forks.children) if (child.exitCode === null && child.signalCode === null) exitChild(child, 0);
  vi.restoreAllMocks();
});

const ATTEMPT = 'a-1';
const CALLED_OFF = '[BotManager] The automatic start after the crash was called off: the bot is being started now';
const lines = (): string[] => [...logged(log), ...logged(warn)];
const answers = (child: any): any[] => sentTo(child, 'reshard:standby-state').map(m => m.data);
const retires = (child: any): any[] => sentTo(child, 'reshard:retire');

function fresh(): BotManager {
  const manager = new BotManager();
  managers.push(manager);
  return manager;
}

function ask(child: any, json: boolean, attempt = ATTEMPT): void {
  child.emit('message', {
    type: 'control:reshard-standby',
    data: { attempt, to: 8, intents: 513, maxConcurrency: 1, ...(json ? { json: true } : { entry: 'postgres://db-a/x' }) },
  });
}

/** A started bot process under fake timers with a standby of ATTEMPT forked by its ask. */
async function overlap(json: boolean): Promise<{ manager: BotManager; child: any; standby: any }> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const manager = fresh();
  const start = manager.start();
  await vi.advanceTimersByTimeAsync(600);
  expect((await start).success).toBe(true);
  const child = forks.children.at(-1);
  manager.noteMemoryReading({ room: true, useMb: 300, freeMb: 900, at: new Date().toISOString() });
  ask(child, json);
  const standby = forks.children.at(-1);
  expect(standby).not.toBe(child);
  await vi.advanceTimersByTimeAsync(5);
  return { manager, child, standby };
}

/** The bot process's answer to each 'reshard:retire', after `delayMs`; undefined leaves it unanswered. */
function retireAnswer(child: any, accepted: boolean | undefined, delayMs = 1): void {
  child.send.mockImplementation((message: any) => {
    if (message?.type === 'reshard:retire' && accepted !== undefined) {
      setTimeout(() => child.emit('message', { requestId: message.requestId, data: { accepted } }), delayMs);
    }
    return true;
  });
}

const U_MS = (600 + 11 * 8) * 1000;

describe("E10: 'ended' to the bot process for a JSON standby stopped by B6", () => {
  it("the deadline B6: 'ended' with the deadline's cause", async () => {
    const { child, standby } = await overlap(true);
    await vi.advanceTimersByTimeAsync(U_MS + 1000);
    expect(standby.signals).toEqual(['SIGTERM']);
    const cause = 'not every new shard was connected within 11 min';
    expect(lines()).toContain(b6Line(cause));
    expect(answers(child)).toEqual([
      { attempt: ATTEMPT, state: 'started' },
      { attempt: ATTEMPT, state: 'ended', reason: cause },
    ]);
  });

  it("the no-answer B6: 'ended' with the retire's 5 s", async () => {
    const { child, standby } = await overlap(true);
    standby.emit('message', { type: 'reshard:standby-ready', data: { attempt: ATTEMPT } });
    await vi.advanceTimersByTimeAsync(5_100);
    expect(standby.signals).toEqual(['SIGTERM']);
    expect(lines()).toContain(b6Line('the reshard was called off'));
    expect(answers(child).at(-1)).toEqual({ attempt: ATTEMPT, state: 'ended', reason: 'the bot process did not answer the retire within 5 s' });
  });

  it("accepted: false stops the standby with no 'ended' (the bot called off already)", async () => {
    const { child, standby } = await overlap(true);
    retireAnswer(child, false);
    standby.emit('message', { type: 'reshard:standby-ready', data: { attempt: ATTEMPT } });
    await vi.advanceTimersByTimeAsync(20);
    expect(standby.signals).toEqual(['SIGTERM']);
    expect(answers(child).map(a => a.state)).toEqual(['started']);
  });

  it("a fork that throws: the error line, then 'ended' with the error", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const manager = fresh();
    const start = manager.start();
    await vi.advanceTimersByTimeAsync(600);
    await start;
    const child = forks.children.at(-1);
    manager.noteMemoryReading({ room: true, useMb: 300, freeMb: 900, at: new Date().toISOString() });
    const sendsAtError: number[] = [];
    error.mockImplementation(() => { sendsAtError.push(answers(child).length); });
    (fork as any).mockImplementationOnce(() => { throw new Error('spawn EAGAIN'); });
    ask(child, true);
    expect(forks.children).toHaveLength(1);
    expect(error).toHaveBeenCalledWith('[BotManager] Error starting bot:', 'spawn EAGAIN');
    expect(sendsAtError).toEqual([0]);
    expect(answers(child)).toEqual([
      { attempt: ATTEMPT, state: 'ended', reason: 'the second bot process could not be started (spawn EAGAIN)' },
    ]);
  });

  it("the deadline passing during the retire's wait: the bot's acceptance promotes", async () => {
    const { manager, child, standby } = await overlap(true);
    retireAnswer(child, true, 3_000);
    await vi.advanceTimersByTimeAsync(U_MS - 1_000);
    standby.emit('message', { type: 'reshard:standby-ready', data: { attempt: ATTEMPT } });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(standby.signals).toEqual([]);
    expect(answers(child).map(a => a.state)).toEqual(['started']);
    child.emit('message', { type: 'control:reshard-retire', data: { attempt: ATTEMPT } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(lines()).toContain(B4_LINE);
    expect((manager as any).botProcess).toBe(standby);
  });

  it("a late 'reshard:standby-ready' after the stop sends no retire", async () => {
    forks.holdExit = true;
    const { child, standby } = await overlap(true);
    await vi.advanceTimersByTimeAsync(U_MS + 1000);
    expect(standby.signals).toEqual(['SIGTERM']);
    standby.emit('message', { type: 'reshard:standby-ready', data: { attempt: ATTEMPT } });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(retires(child)).toEqual([]);
    expect(answers(child).filter(a => a.state === 'ended')).toHaveLength(1);
  });

  it("a Postgres standby's B6 sends no 'ended'", async () => {
    const { child, standby } = await overlap(false);
    await vi.advanceTimersByTimeAsync(U_MS + 1000);
    expect(standby.signals).toEqual([]);
    ask(child, false, 'b-1');
    await vi.advanceTimersByTimeAsync(5);
    expect(standby.signals).toEqual(['SIGTERM']);
    expect(lines()).toContain(b6Line('the second bot process is not the one for this reshard'));
    exitChild(standby, 0);
    expect(answers(child).map(a => a.state)).toEqual(['started', 'started']);
  });
});

describe('E9 after the credentials check (lane C finding 3)', () => {
  it('a pending crash restart, the credentials removed, a Start: the timer stays and no line', async () => {
    const manager = fresh();
    const result = await manager.start();
    expect(result.success).toBe(true);
    await tick(5);
    exitChild(forks.children.at(-1), EXIT_DEPOSED);
    expect((manager as any).crashRestartTimer).not.toBe(null);
    process.env.DISCORD_TOKEN = '';
    expect((await manager.start()).reason).toBe('credentials_missing');
    expect((manager as any).crashRestartTimer).not.toBe(null);
    expect(lines()).not.toContain(CALLED_OFF);
  });
});
