import * as crypto from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { providerCredentialsPath, useSharedDocReader } from '../../src/utils/envLoader';
import { ServerBoostingProvider } from '../../src/bot/internalSetup/utils/payment/boostProvider';
import { DiscordProvider } from '../../src/bot/internalSetup/utils/payment/discordProvider';
import { LemonSqueezyProvider } from '../../src/bot/internalSetup/utils/payment/lemonsqueezyProvider';
import { PatreonProvider } from '../../src/bot/internalSetup/utils/payment/patreonProvider';
import { PayPalProvider } from '../../src/bot/internalSetup/utils/payment/paypalProvider';
import { StripeProvider } from '../../src/bot/internalSetup/utils/payment/stripeProvider';

// NB6 decision 57: on a Postgres bot a built-in provider's own keys come from the credentials doc, over /data/.env
// and the process env. Each row gives the env a different made-up value, so a read of the env alone shows.

type Doc = Record<string, Record<string, string | null>>;
let doc: Doc | null = null;
let unreadable: string | null = null;

type Call = { url: string; init: any };
let calls: Call[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function stubFetch(answer: (url: string, init: any) => Response): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
    calls.push({ url: String(url), init });
    return answer(String(url), init);
  }));
}

const hmacHex = (secret: string, text: string | Buffer) => crypto.createHmac('sha256', secret).update(text).digest('hex');

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  calls = [];
  doc = null;
  unreadable = null;
  useSharedDocReader(absPath => {
    if (absPath !== providerCredentialsPath()) return undefined;
    if (unreadable !== null) throw new Error(unreadable);
    return doc === null ? null : JSON.stringify(doc);
  });
});

afterEach(() => {
  useSharedDocReader(null);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Server Boosting', () => {
  it("the tick walks the doc's target server when the env names none", async () => {
    vi.stubEnv('BOOST_TARGET_GUILD_ID', undefined);
    doc = { boost: { BOOST_TARGET_GUILD_ID: '200000000000000002' } };
    const provider = new ServerBoostingProvider();
    (provider as any).client = { guilds: { fetch: vi.fn(), cache: new Map() } };
    // Past the target check the tick loads the premium manager by require, which this suite does not resolve.
    await expect((provider as any).tick()).rejects.toThrow(/premiumManager/);
  });
});

describe('Discord', () => {
  beforeEach(() => {
    vi.stubEnv('DISCORD_TOKEN', 'bot-token-made-up');
    vi.stubEnv('DISCORD_APPLICATION_ID', 'app-env');
    doc = { discord: { DISCORD_APPLICATION_ID: 'app-doc' } };
  });

  it("a SKU lookup lists the doc's application's SKUs", async () => {
    stubFetch(() => json([{ id: 'sku1', name: 'Gold' }]));
    const variant = await new DiscordProvider().fetchVariant('sku1');
    expect(variant).toMatchObject({ variantId: 'sku1', label: 'Gold' });
    expect(calls.map(c => c.url)).toEqual(['https://discord.com/api/v10/applications/app-doc/skus']);
  });

  it("a subscription read lists the doc's application's entitlements", async () => {
    stubFetch(() => json([{ id: 'e1', sku_id: 'sku1', type: 8, ends_at: null }]));
    const state = await new DiscordProvider().getSubscriptionState('e1');
    expect(state).not.toBeNull();
    expect(calls.map(c => c.url)).toEqual(['https://discord.com/api/v10/applications/app-doc/entitlements']);
  });
});

describe('Lemon Squeezy', () => {
  it("a checkout is created for the doc's store with the doc's API key", async () => {
    vi.stubEnv('LEMONSQUEEZY_API_KEY', 'ls-key-env');
    vi.stubEnv('LEMONSQUEEZY_STORE_ID', '111');
    doc = { lemonsqueezy: { LEMONSQUEEZY_API_KEY: 'ls-key-doc', LEMONSQUEEZY_STORE_ID: '222' } };
    stubFetch(() => json({ data: { attributes: { url: 'https://pay.example/checkout/1' } } }));
    const result = await new LemonSqueezyProvider().initiatePurchase({ guildId: 'g1', tierId: 't1', offeringId: 'o1', variantId: '9' } as any);
    expect(result).toEqual({ redirectUrl: 'https://pay.example/checkout/1' });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].init.body).data.relationships.store.data.id).toBe('222');
  });

  it("a webhook signed with the doc's secret is accepted", async () => {
    vi.stubEnv('LEMONSQUEEZY_WEBHOOK_SECRET', 'ls-whsec-env');
    doc = { lemonsqueezy: { LEMONSQUEEZY_WEBHOOK_SECRET: 'ls-whsec-doc' } };
    const body = Buffer.from(JSON.stringify({ meta: {} }));
    await expect(new LemonSqueezyProvider().handleWebhook(body, hmacHex('ls-whsec-doc', body), {})).resolves.toBeUndefined();
  });
});

