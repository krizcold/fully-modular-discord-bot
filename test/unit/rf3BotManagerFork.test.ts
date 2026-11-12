import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// L5 run A chunk 3: what BotManager forks (entry, exec args, env), the lines it logs for a child's output, the
// broadcasts of panel updates and live states, and the hand-over-held line once per child.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { fork } from 'child_process';
import { BotManager, b8Line } from '../../src/webui/botManager';
import { acceptAddressList, resetAddressesForTests } from '../../src/utils/databaseAddress';
import { forks, forkStage } from '../helpers/forkMock';
import { exitChild, freshWriterLock, logged, resetForks, tick } from '../helpers/nb10Rig';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_BOT = path.resolve(HERE, '..', '..', 'src', 'bot');

let log: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let outWrite: ReturnType<typeof vi.spyOn>;
let errWrite: ReturnType<typeof vi.spyOn>;
let managers: BotManager[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  resetForks();
  forkStage.stages = ['shared', 'guild'];
  freshWriterLock('webui');
  resetAddressesForTests();
  savedEnv.NODE_ENV = process.env.NODE_ENV;
  savedEnv.DATA_BACKEND_URL = process.env.DATA_BACKEND_URL;
  delete process.env.DATA_BACKEND_URL;
  (fork as unknown as ReturnType<typeof vi.fn>).mockClear();
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  outWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  errWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  managers = [];
});

afterEach(() => {
  for (const manager of managers) manager.cancelCrashRestart();
  for (const child of forks.children) if (child.exitCode === null && child.signalCode === null) exitChild(child, 0);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetAddressesForTests();
  vi.restoreAllMocks();
});

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

function lastFork(): { entry: string; args: unknown[]; options: { env: Record<string, unknown>; execArgv: string[] } } {
  const calls = (fork as unknown as ReturnType<typeof vi.fn>).mock.calls as any[][];
  const call = calls.at(-1)!;
  return { entry: call[0], args: call[1], options: call[2] };
}

const strings = (spy: ReturnType<typeof vi.spyOn>): string[] => spy.mock.calls.map((c: unknown[]) => String(c[0]));

describe('the entry and exec args of the forked bot process', () => {
  it('outside development: dist entry bot/index.js, no exec args, and the start line names it', async () => {
    process.env.NODE_ENV = 'production';
    await started();
    const { entry, options } = lastFork();
    const expected = path.join(SRC_BOT, 'index.js');
    expect(path.resolve(entry)).toBe(expected);
    expect(options.execArgv).toEqual([]);
    expect(logged(log)).toContain(`[BotManager] Starting bot from: ${entry}`);
    expect(strings(log).filter(l => l.startsWith('[BotManager] Starting bot from: '))).toEqual([`[BotManager] Starting bot from: ${entry}`]);
  });

  it('NODE_ENV test is not development: the dist entry and no ts-node', async () => {
    process.env.NODE_ENV = 'test';
    await started();
    const { entry, options } = lastFork();
    expect(path.resolve(entry)).toBe(path.join(SRC_BOT, 'index.js'));
    expect(options.execArgv).toEqual([]);
  });

  it('in development: the source entry bot/index.ts under ts-node/register', async () => {
    process.env.NODE_ENV = 'development';
    await started();
    const { entry, options } = lastFork();
    expect(path.resolve(entry)).toBe(path.join(SRC_BOT, 'index.ts'));
    expect(options.execArgv).toEqual(['-r', 'ts-node/register']);
    expect(strings(log)).toContain(`[BotManager] Starting bot from: ${entry}`);
  });
});

describe('the env of the forked bot process', () => {
  it('with no hook list accepted, the env carries no DATA_BACKEND_URL', async () => {
    await started();
    const { options } = lastFork();
    // fork skips an undefined env value; a null one reaches the child as the text "null".
    expect(options.env.DATA_BACKEND_URL).toBeUndefined();
    expect(options.env.BOT_PROCESS_ROLE).toBe('bot');
  });

  it('with a hook list accepted, the env carries it as DATA_BACKEND_URL', async () => {
    acceptAddressList('postgres://db-a/x');
    await started();
    expect(lastFork().options.env.DATA_BACKEND_URL).toBe('postgres://db-a/x');
  });
});

function fakeWs(): { broadcast: ReturnType<typeof vi.fn> } {
  return { broadcast: vi.fn(() => 3) };
}

