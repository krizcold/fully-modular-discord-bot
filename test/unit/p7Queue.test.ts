import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P7 claim 9 as part 1 builds it, and claim 11 (sheet P7, section 10; 4.7): a record of a provider that declares
// `billedWhileQueued` gets the queue notice whose second sentence is that provider's `queuedBilledText`, pushed out of
// the slot by a higher manual grant and installed under a held one alike, and resumes with its stored endDate (null)
// when the grant ends (Q1, the faked provider of helpers/p7World.ts, D8). Discord's PD12 and the Dummy's and PayPal's
// queue notices, and the Dummy's stored entries, audit lines and notices through queue moves, are P6's (Q3, claim 11);
// so are the notices and admin errors of Stripe, PayPal and Discord records through the same moves (claim 11).
// The real PremiumManager in the bot role over the JSON files, and over the mirror rig where a row names a save.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { SubscriptionNotifier } from '../../src/bot/internalSetup/utils/subscriptionNotifier';
import { noticePayloads, notices as sentNotices } from '../helpers/p1Mocks';
import { PATREON_USERS, PTIER } from '../helpers/p7Patreon';
import { PT12 } from '../helpers/p7Rows';
import { FOLLOWER_QUEUED_TEXT, GUILDS, p7World, USERS, type P7World } from '../helpers/p7World';
import { SKU } from '../helpers/p6Discord';
import { p6World, USERS as P6_USERS } from '../helpers/p6World';
import { p5World } from '../helpers/p5World';
import { onceKit } from '../helpers/p5pOnce';
import { StripeProvider } from '../../src/bot/internalSetup/utils/payment/stripeProvider';
import { PayPalProvider } from '../../src/bot/internalSetup/utils/payment/paypalProvider';
import { DiscordProvider } from '../../src/bot/internalSetup/utils/payment/discordProvider';
import type { PaymentProvider, ProviderCapabilities } from '../../src/bot/internalSetup/utils/payment/paymentTypes';
import { holderWords } from '../../src/bot/internalSetup/utils/premiumHolder';
import { allowDropLines } from '../helpers/p1Guard';

const C11U = 'user:86700000000000002';
const C11G = 'guild:86800000000000001';
const ENDS = 'Ends <t:time:f> (<t:time:R>).';
/** What P6's notifier (429e985) gives for a Stripe or PayPal record's notices in the claim 11 row below, captured by running it on the payloads P7 sent. */
const queuedNotBilled = (name: string): string[] => [
  `${C11U} paid.sub.started **Subscription active:** **${name} low** (${name}) is now active for you. ${ENDS}`,
  `${C11G} paid.sub.started **Subscription active:** **Gold ${name}** (${name}) is now active for your server. ${ENDS}`,
  `${C11U} manual.grant.added **Premium granted:** You now have **Star**. ${ENDS}`,
  `${C11U} paid.sub.paused-by-stacking **Subscription paused:** Your **${name} low** (${name}) subscription is queued behind a higher-tier plan and won't be billed until it resumes. 30 days remaining.`,
  `${C11G} manual.grant.added **Premium granted:** Your server now has **Platinum**. ${ENDS}`,
  `${C11G} paid.sub.paused-by-stacking **Subscription paused:** Your **Gold ${name}** (${name}) subscription is queued behind a higher-tier plan and won't be billed until it resumes. 30 days remaining.`,
  `${C11U} paid.sub.resumed-from-queue **Subscription resumed:** Your queued **${name} low** (${name}) subscription is now active. ${ENDS}`,
  `${C11U} manual.grant.revoked **Premium revoked:** Your **Star** grant was removed by an administrator.`,
  `${C11U} paid.sub.cancelled-by-user **Subscription cancelled:** Your **${name} low** (${name}) subscription will not auto-renew.`,
];
const DISCORD_NAME = 'Discord App Monetization';
/** P6's PD11 (premiumManager.ts at 429e985). */
const P6_PD11 = "Discord manages this subscription, so the bot cannot end or remove it. It ends when the member's subscription ends in Discord or Discord refunds it.";
const CLAIM11_TEXTS: Record<string, { texts: string[]; errors: string[] }> = {
  Stripe: { texts: queuedNotBilled('Stripe'), errors: [] },
  PayPal: { texts: queuedNotBilled('PayPal'), errors: [] },
  Discord: {
    texts: [
      `${C11U} paid.sub.started **Subscription active:** **Discord low** (${DISCORD_NAME}) is now active for you. ${ENDS}`,
      `${C11U} manual.grant.added **Premium granted:** You now have **Star**. ${ENDS}`,
      `${C11U} paid.sub.paused-by-stacking **Subscription paused:** Your **Discord low** (${DISCORD_NAME}) subscription is queued behind a higher-tier plan. The bot cannot pause it in Discord; if you no longer want it, cancel it in Discord.`,
      `${C11U} paid.sub.resumed-from-queue **Subscription resumed:** Your queued **Discord low** (${DISCORD_NAME}) subscription is now active. ${ENDS}`,
      `${C11U} manual.grant.revoked **Premium revoked:** Your **Star** grant was removed by an administrator.`,
    ],
    errors: [P6_PD11, P6_PD11],
  },
};

