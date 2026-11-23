import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P3 claim 13: premium sells only the offering's own variants, for every provider, and the member route marks its
// buyer. The real PremiumManager in the bot role over the JSON files, the real StripeProvider with the fake of
// helpers/p3Stripe.ts, and the real DummyProvider. A variant that is not among a price-mode link's entries, or not
// active in a product-mode link's cache, is refused with X13 before any provider call: the fake records no call and the
// Dummy's state.json keeps its bytes. A listed variant is sold. The member route's purchase reaches the provider with
// `buyerSignedIn` true; both dev routes' purchases reach it without.
// Stripe's user rows buy on the dev user route, the one route that sells a user at this tree.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());
vi.mock('../../src/bot/internalSetup/utils/appStoreManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/appStoreManager')>();
  const store = { getCachedModules: () => [], getRepositories: () => [], getInstalledModules: () => [], getAvailableModules: async () => [] };
  return { ...real, getAppStoreManager: () => store };
});

import { dataPath } from '../../src/utils/dataRoot';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { DummyProvider } from '../../src/bot/internalSetup/utils/payment/dummyProvider';
import { IDS, PRICES, UNLINKED_PRICE, p3World } from '../helpers/p3World';

const w = p3World('json');
const SERVER = `guild:${IDS[0]}`;
const BUYER = IDS[1];
const USER = `user:${IDS[1]}`;
const DUMMY_STATE = dataPath('global', 'payment-providers', 'dummy', 'state.json');
const D = {
  weekly: { variantId: 'dummy_weekly_249', label: 'Weekly', amount: 249, currency: 'USD', durationDays: 7, recurring: true, active: true },
  monthly: { variantId: 'dummy_monthly_999', label: 'Monthly', amount: 999, currency: 'USD', durationDays: 30, recurring: true, active: true },
  yearly: { variantId: 'dummy_yearly_9999', label: 'Yearly (save 16%)', amount: 9999, currency: 'USD', durationDays: 365, recurring: true, active: true },
};

const x13 = (label: string, variantId: string, provider: string): string => `Offering '${label}' does not sell variant '${variantId}' through ${provider}.`;

/** A tier with one offering whose one link is the given provider's, in price mode or product mode. */
function tierDef(name: string, kind: 'guild' | 'user', providerId: string, mode: 'price' | 'product', entries: string[], variants: object[]) {
  return {
    displayName: name,
    priority: 1,
    overrides: {},
    ...(kind === 'user' ? { kind: 'user' } : {}),
    offerings: [{
      id: `o-${name.toLowerCase()}`,
      label: name,
      providerLinks: [{
        providerId,
        enabled: true,
        mode,
        ...(mode === 'price'
          ? { priceConfig: { entries: entries.map(variantId => ({ variantId })) } }
          : { productConfig: { productId: providerId === 'stripe' ? 'prod_gold' : 'dummy_product_standard' } }),
        cache: { syncedAt: '2026-11-22T00:00:00.000Z', variants },
      }],
    }],
  };
}

const stripeVariants = () => [
  { variantId: PRICES.gold.monthly, label: 'Gold monthly', amount: 500, currency: 'USD', durationDays: 30, recurring: true, active: true },
  { variantId: PRICES.gold.once, label: 'Gold lifetime', amount: 5000, currency: 'USD', durationDays: null, recurring: false, active: false },
];

let dummy: DummyProvider;
const dummyBytes = (): string | null => (fs.existsSync(DUMMY_STATE) ? fs.readFileSync(DUMMY_STATE, 'utf8') : null);

async function saveTier(tierId: string, def: object): Promise<void> {
  const saved = await w.op('setTier', tierId, def);
  if (!saved.ok) throw new Error(`setTier ${tierId} was not saved: ${saved.error}`);
}

beforeEach(async () => {
  await w.setup();
  dummy = new DummyProvider();
  getPaymentRegistry().register(dummy);
  await dummy.fetchVariant(D.monthly.variantId);
  await w.settle();
  const activated = await w.op('setProviderActivation', 'dummy', true);
  if (!activated.ok) throw new Error(`the Dummy was not activated: ${activated.error}`);
  await saveTier('pgold', tierDef('PGold', 'guild', 'stripe', 'product', [], stripeVariants()));
  await saveTier('dgold', tierDef('DGold', 'guild', 'dummy', 'price', [D.monthly.variantId], [D.monthly, D.yearly]));
  await saveTier('dvip', tierDef('DVip', 'user', 'dummy', 'price', [D.monthly.variantId], [D.monthly, D.yearly]));
  await saveTier('dprod', tierDef('DProd', 'guild', 'dummy', 'product', [], [D.monthly, { ...D.yearly, active: false }]));
  await w.settle();
});

afterEach(async () => {
  dummy.dispose();
  getPaymentRegistry().unregister('dummy');
  await w.teardown();
  vi.restoreAllMocks();
});

