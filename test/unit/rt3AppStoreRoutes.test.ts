import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// L5 run A, chunk rt3: the premium credentials PUT (blank keeps, a failed /data/.env save, the kept-keys sentence,
// the doc op's failure, the unread status) and the store-first refusal and StoreWriteError answers of the
// components and App Store config routes.

const h = vi.hoisted(() => ({
  existing: {} as Record<string, string | undefined>,
  creds: {} as Record<string, string | undefined>,
  unread: null as string | null,
  docKeys: new Set<string>(),
  saved: [] as Array<Record<string, string | undefined>>,
  saveResult: { success: true } as { success: boolean; error?: string },
  writeConfig: null as null | (() => Promise<void>),
  fields: [] as Array<{ key: string; type: string }>,
}));

vi.mock('../../src/utils/envLoader', async orig => {
  const real = (await import('../helpers/backendKind')).withBackendKind(await orig<any>());
  return {
    ...real,
    loadCredentials: () => ({ ...h.existing }),
    credentialsReadError: () => null,
    saveCredentials: (next: Record<string, string | undefined>) => {
      h.saved.push({ ...next });
      return h.saveResult;
    },
    providerCredentials: () => ({ ...h.creds }),
    providerCredentialsUnread: () => h.unread,
    providerDocKey: (_id: string, key: string) => h.docKeys.has(key),
  };
});
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  const provider = { getCredentialFields: () => h.fields, isConfigured: () => true };
  return { ...real, getPaymentRegistry: () => ({ get: (id: string) => (id === 'rt3pay' ? provider : undefined), listAll: () => [] }) };
});
vi.mock('../../src/bot/internalSetup/utils/moduleRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/moduleRegistry')>();
  return { ...real, getModuleRegistry: () => ({ getAllModules: () => { throw new Error('rt3 registry was read'); } }) };
});
vi.mock('../../src/bot/internalSetup/utils/appStoreConfigFile', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/appStoreConfigFile')>();
  return {
    ...real,
    writeConfigFile: (file: string, config: Record<string, any>, base?: string) =>
      h.writeConfig ? h.writeConfig() : real.writeConfigFile(file, config, base),
  };
});

import { createAppStoreRoutes } from '../../src/webui/routes/appstore';
import { StoreWriteError } from '../../src/bot/internalSetup/utils/appStoreManager';
import { dataPath } from '../../src/utils/dataRoot';
import { setBackendKind } from '../helpers/backendKind';

const REFUSED = { status: 503, error: 'rt3: the App Store docs could not be brought up to the rows; nothing was changed' };

function makeBot(over: Record<string, unknown> = {}): any {
  return {
    storeDocsFirst: async () => null,
    migrationRunning: () => null,
    runSharedOp: async () => ({ ok: true }),
    getCommandCleanupStatus: () => ({ running: false }),
    isRunning: () => false,
    ...over,
  };
}

async function run(bot: any, method: string, routePath: string, params: Record<string, string> = {}, body: unknown = {}) {
  const router: any = createAppStoreRoutes(bot);
  const layer = router.stack.find((l: any) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`no route ${method} ${routePath}`);
  const sent: Array<{ status: number; body: any }> = [];
  let code = 200;
  const res: any = {
    status(c: number) { code = c; return res; },
    json(b: unknown) { sent.push({ status: code, body: b }); return res; },
  };
  await layer.route.stack[0].handle({ params, body, query: {} }, res, () => undefined);
  return sent;
}

const APPSTORE_DIR = dataPath('global', 'appstore');
const CONFIG = path.join(APPSTORE_DIR, 'config.json');
const COMPONENTS = path.join(APPSTORE_DIR, 'component-config.json');
const snapshot: Record<string, string | null> = {};

beforeEach(() => {
  h.existing = {};
  h.creds = {};
  h.unread = null;
  h.docKeys = new Set();
  h.saved = [];
  h.saveResult = { success: true };
  h.writeConfig = null;
  h.fields = [];
  for (const f of [CONFIG, COMPONENTS]) snapshot[f] = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});