describe('the panel broadcasts', () => {
  it('a panel update served by another node carries servedBy', () => {
    const manager = fresh();
    const ws = fakeWs();
    manager.setWebSocketManager(ws as any);
    expect(manager.emitPanelUpdate({ panelId: 'p1', guildId: 'g1', sessionId: 's1', response: { a: 1 }, servedBy: 'node-b' })).toBe(3);
    expect(ws.broadcast).toHaveBeenCalledTimes(1);
    const [type, data] = ws.broadcast.mock.calls[0] as [string, any];
    expect(type).toBe('panel:updated');
    expect(data).toMatchObject({ panelId: 'p1', guildId: 'g1', sessionId: 's1', panel: { a: 1 }, servedBy: 'node-b' });
  });

  it('a panel live state is broadcast as panel:live_status with its fields', () => {
    const manager = fresh();
    const ws = fakeWs();
    manager.setWebSocketManager(ws as any);
    const state = { guildId: 'g1', panelId: 'p1', live: false, reason: 'the node is down' };
    manager.emitPanelLiveStatus(state);
    expect(ws.broadcast).toHaveBeenCalledTimes(1);
    expect(ws.broadcast).toHaveBeenCalledWith('panel:live_status', state);
  });
});

describe('the member web panel setting sent to the bot process', () => {
  it('a send that throws is logged with its message', async () => {
    const { manager, child } = await started();
    child.send = vi.fn(() => { throw new Error('channel closed'); });
    manager.sendGuildWebUiSetting();
    expect(child.send).toHaveBeenCalledTimes(1);
    expect(strings(warn)).toContain('[BotManager] Could not tell the bot whether the member web panel is on: channel closed');
  });
});

describe("the bot process's output lines", () => {
  it('stdout of the current child is logged and written without a standby mark', async () => {
    const { manager, child } = await started();
    outWrite.mockClear();
    child.stdout.emit('data', Buffer.from('hello there\n'));
    expect(manager.getLogs().current.at(-1)).toBe('hello there\n');
    expect(strings(outWrite)).toEqual(['[Bot] hello there\n']);
  });

  it('stderr of the current child is logged and written as [ERROR] without a standby mark', async () => {
    const { manager, child } = await started();
    errWrite.mockClear();
    child.stderr.emit('data', Buffer.from('boom\n'));
    expect(manager.getLogs().current.at(-1)).toBe('[ERROR] boom\n');
    expect(strings(errWrite)).toEqual(['[Bot] [ERROR] boom\n']);
  });

  it("the standby's stderr carries the standby mark", async () => {
    const { manager, child } = await started();
    manager.noteMemoryReading({ room: true, useMb: 300, freeMb: 900, at: new Date().toISOString() });
    child.emit('message', { type: 'control:reshard-standby', data: { attempt: 'a-1', to: 8, intents: 513, maxConcurrency: 1, entry: 'postgres://db-a/x' } });
    const standby = forks.children.at(-1);
    expect(standby).not.toBe(child);
    await tick(5);
    errWrite.mockClear();
    outWrite.mockClear();
    standby.stderr.emit('data', Buffer.from('late\n'));
    standby.stdout.emit('data', Buffer.from('up\n'));
    expect(strings(errWrite)).toEqual(['[Bot] [Standby] [ERROR] late\n']);
    expect(strings(outWrite)).toEqual(['[Bot] [Standby] up\n']);
    expect(manager.getLogs().current.slice(-2)).toEqual(['[Standby] [ERROR] late\n', '[Standby] up\n']);
  });
});

describe('the held hand-over line', () => {
  it('is logged once per child: a new child logs the same cause again', async () => {
    const cause = 'another operation is in progress';
    const manager = fresh();
    const first = (await started(manager)).child;
    (manager as any).operationInProgress = true;
    first.emit('message', { type: 'control:reshard-retire', data: { attempt: 'a-1' } });
    first.emit('message', { type: 'control:reshard-retire', data: { attempt: 'a-1' } });
    expect(strings(warn).filter(l => l === b8Line(cause))).toHaveLength(1);
    (manager as any).operationInProgress = false;

    await manager.shutdown(false);
    expect(manager.isRunning()).toBe(false);
    const second = (await started(manager)).child;
    expect(second).not.toBe(first);
    (manager as any).operationInProgress = true;
    second.emit('message', { type: 'control:reshard-retire', data: { attempt: 'a-2' } });
    (manager as any).operationInProgress = false;
    expect(strings(warn).filter(l => l === b8Line(cause))).toHaveLength(2);
  });
});
