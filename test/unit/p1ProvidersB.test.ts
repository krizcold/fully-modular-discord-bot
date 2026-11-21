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

// P1 sheet section 8 claim 13 (second file): Patreon, Server Boosting and Discord's store keep their wire for a
// server and speak holders to premium.

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
  const env = () => {
    vi.stubEnv('DISCORD_APPLICATION_ID', '50000000000000001');
    vi.stubEnv('DISCORD_TOKEN', 'bot-token');
  };
  let seq = 0;
  const entId = () => `40000000000000${String(++seq).padStart(3, '0')}`;
  const bridge = () => {
    const handlers: Record<string, (raw: any) => void> = {};
    new DiscordProvider().attachGatewayBridge((name, handler) => { handlers[name] = handler; });
    return handlers;
  };
  const l4 = (id: string, sku: string) => `[DiscordProvider] Entitlement ${id} (SKU ${sku}) is for a user, not a server; this version does not handle user entitlements, so its events are not applied.`;

  it('sells servers only', () => {
    expect(new DiscordProvider().capabilities.sells).toEqual(['guild']);
  });

  it('a purchase for a user throws X3', async () => {
    await expect(new DiscordProvider().initiatePurchase({ ...userPurchase, variantId: 'sku1' })).rejects.toThrow(doesNotSellText('Discord App Monetization', 'user'));
  });

  it("a server entitlement's three events carry the holder, and the created one the entitlement's user", () => {
    const h = bridge();
    const id = entId();
    const raw = { id, sku_id: 'sku1', guild_id: G, user_id: B };
    h.entitlementCreate(raw);
    h.entitlementUpdate(raw);
    h.entitlementDelete(raw);
    expect(emitted.map(e => [e.type, e.holder, e.buyerId, 'guildId' in e])).toEqual([
      ['subscription.created', `guild:${G}`, B, false],
      ['subscription.updated', `guild:${G}`, undefined, false],
      ['subscription.expired', `guild:${G}`, undefined, false],
    ]);
  });

  it('an entitlement with a user and no server emits nothing and logs L4 once over its three events', () => {
    const h = bridge();
    const id = entId();
    const raw = { id, sku_id: 'sku9', user_id: U };
    h.entitlementUpdate(raw);
    h.entitlementCreate(raw);
    h.entitlementDelete(raw);
    bridge().entitlementCreate(raw);
    expect(emitted).toEqual([]);
    expect(logs).toEqual([l4(id, 'sku9')]);
  });

  it('an entitlement with neither a user nor a server, or a server id that is no Discord id, emits nothing and logs nothing', () => {
    const h = bridge();
    h.entitlementCreate({ id: entId(), sku_id: 'sku1' });
    h.entitlementUpdate({ id: entId(), sku_id: 'sku1', guild_id: 'g1' });
    expect(emitted).toEqual([]);
    expect(logs).toEqual([]);
  });

  it("a server's list names the holder and the entitlement's user as buyer", async () => {
    env();
    const id = entId();
    stubFetch(url => (url.includes('/skus') ? [{ id: 'sku1', name: 'Gold' }] : [{ id, sku_id: 'sku1', guild_id: G, user_id: B, type: 8 }]));
    const list = await new DiscordProvider().listSubscriptionsFor(`guild:${G}`);
    expect(list.map(r => r.metadata)).toEqual([{ holder: `guild:${G}`, buyerId: B, variantId: 'sku1' }]);
  });

  it("a user's list is empty without a request", async () => {
    env();
    const calls = stubFetch(() => []);
    expect(await new DiscordProvider().listSubscriptionsFor(`user:${U}`)).toEqual([]);
    expect(calls).toEqual([]);
  });
});
