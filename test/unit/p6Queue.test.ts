import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P6 claim 7 (sheet P6, section 10, part 1): Discord keeps billing a subscription premium queues, so a queued Discord
// record keeps Discord's end (`billedWhileQueued`): an update for it while queued stores its endDate and autoRenew, and
// its resume gives it that stored endDate in place of now plus the days it held at the pause. Q4: the same sequences
// for a Dummy, a PayPal and a Stripe record, each provider registered, give the stored entries 8a3db4b gave. The real
// DiscordProvider and PremiumManager over the JSON files and over the mirror rig, the Client and the fake of
// helpers/p6World.ts.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { PayPalProvider } from '../../src/bot/internalSetup/utils/payment/paypalProvider';
import { StripeProvider } from '../../src/bot/internalSetup/utils/payment/stripeProvider';
import { SKU, type FakeEntitlement } from '../helpers/p6Discord';
import { noticePayloads } from '../helpers/p1Mocks';
import { GUILD, heldDiscord, p6World, START, USERS, type P6World } from '../helpers/p6World';

const U = USERS[0];
const H = `user:${U}`;
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const BACKENDS = [['the JSON files', 'json' as const], ['the mirror rig', 'rig' as const]] as const;

const iso = (ms: number) => new Date(ms).toISOString();

function normalized(entry: unknown): string {
  return JSON.stringify(entry)
    .replace(/"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/g, '"<id>"')
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, m => `<${Math.floor((Date.parse(m) - START) / MIN)}m>`);
}

describe.each(BACKENDS)("P6 part 1, claim 7 on %s: a queued Discord record keeps Discord's end", (_name, backend) => {
  const w = p6World(backend);
  const record = (holder = H): any => w.stored()?.subscriptions?.[holder] ?? null;
  const heldOf = (id: string) => heldDiscord(w.stored()).find(h => h.sub.providerSubId === id) ?? null;

  /** The payload of the last notice of a kind. */
  function lastPayload(kind: string): any {
    const sent = w.notices();
    for (let i = sent.length - 1; i >= 0; i--) if (sent[i].kind === kind) return noticePayloads[i];
    return undefined;
  }

  /** The user's Discord record for SKU A, queued behind a manual grant of the higher tier for a day. */
  async function queuedBehindGrant(): Promise<FakeEntitlement> {
    const a = w.fake.purchase(U, SKU.A);
    await w.deliverAll();
    expect(heldOf(a.id)?.location).toBe('active');
    expect((await w.op('grantManual', H, 'star', 1)).ok).toBe(true);
    expect(heldOf(a.id)).toMatchObject({ location: 'paused', sub: { status: 'paused', endDate: null, autoRenew: true } });
    return a;
  }

  beforeEach(async () => { await w.setup(); });
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  it("Q1: Discord's update while queued stores its end; when the grant ends the record resumes with that endDate, and the resumed notice states it", async () => {
    const a = await queuedBehindGrant();
    const end = Date.now() + 10 * DAY;
    w.fake.endAt(a, end);
    await w.deliverAll();
    expect(heldOf(a.id)).toMatchObject({ location: 'paused', sub: { status: 'paused', endDate: iso(end), autoRenew: false } });
    expect((await w.op('revokeManual', H)).ok).toBe(true);
    expect(record().active).toMatchObject({ providerSubId: a.id, status: 'active', endDate: iso(end), autoRenew: false });
    expect(lastPayload('paid.sub.resumed-from-queue')).toMatchObject({ endDate: iso(end) });
  });

  it('Q2: the stored end passes while queued and Discord says nothing more: at the resume the record is dropped', async () => {
    const a = await queuedBehindGrant();
    const end = Date.now() + 2 * HOUR;
    w.fake.endAt(a, end);
    await w.deliverAll();
    w.fake.fail(/./, { noAnswer: true }, 100_000);
    await w.advance(3 * HOUR);
    expect(heldOf(a.id)?.location).toBe('paused');
    expect((await w.op('revokeManual', H)).ok).toBe(true);
    expect(heldOf(a.id)).toBeNull();
    expect(record()).toBeNull();
    expect(w.auditLines().filter(l => l.action === 'subscription.expire.paid' && l.metadata?.reason === 'expired-while-queued')).toHaveLength(1);
    expect(w.notices().filter(n => n.kind === 'paid.sub.expired')).toHaveLength(1);
  });

  it("Q3: a queued record whose end event was missed resumes renewing, with endDate null, and a later round's single read writes Discord's end", async () => {
    const a = await queuedBehindGrant();
    const end = Date.now() + 10 * DAY;
    w.fake.endAt(a, end);
    expect(w.fake.drop(0)?.name).toBe('entitlementUpdate');
    expect((await w.op('revokeManual', H)).ok).toBe(true);
    expect(record().active).toMatchObject({ providerSubId: a.id, status: 'active', endDate: null, autoRenew: true });
    await w.advance(45 * 1000);
    w.fake.fail('list', { status: 500 });
    const reads = w.fake.calls.filter(c => c.route === 'single').length;
    expect(await w.round()).toBe(true);
    expect(w.fake.calls.filter(c => c.route === 'single').length).toBe(reads + 1);
    expect(record().active).toMatchObject({ providerSubId: a.id, status: 'active', endDate: iso(end), autoRenew: false });
  });
});

