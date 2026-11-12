import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { providerCredentialsPath, useSharedDocReader } from '../../src/utils/envLoader';
import { DiscordProvider } from '../../src/bot/internalSetup/utils/payment/discordProvider';
import { PayPalProvider } from '../../src/bot/internalSetup/utils/payment/paypalProvider';

// L5 run A, chunk 81: each read of the credentials doc a provider call makes, with a reader that answers each read
// in turn, so a read that fails is logged and a read that answers is used.

let errors: string[] = [];
let calls: string[] = [];
let answers: Array<string | Error> = [];

beforeEach(() => {
  errors = [];
  calls = [];
  answers = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  useSharedDocReader(absPath => {
    if (absPath !== providerCredentialsPath()) return undefined;
    const next = answers.length > 1 ? answers.shift()! : answers[0];
    if (next instanceof Error) throw next;
    return next;
  });
});

afterEach(() => {
  useSharedDocReader(null);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Discord: a cancel reads the doc for the application and again for the call', () => {
  it('a second read that fails is logged, though the first one answered', async () => {
    vi.stubEnv('DISCORD_TOKEN', 'bot-token-made-up');
    vi.stubEnv('DISCORD_APPLICATION_ID', undefined);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url));
      return new Response(null, { status: 204 });
    }));
    answers = [JSON.stringify({ discord: { DISCORD_APPLICATION_ID: 'app-doc' } }), new Error('ra81 discord second read')];
    await new DiscordProvider().cancelSubscription('e1');
    expect(calls).toEqual(['https://discord.com/api/v10/applications/app-doc/entitlements/e1']);
    expect(errors.filter(e => e.includes('cannot be read (ra81 discord second read)'))).toHaveLength(1);
  });
});

describe('PayPal: a purchase reads the doc for its return address and again for its configuration', () => {
  it('a first read that fails is logged, and the second read that answers configures the purchase', async () => {
    vi.stubEnv('PAYPAL_CLIENT_ID', undefined);
    vi.stubEnv('PAYPAL_CLIENT_SECRET', undefined);
    vi.stubEnv('PAYPAL_WEBHOOK_ID', undefined);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url));
      throw new Error('ra81 no network');
    }));
    answers = [
      new Error('ra81 paypal first read'),
      JSON.stringify({ paypal: { PAYPAL_CLIENT_ID: 'id-doc', PAYPAL_CLIENT_SECRET: 'secret-doc', PAYPAL_WEBHOOK_ID: 'hook-doc' } }),
    ];
    await expect(new PayPalProvider().initiatePurchase({
      guildId: '880000000000000081', tierId: 't1', offeringId: 'o1', variantId: 'P-1', autoRenew: true,
    } as any)).rejects.toThrow('ra81 no network');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/\/v1\/oauth2\/token$/);
    expect(errors.filter(e => e.includes('cannot be read (ra81 paypal first read)'))).toHaveLength(1);
  });
});
