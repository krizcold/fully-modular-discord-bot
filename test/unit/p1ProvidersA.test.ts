import * as crypto from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const emitted = vi.hoisted(() => [] as any[]);
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', () => ({
  getPaymentRegistry: () => ({ emitEvent: (event: unknown) => { emitted.push(event); } }),
}));

import { StripeProvider } from '../../src/bot/internalSetup/utils/payment/stripeProvider';
import { LemonSqueezyProvider } from '../../src/bot/internalSetup/utils/payment/lemonsqueezyProvider';
import { PayPalProvider } from '../../src/bot/internalSetup/utils/payment/paypalProvider';

// P1 sheet section 8 claim 13 (first file): Stripe, Lemon Squeezy and PayPal keep their wire for a server and speak
// holders to premium.

const G = '70000000000000001';
const B = '80000000000000001';
const purchase = {
  holder: `guild:${G}` as const, buyerId: B, tierId: 't1', offeringId: 'o1',
};

let logs: string[];
beforeEach(() => {
  emitted.length = 0;
  logs = [];
  vi.stubEnv('MAIN_GUILD_ID', '1');
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type Call = { url: string; init?: RequestInit };
function stubFetch(answer: (url: string, init?: RequestInit) => unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(answer(String(url), init)), { status: 200 });
  }));
  return calls;
}