/** P6's next step in the not-installed line of a variant the offering does not sell (premiumManager.ts at 429e985, lines 1551-1558). */
const P6_NOT_SOLD = (name: string, endedByProvider: boolean): string => (endedByProvider
  ? `The member cancels it in ${name}; the bot tries again at its next check.`
  : `If ${name} keeps billing it, cancel it there; refund it at ${name} if it was paid.`);
/** Patreon's capability string, the last sentence of its PD14 lines. */
const PT_ENDS = 'The member ends the pledge on patreon.com.';
/** Patreon's next step in the line of a variant the offering does not sell. */
const PT_NOT_SOLD = `${PT_ENDS} The bot tries again at its next check.`;

const U = USERS[0];
const U2 = USERS[1];
const H = `user:${U}`;
const H2 = `user:${U2}`;
const G = `guild:${GUILDS[0]}`;
const MIN = 60_000;
const DAY = 86_400_000;
const BACKENDS = [['the JSON files', 'json' as const], ['the mirror rig', 'rig' as const]] as const;

const formatted = (kind: string, payload: unknown, holderKind: 'user' | 'guild' = 'user'): string => (new SubscriptionNotifier() as any).formatMessage(kind, payload, holderKind);
const since = (w: { notices: () => Array<{ to: string; kind: string }> }, from: number) => w.notices().slice(from).map((n, i) => ({ ...n, payload: noticePayloads[from + i] as any }));

function heldOf(w: P7World, holder: string, providerSubId: string): { location: 'active' | 'paused'; sub: any } | null {
  const rec = w.stored()?.subscriptions?.[holder];
  if (rec?.active?.providerSubId === providerSubId) return { location: 'active', sub: rec.active };
  const queued = (rec?.paused ?? []).find((p: any) => p.providerSubId === providerSubId);
  return queued ? { location: 'paused', sub: queued } : null;
}

describe.each(BACKENDS)('P7 part 1 on %s: Q1, a queued record of a billedWhileQueued provider', (_name, backend) => {
  const w = p7World(backend);
  beforeEach(async () => { await w.setup({ faked: true }); });
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  it("Q1: pushed out by a higher manual grant and installed under a held one, it is queued with the provider's queuedBilledText and no started notice; when the grant ends it resumes with endDate null (fails on a build that keeps Discord's sentence in the notifier)", async () => {
    const queuedText = `**Subscription paused:** Your **VIP** (Follower) subscription is queued behind a higher-tier plan. ${FOLLOWER_QUEUED_TEXT}`;
    const a = w.follower.install(H, U, PTIER.A);
    await w.settle();
    expect(heldOf(w, H, a)).toMatchObject({ location: 'active', sub: { endDate: null, autoRenew: true } });
    let from = w.notices().length;
    expect((await w.op('grantManual', H, 'star', 1)).ok).toBe(true);
    const pushed = since(w, from).filter(n => n.kind.startsWith('paid.'));
    expect(pushed.map(n => [n.to, n.kind])).toEqual([[H, 'paid.sub.paused-by-stacking']]);
    expect(pushed[0].payload).toMatchObject({ tierName: 'VIP', providerName: 'Follower', billedWhileQueued: true });
    expect(formatted('paid.sub.paused-by-stacking', pushed[0].payload)).toBe(queuedText);
    expect(heldOf(w, H, a)).toMatchObject({ location: 'paused', sub: { status: 'paused', endDate: null } });

    expect((await w.op('grantManual', H2, 'star', 1)).ok).toBe(true);
    from = w.notices().length;
    const c = w.follower.install(H2, U2, PTIER.A);
    await w.settle();
    expect(heldOf(w, H2, c)).toMatchObject({ location: 'paused', sub: { status: 'paused', endDate: null, autoRenew: true } });
    const queued = since(w, from);
    expect(queued.map(n => [n.to, n.kind])).toEqual([[H2, 'paid.sub.paused-by-stacking']]);
    expect(formatted('paid.sub.paused-by-stacking', queued[0].payload)).toBe(queuedText);

    from = w.notices().length;
    await w.advance(DAY + 2 * MIN);
    expect(heldOf(w, H, a)).toMatchObject({ location: 'active', sub: { status: 'active', endDate: null } });
    expect(heldOf(w, H2, c)).toMatchObject({ location: 'active', sub: { status: 'active', endDate: null } });
    const resumed = since(w, from).filter(n => n.kind === 'paid.sub.resumed-from-queue');
    expect(resumed.map(n => n.to).sort()).toEqual([H, H2].sort());
    for (const n of resumed) expect(formatted(n.kind, n.payload)).toBe('**Subscription resumed:** Your queued **VIP** (Follower) subscription is now active.');
  });
});

