import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P7 claim 1 (sheet P7, section 10; 4.1, 4.7, section 6): the Patreon provider's capabilities, credentials and
// following. P1: it sells both kinds, starts no purchase (PT2), declares `billedWhileQueued` and `endedByProviderOnly`
// with PT11 and PT12 and no `endsAtPaidEnd`; it is configured only with the five keys; the webhook secret is optional;
// a delivery carries no event id; it has no `listSubscriptionsFor` or `scheduledReconcile`. P2: a record a round made is
// followed; today's shape, another campaign's record, or any record while Patreon is not configured is not.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

import { PatreonProvider } from '../../src/bot/internalSetup/utils/payment/patreonProvider';
import { CAMPAIGN_ID, CLIENT_ID, CLIENT_SECRET, CREATOR_TOKEN, PATREON_USERS, PTIER, WEBHOOK_SECRET } from '../helpers/p7Patreon';
import { BASE_URL, p7World, USERS } from '../helpers/p7World';
import { held, link, PT11, PT12, PT2 } from '../helpers/p7Rows';

const FIVE = {
  PATREON_CLIENT_ID: CLIENT_ID,
  PATREON_CLIENT_SECRET: CLIENT_SECRET,
  PATREON_CAMPAIGN_ID: CAMPAIGN_ID,
  PATREON_CREATOR_ACCESS_TOKEN: CREATOR_TOKEN,
  WEBUI_BASE_URL: BASE_URL,
};

describe('P7 claim 1, P1: what the Patreon provider declares', () => {
  beforeEach(() => {
    for (const [key, value] of Object.entries(FIVE)) vi.stubEnv(key, value);
    vi.stubEnv('PATREON_WEBHOOK_SECRET', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sells servers and users, starts no purchase, and declares the two flags with PT11 and PT12 and no endsAtPaidEnd (fails on P6\'s tree: servers only)', () => {
    const caps = new PatreonProvider().capabilities as any;
    expect({
      sells: caps.sells, canInitiatePurchase: caps.canInitiatePurchase, supportsCancel: caps.supportsCancel,
      endedByProviderOnly: caps.endedByProviderOnly, billedWhileQueued: caps.billedWhileQueued,
      endedByProviderText: caps.endedByProviderText, queuedBilledText: caps.queuedBilledText, endsAtPaidEnd: caps.endsAtPaidEnd,
    }).toEqual({
      sells: ['guild', 'user'], canInitiatePurchase: false, supportsCancel: false,
      endedByProviderOnly: true, billedWhileQueued: true, endedByProviderText: PT11, queuedBilledText: PT12, endsAtPaidEnd: undefined,
    });
  });

  it('initiatePurchase throws PT2 for either kind of holder and sends no request', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(String(url)); return new Response('{}'); }));
    const outcomes: unknown[] = [];
    for (const holder of ['guild:70000000000000001', `user:${USERS[0]}`]) {
      outcomes.push(await new PatreonProvider().initiatePurchase({ holder, buyerId: USERS[0], tierId: 't1', offeringId: 'o1', variantId: `tier:${PTIER.A}` } as any).then(() => 'started', (e: Error) => e.message));
    }
    expect(outcomes).toEqual([PT2, PT2]);
    expect(calls).toEqual([]);
  });

  it('is configured with the five keys, and not without any one of them; the webhook secret is not one of them', () => {
    const answers: Record<string, boolean> = { all: new PatreonProvider().isConfigured() };
    for (const key of Object.keys(FIVE)) {
      vi.stubEnv(key, '');
      answers[key] = new PatreonProvider().isConfigured();
      vi.stubEnv(key, (FIVE as Record<string, string>)[key]);
    }
    vi.stubEnv('PATREON_WEBHOOK_SECRET', WEBHOOK_SECRET);
    answers.withSecret = new PatreonProvider().isConfigured();
    expect(answers).toEqual({
      all: true, PATREON_CLIENT_ID: false, PATREON_CLIENT_SECRET: false, PATREON_CAMPAIGN_ID: false, PATREON_CREATOR_ACCESS_TOKEN: false, WEBUI_BASE_URL: false, withSecret: true,
    });
  });

  it('lists the creator token as required and the webhook secret as an optional secret, with section 8\'s help texts', () => {
    const fields = new PatreonProvider().getCredentialFields();
    const byKey = Object.fromEntries(fields.map(f => [f.key, f]));
    expect(fields.map(f => f.key)).toEqual(['PATREON_CLIENT_ID', 'PATREON_CLIENT_SECRET', 'PATREON_CAMPAIGN_ID', 'PATREON_CREATOR_ACCESS_TOKEN', 'PATREON_WEBHOOK_SECRET', 'WEBUI_BASE_URL']);
    expect([byKey.PATREON_CREATOR_ACCESS_TOKEN.type, byKey.PATREON_CREATOR_ACCESS_TOKEN.optional === true]).toEqual(['secret', false]);
    expect(byKey.PATREON_CREATOR_ACCESS_TOKEN.helpText).toBe("From Patreon's clients page (patreon.com/portal): the Creator's Access Token. The bot reads your campaign's members with it. When Patreon stops accepting it, the log says so; create a new one there and save it here.");
    expect([byKey.PATREON_WEBHOOK_SECRET.type, byKey.PATREON_WEBHOOK_SECRET.optional]).toEqual(['secret', true]);
    expect(byKey.PATREON_WEBHOOK_SECRET.helpText).toBe(`Optional. The secret of a webhook you create on Patreon for ${BASE_URL}/webhook/patreon with the members triggers. Without it the bot checks pledges hourly.`);
  });

  it('answers no event id for a delivery, and has no listSubscriptionsFor or scheduledReconcile', () => {
    const p = new PatreonProvider() as any;
    expect([p.webhookEventId(Buffer.from('{"data":{"type":"member","id":"x"}}'), { 'x-patreon-event': 'members:update' }), typeof p.handleWebhook, p.listSubscriptionsFor, p.scheduledReconcile]).toEqual([null, 'function', undefined, undefined]);
  });
});

describe('P7 claim 1, P2: which Patreon records the provider follows', () => {
  const w = p7World('json');
  beforeEach(async () => { await w.setup({ settings: { maskUser: 'none', staleReads: 0 } }); });
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  it("follows a record a round made, and not today's shape, another campaign's record, or any record while Patreon is not configured", async () => {
    await link(w, 0);
    w.fake.pledge(PATREON_USERS[0], PTIER.A);
    await w.advance(1000);
    await w.round();
    const made = held(w)[0];
    expect(made?.ptier).toBe(PTIER.A);
    const p = w.provider;
    const H = `user:${USERS[0]}` as const;
    const meta = made.sub.providerMeta;
    const answers = [
      p.followsSubscription({ holder: H, providerMeta: meta }),
      p.followsSubscription({ holder: H, providerMeta: { patreonUserId: PATREON_USERS[0], patreonTierId: PTIER.A } }),
      p.followsSubscription({ holder: H, providerMeta: { ...meta, campaignId: '8100002' } }),
    ];
    w.setCredentials({ PATREON_CREATOR_ACCESS_TOKEN: undefined });
    answers.push(p.followsSubscription({ holder: H, providerMeta: meta }));
    expect(answers).toEqual([
      { followed: true },
      { followed: false, whyNot: 'old-record' },
      { followed: false, whyNot: 'old-record' },
      { followed: false, whyNot: 'not-configured' },
    ]);
  });
});
