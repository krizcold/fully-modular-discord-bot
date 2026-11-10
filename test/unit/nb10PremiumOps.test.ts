import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 test 10: the premium and Dummy routes send their change to the child as one shared:op while it runs, and the
// web UI process writes neither premium-tiers.json nor the Dummy state; with no child the op runs in the local chain;
// a child that has not reported answers 503 starting. The operator routes of decision 9 and every guild subscription
// route (mounted behind a stand-in session that admits the guild's owner) are each a row.

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
const dummy = vi.hoisted(() => ({
  id: 'dummy',
  adminListVariants: () => [], adminSetVariant: vi.fn(), adminDeleteVariant: vi.fn(() => true),
  adminListProducts: () => [], adminSetProduct: vi.fn(), adminDeleteProduct: vi.fn(() => true),
  adminListCoupons: () => [], adminSetCoupon: vi.fn(), adminDeleteCoupon: vi.fn(() => true),
}));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));
vi.mock('../../src/webui/auth/oauthMiddleware', async orig => ({
  ...(await orig<any>()),
  requireOAuth: (req: any, _res: any, next: () => void) => { req.user = { id: 'owner1' }; next(); },
  requireGuildAccess: (_req: any, _res: any, next: () => void) => next(),
}));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => ({
  ...(await orig<any>()),
  getPaymentRegistry: () => ({
    on: () => undefined, off: () => undefined, list: () => [dummy], startTickers: () => undefined, emitEvent: () => undefined,
    get: (id: string) => (id === 'dummy' ? dummy : undefined),
  }),
}));

import { BotManager, inLocalOp, ROUTE_TEXT } from '../../src/webui/botManager';
import { createAppStoreRoutes } from '../../src/webui/routes/appstore';
import { createGuildSubscriptionRoutes } from '../../src/webui/routes/guildSubscriptions';
import { shaOfRaw } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { flushAll, setSharedWriteGate } from '../../src/bot/internalSetup/utils/dataManager';
import { dataPath } from '../../src/utils/dataRoot';
import { forks } from '../helpers/forkMock';
import { call, put, readJson, startApp } from '../helpers/configRig';
import { answering, exitChild, freshWriterLock, quiet, resetForks, sentTo, startedWith } from '../helpers/nb10Rig';

const G = '123456789012345678';
const TIERS = () => dataPath('global', 'premium-tiers.json');
const DUMMY_STATE = () => dataPath('global', 'payment-providers', 'dummy', 'state.json');
const DUMMY_SEED = { variants: {}, products: {}, coupons: {}, subscriptions: {}, nextId: 1 };
const SEED = { tiers: { gold: { id: 'gold', displayName: 'Gold', priority: 10, overrides: {}, offerings: [] } }, subscriptions: {}, messages: {} };

const MIGRATION = { providerId: 'dummy', sourceTierId: 'gold', sourceOfferingId: 'o1', sourceVariantId: 'v1', targetTierId: 'gold', targetOfferingId: 'o1', targetVariantId: 'v2', effectiveDate: '2099-01-01T00:00:00.000Z' };

