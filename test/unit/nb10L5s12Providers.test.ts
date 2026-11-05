import * as crypto from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_FETCH_MS } from '../../src/bot/internalSetup/utils/payment/paymentTypes';
import { PatreonProvider } from '../../src/bot/internalSetup/utils/payment/patreonProvider';
import { PayPalProvider } from '../../src/bot/internalSetup/utils/payment/paypalProvider';

// NB10 test 28 (the requests themselves): each provider request goes to its address with its method, headers and
// body, and carries the 30 s abort signal.

type Call = { url: string; init: any };
let calls: Call[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function stubFetch(answer: (url: string) => Response): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
    calls.push({ url: String(url), init });
    return answer(String(url));
  }));
}

/** The 30 s signal the provider passes, told apart from any other by the AbortSignal.timeout spy. */
let signals: AbortSignal[] = [];
beforeEach(() => {
  calls = [];
  signals = [];
  const real = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    const s = real(ms);
    if (ms === PROVIDER_FETCH_MS) signals.push(s);
    return s;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const PATREON_TOKEN = 'https://www.patreon.com/api/oauth2/token';
const PATREON_IDENTITY = 'https://www.patreon.com/api/oauth2/v2/identity?include=memberships,memberships.currently_entitled_tiers,memberships.campaign&fields[member]=patron_status,currently_entitled_amount_cents';
const REDIRECT = 'https://bot.example/guild/api/subscriptions/patreon/callback';

function signedState(payload: Record<string, unknown>, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf-8');
  const sig = crypto.createHmac('sha256', secret).update(body).digest();
  return `${body.toString('base64url')}.${sig.toString('base64url')}`;
}

describe('the Patreon requests', () => {
  it('the OAuth callback posts the code exchange, then reads the identity with the token', async () => {
    vi.stubEnv('PATREON_CLIENT_ID', 'cid');
    vi.stubEnv('PATREON_CLIENT_SECRET', 'csec');
    vi.stubEnv('PATREON_CAMPAIGN_ID', '77');
    vi.stubEnv('WEBUI_BASE_URL', 'https://bot.example');
    stubFetch(url => url === PATREON_TOKEN
      ? json({ access_token: 'tok' })
      : json({
        data: { id: 'u1' },
        included: [{ type: 'member', attributes: { patron_status: 'active_patron' }, relationships: { campaign: { data: { id: '77' } }, currently_entitled_tiers: { data: [{ id: '5' }] } } }],
      }));
    const provider = new PatreonProvider();
    const state = signedState({ guildId: '123456789012345678', tierId: 'gold', offeringId: 'o1', variantId: 'tier:5' }, 'csec');
    const result = await provider.handleOAuthCallback({ code: 'c0de', state });
    expect(result).toMatchObject({ externalAccountId: 'u1', guildId: '123456789012345678', tierId: 'gold', variantId: 'tier:5' });
    expect(calls.map(c => c.url)).toEqual([PATREON_TOKEN, PATREON_IDENTITY]);
    const [token, identity] = calls;
    expect(token.init.method).toBe('POST');
    expect(token.init.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });
    expect(Object.fromEntries(new URLSearchParams(String(token.init.body)))).toEqual({
      code: 'c0de', grant_type: 'authorization_code', client_id: 'cid', client_secret: 'csec', redirect_uri: REDIRECT,
    });
    expect(token.init.signal).toBe(signals[0]);
    expect(identity.init.headers).toEqual({ Authorization: 'Bearer tok' });
    expect(identity.init.signal).toBe(signals[1]);
  });

  it('with no client secret set, the code exchange sends an empty one', async () => {
    vi.stubEnv('PATREON_CLIENT_ID', 'cid');
    vi.stubEnv('WEBUI_BASE_URL', 'https://bot.example');
    stubFetch(() => json({ error: 'invalid_client' }, 401));
    const state = signedState({ guildId: '123456789012345678', tierId: 'gold', variantId: 'tier:5' }, '');
    await expect(new PatreonProvider().handleOAuthCallback({ code: 'c0de', state })).rejects.toThrow('Patreon token exchange failed: 401');
    expect(calls).toHaveLength(1);
    expect(new URLSearchParams(String(calls[0].init.body)).get('client_secret')).toBe('');
  });

  it('a variant lookup reads the campaign with the creator token', async () => {
    vi.stubEnv('PATREON_CAMPAIGN_ID', '77');
    vi.stubEnv('PATREON_CREATOR_ACCESS_TOKEN', 'ctok');
    stubFetch(() => json({ included: [{ type: 'tier', id: '5', attributes: { title: 'Gold', amount_cents: 500, published: true } }] }));
    const variant = await new PatreonProvider().fetchVariant('tier:5');
    expect(variant).toMatchObject({ variantId: 'tier:5', label: 'Gold', amount: 500, active: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://www.patreon.com/api/oauth2/v2/campaigns/77?include=tiers&fields[tier]=title,amount_cents,published');
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.headers).toEqual({ Authorization: 'Bearer ctok' });
    expect(calls[0].init.signal).toBe(signals[0]);
  });
});

describe('the PayPal requests', () => {
  it('a subscription read takes a token with the client credentials, then reads the subscription with it', async () => {
    vi.stubEnv('PAYPAL_CLIENT_ID', 'pid');
    vi.stubEnv('PAYPAL_CLIENT_SECRET', 'psec');
    stubFetch(url => url.endsWith('/v1/oauth2/token')
      ? json({ access_token: 'ptok', expires_in: 3600 })
      : json({ id: 'I-1', status: 'ACTIVE', plan_id: 'P-1', start_time: '2026-10-01T00:00:00Z', billing_info: { next_billing_time: '2026-11-01T00:00:00Z' } }));
    const state = await new PayPalProvider().getSubscriptionState('I-1');
    expect(state).toMatchObject({ status: 'active', endDate: '2026-11-01T00:00:00Z' });
    expect(calls.map(c => c.url)).toEqual(['https://api-m.sandbox.paypal.com/v1/oauth2/token', 'https://api-m.sandbox.paypal.com/v1/billing/subscriptions/I-1']);
    const [token, read] = calls;
    expect(token.init.method).toBe('POST');
    expect(token.init.headers).toEqual({
      Authorization: `Basic ${Buffer.from('pid:psec').toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect(token.init.body).toBe('grant_type=client_credentials');
    expect(token.init.signal).toBe(signals[0]);
    expect(read.init.method).toBe('GET');
    expect(read.init.headers).toEqual({ Authorization: 'Bearer ptok', 'Content-Type': 'application/json', Accept: 'application/json' });
    expect(read.init.signal).toBe(signals[1]);
  });
});
