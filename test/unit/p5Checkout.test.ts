import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P5 claim 3 (sheet P5, Revision 9, Z2 and Z13): the checkout. A server buys on the member route and a user on the dev
// user route; the create sends exactly Z2's body, with the five-field custom_id signed over CLIENT_ID, holder, buyer,
// tier and offering; each refusal of Z11 (PT1 to PT10) comes before any call to PayPal that would follow it; premium
// stores nothing until the webhook.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());
vi.mock('../../src/bot/internalSetup/utils/appStoreManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/appStoreManager')>();
  const store = { getCachedModules: () => [], getRepositories: () => [], getInstalledModules: () => [], getAvailableModules: async () => [] };
  return { ...real, getAppStoreManager: () => store };
});

import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { customFrom } from '../../src/bot/internalSetup/utils/payment/paypalProvider';
import { customIdFor } from '../helpers/p5PayPal';
import { BOT_CLIENT_ID, HOST, IDS, p5World, planId, SECOND_CLIENT_ID, tierDefOf, type RouteReply } from '../helpers/p5World';

const SERVER = `guild:${IDS[0]}`;
const USER = `user:${IDS[1]}`;
const CREATE = /^\/v1\/billing\/subscriptions$/;
const PLAN_READ = /^\/v1\/billing\/plans\/[^/]+$/;
const PLAN = planId('gold', 'cheap');

const w = p5World('json');

beforeEach(async () => { await w.setup(); });
afterEach(async () => {
  await w.teardown();
  vi.restoreAllMocks();
});

const errorOf = (reply: RouteReply): string => String(reply.body?.error ?? '');
const creates = (): number => w.fake.callsOf('POST', CREATE).length;
const provider = (): any => getPaymentRegistry().get('paypal');
/** ppr's checkout called as premium calls it, for a server bought by IDS[1] unless the row says otherwise. */
const initiate = (more: Record<string, unknown> = {}) => provider().initiatePurchase({
  holder: SERVER, buyerId: IDS[1], tierId: 'gold', offeringId: 'o-gold', variantId: PLAN, autoRenew: true, ...more,
});
/** The rejection's message, or 'resolved'. */
const refusal = async (p: Promise<unknown>): Promise<string> => p.then(() => 'resolved', (e: Error) => e.message);

