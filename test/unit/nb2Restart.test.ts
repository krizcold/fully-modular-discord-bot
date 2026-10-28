import { beforeEach, describe, expect, it, vi } from 'vitest';

// NB2 ruling 5 (and 7, 8: the bot process asks for its restart): the web UI process restarts its bot child with
// SIGTERM, so the child's exit drain runs, and that restart does not count as a crash.

const forks = vi.hoisted(() => ({ children: [] as any[], exitCode: 0 as number | null }));
const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));

vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { EventEmitter: Emitter } = await import('events');
  const fork = vi.fn(() => {
    const child: any = new Emitter();
    child.stdout = new Emitter();
    child.stderr = new Emitter();
    child.exitCode = null;
    child.signalCode = null;
    child.pid = 1000 + forks.children.length;
    child.signals = [] as string[];
    child.send = vi.fn();
    child.kill = vi.fn((signal: string) => {
      child.signals.push(signal);
      child.killed = true;
      // The child's SIGTERM handler drains and exits 0 (clientInitializer.ts).
      setTimeout(() => {
        child.exitCode = forks.exitCode;
        child.emit('exit', forks.exitCode, null);
      }, 10);
      return true;
    });
    forks.children.push(child);
    setTimeout(() => child.stdout.emit('data', Buffer.from('Logged in as test#0001!\n')), 5);
    return child;
  });
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { BotManager } from '../../src/webui/botManager';

beforeEach(() => {
  forks.children.length = 0;
  forks.exitCode = 0;
  safety.recordCrash.mockClear();
  process.env.DISCORD_TOKEN = 'token';
  process.env.CLIENT_ID = '1';
  process.env.GUILD_ID = '2';
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('ruling 5: the restart that ends maintenance', () => {
  it('stops the child with SIGTERM (its exit drain), starts a new one, and counts no crash', async () => {
    const manager = new BotManager();
    expect((await manager.start()).success).toBe(true);
    const first = forks.children[0];
    const result = await manager.restart();
    expect(result.success).toBe(true);
    expect(first.signals).toEqual(['SIGTERM']);
    expect(forks.children).toHaveLength(2);
    expect(safety.recordCrash).not.toHaveBeenCalled();
    expect(manager.getStatus().crashed).toBe(false);
    await manager.shutdown();
  });

  it('a nonzero exit is still counted as a crash (the counter reads exit codes only)', async () => {
    const manager = new BotManager();
    await manager.start();
    forks.children[0].exitCode = 1;
    forks.children[0].emit('exit', 1, null);
    expect(safety.recordCrash).toHaveBeenCalledTimes(1);
    manager.cancelCrashRestart();
  });

  it('control:restart-bot from the bot process restarts it', async () => {
    const manager = new BotManager();
    await manager.start();
    forks.children[0].emit('message', { type: 'control:restart-bot', data: { reason: 'The database accepted the login again' } });
    await tick(1500);
    expect(forks.children[0].signals).toEqual(['SIGTERM']);
    expect(forks.children).toHaveLength(2);
    expect(safety.recordCrash).not.toHaveBeenCalled();
    await manager.shutdown();
  }, 15_000);

  it('ruling B (F1): control:restart-bot while a start holds the operation lock restarts once that start ends; a second request joins it', async () => {
    const manager = new BotManager();
    const starting = manager.start();
    expect(forks.children).toHaveLength(1);
    forks.children[0].emit('message', { type: 'control:restart-bot', data: { reason: 'r1' } });
    forks.children[0].emit('message', { type: 'control:restart-bot', data: { reason: 'r2' } });
    expect((await starting).success).toBe(true);
    await vi.waitFor(() => expect(forks.children).toHaveLength(2), { timeout: 5000 });
    await tick(300);
    expect(forks.children).toHaveLength(2);
    expect(forks.children[0].signals).toEqual(['SIGTERM']);
    expect(safety.recordCrash).not.toHaveBeenCalled();
    await manager.shutdown();
  }, 15_000);

  it('R2-4: control:restart-bot that lands while the operator stops the bot does not start it again', async () => {
    const manager = new BotManager();
    await manager.start();
    const stopping = manager.shutdown();
    forks.children[0].emit('message', { type: 'control:restart-bot', data: { reason: 'saved' } });
    await stopping;
    await tick(1500);
    expect(forks.children).toHaveLength(1);
    expect(manager.isRunning()).toBe(false);
  }, 15_000);

  it('R3-2: a restart asked by a new child while an older child\'s restart is still queued is not joined to it', async () => {
    const manager = new BotManager();
    await manager.start();
    let finishOld!: (r: any) => void;
    const old = new Promise<any>(resolve => { finishOld = resolve; });
    (manager as any).queuedRestart = old;
    (manager as any).queuedRestartChild = { pid: -1 };
    const mine = manager.requestRestart();
    expect(mine).not.toBe(old);
    finishOld({ success: true });
    expect((await mine).success).toBe(true);
    expect(forks.children).toHaveLength(2);
    expect(forks.children[0].signals).toEqual(['SIGTERM']);
    await manager.shutdown();
  }, 15_000);

  it('R3-1: a child that reports held shows the mode and its counts in the status', async () => {
    const manager = new BotManager();
    await manager.start();
    forks.children[0].emit('message', { type: 'maintenance:mode', data: { mode: 'held', held: { unsavedGuilds: 1, unsavedFiles: 2 } } });
    expect(manager.getStatus()).toMatchObject({ mode: 'held', held: { unsavedGuilds: 1, unsavedFiles: 2 } });
    expect(manager.isServingNormally()).toBe(false);
    await manager.shutdown();
  }, 15_000);

  it('ruling B: requestRestart joins a queued restart and returns its result', async () => {
    const manager = new BotManager();
    const starting = manager.start();
    const first = manager.requestRestart();
    const second = manager.requestRestart();
    expect(second).toBe(first);
    await starting;
    expect((await first).success).toBe(true);
    expect(forks.children).toHaveLength(2);
    await manager.shutdown();
  }, 15_000);

  it('the mode the bot process reports decides whether it serves normally; a new child starts serving', async () => {
    const manager = new BotManager();
    await manager.start();
    expect(manager.isServingNormally()).toBe(true);
    forks.children[0].emit('message', { type: 'maintenance:mode', data: { mode: 'login-refused' } });
    expect(manager.isServingNormally()).toBe(false);
    await manager.restart();
    expect(manager.isServingNormally()).toBe(true);
    await manager.shutdown();
    expect(manager.isServingNormally()).toBe(false);
  }, 15_000);
});

