import * as crypto from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const emitted = vi.hoisted(() => [] as any[]);
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', () => ({
  getPaymentRegistry: () => ({ emitEvent: (event: unknown) => { emitted.push(event); } }),
}));

import { PatreonProvider } from '../../src/bot/internalSetup/utils/payment/patreonProvider';
import { ServerBoostingProvider } from '../../src/bot/internalSetup/utils/payment/boostProvider';
import { DiscordProvider } from '../../src/bot/internalSetup/utils/payment/discordProvider';
import { doesNotSellText } from '../../src/bot/internalSetup/utils/premiumHolder';

// P1 sheet section 8 claim 13 (second file): Patreon and Server Boosting keep their wire for a server and speak
// holders to premium. Discord's store sells users only (sheet P6, claim 12): a user entitlement's events name the user.

const G = '70000000000000001';
const B = '80000000000000001';
const U = '90000000000000001';
const purchase = { holder: `guild:${G}` as const, buyerId: B, tierId: 't1', offeringId: 'o1' };
const userPurchase = { holder: `user:${U}` as const, buyerId: U, tierId: 't1', offeringId: 'o1' };

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

describe('Patreon', () => {
  const secret = 'csec';
  const env = () => {
    vi.stubEnv('PATREON_CLIENT_ID', 'cid');
    vi.stubEnv('PATREON_CLIENT_SECRET', secret);
    vi.stubEnv('PATREON_CAMPAIGN_ID', '77');
    vi.stubEnv('WEBUI_BASE_URL', 'https://bot.example');
  };
  const sign = (payload: Record<string, unknown>) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf-8');
    return `${body.toString('base64url')}.${crypto.createHmac('sha256', secret).update(body).digest().toString('base64url')}`;
  };
  const patron = () => stubFetch(url => (url.includes('/token')
    ? { access_token: 'tok' }
    : {
      data: { id: 'p1' },
      included: [{ type: 'member', attributes: { patron_status: 'active_patron' }, relationships: { campaign: { data: { id: '77' } }, currently_entitled_tiers: { data: [{ id: '5' }] } } }],
    }));

  it('sells servers only', () => {
    expect(new PatreonProvider().capabilities.sells).toEqual(['guild']);
  });

  it("a server purchase signs today's state plus the buyer", async () => {
    env();
    const answer = await new PatreonProvider().initiatePurchase({ ...purchase, variantId: 'tier:5' });
    const state = new URL(answer.oauthUrl!).searchParams.get('state')!;
    expect(state).toBe(sign({ guildId: G, userId: B, tierId: 't1', offeringId: 'o1', variantId: 'tier:5' }));
  });

  it('a purchase for a user throws X3 without a request', async () => {
    env();
    const calls = stubFetch(() => ({}));
    await expect(new PatreonProvider().initiatePurchase({ ...userPurchase, variantId: 'tier:5' })).rejects.toThrow(doesNotSellText('Patreon', 'user'));
    expect(calls).toEqual([]);
  });

  it('the callback answers the holder and the buyer its state held', async () => {
    env();
    patron();
    const result = await new PatreonProvider().handleOAuthCallback({
      code: 'c0de', state: sign({ guildId: G, userId: B, tierId: 't1', offeringId: 'o1', variantId: 'tier:5' }),
    });
    expect(result).toMatchObject({ externalAccountId: 'p1', holder: `guild:${G}`, buyerId: B, tierId: 't1', offeringId: 'o1', variantId: 'tier:5' });
    expect(result).not.toHaveProperty('guildId');
  });

  it('a state that names no buyer answers no buyer', async () => {
    env();
    patron();
    const result = await new PatreonProvider().handleOAuthCallback({
      code: 'c0de', state: sign({ guildId: G, tierId: 't1', offeringId: 'o1', variantId: 'tier:5' }),
    });
    expect(result.holder).toBe(`guild:${G}`);
    expect(result.buyerId).toBe('');
  });

  it("a user's list is empty without a request", async () => {
    env();
    const calls = stubFetch(() => ({}));
    expect(await new PatreonProvider().listSubscriptionsFor(`user:${U}`)).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('Server Boosting', () => {
  const TARGET = '60000000000000001';
  const OWNER = '80000000000000009';
  const tiers = { gold: { id: 'gold', offerings: [{ id: 'o1', providerLinks: [{ providerId: 'boost', enabled: true, priceConfig: { entries: [{ variantId: 'boost' }] } }] }] } };
  const rig = (boosting: boolean) => {
    vi.stubEnv('BOOST_TARGET_GUILD_ID', TARGET);
    const getAllTiers = vi.fn(() => tiers);
    vi.spyOn(ServerBoostingProvider.prototype as any, 'premium').mockReturnValue({ getAllTiers });
    const members = new Map([[OWNER, { premiumSince: boosting ? new Date() : null }]]);
    const target = { members: { fetch: async () => undefined, cache: members } };
    const provider = new ServerBoostingProvider();
    (provider as any).client = { guilds: { fetch: async () => target, cache: new Map([[G, { ownerId: OWNER }]]) } };
    return { provider, getAllTiers, members };
  };

  it('sells servers only', () => {
    expect(new ServerBoostingProvider().capabilities.sells).toEqual(['guild']);
  });

  it('a purchase for a user throws X3', async () => {
    vi.stubEnv('BOOST_TARGET_GUILD_ID', TARGET);
    await expect(new ServerBoostingProvider().initiatePurchase({ ...userPurchase, variantId: 'boost' })).rejects.toThrow(doesNotSellText('Server Boosting', 'user'));
  });

  it("the tick reads the server tiers and grants with the holder and the owner as buyer, then expires by holder", async () => {
    const { provider, getAllTiers, members } = rig(true);
    await (provider as any).tickRun();
    expect(getAllTiers.mock.calls).toEqual([['guild']]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: 'subscription.created', providerSubId: `boost:${G}:${OWNER}:boost`, holder: `guild:${G}`, buyerId: OWNER, tierId: 'gold', offeringId: 'o1' });
    expect(emitted[0]).not.toHaveProperty('guildId');

    members.set(OWNER, { premiumSince: null });
    await (provider as any).tickRun();
    expect(emitted[1]).toMatchObject({ type: 'subscription.expired', providerSubId: `boost:${G}:${OWNER}:boost`, holder: `guild:${G}` });
    expect(emitted[1]).not.toHaveProperty('guildId');
  });

  it("a user's list is empty", async () => {
    expect(await new ServerBoostingProvider().listSubscriptionsFor(`user:${U}`)).toEqual([]);
  });
});

describe("Discord's store", () => {
  let seq = 0;
  const entId = () => `40000000000000${String(++seq).padStart(3, '0')}`;
  const bridge = () => {
    const handlers: Record<string, (raw: any) => void> = {};
    new DiscordProvider().attachGatewayBridge((name, handler) => { handlers[name] = handler; });
    return handlers;
  };
  const pd1 = (id: string, sku: string) => `[DiscordProvider] Entitlement ${id} (SKU ${sku}) is for a server; this bot sells only user subscriptions through Discord, so no tier was given for it. Discord keeps billing it until it is cancelled or refunded in Discord.`;

  it('sells users only', () => {
    expect(new DiscordProvider().capabilities.sells).toEqual(['user']);
  });

  it('a purchase for a user or a server throws PD2 (members buy in Discord)', async () => {
    const pd2 = 'Members buy Discord subscriptions in Discord; the bot cannot start one.';
    await expect(new DiscordProvider().initiatePurchase({ ...userPurchase, variantId: 'sku1' })).rejects.toThrow(pd2);
    await expect(new DiscordProvider().initiatePurchase({ ...purchase, variantId: 'sku1' })).rejects.toThrow(pd2);
  });

  it("a user entitlement's three events carry the user as holder, and the created one the user as buyer and the SKU for premium to find the tier", () => {
    const h = bridge();
    const id = entId();
    const raw = { id, sku_id: 'sku1', user_id: U, application_id: '50000000000000001', type: 8 };
    h.entitlementCreate(raw);
    h.entitlementUpdate(raw);
    h.entitlementDelete(raw);
    expect(emitted.map(e => [e.type, e.holder, e.buyerId, 'guildId' in e])).toEqual([
      ['subscription.created', `user:${U}`, U, false],
      ['subscription.updated', `user:${U}`, undefined, false],
      ['subscription.expired', `user:${U}`, undefined, false],
    ]);
    expect(emitted[0]).toMatchObject({ tierId: '', offeringId: '', variantId: 'sku1', soldVariantOnly: true, tierFromVariant: true });
  });

  it('an entitlement for a server emits nothing and logs PD1 once over its three events', () => {
    const h = bridge();
    const id = entId();
    const raw = { id, sku_id: 'sku9', guild_id: G, user_id: B };
    h.entitlementUpdate(raw);
    h.entitlementCreate(raw);
    h.entitlementDelete(raw);
    bridge().entitlementCreate(raw);
    expect(emitted).toEqual([]);
    expect(logs).toEqual([pd1(id, 'sku9')]);
  });

  it('an entitlement with neither a user nor a server, or a server id that is no Discord id, emits nothing and logs nothing', () => {
    const h = bridge();
    h.entitlementCreate({ id: entId(), sku_id: 'sku1' });
    h.entitlementUpdate({ id: entId(), sku_id: 'sku1', guild_id: 'g1' });
    expect(emitted).toEqual([]);
    expect(logs).toEqual([]);
  });
});