/** Q4's sequence: a record of each other provider queued behind a manual grant, a state event while queued, the resume; the queued entries, then the resumed ones. */
async function q4Sequence(w: P6World): Promise<string[]> {
  const record = (holder: string): any => w.stored()?.subscriptions?.[holder] ?? null;
  const U2 = USERS[1];
  const H2 = `user:${U2}`;
  const G = `guild:${GUILD}`;
  getPaymentRegistry().register(new PayPalProvider());
  getPaymentRegistry().register(new StripeProvider());
  expect((await w.op('setTier', 'dlow', { displayName: 'Dummy low', priority: 1, overrides: {}, kind: 'user', offerings: [{ id: 'o-d', label: 'Dummy low', providerLinks: [{ providerId: 'dummy', enabled: true, mode: 'price', priceConfig: { entries: [{ variantId: 'dummy_monthly_999' }] } }] }] })).ok).toBe(true);
  expect((await w.op('setTier', 'gpay', { displayName: 'Gold PayPal', priority: 1, overrides: {}, offerings: [{ id: 'o-p', label: 'Gold PayPal', providerLinks: [{ providerId: 'paypal', enabled: true, mode: 'price', priceConfig: { entries: [{ variantId: 'P-1' }] } }] }] })).ok).toBe(true);
  expect((await w.op('setTier', 'ustripe', { displayName: 'Stripe low', priority: 1, overrides: {}, kind: 'user', offerings: [{ id: 'o-s', label: 'Stripe low', providerLinks: [{ providerId: 'stripe', enabled: true, mode: 'price', priceConfig: { entries: [{ variantId: 'price_p6' }] } }] }] })).ok).toBe(true);
  expect((await w.op('setTier', 'gtop', { displayName: 'Gold top', priority: 5, overrides: {}, offerings: [] })).ok).toBe(true);
  const now = Date.now();
  const start = now - 3 * DAY;
  const stripeMeta = (cancel: boolean) => ({ stripeStatus: 'active', cancelAtPeriodEnd: cancel, pauseCollection: null, currentPeriodStart: iso(start), trialEnd: null });
  getPaymentRegistry().emitEvent({ type: 'subscription.created', providerId: 'dummy', providerSubId: 'dummy_p6_q4', holder: H as any, buyerId: U, tierId: 'dlow', offeringId: 'o-d', variantId: 'dummy_monthly_999', state: { status: 'active', startDate: iso(start), endDate: iso(now + 30 * DAY), autoRenew: true } });
  getPaymentRegistry().emitEvent({ type: 'subscription.created', providerId: 'paypal', providerSubId: 'I-P6Q4', holder: G as any, buyerId: U, tierId: 'gpay', offeringId: 'o-p', variantId: 'P-1', soldVariantOnly: true, state: { status: 'active', startDate: iso(start), endDate: iso(now + 30 * DAY), autoRenew: true, meta: { paypalStatus: 'ACTIVE', planId: 'P-1' } } });
  getPaymentRegistry().emitEvent({ type: 'subscription.created', providerId: 'stripe', providerSubId: 'sub_P6Q4', holder: H2 as any, buyerId: U2, tierId: 'ustripe', offeringId: 'o-s', variantId: 'price_p6', state: { status: 'active', startDate: iso(start), endDate: iso(now + 30 * DAY), autoRenew: true, meta: stripeMeta(false) } });
  await w.settle();
  expect((await w.op('grantManual', H, 'star', 1)).ok).toBe(true);
  expect((await w.op('grantManual', G, 'gtop', 1)).ok).toBe(true);
  expect((await w.op('grantManual', H2, 'star', 1)).ok).toBe(true);
  await w.advance(HOUR);
  const later = Date.now();
  getPaymentRegistry().emitEvent({ type: 'subscription.updated', providerId: 'dummy', providerSubId: 'dummy_p6_q4', holder: H as any, state: { status: 'active', startDate: iso(later), endDate: iso(later + 40 * DAY), autoRenew: false } });
  getPaymentRegistry().emitEvent({ type: 'subscription.updated', providerId: 'paypal', providerSubId: 'I-P6Q4', holder: G as any, state: { status: 'active', startDate: iso(later), endDate: iso(later + 40 * DAY), autoRenew: false, meta: { paypalStatus: 'ACTIVE', planId: 'P-1' } } });
  getPaymentRegistry().emitEvent({ type: 'subscription.updated', providerId: 'stripe', providerSubId: 'sub_P6Q4', holder: H2 as any, state: { status: 'active', startDate: iso(later), endDate: iso(later + 40 * DAY), autoRenew: false, meta: stripeMeta(true) } });
  await w.settle();
  const queued = [normalized(record(H).paused), normalized(record(G).paused), normalized(record(H2).paused)];
  await w.advance(HOUR);
  expect((await w.op('revokeManual', H)).ok).toBe(true);
  expect((await w.op('revokeManual', G)).ok).toBe(true);
  expect((await w.op('revokeManual', H2)).ok).toBe(true);
  return [...queued, normalized(record(H).active), normalized(record(G).active), normalized(record(H2).active)];
}

