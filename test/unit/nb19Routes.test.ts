import fs from 'fs';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NB19 decision 5's route rule: after a FolderSyncError the new bytes are in the file, so the route makes the running
// bot follow the file and then answers 500 with T7; a write that failed before its rename keeps today's early 500.

const h = vi.hoisted(() => ({
  fail: new Map<string, { kind: 'sync' | 'open' | 'earlier'; errno: string }>(),
  failRenameTo: new Set<string>(),
  first: null as null | { dir: string; errno: string },
}));

vi.mock('../../src/bot/internalSetup/utils/folderChain', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    syncFolderChainSync: (dir: string) => {
      const at = path.resolve(dir);
      if (h.first && real.folderSyncFailed()) return { failed: true, kind: 'earlier', dir: h.first.dir, errno: h.first.errno, error: null };
      const f = h.fail.get(at);
      if (!f) return { failed: false };
      if (f.kind === 'sync') {
        real.noteFolderSyncFailure(at, f.errno);
        h.first ??= { dir: at, errno: f.errno };
      }
      return { failed: true, kind: f.kind, dir: at, errno: f.errno, error: null };
    },
  };
});

vi.mock('fs', async orig => {
  const real = await orig<any>();
  const wrapped = {
    ...real,
    renameSync: (from: any, to: any) => {
      if (h.failRenameTo.has(path.basename(String(to)))) throw Object.assign(new Error('ENOSPC: no space left on device, rename'), { code: 'ENOSPC' });
      return real.renameSync(from, to);
    },
  };
  return { ...wrapped, default: wrapped };
});

import { dataPath } from '../../src/utils/dataRoot';
import { syncWords } from '../../src/bot/internalSetup/utils/folderChain';
import { maintenanceFilePath } from '../../src/utils/maintenanceFile';
import { createManagedRoutes, _setManagedTiming } from '../../src/webui/routes/managed';
import { createAppStoreRoutes } from '../../src/webui/routes/appstore';
import type { BotManager } from '../../src/webui/botManager';
import { _resetOwnerChannel, _setOwnerChannelDeps, ownerChannelFile, ownerMessagesFile, putOwnerChannel } from '../../src/webui/utils/ownerChannel';
import { setBackendKind } from '../helpers/backendKind';
import { startApp } from '../helpers/configRig';
import { FakeOwnerRest } from '../helpers/fakeOwnerRest';

const ROOT = path.resolve(dataPath());
const STORE = path.resolve(dataPath('global', 'appstore'));
const COMPONENTS = path.join(STORE, 'component-config.json');
const STORE_CONFIG = path.join(STORE, 'config.json');
const C = '500000000000000001';
const TOKEN = 'nb19-token';
const HEADERS = { 'content-type': 'application/json', 'x-bot-token': TOKEN };

const T1 = (file: string, dir: string) => {
  const { why, next } = syncWords('sync', dir, 'EIO');
  return `${file} is written, but ${why}, so can't confirm it is stored. ${next}`;
};
const failAt = (dir: string) => h.fail.set(path.resolve(dir), { kind: 'sync', errno: 'EIO' });

let errors: string[];
beforeEach(() => {
  h.fail.clear();
  h.failRenameTo.clear();
  h.first = null;
  errors = [];
  setBackendKind('file');
  process.env.BOT_MANAGER_UPDATE_TOKEN = TOKEN;
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  delete process.env.BOT_MANAGER_UPDATE_TOKEN;
  setBackendKind(null);
  vi.restoreAllMocks();
});

