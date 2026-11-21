import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P1 claim 19: the App Store's premium routes, called as rt2AppStoreRoutes.test.ts calls them (the route's handler
// with a request and a recording response), over the real manager; every op the routes send runs through
// applySharedOp. Part 1 holds the tier rows.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());
vi.mock('../../src/bot/internalSetup/utils/appStoreManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/appStoreManager')>();
  const store = { getCachedModules: () => [], getRepositories: () => [], getInstalledModules: () => [], getAvailableModules: async () => [] };
  return { ...real, getAppStoreManager: () => store };
});
vi.mock('../../src/bot/internalSetup/utils/settings/settingsDiscovery', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/settings/settingsDiscovery')>();
  const schema = { settings: { count: { type: 'number', label: 'Count', default: 5, validation: { min: 1, max: 100 } } } };
  return { ...real, getSettingsSchema: (name: string) => (name === 'p1schema' ? schema : real.getSettingsSchema(name)) };
});

import { createAppStoreRoutes } from '../../src/webui/routes/appstore';
import { createGuildSubscriptionRoutes } from '../../src/webui/routes/guildSubscriptions';
import { gh, uh } from '../helpers/p1Holder';
import { BUYER, p1World, SELLER_ID, SELLER_VARIANT, SERVERS, USERS } from '../helpers/p1World';

const w = p1World();
let ops: Array<{ op: string; args: any }> = [];
const botManager: any = {
  storeDocsFirst: async () => null,
  migrationRunning: () => null,
  isRunning: () => false,
  listLoadedModules: async () => null,
  runSharedOp: async (op: string, args: unknown) => {
    ops.push({ op, args });
    return w.sharedOp(op, args);
  },
};

async function call(method: string, routePath: string, params: Record<string, string> = {}, body: unknown = {}, query: Record<string, string> = {}) {
  const router: any = createAppStoreRoutes(botManager);
  const layer = router.stack.find((l: any) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`no route ${method} ${routePath}`);
  const sent: Array<{ status: number; body: any }> = [];
  let code = 200;
  const res: any = {
    status(c: number) { code = c; return res; },
    json(payload: unknown) { sent.push({ status: code, body: payload }); return res; },
  };
  await layer.route.stack[0].handle({ params, body, query }, res, () => undefined);
  return sent;
}

const tierBody = (displayName: string, priority: number, more: Record<string, unknown> = {}) => ({ displayName, priority, overrides: {}, offerings: [], ...more });

beforeEach(async () => {
  await w.setup();
  ops = [];
});
afterEach(async () => { await w.teardown(); });

