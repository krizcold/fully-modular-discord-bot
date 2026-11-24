import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/utils/envLoader', async orig => ({
  ...(await orig<any>()),
  loadCredentials: () => ({ DISCORD_APPLICATION_ID: '4242', DISCORD_TOKEN: 'test-token' }),
  providerCredentials: () => ({ DISCORD_APPLICATION_ID: '4242', DISCORD_TOKEN: 'test-token' }),
}));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', () => ({
  getPaymentRegistry: () => ({ emitEvent: () => undefined }),
}));

import { DiscordProvider } from '../../src/bot/internalSetup/utils/payment/discordProvider';

// The Discord provider's REST call: the route, the method, the bot's authorization and a bound on the wait.

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a Discord REST call', () => {
  it('reads one entitlement with GET, the bot token and a timeout signal', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 'ent1', sku_id: 'sku1', application_id: '4242', user_id: '80000000000000001', type: 8, deleted: false, starts_at: null, ends_at: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const state = await new DiscordProvider().getSubscriptionState('ent1');
    expect(state).toMatchObject({ status: 'active', endDate: null, autoRenew: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://discord.com/api/v10/applications/4242/entitlements/ent1');
    expect(calls[0].init.method).toBe('GET');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bot test-token');
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });
});