type Row = [string, 'PUT' | 'POST' | 'DELETE', string, object | undefined, string, unknown[]];
const rows: Row[] = [
  ['set a tier', 'PUT', '/premium/tiers/gold', { displayName: 'Gold 2', priority: 11 }, 'premium.setTier', ['gold', expect.objectContaining({ displayName: 'Gold 2', priority: 11 })]],
  ['delete a tier', 'DELETE', '/premium/tiers/gold', undefined, 'premium.deleteTier', ['gold']],
  ['set messages', 'PUT', '/premium/messages', { moduleBlocked: 'nb10 blocked' }, 'premium.setMessages', [{ moduleBlocked: 'nb10 blocked' }]],
  ['reset messages', 'POST', '/premium/messages/reset', {}, 'premium.resetMessages', []],
  ['grant a manual subscription', 'POST', `/premium/subscriptions/${G}/manual`, { tierId: 'gold', durationDays: 30 }, 'premium.grantManual', [G, 'gold', 30, undefined]],
  ['revoke a manual subscription', 'DELETE', `/premium/subscriptions/${G}/manual`, undefined, 'premium.revokeManual', [G]],
  ['set a Dummy variant', 'PUT', '/premium/providers/dummy/variants/v1', { label: 'V1', amount: 5, currency: 'USD' }, 'dummy.adminSetVariant', [expect.objectContaining({ variantId: 'v1', label: 'V1', amount: 5, currency: 'USD' })]],
  ['delete a Dummy variant', 'DELETE', '/premium/providers/dummy/variants/v1', undefined, 'dummy.adminDeleteVariant', ['v1']],
  ['activate a provider', 'PUT', '/premium/providers/dummy/activation', { activated: true }, 'premium.setProviderActivation', ['dummy', true, false]],
  ['set a Dummy product', 'PUT', '/premium/providers/dummy/products/p1', { label: 'P', variantIds: ['v1'] }, 'dummy.adminSetProduct', [{ productId: 'p1', label: 'P', variantIds: ['v1'] }]],
  ['delete a Dummy product', 'DELETE', '/premium/providers/dummy/products/p1', undefined, 'dummy.adminDeleteProduct', ['p1']],
  ['set a Dummy coupon', 'PUT', '/premium/providers/dummy/coupons/C1', { percentOff: 10 }, 'dummy.adminSetCoupon', [expect.objectContaining({ code: 'C1', percentOff: 10, usedCount: 0 })]],
  ['delete a Dummy coupon', 'DELETE', '/premium/providers/dummy/coupons/C1', undefined, 'dummy.adminDeleteCoupon', ['C1']],
  ['extend a manual subscription', 'POST', `/premium/subscriptions/${G}/manual/extend`, { addDays: 5 }, 'premium.extendManual', [G, 5]],
  ['start a paid subscription', 'POST', `/premium/subscriptions/${G}/paid`, { tierId: 'gold', offeringId: 'o1', providerId: 'dummy', variantId: 'v1' }, 'premium.initiatePaidSubscription', [G, 'gold', 'o1', { providerId: 'dummy', variantId: 'v1' }]],
  ['cancel a paid subscription', 'DELETE', `/premium/subscriptions/${G}/paid`, undefined, 'premium.cancelPaidSubscription', [G]],
  ['reactivate a paid subscription', 'POST', `/premium/subscriptions/${G}/paid/reactivate`, {}, 'premium.reactivatePaidSubscription', [G]],
  ['schedule a migration', 'POST', '/premium/migrations', MIGRATION, 'premium.scheduleMigration', [{ ...MIGRATION, message: '', scheduledBy: 'admin' }]],
  ['cancel a migration', 'DELETE', '/premium/migrations/m1', undefined, 'premium.cancelMigration', ['m1']],
  ['set the migration silence policy', 'PUT', '/premium/migration-silence-policy', { policy: 'continue' }, 'premium.setMigrationSilencePolicy', ['continue']],
];

const guildRows: Row[] = [
  ['start a paid subscription', 'POST', `/${G}/paid`, { tierId: 'gold', offeringId: 'o1', providerId: 'dummy', variantId: 'v1' }, 'premium.initiatePaidSubscription', [G, 'gold', 'o1', { providerId: 'dummy', variantId: 'v1', userId: 'owner1', autoRenewOptOut: false }]],
  ['cancel a paid subscription', 'DELETE', `/${G}/paid`, undefined, 'premium.cancelPaidSubscription', [G]],
  ['reactivate a paid subscription', 'POST', `/${G}/paid/reactivate`, {}, 'premium.reactivatePaidSubscription', [G]],
  ['expire a paid subscription now', 'POST', `/${G}/paid/expire-now`, {}, 'premium.cancelPaidSubscriptionImmediately', [G]],
  ['adopt an orphan', 'POST', `/${G}/orphans/dummy/os1/adopt`, { plan: { kind: 'install' } }, 'premium.adoptOrphan', [G, 'dummy', 'os1', { kind: 'install' }]],
  ['cancel an orphan', 'DELETE', `/${G}/orphans/dummy/os1`, undefined, 'premium.cancelOrphan', ['dummy', 'os1']],
  ['remove a paused subscription', 'DELETE', `/${G}/paused/s1`, undefined, 'premium.cancelAndRemovePausedSubscription', [G, 's1']],
  ['unlink a provider account', 'DELETE', `/${G}/provider-links/patreon`, undefined, 'premium.unlinkProviderAccount', [G, 'patreon']],
  ['record a migration decision', 'PUT', `/${G}/migrations/m1`, { decision: 'accepted' }, 'premium.recordMigrationDecision', ['m1', G, 'accepted']],
  ['set the notifications channel', 'PUT', `/${G}/notifications-channel`, { channelId: '223456789012345678' }, 'premium.setNotificationsChannelId', [G, '223456789012345678']],
];

let app: { url: string; close: () => Promise<void> } | null = null;
async function mount(manager: BotManager): Promise<string> {
  app = await startApp(a => {
    a.use('/api/appstore', createAppStoreRoutes(manager));
    a.use('/api/guild-subscriptions', createGuildSubscriptionRoutes(manager));
  });
  return app.url;
}

const dummyWrites = () => Object.entries(dummy).filter(([name, fn]) => /^admin(Set|Delete)/.test(name) && vi.isMockFunction(fn) && (fn as any).mock.calls.length > 0).map(([name]) => name);