describe('P1 claim 19: the tier routes', () => {
  it("the tier PUT stores kind 'user', and stores no kind for 'guild' or for none", async () => {
    const user = await call('put', '/premium/tiers/:id', { id: 'vip' }, tierBody('VIP', 2, { kind: 'user' }));
    const server = await call('put', '/premium/tiers/:id', { id: 'plain' }, tierBody('Plain', 4, { kind: 'guild' }));
    const none = await call('put', '/premium/tiers/:id', { id: 'bare' }, tierBody('Bare', 5));

    expect([user, server, none].map(sent => sent.map(s => [s.status, s.body.success]))).toEqual([[[200, true]], [[200, true]], [[200, true]]]);
    expect(ops.map(o => o.op)).toEqual(['premium.setTier', 'premium.setTier', 'premium.setTier']);
    expect(w.stored().tiers.vip).toStrictEqual({ displayName: 'VIP', priority: 2, overrides: {}, offerings: [], kind: 'user' });
    expect(w.stored().tiers.plain).toStrictEqual({ displayName: 'Plain', priority: 4, overrides: {}, offerings: [] });
    expect(w.stored().tiers.bare).toStrictEqual({ displayName: 'Bare', priority: 5, overrides: {}, offerings: [] });
  });

  it.each([['vip'], ['User'], [''], [5], [null], [['user']]])('the tier PUT refuses kind %j with 400 and sends no op', async kind => {
    const before = JSON.stringify(w.stored());
    const sent = await call('put', '/premium/tiers/:id', { id: 'vip' }, tierBody('VIP', 2, { kind }));

    expect(sent).toEqual([{ status: 400, body: { success: false, error: "kind must be 'user' or 'guild'" } }]);
    expect(ops).toEqual([]);
    expect(JSON.stringify(w.stored())).toBe(before);
  });

  it("the tier PUT answers the manager's refusal of a changed kind and of a user tier's server switch, and stores nothing", async () => {
    await call('put', '/premium/tiers/:id', { id: 'vip' }, tierBody('VIP', 2, { kind: 'user' }));
    const before = JSON.stringify(w.stored());

    const changed = await call('put', '/premium/tiers/:id', { id: 'vip' }, tierBody('VIP', 2));
    const switched = await call('put', '/premium/tiers/:id', { id: 'vip' }, tierBody('VIP', 2, { kind: 'user', overrides: { p1mod: { _moduleEnabled: false } } }));

    expect(changed).toHaveLength(1);
    expect(changed[0].status).toBeGreaterThanOrEqual(400);
    expect(changed[0].body.success).toBe(false);
    expect(changed[0].body.error).toContain("A tier's kind cannot be changed: 'VIP' is a user tier. Make a new tier.");
    expect(switched).toHaveLength(1);
    expect(switched[0].status).toBeGreaterThanOrEqual(400);
    expect(switched[0].body.success).toBe(false);
    expect(switched[0].body.error).toContain('A user tier cannot set _moduleEnabled for p1mod: module switches, command switches and limits belong to server tiers.');
    expect(JSON.stringify(w.stored())).toBe(before);
  });

  it("the tier PUT checks a user tier's values against the module's schema alone: no Free limit, no key left out", async () => {
    expect(await w.setGlobal('p1schema', { hardLimits: { count: { max: 10 } } })).toBe(true);

    const server = await call('put', '/premium/tiers/:id', { id: 'plain' }, tierBody('Plain', 4, { overrides: { p1schema: { count: 50 } } }));
    const user = await call('put', '/premium/tiers/:id', { id: 'vip' }, tierBody('VIP', 2, { kind: 'user', overrides: { p1schema: { count: 50, extra: 'kept' } } }));
    const outside = await call('put', '/premium/tiers/:id', { id: 'vip2' }, tierBody('VIP 2', 3, { kind: 'user', overrides: { p1schema: { count: 500 } } }));

    expect(server.map(s => s.status)).toEqual([400]);
    expect(server[0].body.error).toMatch(/^Not saved: p1schema\.count: /);
    expect(user.map(s => [s.status, s.body.success])).toEqual([[200, true]]);
    expect(outside.map(s => s.status)).toEqual([400]);
    expect(outside[0].body.error).toMatch(/^Not saved: p1schema\.count: /);
    expect(w.stored().tiers.vip.overrides).toStrictEqual({ p1schema: { count: 50, extra: 'kept' } });
    expect(w.stored().tiers.plain).toBeUndefined();
    expect(w.stored().tiers.vip2).toBeUndefined();
  });

  it('GET /premium/tiers answers the server tiers in `tiers` and the user tiers in `userTiers`', async () => {
    await call('put', '/premium/tiers/:id', { id: 'vip' }, tierBody('VIP', 2, { kind: 'user', overrides: { p1mod: { a: 1 } } }));

    const sent = await call('get', '/premium/tiers');

    expect(sent).toHaveLength(1);
    expect(sent[0].status).toBe(200);
    expect(Object.keys(sent[0].body).sort()).toEqual(['success', 'tiers', 'userTiers']);
    expect(Object.keys(sent[0].body.tiers).sort()).toEqual(['alt', 'free', 'high', 'low', 'mid']);
    expect(sent[0].body.tiers.low).toEqual(w.stored().tiers.low);
    expect(sent[0].body.userTiers).toStrictEqual({ vip: { displayName: 'VIP', priority: 2, overrides: { p1mod: { a: 1 } }, offerings: [], kind: 'user' } });
  });

  it('GET /premium/tiers answers an empty `userTiers` when no user tier exists', async () => {
    const sent = await call('get', '/premium/tiers');
    expect(sent[0].body.userTiers).toStrictEqual({});
    expect(Object.keys(sent[0].body.tiers).sort()).toEqual(['alt', 'free', 'high', 'low', 'mid']);
  });

  it('the overview answers `tiers` without the user tiers and `userTiers` beside it', async () => {
    await call('put', '/premium/tiers/:id', { id: 'vip' }, tierBody('VIP', 2, { kind: 'user' }));

    const sent = await call('get', '/bundle');

    expect(sent).toHaveLength(1);
    expect(sent[0].status).toBe(200);
    expect(Object.keys(sent[0].body.tiers).sort()).toEqual(['alt', 'free', 'high', 'low', 'mid']);
    expect(sent[0].body.userTiers).toStrictEqual({ vip: { displayName: 'VIP', priority: 2, overrides: {}, offerings: [], kind: 'user' } });
  });
});