describe('Patreon', () => {
  beforeEach(() => {
    vi.stubEnv('PATREON_CLIENT_ID', 'cid-env');
    vi.stubEnv('PATREON_CLIENT_SECRET', 'csec-env');
    vi.stubEnv('PATREON_CAMPAIGN_ID', '11');
    vi.stubEnv('PATREON_CREATOR_ACCESS_TOKEN', 'ctok-env');
    vi.stubEnv('WEBUI_BASE_URL', 'https://bot.example');
    doc = {
      patreon: {
        PATREON_CLIENT_ID: 'cid-doc', PATREON_CLIENT_SECRET: 'csec-doc', PATREON_CAMPAIGN_ID: '77', PATREON_CREATOR_ACCESS_TOKEN: 'ctok-doc',
      },
    };
  });

  const signed = (payload: Record<string, unknown>, secret: string) => {
    const bytes = Buffer.from(JSON.stringify(payload), 'utf-8');
    return `${bytes.toString('base64url')}.${crypto.createHmac('sha256', secret).update(bytes).digest().toString('base64url')}`;
  };

  it("the link's state is signed with the doc's client secret", async () => {
    const result = await new PatreonProvider().initiatePurchase({ guildId: 'g1', tierId: 't1', offeringId: 'o1', variantId: 'tier:5' } as any);
    const params = new URL(result.oauthUrl!).searchParams;
    expect(params.get('client_id')).toBe('cid-doc');
    const state = params.get('state')!;
    const [body, sig] = state.split('.');
    const expected = crypto.createHmac('sha256', 'csec-doc').update(Buffer.from(body, 'base64url')).digest().toString('base64url');
    expect(sig).toBe(expected);
  });

  it("a callback whose state the doc's secret signed passes to the code exchange, sent with the doc's client", async () => {
    stubFetch(() => json({ error: 'invalid_client' }, 401));
    const state = signed({ guildId: '123456789012345678', tierId: 'gold', variantId: 'tier:5' }, 'csec-doc');
    await expect(new PatreonProvider().handleOAuthCallback({ code: 'c0de', state })).rejects.toThrow('Patreon token exchange failed: 401');
    expect(calls).toHaveLength(1);
    const sent = new URLSearchParams(String(calls[0].init.body));
    expect(sent.get('client_id')).toBe('cid-doc');
    expect(sent.get('client_secret')).toBe('csec-doc');
  });

  it("a variant lookup reads the doc's campaign with the doc's creator token", async () => {
    stubFetch(() => json({ included: [{ type: 'tier', id: '5', attributes: { title: 'Gold', amount_cents: 500, published: true } }] }));
    const variant = await new PatreonProvider().fetchVariant('tier:5');
    expect(variant).toMatchObject({ variantId: 'tier:5', label: 'Gold', amount: 500 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://www.patreon.com/api/oauth2/v2/campaigns/77?include=tiers&fields[tier]=title,amount_cents,published');
    expect(calls[0].init.headers).toEqual({ Authorization: 'Bearer ctok-doc' });
  });
});

describe('PayPal', () => {
  it("a webhook is verified against the doc's webhook id", async () => {
    vi.stubEnv('PAYPAL_CLIENT_ID', 'pid');
    vi.stubEnv('PAYPAL_CLIENT_SECRET', 'psec');
    vi.stubEnv('PAYPAL_WEBHOOK_ID', 'WH-ENV');
    doc = { paypal: { PAYPAL_WEBHOOK_ID: 'WH-DOC' } };
    stubFetch(url => url.endsWith('/v1/oauth2/token')
      ? json({ access_token: 'ptok', expires_in: 3600 })
      : json({ verification_status: 'SUCCESS' }));
    const body = Buffer.from(JSON.stringify({ event_type: 'BILLING.SUBSCRIPTION.UPDATED', resource: {} }));
    await expect(new PayPalProvider().handleWebhook(body, '', {})).resolves.toBeUndefined();
    const verify = calls.find(c => c.url.endsWith('/v1/notifications/verify-webhook-signature'));
    expect(JSON.parse(verify!.init.body).webhook_id).toBe('WH-DOC');
  });
});

describe('Stripe', () => {
  it("a webhook signed with the doc's secret is accepted", async () => {
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec-env');
    doc = { stripe: { STRIPE_WEBHOOK_SECRET: 'whsec-doc' } };
    const raw = JSON.stringify({ type: 'checkout.session.completed', data: {} });
    const header = `t=1700000000,v1=${hmacHex('whsec-doc', `1700000000.${raw}`)}`;
    await expect(new StripeProvider().handleWebhook(Buffer.from(raw), header)).resolves.toBeUndefined();
  });

  it('a doc that turns unreadable during the price lookup is logged when the redirect address is read', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', undefined);
    vi.stubEnv('OAUTH_CALLBACK_URL', undefined);
    doc = { stripe: { STRIPE_SECRET_KEY: 'sk_test_doc' } };
    stubFetch(() => {
      unreadable = 'the doc went unreadable mid-purchase';
      return json({ id: 'price_1', active: true, unit_amount: 500, currency: 'usd', type: 'one_time', product: 'prod_1' });
    });
    await expect(new StripeProvider().initiatePurchase({ guildId: 'g1', tierId: 't1', offeringId: 'o1', variantId: 'price_1' } as any))
      .rejects.toThrow('STRIPE: OAUTH_CALLBACK_URL is not set');
    expect(calls).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith(
      "[Payment] payment-providers/credentials.json cannot be read (the doc went unreadable mid-purchase); the built-in providers' keys read as not set until it can be read",
    );
  });
});