describe('row 21: the maintenance route', () => {
  const bot = {
    enterMaintenance: vi.fn(async () => ({ saved: true })),
    leaveMaintenance: vi.fn(async () => ({ restarting: true })),
    isServingNormally: () => false,
    migrationRunning: () => null,
  };
  let app: { url: string; close: () => Promise<void> };
  beforeAll(async () => {
    app = await startApp(a => a.use('/api/managed', createManagedRoutes(bot as unknown as BotManager, {} as never)));
  });
  afterAll(async () => { await app.close(); });
  beforeEach(() => {
    bot.enterMaintenance.mockClear();
    bot.leaveMaintenance.mockClear();
    fs.rmSync(maintenanceFilePath(), { force: true });
  });
  const post = async (body: unknown) => {
    const res = await fetch(`${app.url}/api/managed/maintenance`, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() as any };
  };
  const stored = () => JSON.parse(fs.readFileSync(maintenanceFilePath(), 'utf8'));

  it('EIO on /data entering maintenance: the bot enters it, the file holds maintenance, 500 with T7', async () => {
    failAt(ROOT);
    const res = await post({ state: 'maintenance', message: 'down for a bit' });
    expect(bot.enterMaintenance).toHaveBeenCalledTimes(1);
    expect(bot.enterMaintenance).toHaveBeenCalledWith('down for a bit');
    expect(stored()).toMatchObject({ state: 'maintenance', message: 'down for a bit' });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ success: false, state: 'maintenance', error: `The maintenance state can't be confirmed as saved: ${T1(maintenanceFilePath(), ROOT)}` });
    expect(errors).toContain(`[Maintenance] The maintenance state can't be confirmed as saved: ${T1(maintenanceFilePath(), ROOT)}`);
  });

  it('EIO on /data leaving maintenance: the bot leaves it, the file holds running, 500 with T7', async () => {
    fs.writeFileSync(maintenanceFilePath(), JSON.stringify({ state: 'maintenance', message: 'm', since: '2026-11-10T00:00:00.000Z' }));
    failAt(ROOT);
    const res = await post({ state: 'running' });
    expect(bot.leaveMaintenance).toHaveBeenCalledTimes(1);
    expect(stored()).toMatchObject({ state: 'running' });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ success: false, state: 'running', error: `The maintenance state can't be confirmed as saved: ${T1(maintenanceFilePath(), ROOT)}` });
  });

  it.each(['maintenance', 'running'] as const)('ENOSPC before the rename for %s: neither is called, today\'s 500', async state => {
    h.failRenameTo.add(path.basename(maintenanceFilePath()));
    const res = await post({ state });
    expect(bot.enterMaintenance).not.toHaveBeenCalled();
    expect(bot.leaveMaintenance).not.toHaveBeenCalled();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: 'The maintenance state could not be saved: ENOSPC: no space left on device, rename' });
    expect(fs.existsSync(maintenanceFilePath())).toBe(false);
  });
});