describe('P7 part 1: Q3, Discord\'s queue notice is P6\'s', () => {
  const w = p6World('json');
  const NAME = 'Discord App Monetization';
  beforeEach(async () => {
    await w.setup({ settings: { staleReads: 0 } });
    await w.advance(45_000);
  });
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  it('Q3: a Discord record pushed out of the slot gets PD12, word for word', async () => {
    w.fake.purchase(P6_USERS[0], SKU.A);
    await w.deliverAll();
    const from = w.notices().length;
    w.fake.purchase(P6_USERS[0], SKU.B);
    await w.deliverAll();
    const pushed = since(w, from).filter(n => n.kind === 'paid.sub.paused-by-stacking');
    expect(pushed).toHaveLength(1);
    expect(pushed[0].payload).toMatchObject({ tierName: 'VIP', providerName: NAME, billedWhileQueued: true });
    expect(formatted('paid.sub.paused-by-stacking', pushed[0].payload)).toBe(`**Subscription paused:** Your **VIP** (${NAME}) subscription is queued behind a higher-tier plan. The bot cannot pause it in Discord; if you no longer want it, cancel it in Discord.`);
  });
});

describe('P7 part 1: Q3, PayPal\'s queue notices are P6\'s', () => {
  const w = p5World('json');
  const o = onceKit(w);
  beforeEach(async () => { await w.setup({ clock: Date.UTC(2027, 0, 31, 12) }); });
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  it('Q3: a pay-once and a renewing PayPal entry pushed into the queue get the payloads and texts of P6\'s tree', async () => {
    await o.owned('guild', { settings: { finalCycle: 'stays-active' } });
    noticePayloads.length = 0;
    sentNotices.sent.length = 0;
    await o.owned('guild', { level: 'high', renewing: true });
    const once = sentNotices.sent.findIndex(n => n.kind === 'paid.sub.paused-by-stacking');
    const oncePayload = noticePayloads[once] as any;
    expect(Object.keys(oncePayload).sort()).toEqual(['payOnce', 'providerName', 'remainingDays', 'tierName']);
    expect(formatted('paid.sub.paused-by-stacking', oncePayload, 'guild')).toBe(`**Subscription paused:** Your **${oncePayload.tierName}** (PayPal) subscription is queued behind a higher-tier plan. It was sold as one payment; its remaining paid time starts when it resumes. ${oncePayload.remainingDays} days remaining.`);
    await w.teardown();
    await w.setup({ clock: Date.UTC(2027, 0, 31, 12) });
    await o.owned('guild', { renewing: true });
    noticePayloads.length = 0;
    sentNotices.sent.length = 0;
    await o.owned('guild', { level: 'high', renewing: true });
    const renewing = sentNotices.sent.findIndex(n => n.kind === 'paid.sub.paused-by-stacking');
    const renewingPayload = noticePayloads[renewing] as any;
    expect(Object.keys(renewingPayload).sort()).toEqual(['providerName', 'remainingDays', 'tierName']);
    expect(formatted('paid.sub.paused-by-stacking', renewingPayload, 'guild')).toBe(`**Subscription paused:** Your **${renewingPayload.tierName}** (PayPal) subscription is queued behind a higher-tier plan and won't be billed until it resumes. ${renewingPayload.remainingDays} days remaining.`);
  });
});

