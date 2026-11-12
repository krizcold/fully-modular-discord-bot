import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// L5 run A survivors in webui/botManager.ts (attachChild, botProcessExit): what a child's output, errors, messages and
// exits leave in the operator's log, the parent's stderr, the crash record and the status. BotManager over the
// forkMock child with a mocked safety manager.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { BotManager, B7_LINE, b15Line } from '../../src/webui/botManager';
import { forks, forkStage } from '../helpers/forkMock';
import { exitChild, freshWriterLock, logged, resetForks, sentTo } from '../helpers/nb10Rig';

let log: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;
let managers: BotManager[] = [];

beforeEach(() => {
  resetForks();
  forkStage.stages = ['shared', 'guild'];
  freshWriterLock('webui');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  safety.recordCrash.mockClear();
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  managers = [];
});

afterEach(() => {
  vi.useRealTimers();
  for (const manager of managers) manager.cancelCrashRestart();
  for (const child of forks.children) if (child.exitCode === null && child.signalCode === null) exitChild(child, 0);
  vi.restoreAllMocks();
});

const lines = (): string[] => [...logged(log), ...logged(warn), ...logged(error)];

function fresh(): BotManager {
  const manager = new BotManager();
  managers.push(manager);
  return manager;
}

async function started(manager = fresh()): Promise<{ manager: BotManager; child: any }> {
  const pending = manager.start();
  await vi.advanceTimersByTimeAsync(600);
  expect((await pending).success).toBe(true);
  return { manager, child: forks.children.at(-1) };
}

async function withStandby(): Promise<{ manager: BotManager; child: any; standby: any }> {
  const { manager, child } = await started();
  manager.noteMemoryReading({ room: true, useMb: 300, freeMb: 900, at: new Date().toISOString() });
  child.emit('message', { type: 'control:reshard-standby', data: { attempt: 'a-1', to: 8, intents: 513, maxConcurrency: 1, entry: 'postgres://db-a/x' } });
  const standby = forks.children.at(-1);
  expect(standby).not.toBe(child);
  await vi.advanceTimersByTimeAsync(5);
  return { manager, child, standby };
}

describe("a child's stderr", () => {
  it("the bot process's stderr line is logged as '[ERROR] ...' with no prefix, and reaches the parent's stderr", async () => {
    const { manager, child } = await started();
    child.stderr.emit('data', Buffer.from('boom\n'));
    expect(manager.getLogs().current.at(-1)).toBe('[ERROR] boom\n');
    expect(stderr).toHaveBeenCalledWith('[Bot] [ERROR] boom\n');
  });

  it("the standby's stderr line carries '[Standby] ' in the log and on the parent's stderr", async () => {
    const { manager, standby } = await withStandby();
    standby.stderr.emit('data', Buffer.from('late\n'));
    expect(manager.getLogs().current).toContain('[Standby] [ERROR] late\n');
    expect(stderr).toHaveBeenCalledWith('[Bot] [Standby] [ERROR] late\n');
  });
});

describe("a child's 'error' event", () => {
  it('is printed with its tag and logged with its message', async () => {
    const { manager, child } = await started();
    const err = new Error('spawn EACCES');
    child.emit('error', err);
    expect(error).toHaveBeenCalledWith('[BotManager] Bot process error:', err);
    expect(manager.getLogs().current).toContain('[BotManager] Process error: spawn EACCES');
  });
});

describe("a child's messages", () => {
  it('a null or undefined message from the bot process is ignored', async () => {
    const { manager, child } = await started();
    expect(() => child.emit('message', null)).not.toThrow();
    expect(() => child.emit('message', undefined)).not.toThrow();
    expect(manager.getStatus().running).toBe(true);
  });

  it('a message from a child that is neither the bot process nor the standby moves nothing', async () => {
    const { manager, child } = await started();
    exitChild(child, 0);
    expect(manager.getStatus().running).toBe(false);
    expect(() => child.emit('message', { type: 'reshard:standby-stopping', data: { reason: 'x', kind: 'called-off' } })).not.toThrow();
    expect(() => child.emit('message', { type: 'reshard:standby-progress', data: { held: 1, ready: 1 } })).not.toThrow();
    expect(sentTo(child, 'reshard:standby-stop-answer')).toEqual([]);
  });
});