afterEach(() => {
  setBackendKind(null);
  for (const f of [CONFIG, COMPONENTS]) {
    if (snapshot[f] === null) fs.rmSync(f, { force: true });
    else fs.writeFileSync(f, snapshot[f]!);
  }
  vi.restoreAllMocks();
});

const CRED = '/premium/providers/:providerId/credentials';

describe('rt3 PUT provider credentials', () => {
  it('rt3 a blank value keeps the stored one', async () => {
    setBackendKind('file');
    h.fields = [{ key: 'KEEP', type: 'secret' }, { key: 'NEW', type: 'text' }];
    h.existing = { KEEP: 'old-made-up' };
    const sent = await run(makeBot(), 'put', CRED, { providerId: 'rt3pay' }, { values: { KEEP: '   ', NEW: ' fresh ' } });
    expect(sent).toHaveLength(1);
    expect(sent[0].status).toBe(200);
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0].KEEP === 'old-made-up').toBe(true);
    expect(h.saved[0].NEW).toBe('fresh');
  });

  it("rt3 a failed /data/.env save answers 500 with the save's own error", async () => {
    setBackendKind('file');
    h.fields = [{ key: 'K', type: 'text' }];
    h.saveResult = { success: false, error: 'EACCES: /data/.env is read-only' };
    const sent = await run(makeBot(), 'put', CRED, { providerId: 'rt3pay' }, { values: { K: 'v' } });
    expect(sent).toEqual([{ status: 500, body: { success: false, error: 'EACCES: /data/.env is read-only' } }]);
  });

  it('rt3 a failed /data/.env save with no error text answers "Failed to save credentials"', async () => {
    setBackendKind('file');
    h.fields = [{ key: 'K', type: 'text' }];
    h.saveResult = { success: false };
    const sent = await run(makeBot(), 'put', CRED, { providerId: 'rt3pay' }, { values: { K: 'v' } });
    expect(sent).toEqual([{ status: 500, body: { success: false, error: 'Failed to save credentials' } }]);
  });

  it('rt3 on a Postgres bot the keys kept on this machine are named comma-separated', async () => {
    setBackendKind('postgres');
    h.fields = [{ key: 'LOCAL_A', type: 'text' }, { key: 'LOCAL_B', type: 'text' }];
    const sent = await run(makeBot(), 'put', CRED, { providerId: 'rt3pay' }, { values: { LOCAL_A: 'a', LOCAL_B: 'b' } });
    expect(sent).toHaveLength(1);
    expect(sent[0].body.success).toBe(true);
    expect(sent[0].body.message).toBe('Saved. LOCAL_A, LOCAL_B are kept on this machine only (in /data/.env); set them on each machine of the bot.');
  });

  it("rt3 the doc op's failure answers success false with the kept keys' sentence", async () => {
    setBackendKind('postgres');
    h.fields = [{ key: 'DOC', type: 'secret' }, { key: 'LOCAL', type: 'text' }];
    h.docKeys = new Set(['DOC']);
    const bot = makeBot({ runSharedOp: async () => ({ ok: false, error: 'rt3 doc write refused' }) });
    const sent = await run(bot, 'put', CRED, { providerId: 'rt3pay' }, { values: { DOC: 'x', LOCAL: 'y' } });
    expect(sent).toHaveLength(1);
    expect(sent[0].status).not.toBe(200);
    expect(sent[0].body.success).toBe(false);
    expect(sent[0].body.error).toContain('rt3 doc write refused');
    expect(sent[0].body.error).toContain(' LOCAL were saved on this machine only (in /data/.env); set them on each machine of the bot.');
  });

  it("rt3 the answer's status says can't confirm only for an unset doc key", async () => {
    setBackendKind('file');
    h.fields = [{ key: 'UNSET', type: 'secret' }, { key: 'SET', type: 'secret' }, { key: 'PLAIN', type: 'text' }];
    h.docKeys = new Set(['UNSET', 'SET']);
    h.creds = { SET: 'made-up' };
    h.unread = 'the credentials doc is not valid JSON';
    const sent = await run(makeBot(), 'put', CRED, { providerId: 'rt3pay' }, { values: { PLAIN: 'p' } });
    expect(sent).toHaveLength(1);
    expect(sent[0].body.status).toEqual({
      UNSET: { set: false, unread: "can't confirm: the credentials doc is not valid JSON" },
      SET: { set: true },
      PLAIN: { set: false },
    });
  });
});