/** The stored subscriptions and their audit lines, with each time and each generated id replaced by its first-seen index. */
function normalized(w: P7World): string {
  const ids = new Map<string, string>();
  const text = JSON.stringify({ subscriptions: w.stored().subscriptions, audit: w.auditLines().filter(l => String(l.action).startsWith('subscription.')) });
  return text
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, '<time>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, id => {
      if (!ids.has(id)) ids.set(id, `<id${ids.size}>`);
      return ids.get(id)!;
    });
}

const install = (holder: string, tierId: string, offeringId: string, subscriptionId: string, buyerId: string) => ({ timestamp: '<time>', actor: 'admin', action: 'subscription.install.paid', holder, tierId, offeringId, providerId: 'dummy', subscriptionId, metadata: { variantId: 'dummy_monthly_999', buyerId } });
const step = (action: string, holder: string, subscriptionId: string, more: Record<string, unknown> = {}) => ({ timestamp: '<time>', actor: 'admin', action, holder, ...more, subscriptionId, ...(more.tierId ? {} : { providerId: 'dummy' }) });
const UH = 'user:86700000000000002';
const GH = 'guild:86800000000000001';
/** What P6's tree (429e985) gives for the row's sequence, captured there before part 1's src changed. */
const CLAIM11 = {
  state: {
    subscriptions: {
      [GH]: {
        paused: [],
        active: {
          id: '<id0>', tierId: 'platinum', source: 'manual', startDate: '<time>', endDate: '<time>', autoRenew: false, status: 'active',
          purchasedSnapshot: { offeringLabel: '', variantLabel: '', amount: 0, currency: '', durationDays: 1, tierDisplayName: 'Platinum', tierPriority: 2, purchasedAt: '<time>' },
          createdAt: '<time>', updatedAt: '<time>',
        },
      },
    },
    audit: [
      install(UH, 'dlow', 'o-d', '<id1>', '86700000000000002'),
      install(GH, 'gdummy', 'o-gd', '<id2>', '86700000000000001'),
      { timestamp: '<time>', actor: 'admin', action: 'subscription.grant.manual', holder: UH, tierId: 'star', subscriptionId: '<id3>', metadata: { durationDays: 1 } },
      step('subscription.pause', UH, '<id1>'),
      { timestamp: '<time>', actor: 'admin', action: 'subscription.grant.manual', holder: GH, tierId: 'platinum', subscriptionId: '<id0>', metadata: { durationDays: 1 } },
      step('subscription.pause', GH, '<id2>'),
      step('subscription.resume', UH, '<id1>'),
      { timestamp: '<time>', actor: 'admin', action: 'subscription.revoke.manual', holder: UH, tierId: 'star', subscriptionId: '<id3>' },
      { ...step('subscription.cancel.paid', GH, '<id2>'), metadata: { fromPausedQueue: true, providerRecordMissing: true } },
      { ...step('subscription.cancel.paid', UH, '<id1>'), metadata: { immediately: true, providerRecordMissing: true } },
    ],
  },
  texts: [
    `${UH} paid.sub.started **Subscription active:** **Dummy low** (Dummy (Development)) is now active for you. Ends <t:time:f> (<t:time:R>).`,
    `${GH} paid.sub.started **Subscription active:** **Gold Dummy** (Dummy (Development)) is now active for your server. Ends <t:time:f> (<t:time:R>).`,
    `${UH} manual.grant.added **Premium granted:** You now have **Star**. Ends <t:time:f> (<t:time:R>).`,
    `${UH} paid.sub.paused-by-stacking **Subscription paused:** Your **Dummy low** (Dummy (Development)) subscription is queued behind a higher-tier plan and won't be billed until it resumes. 30 days remaining.`,
    `${GH} manual.grant.added **Premium granted:** Your server now has **Platinum**. Ends <t:time:f> (<t:time:R>).`,
    `${GH} paid.sub.paused-by-stacking **Subscription paused:** Your **Gold Dummy** (Dummy (Development)) subscription is queued behind a higher-tier plan and won't be billed until it resumes. 30 days remaining.`,
    `${UH} paid.sub.resumed-from-queue **Subscription resumed:** Your queued **Dummy low** (Dummy (Development)) subscription is now active. Ends <t:time:f> (<t:time:R>).`,
    `${UH} manual.grant.revoked **Premium revoked:** Your **Star** grant was removed by an administrator.`,
    `${UH} paid.sub.cancelled-by-user **Subscription cancelled:** Your **Dummy low** (Dummy (Development)) subscription will not auto-renew.`,
  ],
};

