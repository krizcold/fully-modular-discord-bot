import { afterEach, describe, expect, it, vi } from 'vitest';

import { StripeProvider } from '../../src/bot/internalSetup/utils/payment/stripeProvider';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function answer(body: string) {
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_sbp');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const fetch = vi.fn(async (_url: string) => new Response(body, { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('a resume POST that Stripe answers with a JSON null', () => {
  // The premium manager logs a resume failure with the error's message; a raw property read on null names no subscription.
  it('never fails with a message that leaves out the subscription', async () => {
    const fetch = answer('null');
    const outcome = await new StripeProvider().resumeSubscription('sub_sbp', null).then(() => null, (e: unknown) => e as Error);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toContain('/v1/subscriptions/sub_sbp');
    if (outcome !== null) {
      expect(outcome).not.toBeInstanceOf(TypeError);
      expect(outcome.message).toContain('sub_sbp');
    }
  });
});