const refusingBot = () => makeBot({ storeDocsFirst: async () => REFUSED });
const refusedAnswer = [{ status: 503, body: { success: false, error: REFUSED.error } }];

describe('rt3 a Postgres bot whose App Store docs cannot be brought up answers the refusal', () => {
  it('rt3 GET /components', async () => {
    setBackendKind('postgres');
    expect(await run(refusingBot(), 'get', '/components')).toEqual(refusedAnswer);
  });

  it('rt3 PUT /components/:module/:type/:name', async () => {
    setBackendKind('postgres');
    const sent = await run(refusingBot(), 'put', '/components/:module/:type/:name', { module: 'm', type: 'bogus', name: 'n' }, { enabled: true });
    expect(sent).toEqual(refusedAnswer);
  });

  it('rt3 GET /config', async () => {
    setBackendKind('postgres');
    expect(await run(refusingBot(), 'get', '/config')).toEqual(refusedAnswer);
  });

  it('rt3 PUT /config, and config.json is not written', async () => {
    setBackendKind('postgres');
    fs.mkdirSync(APPSTORE_DIR, { recursive: true });
    fs.writeFileSync(CONFIG, '{"autoCleanup":false}');
    const sent = await run(refusingBot(), 'put', '/config', {}, { autoCleanup: true });
    expect(sent).toEqual(refusedAnswer);
    expect(fs.readFileSync(CONFIG, 'utf8')).toBe('{"autoCleanup":false}');
  });
});

describe('rt3 GET /config', () => {
  it('rt3 a JSON bot answers the stored settings and the cleanup status', async () => {
    setBackendKind('file');
    fs.mkdirSync(APPSTORE_DIR, { recursive: true });
    fs.writeFileSync(CONFIG, '{"autoCleanup":true,"autoUpdate":"yes"}');
    const cleanup = { running: false, finishedAt: 5, success: true };
    const sent = await run(makeBot({ getCommandCleanupStatus: () => cleanup }), 'get', '/config');
    expect(sent).toEqual([{ status: 200, body: { success: true, autoCleanup: true, autoUpdate: false, cleanup } }]);
  });
});

describe('rt3 a StoreWriteError from the settings write is answered with its status and text', () => {
  const conflict = () => {
    h.writeConfig = async () => { throw new StoreWriteError(409, 'appstore/rt3 was changed on BRAVO; nothing was saved', 'BRAVO'); };
  };

  it('rt3 PUT /components/:module/:type/:name', async () => {
    setBackendKind('file');
    conflict();
    const sent = await run(makeBot(), 'put', '/components/:module/:type/:name', { module: 'm', type: 'command', name: 'n' }, { enabled: false });
    expect(sent).toEqual([{ status: 409, body: { success: false, error: 'appstore/rt3 was changed on BRAVO; nothing was saved' } }]);
  });

  it('rt3 PUT /config', async () => {
    setBackendKind('file');
    conflict();
    const sent = await run(makeBot(), 'put', '/config', {}, { autoUpdate: true });
    expect(sent).toEqual([{ status: 409, body: { success: false, error: 'appstore/rt3 was changed on BRAVO; nothing was saved' } }]);
  });
});