describe.each(BACKENDS)("P7 part 1 on %s: claim 11, the Dummy's queue moves give P6's stored entries, audit lines and notices", (_name, backend) => {
  const w = p7World(backend);
  beforeEach(async () => { await w.setup(); });
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  it("claim 11: a Dummy user and server record pushed out by a grant, resumed by its revoke, removed from the queue and ended: the stored document, the audit lines and the notices' texts are P6's", async () => {
    const link = { providerId: 'dummy', enabled: true, mode: 'price', priceConfig: { entries: [{ variantId: 'dummy_monthly_999' }] } };
    expect((await w.op('setTier', 'dlow', { displayName: 'Dummy low', priority: 1, overrides: {}, kind: 'user', offerings: [{ id: 'o-d', label: 'Dummy low', providerLinks: [link] }] })).ok).toBe(true);
    expect((await w.op('setTier', 'gdummy', { displayName: 'Gold Dummy', priority: 1, overrides: {}, offerings: [{ id: 'o-gd', label: 'Gold Dummy', providerLinks: [link] }] })).ok).toBe(true);
    const created = (holder: string, buyer: string, tierId: string, offeringId: string, providerSubId: string): void => {
      const now = Date.parse('2026-11-23T12:00:00.000Z');
      getPaymentRegistry().emitEvent({ type: 'subscription.created', providerId: 'dummy', providerSubId, holder: holder as any, buyerId: buyer, tierId, offeringId, variantId: 'dummy_monthly_999', state: { status: 'active', startDate: new Date(now).toISOString(), endDate: new Date(now + 30 * DAY).toISOString(), autoRenew: true } } as any);
    };
    const from = w.notices().length;
    created(H2, U2, 'dlow', 'o-d', 'dummy_p7_q3u');
    created(G, U, 'gdummy', 'o-gd', 'dummy_p7_q3g');
    await w.settle();
    expect((await w.op('grantManual', H2, 'star', 1)).ok).toBe(true);
    expect((await w.op('grantManual', G, 'platinum', 1)).ok).toBe(true);
    expect((await w.op('revokeManual', H2)).ok).toBe(true);
    const queued = w.stored().subscriptions[G].paused.find((p: any) => p.providerId === 'dummy');
    expect((await w.op('cancelAndRemovePausedSubscription', G, queued.id)).ok).toBe(true);
    expect((await w.op('cancelPaidSubscriptionImmediately', H2)).ok).toBe(true);
    const texts = since(w, from).map(n => `${n.to} ${n.kind} ${formatted(n.kind, n.payload, n.to.startsWith('user:') ? 'user' : 'guild').replace(/<t:\d+:/g, '<t:time:')}`);
    const seen = { state: JSON.parse(normalized(w)), texts };
    expect(JSON.stringify(seen)).toBe(JSON.stringify(CLAIM11));
  });
});

/** A provider with a built-in provider's id, name and capabilities, whose calls answer at once and call nothing. */
class StandIn implements PaymentProvider {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  readonly cancels: Array<[string, boolean | undefined]> = [];
  constructor(real: PaymentProvider) {
    this.id = real.id;
    this.displayName = real.displayName;
    this.capabilities = real.capabilities;
  }
  isConfigured(): boolean { return true; }
  getCredentialFields() { return []; }
  async initiatePurchase(): Promise<never> { throw new Error('The stand-in sells nothing.'); }
  async fetchVariant(): Promise<null> { return null; }
  async getSubscriptionState(): Promise<null> { return null; }
  async cancelSubscription(subId: string, immediately?: boolean): Promise<void> { this.cancels.push([subId, immediately]); }
}

