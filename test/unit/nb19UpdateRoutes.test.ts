import { beforeEach, describe, expect, it, vi } from 'vitest';

// NB19 row 72, the web UI's update routes: an update whose list of installed modules can't be confirmed as saved (T9)
// reloads the module where the route reloads, then answers success false with T9.

const up = vi.hoisted(() => ({ single: null as any, bulk: null as any }));
vi.mock('../../src/updater', async orig => {
  const real = await orig<any>();
  return { ...real, triggerModuleUpdate: async () => up.single, triggerAllModuleUpdates: async () => up.bulk };
});

import { createUpdateRouter } from '../../src/webui/routes/update';
import type { BulkModuleUpdateResult } from '../../src/updater';

const T9 = "Module alpha is updated, but the list of installed modules can't be confirmed as saved: /data/global/appstore/installed.json is written, but the disk did not confirm the sync of /data/global/appstore (EIO), so can't confirm it is stored. Check the disk, then restart the machine. Its backup is kept at /data/global/appstore/backups/alpha-1.";

function route(router: any, method: string, routePath: string): (req: any, res: any) => any {
  const layer = router.stack.find((l: any) => l.route?.path === routePath && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
function fakeRes(): any {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  return res;
}
const bot = {
  reloadModule: vi.fn(async () => ({ success: true })),
  reloadModules: vi.fn(async () => ({ success: true, reloaded: ['alpha'], failed: [] })),
  applyModule: vi.fn(async () => ({ outcome: 'applied', text: null })),
};
const bulk = (): BulkModuleUpdateResult => ({
  success: false, totalAttempted: 1, totalUpdated: 1,
  updated: [{ moduleName: 'alpha', oldVersion: '1.0.0', newVersion: '1.1.0', listUnconfirmed: T9 }],
  failed: [], checkErrors: [], skipped: [],
});

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  bot.reloadModule.mockClear();
  bot.reloadModules.mockClear();
  bot.applyModule.mockClear();
  up.single = { success: true, moduleName: 'alpha', oldVersion: '1.0.0', newVersion: '1.1.0', listUnconfirmed: T9 };
  up.bulk = bulk();
});

describe('row 72: the update routes with T9', () => {
  it('POST /modules/:name answers success false with T9 and both versions', async () => {
    const res = fakeRes();
    await route(createUpdateRouter(bot as never), 'post', '/modules/:name')({ params: { name: 'alpha' }, body: {} }, res);
    expect(res.body).toEqual({ success: false, moduleName: 'alpha', oldVersion: '1.0.0', newVersion: '1.1.0', error: T9 });
  });

  it('POST /module-and-reload/:name reloads the module, then answers success false with T9', async () => {
    const res = fakeRes();
    await route(createUpdateRouter(bot as never), 'post', '/module-and-reload/:name')({ params: { name: 'alpha' }, body: {} }, res);
    expect(bot.reloadModule).toHaveBeenCalledWith('alpha');
    expect(res.body).toMatchObject({ success: false, error: T9 });
  });

  it('POST /modules answers success false with a message that ends with T9', async () => {
    const res = fakeRes();
    await route(createUpdateRouter(bot as never), 'post', '/modules')({ params: {}, body: {} }, res);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe(`Updated 1 module(s). ${T9}`);
  });

  it('POST /modules-and-reload reloads the module, then answers success false with the reload clause and T9', async () => {
    const res = fakeRes();
    await route(createUpdateRouter(bot as never), 'post', '/modules-and-reload')({ params: {}, body: {} }, res);
    expect(bot.reloadModules).toHaveBeenCalledWith(['alpha']);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe(`Updated 1 module(s); reloaded the updated module(s). ${T9}`);
  });
});
