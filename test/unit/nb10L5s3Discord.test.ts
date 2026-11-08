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

// The Discord provider's REST call: the method, the bot's authorization and a bound on the wait.

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a Discord REST call', () => {
  it('cancels with DELETE, the bot token and a timeout signal', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    });
    await new DiscordProvider().cancelSubscription('ent1');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://discord.com/api/v10/applications/4242/entitlements/ent1');
    expect(calls[0].init.method).toBe('DELETE');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bot test-token');
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });
});
