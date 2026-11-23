import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P3 claim 12 (sheet P3, section 7): the Checkout Session's parameters for a server bought on the member route and a
// user bought on the dev user route, the order of a purchase (nothing is written and no Customer is made before the
// price, the coupon and the return host pass), Stripe selling both kinds, and the list by holder. The real
// PremiumManager in the bot role over the JSON files, the real StripeProvider, the fake of helpers/p3Stripe.ts.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());
vi.mock('../../src/bot/internalSetup/utils/appStoreManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/appStoreManager')>();
  const store = { getCachedModules: () => [], getRepositories: () => [], getInstalledModules: () => [], getAvailableModules: async () => [] };
  return { ...real, getAppStoreManager: () => store };
});

import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { HOST, IDS, PRICES, p3World } from '../helpers/p3World';

const w = p3World('json');
const A = IDS[0];
const B = IDS[1];
const G1 = '72000000000000001';
const G2 = '72000000000000002';

const metadata = (prefix: string, holder: string, buyerId: string, tierId: string, variantId: string) => ({
  [`${prefix}[holder]`]: holder,
  [`${prefix}[buyerId]`]: buyerId,
  [`${prefix}[tierId]`]: tierId,
  [`${prefix}[offeringId]`]: `o-${tierId}`,
  [`${prefix}[variantId]`]: variantId,
  [`${prefix}[couponCode]`]: '',
});

