import { afterEach, describe, expect, it, vi } from 'vitest';

import { PaymentProviderRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { StripeProvider } from '../../src/bot/internalSetup/utils/payment/stripeProvider';
import { LemonSqueezyProvider } from '../../src/bot/internalSetup/utils/payment/lemonsqueezyProvider';
import { isCoreOwnedGlobalFile, isInternalGlobalRel } from '../../src/bot/internalSetup/utils/configDiscovery';
import type { PaymentProvider } from '../../src/bot/internalSetup/utils/payment/paymentTypes';

// NB10 survivors, chunk 13: the provider ticks start only in the bot process, a failed start is logged, the provider
// fetches go to the provider's API with their credentials and bound, and the premium events log stays core-owned.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const provider = (id: string, start: () => void): PaymentProvider => ({ id, start, stop: () => undefined } as unknown as PaymentProvider);

describe('the payment registry tickers', () => {
  it('startTickers outside the bot process arms nothing: a provider registered after it, once the role reads bot, does not start', () => {
    vi.stubEnv('BOT_PROCESS_ROLE', 'webui');
    const registry = new PaymentProviderRegistry();
    registry.startTickers();
    vi.stubEnv('BOT_PROCESS_ROLE', 'bot');
    const start = vi.fn();
    registry.register(provider('late', start));
    expect(start).not.toHaveBeenCalled();
  });

  it('a provider whose start throws is logged by name with its error, and the next provider still starts', () => {
    vi.stubEnv('BOT_PROCESS_ROLE', 'bot');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const registry = new PaymentProviderRegistry();
    const boom = new Error('start broke');
    registry.register(provider('bad', () => { throw boom; }));
    const next = vi.fn();
    registry.register(provider('good', next));
    expect(() => registry.startTickers()).not.toThrow();
    expect(next).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith("[PaymentRegistry] start() failed for 'bad':", boom);
  });
});

describe('the provider API calls', () => {
  it('Stripe cancels at once with a DELETE to api.stripe.com/v1/subscriptions/<id>', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_s13');
    const fetch = vi.fn(async () => new Response(JSON.stringify({ id: 'sub_s13', status: 'canceled' }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await new StripeProvider().cancelSubscription('sub_s13', true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.stripe.com/v1/subscriptions/sub_s13');
    expect(init.method).toBe('DELETE');
  });

  it('Lemon Squeezy cancels with a DELETE to its v1 API, carrying the key and an abort signal', async () => {
    vi.stubEnv('LEMONSQUEEZY_API_KEY', 'ls_key_s13');
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    await new LemonSqueezyProvider().cancelSubscription('77');
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe('https://api.lemonsqueezy.com/v1/subscriptions/77');
    expect(init.method).toBe('DELETE');
    expect(init.headers.Authorization).toBe('Bearer ls_key_s13');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('the core-owned global files', () => {
  it('premium-tiers.events.jsonl is core-owned, so the Config surfaces neither list nor write it', () => {
    expect(isCoreOwnedGlobalFile('premium-tiers.events.jsonl')).toBe(true);
    expect(isInternalGlobalRel('premium-tiers.events.jsonl')).toBe(true);
    expect(isCoreOwnedGlobalFile('')).toBe(false);
  });
});
