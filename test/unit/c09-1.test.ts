import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => (process.env.GUILD_ID = 'g1', {
  created: [] as string[],
  deleted: [] as string[],
  removedEvents: [] as string[],
  local: [{ name: 'alpha', description: 'a' }, { name: 'beta', description: 'b' }] as any[],
}));

vi.mock('../../src/bot/internalSetup/utils/getLocalCommands', () => ({ default: () => h.local }));
vi.mock('../../src/bot/internalSetup/fleet/nodeIdentity', () => ({ resolveNodeRole: () => 'master' }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async (orig) => ({
  ...(await orig<any>()),
  loadGlobalData: () => ({ guildId: process.env.GUILD_ID }),
  saveGlobalData: () => true,
}));
vi.mock('../../src/bot/internalSetup/utils/moduleEventManager', () => ({
  getModuleEventManager: () => ({ removeEventListeners: (m: string, e: string) => { h.removedEvents.push(`${m}:${e}`); return 1; } }),
}));
vi.mock('../../src/bot/internalSetup/utils/panelManager', () => ({
  getPanelManager: () => ({ getPanel: () => null, unregisterPanel: () => undefined }),
}));
vi.mock('../../src/webui/utils/syncNudge', () => ({ nudgeSync: () => undefined }));

import { dataPath } from '../../src/utils/dataRoot';
import registerCommands from '../../src/bot/internalSetup/events/clientReady/registerCommands';
import { applyAllDisabledStatesOnBoot, applyComponentToggleState, setupToggleIPCHandlers } from '../../src/bot/internalSetup/utils/ipcToggleHandler';
import { createAppStoreRoutes } from '../../src/webui/routes/appstore';
import * as keptConfigFile from '../../src/bot/internalSetup/utils/appStoreConfigFile';

const componentFile = dataPath('global', 'appstore', 'component-config.json');
const storeFile = dataPath('global', 'appstore', 'config.json');
const TORN = '{"mod:command:alpha": false, "mod:event:ready": fa';

function writeRaw(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function fakeClient(): any {
  const commands = {
    fetch: async () => Object.assign(new Map<string, any>(), { find: () => undefined }),
    create: async (data: any) => { h.created.push(data.name); return { id: data.name }; },
    edit: async () => ({}),
    delete: async (id: string) => { h.deleted.push(id); },
  };
  return { application: { commands } };
}

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

const botManager: any = { isRunning: () => false, getCommandCleanupStatus: () => ({}), startCommandCleanup: () => undefined };

beforeEach(() => {
  h.created.length = 0;
  h.deleted.length = 0;
  h.removedEvents.length = 0;
  fs.rmSync(componentFile, { force: true });
  fs.rmSync(storeFile, { force: true });
});

describe('a torn component-config.json is never read as empty', () => {
  it('refuses a toggle and leaves the file as it was', async () => {
    writeRaw(componentFile, TORN);
    const router = createAppStoreRoutes(botManager);
    const res = fakeRes();
    await route(router, 'put', '/components/:module/:type/:name')(
      { params: { module: 'mod', type: 'command', name: 'beta' }, body: { enabled: false } }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/^component-config\.json cannot be read: /);
    expect(fs.readFileSync(componentFile, 'utf-8')).toBe(TORN);
  });

  it('refuses the components listing instead of showing every component enabled', async () => {
    writeRaw(componentFile, TORN);
    const router = createAppStoreRoutes(botManager);
    const res = fakeRes();
    await route(router, 'get', '/components')({ params: {}, body: {} }, res);
    expect(res.body.success).toBe(false);
  });

  it('still saves a toggle when the file is missing', async () => {
    const router = createAppStoreRoutes(botManager);
    const res = fakeRes();
    await route(router, 'put', '/components/:module/:type/:name')(
      { params: { module: 'mod', type: 'command', name: 'beta' }, body: { enabled: false } }, res);
    expect(res.body.success).toBe(true);
    expect(JSON.parse(fs.readFileSync(componentFile, 'utf-8'))).toEqual({ 'mod:command:beta': false });
  });

  it('refuses an app store config save over a torn config.json', async () => {
    const tornStore = '{"autoUpdate": true, "autoCl';
    writeRaw(storeFile, tornStore);
    const router = createAppStoreRoutes(botManager);
    const res = fakeRes();
    await route(router, 'put', '/config')({ params: {}, body: { autoCleanup: false } }, res);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/^config\.json cannot be read: /);
    expect(fs.readFileSync(storeFile, 'utf-8')).toBe(tornStore);
  });

  it('keeps the last applied disabled commands when the file turns torn', async () => {
    writeRaw(componentFile, JSON.stringify({ 'mod:command:alpha': false }));
    await registerCommands(fakeClient(), { runOrphanCleanup: false });
    expect(h.created).toEqual(['beta']);
    h.created.length = 0;
    writeRaw(componentFile, TORN);
    const kept = await import('../../src/bot/internalSetup/utils/appStoreConfigFile');
    vi.resetModules();
    vi.doMock('../../src/bot/internalSetup/utils/appStoreConfigFile', () => kept);
    const fresh = (await import('../../src/bot/internalSetup/events/clientReady/registerCommands')).default;
    vi.doUnmock('../../src/bot/internalSetup/utils/appStoreConfigFile');
    await fresh(fakeClient(), { runOrphanCleanup: false });
    expect(h.created).toEqual(['beta']);
  });

  it('says no disabled set was applied when a fresh boot reads a torn file', async () => {
    writeRaw(componentFile, TORN);
    vi.resetModules();
    const toggle = await import('../../src/bot/internalSetup/utils/ipcToggleHandler');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    toggle.applyAllDisabledStatesOnBoot();
    const logged = errors.mock.calls.map(c => String(c[0])).join('\n');
    errors.mockRestore();
    expect(logged).toContain('no disabled set was applied yet');
    expect(logged).not.toContain('keeping the last applied');
  });

  it('keeps the last applied disabled events after a hot reload reads a torn file', async () => {
    writeRaw(componentFile, JSON.stringify({ 'mod:event:ready': false }));
    applyAllDisabledStatesOnBoot();
    expect(h.removedEvents).toEqual(['mod:ready']);
    h.removedEvents.length = 0;
    writeRaw(componentFile, TORN);
    await applyComponentToggleState({} as any, { manifest: { name: 'mod' } } as any);
    expect(h.removedEvents).toEqual(['mod:ready']);
  });
  it('keeps runtime toggles in the applied sets when the file turns torn', async () => {
    writeRaw(componentFile, JSON.stringify({ 'mod:command:alpha': false }));
    await registerCommands(fakeClient(), { runOrphanCleanup: false });
    applyAllDisabledStatesOnBoot();
    const sent: any[] = [];
    const hadSend = process.send;
    (process as any).send = (m: any) => { sent.push(m); return true; };
    const before = process.listeners('message').length;
    setupToggleIPCHandlers(fakeClient());
    const toggle = async (requestId: string, data: any) => {
      process.emit('message' as any, { type: 'component:toggle', requestId, data } as any);
      await vi.waitFor(() => expect(sent.find(m => m.requestId === requestId)).toBeTruthy());
    };
    await toggle('r1', { module: 'mod', componentType: 'command', name: 'alpha', enabled: true });
    await toggle('r2', { module: 'mod', componentType: 'command', name: 'beta', enabled: false });
    await toggle('r3', { module: 'mod', componentType: 'event', name: 'ready', enabled: false });
    for (const l of process.listeners('message').slice(before)) process.off('message', l as any);
    (process as any).send = hadSend;
    expect(sent.every(m => m.data.success)).toBe(true);
    writeRaw(componentFile, TORN);
    h.created.length = 0;
    h.removedEvents.length = 0;
    const kept = keptConfigFile;
    vi.resetModules();
    vi.doMock('../../src/bot/internalSetup/utils/appStoreConfigFile', () => kept);
    const fresh = (await import('../../src/bot/internalSetup/events/clientReady/registerCommands')).default;
    vi.doUnmock('../../src/bot/internalSetup/utils/appStoreConfigFile');
    await fresh(fakeClient(), { runOrphanCleanup: false });
    expect(h.created).toEqual(['alpha']);
    await applyComponentToggleState({} as any, { manifest: { name: 'mod' } } as any);
    expect(h.removedEvents).toEqual(['mod:ready']);
  });
});
