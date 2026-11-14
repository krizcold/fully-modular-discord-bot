import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { BotManager, B4_LINE } from '../../src/webui/botManager';
import { resetAddressesForTests } from '../../src/utils/databaseAddress';
import { forks, forkStage } from '../helpers/forkMock';
import { exitChild, freshWriterLock, logged, resetForks, sentTo, tick } from '../helpers/nb10Rig';

let log: ReturnType<typeof vi.spyOn>;
let managers: BotManager[] = [];

beforeEach(() => {
  resetForks();
  forkStage.stages = ['shared', 'guild'];
  freshWriterLock('webui');
  resetAddressesForTests();
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
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

const ATTEMPT = 'a-7';

async function started(): Promise<{ manager: BotManager; child: any }> {
  const manager = new BotManager();
  managers.push(manager);
  const result = await manager.start();
  expect(result.success).toBe(true);
  await tick(5);
  manager.noteMemoryReading({ room: true, useMb: 300, freeMb: 900, at: new Date().toISOString() });
  return { manager, child: forks.children.at(-1) };
}

/** A standby forked under fake timers; `base` is the pending timer count before its fork. */
async function standbyUnderFakeTimers(json: boolean): Promise<{ manager: BotManager; child: any; standby: any; base: number }> {
  const { manager, child } = await started();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const base = vi.getTimerCount();
  const data = json
    ? { attempt: ATTEMPT, to: 8, intents: 513, maxConcurrency: 1, json: true }
    : { attempt: ATTEMPT, to: 8, intents: 513, maxConcurrency: 1, entry: 'postgres://db-a/x' };
  child.emit('message', { type: 'control:reshard-standby', data });
  const standby = forks.children.at(-1);
  expect(standby).not.toBe(child);
  expect(sentTo(child, 'reshard:standby-state').at(-1)?.data).toEqual({ attempt: ATTEMPT, state: 'started' });
  await vi.advanceTimersByTimeAsync(10);
  return { manager, child, standby, base };
}

describe('the JSON standby deadline', () => {
  it('is pending while the JSON standby boots, and a Postgres standby has none', async () => {
    const json = await standbyUnderFakeTimers(true);
    expect(vi.getTimerCount()).toBe(json.base + 1);
    vi.useRealTimers();
    exitChild(json.standby, 0);
    const pg = await standbyUnderFakeTimers(false);
    expect(vi.getTimerCount()).toBe(pg.base);
  });

  it('ends when the JSON standby exits by itself before it is ready', async () => {
    const { child, standby, base } = await standbyUnderFakeTimers(true);
    exitChild(standby, 1);
    expect(sentTo(child, 'reshard:standby-state').at(-1)?.data).toEqual({ attempt: ATTEMPT, state: 'ended', reason: 'exit code 1, signal null' });
    expect(vi.getTimerCount()).toBe(base);
  });

  it('ends at a stop of the JSON standby, leaving only the stop wait, and nothing is left after its exit', async () => {
    const { manager, standby, base } = await standbyUnderFakeTimers(true);
    forks.holdExit = true;
    manager.beginExit();
    expect(standby.signals).toEqual(['SIGTERM']);
    expect(vi.getTimerCount()).toBe(base + 1);
    exitChild(standby, 0);
    expect(vi.getTimerCount()).toBe(base);
  });

  it('ends when a JSON standby is promoted before it reported ready', async () => {
    const { manager, child, standby, base } = await standbyUnderFakeTimers(true);
    child.emit('message', { type: 'control:reshard-retire', data: { attempt: ATTEMPT } });
    await vi.advanceTimersByTimeAsync(100);
    expect(child.signals).toEqual(['SIGTERM']);
    expect(logged(log)).toContain(B4_LINE);
    expect((manager as any).botProcess).toBe(standby);
    expect(standby.signals).toEqual([]);
    expect(vi.getTimerCount()).toBe(base);
  });
});

describe("the standby's stop wait", () => {
  it('is cleared at the exit of a stopped Postgres standby', async () => {
    const { manager, standby, base } = await standbyUnderFakeTimers(false);
    forks.holdExit = true;
    manager.beginExit();
    expect(vi.getTimerCount()).toBe(base + 1);
    exitChild(standby, 0);
    expect(vi.getTimerCount()).toBe(base);
    await vi.advanceTimersByTimeAsync(41_000);
    expect(standby.signals).toEqual(['SIGTERM']);
  });

  it('sends no SIGKILL to a stopped standby that is gone without an exit event', async () => {
    const { manager, standby } = await standbyUnderFakeTimers(false);
    forks.holdExit = true;
    manager.beginExit();
    standby.exitCode = -2;
    await vi.advanceTimersByTimeAsync(41_000);
    expect(standby.signals).toEqual(['SIGTERM']);
  });

  it('kills a stopped standby that outlives the stop wait', async () => {
    const { manager, standby } = await standbyUnderFakeTimers(false);
    forks.holdExit = true;
    manager.beginExit();
    await vi.advanceTimersByTimeAsync(41_000);
    expect(standby.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});

describe('messages with no data', () => {
  it("a standby's 'reshard:standby-stopping' with no data is answered not promoted", async () => {
    const { child } = await started();
    child.emit('message', { type: 'control:reshard-standby', data: { attempt: ATTEMPT, to: 8, intents: 513, maxConcurrency: 1, entry: 'postgres://db-a/x' } });
    const standby = forks.children.at(-1);
    expect(standby).not.toBe(child);
    expect(() => standby.emit('message', { type: 'reshard:standby-stopping' })).not.toThrow();
    expect(sentTo(standby, 'reshard:standby-stop-answer').map(m => m.data)).toEqual([{ promoted: false }]);
  });

  it.each([
    ['no data', undefined],
    ['data null', null],
  ])("the bot process's 'control:reshard-retire' with %s stops the bot process", async (_name, data) => {
    const { manager, child } = await started();
    forks.holdExit = true;
    expect(() => child.emit('message', { type: 'control:reshard-retire', ...(data === undefined ? {} : { data }) })).not.toThrow();
    expect((manager as any).retiring).toMatchObject({ child, attempt: null });
    await tick(5);
    expect(child.signals).toEqual(['SIGTERM']);
  });
});