const CLAIM11_PROVIDERS = [
  ['Stripe', () => new StripeProvider()],
  ['PayPal', () => new PayPalProvider()],
  ['Discord', () => new DiscordProvider()],
] as const;

describe.each(CLAIM11_PROVIDERS)("P7 part 5: claim 11, %s's queue moves, notices and refusals give P6's texts", (name, make) => {
  const w = p7World('json');
  let standIn: StandIn;
  beforeEach(async () => {
    await w.setup();
    standIn = new StandIn(make());
    getPaymentRegistry().register(standIn);
  });
  afterEach(async () => {
    getPaymentRegistry().unregister(standIn.id);
    await w.teardown();
    vi.restoreAllMocks();
  });

  it(`claim 11: ${name} records pushed out by a grant, resumed by its revoke, removed from the queue and ended give the notices and admin errors of P6's tree`, async () => {
    const id = standIn.id;
    const variant = `${id}_p7_claim11`;
    const link = { providerId: id, enabled: true, mode: 'price', priceConfig: { entries: [{ variantId: variant }] } };
    const sellsGuild = standIn.capabilities.sells.includes('guild');
    expect((await w.op('setTier', 'ulow', { displayName: `${name} low`, priority: 1, overrides: {}, kind: 'user', offerings: [{ id: 'o-u', label: `${name} low`, providerLinks: [link] }] })).ok).toBe(true);
    if (sellsGuild) expect((await w.op('setTier', 'glow', { displayName: `Gold ${name}`, priority: 1, overrides: {}, offerings: [{ id: 'o-g', label: `Gold ${name}`, providerLinks: [link] }] })).ok).toBe(true);
    const now = Date.now();
    const created = (holder: string, buyer: string, tierId: string, offeringId: string, providerSubId: string): void => {
      getPaymentRegistry().emitEvent({ type: 'subscription.created', providerId: id, providerSubId, holder: holder as any, buyerId: buyer, tierId, offeringId, variantId: variant, state: { status: 'active', startDate: new Date(now).toISOString(), endDate: new Date(now + 30 * DAY).toISOString(), autoRenew: true } } as any);
    };
    const from = w.notices().length;
    const errors: string[] = [];
    const tried = async (...args: Parameters<P7World['op']>): Promise<void> => {
      const r = await w.op(...args);
      if (!r.ok) errors.push(String(r.error));
    };
    created(H2, U2, 'ulow', 'o-u', `${id}_p7_c11u`);
    if (sellsGuild) created(G, U, 'glow', 'o-g', `${id}_p7_c11g`);
    await w.settle();
    expect((await w.op('grantManual', H2, 'star', 1)).ok).toBe(true);
    if (sellsGuild) expect((await w.op('grantManual', G, 'platinum', 1)).ok).toBe(true);
    if (standIn.capabilities.endedByProviderOnly) {
      const queuedUser = w.stored().subscriptions[H2].paused.find((p: any) => p.providerId === id);
      await tried('cancelAndRemovePausedSubscription', H2, queuedUser.id);
    }
    expect((await w.op('revokeManual', H2)).ok).toBe(true);
    if (sellsGuild) {
      const queued = w.stored().subscriptions[G].paused.find((p: any) => p.providerId === id);
      await tried('cancelAndRemovePausedSubscription', G, queued.id);
    }
    await tried('cancelPaidSubscriptionImmediately', H2);
    const texts = since(w, from).map(n => `${n.to} ${n.kind} ${formatted(n.kind, n.payload, n.to.startsWith('user:') ? 'user' : 'guild').replace(/<t:\d+:/g, '<t:time:')}`);
    expect({ texts, errors }).toEqual(CLAIM11_TEXTS[name]);
    expect(standIn.cancels.map(([subId]) => subId).sort()).toEqual(standIn.capabilities.endedByProviderOnly ? [] : [`${id}_p7_c11g`, `${id}_p7_c11u`]);
  });

  it(`claim 11: a ${name} created event whose offering does not sell its variant logs P6's not-installed line, byte for byte`, async () => {
    const id = standIn.id;
    const link = { providerId: id, enabled: true, mode: 'price', priceConfig: { entries: [{ variantId: `${id}_p7_claim11` }] } };
    expect((await w.op('setTier', 'ulow', { displayName: `${name} low`, priority: 1, overrides: {}, kind: 'user', offerings: [{ id: 'o-u', label: `${name} low`, providerLinks: [link] }] })).ok).toBe(true);
    allowDropLines('L3');
    const from = w.logs.length;
    getPaymentRegistry().emitEvent({
      type: 'subscription.created', providerId: id, providerSubId: `${id}_p7_c11n`, holder: H2 as any, buyerId: U2, tierId: 'ulow', offeringId: 'o-u',
      variantId: `${id}_p7_unsold`, soldVariantOnly: true, state: { status: 'active', startDate: '', endDate: null, autoRenew: true },
    } as any);
    await w.settle();
    const shown = standIn.displayName;
    expect(w.logs.slice(from).filter(l => l.includes('was not installed'))).toEqual([
      `[PremiumManager] subscription.created from ${shown} (subscription ${id}_p7_c11n, ${holderWords(H2 as any)}) was not installed: offering '${name} low' does not sell variant '${id}_p7_unsold' through ${shown}. ${P6_NOT_SOLD(shown, standIn.capabilities.endedByProviderOnly === true)}`,
    ]);
  });

  it(`claim 11: ${name} created events refused because a tier is held at their priority (PD14), by its own record and by a grant, log P6's not-installed lines, byte for byte`, async () => {
    const id = standIn.id;
    const variant = `${id}_p7_claim11`;
    const link = { providerId: id, enabled: true, mode: 'price', priceConfig: { entries: [{ variantId: variant }] } };
    expect((await w.op('setTier', 'ulow', { displayName: `${name} low`, priority: 1, overrides: {}, kind: 'user', offerings: [{ id: 'o-u', label: `${name} low`, providerLinks: [link] }] })).ok).toBe(true);
    allowDropLines('L3');
    const created = (holder: string, buyer: string, providerSubId: string): void => {
      getPaymentRegistry().emitEvent({
        type: 'subscription.created', providerId: id, providerSubId, holder: holder as any, buyerId: buyer, tierId: 'ulow', offeringId: 'o-u',
        variantId: variant, soldVariantOnly: true, state: { status: 'active', startDate: '', endDate: null, autoRenew: true },
      } as any);
    };
    created(H2, U2, `${id}_p7_c11p1`);
    await w.settle();
    expect((await w.op('grantManual', H, 'ulow', 1)).ok).toBe(true);
    const from = w.logs.length;
    created(H2, U2, `${id}_p7_c11p2`);
    created(H, U, `${id}_p7_c11p3`);
    await w.settle();
    const shown = standIn.displayName;
    const ended = standIn.capabilities.endedByProviderOnly === true;
    const p6Next = (own: boolean): string => (!ended
      ? `If ${shown} keeps billing it, cancel it there; refund it at ${shown} if it was paid.`
      : own
        ? `If it replaces that subscription, it is installed once ${shown} ends the old one; otherwise the member cancels it in ${shown}.`
        : `The bot tries again at each check, so it is installed once '${name} low' ends; otherwise the member cancels it in ${shown}.`);
    expect(w.logs.slice(from).filter(l => l.includes('was not installed'))).toEqual([
      `[PremiumManager] subscription.created from ${shown} (subscription ${id}_p7_c11p2, ${holderWords(H2 as any)}) was not installed: ${holderWords(H2 as any)} already holds '${name} low' at that priority. ${p6Next(true)}`,
      `[PremiumManager] subscription.created from ${shown} (subscription ${id}_p7_c11p3, ${holderWords(H as any)}) was not installed: ${holderWords(H as any)} already holds '${name} low' at that priority. ${p6Next(false)}`,
    ]);
  });
});