async function sendsOneOp(prefix: string, method: string, route: string, body: object | undefined, op: string, args: unknown[]): Promise<void> {
  const before = fs.readFileSync(TIERS(), 'utf8');
  const dummyBefore = fs.readFileSync(DUMMY_STATE(), 'utf8');
  const { manager, child } = await startedWith([{ stage: 'shared' }]);
  answering(child, m => (m.type === 'shared:op' ? { ok: true, result: true } : undefined));
  const base = await mount(manager);
  const reply = await call(base, method as any, `${prefix}${route}`, body);
  expect(reply.status).toBe(200);
  const ops = sentTo(child, 'shared:op');
  expect(ops).toHaveLength(1);
  expect(ops[0].data.op).toBe(op);
  expect(ops[0].data.args).toEqual({ args });
  await flushAll();
  expect(fs.readFileSync(TIERS(), 'utf8')).toBe(before);
  expect(fs.readFileSync(DUMMY_STATE(), 'utf8')).toBe(dummyBefore);
  expect(dummyWrites()).toEqual([]);
}


beforeEach(async () => {
  quiet();
  resetForks();
  freshWriterLock('webui');
  setSharedWriteGate(() => inLocalOp());
  await flushAll();
  put(TIERS(), SEED);
  put(DUMMY_STATE(), DUMMY_SEED);
  for (const fn of Object.values(dummy)) if (vi.isMockFunction(fn)) fn.mockClear();
});

afterEach(async () => {
  await app?.close();
  app = null;
  setSharedWriteGate(null);
  for (const child of forks.children) if (child.exitCode === null) exitChild(child);
  vi.restoreAllMocks();
});

describe('a child at shared', () => {
  it.each(rows)('%s sends one shared:op and the web UI writes nothing', async (_name, method, route, body, op, args) => {
    await sendsOneOp('/api/appstore', method, route, body, op, args);
  });

  it.each(guildRows)('the guild owner route to %s sends one shared:op and the web UI writes nothing', async (_name, method, route, body, op, args) => {
    await sendsOneOp('/api/guild-subscriptions', method, route, body, op, args);
  });

  it('the global module config save sends one premium.setGlobalModuleConfig built on the served read, and the web UI writes nothing', async () => {
    const settings = dataPath('global', 'nb10mod', 'settings.json');
    fs.rmSync(settings, { force: true });
    const before = fs.readFileSync(TIERS(), 'utf8');
    const { manager, child } = await startedWith([{ stage: 'shared' }]);
    answering(child, m => (m.type === 'shared:op' ? { ok: true, result: true } : m.type === 'data:global-read' ? { ok: true } : undefined));
    const base = await mount(manager);
    const reply = await call(base, 'PUT', '/api/appstore/global-config/nb10mod', { moduleEnabled: false });
    expect(reply.status).toBe(200);
    const ops = sentTo(child, 'shared:op');
    expect(ops).toHaveLength(1);
    expect(ops[0].data).toEqual({
      op: 'premium.setGlobalModuleConfig',
      args: { moduleName: 'nb10mod', partial: { moduleEnabled: false }, rel: expect.stringContaining('nb10mod'), expectSha: shaOfRaw(null) },
    });
    await flushAll();
    expect(fs.existsSync(settings)).toBe(false);
    expect(fs.readFileSync(TIERS(), 'utf8')).toBe(before);
  });

  it('a not-ok child answer reaches the client as its error text', async () => {
    const { manager, child } = await startedWith([{ stage: 'shared' }]);
    answering(child, () => ({ ok: false, code: 'failed', error: 'premium-tiers.json cannot be read (EIO); nothing was saved.' }));
    const base = await mount(manager);
    const reply = await call(base, 'PUT', '/api/appstore/premium/messages', { moduleBlocked: 'x' });
    expect(reply.body).toMatchObject({ success: false, error: 'premium-tiers.json cannot be read (EIO); nothing was saved.' });
    expect(reply.status).toBeGreaterThanOrEqual(400);
  });
});

describe('with no child', () => {
  it('a premium op runs in the local chain and premium-tiers.json holds the change once the route answered', async () => {
    const base = await mount(new BotManager());
    const reply = await call(base, 'PUT', '/api/appstore/premium/messages', { moduleBlocked: 'nb10 local' });
    expect(reply.status).toBe(200);
    expect(readJson(TIERS()).messages).toMatchObject({ moduleBlocked: 'nb10 local' });
    expect(fs.existsSync(dataPath('.writer.lock'))).toBe(false);
  });
});

describe('a child that has not reported', () => {
  it('answers 503 with the starting text and sends nothing', async () => {
    const before = fs.readFileSync(TIERS(), 'utf8');
    const { manager, child } = await startedWith([]);
    answering(child, () => ({ ok: true }));
    const base = await mount(manager);
    const reply = await call(base, 'PUT', '/api/appstore/premium/messages', { moduleBlocked: 'x' });
    expect(reply).toMatchObject({ status: 503, body: { success: false, error: ROUTE_TEXT.starting } });
    expect(sentTo(child)).toEqual([]);
    expect(fs.readFileSync(TIERS(), 'utf8')).toBe(before);
  });
});
