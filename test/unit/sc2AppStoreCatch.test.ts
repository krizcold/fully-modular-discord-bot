import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// L5 regate, chunk sc2: what the App Store module detail, module credentials, premium audit and App Store config
// routes answer when the call inside them throws (an Error, a value that is not an Error, or a shared-op failure
// that was already answered), what the credentials save answers for a body that is not an object or a save that
// fails, and the config route's two flags.

const h = vi.hoisted(() => ({
  store: {} as Record<string, any>,
  pm: {} as Record<string, any>,
}));

vi.mock('../../src/utils/envLoader', async orig => (await import('../helpers/backendKind')).withBackendKind(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/appStoreManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/appStoreManager')>();
  return { ...real, getAppStoreManager: () => h.store };
});
vi.mock('../../src/bot/internalSetup/utils/premiumManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/premiumManager')>();
  return { ...real, getPremiumManager: () => h.pm };
});

import { createAppStoreRoutes } from '../../src/webui/routes/appstore';
import { SharedOpAnswered } from '../../src/webui/routes/hopFailure';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';

type Sent = { status: number; body: any };

function makeBot(over: Record<string, unknown> = {}): any {
  return {
    storeDocsFirst: async () => null,
    migrationRunning: () => null,
    runSharedOp: async () => ({ ok: true }),
    getCommandCleanupStatus: () => ({ running: false }),
    ...over,
  };
}

async function run(bot: any, method: string, routePath: string, params: Record<string, string> = {}, body: unknown = {}): Promise<Sent[]> {
  const router: any = createAppStoreRoutes(bot);
  const layer = router.stack.find((l: any) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`no route ${method} ${routePath}`);
  const sent: Sent[] = [];
  let code = 200;
  const res: any = {
    status(c: number) { code = c; return res; },
    json(b: unknown) { sent.push({ status: code, body: b }); return res; },
  };
  await layer.route.stack[0].handle({ params, body, query: {} }, res, () => undefined);
  return sent;
}

const CONFIG = path.join(dataPath('global', 'appstore'), 'config.json');
let configBefore: string | null = null;

function writeConfig(text: string): void {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, text);
}

beforeEach(() => {
  h.store = {};
  h.pm = {};
  setBackendKind('file');
  configBefore = fs.existsSync(CONFIG) ? fs.readFileSync(CONFIG, 'utf8') : null;
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});
afterEach(() => {
  setBackendKind(null);
  if (configBefore === null) fs.rmSync(CONFIG, { force: true });
  else fs.writeFileSync(CONFIG, configBefore);
  vi.restoreAllMocks();
});

const answered = () => new SharedOpAnswered('sc2 the bot refusal was already answered');

describe('sc2 GET /modules/:name when the read throws', () => {
  it('sc2 a module read that throws an Error is answered 500 with success false and its message', async () => {
    h.store = { getModuleInfo: () => { throw new Error('sc2 the module index is unreadable'); } };
    expect(await run(makeBot(), 'get', '/modules/:name', { name: 'sc2mod' })).toEqual([
      { status: 500, body: { success: false, error: 'sc2 the module index is unreadable' } },
    ]);
  });
});

describe('sc2 GET /credentials/:name when the read throws', () => {
  it('sc2 a credentials read that throws an Error is answered 500 with success false and its message', async () => {
    h.store = { getCredentials: () => { throw new Error('sc2 credentials unreadable'); } };
    expect(await run(makeBot(), 'get', '/credentials/:name', { name: 'sc2mod' })).toEqual([
      { status: 500, body: { success: false, error: 'sc2 credentials unreadable' } },
    ]);
  });

  it('sc2 a credentials read that throws a value that is not an Error is answered Unknown error', async () => {
    h.store = { getCredentials: () => { throw 'sc2 a bare string'; } };
    expect(await run(makeBot(), 'get', '/credentials/:name', { name: 'sc2mod' })).toEqual([
      { status: 500, body: { success: false, error: 'Unknown error' } },
    ]);
  });

  it('sc2 a credentials read that throws an already answered shared-op failure sends nothing more', async () => {
    h.store = { getCredentials: () => { throw answered(); } };
    expect(await run(makeBot(), 'get', '/credentials/:name', { name: 'sc2mod' })).toEqual([]);
  });
});