// Part 3: the rows that are not about tiers. One server and one user hold a subscription; the server's routes are
// called through their last handler (the two before it check who is signed in, which P8 changes, not P1).

const S = SERVERS[0];
const U = USERS[0];
const DEV_ID_ROUTES: Array<[string, string, unknown]> = [
  ['get', '/premium/subscriptions/:guildId', {}],
  ['post', '/premium/subscriptions/:guildId/manual', { tierId: 'low', durationDays: 30 }],
  ['post', '/premium/subscriptions/:guildId/manual/extend', { addDays: 5 }],
  ['delete', '/premium/subscriptions/:guildId/manual', {}],
  ['post', '/premium/subscriptions/:guildId/paid', { tierId: 'low', offeringId: 'o-low', providerId: SELLER_ID, variantId: SELLER_VARIANT, buyerId: BUYER }],
  ['delete', '/premium/subscriptions/:guildId/paid', {}],
  ['post', '/premium/subscriptions/:guildId/paid/reactivate', {}],
];

async function callServerPage(method: string, routePath: string, params: Record<string, string>, body: unknown = {}, user: unknown = { id: BUYER }) {
  const router: any = createGuildSubscriptionRoutes(botManager);
  const layer = router.stack.find((l: any) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`no route ${method} ${routePath}`);
  const sent: Array<{ status: number; body: any }> = [];
  let code = 200;
  const res: any = {
    status(c: number) { code = c; return res; },
    json(payload: unknown) { sent.push({ status: code, body: payload }); return res; },
  };
  const handlers = layer.route.stack;
  await handlers[handlers.length - 1].handle({ params, body, query: {}, user, protocol: 'https', get: () => 'bot.example' }, res, () => undefined);
  return sent;
}

