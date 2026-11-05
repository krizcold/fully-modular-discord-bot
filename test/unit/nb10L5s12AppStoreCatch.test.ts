import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10: the App Store premium and Dummy routes that run a shared op answer exactly once. A refusal the bot answered
// is sent as that refusal and nothing after it; an op that throws is answered with its message; a manual grant
// passes the operator's notes on only when they are text.

const h = vi.hoisted(() => ({
  pm: {
    getSubscriptions: (guildId: string) => ({ guildId, manual: null }),
    getActivatedProviders: () => ({ dummy: { defaultEnabled: false } }),
  },
  dummy: {
    adminListVariants: () => [],
    adminSetProduct: () => undefined,
    adminDeleteProduct: () => true,
    adminListCoupons: () => [],
    adminSetCoupon: () => true,
    adminDeleteCoupon: () => true,
  },
}));

vi.mock('../../src/bot/internalSetup/utils/premiumManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/premiumManager')>();
  return { ...real, getPremiumManager: () => h.pm };
});
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  return {
    ...real,
    getPaymentRegistry: () => ({
      get: (id: string) => (id === 'dummy' ? h.dummy : undefined),
      listAll: () => [],
    }),
  };
});

import { createAppStoreRoutes } from '../../src/webui/routes/appstore';

type Sent = { status: number; body: any };

function fakeRes() {
  const sent: Sent[] = [];
  let code = 200;
  const res: any = {
    headersSent: false,
    status(c: number) { code = c; return res; },
    json(body: unknown) {
      if (res.headersSent) throw new Error('Cannot set headers after they are sent to the client');
      res.headersSent = true;
      sent.push({ status: code, body });
      return res;
    },
  };
  return { res, sent };
}

function botWith(runSharedOp: (op: string, args: any) => Promise<any>) {
  const ops: Array<{ op: string; args: any }> = [];
  const bot: any = {
    runSharedOp: (op: string, args: any) => { ops.push({ op, args }); return runSharedOp(op, args); },
    migrationRunning: () => null,
  };
  return { bot, ops };
}

async function run(bot: any, method: string, routePath: string, params: Record<string, string>, body: unknown) {
  const router: any = createAppStoreRoutes(bot);
  const layer = router.stack.find((l: any) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`no route ${method} ${routePath}`);
  const { res, sent } = fakeRes();
  let threw: unknown;
  try {
    await layer.route.stack[0].handle({ params, body, query: {} }, res, () => undefined);
  } catch (e) {
    threw = e;
  }
  return { sent, threw };
}

interface Route { name: string; method: string; path: string; params: Record<string, string>; body: unknown; catchStatus: number }