describe('P5 claim 3: what the create sends', () => {
  it('PayPal sells servers and users', () => {
    expect(provider().capabilities.sells).toEqual(['guild', 'user']);
  });

  it('a server on the member route: exactly Z2 body, the custom_id signed over CLIENT_ID, holder, buyer, tier and offering, returning to the host of OAUTH_CALLBACK_URL; premium stores nothing', async () => {
    const before = w.storedText();
    const reply = await w.buyMember(SERVER, IDS[1]);
    expect(reply.status).toBe(200);
    expect(reply.subscriptionId).not.toBeNull();
    expect(reply.body.result.redirectUrl).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\/webapps\/billing\/subscriptions\?ba_token=/);
    expect(reply.body.result.providerSubId).toBe(reply.subscriptionId);
    const text = w.fake.createTexts.get(reply.subscriptionId!)!;
    const custom = customIdFor({ clientId: BOT_CLIENT_ID, holder: SERVER, buyerId: IDS[1], tierId: 'gold', offeringId: 'o-gold' });
    expect(text).toBe(JSON.stringify({
      plan_id: PLAN,
      custom_id: custom,
      application_context: {
        brand_name: 'Discord Bot Premium',
        user_action: 'SUBSCRIBE_NOW',
        return_url: `${HOST}/guild/${IDS[0]}/subscription?subscribe=success`,
        cancel_url: `${HOST}/guild/${IDS[0]}/subscription?subscribe=cancel`,
      },
    }));
    expect(custom.split('|')).toHaveLength(5);
    expect(custom.split('|')[4]).toHaveLength(22);
    expect(text).not.toContain('guildId');
    expect(text).not.toContain('userId');
    expect(w.storedText()).toBe(before);
    expect(w.fake.unexpected).toEqual([]);
  });

  it('the signature covers CLIENT_ID and the offering, not the plan', async () => {
    const cheap = await w.buyMember(SERVER, IDS[1]);
    const dear = await w.buyDev(`guild:${IDS[1]}`, IDS[1], { plan: planId('gold', 'dear') });
    const sent = (id: string | null) => JSON.parse(w.fake.createTexts.get(id!)!).custom_id as string;
    expect(sent(cheap.subscriptionId)).toBe(customIdFor({ clientId: BOT_CLIENT_ID, holder: SERVER, buyerId: IDS[1], tierId: 'gold', offeringId: 'o-gold' }));
    expect(sent(dear.subscriptionId)).toBe(customIdFor({ clientId: BOT_CLIENT_ID, holder: `guild:${IDS[1]}`, buyerId: IDS[1], tierId: 'gold', offeringId: 'o-gold' }));
    expect(JSON.parse(w.fake.createTexts.get(dear.subscriptionId!)!).plan_id).toBe(planId('gold', 'dear'));
    const other = customIdFor({ clientId: SECOND_CLIENT_ID, holder: SERVER, buyerId: IDS[1], tierId: 'gold', offeringId: 'o-gold' });
    expect(other).not.toBe(sent(cheap.subscriptionId));
    const offering = customIdFor({ clientId: BOT_CLIENT_ID, holder: SERVER, buyerId: IDS[1], tierId: 'gold', offeringId: 'o-other' });
    expect(offering.split('|')[4]).not.toBe(sent(cheap.subscriptionId).split('|')[4]);
  });

  it('WEBUI_BASE_URL, when set, is the return host', async () => {
    process.env.WEBUI_BASE_URL = 'https://panel.example';
    const reply = await w.buyMember(SERVER, IDS[1]);
    const body = JSON.parse(w.fake.createTexts.get(reply.subscriptionId!)!);
    expect(body.application_context.return_url).toBe(`https://panel.example/guild/${IDS[0]}/subscription?subscribe=success`);
    expect(body.application_context.cancel_url).toBe(`https://panel.example/guild/${IDS[0]}/subscription?subscribe=cancel`);
  });

  it('a user on the dev user route: the user holder and buyer in the custom_id, returning to /guild', async () => {
    const before = w.storedText();
    const reply = await w.buyDev(USER, IDS[1], { tierId: 'vip' });
    expect(reply.status).toBe(200);
    expect(reply.subscriptionId).not.toBeNull();
    expect(w.fake.createTexts.get(reply.subscriptionId!)).toBe(JSON.stringify({
      plan_id: planId('vip', 'cheap'),
      custom_id: customIdFor({ clientId: BOT_CLIENT_ID, holder: USER, buyerId: IDS[1], tierId: 'vip', offeringId: 'o-vip' }),
      application_context: {
        brand_name: 'Discord Bot Premium',
        user_action: 'SUBSCRIBE_NOW',
        return_url: `${HOST}/guild?subscribe=success`,
        cancel_url: `${HOST}/guild?subscribe=cancel`,
      },
    }));
    expect(w.storedText()).toBe(before);
  });

  it('customFrom: signed only for the bot own signature; null for anything that is not five fields with a holder and a Discord buyer', async () => {
    const custom = customIdFor({ clientId: BOT_CLIENT_ID, holder: SERVER, buyerId: IDS[1], tierId: 'gold', offeringId: 'o-gold' });
    const [holder, buyer, tier, offering, sig] = custom.split('|');
    expect(customFrom(custom)).toEqual({ holder: SERVER, buyerId: IDS[1], tierId: 'gold', offeringId: 'o-gold', signed: true });
    const outcomes = [
      customFrom([holder, buyer, 'platinum', offering, sig].join('|')),
      customFrom([holder, buyer, tier, offering, 'AAAAAAAAAAAAAAAAAAAAAA'].join('|')),
      customFrom(customIdFor({ clientId: SECOND_CLIENT_ID, holder: SERVER, buyerId: IDS[1], tierId: 'gold', offeringId: 'o-gold' })),
      customFrom(customIdFor({ clientId: BOT_CLIENT_ID, secret: 'another secret', holder: SERVER, buyerId: IDS[1], tierId: 'gold', offeringId: 'o-gold' })),
      customFrom([holder, buyer, tier, offering, sig.slice(0, 10)].join('|')),
    ];
    expect(outcomes.map(o => o?.signed)).toEqual([false, false, false, false, false]);
    expect(outcomes[0]).toMatchObject({ holder: SERVER, buyerId: IDS[1], tierId: 'platinum', offeringId: 'o-gold' });
    expect([
      customFrom([holder, buyer, tier, sig].join('|')),
      customFrom([`server:${IDS[0]}`, buyer, tier, offering, sig].join('|')),
      customFrom([holder, 'someone', tier, offering, sig].join('|')),
      customFrom(JSON.stringify({ guildId: IDS[0], tierId: 'gold', offeringId: 'o-gold', userId: IDS[1] })),
      customFrom(undefined),
      customFrom(''),
    ]).toEqual([null, null, null, null, null, null]);
  });
});

