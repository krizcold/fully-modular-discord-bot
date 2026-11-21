import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P1 claim 14: what a provider sells is honoured. The seller sells both kinds. A provider that sells servers only:
// premium refuses a user's purchase from it before any call (X3), asks it nothing about a user, and speaks to it
// for a server by holder and buyer. Each of the seven providers is judged by its own `sells`: six sell servers only,
// and the Dummy sells both kinds (P2 claim 3). setTier refuses an enabled link of a provider that does not sell the
// tier's kind (X8).

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import type { PaymentProvider } from '../../src/bot/internalSetup/utils/payment/paymentTypes';
import { StripeProvider } from '../../src/bot/internalSetup/utils/payment/stripeProvider';
import { LemonSqueezyProvider } from '../../src/bot/internalSetup/utils/payment/lemonsqueezyProvider';
import { PayPalProvider } from '../../src/bot/internalSetup/utils/payment/paypalProvider';
import { PatreonProvider } from '../../src/bot/internalSetup/utils/payment/patreonProvider';
import { ServerBoostingProvider } from '../../src/bot/internalSetup/utils/payment/boostProvider';
import { DiscordProvider } from '../../src/bot/internalSetup/utils/payment/discordProvider';
import { dummyDriver } from '../helpers/p2DummyDriver';
import { allowDropLines } from '../helpers/p1Guard';
import { notices } from '../helpers/p1Mocks';
import { gh, uh } from '../helpers/p1Holder';
import { BUYER, p1World, purchaseOptions, SELLER_ID, sellerListCall, sellerOffering, SERVERS, USERS, userSoldTierDef } from '../helpers/p1World';

const w = p1World();
const SERVER = gh(SERVERS[0]);
const USER = uh(USERS[0]);
const PLAIN = 'p1plain';
const PLAIN_VARIANT = 'plain_monthly';
const state = () => ({ premium: w.storedText(), audit: w.auditText(), notices: JSON.stringify(notices.sent) });
const plainOffering = (offeringId: string, label: string, enabled = true) => ({
  id: offeringId, label,
  providerLinks: [{ providerId: PLAIN, enabled, mode: 'price', priceConfig: { entries: [{ variantId: PLAIN_VARIANT }] } }],
});

/** A provider that sells servers only: it installs at once, as the Dummy does. */
function plainProvider(over: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const listed: any[] = [];
  const now = () => new Date().toISOString();
  const provider: any = {
    id: PLAIN,
    displayName: 'P1 Plain',
    capabilities: { canInitiatePurchase: true, supportsCancel: true, supportsReactivate: false, supportsCoupons: false, supportsPause: true, mechanism: 'immediate', sells: ['guild'] },
    isConfigured: () => true,
    initiatePurchase: async (opts: unknown) => {
      calls.push({ method: 'initiatePurchase', args: [opts] });
      return { providerSubId: `plain_${calls.length}`, state: { status: 'active', startDate: now(), endDate: new Date(Date.now() + 30 * 86_400_000).toISOString(), autoRenew: true } };
    },
    listSubscriptionsFor: async (holder: string) => {
      calls.push({ method: 'listSubscriptionsFor', args: [holder] });
      return listed.filter(r => r.metadata.holder === holder);
    },
    getSubscriptionState: async () => null,
    pauseSubscription: async (...args: unknown[]) => { calls.push({ method: 'pauseSubscription', args }); },
    resumeSubscription: async (...args: unknown[]) => { calls.push({ method: 'resumeSubscription', args }); },
    cancelSubscription: async (...args: unknown[]) => { calls.push({ method: 'cancelSubscription', args }); },
    handleWebhook: async (body: Buffer) => { getPaymentRegistry().emitEvent(JSON.parse(body.toString('utf8'))); },
    ...over,
  };
  return { provider, calls, listed };
}

