import fs from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NB3 decisions 2 and 4: the migration lock in the web UI process.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { BotManager } from '../../src/webui/botManager';
import { createManagedRoutes } from '../../src/webui/routes/managed';
import { createControlRoutes } from '../../src/webui/routes/control';
import { createSetupRoutes } from '../../src/webui/routes/setup';
import { createAppStoreRoutes } from '../../src/webui/routes/appstore';
import { maintenanceFilePath, readMaintenanceFile, writeMaintenanceFile } from '../../src/utils/maintenanceFile';
import { crash, forks } from '../helpers/forkMock';
import { startApp } from '../helpers/configRig';
import { FakeDb, emptyStore } from '../helpers/fakePg';
import { MigrationService } from '../../src/bot/internalSetup/utils/dataMigration';
import { ENV, PG_URL, seedFile, useDatabaseUrl, wipeRoot, freshJsonBot } from '../helpers/migrationRig';

const JOB = { jobId: 'job-lock-0001', to: 'postgres' as const };
const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

beforeEach(() => {
  forks.children.length = 0;
  forks.exitCode = 0;
  forks.holdExit = false;
  forks.onFork = null;
  safety.recordCrash.mockClear();
  process.env.DISCORD_TOKEN = 'token';
  process.env.CLIENT_ID = '1';
  process.env.GUILD_ID = '2';
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  fs.rmSync(maintenanceFilePath(), { force: true });
});

describe('BotManager under the lock with maintenance.json saying running', () => {
  it('start, restart and requestRestart refuse; a refused restart leaves the child running', async () => {
    const manager = new BotManager();
    expect((await manager.start()).success).toBe(true);
    expect(manager.takeMigrationLock(JOB)).toBe(true);
    expect(manager.takeMigrationLock({ ...JOB, jobId: 'job-lock-0002' })).toBe(false);
    expect(await manager.restart()).toMatchObject({ success: false, error: 'A data migration is running' });
    expect(await manager.requestRestart()).toMatchObject({ success: false, error: 'A data migration is running' });
    expect(forks.children[0].signals).toEqual([]);
    expect(manager.isRunning()).toBe(true);
    await manager.shutdown();
    expect(await manager.start()).toMatchObject({ success: false, error: 'A data migration is running' });
    expect(forks.children).toHaveLength(1);
    manager.releaseMigrationLock();
    expect((await manager.start()).success).toBe(true);
    await manager.shutdown();
  });

  it('a crash restart is refused, recorded, and runs once at the release', async () => {
    const manager = new BotManager();
    await manager.start();
    manager.takeMigrationLock(JOB);
    crash(forks.children[0]);
    await tick(5600);
    expect(forks.children).toHaveLength(1);
    manager.releaseMigrationLock();
    await vi.waitFor(() => expect(forks.children).toHaveLength(2), { timeout: 3000 });
    await tick(200);
    expect(forks.children).toHaveLength(2);
    await manager.shutdown();
  }, 20_000);

  it('a recorded crash restart does not run at the release when a stop was requested meanwhile', async () => {
    const manager = new BotManager();
    await manager.start();
    manager.takeMigrationLock(JOB);
    crash(forks.children[0]);
    await tick(5600);
    await manager.shutdown();
    manager.releaseMigrationLock();
    await tick(300);
    expect(forks.children).toHaveLength(1);
  }, 20_000);

  it('with maintenance.json saying maintenance, start, restart, requestRestart and a crash restart run, each child booting in maintenance mode', async () => {
    writeMaintenanceFile('maintenance', 'Moving data.');
    forks.onFork = child => { child.maintenanceAtFork = readMaintenanceFile().state; };
    const manager = new BotManager();
    manager.takeMigrationLock(JOB);
    expect((await manager.start()).success).toBe(true);
    expect(forks.children).toHaveLength(1);
    await tick(20);
    expect((await manager.restart()).success).toBe(true);
    expect(forks.children).toHaveLength(2);
    expect(forks.children[0].signals.length).toBeGreaterThan(0);
    await tick(20);
    expect((await manager.requestRestart()).success).toBe(true);
    expect(forks.children).toHaveLength(3);
    await tick(20);
    crash(forks.children[2]);
    await vi.waitFor(() => expect(forks.children).toHaveLength(4), { timeout: 10_000 });
    expect(manager.isRunning()).toBe(true);
    expect(forks.children.map(c => c.maintenanceAtFork)).toEqual(['maintenance', 'maintenance', 'maintenance', 'maintenance']);
    await manager.shutdown();
    manager.releaseMigrationLock();
  }, 20_000);

  it('a stop runs under the lock', async () => {
    const manager = new BotManager();
    await manager.start();
    manager.takeMigrationLock(JOB);
    await manager.shutdown();
    expect(manager.isRunning()).toBe(false);
    manager.releaseMigrationLock();
  });
});

