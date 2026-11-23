import fs from 'fs';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P4 (sheet P4, section R3, p4Removal): what the bot does with stored Lemon Squeezy data once the provider is gone.
// Every subscription starts as a Stripe one p3World's fake installed; a Lemon Squeezy one is that state with
// providerId 'lemonsqueezy' and providerSubId '9' set on the copy. p3World registers Stripe only, so any other id is a
// provider the bot does not have.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());
vi.mock('../../src/bot/internalSetup/utils/appStoreManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/appStoreManager')>();
  const store = { getCachedModules: () => [], getRepositories: () => [], getInstalledModules: () => [], getAvailableModules: async () => [] };
  return { ...real, getAppStoreManager: () => store };
});

import { dataPath } from '../../src/utils/dataRoot';
import { getPremiumManager, startPremiumTickers } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { ServerBoostingProvider } from '../../src/bot/internalSetup/utils/payment/boostProvider';
import { runSharedPass } from '../../src/bot/internalSetup/utils/sharedMirror';
import { loadCredentials, providerCredentialsPath, providerKeysFromEnv, providerKeysToEnv } from '../../src/utils/envLoader';
import { createGuildSubscriptionRoutes } from '../../src/webui/routes/guildSubscriptions';
import { PREMIUM_KEY } from '../helpers/nb6PremiumRig';
import { loadGuildPanel, panelFlush, panelText, type Node } from '../helpers/p1PanelRig';
import { mount, settle } from '../helpers/jsxRig';
import { IDS, p3World, PRICES, tierDefOf, type P3World } from '../helpers/p3World';

const A = IDS[0];
const G = '74000000000000001';
const G2 = '74000000000000002';
const G3 = '74000000000000003';
const holderOf = (guildId: string) => `guild:${guildId}`;
const PAST = '2026-01-01T00:00:00.000Z';
const DAY = 86_400_000;
const NOT_REGISTERED = "Provider 'lemonsqueezy' is not registered; link disabled.";

/** A server subscription bought by A on the member route, completed at the fake and installed by its events. */
async function bought(w: P3World, guildId: string): Promise<any> {
  const b = await w.buyMember(holderOf(guildId), A);
  w.fake.complete(b.sessionId!);
  await w.drain();
  const active = w.stored().subscriptions?.[holderOf(guildId)]?.active;
  if (active?.providerId !== 'stripe') throw new Error('the subscription was not installed');
  return active;
}

/** The stored premium-tiers.json changed as another writer would leave it, then a new bot process on it. */
async function rewrite(w: P3World, change: (doc: any) => void): Promise<void> {
  await w.settle();
  const doc = w.stored();
  change(doc);
  const text = JSON.stringify(doc, null, 2);
  if (w.rig) {
    w.rig.m.state.rows.put(PREMIUM_KEY, text);
    await runSharedPass();
  } else {
    fs.writeFileSync(dataPath('global', 'premium-tiers.json'), text);
  }
  await w.reload();
}

const asLemon = (sub: any, more: Record<string, unknown> = {}) => ({ ...sub, providerId: 'lemonsqueezy', providerSubId: '9', ...more });

/** G holds an active Lemon Squeezy subscription (G2's Stripe one, moved) with G's own Stripe one queued behind it. */
async function lemonActiveStripeQueued(w: P3World, more: Record<string, unknown> = {}): Promise<void> {
  await bought(w, G);
  await bought(w, G2);
  const granted = await w.op('grantManual', holderOf(G), 'gold', 30);
  if (!granted.ok) throw new Error(`the grant was not saved: ${granted.error}`);
  await rewrite(w, doc => {
    doc.subscriptions[holderOf(G)].active = asLemon(doc.subscriptions[holderOf(G2)].active, more);
    delete doc.subscriptions[holderOf(G2)];
  });
}

/** G holds a manual grant with its Stripe subscription queued behind it, made a Lemon Squeezy one. */
async function lemonQueuedBehindManual(w: P3World, manual: Record<string, unknown> = {}): Promise<void> {
  await bought(w, G);
  const granted = await w.op('grantManual', holderOf(G), 'gold', 30);
  if (!granted.ok) throw new Error(`the grant was not saved: ${granted.error}`);
  await rewrite(w, doc => {
    const subs = doc.subscriptions[holderOf(G)];
    subs.paused[0] = asLemon(subs.paused[0]);
    Object.assign(subs.active, manual);
  });
}

