import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
const mirror = vi.hoisted(() => ({ throwWith: null as string | null }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
vi.mock('../../src/bot/internalSetup/utils/sharedMirror', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/sharedMirror')>();
  return {
    ...real,
    refreshShared: (...args: Parameters<typeof real.refreshShared>) => {
      if (mirror.throwWith !== null) return Promise.reject(new Error(mirror.throwWith));
      return real.refreshShared(...args);
    },
  };
});

import { BotManager } from '../../src/webui/botManager';
import { forks, forkStage } from '../helpers/forkMock';
import { freshWriterLock, resetForks, sentTo, tick } from '../helpers/nb10Rig';
import { setBackendKind } from '../helpers/backendKind';
import { writerLockDepth } from '../../src/bot/internalSetup/utils/writerLock';

let managers: BotManager[] = [];

beforeEach(() => {
  resetForks();
  forkStage.stages = ['shared', 'guild'];
  freshWriterLock('webui');
  mirror.throwWith = null;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  managers = [];
});

afterEach(() => {
  for (const manager of managers) manager.cancelCrashRestart();
  for (const child of forks.children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.exitCode = 0;
      child.emit('exit', 0, null);
    }
  }
  setBackendKind(null);
  mirror.throwWith = null;
  vi.restoreAllMocks();
});

const reading = () => ({ room: true, useMb: 300, freeMb: 900, at: new Date().toISOString() });

async function startedChild(onExit?: (manager: BotManager) => void): Promise<{ manager: BotManager; child: any }> {
  const manager = new BotManager();
  managers.push(manager);
  forks.holdExit = true;
  if (onExit) forks.onFork = child => { child.on('exit', () => onExit(manager)); };
  const result = await manager.start();
  forks.onFork = null;
  expect(result.success).toBe(true);
  await tick(5);
  return { manager, child: forks.children.at(-1) };
}

describe('a memory reading that arrives as the bot process exits', () => {
  // Node sets exitCode or signalCode and then emits 'exit'; a listener that runs before the manager's sees a gone child.
  it('is not sent to a bot process that exited with a code', async () => {
    const { manager, child } = await startedChild(m => m.noteMemoryReading(reading()));
    manager.noteMemoryReading(reading());
    const before = sentTo(child, 'memory:reading').length;
    expect(before).toBeGreaterThan(0);
    child.exitCode = 0;
    child.emit('exit', 0, null);
    expect(sentTo(child, 'memory:reading')).toHaveLength(before);
  });

  it('is not sent to a bot process killed by a signal', async () => {
    const { manager, child } = await startedChild(m => m.noteMemoryReading(reading()));
    manager.noteMemoryReading(reading());
    const before = sentTo(child, 'memory:reading').length;
    expect(before).toBeGreaterThan(0);
    child.signalCode = 'SIGKILL';
    child.emit('exit', null, 'SIGKILL');
    expect(sentTo(child, 'memory:reading')).toHaveLength(before);
  });
});

describe('a panel message the child process could not take', () => {
  it('answers Unknown error when sending threw a value that is not an Error', async () => {
    const { manager, child } = await startedChild();
    child.send = vi.fn((message: unknown) => { JSON.stringify(message); return true; });
    const answer = await manager.panelIpc('panel:list', { toJSON() { throw 'not serializable'; } });
    expect(answer).toStrictEqual({ success: false, error: 'Unknown error' });
  });
});

describe('the local chain on a Postgres bot whose reconcile threw', () => {
  it('answers that the database could not be reached and runs nothing', async () => {
    setBackendKind('postgres');
    mirror.throwWith = 'pool ended';
    const manager = new BotManager();
    managers.push(manager);
    const run = vi.fn(async () => ({ ok: true }));
    const answer = await manager.runLocalOp('re8 change', run);
    expect(answer).toStrictEqual({
      ok: false, status: 503, code: 'backend-unavailable',
      error: "Can't reach the database to read the shared files (pool ended); nothing was saved. Try again in a moment.",
    });
    expect(run).not.toHaveBeenCalled();
    expect(writerLockDepth()).toBe(0);
  });
});