describe.each(BACKENDS)('P6 part 1, claim 7 Q4 on %s: the same sequences for a Dummy, a PayPal and a Stripe record store what 8a3db4b stored', (_name, backend) => {
  const w = p6World(backend);
  beforeEach(async () => { await w.setup(); });
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  it('queued behind a manual grant, a state event with a later end while queued, then the resume', async () => {
    expect(await q4Sequence(w)).toEqual(Q4_PINNED);
  });
});

const Q4_PINNED = [
  '[{"id":"<id>","tierId":"dlow","source":"paid","offeringId":"o-d","variantId":"dummy_monthly_999","providerId":"dummy","providerSubId":"dummy_p6_q4","purchasedSnapshot":{"offeringLabel":"Dummy low","variantLabel":"","amount":0,"currency":"","durationDays":null,"tierDisplayName":"Dummy low","tierPriority":1,"purchasedAt":"<0m>"},"buyerId":"86500000000000001","startDate":"<-4320m>","endDate":"<43200m>","autoRenew":false,"status":"paused","createdAt":"<0m>","updatedAt":"<60m>","pausedAt":"<0m>","remainingDaysAtPause":30}]',
  '[{"id":"<id>","tierId":"gpay","source":"paid","offeringId":"o-p","variantId":"P-1","providerId":"paypal","providerSubId":"I-P6Q4","providerMeta":{"paypalStatus":"ACTIVE","planId":"P-1"},"purchasedSnapshot":{"offeringLabel":"Gold PayPal","variantLabel":"","amount":0,"currency":"","durationDays":null,"tierDisplayName":"Gold PayPal","tierPriority":1,"purchasedAt":"<0m>"},"buyerId":"86500000000000001","startDate":"<-4320m>","endDate":"<43200m>","autoRenew":false,"status":"paused","createdAt":"<0m>","updatedAt":"<60m>","pausedAt":"<0m>","remainingDaysAtPause":30}]',
  '[{"id":"<id>","tierId":"ustripe","source":"paid","offeringId":"o-s","variantId":"price_p6","providerId":"stripe","providerSubId":"sub_P6Q4","providerMeta":{"stripeStatus":"active","cancelAtPeriodEnd":true,"pauseCollection":null,"currentPeriodStart":"<-4320m>","trialEnd":null},"purchasedSnapshot":{"offeringLabel":"Stripe low","variantLabel":"","amount":0,"currency":"","durationDays":null,"tierDisplayName":"Stripe low","tierPriority":1,"purchasedAt":"<0m>"},"buyerId":"86500000000000002","startDate":"<-4320m>","endDate":"<43200m>","autoRenew":false,"status":"paused","createdAt":"<0m>","updatedAt":"<60m>","pausedAt":"<0m>","remainingDaysAtPause":30}]',
  '{"id":"<id>","tierId":"dlow","source":"paid","offeringId":"o-d","variantId":"dummy_monthly_999","providerId":"dummy","providerSubId":"dummy_p6_q4","purchasedSnapshot":{"offeringLabel":"Dummy low","variantLabel":"","amount":0,"currency":"","durationDays":null,"tierDisplayName":"Dummy low","tierPriority":1,"purchasedAt":"<0m>"},"buyerId":"86500000000000001","startDate":"<120m>","endDate":"<43320m>","autoRenew":false,"status":"active","createdAt":"<0m>","updatedAt":"<120m>"}',
  '{"id":"<id>","tierId":"gpay","source":"paid","offeringId":"o-p","variantId":"P-1","providerId":"paypal","providerSubId":"I-P6Q4","providerMeta":{"paypalStatus":"ACTIVE","planId":"P-1","keptEnd":"<43320m>"},"purchasedSnapshot":{"offeringLabel":"Gold PayPal","variantLabel":"","amount":0,"currency":"","durationDays":null,"tierDisplayName":"Gold PayPal","tierPriority":1,"purchasedAt":"<0m>"},"buyerId":"86500000000000001","startDate":"<120m>","endDate":"<43320m>","autoRenew":false,"status":"active","createdAt":"<0m>","updatedAt":"<120m>"}',
  '{"id":"<id>","tierId":"ustripe","source":"paid","offeringId":"o-s","variantId":"price_p6","providerId":"stripe","providerSubId":"sub_P6Q4","providerMeta":{"stripeStatus":"active","cancelAtPeriodEnd":true,"pauseCollection":null,"currentPeriodStart":"<-4320m>","trialEnd":null},"purchasedSnapshot":{"offeringLabel":"Stripe low","variantLabel":"","amount":0,"currency":"","durationDays":null,"tierDisplayName":"Stripe low","tierPriority":1,"purchasedAt":"<0m>"},"buyerId":"86500000000000002","startDate":"<120m>","endDate":"<43320m>","autoRenew":false,"status":"active","createdAt":"<0m>","updatedAt":"<120m>"}',
];