describe("P7 fix: a Patreon record's not-installed line for a variant its offering does not sell", () => {
  const w = p7World('json');
  beforeEach(async () => {
    await w.setup({ settings: { maskUser: 'none', staleReads: 0, multiTier: false }, webhook: false });
  });
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  it('says the member ends the pledge on patreon.com, from the capability string (fails on a build that names Patreon in the displayName sentence)', async () => {
    allowDropLines('L3');
    const from = w.logs.length;
    getPaymentRegistry().emitEvent({
      type: 'subscription.created', providerId: 'patreon', providerSubId: 'patreon:m-unsold:t-unsold', holder: H as any, buyerId: U, tierId: 'vip', offeringId: 'o-a',
      variantId: 'tier:t-unsold', soldVariantOnly: true, state: { status: 'active', startDate: '', endDate: null, autoRenew: true },
    } as any);
    await w.settle();
    expect(w.logs.slice(from).filter(l => l.includes('was not installed'))).toEqual([
      `[PremiumManager] subscription.created from Patreon (subscription patreon:m-unsold:t-unsold, ${holderWords(H as any)}) was not installed: offering 'VIP' does not sell variant 'tier:t-unsold' through Patreon. ${PT_NOT_SOLD}`,
    ]);
  });

  it('PD14: refused because a tier is held at its priority, by its own record and by a grant, the line ends with the capability string (fails on a build that tells the member to cancel it in Patreon)', async () => {
    allowDropLines('L3');
    const created = (holder: string, buyer: string, providerSubId: string, offeringId: string, ptier: string): void => {
      getPaymentRegistry().emitEvent({
        type: 'subscription.created', providerId: 'patreon', providerSubId, holder: holder as any, buyerId: buyer, tierId: 'vip', offeringId,
        variantId: `tier:${ptier}`, soldVariantOnly: true, state: { status: 'active', startDate: '', endDate: null, autoRenew: true },
      } as any);
    };
    created(H2, U2, `patreon:m-held1:${PTIER.A}`, 'o-a', PTIER.A);
    await w.settle();
    expect((await w.op('grantManual', H, 'vip', 1)).ok).toBe(true);
    const from = w.logs.length;
    created(H2, U2, `patreon:m-held2:${PTIER.A2}`, 'o-a2', PTIER.A2);
    created(H, U, `patreon:m-held3:${PTIER.A}`, 'o-a', PTIER.A);
    await w.settle();
    expect(w.logs.slice(from).filter(l => l.includes('was not installed'))).toEqual([
      `[PremiumManager] subscription.created from Patreon (subscription patreon:m-held2:${PTIER.A2}, ${holderWords(H2 as any)}) was not installed: ${holderWords(H2 as any)} already holds 'VIP' at that priority. If it replaces that subscription, it is installed once Patreon ends the old one. ${PT_ENDS}`,
      `[PremiumManager] subscription.created from Patreon (subscription patreon:m-held3:${PTIER.A}, ${holderWords(H as any)}) was not installed: ${holderWords(H as any)} already holds 'VIP' at that priority. The bot tries again at each check, so it is installed once 'VIP' ends. ${PT_ENDS}`,
    ]);
  });
});

