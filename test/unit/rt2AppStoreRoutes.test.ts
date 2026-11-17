import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// L5 run A, chunk rt2: the App Store module detail and module credential routes (with the Postgres store-first
// refusal), the premium audit read, and a provider's credential status and save.

const h = vi.hoisted(() => ({
  creds: {} as Record<string, string | undefined>,
  unread: null as string | null,
  docKeys: new Set<string>(),
  saved: [] as Array<Record<string, string | undefined>>,
  store: {} as Record<string, any>,
  pm: {} as Record<string, any>,
  provider: {
    getCredentialFields: () => [
      { key: 'RT2_SECRET', type: 'secret' },
      { key: 'RT2_TEXT', type: 'text' },
    ],
    isConfigured: () => false,
  },
}));

vi.mock('../../src/utils/envLoader', async orig => {
  const real = (await import('../helpers/backendKind')).withBackendKind(await orig<any>());
  return {
    ...real,
    providerCredentials: () => ({ ...h.creds }),
    providerCredentialsUnread: () => h.unread,
    providerDocKey: (_p: string, key: string) => h.docKeys.has(key),
    loadCredentials: () => ({ ...h.creds }),
    credentialsReadError: () => null,
    saveCredentials: (next: Record<string, string | undefined>) => { h.saved.push({ ...next }); return { success: true }; },
  };
});
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  return { ...real, getPaymentRegistry: () => ({ get: (id: string) => (id === 'rt2pay' ? h.provider : undefined), listAll: () => [] }) };
});
vi.mock('../../src/bot/internalSetup/utils/appStoreManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/appStoreManager')>();
  return { ...real, getAppStoreManager: () => h.store };
});
vi.mock('../../src/bot/internalSetup/utils/premiumManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/premiumManager')>();
  return { ...real, getPremiumManager: () => h.pm };
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

let refusal: null | { status: number; error: string };
const botManager: any = {
  storeDocsFirst: async () => refusal,
  migrationRunning: () => null,
  runSharedOp: async () => ({ success: true }),
};

async function run(method: string, routePath: string, params: Record<string, string>, body: unknown = {}, query: Record<string, string> = {}) {
  const router: any = createAppStoreRoutes(botManager);
  const layer = router.stack.find((l: any) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`no route ${method} ${routePath}`);
  const { res, sent } = fakeRes();
  await layer.route.stack[0].handle({ params, body, query }, res, () => undefined);
  return sent;
}

const REFUSED = { status: 503, error: "can't confirm the App Store docs: the database did not answer" };

beforeEach(() => {
  h.creds = {};
  h.unread = null;
  h.docKeys = new Set();
  h.saved = [];
  h.store = {};
  h.pm = {};
  refusal = null;
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});
afterEach(() => {
  setBackendKind(null);
  vi.restoreAllMocks();
});

const MODULE = {
  manifest: { name: 'rt2mod', displayName: 'RT2 Module', description: 'd', version: '1.2.3', author: 'a', category: 'c' },
  repoId: 'repo1',
  repoName: 'Repo One',
  installed: false,
  installedVersion: undefined,
};

describe('rt2 GET /modules/:name', () => {
  it('rt2 answers a known module with its details and components', async () => {
    setBackendKind('file');
    const asked: string[] = [];
    h.store = {
      getModuleInfo: (name: string) => { asked.push(name); return name === 'rt2mod' ? MODULE : null; },
      getModuleComponents: (name: string, repoId: string) => [{ name, repoId }],
    };
    const sent = await run('get', '/modules/:name', { name: 'rt2mod' });
    expect(asked).toEqual(['rt2mod']);
    expect(sent).toHaveLength(1);
    expect(sent[0].status).toBe(200);
    expect(sent[0].body.success).toBe(true);
    expect(sent[0].body.module).toMatchObject({ name: 'rt2mod', version: '1.2.3', repoId: 'repo1', components: [{ name: 'rt2mod', repoId: 'repo1' }] });
  });

  it('rt2 answers an unknown module with 404', async () => {
    setBackendKind('file');
    h.store = { getModuleInfo: () => null };
    expect(await run('get', '/modules/:name', { name: 'nope' })).toEqual([{ status: 404, body: { success: false, error: 'Module not found' } }]);
  });

  it('rt2 on a Postgres bot whose store docs are refused answers the refusal once and reads nothing', async () => {
    setBackendKind('postgres');
    refusal = REFUSED;
    let reads = 0;
    h.store = { getModuleInfo: () => { reads++; return MODULE; }, getModuleComponents: () => [] };
    const sent = await run('get', '/modules/:name', { name: 'rt2mod' });
    expect(sent).toEqual([{ status: 503, body: { success: false, error: REFUSED.error } }]);
    expect(reads).toBe(0);
  });
});

