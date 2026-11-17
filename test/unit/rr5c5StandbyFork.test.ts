import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { fork } from 'child_process';
import { BotManager, b6Line } from '../../src/webui/botManager';
import { resetAddressesForTests } from '../../src/utils/databaseAddress';
import { forks, forkStage } from '../helpers/forkMock';
import { exitChild, freshWriterLock, logged, resetForks, sentTo, tick } from '../helpers/nb10Rig';

let warn: ReturnType<typeof vi.spyOn>;
let log: ReturnType<typeof vi.spyOn>;
let managers: BotManager[] = [];

beforeEach(() => {
  resetForks();
  forkStage.stages = ['shared', 'guild'];
  freshWriterLock('webui');
  resetAddressesForTests();
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  managers = [];
});

afterEach(() => {
  vi.useRealTimers();
  forks.holdExit = false;
  for (const manager of managers) manager.cancelCrashRestart();
  for (const child of forks.children) if (child.exitCode === null && child.signalCode === null) exitChild(child, 0);
  vi.restoreAllMocks();
});

const lines = (): string[] => [...logged(log), ...logged(warn)];
const answers = (child: any): any[] => sentTo(child, 'reshard:standby-state').map(m => m.data);
const lastEnv = (): Record<string, string | undefined> => (fork as any).mock.calls.at(-1)[2].env;

function fresh(): BotManager {
  const manager = new BotManager();
  managers.push(manager);
  return manager;
}

function roomy(manager: BotManager): void {
  manager.noteMemoryReading({ room: true, useMb: 300, freeMb: 900, at: new Date().toISOString() });
}

function ask(child: any, data: Record<string, unknown>): void {
  child.emit('message', { type: 'control:reshard-standby', data: { attempt: 'a-1', to: 8, intents: 513, ...data } });
}

async function started(): Promise<{ manager: BotManager; child: any }> {
  const manager = fresh();
  const result = await manager.start();
  expect(result.success).toBe(true);
  await tick(5);
  const child = forks.children.at(-1);
  roomy(manager);
  return { manager, child };
}

describe("the standby's env from the ask", () => {
  it.each([
    [0, '1'],
    [-3, '1'],
    [4, '4'],
    [1, '1'],
  ])('maxConcurrency %s forks with SMDB_RESHARD_MC %s', async (maxConcurrency, mc) => {
    const { child } = await started();
    ask(child, { maxConcurrency, entry: 'postgres://db-a/x' });
    expect(forks.children).toHaveLength(2);
    expect(lastEnv().SMDB_RESHARD_MC).toBe(mc);
  });

  it.each([
    ['a number entry', { entry: 7 }],
    ['no entry', {}],
    ['an empty entry', { entry: '' }],
    ['a JSON ask with an entry', { json: true, entry: 'postgres://db-a/x' }],
  ])('%s forks with no SMDB_RESHARD_DB', async (_name, data) => {
    const { child } = await started();
    ask(child, { maxConcurrency: 1, ...data });
    expect(answers(child)).toEqual([{ attempt: 'a-1', state: 'started' }]);
    expect(forks.children).toHaveLength(2);
    expect(Object.prototype.hasOwnProperty.call(lastEnv(), 'SMDB_RESHARD_DB')).toBe(false);
  });

  it('a database ask with a string entry forks with it as SMDB_RESHARD_DB', async () => {
    const { child } = await started();
    ask(child, { maxConcurrency: 1, entry: 'postgres://db-a/x' });
    expect(lastEnv().SMDB_RESHARD_DB).toBe('postgres://db-a/x');
  });
});

describe('a JSON standby deadline after the standby was replaced', () => {
  it("the first standby's deadline leaves the second one running and sends no 'ended'", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const manager = fresh();
    const start = manager.start();
    await vi.advanceTimersByTimeAsync(600);
    await start;
    const child = forks.children.at(-1);
    roomy(manager);
    ask(child, { json: true, maxConcurrency: 1 });
    const first = forks.children.at(-1);
    expect(first).not.toBe(child);
    // A spawn that fails as EAGAIN does in Node: exitCode set and 'error' emitted with no 'exit'.
    first.exitCode = -11;
    first.emit('error', Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' }));
    await vi.advanceTimersByTimeAsync(100_000);
    roomy(manager);
    ask(child, { json: true, maxConcurrency: 1 });
    const second = forks.children.at(-1);
    expect(second).not.toBe(first);
    expect(answers(child).map(a => a.state)).toEqual(['started', 'started']);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(second.signals).toEqual([]);
    expect(answers(child).map(a => a.state)).toEqual(['started', 'started']);
    expect(lines()).not.toContain(b6Line('not every new shard was connected within 11 min'));
    await vi.advanceTimersByTimeAsync(100_000);
    expect(second.signals).toEqual(['SIGTERM']);
    expect(lines()).toContain(b6Line('not every new shard was connected within 11 min'));
  });
});

describe('a stopped standby that outlives the stop wait', () => {
  it('is killed with SIGKILL after 40 s, not before', async () => {
    const { manager, child } = await started();
    ask(child, { maxConcurrency: 1, entry: 'postgres://db-a/x' });
    const first = forks.children.at(-1);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    forks.holdExit = true;
    roomy(manager);
    child.emit('message', { type: 'control:reshard-standby', data: { attempt: 'a-2', to: 8, intents: 513, maxConcurrency: 1, entry: 'postgres://db-a/x' } });
    expect(lines()).toContain(b6Line('the second bot process is not the one for this reshard'));
    expect(first.signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(39_000);
    expect(first.signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(first.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});

describe("'reshard:standby-progress' with no data", () => {
  it.each([
    ['no data', undefined],
    ['null data', null],
  ])('%s does not throw out of the message handler', async (_name, data) => {
    const { child } = await started();
    ask(child, { maxConcurrency: 1, entry: 'postgres://db-a/x' });
    const standby = forks.children.at(-1);
    expect(standby).not.toBe(child);
    expect(() => standby.emit('message', { type: 'reshard:standby-progress', data })).not.toThrow();
  });
});
