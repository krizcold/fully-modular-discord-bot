import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ fail: new Set<string>() }));

vi.mock('../../src/bot/internalSetup/utils/folderChain', async orig => {
  const real = await orig<any>();
  return {
    ...real,
    syncFolderChainSync: (dir: string) => {
      const at = path.resolve(dir);
      if (!h.fail.has(at)) return { failed: false };
      return { failed: true, kind: 'sync', dir: at, errno: 'EIO', error: null };
    },
  };
});

import { dataPath } from '../../src/utils/dataRoot';
import { syncWords } from '../../src/bot/internalSetup/utils/folderChain';
import { createAppStoreRoutes } from '../../src/webui/routes/appstore';
import { setBackendKind } from '../helpers/backendKind';

const STORE = path.resolve(dataPath('global', 'appstore'));
const COMPONENTS = path.join(STORE, 'component-config.json');
const STORE_CONFIG = path.join(STORE, 'config.json');

const T1 = (file: string) => {
  const { why, next } = syncWords('sync', STORE, 'EIO');
  return `${file} is written, but ${why}, so can't confirm it is stored. ${next}`;
};
const SETTINGS_TEXT = () => `The App Store settings can't be confirmed as saved: ${T1(STORE_CONFIG)}`;

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
const makeBot = (opts: { running?: boolean; cleanupRunning?: boolean } = {}) => ({
  isRunning: () => opts.running ?? true,
  toggleComponent: vi.fn(async () => undefined),
  startCommandCleanup: vi.fn(() => undefined),
  getCommandCleanupStatus: () => ({ running: opts.cleanupRunning ?? false }),
});
async function putConfig(bot: ReturnType<typeof makeBot>, body: Record<string, unknown>): Promise<any> {
  const res = fakeRes();
  await route(createAppStoreRoutes(bot as never), 'put', '/config')({ params: {}, body }, res);
  return res;
}

let errors: string[];
beforeEach(() => {
  h.fail.clear();
  errors = [];
  setBackendKind('file');
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  fs.rmSync(COMPONENTS, { force: true });
  fs.rmSync(STORE_CONFIG, { force: true });
});
afterEach(() => {
  setBackendKind(null);
  vi.restoreAllMocks();
});

describe('sa16 the component toggle whose store folder sync fails', () => {
  it('sa16 logs the can not confirm text under its [AppStore] tag', async () => {
    h.fail.add(STORE);
    const res = fakeRes();
    await route(createAppStoreRoutes(makeBot({ running: false }) as never), 'put', '/components/:module/:type/:name')(
      { params: { module: 'mod', type: 'command', name: 'beta' }, body: { enabled: false } }, res);
    const text = `The component setting can't be confirmed as saved: ${T1(COMPONENTS)}`;
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe(text);
    expect(errors).toContain(`[AppStore] ${text}`);
  });
});

describe('sa16 PUT /config', () => {
  it('sa16 a save that lands answers 200 with the stored settings and logs nothing', async () => {
    const res = await putConfig(makeBot(), { autoUpdate: true });
    expect(JSON.parse(fs.readFileSync(STORE_CONFIG, 'utf8'))).toEqual({ autoUpdate: true });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, autoCleanup: false, autoUpdate: true });
    expect(errors).toEqual([]);
  });

  it('sa16 a folder sync failure turning autoUpdate on while a cleanup runs: 500 with the file values, cleanupStopping, the text and its log line', async () => {
    h.fail.add(STORE);
    const bot = makeBot({ cleanupRunning: true });
    const res = await putConfig(bot, { autoUpdate: true, autoCleanup: false });
    expect(JSON.parse(fs.readFileSync(STORE_CONFIG, 'utf8'))).toEqual({ autoUpdate: true, autoCleanup: false });
    expect(bot.startCommandCleanup).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ success: false, autoCleanup: false, autoUpdate: true, cleanupStopping: true, error: SETTINGS_TEXT() });
    expect(errors).toEqual([`[AppStore] ${SETTINGS_TEXT()}`]);
  });

  it('sa16 a folder sync failure turning autoUpdate off with no cleanup running: autoUpdate false and no cleanupStopping', async () => {
    fs.mkdirSync(STORE, { recursive: true });
    fs.writeFileSync(STORE_CONFIG, JSON.stringify({ autoUpdate: true }));
    h.fail.add(STORE);
    const res = await putConfig(makeBot(), { autoUpdate: false });
    expect(JSON.parse(fs.readFileSync(STORE_CONFIG, 'utf8'))).toEqual({ autoUpdate: false });
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ success: false, autoCleanup: false, autoUpdate: false, error: SETTINGS_TEXT() });
  });
});
