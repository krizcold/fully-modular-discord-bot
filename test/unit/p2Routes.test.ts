import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P2 claim 13 (part 3): the nine dev routes for a user, called as p1Routes.test.ts calls the App Store's routes (the
// handler with a request and a recording response), over the real manager and the real DummyProvider on the JSON
// files; every op the routes send runs through applySharedOp.

const inject = vi.hoisted(() => ({ refuse: new Set<string>() }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  const ledger = await import('../../src/bot/internalSetup/utils/dataBackends/writeLedger');
  return {
    ...real,
    saveDataTracked: (f: string, o: any, d: unknown) => {
      if (inject.refuse.has(f)) {
        ledger.recordRefusal('storage-failing', `global:${o.category ?? ''}/${f}`);
        throw new real.DataBackendUnavailableError('storage-failing');
      }
      return real.saveDataTracked(f, o, d);
    },
  };
});
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());
vi.mock('../../src/bot/internalSetup/utils/appStoreManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/appStoreManager')>();
  const store = { getCachedModules: () => [], getRepositories: () => [], getInstalledModules: () => [], getAvailableModules: async () => [] };
  return { ...real, getAppStoreManager: () => store };
});

import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { createAppStoreRoutes } from '../../src/webui/routes/appstore';
import { createGuildSubscriptionRoutes } from '../../src/webui/routes/guildSubscriptions';
import { gh, uh } from '../helpers/p1Holder';
import { BUYER, SERVERS, USERS, p1World } from '../helpers/p1World';
import { DUMMY_VARIANT, dummyDriver, recordView } from '../helpers/p2DummyDriver';

const U = USERS[0];
const V = USERS[1];
/** A record's view and premium's answer, field by field (decision 94's fields). */
const viewFields = (v: any) => ({ status: v.status, endDate: v.endDate, autoRenew: v.autoRenew, variantId: v.variantId, resumesAt: v.resumesAt ?? null });
const X5 = "A user's subscription is paid by that user; the buyer given is someone else.";
const REFUSED = "The bot cannot write to its disk right now, so your change was not saved in full. Can't confirm whether part of it was saved. Reload to check before you try again: trying again could apply a saved part twice. A payment provider call this change made may already have taken effect; check the provider's dashboard.";

let driver = dummyDriver();
let w = p1World('json', driver);
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

async function call(method: string, routePath: string, params: Record<string, string> = {}, body: unknown = {}) {
  const router: any = createAppStoreRoutes(botManager);
  const layer = router.stack.find((l: any) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`no route ${method} ${routePath}`);
  const sent: Array<{ status: number; body: any }> = [];
  let code = 200;
  const res: any = {
    status(c: number) { code = c; return res; },
    json(payload: unknown) { sent.push({ status: code, body: payload }); return res; },
  };
  await layer.route.stack[0].handle({ params, body, query: {} }, res, () => undefined);
  return sent;
}

const buy = (userId: string, tierId: string, more: Record<string, unknown> = {}) =>
  call('post', '/premium/users/:userId/paid', { userId }, { tierId, offeringId: `o-${tierId}`, providerId: 'dummy', variantId: DUMMY_VARIANT, ...more });

beforeEach(async () => {
  driver = dummyDriver();
  w = p1World('json', driver);
  await w.setup();
  await w.addSoldUserTiers();
  ops = [];
});
afterEach(async () => {
  inject.refuse.clear();
  await w.teardown();
  vi.restoreAllMocks();
});

const ROUTES: Array<[string, string, Record<string, string>]> = [
  ['get', '/premium/users/:userId', {}],
  ['post', '/premium/users/:userId/paid', {}],
  ['delete', '/premium/users/:userId/paid', {}],
  ['post', '/premium/users/:userId/paid/reactivate', {}],
  ['post', '/premium/users/:userId/paid/expire-now', {}],
  ['delete', '/premium/users/:userId/paused/:subscriptionId', { subscriptionId: 's1' }],
  ['get', '/premium/users/:userId/orphans', {}],
  ['post', '/premium/users/:userId/orphans/:providerId/:providerSubId/adopt', { providerId: 'dummy', providerSubId: 'dummy_1' }],
  ['delete', '/premium/users/:userId/orphans/:providerId/:providerSubId', { providerId: 'dummy', providerSubId: 'dummy_1' }],
];