describe('rt2 GET /credentials/:name', () => {
  it('rt2 answers the stored credentials masked', async () => {
    setBackendKind('file');
    h.store = { getCredentials: (name: string) => (name === 'rt2mod' ? { API_KEY: 'made-up', EMPTY: '' } : null) };
    expect(await run('get', '/credentials/:name', { name: 'rt2mod' })).toEqual([
      { status: 200, body: { success: true, hasCredentials: true, credentials: { API_KEY: '***', EMPTY: '' } } },
    ]);
  });

  it('rt2 answers a module with no credentials', async () => {
    setBackendKind('file');
    h.store = { getCredentials: () => null };
    expect(await run('get', '/credentials/:name', { name: 'other' })).toEqual([
      { status: 200, body: { success: true, hasCredentials: false, credentials: null } },
    ]);
  });

  it('rt2 on a Postgres bot whose store docs are refused answers the refusal once and reads nothing', async () => {
    setBackendKind('postgres');
    refusal = REFUSED;
    let reads = 0;
    h.store = { getCredentials: () => { reads++; return { API_KEY: 'made-up' }; } };
    const sent = await run('get', '/credentials/:name', { name: 'rt2mod' });
    expect(sent).toEqual([{ status: 503, body: { success: false, error: REFUSED.error } }]);
    expect(reads).toBe(0);
  });
});

describe('rt2 PUT /credentials/:name', () => {
  it('rt2 saves the credentials and answers Credentials saved', async () => {
    setBackendKind('file');
    const saves: Array<[string, unknown]> = [];
    h.store = { saveCredentialsAwaited: async (name: string, c: unknown) => { saves.push([name, c]); return true; } };
    const sent = await run('put', '/credentials/:name', { name: 'rt2mod' }, { credentials: { API_KEY: 'made-up' } });
    expect(saves).toEqual([['rt2mod', { API_KEY: 'made-up' }]]);
    expect(sent).toEqual([{ status: 200, body: { success: true, message: 'Credentials saved' } }]);
  });

  it('rt2 refuses a body with no credentials object', async () => {
    setBackendKind('file');
    h.store = { saveCredentialsAwaited: async () => true };
    expect(await run('put', '/credentials/:name', { name: 'rt2mod' }, {})).toEqual([
      { status: 400, body: { success: false, error: 'Credentials object is required' } },
    ]);
  });

  it('rt2 on a Postgres bot whose store docs are refused answers the refusal once and saves nothing', async () => {
    setBackendKind('postgres');
    refusal = REFUSED;
    let saves = 0;
    h.store = { saveCredentialsAwaited: async () => { saves++; return true; } };
    const sent = await run('put', '/credentials/:name', { name: 'rt2mod' }, { credentials: { API_KEY: 'made-up' } });
    expect(sent).toEqual([{ status: 503, body: { success: false, error: REFUSED.error } }]);
    expect(saves).toBe(0);
  });

  it('rt2 a StoreWriteError from the save is answered with its status and words', async () => {
    setBackendKind('file');
    h.store = { saveCredentialsAwaited: async () => { throw new StoreWriteError(409, 'BRAVO saved another version first; nothing was saved', 'BRAVO'); } };
    expect(await run('put', '/credentials/:name', { name: 'rt2mod' }, { credentials: { a: 'b' } })).toEqual([
      { status: 409, body: { success: false, error: 'BRAVO saved another version first; nothing was saved' } },
    ]);
  });
});

