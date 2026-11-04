import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NB3 decision 3: which bot process the job may start beside, and the refusal text for every other one.

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
import { createMigrateRoutes } from '../../src/webui/routes/migrate';
import { MigrationService } from '../../src/bot/internalSetup/utils/dataMigration';
import { forks } from '../helpers/forkMock';
import { startApp } from '../helpers/configRig';
import { FakeDb } from '../helpers/fakePg';
import { PG_URL, useDatabaseUrl, wipeRoot, freshJsonBot } from '../helpers/migrationRig';

const UNSAVED = /^The bot holds unsaved changes \((\d+) guilds, (\d+) files\); a stop or restart drops them$/;
const CANT = "can't confirm whether the bot holds unsaved changes; a stop or restart could drop them";

beforeEach(() => {
  forks.children.length = 0;
  forks.exitCode = 0;
  forks.holdExit = false;
  process.env.DISCORD_TOKEN = 'token';
  process.env.CLIENT_ID = '1';
  process.env.GUILD_ID = '2';
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

const mode = (child: any, data: object) => child.emit('message', { type: 'maintenance:mode', data });

describe("the bot process's state at the first check", () => {
  it('a never-started bot and a stopped bot with its exit seen pass', async () => {
    const manager = new BotManager();
    expect(manager.migrationBotState()).toEqual({ ok: true });
    await manager.start();
    await manager.shutdown();
    expect(manager.migrationBotState()).toEqual({ ok: true });
  });

  it('a dropped handle whose child still runs refuses', async () => {
    const manager = new BotManager();
    await manager.start();
    (manager as any).botProcess = null;
    const state = manager.migrationBotState();
    expect(state.ok).toBe(false);
    expect((state as any).error).toMatch(/has not exited/);
  });

  it('the boot flag passes, also on a login-refused boot, and survives a later maintenance:mode without it', async () => {
    const manager = new BotManager();
    await manager.start();
    mode(forks.children[0], { mode: 'login-refused', boot: true });
    expect(manager.migrationBotState()).toEqual({ ok: true });
    mode(forks.children[0], { mode: 'maintenance' });
    expect(manager.migrationBotState()).toEqual({ ok: true });
    await manager.shutdown();
  });

  it('a serving child refuses with "Stop the bot first"', async () => {
    const manager = new BotManager();
    await manager.start();
    expect(manager.migrationBotState()).toEqual({ ok: false, error: 'Stop the bot first' });
    await manager.shutdown();
  });

  it('a child that entered maintenance while serving: "Restart the bot into maintenance first" only after saved: true', async () => {
    const manager = new BotManager();
    await manager.start();
    mode(forks.children[0], { mode: 'maintenance' });
    expect(manager.migrationBotState()).toEqual({ ok: false, error: CANT });
    (manager as any).sendIPCMessage = vi.fn(async () => ({ saved: false, unsavedGuilds: 2, unsavedFiles: 5 }));
    await manager.enterMaintenance('m');
    expect((manager.migrationBotState() as any).error).toMatch(UNSAVED);
    expect((manager.migrationBotState() as any).error).toContain('(2 guilds, 5 files)');
    (manager as any).sendIPCMessage = vi.fn(async () => { throw new Error('IPC request timed out'); });
    await manager.enterMaintenance('m');
    expect(manager.migrationBotState()).toEqual({ ok: false, error: CANT });
    (manager as any).sendIPCMessage = vi.fn(async () => ({ saved: true }));
    await manager.enterMaintenance('m');
    expect(manager.migrationBotState()).toEqual({ ok: false, error: 'Restart the bot into maintenance first' });
    await manager.shutdown();
  });

  it('mode held refuses with its counts; login-refused and outage without the flag refuse with "can\'t confirm"', async () => {
    const manager = new BotManager();
    await manager.start();
    mode(forks.children[0], { mode: 'held', held: { unsavedGuilds: 1, unsavedFiles: 3 } });
    expect((manager.migrationBotState() as any).error).toContain('(1 guilds, 3 files)');
    mode(forks.children[0], { mode: 'login-refused' });
    expect(manager.migrationBotState()).toEqual({ ok: false, error: CANT });
    mode(forks.children[0], { mode: 'outage' });
    expect(manager.migrationBotState()).toEqual({ ok: false, error: CANT });
    await manager.shutdown();
  });

  it('start() resets the boot flag and the last enter answer', async () => {
    const manager = new BotManager();
    await manager.start();
    mode(forks.children[0], { mode: 'maintenance', boot: true });
    (manager as any).sendIPCMessage = vi.fn(async () => ({ saved: true }));
    await manager.enterMaintenance('m');
    await manager.shutdown();
    await manager.start();
    mode(forks.children[1], { mode: 'maintenance' });
    expect(manager.migrationBotState()).toEqual({ ok: false, error: CANT });
    await manager.shutdown();
  });
});

describe('the hook and the panel route give the same refusal', () => {
  const TOKEN = 'nb3-state-token';
  let manager: BotManager;
  let app: { url: string; close: () => Promise<void> };
  beforeAll(async () => {
    manager = new BotManager();
    const db = new FakeDb();
    const service = new MigrationService(manager, { connect: async (_u, a) => db.connect(a), nodeId: () => 'n' });
    app = await startApp(a => {
      a.use('/api/managed', createManagedRoutes(manager, service));
      a.use('/api/data/migrate', createMigrateRoutes(manager, service));
    });
  });
  afterAll(async () => {
    await manager.shutdown();
    await app.close();
    delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  });

  it('a serving child: "Stop the bot first" from both', async () => {
    freshJsonBot();
    useDatabaseUrl(PG_URL);
    await manager.start();
    delete process.env.BOT_MANAGER_UPDATE_TOKEN;
    const panel = await fetch(`${app.url}/api/data/migrate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: 'postgres' }) });
    expect((await panel.json()).state).toBe('started');
    await vi.waitFor(async () => {
      const g = await (await fetch(`${app.url}/api/data/migrate`)).json();
      expect(g.job).toMatchObject({ state: 'failed', error: 'Stop the bot first' });
    });
    process.env.BOT_MANAGER_UPDATE_TOKEN = TOKEN;
    const hook = await fetch(`${app.url}/api/managed/migrate`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bot-token': TOKEN }, body: JSON.stringify({ jobId: 'job-state-0001', to: 'postgres' }) });
    expect(await hook.json()).toMatchObject({ success: true, jobId: 'job-state-0001', to: 'postgres', state: 'started' });
    await vi.waitFor(async () => {
      const g = await (await fetch(`${app.url}/api/managed/migrate`, { headers: { 'x-bot-token': TOKEN } })).json();
      expect(g.job).toMatchObject({ jobId: 'job-state-0001', state: 'failed', error: 'Stop the bot first' });
    });
  });
});