describe('P5 claim 3: refusals before any call', () => {
  it.each(['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_WEBHOOK_ID'])('PT1 for %s unset, with no call', async key => {
    delete process.env[key];
    const calls = w.fake.calls.length;
    expect(await refusal(initiate())).toBe(`PayPal checkout did not start: ${key} is not set. Nothing was charged.`);
    expect(w.fake.calls.length).toBe(calls);
  });

  it('PT10 for CLIENT_ID unset, through the member route, with no call', async () => {
    delete process.env.CLIENT_ID;
    const calls = w.fake.calls.length;
    const reply = await w.buyMember(SERVER, IDS[1]);
    expect(reply.subscriptionId).toBeNull();
    expect(errorOf(reply)).toContain("PayPal checkout did not start: CLIENT_ID (the bot's Discord application id) is not set. Nothing was charged.");
    expect(w.fake.calls.length).toBe(calls);
  });

  it('PT6 with neither WEBUI_BASE_URL nor OAUTH_CALLBACK_URL, with no call', async () => {
    delete process.env.OAUTH_CALLBACK_URL;
    delete process.env.WEBUI_BASE_URL;
    const calls = w.fake.calls.length;
    const reply = await w.buyDev(USER, IDS[1], { tierId: 'vip' });
    expect(reply.subscriptionId).toBeNull();
    expect(errorOf(reply)).toContain('PayPal checkout did not start: neither WEBUI_BASE_URL nor OAUTH_CALLBACK_URL is set, so the bot has no address for PayPal to send the buyer back to. Nothing was charged.');
    expect(w.fake.calls.length).toBe(calls);
  });

  it('PT5 for the opt-out on the member route, with no call', async () => {
    const calls = w.fake.calls.length;
    const reply = await w.buyMember(SERVER, IDS[1], { more: { autoRenewOptOut: true } });
    expect(reply.subscriptionId).toBeNull();
    expect(errorOf(reply)).toContain('PayPal subscriptions renew until they are cancelled, so no checkout was started with auto-renew off. Buy with auto-renew on and cancel it afterwards (you keep access until the period ends), or pay with another provider. Nothing was charged.');
    expect(w.fake.calls.length).toBe(calls);
  });

  it('PT3 for a 90-character tier id and for a "|" in an offering id, with no call', async () => {
    const calls = w.fake.calls.length;
    const tierId = 't'.repeat(90);
    const length = customIdFor({ clientId: BOT_CLIENT_ID, holder: SERVER, buyerId: IDS[1], tierId, offeringId: 'o-gold' }).length;
    expect(length).toBeGreaterThan(127);
    expect(await refusal(initiate({ tierId }))).toBe(
      `PayPal checkout did not start: the subscription's label for PayPal (server, buyer, tier '${tierId}', offering 'o-gold') is ${length} characters, over PayPal's limit of 127. Use a shorter tier or offering id. Nothing was charged.`,
    );
    expect(await refusal(initiate({ holder: USER, offeringId: 'o|vip', tierId: 'vip' }))).toBe(
      `PayPal checkout did not start: the subscription's label for PayPal (user, buyer, tier 'vip', offering 'o|vip') contains the character "|". Remove the "|" from the offering id. Nothing was charged.`,
    );
    expect(await refusal(initiate({ holder: USER, offeringId: 'o-vip', tierId: 'v|ip' }))).toBe(
      `PayPal checkout did not start: the subscription's label for PayPal (user, buyer, tier 'v|ip', offering 'o-vip') contains the character "|". Remove the "|" from the tier id. Nothing was charged.`,
    );
    expect(w.fake.calls.length).toBe(calls);
  });
});

describe('P5 review 2 (A9): a manual grant at the same priority', () => {
  it('a manual grant of Gold in the active slot: a PayPal checkout of Gold is refused with no create', async () => {
    expect((await w.op('grantManual', SERVER, 'gold', 30)).ok).toBe(true);
    const before = w.storedText();
    const reply = await w.buyMember(SERVER, IDS[1]);
    expect([reply.status === 200, reply.subscriptionId, creates()]).toEqual([false, null, 0]);
    expect(errorOf(reply)).toContain("You already have 'Gold' as a grant from this server's staff; a purchase at the same priority can start only after it ends or staff remove it.");
    expect(w.storedText()).toBe(before);
  });
});

