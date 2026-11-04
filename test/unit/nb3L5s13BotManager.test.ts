import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB3: the bot process state a migration reads, and the starts the migration lock defers, in the web UI process.

const safety = vi.hoisted(() => ({
  safe: false,
  recordCrash: () => undefined,
  isInSafeMode(): boolean { return this.safe; },
  getStatus: () => ({}),
}));
// A hook run inside the next read of maintenance.json: models a migration that ends while a start is being refused.
const readHook = vi.hoisted(() => ({ once: null as null | (() => void) }));

vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
vi.mock('../../src/utils/maintenanceFile', async orig => {
  const actual = await orig<typeof import('../../src/utils/maintenanceFile')>();
  return {
    ...actual,
    readMaintenanceFile: () => {
      const hook = readHook.once;
      readHook.once = null;
      hook?.();
      return actual.readMaintenanceFile();
    },
  };
});

import { BotManager } from '../../src/webui/botManager';
import { maintenanceFilePath, writeMaintenanceFile } from '../../src/utils/maintenanceFile';
import { crash, forkLogin, forks } from '../helpers/forkMock';

const JOB = { jobId: 'job-s13-0001', to: 'postgres' as const };
const MISSING = 'Missing or invalid credentials: DISCORD_TOKEN';
const DEFERRED = 'The bot was stopped, but a data migration started meanwhile; it is started again once the migration ends';
const STILL_STARTING = "The bot process is still starting; can't confirm whether it boots in maintenance; try again once it has started";
const NOT_EXITED = 'The last bot process has not exited yet; a migration beside it could miss its writes';
const CANT_CONFIRM = "can't confirm whether the bot holds unsaved changes; a stop or restart could drop them";

let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
const lines = (spy: ReturnType<typeof vi.spyOn>): string[] => spy.mock.calls.map((call: unknown[]) => String(call[0]));
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

async function startBot(manager: BotManager, waitMs = 600) {
  const pending = manager.start();
  await advance(waitMs);
  return pending;
}

function lastRequestId(child: any, type: string): string {
  const call = [...child.send.mock.calls].reverse().find((c: any[]) => c[0]?.type === type);
  return call[0].requestId;
}

// A restart that stopped the bot and found the lock taken meanwhile: its start is left for the release.
async function deferRestart(manager: BotManager) {
  expect((await startBot(manager)).success).toBe(true);
  const pending = manager.restart();
  expect(manager.takeMigrationLock(JOB)).toBe(true);
  await advance(100);
  const result = await pending;
  expect(result).toMatchObject({ success: false, reason: 'migration_running', error: DEFERRED });
  expect(manager.isRunning()).toBe(false);
  expect(forks.children).toHaveLength(1);
}