describe('rt2 DELETE /credentials/:name', () => {
  it('rt2 a StoreWriteError from the delete is answered with its status and words', async () => {
    setBackendKind('file');
    h.store = { deleteCredentialsAwaited: async () => { throw new StoreWriteError(202, 'the delete is queued; can\'t confirm it landed'); } };
    expect(await run('delete', '/credentials/:name', { name: 'rt2mod' })).toEqual([
      { status: 202, body: { success: false, error: 'the delete is queued; can\'t confirm it landed' } },
    ]);
  });

  it('rt2 any other error from the delete is answered 500 with its message', async () => {
    setBackendKind('file');
    h.store = { deleteCredentialsAwaited: async () => { throw new Error('rt2 disk full'); } };
    expect(await run('delete', '/credentials/:name', { name: 'rt2mod' })).toEqual([
      { status: 500, body: { success: false, error: 'rt2 disk full' } },
    ]);
  });
});

describe('rt2 GET /premium/audit', () => {
  it('rt2 passes every filter on to the audit read and answers its entries', async () => {
    const asked: unknown[] = [];
    h.pm = { readAuditEntries: async (opts: unknown) => { asked.push(opts); return { entries: [{ action: 'grant' }], total: 1 }; } };
    const sent = await run('get', '/premium/audit', {}, {}, {
      from: '2026-11-01T00:00:00.000Z', to: '2026-11-02T00:00:00.000Z', action: 'grant', tierId: 'gold',
      providerId: 'rt2pay', guildId: 'g1', subscriptionId: 's1', limit: '25',
    });
    expect(asked).toEqual([{
      from: '2026-11-01T00:00:00.000Z', to: '2026-11-02T00:00:00.000Z', action: 'grant', tierId: 'gold',
      providerId: 'rt2pay', guildId: 'g1', subscriptionId: 's1', limit: 25,
    }]);
    expect(sent).toEqual([{ status: 200, body: { success: true, entries: [{ action: 'grant' }], total: 1 } }]);
  });

  it('rt2 an audit read that throws is answered 500 with its message', async () => {
    h.pm = { readAuditEntries: async () => { throw new Error('rt2 audit unreadable'); } };
    expect(await run('get', '/premium/audit', {}, {}, {})).toEqual([{ status: 500, body: { success: false, error: 'rt2 audit unreadable' } }]);
  });
});

describe('rt2 provider credential status and save', () => {
  it('rt2 a doc key that is not set while the doc is unread reads not set, with the reason', async () => {
    h.unread = 'payment-providers/credentials.json cannot be read (rt2 cause)';
    h.docKeys = new Set(['RT2_SECRET']);
    const sent = await run('get', '/premium/providers/:providerId/credentials', { providerId: 'rt2pay' });
    expect(sent).toHaveLength(1);
    expect(sent[0].body.status).toEqual({
      RT2_SECRET: { set: false, unread: "can't confirm: payment-providers/credentials.json cannot be read (rt2 cause)" },
      RT2_TEXT: { set: false },
    });
  });

  it('rt2 a saved value is trimmed, and a value of only spaces keeps the old one', async () => {
    setBackendKind('file');
    h.creds = { RT2_TEXT: 'old-text' };
    const sent = await run('put', '/premium/providers/:providerId/credentials', { providerId: 'rt2pay' }, {
      values: { RT2_SECRET: '  made-up-secret  ', RT2_TEXT: '   ' },
    });
    expect(sent[0].status).toBe(200);
    expect(h.saved).toEqual([{ RT2_TEXT: 'old-text', RT2_SECRET: 'made-up-secret' }]);
  });
});