beforeEach(async () => {
  await w.setup();
  await w.addSoldUserTiers();
  for (const level of ['log', 'warn'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await w.teardown();
});

describe('P1 claim 14: a provider that sells servers only', () => {
  it('a user purchase through it is refused with X3 and it is never called', async () => {
    // The tier is saved while the provider is not registered (X8 cannot judge an unknown provider); it registers after.
    expect((await w.op('setTier', 'uplain', { ...userSoldTierDef('vlow', 'U Plain'), priority: 5, offerings: [plainOffering('o-uplain', 'U Plain')] })).ok).toBe(true);
    const plain = plainProvider();
    getPaymentRegistry().register(plain.provider);
    expect((await w.op('setProviderActivation', PLAIN, true)).ok).toBe(true);
    const before = state();

    const reply = await w.op('initiatePaidSubscription', USER, 'uplain', 'o-uplain', { providerId: PLAIN, variantId: PLAIN_VARIANT, buyerId: USERS[0] });

    expect(reply.ok).toBe(false);
    expect(reply.error).toContain('P1 Plain does not sell user subscriptions.');
    expect(state()).toEqual(before);
    expect(plain.calls).toEqual([]);
    expect(w.calls()).toEqual([]);
  });

  it('a server purchase through it lists by the holder, sends the holder and the buyer and stores the buyer', async () => {
    const plain = plainProvider();
    getPaymentRegistry().register(plain.provider);
    expect((await w.op('setProviderActivation', PLAIN, true)).ok).toBe(true);
    expect((await w.op('setTier', 'plain', { displayName: 'Plain', priority: 6, overrides: {}, offerings: [plainOffering('o-plain', 'Plain')] })).ok).toBe(true);

    const reply = await w.op('initiatePaidSubscription', SERVER, 'plain', 'o-plain', { providerId: PLAIN, variantId: PLAIN_VARIANT, buyerId: BUYER });

    expect(reply).toMatchObject({ ok: true });
    expect(plain.calls.map(c => c.method)).toEqual(['listSubscriptionsFor', 'initiatePurchase']);
    expect(plain.calls[0].args).toEqual([SERVER]);
    expect(plain.calls[1].args[0]).toMatchObject({ holder: SERVER, buyerId: BUYER, tierId: 'plain', offeringId: 'o-plain', variantId: PLAIN_VARIANT });
    expect(plain.calls[1].args[0]).not.toHaveProperty('guildId');
    expect(plain.calls[1].args[0]).not.toHaveProperty('userId');
    expect(w.recordOf(SERVER).active).toMatchObject({ tierId: 'plain', source: 'paid', providerId: PLAIN, buyerId: BUYER });
  });

  it('its events and its list are read by holder and buyer: an event by holder is applied, a listed buyerId is the buyer of an adoption, and the form of before P1 is not read', async () => {
    const plain = plainProvider();
    getPaymentRegistry().register(plain.provider);
    expect((await w.op('setProviderActivation', PLAIN, true)).ok).toBe(true);
    expect((await w.op('setTier', 'plain', { displayName: 'Plain', priority: 6, overrides: {}, offerings: [plainOffering('o-plain', 'Plain')] })).ok).toBe(true);
    const deliver = (event: object) => w.sharedOp('payment.webhook', { providerId: PLAIN, body: Buffer.from(JSON.stringify(event)).toString('base64'), signature: '' });
    const term = { status: 'active', startDate: new Date().toISOString(), endDate: new Date(Date.now() + 30 * 86_400_000).toISOString(), autoRenew: true };

    expect(await deliver({ type: 'subscription.created', providerId: PLAIN, providerSubId: 'plain_evt', holder: SERVER, buyerId: BUYER, tierId: 'plain', offeringId: 'o-plain', variantId: PLAIN_VARIANT, state: term })).toMatchObject({ ok: true });
    expect(w.recordOf(SERVER).active).toMatchObject({ providerSubId: 'plain_evt', buyerId: BUYER });
    const later = new Date(Date.now() + 60 * 86_400_000).toISOString();
    expect(await deliver({ type: 'subscription.renewed', providerId: PLAIN, providerSubId: 'plain_evt', holder: SERVER, state: { ...term, endDate: later } })).toMatchObject({ ok: true });
    expect(w.recordOf(SERVER).active.endDate).toBe(later);
    allowDropLines('L2');
    const byGuildId = state();
    await deliver({ type: 'subscription.renewed', providerId: PLAIN, providerSubId: 'plain_evt', guildId: SERVERS[0], state: { ...term, endDate: new Date(Date.now() + 90 * 86_400_000).toISOString() } });
    expect(state().premium).toBe(byGuildId.premium);

    const other = gh(SERVERS[1]);
    plain.listed.push({
      providerSubId: 'plain_orphan', state: term,
      metadata: { holder: other, buyerId: '80000000000000055', tierId: 'plain', offeringId: 'o-plain', variantId: PLAIN_VARIANT },
      display: { amountLabel: '5.00 USD', periodLabel: 'monthly', statusLabel: 'active' },
    });
    const third = gh('70000000000000003');
    plain.listed.push({
      providerSubId: 'plain_old', state: term,
      metadata: { holder: third, userId: '80000000000000056', tierId: 'plain', offeringId: 'o-plain', variantId: PLAIN_VARIANT },
      display: { amountLabel: '5.00 USD', periodLabel: 'monthly', statusLabel: 'active' },
    });
    const listed = await w.orphans(other);
    expect(listed.map(o => [o.providerId, o.ref.providerSubId, o.plan.kind])).toEqual([[PLAIN, 'plain_orphan', 'install']]);
    expect((await w.op('adoptOrphan', other, PLAIN, 'plain_orphan', listed[0].plan))).toMatchObject({ ok: true, result: true });
    expect(w.recordOf(other).active).toMatchObject({ providerSubId: 'plain_orphan', buyerId: '80000000000000055', source: 'paid' });
    expect((await w.orphans(third)).map(o => [o.ref.providerSubId, o.plan.kind])).toEqual([['plain_old', 'refuse']]);
  });

  it("a created event of a user tier for a user from it is not installed, changes nothing and logs L3 with the provider's kinds", async () => {
    const plain = plainProvider();
    getPaymentRegistry().register(plain.provider);
    expect(await w.purchase(SERVER, 'mid')).toMatchObject({ ok: true });
    const before = state();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    allowDropLines('L3');
    const term = { status: 'active', startDate: new Date().toISOString(), endDate: new Date(Date.now() + 30 * 86_400_000).toISOString(), autoRenew: true };

    const reply = await w.sharedOp('payment.webhook', {
      providerId: PLAIN, signature: '',
      body: Buffer.from(JSON.stringify({ type: 'subscription.created', providerId: PLAIN, providerSubId: 'plain_u1', holder: USER, buyerId: USERS[0], tierId: 'vlow', offeringId: 'o-vlow', variantId: PLAIN_VARIANT, state: term })).toString('base64'),
    });

    expect(reply).toMatchObject({ ok: true });
    expect(state()).toEqual(before);
    expect(w.recordOf(USER)).toBeNull();
    expect(warn.mock.calls.map(c => c.map(String).join(' ')).filter(l => l.includes('was not installed'))).toEqual([
      `[PremiumManager] subscription.created from ${PLAIN} (subscription plain_u1, user ${USERS[0]}) was not installed: P1 Plain does not sell user subscriptions`,
    ]);
  });

  it('findOrphansFor a user asks only the seller, and for a server asks both', async () => {
    const plain = plainProvider();
    getPaymentRegistry().register(plain.provider);

    expect(await w.orphans(USER)).toEqual([]);
    expect(w.calls()).toEqual([sellerListCall(USER)]);
    expect(plain.calls).toEqual([]);

    expect(await w.orphans(SERVER)).toEqual([]);
    expect(w.calls()).toEqual([sellerListCall(USER), sellerListCall(SERVER)]);
    expect(plain.calls).toEqual([{ method: 'listSubscriptionsFor', args: [SERVER] }]);
  });

  it('adoptOrphan for a user at it throws X3 with no list call', async () => {
    const plain = plainProvider();
    getPaymentRegistry().register(plain.provider);
    const before = state();

    const reply = await w.op('adoptOrphan', USER, PLAIN, 'plain_1');

    expect(reply.ok).toBe(false);
    expect(reply.error).toContain('P1 Plain does not sell user subscriptions.');
    expect(plain.calls).toEqual([]);
    expect(state()).toEqual(before);
  });
});

describe('P1 claim 14 as P2 leaves it: the six providers that sell servers only, each by its own `sells`', () => {
  it('each sells servers; a user tier linking it is refused (X8), and a user purchase and adoption through it never reach it', async () => {
    const six: PaymentProvider[] = [new StripeProvider(), new LemonSqueezyProvider(), new PayPalProvider(), new PatreonProvider(), new ServerBoostingProvider(), new DiscordProvider()];
    const offering = (enabled: boolean) => ({
      id: 'o-useven', label: 'Seven monthly',
      providerLinks: six.map(p => ({ providerId: p.id, enabled, mode: 'price', priceConfig: { entries: [{ variantId: `${p.id}_v` }] } })),
    });
    expect((await w.op('setTier', 'useven', { ...userSoldTierDef('vlow', 'U Seven'), priority: 5, offerings: [offering(true)] })).ok).toBe(true);
    const outcomes: unknown[] = [];
    try {
      for (const p of six) {
        const configured = vi.spyOn(p, 'isConfigured').mockReturnValue(true);
        const bought = vi.spyOn(p, 'initiatePurchase');
        const listed = vi.spyOn(p as Required<PaymentProvider>, 'listSubscriptionsFor');
        getPaymentRegistry().register(p);
        expect((await w.op('setProviderActivation', p.id, true)).ok).toBe(true);
        const before = state();
        const askedBefore = configured.mock.calls.length;
        const purchase = await w.op('initiatePaidSubscription', USER, 'useven', 'o-useven', { providerId: p.id, variantId: `${p.id}_v`, buyerId: USERS[0] });
        const askedByPurchase = configured.mock.calls.length - askedBefore;
        const adopt = await w.op('adoptOrphan', USER, p.id, `${p.id}_1`);
        const tier = await w.op('setTier', 'useven2', { ...userSoldTierDef('vlow', 'U Seven 2'), priority: 4, offerings: [{ ...offering(false), providerLinks: [{ providerId: p.id, enabled: true, mode: 'price', priceConfig: { entries: [{ variantId: `${p.id}_v` }] } }] }] });
        outcomes.push([p.id, p.capabilities.sells, purchase.ok, purchase.error, askedByPurchase, adopt.ok, adopt.error, tier.ok, tier.error, bought.mock.calls.length, listed.mock.calls.length, state().premium === before.premium]);
      }
    } finally {
      for (const p of six) p.stop?.();
    }

    const x3 = (name: string) => `${name} does not sell user subscriptions.`;
    const x8 = (name: string) => `${name} does not sell user subscriptions; turn its link off on offering 'Seven monthly'.`;
    const row = (id: string, name: string) => [id, ['guild'], false, expect.stringContaining(x3(name)), 0, false, expect.stringContaining(x3(name)), false, expect.stringContaining(x8(name)), 0, 0, true];
    expect(outcomes).toEqual([
      row('stripe', 'Stripe'),
      row('lemonsqueezy', 'Lemon Squeezy'),
      row('paypal', 'PayPal'),
      row('patreon', 'Patreon'),
      row('boost', 'Server Boosting'),
      row('discord', 'Discord App Monetization'),
    ]);
  });
});

describe('P2 claim 3: the Dummy provider sells servers and users', () => {
  const dummyOffering = (offeringId: string, label: string) => ({
    id: offeringId, label,
    providerLinks: [{ providerId: 'dummy', enabled: true, mode: 'price', priceConfig: { entries: [{ variantId: 'dummy_monthly_999' }] } }],
  });

  it('declares both kinds; a user tier and a server tier with an enabled Dummy link are saved; a user purchase installs under the user with the user as buyer', async () => {
    const driver = dummyDriver();
    await driver.attach(null);
    try {
      const dummy = driver.provider();
      expect(dummy.capabilities.sells).toEqual(['guild', 'user']);
      expect(await w.op('setTier', 'udummy', { ...userSoldTierDef('vlow', 'U Dummy'), priority: 5, offerings: [dummyOffering('o-udummy', 'Dummy monthly')] })).toMatchObject({ ok: true });
      expect(await w.op('setTier', 'gdummy', { displayName: 'G Dummy', priority: 6, overrides: {}, offerings: [dummyOffering('o-gdummy', 'Dummy monthly')] })).toMatchObject({ ok: true });
      expect(w.stored().tiers.udummy).toMatchObject({ kind: 'user', offerings: [{ providerLinks: [{ providerId: 'dummy', enabled: true }] }] });
      expect(w.stored().tiers.gdummy.offerings[0].providerLinks[0]).toMatchObject({ providerId: 'dummy', enabled: true });
      expect((await w.op('setProviderActivation', 'dummy', true)).ok).toBe(true);

      const bought = await w.op('initiatePaidSubscription', USER, 'udummy', 'o-udummy', { providerId: 'dummy', variantId: 'dummy_monthly_999', buyerId: USERS[0] });

      expect(bought).toMatchObject({ ok: true });
      expect(w.recordOf(USER).active).toMatchObject({ tierId: 'udummy', providerId: 'dummy', buyerId: USERS[0] });
      expect(driver.view(w.recordOf(USER).active.providerSubId)).toMatchObject({ status: 'active' });
    } finally {
      await driver.detach();
    }
  });

  it('findOrphansFor a user asks the P1 seller and the Dummy', async () => {
    const driver = dummyDriver();
    await driver.attach(null);
    try {
      expect(await w.orphans(USER)).toEqual([]);
      expect(w.calls()).toEqual([sellerListCall(USER)]);
      expect(driver.calls()).toEqual([{ method: 'listSubscriptionsFor', args: [USER] }]);
    } finally {
      await driver.detach();
    }
  });
});

describe('P1 claim 14: a provider that sells users only', () => {
  it('a server purchase, a server listing and a server adoption never reach it', async () => {
    const usersOnly = plainProvider({ capabilities: { canInitiatePurchase: true, supportsCancel: true, supportsReactivate: false, supportsCoupons: false, supportsPause: true, mechanism: 'immediate', sells: ['user'] } });
    expect((await w.op('setTier', 'plain', { displayName: 'Plain', priority: 6, overrides: {}, offerings: [plainOffering('o-plain', 'Plain')] })).ok).toBe(true);
    getPaymentRegistry().register(usersOnly.provider);
    expect((await w.op('setProviderActivation', PLAIN, true)).ok).toBe(true);
    const before = state();

    const bought = await w.op('initiatePaidSubscription', SERVER, 'plain', 'o-plain', { providerId: PLAIN, variantId: PLAIN_VARIANT, buyerId: BUYER });
    const adopted = await w.op('adoptOrphan', SERVER, PLAIN, 'plain_1');
    await w.orphans(SERVER);

    expect(bought.ok).toBe(false);
    expect(bought.error).toContain('P1 Plain does not sell server subscriptions.');
    expect(adopted.ok).toBe(false);
    expect(adopted.error).toContain('P1 Plain does not sell server subscriptions.');
    expect(usersOnly.calls).toEqual([]);
    expect(state()).toEqual(before);
  });
});

describe('P1 claim 14: setTier and a link of a provider that does not sell the tier\'s kind (X8)', () => {
  it('a user tier with an enabled link of a provider that sells servers is refused and stores nothing; with the link off it is saved', async () => {
    getPaymentRegistry().register(plainProvider().provider);
    const before = state();
    const tier = (enabled: boolean) => ({ ...userSoldTierDef('vlow', 'U Plain'), priority: 5, offerings: [plainOffering('o-uplain', 'Plain monthly', enabled)] });

    const refused = await w.op('setTier', 'uplain', tier(true));

    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("P1 Plain does not sell user subscriptions; turn its link off on offering 'Plain monthly'.");
    expect(state()).toEqual(before);

    expect(await w.op('setTier', 'uplain', tier(false))).toMatchObject({ ok: true });
    expect(w.stored().tiers.uplain).toMatchObject({ kind: 'user', offerings: [{ id: 'o-uplain', providerLinks: [{ providerId: PLAIN, enabled: false }] }] });
  });

  it('a server tier with an enabled link of a provider that sells users only is refused; the seller, which sells both, is accepted on both kinds', async () => {
    getPaymentRegistry().register(plainProvider({ capabilities: { canInitiatePurchase: true, mechanism: 'immediate', sells: ['user'] } }).provider);
    const before = state();

    const refused = await w.op('setTier', 'plain', { displayName: 'Plain', priority: 6, overrides: {}, offerings: [sellerOffering('o-seller', 'Seller monthly'), plainOffering('o-plain', 'Plain monthly')] });

    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("P1 Plain does not sell server subscriptions; turn its link off on offering 'Plain monthly'.");
    expect(state()).toEqual(before);
    expect(await w.op('setTier', 'plain', { displayName: 'Plain', priority: 6, overrides: {}, offerings: [sellerOffering('o-seller', 'Seller monthly')] })).toMatchObject({ ok: true });
    expect(await w.op('setTier', 'uplain', { ...userSoldTierDef('vlow', 'U Plain'), priority: 5, offerings: [sellerOffering('o-seller', 'Seller monthly')] })).toMatchObject({ ok: true });
    expect(w.calls()).toEqual([]);
  });

  it('the seller sells a user: a purchase for a user is installed under the user\'s key', async () => {
    expect(await w.op('initiatePaidSubscription', USER, 'vmid', 'o-vmid', purchaseOptions(USER))).toMatchObject({ ok: true });
    expect(w.recordOf(USER).active).toMatchObject({ tierId: 'vmid', providerId: SELLER_ID, buyerId: USERS[0] });
    expect(Object.keys(w.stored().subscriptions)).toEqual([USER]);
  });
});