describe('P5 claim 3: the plan read and the sign-in', () => {
  it('PT2 for a plan that is not active: no create', async () => {
    w.fake.setPlanStatus(PLAN, 'INACTIVE');
    const reply = await w.buyMember(SERVER, IDS[1]);
    expect(errorOf(reply)).toContain(`PayPal checkout did not start: plan ${PLAN} is INACTIVE at PayPal, not active. Nothing was charged.`);
    expect(w.fake.callsOf('GET', PLAN_READ)).toHaveLength(1);
    expect(creates()).toBe(0);
  });

  it.each([
    ['404', { status: 404 }, `PayPal answered 404: The specified resource does not exist.`],
    ['500', { status: 500 }, `PayPal answered 500: An internal server error has occurred.`],
    ['no answer', { drop: 'before' as const }, 'PayPal did not answer: fetch failed'],
  ])('PT4 for a plan read answering %s: no create', async (_name, fault, reason) => {
    w.fake.fail('GET', PLAN_READ, fault);
    const reply = await w.buyMember(SERVER, IDS[1]);
    expect(errorOf(reply)).toContain(`PayPal checkout did not start: the bot could not read plan ${PLAN} (${reason}). Nothing was charged.`);
    expect(creates()).toBe(0);
    expect(w.fake.subscriptions.size).toBe(0);
  });

  it.each([
    ['refused', { status: 401 }, 'PayPal answered 401'],
    ['unanswered', { drop: 'before' as const }, 'PayPal did not answer: fetch failed'],
  ])('PT9 for a token %s: no plan read and no create', async (_name, fault, reason) => {
    w.fake.fail('POST', /^\/v1\/oauth2\/token$/, fault);
    const reply = await w.buyMember(SERVER, IDS[1]);
    expect(errorOf(reply)).toContain(`PayPal checkout did not start: the bot could not sign in to PayPal (${reason}). Nothing was charged.`);
    expect(w.fake.callsOf('GET', PLAN_READ)).toHaveLength(0);
    expect(creates()).toBe(0);
  });
});

describe("P5 claim 3: the create's answers", () => {
  it("PT7 for a 422 (PayPal's message) and nothing made", async () => {
    w.fake.fail('POST', CREATE, { status: 422, message: 'The requested action could not be performed.' });
    const reply = await w.buyMember(SERVER, IDS[1]);
    expect(errorOf(reply)).toContain('PayPal did not start the checkout: The requested action could not be performed. Nothing was charged.');
    expect(w.fake.subscriptions.size).toBe(0);
  });

  it('PT7 for a 2xx with no approve link', async () => {
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const res = await real(url, init);
      if (init?.method === 'POST' && String(url).endsWith('/v1/billing/subscriptions')) {
        const body = await res.json();
        return new Response(JSON.stringify({ ...body, links: body.links.filter((l: any) => l.rel !== 'approve') }), { status: res.status, headers: { 'content-type': 'application/json' } });
      }
      return res;
    });
    const reply = await w.buyMember(SERVER, IDS[1]);
    expect(errorOf(reply)).toContain('PayPal did not start the checkout: PayPal answered with no approval link. Nothing was charged.');
    expect(creates()).toBe(1);
  });

  it.each([
    ['500', { status: 500 }, 'PayPal answered 500: An internal server error has occurred.'],
    ['no answer', { drop: 'after' as const }, 'PayPal did not answer: fetch failed'],
  ])('PT8 for a create answering %s', async (_name, fault, reason) => {
    w.fake.fail('POST', CREATE, fault);
    const reply = await w.buyMember(SERVER, IDS[1]);
    expect(errorOf(reply)).toContain(`Can't confirm whether PayPal started a checkout (${reason}). Nothing is charged until a checkout is approved; try again.`);
    expect(creates()).toBe(1);
  });
});

describe('P5 claim 3: auto-renew', () => {
  it("with no opt-out and premium's variant read failing, the checkout starts", async () => {
    const def: any = tierDefOf('gold');
    delete def.offerings[0].providerLinks[0].cache;
    expect((await w.op('setTier', 'gold', def)).ok).toBe(true);
    const read = vi.spyOn(provider(), 'fetchVariant').mockRejectedValue(new Error('p5 variant read failed'));
    const reply = await w.buyMember(SERVER, IDS[1]);
    expect(read).toHaveBeenCalled();
    expect(reply.status).toBe(200);
    expect(reply.subscriptionId).not.toBeNull();
  });

  it('with the opt-out and an offering that forces auto-renew, the checkout starts', async () => {
    const def: any = tierDefOf('gold');
    def.offerings[0].forceAutoRenew = true;
    expect((await w.op('setTier', 'gold', def)).ok).toBe(true);
    const reply = await w.buyMember(SERVER, IDS[1], { more: { autoRenewOptOut: true } });
    expect(reply.status).toBe(200);
    expect(reply.subscriptionId).not.toBeNull();
  });

  it('premium passes autoRenewOptOut only for an opt-out on an offering that does not force auto-renew', async () => {
    const seen: unknown[] = [];
    vi.spyOn(provider(), 'initiatePurchase').mockImplementation(async (opts: any) => {
      seen.push(opts.autoRenewOptOut);
      return { redirectUrl: 'https://paypal.example/approve' };
    });
    await w.buyMember(SERVER, IDS[1], { more: { autoRenewOptOut: true } });
    await w.buyMember(SERVER, IDS[1]);
    const def: any = tierDefOf('gold');
    def.offerings[0].forceAutoRenew = true;
    expect((await w.op('setTier', 'gold', def)).ok).toBe(true);
    await w.buyMember(SERVER, IDS[1], { more: { autoRenewOptOut: true } });
    expect(seen).toEqual([true, undefined, undefined]);
  });
});