const subsOf = (w: P3World, guildId: string) => w.stored().subscriptions?.[holderOf(guildId)];
const tick = (): void => (getPremiumManager() as any).checkExpiry();
const noticeKinds = (w: P3World, from: number) => w.notices().slice(from).map(n => n.kind);

function quiet(): void {
  for (const level of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
}

for (const backend of ['json', 'rig'] as const) {
  describe(`stored Lemon Squeezy subscriptions on ${backend === 'json' ? 'the JSON files' : 'the mirror rig'}`, () => {
    const w = p3World(backend);
    beforeEach(async () => {
      quiet();
      await w.setup();
    });
    afterEach(async () => {
      await w.teardown();
      vi.restoreAllMocks();
    });

    it('1: past its end with a Stripe entry queued, a checker tick changes nothing and the server has the free tier', async () => {
      await lemonActiveStripeQueued(w, { endDate: PAST });
      await w.settle();
      const before = w.storedText();
      const lines = w.auditLines().length;
      tick();
      await w.settle();
      expect(w.storedText()).toBe(before);
      expect(w.auditLines()).toHaveLength(lines);
      expect(getPremiumManager().resolveActiveTier(G).tierId).toBe('free');
    }, 30_000);

    it('3: a manual grant after its end takes the slot, and the audit log keeps its id and end date', async () => {
      await lemonActiveStripeQueued(w, { endDate: PAST });
      const lemon = subsOf(w, G).active;
      const queued = subsOf(w, G).paused;
      const lines = w.auditLines().length;
      const granted = await w.op('grantManual', holderOf(G), 'gold', 30);
      expect(granted.ok).toBe(true);
      const after = subsOf(w, G);
      expect([after.active.source, after.active.tierId]).toEqual(['manual', 'gold']);
      expect(after.paused).toEqual(queued);
      const added = w.auditLines().slice(lines);
      expect(added.map(l => l.action)).toEqual(['subscription.grant.manual', 'subscription.expire.paid']);
      expect(added[1]).toMatchObject({ holder: holderOf(G), subscriptionId: lemon.id, providerId: 'lemonsqueezy' });
      expect(added[1].metadata).toEqual({ reason: 'replaced-after-end', providerSubId: '9', endDate: PAST });
    }, 30_000);

    it('C4 for every provider (a): an ended Stripe subscription replaced by a grant leaves one expire.paid line', async () => {
      const stripe = await bought(w, G);
      await rewrite(w, doc => { doc.subscriptions[holderOf(G)].active.endDate = PAST; });
      const lines = w.auditLines().length;
      const notices = w.notices().length;
      expect((await w.op('grantManual', holderOf(G), 'gold', 30)).ok).toBe(true);
      await w.settle();
      const added = w.auditLines().slice(lines);
      expect(added.map(l => l.action)).toEqual(['subscription.grant.manual', 'subscription.expire.paid']);
      expect(added[1]).toMatchObject({ holder: holderOf(G), subscriptionId: stripe.id, providerId: 'stripe' });
      expect(added[1].metadata).toEqual({ reason: 'replaced-after-end', providerSubId: stripe.providerSubId, endDate: PAST });
      expect(noticeKinds(w, notices)).not.toContain('paid.sub.expired');
    }, 30_000);

    it('C4 for every provider (b): an ended manual grant replaced before a checker tick leaves one revoke.manual line', async () => {
      expect((await w.op('grantManual', holderOf(G), 'gold', 30)).ok).toBe(true);
      await rewrite(w, doc => { doc.subscriptions[holderOf(G)].active.endDate = PAST; });
      const ended = subsOf(w, G).active;
      const lines = w.auditLines().length;
      expect((await w.op('grantManual', holderOf(G), 'gold', 30)).ok).toBe(true);
      const added = w.auditLines().slice(lines);
      expect(added.map(l => l.action)).toEqual(['subscription.grant.manual', 'subscription.revoke.manual']);
      expect(added[1]).toMatchObject({ holder: holderOf(G), subscriptionId: ended.id });
      expect(added[1].metadata).toEqual({ reason: 'replaced-after-end', endDate: PAST });
    }, 30_000);

    it('C4 for every provider (c): a grant onto an empty slot writes only its own line', async () => {
      const lines = w.auditLines().length;
      expect((await w.op('grantManual', holderOf(G), 'gold', 30)).ok).toBe(true);
      expect(w.auditLines().slice(lines).map(l => l.action)).toEqual(['subscription.grant.manual']);
    }, 30_000);

    it('R1: a Stripe subscription paused at Stripe before its end date, replaced by a grant, says so in its line', async () => {
      const stripe = await bought(w, G);
      await getPaymentRegistry().get('stripe')!.pauseSubscription!(stripe.providerSubId, null, null);
      await w.drain();
      const paused = subsOf(w, G).active;
      expect([paused.id, paused.status]).toEqual([stripe.id, 'paused']);
      expect(Date.parse(paused.endDate)).toBeGreaterThan(Date.now());
      const lines = w.auditLines().length;
      expect((await w.op('grantManual', holderOf(G), 'gold', 30)).ok).toBe(true);
      const added = w.auditLines().slice(lines);
      expect(added.map(l => l.action)).toEqual(['subscription.grant.manual', 'subscription.expire.paid']);
      expect(added[1]).toMatchObject({ subscriptionId: stripe.id, providerId: 'stripe' });
      expect(added[1].metadata).toEqual({ reason: 'replaced-while-paused', status: 'paused', providerSubId: stripe.providerSubId, endDate: paused.endDate });
    }, 30_000);

    it('6: "Cancel & remove now" removes it with the id kept, sends no notice, and the Stripe entry resumes', async () => {
      await lemonActiveStripeQueued(w);
      const lemon = subsOf(w, G).active;
      const stripeId = subsOf(w, G).paused[0].id;
      const lines = w.auditLines().length;
      const notices = w.notices().length;
      const reply = await w.op('cancelPaidSubscriptionImmediately', holderOf(G));
      expect(reply).toMatchObject({ ok: true, result: true });
      const after = subsOf(w, G);
      expect([after.active.id, after.active.providerId, after.active.status, after.paused]).toEqual([stripeId, 'stripe', 'active', []]);
      const cancel = w.auditLines().slice(lines).find(l => l.action === 'subscription.cancel.paid');
      expect(cancel).toMatchObject({ subscriptionId: lemon.id, providerId: 'lemonsqueezy' });
      expect(cancel.metadata).toEqual({ immediately: true, providerNotCalled: true, providerSubId: '9', endDate: lemon.endDate });
      expect(noticeKinds(w, notices)).not.toContain('paid.sub.cancelled-by-user');

      const stripe = await bought(w, G3);
      const stripeLines = w.auditLines().length;
      const stripeNotices = w.notices().length;
      expect(await w.op('cancelPaidSubscriptionImmediately', holderOf(G3))).toMatchObject({ ok: true, result: true });
      await vi.waitFor(() => expect(noticeKinds(w, stripeNotices)).toContain('paid.sub.cancelled-by-user'), { timeout: 5000, interval: 5 });
      const stripeCancel = w.auditLines().slice(stripeLines).find(l => l.action === 'subscription.cancel.paid');
      expect(stripeCancel).toMatchObject({ subscriptionId: stripe.id, providerId: 'stripe' });
      expect(stripeCancel.metadata).toEqual({ immediately: true });
    }, 30_000);

    it('7: the cancel of a queued Lemon Squeezy entry removes it with the id kept; the active grant stays', async () => {
      await lemonQueuedBehindManual(w);
      const before = subsOf(w, G);
      const lemon = before.paused[0];
      const lines = w.auditLines().length;
      const reply = await w.op('cancelAndRemovePausedSubscription', holderOf(G), lemon.id);
      expect(reply).toMatchObject({ ok: true, result: true });
      const after = subsOf(w, G);
      expect([after.active, after.paused]).toEqual([before.active, []]);
      const cancel = w.auditLines().slice(lines).find(l => l.action === 'subscription.cancel.paid');
      expect(cancel).toMatchObject({ subscriptionId: lemon.id, providerId: 'lemonsqueezy' });
      expect(cancel.metadata).toEqual({ fromPausedQueue: true, providerNotCalled: true, providerSubId: '9', endDate: lemon.endDate });
    }, 30_000);
  });
}

describe('stored Lemon Squeezy data on the JSON files', () => {
  const w = p3World('json');
  beforeEach(async () => {
    quiet();
    await w.setup();
  });
  afterEach(async () => {
    getPaymentRegistry().unregister('boost');
    await w.teardown();
    vi.restoreAllMocks();
  });

  it('2: before its end date the server keeps its tier', async () => {
    await lemonActiveStripeQueued(w);
    expect(getPremiumManager().resolveActiveTier(G).tierId).toBe('gold');
  });

  it('4: a manual grant past its end gives way to the queued Lemon Squeezy entry, with its held days', async () => {
    await lemonQueuedBehindManual(w, { endDate: PAST });
    const lemon = subsOf(w, G).paused[0];
    const lines = w.auditLines().length;
    const start = Date.now();
    tick();
    await w.settle();
    const after = subsOf(w, G);
    expect([after.active.id, after.active.providerId, after.active.status, after.paused]).toEqual([lemon.id, 'lemonsqueezy', 'active', []]);
    const ends = Date.parse(after.active.endDate);
    expect(ends).toBeGreaterThanOrEqual(start + lemon.remainingDaysAtPause * DAY);
    expect(ends).toBeLessThanOrEqual(Date.now() + lemon.remainingDaysAtPause * DAY);
    const added = w.auditLines().slice(lines);
    expect(added.map(l => l.action)).toEqual(['subscription.revoke.manual', 'subscription.resume']);
    expect(added[1]).toMatchObject({ subscriptionId: lemon.id, providerId: 'lemonsqueezy' });
  });

  it('5: cancel at period end and reactivate both answer false and change nothing', async () => {
    await lemonActiveStripeQueued(w);
    await w.settle();
    const before = w.storedText()!;
    const notices = w.notices().length;
    const cancel = await w.op('cancelPaidSubscription', holderOf(G));
    await w.settle();
    expect(w.storedText()).toBe(before);
    await rewrite(w, doc => { doc.subscriptions[holderOf(G)].active.autoRenew = false; });
    const between = w.storedText()!;
    const reactivate = await w.op('reactivatePaidSubscription', holderOf(G));
    expect([cancel.result, reactivate.result]).toEqual([false, false]);
    expect(JSON.parse(between).subscriptions[holderOf(G)].active.autoRenew).toBe(false);
    expect(w.storedText()).toBe(between);
    expect(JSON.parse(before).subscriptions[holderOf(G)].active.autoRenew).toBe(true);
    expect(w.notices().length).toBe(notices);
  });

  it('8: "Cancel & remove now" on Server Boosting, a provider the bot has, still sends the notice', async () => {
    getPaymentRegistry().register(new ServerBoostingProvider());
    await bought(w, G);
    await rewrite(w, doc => { doc.subscriptions[holderOf(G)].active.providerId = 'boost'; });
    const boost = subsOf(w, G).active;
    const lines = w.auditLines().length;
    const notices = w.notices().length;
    expect(await w.op('cancelPaidSubscriptionImmediately', holderOf(G))).toMatchObject({ ok: true, result: true });
    await vi.waitFor(() => expect(noticeKinds(w, notices)).toContain('paid.sub.cancelled-by-user'), { timeout: 5000, interval: 5 });
    const cancel = w.auditLines().slice(lines).find(l => l.action === 'subscription.cancel.paid');
    expect(cancel).toMatchObject({ subscriptionId: boost.id, providerId: 'boost' });
    expect(cancel.metadata).toEqual({ immediately: true });
  });

  it('9: a higher manual grant queues an active Lemon Squeezy subscription with no paused notice; Stripe keeps it', async () => {
    expect((await w.op('setTier', 'plat', { displayName: 'Platinum', priority: 2, overrides: {}, offerings: [] })).ok).toBe(true);
    await bought(w, G3);
    await lemonActiveStripeQueued(w);
    const lemon = subsOf(w, G).active;
    const lines = w.auditLines().length;
    const notices = w.notices().length;
    expect((await w.op('grantManual', holderOf(G), 'plat', 30)).ok).toBe(true);
    expect(subsOf(w, G).paused.map((p: any) => p.id)).toContain(lemon.id);
    const pause = w.auditLines().slice(lines).find(l => l.action === 'subscription.pause');
    expect(pause).toMatchObject({ subscriptionId: lemon.id, providerId: 'lemonsqueezy', metadata: { providerNotCalled: true } });
    await w.settle();
    expect(noticeKinds(w, notices)).not.toContain('paid.sub.paused-by-stacking');

    const stripe = subsOf(w, G3).active;
    const stripeLines = w.auditLines().length;
    const stripeNotices = w.notices().length;
    expect((await w.op('grantManual', holderOf(G3), 'plat', 30)).ok).toBe(true);
    await vi.waitFor(() => expect(noticeKinds(w, stripeNotices)).toContain('paid.sub.paused-by-stacking'), { timeout: 5000, interval: 5 });
    const stripePause = w.auditLines().slice(stripeLines).find(l => l.action === 'subscription.pause');
    expect(stripePause).toMatchObject({ subscriptionId: stripe.id, providerId: 'stripe' });
    expect(stripePause.metadata?.providerNotCalled).toBeUndefined();
  });

  it('10: a price change for lemonsqueezy cannot be scheduled; a stored one is cancelled at its date and stays listed', async () => {
    const refused = await w.op('scheduleMigration', {
      providerId: 'lemonsqueezy', sourceTierId: 'gold', sourceOfferingId: 'o-gold', sourceVariantId: PRICES.gold.monthly,
      targetTierId: 'gold', targetOfferingId: 'o-gold', targetVariantId: PRICES.gold.once,
      effectiveDate: new Date(Date.now() + DAY).toISOString(), message: '',
    });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("Provider 'lemonsqueezy' is not registered.");
    const scheduled = await w.op('scheduleMigration', {
      providerId: 'stripe', sourceTierId: 'gold', sourceOfferingId: 'o-gold', sourceVariantId: PRICES.gold.monthly,
      targetTierId: 'gold', targetOfferingId: 'o-gold', targetVariantId: PRICES.gold.once,
      effectiveDate: new Date(Date.now() + DAY).toISOString(), message: '',
    });
    expect(scheduled.ok).toBe(true);
    await rewrite(w, doc => {
      doc.migrations[0].providerId = 'lemonsqueezy';
      doc.migrations[0].effectiveDate = PAST;
    });
    const id = w.stored().migrations[0].id;
    const lines = w.auditLines().length;
    await getPremiumManager().processDueMigrations();
    await w.settle();
    expect(w.stored().migrations.map((m: any) => [m.id, m.status])).toEqual([[id, 'cancelled']]);
    expect(getPremiumManager().listMigrations().map(m => [m.id, m.status])).toEqual([[id, 'cancelled']]);
    const added = w.auditLines().slice(lines);
    expect(added.map(l => [l.action, l.migrationId, l.providerId, l.metadata])).toEqual([['migration.cancelled', id, 'lemonsqueezy', { reason: 'provider-unavailable' }]]);
  });

  it("11: setTier keeps an enabled lemonsqueezy link; the admin tier save turns it off, keeps its cache and warns", async () => {
    const gold = tierDefOf('gold');
    const stripeLink = gold.offerings[0].providerLinks[0];
    const lemonLink = { ...stripeLink, providerId: 'lemonsqueezy', priceConfig: { entries: [{ variantId: '5' }] }, cache: { ...stripeLink.cache, variants: [{ ...stripeLink.cache.variants[0], variantId: '5' }] } };
    const tier = { ...gold, offerings: [{ ...gold.offerings[0], providerLinks: [stripeLink, lemonLink] }] };
    expect((await w.op('setTier', 'gold', tier)).ok).toBe(true);
    const kept = w.stored().tiers.gold.offerings[0].providerLinks.find((l: any) => l.providerId === 'lemonsqueezy');
    expect(kept).toEqual(lemonLink);
    const { createAppStoreRoutes } = await import('../../src/webui/routes/appstore');
    const stored = w.stored().tiers.gold;
    const reply = await w.callRoute(createAppStoreRoutes(w.botManager), 'put', '/premium/tiers/:id', {
      params: { id: 'gold' }, body: { displayName: stored.displayName, priority: stored.priority, overrides: stored.overrides, offerings: stored.offerings },
    });
    expect(reply.status).toBe(200);
    expect(reply.body.success).toBe(true);
    expect(reply.body.warnings).toContain(NOT_REGISTERED);
    const saved = w.stored().tiers.gold.offerings[0].providerLinks.find((l: any) => l.providerId === 'lemonsqueezy');
    expect(saved).toEqual({ ...lemonLink, enabled: false });
  });

  it('12: a journaled subscription.created from lemonsqueezy for a server is installed by the replay', async () => {
    await bought(w, G);
    const created = w.emitted.find(e => e.type === 'subscription.created');
    const event = { ...created, providerId: 'lemonsqueezy', providerSubId: '9', holder: holderOf(G2) };
    const good = w.storedText()!;
    fs.writeFileSync(dataPath('global', 'premium-tiers.json'), '{ not json');
    await w.reload();
    getPaymentRegistry().emitEvent(event as any);
    await w.settle();
    const journal = dataPath('global', 'premium-tiers.events.jsonl');
    expect(fs.readFileSync(journal, 'utf8')).toContain('"providerId":"lemonsqueezy"');
    fs.writeFileSync(dataPath('global', 'premium-tiers.json'), good);
    await w.reload();
    const pm = getPremiumManager();
    startPremiumTickers();
    await vi.waitFor(() => expect(pm.cacheState()).toBe('normal'), { timeout: 5000, interval: 5 });
    await w.settle();
    const installed = subsOf(w, G2).active;
    expect([installed.source, installed.providerId, installed.providerSubId, installed.tierId, installed.status]).toEqual(['paid', 'lemonsqueezy', '9', 'gold', 'active']);
    pm.stopExpiryChecker();
  });

  it('13: the guild view answers the subscription as stored and lists the registered providers apart', async () => {
    await lemonActiveStripeQueued(w);
    getPaymentRegistry().register(new ServerBoostingProvider());
    const reply = await w.callRoute(createGuildSubscriptionRoutes(w.botManager), 'get', '/:guildId', { params: { guildId: G }, user: { id: A } });
    expect(reply.status).toBe(200);
    expect(reply.body.subscriptions).toEqual(subsOf(w, G));
    const listed = reply.body.providers.map((p: any) => p.id);
    expect(listed).not.toContain('lemonsqueezy');
    expect(listed).not.toContain('boost');
    expect(reply.body.registeredProviders).toEqual(getPaymentRegistry().listAll().map(p => p.id));
    expect(reply.body.registeredProviders).toEqual(expect.arrayContaining(['stripe', 'boost']));
  });

  it('16 (JSON): a Stripe key saved on the premium tab keeps the LEMONSQUEEZY_ line of /data/.env byte for byte', async () => {
    const env = dataPath('.env');
    const line = 'LEMONSQUEEZY_API_KEY=ls_json_made_up_p4';
    fs.writeFileSync(env, `${line}\n`);
    try {
      const { createAppStoreRoutes } = await import('../../src/webui/routes/appstore');
      const reply = await w.callRoute(createAppStoreRoutes(w.botManager), 'put', '/premium/providers/:providerId/credentials', {
        params: { providerId: 'stripe' }, body: { values: { STRIPE_SECRET_KEY: 'sk_test_p4_made_up' } },
      });
      expect(reply.status).toBe(200);
      const lines = fs.readFileSync(env, 'utf8').split('\n');
      expect(lines).toContain(line);
      expect(lines.some(l => l.startsWith('STRIPE_SECRET_KEY='))).toBe(true);
    } finally {
      fs.writeFileSync(env, '');
      loadCredentials();
      fs.rmSync(env, { force: true });
      for (const key of Object.keys(process.env)) if (key.startsWith('LEMONSQUEEZY_')) delete process.env[key];
    }
  });

  it("14: the buyer's portal route gives no portal URL, answers the op's refusal and writes nothing", async () => {
    await lemonActiveStripeQueued(w);
    await w.settle();
    const before = w.storedText();
    const lines = w.auditLines().length;
    const reply = await w.callRoute(createGuildSubscriptionRoutes(w.botManager), 'post', '/:guildId/paid/billing-portal', { params: { guildId: G }, body: {}, user: { id: A } });
    expect(reply.body.success).toBe(false);
    expect(reply.body.portalUrl).toBeUndefined();
    expect(reply.body.error).toContain("Provider 'lemonsqueezy' does not have a managed portal");
    expect(w.storedText()).toBe(before);
    expect(w.auditLines()).toHaveLength(lines);
  });
});

describe('16: Lemon Squeezy keys, on the mirror rig where the credentials doc lives', () => {
  const w = p3World('rig');
  const ENV = dataPath('.env');
  const DOC_KEY = 'global/payment-providers/credentials.json';
  const clean = (): void => {
    fs.writeFileSync(ENV, '');
    loadCredentials();
    fs.rmSync(ENV, { force: true });
    for (const key of Object.keys(process.env)) if (key.startsWith('LEMONSQUEEZY_')) delete process.env[key];
  };
  beforeEach(async () => {
    quiet();
    await w.setup();
    clean();
  });
  afterEach(async () => {
    clean();
    fs.rmSync(dataPath('global', 'payment-providers'), { recursive: true, force: true });
    await w.teardown();
    vi.restoreAllMocks();
  });

  it('a migration carries them both ways, a Stripe key save keeps their entry, and no screen reads them', async () => {
    fs.writeFileSync(ENV, 'LEMONSQUEEZY_API_KEY=ls_made_up_p4\n');
    const fromEnv = JSON.parse(providerKeysFromEnv().body!.toString('utf8'));
    expect(fromEnv.lemonsqueezy).toEqual({ LEMONSQUEEZY_API_KEY: 'ls_made_up_p4' });
    fs.writeFileSync(ENV, '');
    const plan = providerKeysToEnv(JSON.stringify({ lemonsqueezy: { LEMONSQUEEZY_API_KEY: 'ls_doc_p4' } }));
    expect(plan.changes).toEqual({ LEMONSQUEEZY_API_KEY: 'ls_doc_p4' });

    const doc = { lemonsqueezy: { LEMONSQUEEZY_API_KEY: 'ls_doc_p4', LEMONSQUEEZY_STORE_ID: '222' } };
    const text = JSON.stringify(doc, null, 2);
    w.rig!.m.state.rows.put(DOC_KEY, text);
    fs.mkdirSync(dataPath('global', 'payment-providers'), { recursive: true });
    fs.writeFileSync(providerCredentialsPath(), text);
    const entryBefore = JSON.stringify(doc.lemonsqueezy, null, 2);
    const saved = await w.sharedOp('provider.saveCredentials', { providerId: 'stripe', changes: { STRIPE_P4_MARK: 'p4' } });
    expect(saved.ok).toBe(true);
    const row = JSON.parse(w.rig!.m.state.rows.docs.get(DOC_KEY)!.body.toString('utf8'));
    expect(row.stripe).toEqual({ STRIPE_P4_MARK: 'p4' });
    expect(JSON.stringify(row.lemonsqueezy, null, 2)).toBe(entryBefore);

    const { createAppStoreRoutes } = await import('../../src/webui/routes/appstore');
    const reply = await w.callRoute(createAppStoreRoutes(w.botManager), 'get', '/premium/providers/:providerId/credentials', { params: { providerId: 'lemonsqueezy' } });
    expect(reply.status).toBe(404);
  }, 30_000);
});

type Button = { label: string; title: string; onClick: () => unknown };
function buttonsOf(tree: unknown, out: Button[] = []): Button[] {
  if (Array.isArray(tree)) { tree.forEach(t => buttonsOf(t, out)); return out; }
  if (!tree || typeof tree !== 'object') return out;
  const node = tree as Node;
  if (node.type === 'button') out.push({ label: panelText(node).trim(), title: String(node.props?.title ?? ''), onClick: node.props?.onClick as () => unknown });
  (node.children || []).forEach(c => buttonsOf(c, out));
  return out;
}

const STRIPE_LISTED = { id: 'stripe', displayName: 'Stripe', capabilities: { supportsCancel: true, supportsReactivate: true, supportsCustomerPortal: true } };
const ENDS = '2027-03-03T12:00:00.000Z';
const paidCard = (providerId: string, autoRenew: boolean) => ({
  id: 'sub-a', source: 'paid', status: 'active', tierId: 'gold', providerId, providerSubId: '9', autoRenew, endDate: ENDS,
});
const queuedCard = (providerId: string) => ({
  id: 'sub-q', source: 'paid', status: 'paused', tierId: 'gold', providerId, providerSubId: '10', remainingDaysAtPause: 5, endDate: ENDS,
});
const GONE_LINE = "This bot does not have the payment provider 'lemonsqueezy', so it cannot change this subscription there. Manage or cancel it at that provider.";
const GONE_CONFIRM = " This removes it from the bot only: the bot does not have the payment provider 'lemonsqueezy', so the billing there does not stop. Cancel it at that provider as well.";
const NOW_CONFIRM = "Cancel 'Gold' immediately? You'll lose any remaining time on it. If you have a queued subscription it will resume in this slot. This cannot be undone.";
const QUEUED_GONE_CONFIRM = "Cancel your queued 'Gold' subscription? It will not resume when your current plan ends. This removes it from the bot only: the bot does not have the payment provider 'lemonsqueezy', so the billing there does not stop. Cancel it at that provider as well.";
const QUEUED_CONFIRM = "Cancel your queued 'Gold' subscription? It will not resume when your current plan ends, and the provider will stop billing for it.";

async function showPanel(active: any, paused: any[], providers: any[], registeredProviders?: string[]) {
  const confirms: string[] = [];
  const panel = loadGuildPanel({
    listOrphans: async () => ({ success: true, orphans: [] }),
    listPendingMigrations: async () => ({ success: true, migrations: [] }),
    listGuildChannels: async () => ({ success: true, channels: [] }),
  }, text => { confirms.push(text); return false; });
  const subData = {
    subscriptions: { active, paused },
    tiers: { gold: { displayName: 'Gold', priority: 1, offerings: [] } },
    providers,
    ...(registeredProviders ? { registeredProviders } : {}),
  };
  const props = { guild: { id: G }, subData, onRefresh: async () => {} };
  panel.render(props);
  await panelFlush();
  const tree = panel.render(props);
  const buttons = buttonsOf(tree);
  const labels = buttons.map(b => b.label);
  return {
    text: panelText(tree),
    has: (label: string) => labels.some(l => l.startsWith(label)),
    labels,
    click: async (label: string) => { await buttons.find(b => b.label === label)!.onClick(); },
    confirms,
  };
}

describe('15: the member page for a subscription whose provider the bot does not have', () => {
  it('without the provider in registeredProviders: no Cancel, Reactivate or portal button, the line, and both confirms say the billing goes on', async () => {
    const on = await showPanel(paidCard('lemonsqueezy', true), [queuedCard('lemonsqueezy')], [STRIPE_LISTED], ['stripe']);
    const off = await showPanel(paidCard('lemonsqueezy', false), [], [STRIPE_LISTED], ['stripe']);
    expect([on.labels.includes('Cancel'), on.has('Manage at provider'), on.labels.includes('Cancel & remove now')]).toEqual([false, false, true]);
    expect([off.has('Reactivate'), off.has('Manage at provider'), off.labels.includes('Cancel & remove now')]).toEqual([false, false, true]);
    expect(on.text).toContain(GONE_LINE);
    expect(off.text).toContain(GONE_LINE);
    await on.click('Cancel & remove now');
    await on.click('Cancel & remove');
    expect(on.confirms).toEqual([`${NOW_CONFIRM}${GONE_CONFIRM}`, QUEUED_GONE_CONFIRM]);
  });

  it('with no registeredProviders in the reply: the buttons and confirms as before', async () => {
    const on = await showPanel(paidCard('lemonsqueezy', true), [queuedCard('lemonsqueezy')], [STRIPE_LISTED]);
    const off = await showPanel(paidCard('lemonsqueezy', false), [], [STRIPE_LISTED]);
    expect([on.labels.includes('Cancel'), on.has('Manage at provider'), off.has('Reactivate')]).toEqual([true, true, true]);
    expect(on.text).not.toContain(GONE_LINE);
    await on.click('Cancel & remove now');
    await on.click('Cancel & remove');
    expect(on.confirms).toEqual([NOW_CONFIRM, QUEUED_CONFIRM]);
  });

  it('a registered provider missing from providers (Stripe deactivated) keeps Cancel, Reactivate and "Manage at provider"', async () => {
    const on = await showPanel(paidCard('stripe', true), [queuedCard('stripe')], [], ['dummy', 'stripe']);
    const off = await showPanel(paidCard('stripe', false), [], [], ['dummy', 'stripe']);
    expect([on.labels.includes('Cancel'), on.has('Manage at provider'), off.has('Reactivate'), off.has('Manage at provider')]).toEqual([true, true, true, true]);
    expect(on.text).not.toContain('This bot does not have the payment provider');
    await on.click('Cancel & remove now');
    await on.click('Cancel & remove');
    expect(on.confirms).toEqual([NOW_CONFIRM, QUEUED_CONFIRM]);
  });
});

const PREMIUM_JSX = fileURLToPath(new URL('../../src/webui/public/components/premium/PremiumComponents.jsx', import.meta.url));

describe("17: the offerings editor's provider chips", () => {
  it('a lemonsqueezy link reads "(not installed)"; a registered provider that is not activated reads "(deactivated)"', async () => {
    const link = (providerId: string) => ({ providerId, enabled: true, mode: 'price', priceConfig: { entries: [] }, cache: { variants: [] } });
    const tier = { displayName: 'Gold', priority: 1, overrides: {}, offerings: [{ id: 'o-gold', label: 'Gold', providerLinks: [link('lemonsqueezy'), link('stripe')] }] };
    const panel = mount(PREMIUM_JSX, 'OfferingsEditorPanel', {
      tierId: 'gold', tier, providers: [{ id: 'stripe', displayName: 'Stripe', capabilities: {} }], activatedProviders: {},
      onSave: () => undefined, onClose: () => undefined, showSuccess: () => undefined, setError: () => undefined,
    }, { api: {}, confirm: () => false });
    await settle();
    const chips = panel.all(el => el.type === 'span' && /^(lemonsqueezy|Stripe)/.test(panel.text(el))).map(el => panel.text(el));
    expect(chips).toEqual(['lemonsqueezy (not installed)', 'Stripe (deactivated)']);
  });
});