describe('row 62: the component toggle and PUT /config', () => {
  function route(router: any, method: string, routePath: string): (req: any, res: any) => any {
    const layer = router.stack.find((l: any) => l.route?.path === routePath && l.route.methods[method]);
    return layer.route.stack[0].handle;
  }
  function fakeRes(): any {
    const res: any = { statusCode: 200, body: undefined };
    res.status = (code: number) => { res.statusCode = code; return res; };
    res.json = (body: any) => { res.body = body; return res; };
    return res;
  }
  const makeBot = () => ({
    isRunning: () => true,
    toggleComponent: vi.fn(async () => undefined),
    startCommandCleanup: vi.fn(() => undefined),
    getCommandCleanupStatus: () => ({ running: false }),
  });
  const toggle = (router: any, res: any) => route(router, 'put', '/components/:module/:type/:name')(
    { params: { module: 'mod', type: 'command', name: 'beta' }, body: { enabled: false } }, res);
  beforeEach(() => {
    fs.rmSync(COMPONENTS, { force: true });
    fs.rmSync(STORE_CONFIG, { force: true });
  });

  it('EIO on the store folder at a toggle: the bot is told after the debounce, 500 with T7', async () => {
    const bot = makeBot();
    const router = createAppStoreRoutes(bot as never);
    failAt(STORE);
    const res = fakeRes();
    await toggle(router, res);
    expect(JSON.parse(fs.readFileSync(COMPONENTS, 'utf8'))).toEqual({ 'mod:command:beta': false });
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ success: false, key: 'mod:command:beta', enabled: false, changed: true, error: `The component setting can't be confirmed as saved: ${T1(COMPONENTS, STORE)}` });
    await vi.waitFor(() => expect(bot.toggleComponent).toHaveBeenCalledWith('mod', 'command', 'beta', false), { timeout: 5000, interval: 25 });
  });

  it('ENOSPC before the rename at a toggle: the bot is not told, today\'s 500', async () => {
    const bot = makeBot();
    const router = createAppStoreRoutes(bot as never);
    h.failRenameTo.add('component-config.json');
    const res = fakeRes();
    await toggle(router, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).not.toContain("can't be confirmed as saved");
    expect(fs.existsSync(COMPONENTS)).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 2000));
    expect(bot.toggleComponent).not.toHaveBeenCalled();
  });

  it('EIO on the store folder at PUT /config with autoCleanup: the cleanup starts, 500 with T7', async () => {
    const bot = makeBot();
    const router = createAppStoreRoutes(bot as never);
    failAt(STORE);
    const res = fakeRes();
    await route(router, 'put', '/config')({ params: {}, body: { autoCleanup: true } }, res);
    expect(bot.startCommandCleanup).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(STORE_CONFIG, 'utf8'))).toMatchObject({ autoCleanup: true });
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ success: false, autoCleanup: true, cleanupStarted: true, error: `The App Store settings can't be confirmed as saved: ${T1(STORE_CONFIG, STORE)}` });
  });

  it('ENOSPC before the rename at PUT /config: no cleanup, today\'s 500', async () => {
    const bot = makeBot();
    const router = createAppStoreRoutes(bot as never);
    h.failRenameTo.add('config.json');
    const res = fakeRes();
    await route(router, 'put', '/config')({ params: {}, body: { autoCleanup: true } }, res);
    expect(bot.startCommandCleanup).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(500);
    expect(res.body.error).not.toContain("can't be confirmed as saved");
    expect(fs.existsSync(STORE_CONFIG)).toBe(false);
  });
});

describe('row 22: the owner channel and the repeat check', () => {
  let rest: FakeOwnerRest;
  beforeEach(() => {
    rest = new FakeOwnerRest(300);
    _resetOwnerChannel();
    _setOwnerChannelDeps({ readRow: async () => null, readMs: 150 });
    fs.rmSync(ownerChannelFile(), { force: true });
    fs.rmSync(ownerMessagesFile(), { force: true });
  });
  afterEach(() => {
    FakeOwnerRest.reset();
    _setOwnerChannelDeps(null);
  });

  it('PUT of a channel with EIO on /data: 502 with T7, the file holds the channel', async () => {
    failAt(ROOT);
    const host = { migrationRunning: () => null, ownerChannelWriteStart: () => ({ ok: true as const, end: () => undefined }) };
    const answer = await putOwnerChannel(host, C);
    expect(rest.calls.length).toBeGreaterThan(0);
    expect(answer).toEqual({ status: 502, body: { success: false, error: `The setting can't be confirmed as saved: ${T1(ownerChannelFile(), ROOT)}` } });
    expect(JSON.parse(fs.readFileSync(ownerChannelFile(), 'utf8'))).toEqual({ channelId: C });
  });

  it('notify-owner with EIO on /data at the repeat check: posted, with the T7 note', async () => {
    const app = await startApp(a => a.use('/api/managed', createManagedRoutes({} as BotManager)));
    try {
      _setManagedTiming({ notifyMs: 600, switchMs: 750 });
      failAt(ROOT);
      const res = await fetch(`${app.url}/api/managed/notify-owner`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ text: 'Backup failed', key: 'nb19-k1' }) });
      const body = await res.json() as any;
      expect(res.status).toBe(200);
      expect(body).toMatchObject({ success: true, posted: true });
      expect(body.note).toBe(`The repeat check can't be confirmed as saved: ${T1(ownerMessagesFile(), ROOT)}, so a repeat of this key may post again.`);
      expect(Object.keys(JSON.parse(fs.readFileSync(ownerMessagesFile(), 'utf8')).keys)).toContain('nb19-k1');
    } finally {
      _setManagedTiming(null);
      await app.close();
    }
  });
});