describe('Stripe: only the offering link\'s variants are sold', () => {
  it('refuses a price that is not among the price-mode entries with X13 and no call to Stripe', async () => {
    const calls = w.fake.calls.length;
    const refused = await w.buyMember(SERVER, BUYER, 'monthly', { variantId: UNLINKED_PRICE });
    expect(refused.body.success).toBe(false);
    expect(refused.body.error).toContain(x13('Gold', UNLINKED_PRICE, 'Stripe'));
    expect(refused.sessionId).toBeNull();
    expect(w.fake.calls.slice(calls)).toEqual([]);
    expect(w.fake.unexpected).toEqual([]);
  });

  it('sells a price among the price-mode entries', async () => {
    const sold = await w.buyMember(SERVER, BUYER, 'monthly');
    expect(sold.body.success).toBe(true);
    expect(sold.sessionId).not.toBeNull();
  });

  it('refuses in product mode a cached variant that is not active and one not cached, and sells an active one', async () => {
    const more = (variantId: string) => ({ tierId: 'pgold', offeringId: 'o-pgold', variantId });
    const calls = w.fake.calls.length;
    const inactive = await w.buyMember(SERVER, BUYER, 'monthly', more(PRICES.gold.once));
    const uncached = await w.buyMember(SERVER, BUYER, 'monthly', more(UNLINKED_PRICE));
    expect([inactive.body.error, uncached.body.error]).toEqual([
      expect.stringContaining(x13('PGold', PRICES.gold.once, 'Stripe')),
      expect.stringContaining(x13('PGold', UNLINKED_PRICE, 'Stripe')),
    ]);
    expect([inactive.sessionId, uncached.sessionId]).toEqual([null, null]);
    expect(w.fake.calls.slice(calls)).toEqual([]);
    const sold = await w.buyMember(SERVER, BUYER, 'monthly', more(PRICES.gold.monthly));
    expect(sold.body.success).toBe(true);
    expect(sold.sessionId).not.toBeNull();
  });
});

describe('Stripe for a user: only the offering link\'s variants are sold', () => {
  it('refuses on the dev user route a price that is not among the vip entries with X13 and no call to Stripe, and sells a listed one', async () => {
    const calls = w.fake.calls.length;
    const refused = await w.buyDev(USER, IDS[1], 'monthly', { variantId: PRICES.gold.monthly });
    expect(refused.body.success).toBe(false);
    expect(refused.body.error).toContain(x13('VIP', PRICES.gold.monthly, 'Stripe'));
    expect(refused.sessionId).toBeNull();
    expect(w.fake.calls.slice(calls)).toEqual([]);
    const sold = await w.buyDev(USER, IDS[1]);
    expect(sold.body.success).toBe(true);
    expect(sold.sessionId).not.toBeNull();
  });
});

describe('the Dummy: only the offering link\'s variants are sold', () => {
  const buy = (holder: string, tierId: string, variantId: string) =>
    w.op('initiatePaidSubscription', holder, tierId, `o-${tierId}`, { providerId: 'dummy', variantId, buyerId: BUYER });

  for (const [kind, holder, tierId, label] of [['server', SERVER, 'dgold', 'DGold'], ['user', USER, 'dvip', 'DVip']] as const) {
    it(`refuses for a ${kind} a variant that is not among the price-mode entries, keeping state.json's bytes, and sells a listed one`, async () => {
      const before = dummyBytes();
      const refused = await buy(holder, tierId, D.yearly.variantId);
      expect(refused.ok).toBe(false);
      expect(refused.error).toContain(x13(label, D.yearly.variantId, 'Dummy (Development)'));
      expect(dummyBytes()).toBe(before);
      expect((w.stored()?.subscriptions ?? {})[holder]?.active).toBeUndefined();
      const sold = await buy(holder, tierId, D.monthly.variantId);
      expect(sold.ok).toBe(true);
      expect(w.stored().subscriptions[holder].active).toMatchObject({ providerId: 'dummy', variantId: D.monthly.variantId });
    });
  }

  it('refuses in product mode a cached variant that is not active and one not cached, and sells an active one', async () => {
    const before = dummyBytes();
    const inactive = await buy(SERVER, 'dprod', D.yearly.variantId);
    const uncached = await buy(SERVER, 'dprod', D.weekly.variantId);
    expect([inactive.error, uncached.error]).toEqual([
      expect.stringContaining(x13('DProd', D.yearly.variantId, 'Dummy (Development)')),
      expect.stringContaining(x13('DProd', D.weekly.variantId, 'Dummy (Development)')),
    ]);
    expect(dummyBytes()).toBe(before);
    const sold = await buy(SERVER, 'dprod', D.monthly.variantId);
    expect(sold.ok).toBe(true);
  });
});

describe('the member route marks its buyer', () => {
  it('reaches the provider with buyerSignedIn true from the member route and without it from both dev routes', async () => {
    const seen: Array<[string, unknown]> = [];
    const stripe = getPaymentRegistry().get('stripe')!;
    const realStripe = stripe.initiatePurchase.bind(stripe);
    vi.spyOn(stripe, 'initiatePurchase').mockImplementation(async opts => {
      seen.push(['stripe', opts.buyerSignedIn]);
      return realStripe(opts);
    });
    const realDummy = dummy.initiatePurchase.bind(dummy);
    vi.spyOn(dummy, 'initiatePurchase').mockImplementation(async opts => {
      seen.push(['dummy', opts.buyerSignedIn]);
      return realDummy(opts);
    });
    const member = await w.buyMember(SERVER, BUYER);
    const devServer = await w.buyDev(`guild:${IDS[1]}`, BUYER);
    const devUser = await w.buyDev(USER, IDS[1], 'monthly', { tierId: 'dvip', offeringId: 'o-dvip', providerId: 'dummy', variantId: D.monthly.variantId });
    expect([member.body.success, devServer.body.success, devUser.body.success]).toEqual([true, true, true]);
    expect(seen).toEqual([['stripe', true], ['stripe', undefined], ['dummy', undefined]]);
  });
});
