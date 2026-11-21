import { afterEach, describe, expect, it, vi } from 'vitest';

import { StripeProvider } from '../../src/bot/internalSetup/utils/payment/stripeProvider';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const sub = (over: Record<string, unknown> = {}) => ({
  id: 'sub_sa2', status: 'active', cancel_at_period_end: false, current_period_start: 1762000000, current_period_end: 1764000000,
  start_date: 1762000000, pause_collection: null, metadata: { guildId: '70000000000000001', tierId: 't', offeringId: 'o' }, ...over,
});

function stub(answer: (url: string) => unknown) {
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_sa2');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const fetch = vi.fn(async (_url: string) => new Response(JSON.stringify(answer(_url)), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const listed = async (s: Record<string, unknown>) => {
  stub(url => (url.includes('/search') ? { data: [s], has_more: false } : { data: [] }));
  const refs = await new StripeProvider().listSubscriptionsFor('guild:70000000000000001');
  expect(refs).toHaveLength(1);
  return refs[0];
};

const stateOf = async (s: Record<string, unknown>) => {
  stub(() => s);
  const state = await new StripeProvider().getSubscriptionState('sub_sa2');
  expect(state).not.toBeNull();
  return state!;
};

describe('metadata[pausedDaysLeft] read back from a listed subscription', () => {
  it.each(['20@1762732800x', '20@1762732800 ', '20@1762732800@5'])("'%s' with text after the pause time gives neither field", async value => {
    const ref = await listed(sub({ metadata: { guildId: '70000000000000001', tierId: 't', offeringId: 'o', pausedDaysLeft: value } }));
    expect(ref.metadata.pausedDaysLeft).toBeUndefined();
    expect(ref.metadata.pausedAt).toBeUndefined();
  });
});

describe('the metadata of a listed subscription', () => {
  const priced = (metadata: Record<string, string>) => sub({
    metadata: { guildId: '70000000000000001', tierId: 't', offeringId: 'o', ...metadata },
    items: { data: [{ id: 'si_1', price: { id: 'price_live', active: true, currency: 'usd', unit_amount: 500, type: 'recurring', recurring: { interval: 'month', interval_count: 1 }, product: 'prod_1' } }] },
  });

  it('with no variantId in metadata, the variant is the price of the first item', async () => {
    const ref = await listed(priced({}));
    expect(ref.metadata.variantId).toBe('price_live');
  });

  it('a variantId in metadata wins over the price of the first item', async () => {
    const ref = await listed(priced({ variantId: 'price_meta' }));
    expect(ref.metadata.variantId).toBe('price_meta');
  });

  it('couponCode, and userId as buyerId, in metadata are carried; empty ones are left out', async () => {
    const ref = await listed(priced({ couponCode: 'SAVE10', userId: '80000000000000002' }));
    expect(ref.metadata.couponCode).toBe('SAVE10');
    expect(ref.metadata.buyerId).toBe('80000000000000002');
    const empty = await listed(priced({ couponCode: '', userId: '' }));
    expect(empty.metadata.couponCode).toBeUndefined();
    expect(empty.metadata.buyerId).toBeUndefined();
  });
});

describe('the state of a fetched subscription', () => {
  it('a subscription that renews has autoRenew true and the full meta', async () => {
    const state = await stateOf(sub({ trial_end: 1764500000 }));
    expect(state.autoRenew).toBe(true);
    expect(state.meta).toEqual({
      stripeStatus: 'active',
      cancelAtPeriodEnd: false,
      pauseCollection: null,
      currentPeriodStart: new Date(1762000000 * 1000).toISOString(),
      trialEnd: new Date(1764500000 * 1000).toISOString(),
    });
  });

  it('a subscription set to cancel at period end has autoRenew false', async () => {
    const state = await stateOf(sub({ cancel_at_period_end: true }));
    expect(state.autoRenew).toBe(false);
    expect(state.meta).toMatchObject({ cancelAtPeriodEnd: true });
  });

  it("a paused collection shows its behavior in meta, and no trial_end gives trialEnd null", async () => {
    const state = await stateOf(sub({ pause_collection: { behavior: 'void' } }));
    expect(state.meta).toMatchObject({ pauseCollection: 'void', trialEnd: null });
  });
});

describe('the resume POST', () => {
  it("sends proration_behavior 'none'", async () => {
    const fetch = stub(() => sub());
    await new StripeProvider().resumeSubscription('sub_sa2', null);
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URLSearchParams(String(init.body)).get('proration_behavior')).toBe('none');
  });
});
