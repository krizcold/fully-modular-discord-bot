import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import { loadCredentials, providerCredentials } from '../../src/utils/envLoader';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { _resetRowQueue } from '../../src/bot/internalSetup/utils/sharedStore';
import { StripeProvider } from '../../src/bot/internalSetup/utils/payment/stripeProvider';
import { PayPalProvider } from '../../src/bot/internalSetup/utils/payment/paypalProvider';
import { PatreonProvider } from '../../src/bot/internalSetup/utils/payment/patreonProvider';
import { DiscordProvider } from '../../src/bot/internalSetup/utils/payment/discordProvider';
import { ServerBoostingProvider } from '../../src/bot/internalSetup/utils/payment/boostProvider';
import { setBackendKind } from '../helpers/backendKind';

// NB6 test 73 (wip-redesign/sheets/NB6.md, D's table; decision 57 under owner question 2's answer (a); part 24): the
// built-in providers' keys on a Postgres bot. The doc is written by the facade's own save; /data/.env is a temp file
// under the test's data root. Every value is made up, and rows compare values, never print them.

const DOC = { scope: 'global' as const, category: 'payment-providers' };
const DOC_PATH = dataPath('global', 'payment-providers', 'credentials.json');
const ENV_PATH = dataPath('.env');

type Doc = Record<string, Record<string, string | null>>;

function writeEnv(values: Record<string, string>): void {
  fs.writeFileSync(ENV_PATH, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(''));
  loadCredentials();
}

function saveDoc(doc: Doc): void {
  expect(dm.saveDataTracked('credentials.json', DOC, doc).outcome).toBe('saved');
}

type Call = { url: string; init: any };
let calls: Call[] = [];
function stubFetch(answer: (url: string) => unknown): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(answer(String(url))), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  calls = [];
  _resetRowQueue();
  fs.rmSync(DOC_PATH, { force: true });
  setBackendKind('postgres');
});