describe('Stripe', () => {
  const secret = 'whsec_p1';
  const sign = (body: string) => {
    const t = '1762000000';
    return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
  };
  const sub = (metadata: Record<string, string>, id = 'sub_1') => ({
    id, status: 'active', cancel_at_period_end: false, current_period_start: 1762000000, current_period_end: 1764000000,
    start_date: 1762000000, pause_collection: null, metadata,
  });
  const env = () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_p1');
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', secret);
    vi.stubEnv('OAUTH_CALLBACK_URL', 'https://bot.example/oauth');
  };
  const price = {
    id: 'price_1', active: true, currency: 'usd', unit_amount: 500, type: 'recurring',
    recurring: { interval: 'month', interval_count: 1 }, product: { id: 'prod_1', name: 'Gold', active: true },
  };
  const webhook = async (type: string, object: unknown) => {
    const body = JSON.stringify({ type, data: { object } });
    await new StripeProvider().handleWebhook(Buffer.from(body), sign(body));
  };

  it('sells servers only', () => {
    expect(new StripeProvider().capabilities.sells).toEqual(['guild']);
  });

  it("a server purchase sends today's fields plus subscription_data[metadata][userId]", async () => {
    env();
    const calls = stubFetch(url => (url.includes('/v1/prices/') ? price : { id: 'cs_1', url: 'https://checkout.example/cs_1' }));
    await new StripeProvider().initiatePurchase({ ...purchase, variantId: 'price_1' });
    const post = calls.find(c => c.url.endsWith('/v1/checkout/sessions'))!;
    expect(String(post.init!.body)).toBe(new URLSearchParams({
      mode: 'subscription',
      'line_items[0][price]': 'price_1',
      'line_items[0][quantity]': '1',
      success_url: `https://bot.example/guild/${G}/subscription?subscribe=success&session={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://bot.example/guild/${G}/subscription?subscribe=cancel`,
      client_reference_id: `${G}:t1:o1`,
      'metadata[guildId]': G,
      'metadata[tierId]': 't1',
      'metadata[offeringId]': 'o1',
      'metadata[variantId]': 'price_1',
      'metadata[couponCode]': '',
      'metadata[userId]': B,
      'subscription_data[metadata][guildId]': G,
      'subscription_data[metadata][tierId]': 't1',
      'subscription_data[metadata][offeringId]': 'o1',
      'subscription_data[metadata][variantId]': 'price_1',
      'subscription_data[metadata][couponCode]': '',
      'subscription_data[metadata][userId]': B,
    }).toString());
  });

  it('a purchase for a user throws X3 without a request', async () => {
    env();
    const calls = stubFetch(() => ({}));
    await expect(new StripeProvider().initiatePurchase({ ...purchase, holder: `user:${B}`, variantId: 'price_1' }))
      .rejects.toThrow('Stripe does not sell user subscriptions.');
    expect(calls).toHaveLength(0);
  });

  it('the checkout webhook emits the holder and the buyer its session held', async () => {
    env();
    stubFetch(() => sub({ guildId: G, tierId: 't1', offeringId: 'o1' }));
    await webhook('checkout.session.completed', {
      id: 'cs_1', subscription: 'sub_1', metadata: { guildId: G, tierId: 't1', offeringId: 'o1', variantId: 'price_1', userId: B },
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: 'subscription.created', providerSubId: 'sub_1', holder: `guild:${G}`, buyerId: B });
  });

  it('the four later events carry the holder', async () => {
    env();
    const s = sub({ guildId: G, tierId: 't1', offeringId: 'o1' });
    stubFetch(() => s);
    await webhook('customer.subscription.updated', s);
    await webhook('customer.subscription.deleted', s);
    await webhook('invoice.paid', { subscription: 'sub_1' });
    await webhook('invoice.payment_failed', { subscription: 'sub_1' });
    expect(emitted.map(e => [e.type, e.holder])).toEqual([
      ['subscription.updated', `guild:${G}`],
      ['subscription.expired', `guild:${G}`],
      ['subscription.renewed', `guild:${G}`],
      ['subscription.renewal-failed', `guild:${G}`],
    ]);
  });

  it('each later event for a subscription without metadata.guildId resolves, emits nothing and logs nothing', async () => {
    env();
    const s = sub({ tierId: 't1' });
    stubFetch(() => s);
    const outcomes: string[] = [];
    for (const [type, obj] of [
      ['customer.subscription.updated', s], ['customer.subscription.deleted', s],
      ['invoice.paid', { subscription: 'sub_1' }], ['invoice.payment_failed', { subscription: 'sub_1' }],
    ] as const) {
      outcomes.push(await webhook(type, obj).then(() => 'ok', (e: Error) => e.message));
    }
    expect(outcomes).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(emitted).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('the list returns the buyer of a subscription with the new key and none for one without', async () => {
    env();
    const withBuyer = sub({ guildId: G, tierId: 't1', offeringId: 'o1', userId: B }, 'sub_a');
    const without = sub({ guildId: G, tierId: 't1', offeringId: 'o1' }, 'sub_b');
    stubFetch(url => (url.includes('/search') ? { data: [withBuyer], has_more: false } : { data: [without] }));
    const refs = await new StripeProvider().listSubscriptionsFor(`guild:${G}`);
    const byId = Object.fromEntries(refs.map(r => [r.providerSubId, r.metadata]));
    expect(byId.sub_a).toMatchObject({ holder: `guild:${G}`, buyerId: B });
    expect(byId.sub_b.holder).toBe(`guild:${G}`);
    expect(byId.sub_b.buyerId).toBeUndefined();
  });

  it("a user's list is empty without a request", async () => {
    env();
    const calls = stubFetch(() => ({ data: [] }));
    expect(await new StripeProvider().listSubscriptionsFor(`user:${B}`)).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('Lemon Squeezy', () => {
  const secret = 'ls_p1';
  const env = () => {
    vi.stubEnv('LEMONSQUEEZY_API_KEY', 'key_p1');
    vi.stubEnv('LEMONSQUEEZY_STORE_ID', '12345');
    vi.stubEnv('LEMONSQUEEZY_WEBHOOK_SECRET', secret);
  };
  const webhook = async (eventName: string, custom: Record<string, string>) => {
    const body = JSON.stringify({
      meta: { event_name: eventName, custom_data: custom },
      data: { id: '77', attributes: { status: 'active', variant_id: 5, renews_at: '2026-12-21T00:00:00.000Z', ends_at: null } },
    });
    const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
    await new LemonSqueezyProvider().handleWebhook(Buffer.from(body), sig, {});
  };

  it('sells servers only', () => {
    expect(new LemonSqueezyProvider().capabilities.sells).toEqual(['guild']);
  });

  it("a server purchase sends today's custom data", async () => {
    env();
    const calls = stubFetch(() => ({ data: { attributes: { url: 'https://ls.example/c' } } }));
    await new LemonSqueezyProvider().initiatePurchase({ ...purchase, variantId: '5' });
    expect(calls).toHaveLength(1);
    expect(String(calls[0].init!.body)).toBe(JSON.stringify({
      data: {
        type: 'checkouts',
        attributes: {
          checkout_data: { custom: { guildId: G, tierId: 't1', offeringId: 'o1', variantId: '5', userId: B } },
          checkout_options: { embed: false },
        },
        relationships: {
          store: { data: { type: 'stores', id: '12345' } },
          variant: { data: { type: 'variants', id: '5' } },
        },
      },
    }));
  });

  it('a purchase for a user throws X3 without a request', async () => {
    env();
    const calls = stubFetch(() => ({}));
    await expect(new LemonSqueezyProvider().initiatePurchase({ ...purchase, holder: `user:${B}`, variantId: '5' }))
      .rejects.toThrow('Lemon Squeezy does not sell user subscriptions.');
    expect(calls).toHaveLength(0);
  });

  it('webhook events carry the holder, and the created one the buyer of custom.userId', async () => {
    env();
    await webhook('subscription_created', { guildId: G, tierId: 't1', offeringId: 'o1', variantId: '5', userId: B });
    await webhook('subscription_updated', { guildId: G });
    expect(emitted[0]).toMatchObject({ type: 'subscription.created', holder: `guild:${G}`, buyerId: B, tierId: 't1' });
    expect(emitted[1]).toMatchObject({ type: 'subscription.updated', holder: `guild:${G}` });
  });

  it('an id that is not a Discord id emits nothing and logs nothing', async () => {
    env();
    const outcomes: string[] = [];
    for (const name of ['subscription_created', 'subscription_updated', 'subscription_payment_success']) {
      outcomes.push(await webhook(name, { guildId: 'not-a-server', tierId: 't1', offeringId: 'o1' }).then(() => 'ok', (e: Error) => e.message));
    }
    expect(outcomes).toEqual(['ok', 'ok', 'ok']);
    expect(emitted).toEqual([]);
    expect(logs).toEqual([]);
  });

  it("a user's list is empty without a request", async () => {
    env();
    const calls = stubFetch(() => ({}));
    expect(await new LemonSqueezyProvider().listSubscriptionsFor(`user:${B}`)).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('PayPal', () => {
  const env = () => {
    vi.stubEnv('PAYPAL_CLIENT_ID', 'id_p1');
    vi.stubEnv('PAYPAL_CLIENT_SECRET', 'secret_p1');
    vi.stubEnv('PAYPAL_WEBHOOK_ID', 'hook_p1');
    vi.stubEnv('WEBUI_BASE_URL', 'https://bot.example');
  };
  const answer = (url: string) => {
    if (url.endsWith('/v1/oauth2/token')) return { access_token: 'tok', expires_in: 3600 };
    if (url.endsWith('/verify-webhook-signature')) return { verification_status: 'SUCCESS' };
    return { id: 'I-1', links: [{ rel: 'approve', href: 'https://paypal.example/approve' }] };
  };
  const webhook = async (eventType: string, custom: Record<string, string>) => {
    const body = JSON.stringify({
      event_type: eventType,
      resource: { id: 'I-1', plan_id: 'P-1', status: 'ACTIVE', custom_id: JSON.stringify(custom) },
    });
    await new PayPalProvider().handleWebhook(Buffer.from(body), '', {});
  };

  it('sells servers only', () => {
    expect(new PayPalProvider().capabilities.sells).toEqual(['guild']);
  });

  it("a server purchase sends today's custom_id", async () => {
    env();
    const calls = stubFetch(answer);
    await new PayPalProvider().initiatePurchase({ ...purchase, variantId: 'P-1' });
    const post = calls.find(c => c.url.endsWith('/v1/billing/subscriptions'))!;
    expect(String(post.init!.body)).toBe(JSON.stringify({
      plan_id: 'P-1',
      custom_id: JSON.stringify({ guildId: G, tierId: 't1', offeringId: 'o1', userId: B }),
      application_context: {
        brand_name: 'Discord Bot Premium',
        user_action: 'SUBSCRIBE_NOW',
        return_url: `https://bot.example/guild/${G}/subscription?subscribe=success`,
        cancel_url: `https://bot.example/guild/${G}/subscription?subscribe=cancel`,
      },
    }));
  });

  it('a purchase for a user throws X3 without a request', async () => {
    env();
    const calls = stubFetch(answer);
    await expect(new PayPalProvider().initiatePurchase({ ...purchase, holder: `user:${B}`, variantId: 'P-1' }))
      .rejects.toThrow('PayPal does not sell user subscriptions.');
    expect(calls).toHaveLength(0);
  });

  it('webhook events carry the holder, and the created one the buyer of custom_id.userId', async () => {
    env();
    stubFetch(answer);
    await webhook('BILLING.SUBSCRIPTION.ACTIVATED', { guildId: G, tierId: 't1', offeringId: 'o1', userId: B });
    await webhook('BILLING.SUBSCRIPTION.UPDATED', { guildId: G });
    expect(emitted[0]).toMatchObject({ type: 'subscription.created', holder: `guild:${G}`, buyerId: B, tierId: 't1' });
    expect(emitted[1]).toMatchObject({ type: 'subscription.updated', holder: `guild:${G}` });
  });

  it('an id that is not a Discord id emits nothing and logs nothing', async () => {
    env();
    stubFetch(answer);
    const outcomes: string[] = [];
    for (const type of ['BILLING.SUBSCRIPTION.ACTIVATED', 'BILLING.SUBSCRIPTION.UPDATED', 'PAYMENT.SALE.COMPLETED']) {
      outcomes.push(await webhook(type, { guildId: 'not-a-server', tierId: 't1' }).then(() => 'ok', (e: Error) => e.message));
    }
    expect(outcomes).toEqual(['ok', 'ok', 'ok']);
    expect(emitted).toEqual([]);
    expect(logs).toEqual([]);
  });

  it("a user's list is empty without a request", async () => {
    env();
    const calls = stubFetch(answer);
    expect(await new PayPalProvider().listSubscriptionsFor(`user:${B}`)).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