// A crash under the lock: the automatic start waits for the release.
async function deferCrashRestart(manager: BotManager) {
  expect((await startBot(manager)).success).toBe(true);
  expect(manager.takeMigrationLock(JOB)).toBe(true);
  crash(forks.children[0], 1);
  await advance(5100);
  expect(forks.children).toHaveLength(1);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  forks.children.length = 0;
  forks.exitCode = 0;
  forks.holdExit = false;
  forks.onFork = null;
  forkLogin.on = true;
  safety.safe = false;
  readHook.once = null;
  process.env.DISCORD_TOKEN = 'token';
  process.env.CLIENT_ID = '1';
  process.env.GUILD_ID = '2';
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  fs.rmSync(maintenanceFilePath(), { force: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(maintenanceFilePath(), { force: true });
});

describe('migrationBotState: whether the bot has said what it booted as', () => {
  it("a current child's line that is not its login leaves it starting; its login line makes it reported", async () => {
    forkLogin.on = false;
    const manager = new BotManager();
    expect((await startBot(manager, 5600)).success).toBe(true);
    const child = forks.children[0];
    child.stdout.emit('data', Buffer.from('Loading modules\n'));
    expect(manager.migrationBotState()).toEqual({ ok: false, error: STILL_STARTING });
    child.stdout.emit('data', Buffer.from('Logged in as test#0001!\n'));
    expect(manager.migrationBotState()).toEqual({ ok: false, error: 'Stop the bot first' });
  });

  it("a previous child's late login line does not count for the current child", async () => {
    const manager = new BotManager();
    expect((await startBot(manager)).success).toBe(true);
    const old = forks.children[0];
    crash(old, 0);
    forkLogin.on = false;
    expect((await startBot(manager, 5600)).success).toBe(true);
    expect(forks.children).toHaveLength(2);
    old.stdout.emit('data', Buffer.from('Logged in as test#0001!\n'));
    expect(manager.migrationBotState()).toEqual({ ok: false, error: STILL_STARTING });
  });
});

describe('migrationBotState: the last child must have exited', () => {
  it('an older child exiting does not count as the exit of the last one, which outlived its kill', async () => {
    forks.holdExit = true;
    const manager = new BotManager();
    expect((await startBot(manager)).success).toBe(true);
    const first = forks.children[0];
    let stop = manager.shutdown();
    await advance(46_000);
    await stop;
    expect((await startBot(manager)).success).toBe(true);
    stop = manager.shutdown();
    await advance(46_000);
    await stop;
    expect(manager.isRunning()).toBe(false);
    first.exitCode = 0;
    first.emit('exit', 0, null);
    expect(manager.migrationBotState()).toEqual({ ok: false, error: NOT_EXITED });
  });

  it("the last child's exit event alone lets a migration run", async () => {
    const manager = new BotManager();
    expect((await startBot(manager)).success).toBe(true);
    forks.children[0].emit('exit', 0, null);
    expect(manager.isRunning()).toBe(false);
    expect(manager.migrationBotState()).toEqual({ ok: true });
  });

  it('a last child with an exit code lets a migration run before its exit event', async () => {
    const manager = new BotManager();
    expect((await startBot(manager)).success).toBe(true);
    forks.children[0].exitCode = 1;
    expect(manager.isRunning()).toBe(false);
    expect(manager.migrationBotState()).toEqual({ ok: true });
  });

  it('a last child killed by a signal lets a migration run before its exit event', async () => {
    const manager = new BotManager();
    expect((await startBot(manager)).success).toBe(true);
    forks.children[0].signalCode = 'SIGKILL';
    expect(manager.isRunning()).toBe(false);
    expect(manager.migrationBotState()).toEqual({ ok: true });
  });
});

describe('migrationBotState: what the running child reported', () => {
  it('a held child without counts that answered the maintenance request with unsaved changes names them', async () => {
    const manager = new BotManager();
    expect((await startBot(manager)).success).toBe(true);
    const child = forks.children[0];
    child.emit('message', { type: 'maintenance:mode', data: { mode: 'held' } });
    const pending = manager.enterMaintenance('Moving data.');
    child.emit('message', { requestId: lastRequestId(child, 'maintenance:enter'), data: { saved: false, unsavedGuilds: 3, unsavedFiles: 4 } });
    expect(await pending).toMatchObject({ saved: false, unsavedGuilds: 3, unsavedFiles: 4 });
    expect(manager.migrationBotState()).toEqual({
      ok: false,
      error: 'The bot holds unsaved changes (3 guilds, 4 files); a stop or restart drops them',
    });
  });

  it('an unknown mode is named in the refusal', async () => {
    const manager = new BotManager();
    expect((await startBot(manager)).success).toBe(true);
    forks.children[0].emit('message', { type: 'maintenance:mode', data: { mode: 'weird' } });
    expect(manager.migrationBotState()).toEqual({ ok: false, error: 'The bot process is in state weird; stop it first' });
  });

  it("a replaced child's maintenance answer is not taken as the new child's", async () => {
    const manager = new BotManager();
    expect((await startBot(manager)).success).toBe(true);
    const old = forks.children[0];
    const pending = manager.enterMaintenance('Moving data.');
    old.emit('message', { requestId: lastRequestId(old, 'maintenance:enter'), data: { saved: false, unsavedGuilds: 2, unsavedFiles: 1 } });
    crash(old, 0);
    const started = manager.start();
    expect(await pending).toMatchObject({ saved: false });
    await advance(600);
    expect((await started).success).toBe(true);
    const current = forks.children[1];
    current.emit('message', { type: 'maintenance:mode', data: { mode: 'held' } });
    expect(manager.migrationBotState()).toEqual({ ok: false, error: CANT_CONFIRM });
  });

  it('an answer without a save result is logged as such and leaves the save unknown', async () => {
    const manager = new BotManager();
    expect((await startBot(manager)).success).toBe(true);
    const child = forks.children[0];
    const pending = manager.enterMaintenance('Moving data.');
    child.emit('message', { requestId: lastRequestId(child, 'maintenance:enter') });
    expect(await pending).toMatchObject({ saved: null });
    expect(lines(warnSpy)).toContain('[BotManager] The bot process answered the maintenance request without a save result');
    expect(lines(warnSpy).some(l => l.includes('got no answer'))).toBe(false);
  });
});

describe('the automatic start after a crash', () => {
  it('under the lock it waits and says so', async () => {
    const manager = new BotManager();
    await deferCrashRestart(manager);
    expect(lines(warnSpy)).toContain('[BotManager] The automatic start waits: a data migration is running; it runs once the migration ends');
  });

  it('a stop requested before the release calls it off and says why', async () => {
    const manager = new BotManager();
    await deferCrashRestart(manager);
    await manager.shutdown();
    manager.releaseMigrationLock();
    await advance(600);
    expect(forks.children).toHaveLength(1);
    expect(lines(logSpy)).toContain('[BotManager] The automatic start was called off: a stop was requested');
  });

  it('safe mode turned on before the release calls it off and says why', async () => {
    const manager = new BotManager();
    await deferCrashRestart(manager);
    safety.safe = true;
    manager.releaseMigrationLock();
    await advance(600);
    expect(forks.children).toHaveLength(1);
    expect(lines(logSpy)).toContain('[BotManager] The automatic start was called off: safe mode is on');
  });

  it('a bot started in maintenance before the release makes the release do nothing', async () => {
    const manager = new BotManager();
    await deferCrashRestart(manager);
    writeMaintenanceFile('maintenance', 'Moving data.');
    expect((await startBot(manager)).success).toBe(true);
    safety.safe = true;
    manager.releaseMigrationLock();
    await advance(600);
    expect(forks.children).toHaveLength(2);
    expect(lines(logSpy).some(l => l.includes('The automatic start was called off'))).toBe(false);
  });

  it('runs once at the release; a later lock and release with no new crash starts nothing', async () => {
    const manager = new BotManager();
    await deferCrashRestart(manager);
    manager.releaseMigrationLock();
    await advance(600);
    expect(forks.children).toHaveLength(2);
    crash(forks.children[1], 0);
    expect(manager.takeMigrationLock(JOB)).toBe(true);
    manager.releaseMigrationLock();
    await advance(600);
    expect(forks.children).toHaveLength(2);
    expect(manager.isRunning()).toBe(false);
  });

  it('a start that fails is logged with its reason', async () => {
    const manager = new BotManager();
    expect((await startBot(manager)).success).toBe(true);
    crash(forks.children[0], 1);
    process.env.DISCORD_TOKEN = '';
    await advance(5600);
    expect(forks.children).toHaveLength(1);
    expect(lines(errorSpy)).toContain(`[BotManager] The bot did not start again after its crash: ${MISSING}`);
  });

  it('a start that succeeds logs no failure', async () => {
    const manager = new BotManager();
    expect((await startBot(manager)).success).toBe(true);
    crash(forks.children[0], 1);
    await advance(5600);
    expect(forks.children).toHaveLength(2);
    expect(manager.isRunning()).toBe(true);
    expect(lines(errorSpy).some(l => l.includes('did not start again'))).toBe(false);
  });

  it('a bot an operator started meanwhile is no failure', async () => {
    const manager = new BotManager();
    expect((await startBot(manager)).success).toBe(true);
    crash(forks.children[0], 1);
    expect((await startBot(manager)).success).toBe(true);
    await advance(5600);
    expect(forks.children).toHaveLength(2);
    expect(lines(errorSpy).some(l => l.includes('did not start again'))).toBe(false);
  });

  it('stops after five automatic starts in a row that crashed', async () => {
    const manager = new BotManager();
    expect((await startBot(manager)).success).toBe(true);
    for (let i = 0; i < 6; i += 1) {
      crash(forks.children[forks.children.length - 1], 1);
      await advance(5600);
    }
    expect(forks.children).toHaveLength(6);
    expect(manager.isRunning()).toBe(false);
    expect(lines(errorSpy).some(l => l.startsWith('[BotManager] The bot stays down: 5 automatic starts in a row'))).toBe(true);
  });

  it("an operator's start after an automatic one begins a fresh count", async () => {
    const manager = new BotManager();
    expect((await startBot(manager)).success).toBe(true);
    crash(forks.children[0], 1);
    await advance(5600);
    expect(forks.children).toHaveLength(2);
    const stop = manager.shutdown();
    await advance(50);
    await stop;
    expect((await startBot(manager)).success).toBe(true);
    expect(forks.children).toHaveLength(3);
    for (let i = 0; i < 5; i += 1) {
      crash(forks.children[forks.children.length - 1], 1);
      await advance(5600);
    }
    expect(forks.children).toHaveLength(8);
    expect(manager.isRunning()).toBe(true);
  });
});

describe('the start a restart leaves for the release of the lock', () => {
  it('runs at the release and logs no failure', async () => {
    const manager = new BotManager();
    await deferRestart(manager);
    manager.releaseMigrationLock();
    await advance(600);
    expect(forks.children).toHaveLength(2);
    expect(manager.isRunning()).toBe(true);
    expect(lines(errorSpy).some(l => l.includes('did not start after the migration'))).toBe(false);
  });

  it('a start that fails at the release is logged with its reason', async () => {
    const manager = new BotManager();
    await deferRestart(manager);
    process.env.DISCORD_TOKEN = '';
    manager.releaseMigrationLock();
    await advance(600);
    expect(forks.children).toHaveLength(1);
    expect(lines(errorSpy)).toContain(`[BotManager] The bot did not start after the migration: ${MISSING}`);
  });

  it('a stop requested meanwhile calls it off and says so', async () => {
    const manager = new BotManager();
    await deferRestart(manager);
    await manager.shutdown();
    manager.releaseMigrationLock();
    await advance(600);
    expect(forks.children).toHaveLength(1);
    expect(lines(logSpy)).toContain('[BotManager] The start a restart left for after the migration was called off: a stop was requested meanwhile');
  });

  it('a process that is exiting starts nothing at the release and logs no failure', async () => {
    const manager = new BotManager();
    await deferRestart(manager);
    manager.beginExit();
    manager.releaseMigrationLock();
    await advance(600);
    expect(forks.children).toHaveLength(1);
    expect(lines(errorSpy)).toEqual([]);
  });

  it('a bot already running at the release is left as it is, with no log of a called off start', async () => {
    const manager = new BotManager();
    await deferRestart(manager);
    writeMaintenanceFile('maintenance', 'Moving data.');
    await manager.shutdown();
    expect((await startBot(manager)).success).toBe(true);
    manager.releaseMigrationLock();
    await advance(600);
    expect(forks.children).toHaveLength(2);
    expect(lines(logSpy).some(l => l.includes('The start a restart left for after the migration was called off'))).toBe(false);
  });

  it('does not leave a crash restart behind: a later lock and release starts nothing', async () => {
    const manager = new BotManager();
    await deferRestart(manager);
    manager.releaseMigrationLock();
    await advance(600);
    expect(forks.children).toHaveLength(2);
    crash(forks.children[1], 0);
    expect(manager.takeMigrationLock(JOB)).toBe(true);
    manager.releaseMigrationLock();
    await advance(600);
    expect(forks.children).toHaveLength(2);
    expect(manager.isRunning()).toBe(false);
  });

  it('a migration that ended while the start was refused starts the bot at once', async () => {
    const manager = new BotManager();
    expect((await startBot(manager)).success).toBe(true);
    const pending = manager.restart();
    expect(manager.takeMigrationLock(JOB)).toBe(true);
    readHook.once = () => manager.releaseMigrationLock();
    await advance(100);
    expect(await pending).toMatchObject({ success: false, reason: 'migration_running', error: DEFERRED });
    expect(manager.migrationRunning()).toBeNull();
    await advance(600);
    expect(forks.children).toHaveLength(2);
    expect(manager.isRunning()).toBe(true);
  });
});

describe('what restart answers', () => {
  it('a restart that succeeds answers success and nothing else', async () => {
    const manager = new BotManager();
    expect((await startBot(manager)).success).toBe(true);
    const pending = manager.restart();
    await advance(700);
    expect(await pending).toEqual({ success: true });
    expect(forks.children).toHaveLength(2);
  });

  it("a restart whose start fails for another reason answers that reason, not the migration's", async () => {
    const manager = new BotManager();
    expect((await startBot(manager)).success).toBe(true);
    process.env.DISCORD_TOKEN = '';
    const pending = manager.restart();
    await advance(100);
    expect(await pending).toEqual({ success: false, reason: 'credentials_missing', error: MISSING });
  });

  it('a restart whose stop did not leave the bot stopped answers the plain migration refusal', async () => {
    const manager = new BotManager();
    expect((await startBot(manager)).success).toBe(true);
    let operatorStart: Promise<unknown> | null = null;
    forks.children[0].once('exit', () => {
      operatorStart = manager.start();
      manager.takeMigrationLock(JOB);
    });
    const pending = manager.restart();
    await advance(700);
    expect(await pending).toEqual({ success: false, reason: 'migration_running', error: 'A data migration is running' });
    expect(await operatorStart).toMatchObject({ success: true });
    expect(manager.isRunning()).toBe(true);
    expect(forks.children).toHaveLength(2);
  });
});

describe('requestRestart under the lock', () => {
  it('refuses with the migration reason and logs it, with no bot running', async () => {
    const manager = new BotManager();
    expect(manager.takeMigrationLock(JOB)).toBe(true);
    const pending = manager.requestRestart();
    await advance(300);
    expect(await pending).toEqual({ success: false, reason: 'migration_running', error: 'A data migration is running' });
    expect(lines(warnSpy)).toContain('[BotManager] The restart the bot process asked for was refused: a data migration is running');
  });
});