describe.each(BACKENDS)('P7 part 2 on %s: Q2, a queued Patreon record', (_name, backend) => {
  const w = p7World(backend);
  beforeEach(async () => {
    await w.setup({ settings: { maskUser: 'none', staleReads: 0, multiTier: false } });
    await w.advance(31_000);
  });
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  it("Q2: pushed out by a higher manual grant it is queued with PT12 and stays queued while paid; when its tier stops being paid, the read removes it from the queue (fails on P6's tree: no read installs or ends it)", async () => {
    expect((await w.op('linkAccount', 'patreon', PATREON_USERS[0], H, U)).ok).toBe(true);
    const m = w.fake.pledge(PATREON_USERS[0], PTIER.A);
    await w.deliverAll();
    const id = `patreon:${m.id}:${PTIER.A}`;
    expect(heldOf(w, H, id)?.location).toBe('active');
    const from = w.notices().length;
    expect((await w.op('grantManual', H, 'star', 1)).ok).toBe(true);
    const pushed = since(w, from).filter(n => n.kind === 'paid.sub.paused-by-stacking');
    expect(pushed).toHaveLength(1);
    expect(formatted(pushed[0].kind, pushed[0].payload)).toBe(`**Subscription paused:** Your **VIP** (Patreon) subscription is queued behind a higher-tier plan. ${PT12}`);
    await w.advance(11 * MIN);
    await (w.provider as any).checkNow();
    await w.settle();
    expect(heldOf(w, H, id)).toMatchObject({ location: 'paused', sub: { endDate: null } });
    w.fake.cancel(m);
    await w.deliverAll();
    expect(heldOf(w, H, id)).toBeNull();
    expect(w.stored()?.subscriptions?.[H]?.active?.source).toBe('manual');
  });
});