beforeEach(async () => {
  for (const level of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
  await w.setup();
});
afterEach(async () => {
  await w.teardown();
  vi.restoreAllMocks();
});

describe('the Checkout Session', () => {
  it("a server's subscription on the member route sends exactly section 3's parameters", async () => {
    const bought = await w.buyMember(`guild:${G1}`, A);
    expect(bought.body.success).toBe(true);
    const customer = [...w.fake.customers.keys()][0];
    expect(w.fake.sessionParams.get(bought.sessionId!)).toEqual({
      mode: 'subscription',
      'line_items[0][price]': PRICES.gold.monthly,
      'line_items[0][quantity]': '1',
      success_url: `${HOST}/guild/${G1}/subscription?subscribe=success&session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${HOST}/guild/${G1}/subscription?subscribe=cancel`,
      customer,
      client_reference_id: `guild:${G1}:gold:o-gold`,
      ...metadata('metadata', `guild:${G1}`, A, 'gold', PRICES.gold.monthly),
      ...metadata('subscription_data[metadata]', `guild:${G1}`, A, 'gold', PRICES.gold.monthly),
    });
    expect(w.stored().subscriptions?.[`guild:${G1}`]).toBeUndefined();
  });

  it("a user's subscription on the dev user route returns to /guild and names no customer", async () => {
    const bought = await w.buyDev(`user:${B}`, B);
    expect(bought.body.success).toBe(true);
    expect(w.fake.sessionParams.get(bought.sessionId!)).toEqual({
      mode: 'subscription',
      'line_items[0][price]': PRICES.vip.monthly,
      'line_items[0][quantity]': '1',
      success_url: `${HOST}/guild?subscribe=success&session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${HOST}/guild?subscribe=cancel`,
      client_reference_id: `user:${B}:vip:o-vip`,
      ...metadata('metadata', `user:${B}`, B, 'vip', PRICES.vip.monthly),
      ...metadata('subscription_data[metadata]', `user:${B}`, B, 'vip', PRICES.vip.monthly),
    });
    expect(w.stored().subscriptions?.[`user:${B}`]).toBeUndefined();
  });

  it("a one-time price sends mode 'payment' with the same metadata and no subscription_data", async () => {
    const bought = await w.buyMember(`guild:${G1}`, A, 'once');
    expect(bought.body.success).toBe(true);
    const params = w.fake.sessionParams.get(bought.sessionId!)!;
    expect(params.mode).toBe('payment');
    expect(Object.fromEntries(Object.entries(params).filter(([k]) => k.startsWith('metadata[')))).toEqual(metadata('metadata', `guild:${G1}`, A, 'gold', PRICES.gold.once));
    expect(Object.keys(params).filter(k => k.startsWith('subscription_data'))).toEqual([]);
    expect(w.stored().subscriptions?.[`guild:${G1}`]).toBeUndefined();
  });
});

describe('the order of a purchase', () => {
  const steps: Array<[string, () => Record<string, unknown>]> = [
    ['a missing price', () => { w.fake.prices.delete(PRICES.gold.monthly); return {}; }],
    ['a refused coupon', () => ({ couponCode: 'NOPE' })],
    ['an unset OAUTH_CALLBACK_URL', () => { delete process.env.OAUTH_CALLBACK_URL; return {}; }],
  ];
  for (const [what, arrange] of steps) {
    it(`${what} makes no Customer and no doc write`, async () => {
      const refused = await w.buyMember(`guild:${G1}`, A, 'monthly', arrange());
      expect(refused.body.success).toBe(false);
      expect(w.fake.callsOf('POST', /./)).toEqual([]);
      expect(w.customersText()).toBeNull();
    });
  }
});

describe('Stripe sells both kinds', () => {
  it("names guild and user in sells, and a user's purchase passes premium's checks to the provider", async () => {
    expect(getPaymentRegistry().get('stripe')!.capabilities.sells).toEqual(['guild', 'user']);
    const bought = await w.buyDev(`user:${A}`, A);
    expect(bought.body.success).toBe(true);
    expect(bought.sessionId).not.toBeNull();
  });
});

describe('the list by holder', () => {
  /** Two server subscriptions at the fake, one per server, completed and paid; and one with only the old keys. */
  async function arrange(): Promise<{ mine: string; theirs: string; old: string }> {
    const first = await w.buyMember(`guild:${G1}`, A);
    const second = await w.buyMember(`guild:${G2}`, B);
    const mine = w.fake.complete(first.sessionId!).subscription as string;
    const theirs = w.fake.complete(second.sessionId!).subscription as string;
    const old = JSON.parse(JSON.stringify(w.fake.subscriptions.get(mine)));
    old.id = 'sub_old_keys';
    old.metadata = { guildId: G1, userId: A, tierId: 'gold', offeringId: 'o-gold', variantId: PRICES.gold.monthly };
    w.fake.subscriptions.set(old.id, old);
    return { mine, theirs, old: old.id };
  }
  const stripe = () => getPaymentRegistry().get('stripe')!;

  it('the search names the holder, and each ref carries holder and buyerId', async () => {
    const { mine } = await arrange();
    const refs = await stripe().listSubscriptionsFor!(`guild:${G1}`);
    const search = w.fake.calls.find(c => c.path.startsWith('/v1/subscriptions/search'))!;
    expect(new URL(`https://x${search.path}`).searchParams.get('query')).toBe(`metadata['holder']:'guild:${G1}'`);
    expect(refs.map(r => [r.providerSubId, r.metadata.holder, r.metadata.buyerId])).toEqual([[mine, `guild:${G1}`, A]]);
  });

  it("a search answer for another holder, or with only guildId, is not listed", async () => {
    const { mine } = await arrange();
    vi.spyOn(w.fake as any, 'searchMatches').mockReturnValue(true);
    const refs = await stripe().listSubscriptionsFor!(`guild:${G1}`);
    expect(refs.map(r => r.providerSubId)).toEqual([mine]);
  });

  it('the list fallback filters the same way', async () => {
    const { mine } = await arrange();
    w.fake.fail('GET', /^\/v1\/subscriptions\/search/, { status: 500 });
    const refs = await stripe().listSubscriptionsFor!(`guild:${G1}`);
    expect(refs.map(r => [r.providerSubId, r.metadata.holder, r.metadata.buyerId])).toEqual([[mine, `guild:${G1}`, A]]);
  });

  it("a user's list is read the same way", async () => {
    const bought = await w.buyDev(`user:${B}`, B);
    const sub = w.fake.complete(bought.sessionId!).subscription as string;
    const refs = await stripe().listSubscriptionsFor!(`user:${B}`);
    expect(refs.map(r => [r.providerSubId, r.metadata.holder, r.metadata.buyerId])).toEqual([[sub, `user:${B}`, B]]);
  });
});
