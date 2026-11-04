import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB3 mutation gate, round f1: a start left for the end of a migration that fails without saying why logs "unknown".

const safety = vi.hoisted(() => ({
  safe: false,
  recordCrash: () => undefined,
  isInSafeMode(): boolean { return this.safe; },
  getStatus: () => ({}),
}));

vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { BotManager } from '../../src/webui/botManager';
import { maintenanceFilePath } from '../../src/utils/maintenanceFile';
import { forkLogin, forks } from '../helpers/forkMock';

const JOB = { jobId: 'job-f1-0001', to: 'postgres' as const };
const DEFERRED = 'The bot was stopped, but a data migration started meanwhile; it is started again once the migration ends';

let errorSpy: ReturnType<typeof vi.spyOn>;
const lines = (spy: ReturnType<typeof vi.spyOn>): string[] => spy.mock.calls.map((call: unknown[]) => String(call[0]));
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  forks.children.length = 0;
  forks.exitCode = 0;
  forks.holdExit = false;
  forks.onFork = null;
  forkLogin.on = true;
  safety.safe = false;
  process.env.DISCORD_TOKEN = 'token';
  process.env.CLIENT_ID = '1';
  process.env.GUILD_ID = '2';
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  fs.rmSync(maintenanceFilePath(), { force: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(maintenanceFilePath(), { force: true });
});

describe('the start a restart leaves for the release of the lock', () => {
  it('a failed start that gives neither an error nor a reason is logged as unknown', async () => {
    const manager = new BotManager();
    const first = manager.start();
    await advance(600);
    expect((await first).success).toBe(true);
    const restart = manager.restart();
    expect(manager.takeMigrationLock(JOB)).toBe(true);
    await advance(100);
    expect(await restart).toMatchObject({ success: false, reason: 'migration_running', error: DEFERRED });
    expect(manager.isRunning()).toBe(false);

    const start = vi.spyOn(manager, 'start').mockResolvedValue({ success: false });
    manager.releaseMigrationLock();
    await advance(10);
    expect(start).toHaveBeenCalledTimes(1);
    const logged = lines(errorSpy).filter(l => l.includes('did not start after the migration'));
    expect(logged).toEqual(['[BotManager] The bot did not start after the migration: unknown']);
  });
});