describe('P2 claim 13: the dev routes for a user', () => {
  it.each(ROUTES)("%s %s with :userId 'abc' answers 400 Invalid user id and sends no op", async (method, routePath, params) => {
    const before = w.storedText();
    const sent = await call(method, routePath, { userId: 'abc', ...params }, { tierId: 'vlow', offeringId: 'o-vlow', providerId: 'dummy', variantId: DUMMY_VARIANT, plan: {} });
    expect(sent).toEqual([{ status: 400, body: { success: false, error: 'Invalid user id' } }]);
    expect(ops).toEqual([]);
    expect(w.storedText()).toBe(before);
  });

  it('the detail answers effective null for a user with no tier, and the tier once the user holds one', async () => {
    const none = await call('get', '/premium/users/:userId', { userId: U });
    expect(none).toHaveLength(1);
    expect(none[0].status).toBe(200);
    expect(none[0].body.success).toBe(true);
    expect(none[0].body.effective).toBeNull();

    expect((await buy(U, 'vlow'))[0].body.success).toBe(true);
    const held = await call('get', '/premium/users/:userId', { userId: U });
    expect(held[0].body.effective).toMatchObject({ tierId: 'vlow', source: 'paid' });
    expect(held[0].body.effective.tier.displayName).toBe('VLOW');
    expect(held[0].body.subscriptions.active).toMatchObject({ tierId: 'vlow', providerId: 'dummy' });
  });

  it.each([
    ['tierId', 'tierId is required'],
    ['offeringId', 'offeringId is required'],
    ['providerId', 'providerId is required'],
    ['variantId', 'variantId is required'],
  ])('the purchase without %s answers 400 with its text and sends no op', async (field, error) => {
    const body: Record<string, unknown> = { tierId: 'vlow', offeringId: 'o-vlow', providerId: 'dummy', variantId: DUMMY_VARIANT };
    delete body[field];
    const sent = await call('post', '/premium/users/:userId/paid', { userId: U }, body);
    expect(sent).toEqual([{ status: 400, body: { success: false, error } }]);
    expect(ops).toEqual([]);
  });

  it("the purchase with another user as buyerId answers 400 with X5's words and sends no op", async () => {
    const before = driver.bytes();
    const sent = await buy(U, 'vlow', { buyerId: V });
    expect(sent).toEqual([{ status: 400, body: { success: false, error: X5 } }]);
    expect(ops).toEqual([]);
    expect(driver.bytes()).toBe(before);
    expect(w.recordOf(uh(U))).toBeNull();
  });

  it.each([['null', null], ['a number', Number(U)], ['an object', { id: U }], ['an empty string', '']])('the purchase with %s as buyerId answers 400 with its own text and sends no op', async (_label, buyerId) => {
    const before = driver.bytes();
    const sent = await buy(U, 'vlow', { buyerId });
    expect(sent).toEqual([{ status: 400, body: { success: false, error: "buyerId must be the user's Discord id, or left out" } }]);
    expect(ops).toEqual([]);
    expect(driver.bytes()).toBe(before);
  });

  it.each([['no buyerId', undefined], ["the user's own id", U]])('the purchase with %s installs under user:<id> with the user as buyer', async (_label, buyerId) => {
    const sent = await buy(U, 'vlow', buyerId === undefined ? {} : { buyerId });
    expect(sent.map(s => [s.status, s.body.success])).toEqual([[200, true]]);
    expect(ops.map(o => o.op)).toEqual(['premium.initiatePaidSubscription']);
    expect(ops[0].args.args[0]).toBe(uh(U));
    expect(ops[0].args.args[3]).toMatchObject({ providerId: 'dummy', variantId: DUMMY_VARIANT, buyerId: U });
    const id = sent[0].body.result.providerSubId;
    expect(w.recordOf(uh(U)).active).toMatchObject({ providerId: 'dummy', providerSubId: id, buyerId: U });
    expect(driver.document().subscriptions[id]).toMatchObject({ holder: uh(U), buyerId: U, status: 'active' });
    expect(w.recordOf(gh(U))).toBeNull();
  });

  it("cancel, renew again and end now act on that user's active paid subscription", async () => {
    const id = (await buy(U, 'vlow'))[0].body.result.providerSubId;
    expect((await buy(V, 'vlow'))[0].body.success).toBe(true);
    const other = JSON.stringify(w.recordOf(uh(V)));

    const cancel = await call('delete', '/premium/users/:userId/paid', { userId: U });
    expect(cancel.map(s => [s.status, s.body.success])).toEqual([[200, true]]);
    expect([w.recordOf(uh(U)).active.autoRenew, driver.view(id)?.autoRenew]).toEqual([false, false]);

    const renew = await call('post', '/premium/users/:userId/paid/reactivate', { userId: U });
    expect(renew.map(s => [s.status, s.body.success])).toEqual([[200, true]]);
    expect([w.recordOf(uh(U)).active.autoRenew, driver.view(id)?.autoRenew]).toEqual([true, true]);

    const end = await call('post', '/premium/users/:userId/paid/expire-now', { userId: U });
    expect(end.map(s => [s.status, s.body.success])).toEqual([[200, true]]);
    expect(w.recordOf(uh(U))).toBeNull();
    expect(driver.view(id)?.status).toBe('expired');
    expect(JSON.stringify(w.recordOf(uh(V)))).toBe(other);
    expect(ops.slice(2).map(o => [o.op, o.args.args[0]])).toEqual([
      ['premium.cancelPaidSubscription', uh(U)],
      ['premium.reactivatePaidSubscription', uh(U)],
      ['premium.cancelPaidSubscriptionImmediately', uh(U)],
    ]);
  });

  it('end now answers 404 when the user has no active paid subscription', async () => {
    const sent = await call('post', '/premium/users/:userId/paid/expire-now', { userId: U });
    expect(sent).toEqual([{ status: 404, body: { success: false, error: 'No active paid subscription to expire' } }]);
  });

  it("the queued cancel removes that entry, and answers 404 for an id the user's queue lacks", async () => {
    expect((await buy(U, 'vhigh'))[0].body.success).toBe(true);
    const queuedSub = (await buy(U, 'vlow'))[0].body.result.providerSubId;
    expect((await buy(V, 'vhigh'))[0].body.success).toBe(true);
    expect((await buy(V, 'vlow'))[0].body.success).toBe(true);
    const entry = w.recordOf(uh(U)).paused[0];
    expect(entry.providerSubId).toBe(queuedSub);
    const othersEntry = w.recordOf(uh(V)).paused[0];

    const missing = await call('delete', '/premium/users/:userId/paused/:subscriptionId', { userId: U, subscriptionId: othersEntry.id });
    expect(missing).toEqual([{ status: 404, body: { success: false, error: 'No paused subscription matched that id' } }]);
    expect(w.recordOf(uh(V)).paused.map((p: any) => p.id)).toEqual([othersEntry.id]);

    const empty = await call('delete', '/premium/users/:userId/paused/:subscriptionId', { userId: U, subscriptionId: '' });
    expect(empty).toEqual([{ status: 400, body: { success: false, error: 'subscriptionId is required' } }]);

    const removed = await call('delete', '/premium/users/:userId/paused/:subscriptionId', { userId: U, subscriptionId: entry.id });
    expect(removed.map(s => [s.status, s.body.success])).toEqual([[200, true]]);
    expect(w.recordOf(uh(U)).paused).toEqual([]);
    expect(driver.view(queuedSub)?.status).toBe('expired');
  });

  it('the list answers each found record with its plan, and adopt passes the plan the list showed', async () => {
    const id = await w.unheld(uh(U), 'vlow');
    ops = [];

    const listed = await call('get', '/premium/users/:userId/orphans', { userId: U });
    expect(listed).toHaveLength(1);
    expect(listed[0].body.success).toBe(true);
    expect(listed[0].body.orphans.map((o: any) => [o.providerId, o.ref.providerSubId, o.plan.kind])).toEqual([['dummy', id, 'install']]);
    expect((await call('get', '/premium/users/:userId/orphans', { userId: V }))[0].body.orphans).toEqual([]);

    const plan = listed[0].body.orphans[0].plan;
    const adopted = await call('post', '/premium/users/:userId/orphans/:providerId/:providerSubId/adopt', { userId: U, providerId: 'dummy', providerSubId: id }, { plan });
    expect(adopted.map(s => [s.status, s.body.success])).toEqual([[200, true]]);
    expect(ops.map(o => o.op)).toEqual(['premium.adoptOrphan']);
    expect(ops[0].args.args).toEqual([uh(U), 'dummy', id, plan]);
    expect(w.recordOf(uh(U)).active).toMatchObject({ providerId: 'dummy', providerSubId: id, buyerId: U });
  });

  it("the cancel of a record listed for another user answers 404 and leaves it live; the user's own cancel ends it", async () => {
    const id = await w.unheld(uh(U), 'vlow');
    ops = [];

    const wrong = await call('delete', '/premium/users/:userId/orphans/:providerId/:providerSubId', { userId: V, providerId: 'dummy', providerSubId: id });
    expect(wrong).toEqual([{ status: 404, body: { success: false, error: `Subscription '${id}' is not listed at Dummy (Development) for this user.` } }]);
    expect(ops).toEqual([]);
    expect(driver.view(id)?.status).toBe('active');

    const own = await call('delete', '/premium/users/:userId/orphans/:providerId/:providerSubId', { userId: U, providerId: 'dummy', providerSubId: id });
    expect(own.map(s => [s.status, s.body.success])).toEqual([[200, true]]);
    expect(ops.map(o => [o.op, o.args.args])).toEqual([['premium.cancelOrphan', ['dummy', id]]]);
    expect(driver.view(id)?.status).toBe('expired');
  });

  describe("premium's save refused (the web UI role, premium-tiers.json refusing writes)", () => {
    /** Runs the call while premium's save is refused, in the web UI role, where a refused save is not held. */
    async function refused<T>(fn: () => Promise<T>): Promise<T> {
      const role = process.env.BOT_PROCESS_ROLE;
      delete process.env.BOT_PROCESS_ROLE;
      inject.refuse.add('premium-tiers.json');
      try {
        return await fn();
      } finally {
        inject.refuse.clear();
        process.env.BOT_PROCESS_ROLE = role;
        await w.settle();
      }
    }

    it('the purchase answers not ok and premium stores nothing; a new process lists the Dummy record for that user', async () => {
      const before = w.storedText();
      const sent = await refused(() => buy(U, 'vlow'));
      expect(sent).toHaveLength(1);
      expect(sent[0].status).not.toBe(200);
      expect(sent[0].body.success).toBe(false);
      expect(w.storedText()).toBe(before);
      const ids = Object.keys(driver.document()?.subscriptions ?? {});
      expect(ids).toHaveLength(1);
      await w.reload();
      expect((await w.orphans(uh(U))).map((o: any) => o.ref.providerSubId)).toEqual(ids);
    });

    /** The bot process starts again on the files as they are: a new DummyProvider and a new PremiumManager. */
    async function botProcess(): Promise<void> {
      await w.settle();
      await driver.detach();
      await driver.attach(null);
      await w.reload();
    }

    it("end now answers 503 with the refusal, premium keeps the subscription, and the Dummy's expired record is set back to premium's state within two ticks", async () => {
      const id = (await buy(U, 'vlow'))[0].body.result.providerSubId;
      const before = w.storedText();
      const sent = await refused(() => call('post', '/premium/users/:userId/paid/expire-now', { userId: U }));
      expect(sent).toEqual([{ status: 503, body: { success: false, error: REFUSED } }]);
      expect(w.storedText()).toBe(before);
      expect(w.recordOf(uh(U)).active).toMatchObject({ tierId: 'vlow', providerId: 'dummy' });
      expect(driver.view(id)?.status).toBe('expired');
      await botProcess();
      await w.tick();
      await w.tick();
      const answer = getPaymentRegistry().readSubscription('dummy', uh(U) as any, id);
      expect(answer).toMatchObject({ status: 'active' });
      expect(viewFields(recordView(driver.document().subscriptions[id]))).toEqual(viewFields(answer));
    });

    it("the queued cancel answers 503 with the refusal, premium keeps the queued subscription, and the Dummy's expired record is set back to premium's state within two ticks", async () => {
      expect((await buy(U, 'vhigh'))[0].body.success).toBe(true);
      const queuedSub = (await buy(U, 'vlow'))[0].body.result.providerSubId;
      const entry = w.recordOf(uh(U)).paused[0];
      const before = w.storedText();
      const sent = await refused(() => call('delete', '/premium/users/:userId/paused/:subscriptionId', { userId: U, subscriptionId: entry.id }));
      expect(sent).toEqual([{ status: 503, body: { success: false, error: REFUSED } }]);
      expect(w.storedText()).toBe(before);
      expect(w.recordOf(uh(U)).paused.map((p: any) => p.id)).toEqual([entry.id]);
      expect(driver.view(queuedSub)?.status).toBe('expired');
      await botProcess();
      await w.tick();
      await w.tick();
      const answer = getPaymentRegistry().readSubscription('dummy', uh(U) as any, queuedSub);
      expect(answer).toMatchObject({ status: 'paused' });
      expect(viewFields(recordView(driver.document().subscriptions[queuedSub]))).toEqual(viewFields(answer));
    });
  });

  it("the server page's cancel of a Dummy record premium holds answers the refusal alone, with no provider sentence, and leaves it live", async () => {
    const A = SERVERS[0];
    const bought = await call('post', '/premium/subscriptions/:guildId/paid', { guildId: A }, { tierId: 'low', offeringId: 'o-low', providerId: 'dummy', variantId: DUMMY_VARIANT, buyerId: BUYER });
    const id = bought[0].body.result.providerSubId;
    const router: any = createGuildSubscriptionRoutes(botManager);
    const layer = router.stack.find((l: any) => l.route && l.route.path === '/:guildId/orphans/:providerId/:providerSubId' && l.route.methods.delete);
    const sent: Array<{ status: number; body: any }> = [];
    let code = 200;
    const res: any = {
      status(c: number) { code = c; return res; },
      json(payload: unknown) { sent.push({ status: code, body: payload }); return res; },
    };
    const handlers = layer.route.stack;
    await handlers[handlers.length - 1].handle({ params: { guildId: A, providerId: 'dummy', providerSubId: id }, body: {}, query: {}, user: { id: BUYER } }, res, () => undefined);
    expect(sent).toEqual([{ status: 500, body: { success: false, error: `Subscription '${id}' was not cancelled at the provider: the bot holds it as a subscription. Reload the page to see it.` } }]);
    expect(driver.view(id)?.status).toBe('active');
  });

  it("a server's dev purchase route answers as before", async () => {
    const A = SERVERS[0];
    const sent = await call('post', '/premium/subscriptions/:guildId/paid', { guildId: A }, { tierId: 'low', offeringId: 'o-low', providerId: 'dummy', variantId: DUMMY_VARIANT, buyerId: BUYER });
    expect(sent.map(s => [s.status, s.body.success])).toEqual([[200, true]]);
    expect(ops[0].args.args[0]).toBe(gh(A));
    expect(w.recordOf(gh(A)).active).toMatchObject({ providerId: 'dummy', buyerId: BUYER });
  });
});