const ROUTES: Route[] = [
  { name: 'PUT Dummy product', method: 'put', path: '/premium/providers/dummy/products/:productId', params: { productId: 'p1' }, body: { label: 'Gold' }, catchStatus: 500 },
  { name: 'DELETE Dummy product', method: 'delete', path: '/premium/providers/dummy/products/:productId', params: { productId: 'p1' }, body: {}, catchStatus: 500 },
  { name: 'PUT Dummy coupon', method: 'put', path: '/premium/providers/dummy/coupons/:code', params: { code: 'SAVE' }, body: { percentOff: 10 }, catchStatus: 500 },
  { name: 'DELETE Dummy coupon', method: 'delete', path: '/premium/providers/dummy/coupons/:code', params: { code: 'SAVE' }, body: {}, catchStatus: 500 },
  { name: 'POST manual grant', method: 'post', path: '/premium/subscriptions/:guildId/manual', params: { guildId: 'g1' }, body: { tierId: 'gold', durationDays: 30 }, catchStatus: 500 },
  { name: 'POST manual extend', method: 'post', path: '/premium/subscriptions/:guildId/manual/extend', params: { guildId: 'g1' }, body: { addDays: 5 }, catchStatus: 500 },
  { name: 'DELETE manual', method: 'delete', path: '/premium/subscriptions/:guildId/manual', params: { guildId: 'g1' }, body: {}, catchStatus: 500 },
  { name: 'POST paid', method: 'post', path: '/premium/subscriptions/:guildId/paid', params: { guildId: 'g1' }, body: { tierId: 'gold', offeringId: 'o1', providerId: 'dummy', variantId: 'v1' }, catchStatus: 500 },
  { name: 'DELETE paid', method: 'delete', path: '/premium/subscriptions/:guildId/paid', params: { guildId: 'g1' }, body: {}, catchStatus: 500 },
  { name: 'POST paid reactivate', method: 'post', path: '/premium/subscriptions/:guildId/paid/reactivate', params: { guildId: 'g1' }, body: {}, catchStatus: 500 },
  {
    name: 'POST migration',
    method: 'post',
    path: '/premium/migrations',
    params: {},
    body: {
      providerId: 'dummy', sourceTierId: 'a', sourceOfferingId: 'b', sourceVariantId: 'c',
      targetTierId: 'd', targetOfferingId: 'e', targetVariantId: 'f', effectiveDate: '2026-12-01T00:00:00.000Z',
    },
    catchStatus: 400,
  },
  { name: 'DELETE migration', method: 'delete', path: '/premium/migrations/:migrationId', params: { migrationId: 'm1' }, body: {}, catchStatus: 500 },
  { name: 'PUT silence policy', method: 'put', path: '/premium/migration-silence-policy', params: {}, body: { policy: 'cancel' }, catchStatus: 500 },
  { name: 'PUT provider activation', method: 'put', path: '/premium/providers/:providerId/activation', params: { providerId: 'dummy' }, body: { activated: true }, catchStatus: 500 },
];

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('NB10 App Store shared-op routes answer a bot refusal once', () => {
  for (const r of ROUTES) {
    it(`${r.name}: a bot-down refusal is answered as 503 and nothing more is sent`, async () => {
      const { bot, ops } = botWith(async () => ({ ok: false, code: 'bot-down' }));
      const { sent, threw } = await run(bot, r.method, r.path, r.params, r.body);
      expect(ops.length).toBe(1);
      expect(threw).toBeUndefined();
      expect(sent).toEqual([{ status: 503, body: { success: false, error: 'the bot process is not running' } }]);
    });
  }
});

describe('NB10 App Store shared-op routes answer an op that throws', () => {
  for (const r of ROUTES) {
    it(`${r.name}: a thrown error is answered with its message`, async () => {
      const { bot } = botWith(async () => { throw new Error('the IPC channel closed'); });
      const { sent, threw } = await run(bot, r.method, r.path, r.params, r.body);
      expect(threw).toBeUndefined();
      expect(sent).toEqual([{ status: r.catchStatus, body: { success: false, error: 'the IPC channel closed' } }]);
    });
  }
});

describe('NB10 manual grant passes the notes on only when they are text', () => {
  const grant = async (body: Record<string, unknown>) => {
    const { bot, ops } = botWith(async () => ({ ok: true, result: true }));
    const { sent } = await run(bot, 'post', '/premium/subscriptions/:guildId/manual', { guildId: 'g1' }, { tierId: 'gold', durationDays: 30, ...body });
    expect(sent).toEqual([{ status: 200, body: { success: true, subscriptions: { guildId: 'g1', manual: null } } }]);
    return ops;
  };

  it('text notes reach premium.grantManual as given', async () => {
    const ops = await grant({ notes: 'paid by bank transfer' });
    expect(ops).toStrictEqual([{ op: 'premium.grantManual', args: { args: ['g1', 'gold', 30, 'paid by bank transfer'] } }]);
  });

  it('notes that are not text reach premium.grantManual as undefined', async () => {
    const ops = await grant({ notes: 42 });
    expect(ops).toStrictEqual([{ op: 'premium.grantManual', args: { args: ['g1', 'gold', 30, undefined] } }]);
  });
});