describe("the retiring bot process's exit", () => {
  it("logs 'Bot exited with code' once, then starts a new bot process (B7)", async () => {
    const { child } = await started();
    child.emit('message', { type: 'control:reshard-retire', data: { attempt: 'a-1' } });
    await vi.advanceTimersByTimeAsync(40);
    expect(child.signals).toEqual(['SIGTERM']);
    expect(lines().filter(l => l === '[BotManager] Bot exited with code: 0, signal: null')).toHaveLength(1);
    expect(lines()).toContain(B7_LINE);
  });
});

describe("the bot process's own exit", () => {
  it("a crash logs 'Bot exited with code', keeps the log before it as the crash log, and logs the exit code", async () => {
    const { manager, child } = await started();
    child.stderr.emit('data', Buffer.from('fatal\n'));
    exitChild(child, 3);
    expect(lines()).toContain('[BotManager] Bot exited with code: 3, signal: null');
    const shown = manager.getLogs(true);
    expect(shown.crashed).toBe(true);
    expect(shown.crash).toContain('[ERROR] fatal\n');
    expect(safety.recordCrash.mock.calls[0][2]).toContain('[ERROR] fatal\n');
    expect(shown.current).toContain('\n[BotManager] BOT CRASHED - Exit code: 3\n');
    expect(shown.current).not.toContain(`\n${b15Line(null)}\n`);
    expect(manager.getStatus().crashed).toBe(true);
  });

  it('a clean exit leaves the status not crashed and no crash log', async () => {
    const { manager, child } = await started();
    exitChild(child, 0);
    expect(manager.getStatus().crashed).toBe(false);
    expect(manager.getLogs(true).crashed).toBe(false);
  });
});

describe('the automatic start budget', () => {
  async function fiveQuickCrashes(): Promise<BotManager> {
    const { manager } = await started();
    for (let i = 0; i < 5; i += 1) {
      exitChild(forks.children[i], 1);
      await vi.advanceTimersByTimeAsync(5_700);
    }
    expect(forks.children).toHaveLength(6);
    expect(lines()).toContain('[BotManager] Starting the bot again in 5s (automatic start 5 of 5)');
    return manager;
  }

  it('a sixth quick crash keeps the bot down and names the 10 minutes of uptime', async () => {
    await fiveQuickCrashes();
    exitChild(forks.children[5], 1);
    expect(lines()).toContain('[BotManager] The bot stays down: 5 automatic starts in a row ended in a crash before 10 minutes of uptime; start it by hand');
    await vi.advanceTimersByTimeAsync(6_000);
    expect(forks.children).toHaveLength(6);
  });

  it('a run of 10 minutes resets the count: its crash is started again as start 1 of 5', async () => {
    await fiveQuickCrashes();
    await vi.advanceTimersByTimeAsync(600_000);
    exitChild(forks.children[5], 1);
    expect(lines()).toContain('[BotManager] Starting the bot again in 5s (automatic start 1 of 5)');
    expect(lines().some(l => l.startsWith('[BotManager] The bot stays down:'))).toBe(false);
  });

  it('a start time of 0 (no start time known) never counts as a stable run', async () => {
    vi.setSystemTime(0);
    const { manager } = await started();
    expect((manager as any).botStartTime).toBe(0);
    (manager as any).crashRestarts = 5;
    await vi.advanceTimersByTimeAsync(600_000);
    exitChild(forks.children[0], 1);
    expect(lines()).toContain('[BotManager] The bot stays down: 5 automatic starts in a row ended in a crash before 10 minutes of uptime; start it by hand');
    expect(lines()).not.toContain('[BotManager] Starting the bot again in 5s (automatic start 1 of 5)');
  });
});