describe('sc2 PUT /credentials/:name', () => {
  for (const credentials of ['sc2-made-up-key', 42, true]) {
    it(`sc2 a credentials value that is not an object (${typeof credentials}) is refused 400 and nothing is saved`, async () => {
      let saves = 0;
      h.store = { saveCredentialsAwaited: async () => { saves++; return true; } };
      const sent = await run(makeBot(), 'put', '/credentials/:name', { name: 'sc2mod' }, { credentials });
      expect(sent).toEqual([{ status: 400, body: { success: false, error: 'Credentials object is required' } }]);
      expect(saves).toBe(0);
    });
  }

  it('sc2 a save that reports failure is answered success false with Failed to save credentials', async () => {
    h.store = { saveCredentialsAwaited: async () => false };
    expect(await run(makeBot(), 'put', '/credentials/:name', { name: 'sc2mod' }, { credentials: { API_KEY: 'made-up' } })).toEqual([
      { status: 200, body: { success: false, message: 'Failed to save credentials' } },
    ]);
  });

  it('sc2 a save that throws an Error is answered 500 with success false and its message', async () => {
    h.store = { saveCredentialsAwaited: async () => { throw new Error('sc2 the disk did not take the write'); } };
    expect(await run(makeBot(), 'put', '/credentials/:name', { name: 'sc2mod' }, { credentials: { API_KEY: 'made-up' } })).toEqual([
      { status: 500, body: { success: false, error: 'sc2 the disk did not take the write' } },
    ]);
  });

  it('sc2 a save that throws a value that is not an Error is answered Unknown error', async () => {
    h.store = { saveCredentialsAwaited: async () => { throw 42; } };
    expect(await run(makeBot(), 'put', '/credentials/:name', { name: 'sc2mod' }, { credentials: { API_KEY: 'made-up' } })).toEqual([
      { status: 500, body: { success: false, error: 'Unknown error' } },
    ]);
  });

  it('sc2 a save that throws an already answered shared-op failure sends nothing more', async () => {
    h.store = { saveCredentialsAwaited: async () => { throw answered(); } };
    expect(await run(makeBot(), 'put', '/credentials/:name', { name: 'sc2mod' }, { credentials: { API_KEY: 'made-up' } })).toEqual([]);
  });
});

describe('sc2 DELETE /credentials/:name when the delete throws', () => {
  it('sc2 a delete that throws a value that is not an Error is answered Unknown error', async () => {
    h.store = { deleteCredentialsAwaited: async () => { throw { reason: 'sc2 not an Error' }; } };
    expect(await run(makeBot(), 'delete', '/credentials/:name', { name: 'sc2mod' })).toEqual([
      { status: 500, body: { success: false, error: 'Unknown error' } },
    ]);
  });

  it('sc2 a delete that throws an already answered shared-op failure sends nothing more', async () => {
    h.store = { deleteCredentialsAwaited: async () => { throw answered(); } };
    expect(await run(makeBot(), 'delete', '/credentials/:name', { name: 'sc2mod' })).toEqual([]);
  });
});

describe('sc2 GET /premium/audit when the read throws', () => {
  it('sc2 an audit read that throws a value that is not an Error is answered Unknown error', async () => {
    h.pm = { readAuditEntries: async () => { throw 'sc2 a bare string'; } };
    expect(await run(makeBot(), 'get', '/premium/audit')).toEqual([{ status: 500, body: { success: false, error: 'Unknown error' } }]);
  });

  it('sc2 an audit read that throws an already answered shared-op failure sends nothing more', async () => {
    h.pm = { readAuditEntries: async () => { throw answered(); } };
    expect(await run(makeBot(), 'get', '/premium/audit')).toEqual([]);
  });
});

describe('sc2 GET /config', () => {
  it('sc2 with no config file both flags read false', async () => {
    fs.rmSync(CONFIG, { force: true });
    expect(await run(makeBot(), 'get', '/config')).toEqual([
      { status: 200, body: { success: true, autoCleanup: false, autoUpdate: false, cleanup: { running: false } } },
    ]);
  });

  it('sc2 a flag stored as anything but true reads false', async () => {
    writeConfig(JSON.stringify({ autoCleanup: 'true', autoUpdate: 1 }));
    expect(await run(makeBot(), 'get', '/config')).toEqual([
      { status: 200, body: { success: true, autoCleanup: false, autoUpdate: false, cleanup: { running: false } } },
    ]);
  });

  it('sc2 autoUpdate stored as true reads true and autoCleanup stored as false reads false', async () => {
    writeConfig(JSON.stringify({ autoCleanup: false, autoUpdate: true }));
    expect(await run(makeBot(), 'get', '/config')).toEqual([
      { status: 200, body: { success: true, autoCleanup: false, autoUpdate: true, cleanup: { running: false } } },
    ]);
  });

  it('sc2 a config file that is not JSON is answered 500 with success false and the read error', async () => {
    writeConfig('{ not json');
    const sent = await run(makeBot(), 'get', '/config');
    expect(sent).toHaveLength(1);
    expect(sent[0].status).toBe(500);
    expect(Object.keys(sent[0].body).sort()).toEqual(['error', 'success']);
    expect(sent[0].body.success).toBe(false);
    expect(sent[0].body.error).toMatch(/^config\.json cannot be read: \S/);
  });

  it('sc2 a cleanup status read that throws a value that is not an Error is answered Unknown error', async () => {
    fs.rmSync(CONFIG, { force: true });
    const bot = makeBot({ getCommandCleanupStatus: () => { throw 'sc2 a bare string'; } });
    expect(await run(bot, 'get', '/config')).toEqual([{ status: 500, body: { success: false, error: 'Unknown error' } }]);
  });
});
