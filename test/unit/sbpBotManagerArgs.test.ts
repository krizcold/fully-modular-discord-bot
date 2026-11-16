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
import { BotManager } from '../../src/webui/botManager';
import { resetAddressesForTests } from '../../src/utils/databaseAddress';
import { forks, forkStage } from '../helpers/forkMock';
import { exitChild, freshWriterLock, resetForks, tick } from '../helpers/nb10Rig';

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
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
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

describe('the command line of the forked bot process', () => {
  it.each(['production', 'development'])('with NODE_ENV %s, start() forks the bot with no arguments after the entry', async env => {
    process.env.NODE_ENV = env;
    const manager = new BotManager();
    managers.push(manager);
    const result = await manager.start();
    expect(result.success).toBe(true);
    await tick(5);
    const calls = (fork as unknown as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual([]);
  });
});
