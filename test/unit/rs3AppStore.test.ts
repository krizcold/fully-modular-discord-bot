import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// L5 run A, chunk rs3: the App Store routes' answer for a StoreWriteError (NB6 decision 28), the set flag of a
// provider's credential fields, and the module failure list a Postgres bot's /installed carries (owner question 1).

const h = vi.hoisted(() => ({
  creds: {} as Record<string, string | undefined>,
  store: {} as Record<string, any>,
  backend: null as null | { sharedSelect?: (sql: string, values: unknown[], boundMs: number) => Promise<{ rows: any[] }> },
  selects: [] as Array<{ sql: string; values: unknown[] }>,
  provider: {
    getCredentialFields: () => [
      { key: 'SPACES', type: 'text' },
      { key: 'PLACEHOLDER', type: 'text' },
      { key: 'TAIL', type: 'text' },
      { key: 'REAL', type: 'secret' },
    ],
    isConfigured: () => false,
  },
}));

vi.mock('../../src/utils/envLoader', async orig => {
  const real = (await import('../helpers/backendKind')).withBackendKind(await orig<any>());
  return { ...real, providerCredentials: () => ({ ...h.creds }), providerCredentialsUnread: () => null };
});
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  return { ...real, getPaymentRegistry: () => ({ get: (id: string) => (id === 'rs3pay' ? h.provider : undefined), listAll: () => [] }) };
});
vi.mock('../../src/bot/internalSetup/utils/appStoreManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/appStoreManager')>();
  return { ...real, getAppStoreManager: () => h.store };
});
vi.mock('../../src/bot/internalSetup/utils/sharedStore', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/sharedStore')>();
  return { ...real, rowBackend: () => h.backend };
});

import { createAppStoreRoutes } from '../../src/webui/routes/appstore';
import { StoreWriteError } from '../../src/bot/internalSetup/utils/appStoreManager';
import { setBackendKind } from '../helpers/backendKind';

function fakeRes() {
  const sent: Array<{ status: number; body: any }> = [];
  let code = 200;
  const res: any = {
    status(c: number) { code = c; return res; },
    json(body: unknown) { sent.push({ status: code, body }); return res; },
  };
  return { res, sent };
}

const botManager: any = { storeDocsFirst: async () => null, migrationRunning: () => null, runSharedOp: async () => ({ success: true }) };

async function run(method: string, routePath: string, params: Record<string, string>, body: unknown = {}) {
  const router: any = createAppStoreRoutes(botManager);
  const layer = router.stack.find((l: any) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`no route ${method} ${routePath}`);
  const { res, sent } = fakeRes();
  await layer.route.stack[0].handle({ params, body, query: {} }, res, () => undefined);
  return sent;
}

beforeEach(() => {
  h.creds = {};
  h.store = {};
  h.backend = null;
  h.selects = [];
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});
afterEach(() => {
  setBackendKind(null);
  vi.restoreAllMocks();
});

describe('rs3 a StoreWriteError is answered once with its status and text', () => {
  it('rs3 PUT /credentials/:name answers the 409 and its words, nothing after', async () => {
    setBackendKind('file');
    h.store = { saveCredentialsAwaited: async () => { throw new StoreWriteError(409, 'BRAVO saved another version first; nothing was saved', 'BRAVO'); } };
    const sent = await run('put', '/credentials/:name', { name: 'mod' }, { credentials: { a: 'b' } });
    expect(sent).toEqual([{ status: 409, body: { success: false, error: 'BRAVO saved another version first; nothing was saved' } }]);
  });
});

describe('rs3 which credential values count as set', () => {
  it('rs3 blank and REPLACE-prefixed values are not set; a value that only ends in REPLACE is', async () => {
    h.creds = { SPACES: '   ', PLACEHOLDER: 'REPLACE_ME', TAIL: 'keyREPLACE', REAL: 's3cret' };
    const sent = await run('get', '/premium/providers/:providerId/credentials', { providerId: 'rs3pay' });
    expect(sent).toHaveLength(1);
    expect(sent[0].status).toBe(200);
    expect(sent[0].body.status).toEqual({
      SPACES: { set: false },
      PLACEHOLDER: { set: false },
      TAIL: { set: true, preview: 'keyREPLACE' },
      REAL: { set: true, preview: String.fromCharCode(0x2022).repeat(8) },
    });
  });
});

describe("rs3 a Postgres bot's /installed lists the machines where a module failed to load", () => {
  it('rs3 with no connection to the database it says so', async () => {
    setBackendKind('postgres');
    h.store = { getInstalledModules: () => [] };
    h.backend = {};
    const sent = await run('get', '/installed', {});
    expect(sent).toEqual([{ status: 200, body: { success: true, modules: [], moduleFailuresUnread: "this process has no connection to the bot's database" } }]);
  });

  it('rs3 each failed row is one line, its error empty only when the row holds none', async () => {
    setBackendKind('postgres');
    h.store = { getInstalledModules: () => [] };
    h.backend = {
      sharedSelect: async (sql, values) => {
        h.selects.push({ sql, values });
        return {
          rows: [
            { module: 'a', node_name: 'ALPHA', sha: 's1', error: null, version: '1.0.0' },
            { module: 'b', node_name: 'BRAVO', sha: 's2', error: undefined, version: null },
            { module: 'c', node_name: 'CHARLIE', sha: 's3', error: 'boom', version: '2.0.0' },
          ],
        };
      },
    };
    const sent = await run('get', '/installed', {});
    expect(sent).toHaveLength(1);
    expect(sent[0].body.moduleFailures).toEqual([
      { module: 'a', version: '1.0.0', machine: 'ALPHA', error: '' },
      { module: 'b', version: 's2', machine: 'BRAVO', error: '' },
      { module: 'c', version: '2.0.0', machine: 'CHARLIE', error: 'boom' },
    ]);
    expect(h.selects).toHaveLength(1);
    expect(h.selects[0].values).toEqual([]);
  });
});