describe('P1 claim 19, part 3: the subscription routes', () => {
  beforeEach(async () => {
    await w.addUserTiers();
    expect((await w.grant(gh(S), 'mid', 30)).ok).toBe(true);
    expect((await w.grant(uh(U), 'ulow', null)).ok).toBe(true);
    ops = [];
  });

  it("the server page's `tiers` has no user tier and its `subscriptions` is the server's record", async () => {
    const sent = await callServerPage('get', '/:guildId', { guildId: S });

    expect(sent).toHaveLength(1);
    expect(sent[0].status).toBe(200);
    expect(Object.keys(sent[0].body).sort()).toEqual(['effective', 'providers', 'subscriptions', 'success', 'tiers']);
    expect(Object.keys(sent[0].body.tiers).sort()).toEqual(['alt', 'free', 'high', 'low', 'mid']);
    expect(sent[0].body.subscriptions).toEqual(w.recordOf(S));
    expect(Object.keys(sent[0].body.subscriptions).sort()).toEqual(['active', 'paused']);
    expect(sent[0].body.effective.tierId).toBe('mid');
  });

  it("the server page of a server whose id is a user's shows no subscription of that user", async () => {
    const sent = await callServerPage('get', '/:guildId', { guildId: U });
    expect(sent[0].body.subscriptions).toEqual({ paused: [] });
    expect(sent[0].body.effective.tierId).toBe('free');
  });

  it("the server page's purchase passes the signed-in user as the buyer and stores it", async () => {
    const sent = await callServerPage('post', '/:guildId/paid', { guildId: SERVERS[1] }, { tierId: 'low', offeringId: 'o-low', providerId: SELLER_ID, variantId: SELLER_VARIANT }, { id: BUYER });

    expect(sent.map(s => [s.status, s.body.success])).toEqual([[200, true]]);
    expect(ops).toEqual([{ op: 'premium.initiatePaidSubscription', args: { args: [gh(SERVERS[1]), 'low', 'o-low', { providerId: SELLER_ID, variantId: SELLER_VARIANT, couponCode: undefined, buyerId: BUYER, autoRenewOptOut: false }] } }]);
    expect(w.recordOf(SERVERS[1]).active).toMatchObject({ tierId: 'low', source: 'paid', buyerId: BUYER });
    expect(sent[0].body.subscriptions.active.buyerId).toBe(BUYER);
  });

  it("the server page's migrations list holds the server's own decision by holder", async () => {
    expect((await w.purchase(SERVERS[1], 'low')).ok).toBe(true);
    expect((await w.purchase('70000000000000003', 'low')).ok).toBe(true);
    const scheduled = await w.op('scheduleMigration', {
      providerId: SELLER_ID, sourceTierId: 'low', sourceOfferingId: 'o-low', sourceVariantId: SELLER_VARIANT,
      targetTierId: 'mid', targetOfferingId: 'o-mid', targetVariantId: SELLER_VARIANT,
      effectiveDate: new Date(Date.now() + 3_600_000).toISOString(), message: 'm',
    });
    expect(scheduled.ok).toBe(true);
    ops = [];

    const listed = await callServerPage('get', '/:guildId/migrations', { guildId: SERVERS[1] });
    const decided = await callServerPage('put', '/:guildId/migrations/:migrationId', { guildId: SERVERS[1], migrationId: scheduled.result.id }, { decision: 'accepted' });

    expect(listed[0].body.migrations.map((m: any) => m.decisions.map((d: any) => d.holder))).toEqual([[gh(SERVERS[1])]]);
    expect(decided).toEqual([{ status: 200, body: { success: true } }]);
    expect(ops).toEqual([{ op: 'premium.recordMigrationDecision', args: { args: [scheduled.result.id, gh(SERVERS[1]), 'accepted'] } }]);
    expect(w.stored().migrations[0].decisions.map((d: any) => [d.holder, d.decision])).toEqual([[gh(SERVERS[1]), 'accepted'], [gh('70000000000000003'), 'pending']]);
  });

  it('the dev lists key `subscriptions` by the bare server id and `userSubscriptions` by the bare user id', async () => {
    const list = await call('get', '/premium/subscriptions');
    const overview = await call('get', '/bundle');

    expect(list).toHaveLength(1);
    expect(Object.keys(list[0].body).sort()).toEqual(['subscriptions', 'success', 'userSubscriptions']);
    expect(list[0].body.subscriptions).toEqual({ [S]: w.recordOf(gh(S)) });
    expect(list[0].body.userSubscriptions).toEqual({ [U]: w.recordOf(uh(U)) });
    expect(overview[0].body.subscriptions).toEqual({ [S]: w.recordOf(gh(S)) });
    expect(overview[0].body.userSubscriptions).toEqual({ [U]: w.recordOf(uh(U)) });
    expect(Object.keys(overview[0].body.tiers).sort()).toEqual(['alt', 'free', 'high', 'low', 'mid']);
    expect(Object.keys(overview[0].body.userTiers).sort()).toEqual(['ualt', 'uhigh', 'ulow', 'umid']);
  });

  it("the dev route of one server answers that server's record and effective tier", async () => {
    const sent = await call('get', '/premium/subscriptions/:guildId', { guildId: S });
    expect(sent.map(s => s.status)).toEqual([200]);
    expect(sent[0].body.subscriptions).toEqual(w.recordOf(S));
    expect(sent[0].body.effective.tierId).toBe('mid');
  });

  it.each(DEV_ID_ROUTES.flatMap(([method, route, body]) => ['abc', 'guild:5', '05', ''].map(id => [method, route, id, body] as const)))('%s %s with the id %j answers 400 and calls no op', async (method, route, id, body) => {
    const before = w.storedText();
    const sent = await call(method, route, { guildId: id }, body);

    expect(sent).toEqual([{ status: 400, body: { success: false, error: 'Invalid server id' } }]);
    expect(ops).toEqual([]);
    expect(w.storedText()).toBe(before);
  });

  it.each([[undefined], [''], ['abc'], [5]])('the dev purchase with the buyerId %j answers 400 and calls no op', async buyerId => {
    const before = w.storedText();
    const sent = await call('post', '/premium/subscriptions/:guildId/paid', { guildId: SERVERS[1] }, { tierId: 'low', offeringId: 'o-low', providerId: SELLER_ID, variantId: SELLER_VARIANT, ...(buyerId === undefined ? {} : { buyerId }) });

    expect(sent).toHaveLength(1);
    expect(sent[0].status).toBe(400);
    expect(sent[0].body.success).toBe(false);
    expect(ops).toEqual([]);
    expect(w.calls()).toEqual([]);
    expect(w.storedText()).toBe(before);
  });

  it('the dev purchase with a buyerId sends it in the op and the subscription stores it', async () => {
    const sent = await call('post', '/premium/subscriptions/:guildId/paid', { guildId: SERVERS[1] }, { tierId: 'low', offeringId: 'o-low', providerId: SELLER_ID, variantId: SELLER_VARIANT, buyerId: BUYER });

    expect(sent.map(s => [s.status, s.body.success])).toEqual([[200, true]]);
    expect(ops.map(o => [o.op, o.args.args[0], o.args.args[3].buyerId, 'userId' in o.args.args[3]])).toEqual([['premium.initiatePaidSubscription', gh(SERVERS[1]), BUYER, false]]);
    expect(w.recordOf(SERVERS[1]).active.buyerId).toBe(BUYER);
  });

  it("the server's manual routes send the server's holder", async () => {
    await call('post', '/premium/subscriptions/:guildId/manual', { guildId: SERVERS[1] }, { tierId: 'low', durationDays: 30 });
    await call('post', '/premium/subscriptions/:guildId/manual/extend', { guildId: SERVERS[1] }, { addDays: 5 });
    const revoked = await call('delete', '/premium/subscriptions/:guildId/manual', { guildId: SERVERS[1] });

    expect(ops.map(o => [o.op, o.args.args[0]])).toEqual([
      ['premium.grantManual', gh(SERVERS[1])], ['premium.extendManual', gh(SERVERS[1])], ['premium.revokeManual', gh(SERVERS[1])],
    ]);
    expect(revoked[0].body).toEqual({ success: true, subscriptions: { paused: [] } });
    expect(w.recordOf(SERVERS[1])).toBeNull();
  });

  it('the three user manual routes grant, extend and revoke through the op', async () => {
    const other = USERS[1];
    const granted = await call('post', '/premium/users/:userId/manual', { userId: other }, { tierId: 'uhigh', durationDays: 10, notes: 'a gift' });
    const endAfterGrant = w.recordOf(uh(other)).active.endDate;
    const extended = await call('post', '/premium/users/:userId/manual/extend', { userId: other }, { addDays: 20 });
    const endAfterExtend = w.recordOf(uh(other)).active.endDate;
    const revoked = await call('delete', '/premium/users/:userId/manual', { userId: other });

    expect(ops).toEqual([
      { op: 'premium.grantManual', args: { args: [uh(other), 'uhigh', 10, 'a gift'] } },
      { op: 'premium.extendManual', args: { args: [uh(other), 20] } },
      { op: 'premium.revokeManual', args: { args: [uh(other)] } },
    ]);
    expect(granted.map(s => [s.status, s.body.success, s.body.subscriptions.active.tierId, s.body.subscriptions.active.notes])).toEqual([[200, true, 'uhigh', 'a gift']]);
    expect(extended.map(s => [s.status, s.body.success])).toEqual([[200, true]]);
    expect(Date.parse(endAfterExtend) - Date.parse(endAfterGrant)).toBe(20 * 86_400_000);
    expect(revoked).toEqual([{ status: 200, body: { success: true, subscriptions: { paused: [] } } }]);
    expect(w.recordOf(uh(other))).toBeNull();
    expect(JSON.stringify(w.recordOf(uh(U)))).toContain('ulow');
  });

  it.each([
    ['post', '/premium/users/:userId/manual', { tierId: 'uhigh', durationDays: 10 }],
    ['post', '/premium/users/:userId/manual/extend', { addDays: 5 }],
    ['delete', '/premium/users/:userId/manual', {}],
  ])('%s %s with a user id that is no Discord id answers 400 and calls no op', async (method, route, body) => {
    const sent = await call(method, route, { userId: 'web-ui-owner' }, body);
    expect(sent).toEqual([{ status: 400, body: { success: false, error: 'Invalid user id' } }]);
    expect(ops).toEqual([]);
  });

  it('a user manual grant of a server tier answers the refusal and stores nothing', async () => {
    const before = w.storedText();
    const sent = await call('post', '/premium/users/:userId/manual', { userId: USERS[1] }, { tierId: 'low', durationDays: 10 });

    expect(sent).toHaveLength(1);
    expect(sent[0].status).toBeGreaterThanOrEqual(400);
    expect(sent[0].body.error).toContain("'LOW' is a server tier and cannot be given to a user.");
    expect(w.storedText()).toBe(before);
  });

  it.each([
    ['get', '/:guildId'],
    ['post', '/:guildId/paid'],
    ['delete', '/:guildId/paid'],
    ['put', '/:guildId/notifications-channel'],
  ])('the server page route %s %s refuses a server id with a leading zero with its 400', async (method, routePath) => {
    const before = w.storedText();
    const sent = await callServerPage(method, routePath, { guildId: '01234567890123456' }, { tierId: 'low', offeringId: 'o-low', providerId: 'p', variantId: 'v', channelId: null });
    expect(sent).toEqual([{ status: 400, body: { success: false, error: 'Invalid guild ID' } }]);
    expect(w.storedText()).toBe(before);
  });

  it("the audit route's guildId=5 returns the lines of guild:5 only, and `holder` filters by the key", async () => {
    expect((await w.grant(gh('5'), 'low', 30)).ok).toBe(true);
    expect((await w.grant(uh('5'), 'ulow', 30)).ok).toBe(true);
    expect((await w.grant(gh('55'), 'low', 30)).ok).toBe(true);

    const byServer = await call('get', '/premium/audit', {}, {}, { guildId: '5' });
    const byUser = await call('get', '/premium/audit', {}, {}, { holder: 'user:5' });
    const byServerKey = await call('get', '/premium/audit', {}, {}, { holder: 'guild:55' });
    const badServer = await call('get', '/premium/audit', {}, {}, { guildId: 'abc' });

    expect(byServer[0].body.entries.map((e: any) => [e.action, e.holder])).toEqual([['subscription.grant.manual', 'guild:5']]);
    expect(byUser[0].body.entries.map((e: any) => [e.action, e.holder])).toEqual([['subscription.grant.manual', 'user:5']]);
    expect(byServerKey[0].body.entries.map((e: any) => e.holder)).toEqual(['guild:55']);
    expect(badServer).toEqual([{ status: 400, body: { success: false, error: 'Invalid server id' } }]);
    for (const holder of ['abc', '5', 'guild:05', 'member:5']) {
      expect(await call('get', '/premium/audit', {}, {}, { holder })).toEqual([{ status: 400, body: { success: false, error: 'Invalid holder: it is guild:<id> or user:<id>' } }]);
    }
  });
});