describe('the routes under the lock', () => {
  const TOKEN = 'nb3-token';
  let manager: BotManager;
  let app: { url: string; close: () => Promise<void> };
  beforeAll(async () => {
    process.env.BOT_MANAGER_UPDATE_TOKEN = TOKEN;
    manager = new BotManager();
    app = await startApp(a => {
      a.use('/api/managed', createManagedRoutes(manager));
      a.use('/api/bot', createControlRoutes(manager));
      a.use('/api/setup', createSetupRoutes(manager));
      a.use('/api/appstore', createAppStoreRoutes(manager));
    });
  });
  afterAll(async () => {
    await app.close();
    delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  });
  afterEach(() => manager.releaseMigrationLock());

  const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${app.url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it("the hook 'running' refuses and leaves maintenance.json as it was", async () => {
    writeMaintenanceFile('maintenance', 'Moving data.');
    const before = fs.readFileSync(maintenanceFilePath(), 'utf-8');
    manager.takeMigrationLock(JOB);
    const res = await post('/api/managed/maintenance', { state: 'running' }, { 'x-bot-token': TOKEN });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/A data migration is running/);
    expect(fs.readFileSync(maintenanceFilePath(), 'utf-8')).toBe(before);
    expect(readMaintenanceFile().state).toBe('maintenance');
  });

  it('restart-server and the container restart refuse; a plain stop answers true', async () => {
    manager.takeMigrationLock(JOB);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const a = await post('/api/bot/restart-server', {});
    expect(a.status).toBe(409);
    expect((await a.json()).error).toMatch(/A data migration is running/);
    const b = await post('/api/bot/shutdown', { emergency: true });
    expect(b.status).toBe(409);
    const c = await post('/api/bot/shutdown', {});
    expect((await c.json()).success).toBe(true);
    await tick(700);
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it('GET /api/bot/status reports the running migration', async () => {
    expect((await (await fetch(`${app.url}/api/bot/status`)).json()).status.migration).toBeNull();
    manager.takeMigrationLock(JOB);
    expect((await (await fetch(`${app.url}/api/bot/status`)).json()).status.migration).toEqual(JOB);
  });

  it('the setup credentials route refuses and leaves /data/.env as it was', async () => {
    freshJsonBot();
    seedFile('.env', 'DATA_BACKEND=file\n');
    manager.takeMigrationLock(JOB);
    const res = await post('/api/setup/credentials', { MAIN_GUILD_ID: '1234567890123' });
    expect(res.status).toBe(409);
    expect(fs.readFileSync(ENV, 'utf-8')).toBe('DATA_BACKEND=file\n');
    const pay = await fetch(`${app.url}/api/appstore/premium/providers/dummy/credentials`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values: { X: 'y' } }),
    });
    expect(pay.status).toBe(409);
    expect((await pay.json()).error).toMatch(/A data migration is running/);
    expect(fs.readFileSync(ENV, 'utf-8')).toBe('DATA_BACKEND=file\n');
  });
});

describe('the job never starts, stops or restarts the bot', () => {
  it('a whole job on a stopped bot calls none of them', async () => {
    freshJsonBot();
    useDatabaseUrl(PG_URL);
    delete process.env.BOT_MANAGER_UPDATE_TOKEN;
    seedFile('111111111111111111/mod/a.json', '{"a":1}');
    const manager = new BotManager();
    const start = vi.spyOn(manager, 'start');
    const stop = vi.spyOn(manager, 'shutdown');
    const restart = vi.spyOn(manager, 'restart');
    const db = new FakeDb();
    const service = new MigrationService(manager, { connect: async (_u, app) => db.connect(app), nodeId: () => 'n', lockTimeoutMs: 1000 });
    const answer = await service.post({ jobId: 'job-calls-0001', to: 'postgres' });
    expect(answer.body.state).toBe('started');
    await service.idle();
    expect(service.status().body.job.state).toBe('done');
    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
    expect(db.schemas.get('smdb_data')?.data).toHaveLength(1);
    void emptyStore;
  });
});