afterEach(() => {
  writeEnv({});
  fs.rmSync(ENV_PATH, { force: true });
  _resetRowQueue();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('providerCredentials', () => {
  it('a key the doc holds wins over /data/.env', () => {
    writeEnv({ STRIPE_SECRET_KEY: 'sk_test_env_made_up', STRIPE_WEBHOOK_SECRET: 'whsec_env_made_up' });
    saveDoc({ stripe: { STRIPE_SECRET_KEY: 'sk_test_doc_made_up', STRIPE_WEBHOOK_SECRET: 'whsec_doc_made_up' } });
    const keys = providerCredentials('stripe');
    expect(keys.STRIPE_SECRET_KEY === 'sk_test_doc_made_up').toBe(true);
    expect(keys.STRIPE_WEBHOOK_SECRET === 'whsec_doc_made_up').toBe(true);
  });

  it('null in the doc means not set, though /data/.env holds the key', () => {
    writeEnv({ STRIPE_SECRET_KEY: 'sk_test_env_made_up', STRIPE_WEBHOOK_SECRET: 'whsec_env_made_up' });
    saveDoc({ stripe: { STRIPE_SECRET_KEY: null, STRIPE_WEBHOOK_SECRET: 'whsec_doc_made_up' } });
    const keys = providerCredentials('stripe');
    expect(keys.STRIPE_SECRET_KEY).toBeUndefined();
    expect(keys.STRIPE_WEBHOOK_SECRET === 'whsec_doc_made_up').toBe(true);
    expect(new StripeProvider().isConfigured()).toBe(false);
  });

  it('a key the doc lacks is read from /data/.env, and so is every key of a provider the doc has no entry for', () => {
    writeEnv({ STRIPE_WEBHOOK_SECRET: 'whsec_env_made_up', PAYPAL_CLIENT_ID: 'pp_env_made_up' });
    saveDoc({ stripe: { STRIPE_SECRET_KEY: 'sk_test_doc_made_up' } });
    expect(providerCredentials('stripe').STRIPE_WEBHOOK_SECRET === 'whsec_env_made_up').toBe(true);
    expect(providerCredentials('paypal').PAYPAL_CLIENT_ID === 'pp_env_made_up').toBe(true);
  });

  it('with no doc, every key is read from /data/.env', () => {
    writeEnv({ STRIPE_SECRET_KEY: 'sk_test_env_made_up' });
    expect(providerCredentials('stripe').STRIPE_SECRET_KEY === 'sk_test_env_made_up').toBe(true);
  });

  it('a doc entry applies only to its own provider and only to that provider\'s keys', () => {
    writeEnv({ DISCORD_TOKEN: 'token_env_made_up', WEBUI_BASE_URL: 'https://env.example' });
    saveDoc({ stripe: { PAYPAL_CLIENT_ID: 'pp_doc_made_up', DISCORD_TOKEN: 'token_doc_made_up', WEBUI_BASE_URL: 'https://doc.example' } });
    const stripe = providerCredentials('stripe');
    expect(stripe.PAYPAL_CLIENT_ID).toBeUndefined();
    expect(stripe.DISCORD_TOKEN === 'token_env_made_up').toBe(true);
    expect(stripe.WEBUI_BASE_URL === 'https://env.example').toBe(true);
    expect(providerCredentials('paypal').PAYPAL_CLIENT_ID).toBeUndefined();
  });

  it('a doc that cannot be read leaves the provider\'s keys not set; the keys the doc never holds still come from /data/.env', () => {
    writeEnv({ PATREON_CLIENT_ID: 'pc_env_made_up', WEBUI_BASE_URL: 'https://env.example' });
    fs.mkdirSync(dataPath('global', 'payment-providers'), { recursive: true });
    fs.writeFileSync(DOC_PATH, '{ not json');
    const keys = providerCredentials('patreon');
    expect(keys.PATREON_CLIENT_ID).toBeUndefined();
    expect(keys.WEBUI_BASE_URL === 'https://env.example').toBe(true);
  });

  it('a doc whose entry is not an object of strings and nulls is read as one that cannot be read', () => {
    writeEnv({ STRIPE_SECRET_KEY: 'sk_test_env_made_up' });
    saveDoc({ stripe: { STRIPE_SECRET_KEY: 7 as unknown as string } });
    expect(providerCredentials('stripe').STRIPE_SECRET_KEY).toBeUndefined();
  });

  it('a JSON bot reads no doc: its keys stay in /data/.env', () => {
    writeEnv({ STRIPE_SECRET_KEY: 'sk_test_env_made_up' });
    fs.mkdirSync(dataPath('global', 'payment-providers'), { recursive: true });
    fs.writeFileSync(DOC_PATH, JSON.stringify({ stripe: { STRIPE_SECRET_KEY: 'sk_test_doc_made_up' } }));
    setBackendKind('file');
    expect(providerCredentials('stripe').STRIPE_SECRET_KEY === 'sk_test_env_made_up').toBe(true);
  });

  it('a custom provider reads its keys from the environment alone', () => {
    writeEnv({ STRIPE_SECRET_KEY: 'sk_test_env_made_up' });
    saveDoc({ custompay: { STRIPE_SECRET_KEY: 'sk_test_doc_made_up' } });
    expect(providerCredentials('custompay').STRIPE_SECRET_KEY === 'sk_test_env_made_up').toBe(true);
  });
});

describe('the built-in providers read their keys through providerCredentials', () => {
  it('Stripe: configured from the doc, and its API calls carry the doc\'s secret', async () => {
    writeEnv({ STRIPE_SECRET_KEY: 'sk_test_env_made_up' });
    saveDoc({ stripe: { STRIPE_SECRET_KEY: 'sk_test_doc_made_up', STRIPE_WEBHOOK_SECRET: 'whsec_doc_made_up' } });
    const stripe = new StripeProvider();
    expect(stripe.isConfigured()).toBe(true);
    stubFetch(() => ({ id: 'sub_made_up', status: 'canceled' }));
    await stripe.cancelSubscription('sub_made_up', true);
    expect(calls).toHaveLength(1);
    expect(calls[0].init.headers.Authorization === 'Bearer sk_test_doc_made_up').toBe(true);
  });

  it('PayPal: configured from the doc; the token request uses the doc\'s client id, secret and environment', async () => {
    writeEnv({ PAYPAL_CLIENT_ID: 'pp_env_made_up', PAYPAL_ENV: 'sandbox' });
    saveDoc({ paypal: { PAYPAL_ENV: 'live', PAYPAL_CLIENT_ID: 'pp_doc_made_up', PAYPAL_CLIENT_SECRET: 'pps_doc_made_up', PAYPAL_WEBHOOK_ID: 'wh_doc_made_up' } });
    const paypal = new PayPalProvider();
    expect(paypal.isConfigured()).toBe(true);
    stubFetch(url => url.endsWith('/v1/oauth2/token') ? { access_token: 'tok_made_up', expires_in: 3600 } : { id: 'I-1', status: 'ACTIVE' });
    await paypal.getSubscriptionState('I-1');
    expect(calls[0].url).toBe('https://api-m.paypal.com/v1/oauth2/token');
    const basic = Buffer.from('pp_doc_made_up:pps_doc_made_up').toString('base64');
    expect(calls[0].init.headers.Authorization === `Basic ${basic}`).toBe(true);
  });

  it('Patreon: configured from the doc\'s keys with WEBUI_BASE_URL from /data/.env, and not without the creator token; a variant lookup uses the doc\'s campaign and creator token', async () => {
    writeEnv({ WEBUI_BASE_URL: 'https://bot.example', PATREON_CLIENT_ID: 'pc_env_made_up' });
    saveDoc({ patreon: { PATREON_CLIENT_ID: 'pc_doc_made_up', PATREON_CLIENT_SECRET: 'pcs_doc_made_up', PATREON_CAMPAIGN_ID: '77' } });
    expect(new PatreonProvider().isConfigured()).toBe(false);
    saveDoc({ patreon: { PATREON_CLIENT_ID: 'pc_doc_made_up', PATREON_CLIENT_SECRET: 'pcs_doc_made_up', PATREON_CAMPAIGN_ID: '77', PATREON_CREATOR_ACCESS_TOKEN: 'pct_doc_made_up' } });
    const patreon = new PatreonProvider();
    expect(patreon.isConfigured()).toBe(true);
    stubFetch(() => ({ included: [{ type: 'tier', id: '5', attributes: { title: 'Gold', amount_cents: 500, published: true } }] }));
    expect(await patreon.fetchVariant('tier:5')).toMatchObject({ variantId: 'tier:5', label: 'Gold' });
    expect(calls[0].url).toBe('https://www.patreon.com/api/oauth2/v2/campaigns/77?include=tiers&fields[tier]=title,amount_cents,published');
    expect(calls[0].init.headers.Authorization === 'Bearer pct_doc_made_up').toBe(true);
  });

  it('Patreon: a key cleared in the doc leaves it not configured', () => {
    writeEnv({ WEBUI_BASE_URL: 'https://bot.example', PATREON_CLIENT_ID: 'pc_env_made_up', PATREON_CLIENT_SECRET: 'pcs_env_made_up', PATREON_CAMPAIGN_ID: '77', PATREON_CREATOR_ACCESS_TOKEN: 'pct_env_made_up' });
    expect(new PatreonProvider().isConfigured()).toBe(true);
    saveDoc({ patreon: { PATREON_CLIENT_ID: null } });
    expect(new PatreonProvider().isConfigured()).toBe(false);
  });
});

describe('the second half of the built-in providers read their keys through providerCredentials', () => {
  it("Discord: configured from the doc's application id with the bot token from /data/.env; its API calls use both", async () => {
    writeEnv({ DISCORD_TOKEN: 'token_env_made_up', DISCORD_APPLICATION_ID: '100000000000000001' });
    saveDoc({ discord: { DISCORD_APPLICATION_ID: '100000000000000002', DISCORD_TOKEN: 'token_doc_made_up' } });
    const discord = new DiscordProvider();
    expect(discord.isConfigured()).toBe(true);
    stubFetch(() => ({ id: 'ent1', sku_id: 'sku1', application_id: '100000000000000002', user_id: '80000000000000001', type: 8, deleted: false, starts_at: null, ends_at: null }));
    await discord.getSubscriptionState('ent1');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://discord.com/api/v10/applications/100000000000000002/entitlements/ent1');
    expect(calls[0].init.headers.Authorization === 'Bot token_env_made_up').toBe(true);
  });

  it('Discord: the application id cleared in the doc leaves it not configured', () => {
    writeEnv({ DISCORD_TOKEN: 'token_env_made_up', DISCORD_APPLICATION_ID: '100000000000000001' });
    expect(new DiscordProvider().isConfigured()).toBe(true);
    saveDoc({ discord: { DISCORD_APPLICATION_ID: null } });
    expect(new DiscordProvider().isConfigured()).toBe(false);
  });

  it("Server Boosting: configured from the doc's target server, which the purchase instruction names", async () => {
    writeEnv({ BOOST_TARGET_GUILD_ID: '200000000000000001' });
    saveDoc({ boost: { BOOST_TARGET_GUILD_ID: '200000000000000002' } });
    const boost = new ServerBoostingProvider();
    boost.setClient({} as any);
    expect(boost.isConfigured()).toBe(true);
    const answer = await boost.initiatePurchase({ holder: 'guild:70000000000000001', buyerId: '80000000000000001', tierId: 't1', offeringId: 'o1', variantId: 'boost' } as any);
    const instruction = (answer.clientHandoff as any).instruction as string;
    expect(instruction.includes('(server id: 200000000000000002)')).toBe(true);
    expect(instruction.includes('200000000000000001')).toBe(false);
  });

  it('Server Boosting: the target server cleared in the doc leaves it not configured', () => {
    writeEnv({ BOOST_TARGET_GUILD_ID: '200000000000000001' });
    const boost = new ServerBoostingProvider();
    boost.setClient({} as any);
    expect(boost.isConfigured()).toBe(true);
    saveDoc({ boost: { BOOST_TARGET_GUILD_ID: null } });
    expect(boost.isConfigured()).toBe(false);
  });
});
