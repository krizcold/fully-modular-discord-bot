import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P5 claims 4 to 8 and 14 (sheet P5, Revision 9, Z4 to Z7 and Z13): what PayPal's events install, every object read
// fresh, Z5's status table and end, refunds, repeats and order, and the chains. Purchases go through the real
// initiatePurchase (a server on the member route, a user on the dev user route), approved by the fake; premium's copy
// comes from delivered events. Ends are computed by Z5 from the fake's own fields (helpers/p5Model.ts).

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());
vi.mock('../../src/bot/internalSetup/utils/appStoreManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/appStoreManager')>();
  const store = { getCachedModules: () => [], getRepositories: () => [], getInstalledModules: () => [], getAvailableModules: async () => [] };
  return { ...real, getAppStoreManager: () => store };
});

import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { getPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { holderWords } from '../../src/bot/internalSetup/utils/premiumHolder';
import { allowDropLines } from '../helpers/p1Guard';
import { z5End } from '../helpers/p5Model';
import { addCycles, customIdFor, FakeRefusal, type FakeSettings, type PayPalEvent } from '../helpers/p5PayPal';
import { BOT_CLIENT_ID, EXTRA_PLANS, heldPayPal, IDS, ONCE_LINK, p5World, planId, TIERS, type Delivered, type PlanKind, type TierId } from '../helpers/p5World';
import { onceEnd, onceProof } from '../helpers/p5Model';
import { FINAL_CYCLES, HOUR, onceKit, PL16, PL16_ALREADY, PL17, PL17_ANY, PL18, PL18_ENDED, PL18_NONE, PL18_UNCOUNTED, PL19, PL6, PW7, PW7_NONE, PW8, RF } from '../helpers/p5pOnce';

const DAY = 86_400_000;
const T0 = Date.UTC(2027, 0, 31, 12);
type Kind = 'guild' | 'user';
const KINDS: Array<[string, Kind]> = [['a server', 'guild'], ['a user', 'user']];
const SUB_READ = /^\/v1\/billing\/subscriptions\/I-[^/?]+$/;
const PLAN_READ = /^\/v1\/billing\/plans\/[^/?]+$/;

const w = p5World('json');

beforeEach(async () => { await w.setup({ clock: T0 }); });
afterEach(async () => {
  await w.teardown();
  vi.restoreAllMocks();
});

const holderOf = (k: Kind): string => (k === 'guild' ? `guild:${IDS[0]}` : `user:${IDS[1]}`);
const buyerOf = (k: Kind): string => (k === 'guild' ? IDS[0] : IDS[1]);
const tierOf = (k: Kind, level: 'low' | 'high' = 'low'): TierId => TIERS[k][level];
const words = (k: Kind): string => holderWords(holderOf(k) as any);
const ms = (iso: string | null | undefined): number => Date.parse(String(iso));
const isoOf = (at: number): string => new Date(at).toISOString();
const errorOf = (out: Delivered): string => String((out.reply as any)?.error ?? (out.reply as any)?.body?.error ?? '');
const fakeSub = (id: string): any => w.fake.subscriptions.get(id);

/** The trial plan linked beside the cheap and dear plans of every tier. */
const TRIAL_LINK: Partial<Record<TierId, string[]>> = Object.fromEntries((['gold', 'platinum', 'vip', 'star'] as TierId[])
  .map(t => [t, [EXTRA_PLANS.trial, planId(t, 'cheap'), planId(t, 'dear')]]));

async function restart(opts: Parameters<typeof w.setup>[0]): Promise<void> {
  await w.teardown();
  await w.setup({ clock: T0, ...opts });
}

/** A purchase through the real checkout; the subscription it made at the fake. */
async function buy(k: Kind, opts: { level?: 'low' | 'high'; plan?: PlanKind | string } = {}): Promise<string> {
  const tierId = tierOf(k, opts.level);
  const plan = opts.plan === undefined || opts.plan === 'cheap' || opts.plan === 'dear' ? planId(tierId, (opts.plan ?? 'cheap') as PlanKind) : opts.plan;
  const reply = k === 'guild'
    ? await w.buyMember(holderOf(k), buyerOf(k), { tierId, plan })
    : await w.buyDev(holderOf(k), buyerOf(k), { tierId, plan });
  if (!reply.subscriptionId) throw new Error(`the purchase made no subscription: ${JSON.stringify(reply.body)}`);
  return reply.subscriptionId;
}

/** Bought, approved and every queued event delivered. */
async function owned(k: Kind, opts: { level?: 'low' | 'high'; plan?: PlanKind | string; firstSale?: 'now' | 'later' | 'fail' } = {}): Promise<string> {
  const id = await buy(k, opts);
  w.fake.approve(id, { firstSale: opts.firstSale });
  await drain();
  return id;
}

/** Every queued event delivered, the oldest first, including the ones premium's calls queue meanwhile. */
async function drain(): Promise<Delivered[]> {
  const outs = await w.drain();
  await w.settle();
  outs.push(...await w.drain());
  return outs;
}

const heldOf = (id: string) => heldPayPal(w.stored()).find(h => h.sub.providerSubId === id) ?? null;
/** The queued event of this type for the subscription (or the sale of it), taken out of the queue. */
function take(type: string, id: string): PayPalEvent {
  const index = w.fake.queue.findIndex(e => e.event_type === type && (e.resource.id === id || e.resource.billing_agreement_id === id));
  if (index < 0) throw new Error(`no queued ${type} for ${id}`);
  return w.fake.dequeue(index)!;
}
const lastDelivered = (type: string, id: string): PayPalEvent => {
  const found = [...w.delivered].reverse().find(d => d.event?.event_type === type && (d.event.resource.id === id || d.event.resource.billing_agreement_id === id));
  if (!found?.event) throw new Error(`no delivered ${type} for ${id}`);
  return found.event;
};
const emittedFor = (id: string) => w.emitted.filter(e => e.providerSubId === id);
const cancels = (id: string) => w.fake.callsOf('POST', new RegExp(`^/v1/billing/subscriptions/${id}/cancel$`)).length;
const suspends = (id: string) => w.fake.callsOf('POST', new RegExp(`^/v1/billing/subscriptions/${id}/suspend$`)).length;
const installLines = () => w.auditLines().filter(l => l.action === 'subscription.install.paid');
const premium = (): any => getPremiumManager();
const live = (holder: string): any => premium().config.subscriptions[holder];
/** The tier premium gives the holder now. */
const tierNow = (k: Kind): string | null => (k === 'guild' ? premium().resolveActiveTier(IDS[0]).tierId : premium().resolveActiveUserTier(IDS[1])?.tierId ?? null);
/** Premium's copy with no `updatedAt`, to compare two moments. */
const plain = (): any => JSON.parse(JSON.stringify(w.stored()?.subscriptions ?? {}, (key, value) => (key === 'updatedAt' ? undefined : value)));
async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe.each(KINDS)('P5 claim 4: what is installed, for %s', (_name, k) => {
  it('CREATED while approval is pending installs nothing; ACTIVATED after approve installs it once with the custom_id fields', async () => {
    const id = await buy(k);
    const created = await w.deliverNext(0);
    expect([created?.event?.event_type, created?.status]).toEqual(['BILLING.SUBSCRIPTION.CREATED', 200]);
    expect(heldOf(id)).toBeNull();
    w.fake.approve(id);
    await drain();
    expect(heldOf(id)).toMatchObject({
      holder: holderOf(k), location: 'active',
      sub: { buyerId: buyerOf(k), tierId: tierOf(k), offeringId: `o-${tierOf(k)}`, variantId: planId(tierOf(k), 'cheap'), status: 'active', autoRenew: true },
    });
    expect(installLines()).toHaveLength(1);
  });

  it('ACTIVATED read with no last_payment installs nothing; the first sale COMPLETED installs it once', async () => {
    const id = await buy(k);
    w.fake.approve(id, { firstSale: 'later' });
    await drain();
    expect(heldOf(id)).toBeNull();
    w.fake.completeFirstSale(id);
    await drain();
    expect(heldOf(id)?.location).toBe('active');
    expect(installLines()).toHaveLength(1);
  });

  it('a forged custom_id (a made-up signature, or a signed one with its tier changed) is never installed: PL2 once each', async () => {
    const tierId = tierOf(k);
    const real = customIdFor({ clientId: BOT_CLIENT_ID, holder: holderOf(k), buyerId: buyerOf(k), tierId, offeringId: `o-${tierId}` });
    const made = w.fake.forge(planId(tierId, 'cheap'), `${holderOf(k)}|${buyerOf(k)}|${tierId}|o-${tierId}|AAAAAAAAAAAAAAAAAAAAAA`);
    const high = tierOf(k, 'high');
    const changed = w.fake.forge(planId(high, 'cheap'), real.replace(`|${tierId}|o-${tierId}|`, `|${high}|o-${high}|`));
    const outs = await drain();
    expect(outs.every(o => o.status === 200)).toBe(true);
    expect(heldPayPal(w.stored())).toEqual([]);
    for (const sub of [made, changed]) {
      expect(w.logged(`[PayPalProvider] A BILLING.SUBSCRIPTION.CREATED event for subscription ${sub.id} was not applied: its custom_id's signature does not match and the bot holds no such subscription.`)).toHaveLength(1);
      expect(w.logged(`subscription ${sub.id} was not applied: its custom_id's signature`)).toHaveLength(1);
    }
  });

  it("the second bot's subscription delivered to the first: PL2, and its refund there sends no cancel", async () => {
    const second = await w.buySecondBot(holderOf(k), buyerOf(k), { tierId: tierOf(k) });
    expect(second.error).toBeNull();
    const id = second.subscriptionId!;
    w.fake.approve(id);
    await drain();
    expect(heldPayPal(w.stored())).toEqual([]);
    expect(w.logged(`event for subscription ${id} was not applied: its custom_id's signature does not match`)).toHaveLength(1);
    w.fake.refund(w.fake.latestSale(id)!.id);
    const outs = await drain();
    expect(outs.map(o => o.status)).toEqual([200]);
    expect(cancels(id)).toBe(0);
  });

  it("a signed subscription moved by changePlan to a plan the offering does not sell is not installed: the 'variant' warning", async () => {
    allowDropLines('L3');
    const id = await buy(k);
    w.fake.approve(id);
    w.fake.changePlan(id, EXTRA_PLANS.unlinked);
    await drain();
    expect(heldOf(id)).toBeNull();
    const label = { gold: 'Gold', vip: 'VIP' }[tierOf(k) as 'gold' | 'vip'];
    expect(w.logged(`[PremiumManager] subscription.created from PayPal (subscription ${id}, ${words(k)}) was not installed: offering '${label}' does not sell variant '${EXTRA_PLANS.unlinked}' through PayPal. If PayPal keeps billing it, cancel it there; refund it at PayPal if it was paid.`).length).toBeGreaterThan(0);
  });

  it("a second subscription of the held tier, both approved: one installed, the other refused as 'priority' with the warning, again at its next delivery", async () => {
    allowDropLines('L3');
    const first = await buy(k);
    const second = await buy(k);
    w.fake.approve(first);
    w.fake.approve(second);
    await drain();
    expect([heldOf(first)?.location, heldOf(second)]).toEqual(['active', null]);
    expect(fakeSub(second).status).toBe('ACTIVE');
    const label = { gold: 'Gold', vip: 'VIP' }[tierOf(k) as 'gold' | 'vip'];
    const line = `[PremiumManager] subscription.created from PayPal (subscription ${second}, ${words(k)}) was not installed: ${words(k)} already holds '${label}' at that priority. If PayPal keeps billing it, cancel it there; refund it at PayPal if it was paid.`;
    const before = w.logged(line).length;
    expect(before).toBeGreaterThan(0);
    expect(w.logged('[PremiumManager] subscription.created from PayPal').every(l => l === line)).toBe(true);
    expect(w.logged('installAsyncSubscription failed')).toEqual([]);
    await w.deliver(lastDelivered('PAYMENT.SALE.COMPLETED', second));
    expect([heldOf(first)?.location, heldOf(second), w.logged(line).length]).toEqual(['active', null, before + 1]);
  });

  it.each([
    ['cancelled', (id: string) => w.fake.buyerCancel(id)],
    ['suspended', (id: string) => w.fake.suspendNoFailure(id)],
  ])('a paid subscription %s at PayPal before any delivery is applied: nothing installed, the refund line at each delivery; with no payment, no line', async (word, change) => {
    const id = await buy(k);
    w.fake.approve(id);
    change(id);
    const outs = await drain();
    expect(outs.map(o => o.status).every(s => s === 200)).toBe(true);
    expect(heldOf(id)).toBeNull();
    const line = `[PayPalProvider] PayPal took a payment for subscription ${id} (${words(k)}), which is ${word} at PayPal and not held by the bot, so the bot installs nothing. If it was ${word} before the bot installed it, the buyer paid and did not get the tier: refund it in PayPal's dashboard.`;
    expect(w.logged(line)).toHaveLength(outs.length);
    const unpaid = await buy(k);
    w.fake.approve(unpaid, { firstSale: 'later' });
    change(unpaid);
    await drain();
    expect([heldOf(unpaid), w.logged(`PayPal took a payment for subscription ${unpaid}`)]).toEqual([null, []]);
  });

  it('quantity 2 is not installed: PL4', async () => {
    const tierId = tierOf(k);
    const custom = customIdFor({ clientId: BOT_CLIENT_ID, holder: holderOf(k), buyerId: buyerOf(k), tierId, offeringId: `o-${tierId}` });
    const sub = w.fake.forge(EXTRA_PLANS.quantity, custom, { quantity: '2' });
    await drain();
    expect(heldPayPal(w.stored())).toEqual([]);
    expect(w.logged(`[PayPalProvider] Subscription ${sub.id} (${words(k)}) is for quantity 2; the bot sells quantity 1 only, so nothing was installed. Cancel and refund it in PayPal's dashboard if it was paid.`).length).toBeGreaterThan(0);
  });

  it("today's JSON custom_id is never installed: PL1 once", async () => {
    const tierId = tierOf(k);
    const sub = w.fake.forge(planId(tierId, 'cheap'), JSON.stringify({ guildId: IDS[0], tierId, offeringId: `o-${tierId}`, userId: buyerOf(k) }));
    await drain();
    expect(heldPayPal(w.stored())).toEqual([]);
    expect(w.logged(`[PayPalProvider] A BILLING.SUBSCRIPTION.CREATED event for subscription ${sub.id} was not applied: its custom_id is not one this version of the bot writes. It was made before this version or not by this bot; the bot does not manage it.`)).toHaveLength(1);
    expect(w.logged(`subscription ${sub.id} was not applied: its custom_id is not one`)).toHaveLength(1);
  });

  it("one moved by the bot's own migration to the offering's other plan stays signed and syncs", async () => {
    const id = await owned(k);
    await getPaymentRegistry().get('paypal')!.migrateSubscriptionPrice!(id, planId(tierOf(k), 'dear'), 'none');
    w.fake.approveRevision(id);
    await drain();
    const held = heldOf(id)!;
    expect(held).toMatchObject({ location: 'active', sub: { providerMeta: { planId: planId(tierOf(k), 'dear') } } });
    expect(ms(held.sub.endDate)).toBe(z5End(w.fake, id).end);
  });
});

/** A delivery of `type` whose resource is older than the fake's: another status, another plan, another holder. */
function staleEvent(type: string, id: string): PayPalEvent {
  const other = customIdFor({ clientId: BOT_CLIENT_ID, holder: `guild:${IDS[1]}`, buyerId: IDS[1], tierId: 'gold', offeringId: 'o-gold' });
  const resource = type.startsWith('BILLING.SUBSCRIPTION.')
    ? { id, status: type.endsWith('CANCELLED') ? 'CANCELLED' : 'APPROVAL_PENDING', plan_id: EXTRA_PLANS.unlinked, custom_id: other, billing_info: { next_billing_time: '2026-01-01T00:00:00Z' } }
    : { id: '5P5STALESALE', state: 'pending', billing_agreement_id: id, amount: { total: '1.00', currency: 'USD' } };
  return {
    id: `WH-P5-STALE-${type}`, event_version: '1.0', create_time: '2026-01-01T00:00:00Z', resource_type: type.startsWith('BILLING') ? 'subscription' : 'sale',
    resource_version: '2.0', event_type: type, summary: 'stale', resource, links: [],
  };
}

describe('P5 claim 5: every object is read fresh', () => {
  it.each([
    'BILLING.SUBSCRIPTION.ACTIVATED', 'BILLING.SUBSCRIPTION.UPDATED', 'BILLING.SUBSCRIPTION.CANCELLED', 'BILLING.SUBSCRIPTION.SUSPENDED',
    'BILLING.SUBSCRIPTION.EXPIRED', 'BILLING.SUBSCRIPTION.PAYMENT.FAILED', 'PAYMENT.SALE.COMPLETED',
  ])('%s carrying an older resource: premium gets the current state for the current custom_id holder', async type => {
    const id = await owned('guild');
    const before = ms(heldOf(id)!.sub.endDate);
    w.fake.renew(id);
    w.fake.queue.length = 0;
    const out = await w.deliver(staleEvent(type, id));
    expect(out.status).toBe(200);
    const held = heldPayPal(w.stored());
    expect(held.map(h => [h.holder, h.sub.providerSubId, h.location])).toEqual([[`guild:${IDS[0]}`, id, 'active']]);
    expect(held[0].sub).toMatchObject({ status: 'active', autoRenew: true, providerMeta: { paypalStatus: 'ACTIVE', planId: planId('gold', 'cheap') } });
    expect(ms(held[0].sub.endDate)).toBe(z5End(w.fake, id).end);
    expect(ms(held[0].sub.endDate)).toBeGreaterThan(before);
  });

  it.each([
    ['500', { status: 500 }], ['401', { status: 401 }], ['429', { status: 429 }], ['no answer', { drop: 'before' as const }],
  ])('a subscription read answering %s: 400 PW3, premium unchanged, then the next delivery applies it', async (_name, fault) => {
    const id = await buy('guild');
    w.fake.approve(id);
    take('BILLING.SUBSCRIPTION.CREATED', id);
    const event = take('BILLING.SUBSCRIPTION.ACTIVATED', id);
    const before = w.storedText();
    w.fake.fail('GET', SUB_READ, fault as any);
    const first = await w.deliver(event);
    expect(first.status).toBe(400);
    expect(errorOf(first)).toMatch(new RegExp(`^PayPal webhook not applied: the bot could not read subscription ${id} at PayPal \\(.+\\); PayPal sends the event again\\.$`));
    expect(w.storedText()).toBe(before);
    const again = await w.deliver(event);
    expect([again.status, heldOf(id)?.location]).toEqual([200, 'active']);
  });

  it('a subscription read answering 404: 200 and PL9, nothing installed', async () => {
    const id = await buy('guild');
    w.fake.approve(id);
    take('BILLING.SUBSCRIPTION.CREATED', id);
    const event = take('BILLING.SUBSCRIPTION.ACTIVATED', id);
    w.fake.deleteObject('subscription', id);
    const out = await w.deliver(event);
    expect([out.status, errorOf(out)]).toEqual([200, '']);
    expect(w.logged(`[PayPalProvider] A BILLING.SUBSCRIPTION.ACTIVATED event was not applied: PayPal has no subscription ${id} (404).`)).toHaveLength(1);
    expect(heldOf(id)).toBeNull();
  });
});

describe.each(KINDS)('P5 claim 6: the status table and the end, for %s', (_name, k) => {
  it('a renewal paid: the end is PayPal\'s new next_billing_time plus a day; on the anchor Jan 31, Feb 28, Mar 31 each time, with no notice between renewals', async () => {
    const id = await owned(k);
    const afterInstall = w.notices().length;
    const gaps: number[] = [];
    const gap = () => ms(heldOf(id)!.sub.endDate) - (ms(fakeSub(id).billing_info.next_billing_time) + DAY);
    gaps.push(gap());
    for (let i = 0; i < 2; i++) {
      w.fake.renew(id);
      await drain();
      gaps.push(gap());
    }
    expect(gaps).toEqual([0, 0, 0]);
    expect(w.fake.salesOf(id).map(s => s.create_time.slice(0, 10))).toEqual(['2027-01-31', '2027-02-28', '2027-03-31']);
    expect(w.notices().length).toBe(afterInstall);
  });

  it('a three-cycle free trial: the end is PayPal\'s trial end plus a day', async () => {
    await restart({ link: TRIAL_LINK });
    const id = await owned(k, { plan: EXTRA_PLANS.trial });
    const sub = fakeSub(id);
    expect(sub.billing_info.last_payment).toBeUndefined();
    expect(ms(heldOf(id)!.sub.endDate)).toBe(ms(sub.start_time) + 21 * DAY + DAY);
    expect(ms(heldOf(id)!.sub.endDate)).toBe(ms(sub.billing_info.next_billing_time) + DAY);
  });

  it('a failed renewal keeps the tier to sideEnd plus 10 days with paymentFailing; the count reaching 1 does not grow it; a retry that succeeds gives the new date plus a day and clears the flag', async () => {
    const id = await owned(k);
    w.fake.failPayment(id, { count: 0 });
    await drain();
    let held = heldOf(id)!.sub;
    expect([held.status, ms(held.endDate) - (ms(fakeSub(id).billing_info.next_billing_time) + 11 * DAY), held.providerMeta.paymentFailing]).toEqual(['active', 0, true]);
    const windowed = ms(held.endDate);
    w.fake.failPayment(id, { count: 1 });
    await drain();
    expect(ms(heldOf(id)!.sub.endDate)).toBe(windowed);
    w.fake.retrySucceeds(id);
    await drain();
    held = heldOf(id)!.sub;
    expect([ms(held.endDate) - (ms(fakeSub(id).billing_info.next_billing_time) + DAY), held.providerMeta.paymentFailing]).toEqual([0, undefined]);
  });

  it('a failed renewal with next_billing_time moved a cycle on: the end is at most longest plus a day plus the window', async () => {
    const id = await owned(k);
    w.fake.failPayment(id, { count: 0, moveNext: true });
    await drain();
    const held = heldOf(id)!.sub;
    const lastPayment = ms(fakeSub(id).billing_info.last_payment.time);
    expect(ms(held.endDate)).toBeLessThanOrEqual(lastPayment + 31 * DAY + DAY + 10 * DAY);
    expect(ms(held.endDate)).toBe(z5End(w.fake, id).end);
    expect(held.providerMeta.paymentFailing).toBe(true);
  });

  it('a balance above 0 after a later successful payment, count 0: not failing, the end from that payment, no flag', async () => {
    const id = await owned(k);
    w.fake.failPayment(id, { count: 0, moveNext: true });
    const failedAt = ms(fakeSub(id).billing_info.last_failed_payment.time);
    w.fake.renew(id, { at: failedAt + DAY });
    await drain();
    expect(Number(fakeSub(id).billing_info.outstanding_balance.value)).toBeGreaterThan(0);
    const model = z5End(w.fake, id);
    expect(model.failing).toBe(false);
    const held = heldOf(id)!.sub;
    expect([ms(held.endDate), held.providerMeta.paymentFailing]).toEqual([model.end, undefined]);
  });

  it('failPayment then buyerCancel: the end is sideEnd, no window, no flag', async () => {
    const id = await owned(k);
    w.fake.failPayment(id, { count: 0 });
    await drain();
    expect(heldOf(id)!.sub.providerMeta.paymentFailing).toBe(true);
    w.fake.buyerCancel(id);
    await drain();
    const held = heldOf(id)!.sub;
    const lastPayment = ms(fakeSub(id).billing_info.last_payment.time);
    expect([held.status, held.autoRenew, held.providerMeta.paymentFailing]).toEqual(['active', false, undefined]);
    expect(ms(held.endDate)).toBe(addCycles(lastPayment, 'MONTH', 1, 1) + DAY);
  });

  it('buyerCancel after one payment: active, auto-renew off, the end of Z5; a cancel with no payment: nothing held', async () => {
    const id = await owned(k);
    w.fake.buyerCancel(id);
    await drain();
    const held = heldOf(id)!.sub;
    expect([held.status, held.autoRenew, held.providerMeta.paypalStatus]).toEqual(['active', false, 'CANCELLED']);
    expect(ms(held.endDate)).toBe(z5End(w.fake, id).end);
    expect((await w.op('cancelPaidSubscriptionImmediately', holderOf(k))).ok).toBe(true);
    const unpaid = await buy(k);
    w.fake.approve(unpaid, { firstSale: 'later' });
    w.fake.buyerCancel(unpaid);
    await drain();
    expect(heldOf(unpaid)).toBeNull();
  });

  it('retries that fail and PayPal suspends: the tier is held only to the end of what was paid, which has passed, PL7, and the checker frees it at once', async () => {
    const id = await owned(k);
    w.later(33 * DAY);
    w.fake.failPayment(id, { count: 1 });
    w.fake.suspendForFailures(id);
    await drain();
    const held = heldOf(id)!.sub;
    const model = z5End(w.fake, id);
    expect([held.status, held.autoRenew, ms(held.endDate), held.providerMeta.paymentFailing]).toEqual(['active', true, model.end, undefined]);
    expect(model.end!).toBeLessThan(Date.now());
    expect(w.logged(`[PayPalProvider] PayPal suspended subscription ${id} (${words(k)}) after 1 failed payments (Suspended after failed payments); the bot gives its tier only until ${isoOf(model.end!)}, a day after the end of what was paid.`).length).toBeGreaterThan(0);
    await w.tick();
    expect(heldOf(id)).toBeNull();
    expect(w.notices().filter(n => n.kind === 'paid.sub.expired')).toHaveLength(1);
  });

  it('PayPal suspending a resumed entry after failed payments: PL7 names the resumed end it keeps, with no claim about what was paid', async () => {
    const low = await owned(k);
    w.fake.failPayment(low, { count: 0 });
    await drain();
    const high = await owned(k, { level: 'high' });
    w.later(5 * DAY);
    w.fake.expire(high);
    await drain();
    const resumed = heldOf(low)!;
    expect([resumed.location, resumed.sub.providerMeta.paypalStatus]).toEqual(['active', 'ACTIVE']);
    w.fake.suspendForFailures(low, { count: 1 });
    await drain();
    const held = heldOf(low)!.sub;
    expect([held.endDate, held.providerMeta.paypalStatus]).toEqual([resumed.sub.endDate, 'SUSPENDED']);
    expect(ms(held.endDate)).toBeGreaterThan(z5End(w.fake, low).end!);
    expect(w.logged(`[PayPalProvider] PayPal suspended subscription ${low} (${words(k)}) after 1 failed payments (Suspended after failed payments); the bot gives its tier only until ${held.endDate}.`)).toHaveLength(1);
  });

  it('PayPal suspending a resumed entry with no failed payment: PL12 names the resumed end it keeps, with no claim about what was paid', async () => {
    const low = await owned(k);
    const high = await owned(k, { level: 'high' });
    w.later(5 * DAY);
    w.fake.expire(high);
    await drain();
    const resumed = heldOf(low)!;
    expect([resumed.location, resumed.sub.providerMeta.paypalStatus]).toEqual(['active', 'ACTIVE']);
    w.fake.suspendNoFailure(low);
    await drain();
    const held = heldOf(low)!.sub;
    expect([held.endDate, held.providerMeta.paypalStatus]).toEqual([resumed.sub.endDate, 'SUSPENDED']);
    expect(ms(held.endDate)).toBeGreaterThan(z5End(w.fake, low).end!);
    expect(w.logged(`[PayPalProvider] PayPal reports subscription ${low} (${words(k)}) suspended with no failed payment (Suspended by the merchant); the bot gives its tier only until ${held.endDate}.`)).toHaveLength(1);
  });

  it('suspendNoFailure of a held active one: active, auto-renew on, the end of Z5 with no window, PL12 once', async () => {
    const id = await owned(k);
    w.fake.suspendNoFailure(id);
    await drain();
    await w.deliver(lastDelivered('BILLING.SUBSCRIPTION.SUSPENDED', id));
    const held = heldOf(id)!.sub;
    const model = z5End(w.fake, id);
    expect([held.status, held.autoRenew, ms(held.endDate)]).toEqual(['active', true, model.end]);
    expect(w.logged(`[PayPalProvider] PayPal reports subscription ${id} (${words(k)}) suspended with no failed payment (Suspended by the merchant); the bot gives its tier only until ${isoOf(model.end!)}, a day after the end of what was paid.`)).toHaveLength(1);
  });

  it('a lower-priority tier bought while a higher one is active: after ACTIVATED it is queued, no active state follows, the bot\'s suspend lands, and its meta says SUSPENDED with computedEnd its held end', async () => {
    await owned(k, { level: 'high' });
    const low = await buy(k);
    w.fake.approve(low);
    take('BILLING.SUBSCRIPTION.CREATED', low);
    await w.deliver(take('BILLING.SUBSCRIPTION.ACTIVATED', low));
    await w.settle();
    expect(heldOf(low)).toMatchObject({ location: 'paused', sub: { status: 'paused' } });
    expect(emittedFor(low).map(e => e.type)).toEqual(['subscription.created']);
    expect(fakeSub(low).status).toBe('SUSPENDED');
    const end = heldOf(low)!.sub.endDate;
    await drain();
    const queued = heldOf(low)!;
    expect(queued).toMatchObject({ location: 'paused', sub: { status: 'paused', endDate: end, providerMeta: { paypalStatus: 'SUSPENDED' } } });
    expect(ms(queued.sub.providerMeta.computedEnd)).toBe(ms(end));
    expect(emittedFor(low).filter(e => e.state?.status === 'active').map(e => e.type)).toEqual(['subscription.created']);
  });

  it('a failing active one pushed into the queue stays queued with no PL7 and resumes; read failing after the resume, its end is the resumed end with paymentFailing, kept after buyerCancel', async () => {
    const low = await owned(k);
    w.fake.failPayment(low, { count: 0 });
    await drain();
    expect(heldOf(low)!.sub.providerMeta.paymentFailing).toBe(true);
    const high = await owned(k, { level: 'high' });
    const queued = heldOf(low)!;
    expect(queued).toMatchObject({ location: 'paused', sub: { status: 'paused' } });
    expect(fakeSub(low).status).toBe('SUSPENDED');
    expect(w.logged('PayPal suspended subscription')).toEqual([]);
    const remaining = queued.sub.remainingDaysAtPause;
    expect(remaining).toBeGreaterThan(0);
    w.later(5 * DAY);
    const from = Date.now();
    w.fake.expire(high);
    await drain();
    const to = Date.now();
    const resumed = heldOf(low)!;
    expect(resumed).toMatchObject({ location: 'active', sub: { status: 'active', providerMeta: { paypalStatus: 'ACTIVE', paymentFailing: true } } });
    const end = ms(resumed.sub.endDate);
    expect(end).toBeGreaterThanOrEqual(from + remaining * DAY);
    expect(end).toBeLessThanOrEqual(to + remaining * DAY);
    expect(end).toBeGreaterThan(z5End(w.fake, low).side!);
    expect(tierNow(k)).toBe(tierOf(k));
    w.fake.buyerCancel(low);
    await drain();
    expect([ms(heldOf(low)!.sub.endDate), heldOf(low)!.sub.autoRenew]).toEqual([end, false]);
  });

  it('a resumed entry whose activate the fake refuses keeps its SUSPENDED meta, and a SUSPENDED delivery then holds it to the resumed end', async () => {
    const low = await owned(k);
    const high = await owned(k, { level: 'high' });
    expect(heldOf(low)!.sub.providerMeta.paypalStatus).toBe('SUSPENDED');
    w.fake.fail('POST', /\/activate$/, { status: 422, issue: 'SUBSCRIPTION_STATUS_INVALID' });
    w.later(5 * DAY);
    w.fake.expire(high);
    await drain();
    const resumed = heldOf(low)!;
    expect(resumed).toMatchObject({ location: 'active', sub: { status: 'active', providerMeta: { paypalStatus: 'SUSPENDED' } } });
    expect(fakeSub(low).status).toBe('SUSPENDED');
    expect(w.logged("[PremiumManager] provider resumeSubscription failed for 'paypal'").length).toBe(1);
    const end = resumed.sub.endDate;
    await w.deliver(lastDelivered('BILLING.SUBSCRIPTION.SUSPENDED', low));
    expect(heldOf(low)!.sub).toMatchObject({ status: 'active', autoRenew: true, endDate: end });
    w.later(ms(end) - Date.now() - 3_600_000);
    await w.tick();
    expect([heldOf(low)?.location, tierNow(k)]).toEqual(['active', tierOf(k)]);
    w.later(2 * 3_600_000);
    await w.tick();
    expect(heldOf(low)).toBeNull();
    expect(tierNow(k)).not.toBe(tierOf(k));
  });

  it('a queued entry PayPal bills: with premium\'s suspend refused, the COMPLETED delivery leaves it queued, sends one suspend that lands, logs PL14 once', async () => {
    await owned(k, { level: 'high' });
    const low = await buy(k);
    w.fake.fail('POST', /\/suspend$/, { status: 422, issue: 'SUBSCRIPTION_STATUS_INVALID' });
    w.fake.approve(low);
    take('BILLING.SUBSCRIPTION.CREATED', low);
    await w.deliver(take('BILLING.SUBSCRIPTION.ACTIVATED', low));
    await w.settle();
    expect([heldOf(low)?.location, fakeSub(low).status]).toEqual(['paused', 'ACTIVE']);
    w.fake.renew(low);
    await drain();
    expect([heldOf(low)?.location, heldOf(low)?.sub.status, fakeSub(low).status, suspends(low)]).toEqual(['paused', 'paused', 'SUSPENDED', 2]);
    expect(w.logged('[PayPalProvider] PayPal reported queued subscription')).toEqual([
      `[PayPalProvider] PayPal reported queued subscription ${low} (${words(k)}) active; the bot suspended it again; payments taken while it was queued are not added to its days: refund them in PayPal's dashboard if needed.`,
    ]);
    expect(emittedFor(low).filter(e => e.state?.status === 'active').map(e => e.type)).toEqual(['subscription.created']);
  });

  it("a queued entry PayPal bills, with the bot's second suspend refused too: PL14's failure form", async () => {
    await owned(k, { level: 'high' });
    const low = await buy(k);
    w.fake.fail('POST', /\/suspend$/, { status: 422, issue: 'SUBSCRIPTION_STATUS_INVALID' }, 2);
    w.fake.approve(low);
    take('BILLING.SUBSCRIPTION.CREATED', low);
    await w.deliver(take('BILLING.SUBSCRIPTION.ACTIVATED', low));
    await w.settle();
    await w.deliver(take('PAYMENT.SALE.COMPLETED', low));
    expect(heldOf(low)?.location).toBe('paused');
    const lines = w.logged('[PayPalProvider] PayPal reported queued subscription');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`^\\[PayPalProvider\\] PayPal reported queued subscription ${low} \\(${words(k)}\\) active; the bot's suspend failed again: PayPal answered 422: .+, so PayPal keeps billing it; payments taken while it was queued are not added to its days: refund them in PayPal's dashboard if needed\\.$`));
  });

  it('a queued subscription cancelled at PayPal stays queued with auto-renew off; when the active one ends it resumes with its remaining days, the refused activate is logged, and the checker ends it at its end', async () => {
    const high = await owned(k, { level: 'high' });
    const low = await owned(k);
    const queued = heldOf(low)!;
    expect(queued.location).toBe('paused');
    w.fake.buyerCancel(low);
    await drain();
    const after = heldOf(low)!;
    expect(after).toMatchObject({ location: 'paused', sub: { status: 'paused', autoRenew: false, endDate: queued.sub.endDate, providerMeta: { paypalStatus: 'CANCELLED' } } });
    expect(ms(after.sub.providerMeta.computedEnd)).toBe(ms(queued.sub.endDate));
    const from = Date.now();
    w.fake.expire(high);
    await drain();
    const resumed = heldOf(low)!;
    expect(resumed.location).toBe('active');
    expect(ms(resumed.sub.endDate)).toBeGreaterThanOrEqual(from + after.sub.remainingDaysAtPause * DAY);
    expect(w.logged("[PremiumManager] provider resumeSubscription failed for 'paypal'").length).toBe(1);
    w.later(ms(resumed.sub.endDate) - Date.now() - 3_600_000);
    await w.tick();
    expect(heldOf(low)?.location).toBe('active');
    w.later(2 * 3_600_000);
    await w.tick();
    expect(heldOf(low)).toBeNull();
  });

  it('a first payment that fails installs nothing; a held one left with no payment that fails a payment is ended', async () => {
    const id = await buy(k);
    w.fake.approve(id, { firstSale: 'fail' });
    await drain();
    expect(heldOf(id)).toBeNull();
    await restart({ link: TRIAL_LINK });
    const trial = await owned(k, { plan: EXTRA_PLANS.trial });
    expect(heldOf(trial)?.location).toBe('active');
    w.fake.changePlan(trial, planId(tierOf(k), 'cheap'));
    w.fake.failPayment(trial, { count: 1 });
    await drain();
    expect(heldOf(trial)).toBeNull();
  });

  it('EXPIRED ends it and the queue resumes; PAYMENT.FAILED sends one renewal-failed notice; changePlan to the other plan copies the state, keeps the tier and logs PL3 once', async () => {
    const high = await owned(k, { level: 'high' });
    const low = await owned(k);
    w.fake.expire(high);
    await drain();
    expect([heldOf(high), heldOf(low)?.location]).toEqual([null, 'active']);
    w.fake.failPayment(low, { count: 0 });
    await drain();
    expect(w.notices().filter(n => n.kind === 'paid.sub.renewal-failed')).toHaveLength(1);
    w.fake.changePlan(low, planId(tierOf(k), 'dear'));
    await drain();
    await w.deliver(lastDelivered('BILLING.SUBSCRIPTION.UPDATED', low));
    expect(heldOf(low)!.sub).toMatchObject({ tierId: tierOf(k), status: 'active', providerMeta: { planId: planId(tierOf(k), 'dear') } });
    expect(w.logged(`[PayPalProvider] Subscription ${low} now bills plan ${planId(tierOf(k), 'dear')}, not ${planId(tierOf(k), 'cheap')} that the bot recorded; the bot keeps giving tier '${tierOf(k)}'.`)).toHaveLength(1);
  });
});

describe('P5 claim 7: refunds', () => {
  const k: Kind = 'guild';

  it('the latest sale refunded in full: one cancel, ended with the queue resumed, PL6', async () => {
    const high = await owned(k, { level: 'high' });
    const low = await owned(k);
    const sale = w.fake.latestSale(high)!.id;
    w.fake.refund(sale, undefined, { withAgreement: true });
    const outs = await drain();
    expect(outs.every(o => o.status === 200)).toBe(true);
    expect([cancels(high), heldOf(high), heldOf(low)?.location]).toEqual([1, null, 'active']);
    expect(w.logged(`[PayPalProvider] Sale ${sale} was refunded in full; subscription ${high} (${words(k)}) was cancelled at PayPal, and the event that ends it in the bot was raised.`)).toHaveLength(1);
  });

  it('partial refunds: one is PL5; reaching the whole ends it at the second', async () => {
    const id = await owned(k);
    const sale = w.fake.latestSale(id)!.id;
    w.fake.refund(sale, 200);
    await drain();
    expect(heldOf(id)?.location).toBe('active');
    expect(w.logged(`[PayPalProvider] Sale ${sale} was refunded (PARTIALLY_REFUNDED), and it is not a full refund of the latest payment of subscription ${id}; the subscription stays.`)).toHaveLength(1);
    expect(cancels(id)).toBe(0);
    w.fake.refund(sale);
    await drain();
    expect([heldOf(id), cancels(id)]).toEqual([null, 1]);
  });

  it('a full refund of an older sale while a newer one is paid: PL5', async () => {
    const id = await owned(k);
    const first = w.fake.latestSale(id)!.id;
    w.later(29 * DAY);
    w.fake.renew(id);
    await drain();
    w.fake.refund(first);
    await drain();
    expect([heldOf(id)?.location, cancels(id)]).toEqual(['active', 0]);
    expect(w.logged(`[PayPalProvider] Sale ${first} was refunded (REFUNDED), and it is not a full refund of the latest payment of subscription ${id}; the subscription stays.`)).toHaveLength(1);
  });

  it("an already cancelled subscription: no cancel, ended, PL6's other form", async () => {
    const id = await owned(k);
    w.fake.buyerCancel(id);
    await drain();
    const sale = w.fake.latestSale(id)!.id;
    w.fake.refund(sale);
    await drain();
    expect([heldOf(id), cancels(id)]).toEqual([null, 0]);
    expect(w.logged(`[PayPalProvider] Sale ${sale} was refunded in full; subscription ${id} (${words(k)}) was already cancelled at PayPal, and the event that ends it in the bot was raised.`)).toHaveLength(1);
  });

  it("a queued subscription's latest sale refunded: cancelled at PayPal and gone from the queue, and nothing resumes from it later", async () => {
    const high = await owned(k, { level: 'high' });
    const low = await owned(k);
    expect(heldOf(low)?.location).toBe('paused');
    w.fake.refund(w.fake.latestSale(low)!.id);
    await drain();
    expect([cancels(low), fakeSub(low).status]).toEqual([1, 'CANCELLED']);
    expect(emittedFor(low).filter(e => e.type === 'subscription.expired').map(e => e.state.status)).toEqual(['expired']);
    expect(heldOf(low)).toBeNull();
    w.fake.expire(high);
    await drain();
    expect([heldOf(high), heldOf(low), live(holderOf(k))?.active ?? null]).toEqual([null, null, null]);
  });

  it('a refund event with no billing_agreement_id reads the sale; a sale with none is PL10', async () => {
    const id = await owned(k);
    const sale = w.fake.latestSale(id)!.id;
    w.fake.refund(sale);
    await drain();
    expect(w.fake.callsOf('GET', new RegExp(`^/v1/payments/sale/${sale}$`))).toHaveLength(1);
    expect(heldOf(id)).toBeNull();
    const other = await owned(k);
    const lone = w.fake.latestSale(other)!;
    lone._withAgreement = false;
    w.fake.refund(lone.id);
    const outs = await drain();
    expect(outs.map(o => o.status)).toEqual([200]);
    expect(heldOf(other)?.location).toBe('active');
    expect(w.logged(`[PayPalProvider] A PAYMENT.SALE.REFUNDED event for sale ${lone.id} names no subscription; the bot does not manage it.`)).toHaveLength(1);
  });

  it.each([[404, 200], [410, 200], [503, 400]])('the sale read answering %s: %s', async (status, answer) => {
    const id = await owned(k);
    const sale = w.fake.latestSale(id)!.id;
    w.fake.refund(sale);
    w.fake.fail('GET', /^\/v1\/payments\/sale\//, { status });
    const out = (await w.deliverNext(0))!;
    expect(out.status).toBe(answer);
    if (answer === 200) {
      expect(w.logged(`[PayPalProvider] A PAYMENT.SALE.REFUNDED event was not applied: the bot could not find the subscription of sale ${sale} (PayPal answered ${status}).`)).toHaveLength(1);
    } else {
      expect(errorOf(out)).toMatch(new RegExp(`^PayPal webhook not applied: the bot could not read sale ${sale} at PayPal \\(PayPal answered 503: .+\\); PayPal sends the event again\\.$`));
    }
    expect([heldOf(id)?.location, cancels(id)]).toEqual(['active', 0]);
  });

  it('a sale missing from the transactions: PL11, no cancel', async () => {
    const id = await owned(k);
    const sale = w.fake.latestSale(id)!;
    sale.create_time = '2020-01-01T00:00:00Z';
    w.fake.refund(sale.id);
    await drain();
    expect([heldOf(id)?.location, cancels(id)]).toEqual(['active', 0]);
    expect(w.logged(`[PayPalProvider] Sale ${sale.id} was refunded, and the bot did not find it among the payments PayPal lists for subscription ${id}; nothing was ended. Use "Cancel & remove now" on its subscription page if the refund should end it.`)).toHaveLength(1);
  });

  it('the cancel with no answer after PayPal acted: 400 PW5, then the retry ends it with one cancel in all', async () => {
    const id = await owned(k);
    w.fake.refund(w.fake.latestSale(id)!.id);
    const event = w.fake.dequeue(0)!;
    w.fake.fail('POST', /\/cancel$/, { drop: 'after' });
    const first = await w.deliver(event);
    expect(first.status).toBe(400);
    expect(errorOf(first)).toBe(`PayPal webhook not applied: can't confirm whether PayPal cancelled subscription ${id} after its refund (PayPal did not answer: fetch failed); PayPal sends the event again.`);
    expect(heldOf(id)?.location).toBe('active');
    const again = await w.deliver(event);
    expect([again.status, heldOf(id), cancels(id)]).toEqual([200, null, 1]);
  });

  it('the cancel answering 503: 400 PW5, and the retry cancels and ends it', async () => {
    const id = await owned(k);
    w.fake.refund(w.fake.latestSale(id)!.id);
    const event = w.fake.dequeue(0)!;
    w.fake.fail('POST', /\/cancel$/, { status: 503 });
    const first = await w.deliver(event);
    expect(first.status).toBe(400);
    expect(errorOf(first)).toMatch(/^PayPal webhook not applied: can't confirm whether PayPal cancelled subscription \S+ after its refund \(PayPal answered 503: .+\); PayPal sends the event again\.$/);
    expect(fakeSub(id).status).toBe('ACTIVE');
    const again = await w.deliver(event);
    expect([again.status, heldOf(id), fakeSub(id).status]).toEqual([200, null, 'CANCELLED']);
  });

  it('the cancel answering 422 with the subscription still active: 400 PW4; with it cancelled meanwhile: ended', async () => {
    const id = await owned(k);
    w.fake.refund(w.fake.latestSale(id)!.id);
    const event = w.fake.dequeue(0)!;
    w.fake.fail('POST', /\/cancel$/, { status: 422, message: 'Invalid subscription status for cancel action.' });
    const first = await w.deliver(event);
    expect([first.status, errorOf(first)]).toEqual([400, `PayPal webhook not applied: PayPal refused to cancel subscription ${id} after its refund (Invalid subscription status for cancel action) and its status there is ACTIVE; PayPal sends the event again.`]);
    expect(heldOf(id)?.location).toBe('active');
    w.fake.fail('POST', /\/cancel$/, { status: 422 });
    const held = w.fake.hold('POST', /\/cancel$/);
    const second = w.deliver(event);
    await held.reached;
    w.fake.buyerCancel(id);
    held.release();
    expect([(await second).status, heldOf(id)]).toEqual([200, null]);
  });
});

describe('P5 claim 7: the cancel after a refund, refused with the subscription suspended', () => {
  const k: Kind = 'guild';

  it('the cancel answering 422 with the subscription SUSPENDED at PayPal: 400 PW4 naming SUSPENDED', async () => {
    const id = await owned(k);
    w.fake.suspendNoFailure(id);
    await drain();
    w.fake.refund(w.fake.latestSale(id)!.id);
    const event = w.fake.dequeue(0)!;
    expect(event.event_type).toBe('PAYMENT.SALE.REFUNDED');
    w.fake.fail('POST', /\/cancel$/, { status: 422, message: 'Invalid subscription status for cancel action.' });
    const out = await w.deliver(event);
    expect([out.status, errorOf(out)]).toEqual([400, `PayPal webhook not applied: PayPal refused to cancel subscription ${id} after its refund (Invalid subscription status for cancel action) and its status there is SUSPENDED; PayPal sends the event again.`]);
    expect(heldOf(id)?.location).toBe('active');
  });
});

describe('P5 claim 8: repeats and order', () => {
  const k: Kind = 'guild';

  it('each type delivered twice: premium equal apart from updatedAt, one install line, and the refund\'s second delivery sends no cancel', async () => {
    const id = await buy(k);
    w.fake.approve(id);
    const steps: Array<() => void> = [
      () => undefined,
      () => w.fake.renew(id),
      () => w.fake.failPayment(id, { count: 0 }),
      () => w.fake.retrySucceeds(id),
      () => w.fake.changePlan(id, planId('gold', 'dear')),
      () => w.fake.suspendNoFailure(id),
      () => w.fake.reactivate(id),
      () => {
        w.useClock(Date.parse(w.fake.latestSale(id)!.create_time) + DAY);
        w.fake.refund(w.fake.latestSale(id)!.id);
      },
    ];
    const differing: string[] = [];
    for (const step of steps) {
      step();
      while (w.fake.queue.length > 0) {
        const out = (await w.deliverNext(0))!;
        await w.settle();
        const once = plain();
        const cancelled = cancels(id);
        const again = await w.deliver(out.event);
        await w.settle();
        if (again.status !== 200 || JSON.stringify(plain()) !== JSON.stringify(once) || cancels(id) !== cancelled) differing.push(out.event!.event_type);
      }
    }
    expect(differing).toEqual([]);
    expect(installLines()).toHaveLength(1);
    expect(cancels(id)).toBe(1);
  });

  it("a failing subscription's PAYMENT.FAILED delivered five times: the end after the last equals the end after the first", async () => {
    const id = await owned(k);
    w.fake.failPayment(id, { count: 0 });
    const event = take('BILLING.SUBSCRIPTION.PAYMENT.FAILED', id);
    await w.deliver(event);
    const end = heldOf(id)!.sub.endDate;
    for (let i = 0; i < 4; i++) await w.deliver(event);
    expect(heldOf(id)!.sub.endDate).toBe(end);
  });

  it('ACTIVATED delivered after a later buyerCancel: premium holds the cancelled state', async () => {
    const id = await owned(k);
    w.fake.buyerCancel(id);
    await drain();
    await w.deliver(lastDelivered('BILLING.SUBSCRIPTION.ACTIVATED', id));
    expect(heldOf(id)!.sub).toMatchObject({ status: 'active', autoRenew: false, providerMeta: { paypalStatus: 'CANCELLED' } });
  });

  it('"Cancel & remove now", then the CANCELLED delivery its cancel caused: nothing held and no refund line', async () => {
    const id = await owned(k);
    expect((await w.op('cancelPaidSubscriptionImmediately', holderOf(k))).ok).toBe(true);
    expect(heldOf(id)).toBeNull();
    const outs = await drain();
    expect(outs.map(o => [o.event?.event_type, o.status])).toEqual([['BILLING.SUBSCRIPTION.CANCELLED', 200]]);
    expect([heldOf(id), w.logged('PayPal took a payment for subscription')]).toEqual([null, []]);
  });

  it('a full refund, then the CANCELLED delivery its cancel caused: nothing held and no refund line', async () => {
    const id = await owned(k);
    w.fake.refund(w.fake.latestSale(id)!.id);
    const outs = await drain();
    expect(outs.map(o => o.status).every(s => s === 200)).toBe(true);
    expect(outs.map(o => o.event?.event_type)).toContain('BILLING.SUBSCRIPTION.CANCELLED');
    expect([heldOf(id), cancels(id), w.logged('PayPal took a payment for subscription')]).toEqual([null, 1, []]);
  });

  it('a paid subscription cancelled before any delivery, then refunded in full: the refund line before the refund, none at the CANCELLED delivered after it', async () => {
    const id = await buy(k);
    w.fake.approve(id);
    w.fake.buyerCancel(id);
    const outs = await drain();
    const lines = () => w.logged(`PayPal took a payment for subscription ${id}`).length;
    expect([heldOf(id), lines()]).toEqual([null, outs.length]);
    const before = lines();
    w.fake.refund(w.fake.latestSale(id)!.id);
    const refunded = await drain();
    expect(refunded.map(o => [o.event?.event_type, o.status])).toEqual([['PAYMENT.SALE.REFUNDED', 200]]);
    await w.deliver(lastDelivered('BILLING.SUBSCRIPTION.CANCELLED', id));
    expect([heldOf(id), cancels(id), lines()]).toEqual([null, 0, before]);
  });

  it('"Cancel & remove now" answered 422 while PayPal already holds it CANCELLED, then the CANCELLED delivery: nothing held and no refund line', async () => {
    const id = await owned(k);
    w.fake.buyerCancel(id);
    w.fake.fail('POST', /\/cancel$/, { status: 422, message: 'Invalid subscription status for cancel action.' });
    expect((await w.op('cancelPaidSubscriptionImmediately', holderOf(k))).ok).toBe(true);
    expect(heldOf(id)).toBeNull();
    const outs = await drain();
    expect(outs.map(o => [o.event?.event_type, o.status])).toEqual([['BILLING.SUBSCRIPTION.CANCELLED', 200]]);
    expect([heldOf(id), w.logged('PayPal took a payment for subscription')]).toEqual([null, []]);
  });

  it('a delivery replayed after "Cancel & remove now" installs nothing', async () => {
    const id = await owned(k);
    const reply = await w.op('cancelPaidSubscriptionImmediately', holderOf(k));
    expect(reply.ok).toBe(true);
    expect(heldOf(id)).toBeNull();
    await w.deliver(lastDelivered('BILLING.SUBSCRIPTION.ACTIVATED', id));
    await w.deliver(lastDelivered('PAYMENT.SALE.COMPLETED', id));
    await drain();
    expect(heldOf(id)).toBeNull();
  });

  it("two deliveries for one subscription at once, the first's read held while the buyer cancels: premium ends with the newer state", async () => {
    const id = await owned(k);
    w.fake.renew(id);
    const renewal = take('PAYMENT.SALE.COMPLETED', id);
    const read = w.fake.hold('GET', SUB_READ);
    const first = w.deliver(renewal);
    await read.reached;
    w.fake.buyerCancel(id);
    const second = w.deliver(take('BILLING.SUBSCRIPTION.CANCELLED', id));
    read.release();
    expect([(await first).status, (await second).status]).toEqual([200, 200]);
    expect(heldOf(id)!.sub).toMatchObject({ autoRenew: false, providerMeta: { paypalStatus: 'CANCELLED' } });
  });
});

describe('P5 claim 14: chains', () => {
  const k: Kind = 'guild';

  it('a handling\'s read held while "Cancel & remove now" is pressed, and the reverse: not held after both, one cancel', async () => {
    const id = await owned(k);
    const read = w.fake.hold('GET', SUB_READ);
    const delivery = w.deliver(lastDelivered('PAYMENT.SALE.COMPLETED', id));
    await read.reached;
    const removal = w.op('cancelPaidSubscriptionImmediately', holderOf(k));
    read.release();
    expect([(await delivery).status, (await removal).ok]).toEqual([200, true]);
    await drain();
    expect([heldOf(id), cancels(id)]).toEqual([null, 1]);

    const other = await owned(k);
    const cancel = w.fake.hold('POST', /\/cancel$/);
    const removal2 = w.op('cancelPaidSubscriptionImmediately', holderOf(k));
    await cancel.reached;
    const delivery2 = w.deliver(lastDelivered('PAYMENT.SALE.COMPLETED', other));
    cancel.release();
    expect([(await removal2).ok, (await delivery2).status]).toEqual([true, 200]);
    await drain();
    expect([heldOf(other), cancels(other)]).toEqual([null, 1]);
  });

  it('after a refund ended one through the webhook, "Cancel & remove now" on another and a cancel of the refunded id complete, and a later event for it is handled', async () => {
    const id = await owned(k);
    const otherHolder = `guild:${IDS[1]}`;
    const reply = await w.buyMember(otherHolder, IDS[1]);
    w.fake.approve(reply.subscriptionId!);
    await drain();
    w.fake.refund(w.fake.latestSale(id)!.id);
    await drain();
    expect(heldOf(id)).toBeNull();
    const timeout = <T>(p: Promise<T>): Promise<T | 'timed out'> => Promise.race([p, new Promise<'timed out'>(resolve => setTimeout(() => resolve('timed out'), 5000))]);
    expect((await timeout(w.op('cancelPaidSubscriptionImmediately', otherHolder)) as any)?.ok).toBe(true);
    expect(await timeout(getPaymentRegistry().get('paypal')!.cancelSubscription!(id).then(() => 'done', (e: Error) => e.message))).toBe('done');
    const later = await timeout(w.deliver(lastDelivered('BILLING.SUBSCRIPTION.CANCELLED', id)));
    expect((later as Delivered).status).toBe(200);
  });

  it("premium's view is read late: a queued entry's delivery whose plan read is held while premium resumes it leaves it active in the slot", async () => {
    const high = await owned(k, { level: 'high' });
    const low = await owned(k);
    expect(heldOf(low)?.location).toBe('paused');
    const plan = w.fake.hold('GET', PLAN_READ);
    const delivery = w.deliver(lastDelivered('BILLING.SUBSCRIPTION.SUSPENDED', low));
    await plan.reached;
    w.fake.expire(high);
    const ending = w.deliver(take('BILLING.SUBSCRIPTION.EXPIRED', high));
    await until(() => live(holderOf(k))?.active?.providerSubId === low, 'the resume');
    plan.release();
    expect([(await delivery).status, (await ending).status]).toEqual([200, 200]);
    await drain();
    expect(heldOf(low)).toMatchObject({ location: 'active', sub: { status: 'active' } });
    expect(tierNow(k)).toBe(tierOf(k));
  });

  it("premium's queueing racing a handling: the handling's suspend lands, premium's pause reads SUSPENDED and resolves with no warning, PL14 says reported active", async () => {
    const low = await owned(k);
    const plan = w.fake.hold('GET', PLAN_READ);
    const delivery = w.deliver(lastDelivered('PAYMENT.SALE.COMPLETED', low));
    await plan.reached;
    const high = await buy(k, { level: 'high' });
    w.fake.approve(high);
    take('BILLING.SUBSCRIPTION.CREATED', high);
    const install = w.deliver(take('BILLING.SUBSCRIPTION.ACTIVATED', high));
    await until(() => live(holderOf(k))?.paused?.some((p: any) => p.providerSubId === low) === true, 'the queueing');
    plan.release();
    expect([(await delivery).status, (await install).status]).toEqual([200, 200]);
    await w.settle();
    expect(w.logged('[PremiumManager] provider pauseSubscription failed')).toEqual([]);
    expect(w.logged(`[PayPalProvider] PayPal reported queued subscription ${low} (${words(k)}) active; the bot suspended it again;`)).toHaveLength(1);
    expect(suspends(low)).toBe(2);
    expect(w.fake.queue.filter(e => e.event_type === 'BILLING.SUBSCRIPTION.SUSPENDED' && e.resource.id === low)).toHaveLength(1);
    expect(fakeSub(low).status).toBe('SUSPENDED');
  });
});

// Sheet P5P, Y2 and Y7 (Q3, Q6, Q8 to Q12): a pay-once subscription's tier follows its payment record, never PayPal's
// status; once the payment is proven the bot cancels it at PayPal; it sells one period from its earliest kept payment.
// Ends come from helpers/p5Model.ts's onceEnd and onceProof over what the fake answers.

const o = onceKit(w);
const fakeStatus = (id: string): string => w.fake.subscriptions.get(id)!.status;
/** The subscription's only queued event of `type` delivered after every other queued event is dropped. */
async function only(type: string, id: string): Promise<Delivered> {
  const event = o.take(type, id);
  w.fake.queue.length = 0;
  return w.deliver(event);
}
/** Bought with the opt-out, its first delivery's cancel answered 503, so premium holds it while PayPal keeps it ACTIVE. */
async function heldActive(k: Kind, settings: FakeSettings = {}): Promise<string> {
  const id = await o.buy(k);
  w.fake.configure(id, { finalCycle: 'stays-active', ...settings });
  w.fake.approve(id);
  w.fake.fail('POST', new RegExp(`^/v1/billing/subscriptions/${id}/cancel$`), { status: 503 });
  const first = await w.deliver(o.take('BILLING.SUBSCRIPTION.CREATED', id));
  expect(first.status).toBe(400);
  w.fake.queue.length = 0;
  expect(o.heldOf(id)?.location).toBe('active');
  expect(fakeStatus(id)).toBe('ACTIVE');
  return id;
}
/** A delivery that only makes the bot read the subscription again. */
function createdOf(id: string): PayPalEvent {
  return { id: `WH-P5P-READ-${id}-${w.delivered.length}`, event_version: '1.0', create_time: isoOf(Date.now()), resource_type: 'subscription', resource_version: '2.0', event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', summary: 'read', resource: { id }, links: [] };
}
/** The clock moved to the subscription's next due date at PayPal. */
function toDue(id: string): void {
  const due = Date.parse(w.fake.subscriptions.get(id)!.billing_info.next_billing_time);
  w.later(due - Date.now() + 60_000);
}

describe.each(KINDS)('P5P Q3: expiry timing [R1], for %s', (_name, k) => {
  it.each(FINAL_CYCLES)('under %s: installed once, active, auto-renew off, the end onceEnd(T), meta payOnce; one cancel only when a read shows ACTIVE', async final => {
    const id = await o.owned(k, { settings: { finalCycle: final } });
    const held = o.heldOf(id)!;
    expect(held).toMatchObject({ location: 'active', sub: { status: 'active', autoRenew: false, providerMeta: { payOnce: true } } });
    expect(o.endOf(id)).toBe(onceEnd(w.fake, id));
    expect(o.installLines(id)).toHaveLength(1);
    const cancelled = final === 'expire-at-payment' ? 0 : 1;
    expect([o.cancels(id), w.logged(PL16(id, k)).length]).toEqual([cancelled, cancelled]);
    expect(fakeStatus(id)).toBe(final === 'expire-at-payment' ? 'EXPIRED' : 'CANCELLED');
  });

  it.each([['cancelled', 'buyerCancel'], ['expired', 'expire']] as const)('the subscription %s at PayPal between the read and the cancel: 422, the read shows it, PL16 second form only', async (word, how) => {
    const id = await o.buy(k);
    w.fake.configure(id, { finalCycle: 'stays-active' });
    w.fake.approve(id);
    const hold = w.fake.hold('POST', new RegExp(`^/v1/billing/subscriptions/${id}/cancel$`));
    const first = w.deliverNext(0);
    await hold.reached;
    if (how === 'buyerCancel') w.fake.buyerCancel(id);
    else w.fake.expire(id);
    hold.release();
    expect((await first)?.status).toBe(200);
    await o.drain();
    expect([w.logged(PL16_ALREADY(id, k, word)).length, w.logged(PL16(id, k)).length, o.cancels(id)]).toEqual([1, 0, 1]);
    expect(o.heldOf(id)?.location).toBe('active');
    expect(o.endOf(id)).toBe(onceEnd(w.fake, id));
  });

  it.each([['in order', 'order'], ['in reverse order', 'reverse'], ['with only the last one', 'last']] as const)('the events delivered %s: the same single install and end', async (_label, how) => {
    const id = await o.buy(k);
    w.fake.configure(id, { finalCycle: 'active-to-period-end' });
    w.fake.approve(id);
    if (how === 'reverse') await w.drain(length => length - 1);
    if (how === 'last') {
      const last = w.fake.queue[w.fake.queue.length - 1];
      w.fake.queue.length = 0;
      await w.deliver(last);
    }
    await o.drain();
    expect(o.installLines(id)).toHaveLength(1);
    expect(o.endOf(id)).toBe(onceEnd(w.fake, id));
    expect(o.cancels(id)).toBe(1);
  });

  it.each([['expire-at-payment', 'BILLING.SUBSCRIPTION.EXPIRED'], ['active-to-period-end', 'BILLING.SUBSCRIPTION.CANCELLED']] as const)('under %s, %s delivered again for the held one: the same state, no notice', async (final, type) => {
    const id = await o.owned(k, { settings: { finalCycle: final } });
    const before = o.plain();
    const notices = w.notices().length;
    const out = await w.deliver(o.lastDelivered(type, id));
    expect(out.status).toBe(200);
    expect([o.plain(), w.notices().length]).toEqual([before, notices]);
  });

  it('each event delivered twice: premium unchanged after the first apart from updatedAt, no second cancel', async () => {
    const id = await o.owned(k, { settings: { finalCycle: 'stays-active' } });
    const before = o.plain();
    for (const done of [...w.delivered]) if (done.event) await w.deliver(done.event);
    await o.drain();
    expect(o.plain()).toEqual(before);
    expect(o.cancels(id)).toBe(1);
  });
});

describe.each(KINDS)('P5P Q6: the override and later charges [R2, R3], for %s', (_name, k) => {
  const SHOWN: Array<[string, FakeSettings]> = [
    ['flag', { showOverrideBy: 'flag' }], ['cycles', { showOverrideBy: 'cycles' }], ['both', { showOverrideBy: 'both' }], ['none', { showOverrideBy: 'none' }],
    ['ignoreOverride', { ignoreOverride: true }], ['billsDespiteOverride', { billsDespiteOverride: true }],
  ];
  it.each(SHOWN)('under %s: one cancel at the first read that proves the payment and shows ACTIVE, PL16; CANCELLED keeps the end; the next renew is refused', async (_label, settings) => {
    const id = await o.owned(k, { settings: { finalCycle: 'active-to-period-end', ...settings } });
    expect([o.cancels(id), w.logged(PL16(id, k)).length, fakeStatus(id)]).toEqual([1, 1, 'CANCELLED']);
    expect(o.heldOf(id)?.sub).toMatchObject({ status: 'active', autoRenew: false });
    expect(o.endOf(id)).toBe(onceEnd(w.fake, id));
    toDue(id);
    expect(() => w.fake.renew(id)).toThrow(FakeRefusal);
    expect(w.fake.salesOf(id)).toHaveLength(1);
  });

  const BILLED: Array<[string, FakeSettings]> = [['ignoreOverride', { ignoreOverride: true }], ['billsDespiteOverride', { billsDespiteOverride: true }]];

  it.each(BILLED)('under %s, a second sale while held: the end stays the first payment\'s, PL17 once naming it, then one cancel', async (_label, settings) => {
    const id = await heldActive(k, settings);
    const first = o.endOf(id);
    toDue(id);
    w.fake.renew(id);
    const [, second] = o.sales(id);
    await o.drain();
    expect(o.endOf(id)).toBe(first);
    expect(o.endOf(id)).toBe(onceEnd(w.fake, id));
    expect(w.logged(PL17(second, o.saleTime(second), id, k))).toHaveLength(1);
    expect(w.logged(PL17_ANY(id)).filter(l => l.includes('PayPal took another payment'))).toHaveLength(1);
    expect([fakeStatus(id), w.logged(PL16(id, k)).length]).toEqual(['CANCELLED', 1]);
  });

  it.each(BILLED)('under %s, a second sale before any delivery: installed from the first payment, PL17 once, one cancel', async (_label, settings) => {
    const id = await o.buy(k);
    w.fake.configure(id, settings);
    w.fake.approve(id);
    toDue(id);
    w.fake.renew(id);
    const [firstSale, second] = o.sales(id);
    await o.drain();
    expect(o.installLines(id)).toHaveLength(1);
    expect(o.endOf(id)).toBe(onceEnd(w.fake, id));
    expect(o.endOf(id)).toBeLessThan(o.saleTime(second) + 31 * DAY);
    expect(o.saleTime(firstSale)).toBeLessThan(o.saleTime(second));
    expect(w.logged(PL17(second, o.saleTime(second), id, k))).toHaveLength(1);
    expect([o.cancels(id), fakeStatus(id)]).toEqual([1, 'CANCELLED']);
  });

  describe.each([['delivered', true], ['not delivered (the next read)', false]] as const)('the refund event %s', (_label, delivered) => {
    async function twoSales(): Promise<[string, string, string]> {
      const id = await o.buy(k);
      w.fake.configure(id, { ignoreOverride: true });
      w.fake.approve(id);
      toDue(id);
      w.fake.renew(id);
      await o.drain();
      const [a, b] = o.sales(id);
      return [id, a, b];
    }
    async function refundThenRead(id: string, sale: string): Promise<Delivered | null> {
      w.fake.refund(sale);
      if (delivered) return w.deliverNext(w.fake.queue.findIndex(e => e.event_type === 'PAYMENT.SALE.REFUNDED'));
      o.take('PAYMENT.SALE.REFUNDED', id);
      return w.deliver(o.lastDelivered('BILLING.SUBSCRIPTION.CANCELLED', id));
    }

    it('a full refund of the second sale: nothing changes, PL18 when delivered, no second PL17', async () => {
      const [id, a, b] = await twoSales();
      const end = o.endOf(id);
      const out = await refundThenRead(id, b);
      expect(out?.status).toBe(200);
      expect(o.endOf(id)).toBe(end);
      expect(w.logged(PL18(b, id, k, o.saleTime(a), end))).toHaveLength(delivered ? 1 : 0);
      expect(w.logged('PayPal took another payment')).toHaveLength(1);
    });

    it("a full refund of the first sale (T's own): T moves to the second sale and the end is its onceEnd", async () => {
      const [id, a, b] = await twoSales();
      const out = await refundThenRead(id, a);
      expect(out?.status).toBe(200);
      expect(o.endOf(id)).toBe(onceEnd(w.fake, id));
      expect(onceProof(w.fake, id, 'BILLING.SUBSCRIPTION.UPDATED').T).toBe(o.saleTime(b));
      expect(w.logged(PL18(a, id, k, o.saleTime(b), o.endOf(id)))).toHaveLength(delivered ? 1 : 0);
    });

    it('a full refund of both: ended at once', async () => {
      const [id, a, b] = await twoSales();
      await refundThenRead(id, a);
      const out = await refundThenRead(id, b);
      expect(out?.status).toBe(200);
      expect(o.heldOf(id)).toBeNull();
    });
  });

  it('a read taking last_payment (the second sale) while the list hides both, then the list released: the end moves back to the first sale\'s onceEnd', async () => {
    const id = await o.buy(k);
    w.fake.configure(id, { ignoreOverride: true, listLag: true });
    w.fake.approve(id);
    toDue(id);
    w.fake.renew(id);
    const [a, b] = o.sales(id);
    w.fake.queue.length = 0;
    const out = await w.deliver(createdOf(id));
    expect(out.status).toBe(200);
    expect(o.endOf(id)).toBe(onceEnd(w.fake, id));
    expect(onceProof(w.fake, id, 'BILLING.SUBSCRIPTION.UPDATED').T).toBe(o.saleTime(b));
    w.fake.release(id, 'listLag');
    await w.deliver(createdOf(id));
    expect(onceProof(w.fake, id, 'BILLING.SUBSCRIPTION.UPDATED').T).toBe(o.saleTime(a));
    expect(o.endOf(id)).toBe(onceEnd(w.fake, id));
    expect(w.logged(PL17(b, o.saleTime(b), id, k))).toHaveLength(1);
  });

  it('a renewing subscription: no cancel call', async () => {
    const id = await o.owned(k, { renewing: true });
    expect(o.heldOf(id)?.sub).toMatchObject({ autoRenew: true });
    expect(o.cancels(id)).toBe(0);
  });
});

describe.each(KINDS)('P5P Q8: next billing time [R4], for %s', (_name, k) => {
  it.each([['removed', false], ['kept at the payment time', true]] as const)('next_billing_time %s after the last cycle: the end is onceEnd(T)', async (_label, keep) => {
    const id = await o.owned(k, { settings: { finalCycle: 'active-to-period-end', keepNextAfterFinal: keep } });
    const T = o.saleTime(o.sales(id)[0]);
    expect(o.endOf(id)).toBe(onceEnd(w.fake, id));
    expect(o.endOf(id)).not.toBe(T + DAY);
  });
});

describe.each(KINDS)('P5P Q9: the payment proof [R5, R6, R7, R10, R11, R12], for %s', (_name, k) => {
  /** Bought, the settings set, approved; only one event delivered (ACTIVATED under 'stays-active', or EXPIRED). */
  async function single(settings: FakeSettings, type = 'BILLING.SUBSCRIPTION.ACTIVATED'): Promise<[string, Delivered]> {
    const id = await o.buy(k);
    w.fake.configure(id, { finalCycle: type === 'BILLING.SUBSCRIPTION.EXPIRED' ? 'expire-at-payment' : 'stays-active', ...settings });
    w.fake.approve(id);
    return [id, await only(type, id)];
  }

  it.each(['BILLING.SUBSCRIPTION.ACTIVATED', 'BILLING.SUBSCRIPTION.EXPIRED'])('omitLastPayment alone with the sale listed, only %s: installed at once from the listed sale, one cancel when ACTIVE', async type => {
    const [id, out] = await single({ omitLastPayment: true }, type);
    expect(out.status).toBe(200);
    expect(o.endOf(id)).toBe(onceEnd(w.fake, id));
    expect(o.cancels(id)).toBe(type.endsWith('ACTIVATED') ? 1 : 0);
  });

  it('listLag alone: installed at once from last_payment', async () => {
    const [id, out] = await single({ listLag: true });
    expect(out.status).toBe(200);
    expect(o.endOf(id)).toBe(onceEnd(w.fake, id));
    expect(o.cancels(id)).toBe(1);
  });

  it.each([
    ['omitLastPayment with listLag', { omitLastPayment: true, listLag: true }, PW7_NONE],
    ['pendingSale with omitLastPayment', { omitLastPayment: true, pendingSale: true }, 'its latest transaction is PENDING'],
    ['omitCycleExecutions with omitLastPayment and listLag', { omitCycleExecutions: true, omitLastPayment: true, listLag: true }, PW7_NONE],
  ] as Array<[string, FakeSettings, string]>)('%s: 400 PW7, nothing installed, no cancel; after the release the next delivery installs it once and cancels it', async (_label, settings, why) => {
    const [id, out] = await single(settings);
    expect([out.status, o.errorOf(out)]).toEqual([400, PW7(id, why)]);
    expect([o.heldOf(id), o.cancels(id)]).toEqual([null, 0]);
    w.fake.release(id, ...(Object.keys(settings) as Array<keyof FakeSettings>));
    const again = await w.deliver(out.event);
    expect(again.status).toBe(200);
    await o.drain();
    expect([o.installLines(id).length, o.cancels(id)]).toEqual([1, 1]);
    expect(o.endOf(id)).toBe(onceEnd(w.fake, id));
  });

  it('pendingSale with lpWhilePending [R11]: installed at once from last_payment and cancelled', async () => {
    const [id, out] = await single({ pendingSale: true, lpWhilePending: true });
    expect(out.status).toBe(200);
    expect([o.heldOf(id)?.location, o.cancels(id)]).toEqual(['active', 1]);
  });

  it('omitCycleExecutions alone: installed', async () => {
    const [id, out] = await single({ omitCycleExecutions: true });
    expect([out.status, o.heldOf(id)?.location]).toEqual([200, 'active']);
  });

  it('only PAYMENT.SALE.COMPLETED with omitLastPayment, listLag and staleCycles: 400 PW7, not none; staleCycles released first: still PW7; all released: installed once and cancelled', async () => {
    const [id, out] = await single({ omitLastPayment: true, listLag: true, staleCycles: true }, 'PAYMENT.SALE.COMPLETED');
    expect([out.status, o.errorOf(out)]).toEqual([400, PW7(id, PW7_NONE)]);
    w.fake.release(id, 'staleCycles');
    const still = await w.deliver(out.event);
    expect([still.status, o.heldOf(id)]).toEqual([400, null]);
    w.fake.release(id, 'omitLastPayment', 'listLag');
    const last = await w.deliver(out.event);
    expect(last.status).toBe(200);
    expect([o.installLines(id).length, o.cancels(id)]).toEqual([1, 1]);
  });

  describe.each([[0], [1], [3540], [-1], [-3540]])('lpSkew %i seconds [R10]', skew => {
    it('a full refund of the one payment, the refund event not delivered: not held, refunded (nothing installed, cancelled); held, ended at once and cancelled', async () => {
      const other = await o.buy(k, { level: 'high' });
      w.fake.configure(other, { finalCycle: 'stays-active', lpSkew: skew });
      w.fake.approve(other);
      w.fake.refund(o.sales(other)[0]);
      const out = await only('BILLING.SUBSCRIPTION.ACTIVATED', other);
      expect([out.status, o.heldOf(other), o.cancels(other)]).toEqual([200, null, 1]);
      const held = await heldActive(k === 'guild' ? 'user' : 'guild', { lpSkew: skew });
      w.fake.refund(o.sales(held)[0]);
      w.fake.queue.length = 0;
      const read = await w.deliver(o.lastDelivered('BILLING.SUBSCRIPTION.CREATED', held));
      expect([read.status, o.heldOf(held), o.cancels(held), fakeStatus(held)]).toEqual([200, null, 2, 'CANCELLED']);
    });
  });

  it.each([[7200], [-7200]])('lpSkew %i seconds: paid from last_payment, kept after a full refund (accepted limit Y8.7)', async skew => {
    const id = await heldActive(k, { lpSkew: skew });
    w.fake.refund(o.sales(id)[0]);
    w.fake.queue.length = 0;
    const read = await w.deliver(o.lastDelivered('BILLING.SUBSCRIPTION.CREATED', id));
    expect(read.status).toBe(200);
    expect(o.heldOf(id)?.location).toBe('active');
  });

  it('emptyListIs404 [R12] with last_payment: installed from it and cancelled; with no last_payment: 400 PW7', async () => {
    const [id, out] = await single({ emptyListIs404: true, listLag: true });
    expect([out.status, o.heldOf(id)?.location, o.cancels(id)]).toEqual([200, 'active', 1]);
    expect(o.endOf(id)).toBe(onceEnd(w.fake, id));
    const other = await o.buy(k, { level: 'high' });
    w.fake.configure(other, { finalCycle: 'stays-active', emptyListIs404: true, listLag: true, omitLastPayment: true });
    w.fake.approve(other);
    const none = await only('BILLING.SUBSCRIPTION.ACTIVATED', other);
    expect([none.status, o.errorOf(none), o.heldOf(other)]).toEqual([400, PW7(other, PW7_NONE), null]);
  });

  it('a refund event under emptyListIs404 with its sale not in the list: 400 PW8', async () => {
    const [id] = await single({ emptyListIs404: true, listLag: true });
    const sale = o.sales(id)[0];
    w.fake.refund(sale);
    const out = await only('PAYMENT.SALE.REFUNDED', id);
    expect([out.status, o.errorOf(out)]).toEqual([400, PW8(sale, id)]);
    expect(o.heldOf(id)?.location).toBe('active');
  });

  /** Refunded in full, the list frozen, then a second sale PayPal takes while the cancel fails. */
  async function refundedThenLater(settings: FakeSettings, held: boolean): Promise<string> {
    const id = held ? await heldActive(k, { ignoreOverride: true }) : await o.buy(k, { level: 'high' });
    if (!held) {
      w.fake.configure(id, { finalCycle: 'stays-active', ignoreOverride: true });
      w.fake.approve(id);
    }
    w.fake.refund(o.sales(id)[0]);
    w.fake.configure(id, { listLag: true });
    toDue(id);
    w.fake.renew(id);
    w.fake.configure(id, settings);
    w.fake.queue.length = 0;
    return id;
  }

  it('refunded payments only, omitLastPayment, a second sale hidden, cycles_completed 2 (A5): unknown; held unchanged and cancelled, not held 400 PW7', async () => {
    const held = await refundedThenLater({ omitLastPayment: true }, true);
    const before = o.plain();
    const read = await w.deliver(createdOf(held));
    expect([read.status, o.plain(), fakeStatus(held)]).toEqual([200, before, 'CANCELLED']);
    const free = await refundedThenLater({ omitLastPayment: true }, false);
    const out = await w.deliver(createdOf(free));
    expect([out.status, o.errorOf(out), o.heldOf(free), o.cancels(free)]).toEqual([400, PW7(free, 'its latest transaction is REFUNDED'), null, 0]);
  });

  it('the same with cycles_completed 1: refunded', async () => {
    const id = await refundedThenLater({ omitLastPayment: true, staleCycles: 1 }, true);
    const read = await w.deliver(createdOf(id));
    expect([read.status, o.heldOf(id)]).toEqual([200, null]);
  });

  it('last_payment matched to the refunded sale and cycles_completed 1: refunded', async () => {
    const id = await heldActive(k);
    w.fake.refund(o.sales(id)[0]);
    w.fake.queue.length = 0;
    const read = await w.deliver(createdOf(id));
    expect([read.status, o.heldOf(id)]).toEqual([200, null]);
  });

  it('a stale last_payment matched to the refunded sale with cycles_completed 2 and one payment listed (B3): unknown', async () => {
    const id = await refundedThenLater({ pendingSale: true }, true);
    const before = o.plain();
    const read = await w.deliver(createdOf(id));
    expect([read.status, o.plain()]).toEqual([200, before]);
    expect(o.heldOf(id)?.location).toBe('active');
  });

  it('omitCycleExecutions and no last_payment, the only payment refunded: unknown, held unchanged', async () => {
    const id = await heldActive(k, { omitCycleExecutions: true });
    w.fake.refund(o.sales(id)[0]);
    w.fake.configure(id, { omitLastPayment: true });
    w.fake.queue.length = 0;
    const before = o.plain();
    const read = await w.deliver(createdOf(id));
    expect([read.status, o.plain(), fakeStatus(id)]).toEqual([200, before, 'CANCELLED']);
  });

  it('held active under an unknown read (pendingSale with omitLastPayment): premium unchanged, the cancel tried again and landed', async () => {
    const id = await heldActive(k);
    w.fake.configure(id, { pendingSale: true, omitLastPayment: true });
    const before = o.plain();
    const read = await w.deliver(createdOf(id));
    expect([read.status, o.plain(), fakeStatus(id), o.cancels(id)]).toEqual([200, before, 'CANCELLED', 2]);
  });

  it('an older sale refunded and the latest sale lagging (W5): paid from last_payment, kept', async () => {
    const id = await refundedThenLater({}, true);
    const read = await w.deliver(createdOf(id));
    expect(read.status).toBe(200);
    expect(o.heldOf(id)?.location).toBe('active');
    expect(o.endOf(id)).toBe(onceEnd(w.fake, id));
  });

  it.each([['500', { status: 500 }], ['no answer', { drop: 'before' as const }]])('a transactions read answering %s: 400 PW3, premium unchanged, the next delivery applies it', async (_label, fault) => {
    const id = await o.buy(k);
    w.fake.configure(id, { finalCycle: 'stays-active' });
    w.fake.approve(id);
    const event = o.take('BILLING.SUBSCRIPTION.ACTIVATED', id);
    w.fake.queue.length = 0;
    w.fake.fail('GET', /\/transactions\?/, fault as any);
    const out = await w.deliver(event);
    expect(out.status).toBe(400);
    expect(o.errorOf(out)).toMatch(new RegExp(`^PayPal webhook not applied: the bot could not read subscription ${id} at PayPal \\(.+\\); PayPal sends the event again\\.$`));
    expect(o.heldOf(id)).toBeNull();
    const again = await w.deliver(event);
    expect([again.status, o.heldOf(id)?.location]).toEqual([200, 'active']);
  });
});

describe.each(KINDS)('P5P Q10: status does not matter [R8], for %s', (_name, k) => {
  it.each([
    ['ACTIVE', (_id: string) => undefined, 1],
    ['CANCELLED by the buyer', (id: string) => { w.fake.buyerCancel(id); }, 0],
    ['EXPIRED', (id: string) => { w.fake.expire(id); }, 0],
    ['SUSPENDED for failed payments', (id: string) => { w.fake.suspendForFailures(id); }, 1],
  ] as Array<[string, (id: string) => void, number]>)('held, read %s: the same active state and end; the cancel only from ACTIVE or SUSPENDED; freed by the checker at that end', async (_label, change, cancelled) => {
    const id = await heldActive(k);
    const end = o.endOf(id);
    change(id);
    const read = await w.deliver(o.lastDelivered('BILLING.SUBSCRIPTION.CREATED', id));
    expect(read.status).toBe(200);
    expect(o.heldOf(id)?.sub).toMatchObject({ status: 'active', autoRenew: false });
    expect(o.endOf(id)).toBe(end);
    expect(o.cancels(id)).toBe(1 + cancelled);
    w.later(end - Date.now() + HOUR);
    await w.tick();
    expect(o.heldOf(id)).toBeNull();
  });

  it("held, premium's soft cancel through the op: one cancel call, the same active state and end", async () => {
    const id = await heldActive(k);
    const end = o.endOf(id);
    const calls = o.cancels(id);
    const reply = await w.op('cancelPaidSubscription', holderOf(k));
    expect(reply.ok).toBe(true);
    expect(o.cancels(id) - calls).toBe(1);
    await o.drain();
    expect(o.heldOf(id)?.sub).toMatchObject({ status: 'active', autoRenew: false });
    expect(o.endOf(id)).toBe(end);
  });

  it.each([['ACTIVE', false], ['SUSPENDED', true]] as const)('PAYMENT.FAILED for a held one, the fake %s, the cancel refused so far (B2): no renewal-failed notice, the state unchanged, the cancel sent', async (_status, suspended) => {
    const id = await heldActive(k, { ignoreOverride: true });
    toDue(id);
    w.fake.failPayment(id);
    if (suspended) w.fake.suspendForFailures(id);
    // SUSPENDED: the only field allowed to change is PayPal's status in the entry's meta.
    const bytes = (): any => (suspended ? JSON.parse(JSON.stringify(o.plain(), (key, value) => (key === 'paypalStatus' ? undefined : value))) : o.plain());
    const before = bytes();
    const out = await only('BILLING.SUBSCRIPTION.PAYMENT.FAILED', id);
    expect(out.status).toBe(200);
    expect(w.notices().filter(n => n.kind === 'paid.sub.renewal-failed')).toEqual([]);
    expect(bytes()).toEqual(before);
    expect([o.cancels(id), fakeStatus(id)]).toEqual([2, 'CANCELLED']);
  });

  it.each([
    ['ACTIVE', (_id: string) => undefined, 1],
    ['CANCELLED', (id: string) => { w.fake.buyerCancel(id); }, 0],
    ['EXPIRED', (id: string) => { w.fake.expire(id); }, 0],
    ['SUSPENDED', (id: string) => { w.fake.suspendForFailures(id); }, 1],
  ] as Array<[string, (id: string) => void, number]>)('not held, first read %s with the payment proven: installed once with onceEnd(T)', async (_label, change, cancelled) => {
    const id = await o.buy(k);
    w.fake.configure(id, { finalCycle: 'stays-active' });
    w.fake.approve(id);
    change(id);
    await o.drain();
    expect(o.installLines(id)).toHaveLength(1);
    expect(o.endOf(id)).toBe(onceEnd(w.fake, id));
    expect(o.cancels(id)).toBe(cancelled);
  });

  it('none [R8, X4]: an APPROVAL_PENDING read, and a read with every cycles_completed 0, for an event other than PAYMENT.SALE.COMPLETED: 200, nothing, no line, no cancel', async () => {
    const id = await o.buy(k);
    const lines = () => w.logged('[PayPalProvider]').length;
    const before = lines();
    const created = await w.deliverNext(0);
    expect([created?.status, o.heldOf(id), lines()]).toEqual([200, null, before]);
    w.fake.approve(id, { firstSale: 'later' });
    const activated = await only('BILLING.SUBSCRIPTION.ACTIVATED', id);
    expect([activated.status, o.heldOf(id), lines(), o.cancels(id)]).toEqual([200, null, before, 0]);
  });

  it('expireNeverApproved: 400 PW7 at each delivery, nothing installed, no cancel (accepted limit Y8.8)', async () => {
    const id = await o.buy(k);
    w.fake.queue.length = 0;
    w.fake.expireNeverApproved(id);
    const outs = [await w.deliverNext(0), await w.deliver(o.lastDelivered('BILLING.SUBSCRIPTION.EXPIRED', id))];
    expect(outs.map(x => [x?.status, o.errorOf(x!)])).toEqual([[400, PW7(id, PW7_NONE)], [400, PW7(id, PW7_NONE)]]);
    expect([o.heldOf(id), o.cancels(id)]).toEqual([null, 0]);
  });
});

describe.each(KINDS)('P5P Q11: what still ends at once, for %s', (_name, k) => {
  it.each([['', {}], [', last_payment omitted on EXPIRED reads (R5)', { omitLastPayment: true, omitLastPaymentOn: 'EXPIRED' }]] as Array<[string, FakeSettings]>)('a held pay-once EXPIRED whose sale was refunded in full%s, the refund event not delivered: ended at once; the refund delivered: no cancel, PL6 had already expired', async (_label, settings) => {
    const id = await o.owned(k, { settings });
    expect(fakeStatus(id)).toBe('EXPIRED');
    expect(o.heldOf(id)?.location).toBe('active');
    const sale = o.sales(id)[0];
    w.fake.refund(sale);
    const refund = o.take('PAYMENT.SALE.REFUNDED', id);
    await w.deliver(o.lastDelivered('BILLING.SUBSCRIPTION.EXPIRED', id));
    expect(o.heldOf(id)).toBeNull();
    const other = await o.owned(k, { level: 'high' });
    const otherSale = o.sales(other)[0];
    w.fake.refund(otherSale);
    const out = await only('PAYMENT.SALE.REFUNDED', other);
    expect([out.status, o.heldOf(other), o.cancels(other)]).toEqual([200, null, 0]);
    expect(w.logged(PL6(otherSale, other, k, 'had already expired at PayPal'))).toHaveLength(1);
    expect(refund.event_type).toBe('PAYMENT.SALE.REFUNDED');
  });

  it('a held pay-once ACTIVE (the cancel refused so far) refunded in full: one refund cancel, ended, PL6', async () => {
    const id = await heldActive(k);
    const sale = o.sales(id)[0];
    w.fake.refund(sale);
    const out = await only('PAYMENT.SALE.REFUNDED', id);
    expect([out.status, o.heldOf(id), fakeStatus(id)]).toEqual([200, null, 'CANCELLED']);
    const calls = w.fake.callsOf('POST', new RegExp(`^/v1/billing/subscriptions/${id}/cancel$`));
    expect(calls.map(c => c.json?.reason)).toEqual(['sold as one payment', 'refunded']);
    expect(w.logged(PL6(sale, id, k, 'was cancelled at PayPal'))).toHaveLength(1);
  });

  it('a partial refund delivered once (C2): PL5, 200, no PW8, kept, and the second rule\'s cancel', async () => {
    const id = await heldActive(k);
    const sale = o.sales(id)[0];
    w.fake.refund(sale, 100);
    const out = await only('PAYMENT.SALE.REFUNDED', id);
    expect([out.status, o.errorOf(out)]).toEqual([200, '']);
    expect(w.logged(`[PayPalProvider] Sale ${sale} was refunded (PARTIALLY_REFUNDED), and it is not a full refund of the latest payment of subscription ${id}; the subscription stays.`)).toHaveLength(1);
    expect([o.heldOf(id)?.location, fakeStatus(id)]).toEqual(['active', 'CANCELLED']);
  });

  it('the refund event read while the list lags behind the refund (Z3): 400 PW8 after the cancel, nothing ended; after the release it ends it', async () => {
    const id = await heldActive(k);
    const sale = o.sales(id)[0];
    w.fake.configure(id, { listLag: true });
    w.fake.refund(sale);
    const event = o.take('PAYMENT.SALE.REFUNDED', id);
    w.fake.queue.length = 0;
    const out = await w.deliver(event);
    expect([out.status, o.errorOf(out), o.heldOf(id)?.location]).toEqual([400, PW8(sale, id), 'active']);
    w.fake.release(id, 'listLag');
    expect([fakeStatus(id), o.cancels(id)]).toEqual(['CANCELLED', 2]);
    const again = await w.deliver(event);
    expect([again.status, o.heldOf(id), o.cancels(id)]).toEqual([200, null, 2]);
    expect(w.logged(PL6(sale, id, k, 'was already cancelled at PayPal'))).toHaveLength(1);
  });

  it('the refund event naming the sale by another id than the list (R14, B1): every payment refunded ends the tier with no PW8', async () => {
    const id = await heldActive(k, { listOtherIds: true });
    const sale = o.sales(id)[0];
    w.fake.refund(sale);
    const out = await only('PAYMENT.SALE.REFUNDED', id);
    expect([out.status, o.errorOf(out), o.heldOf(id)]).toEqual([200, '', null]);
  });

  it('the refund event naming the sale by another id, an earlier payment still kept: the paid cell, then 400 PW8', async () => {
    const id = await heldActive(k, { listOtherIds: true, ignoreOverride: true });
    toDue(id);
    w.fake.renew(id);
    const [, second] = o.sales(id);
    w.fake.refund(second);
    const out = await only('PAYMENT.SALE.REFUNDED', id);
    expect([out.status, o.errorOf(out), o.heldOf(id)?.location]).toEqual([400, PW8(second, id), 'active']);
    expect(o.endOf(id)).toBe(onceEnd(w.fake, id));
  });

  it('under ignoreOverride, the refund event never delivered again: the next read (refunded, the fake ACTIVE) ends it and sends the cancel; the next renew is refused', async () => {
    const id = await heldActive(k, { ignoreOverride: true });
    w.fake.refund(o.sales(id)[0]);
    w.fake.queue.length = 0;
    const read = await w.deliver(o.lastDelivered('BILLING.SUBSCRIPTION.CREATED', id));
    expect([read.status, o.heldOf(id), fakeStatus(id)]).toEqual([200, null, 'CANCELLED']);
    toDue(id);
    expect(() => w.fake.renew(id)).toThrow(FakeRefusal);
  });

  it("the finite plan (total_cycles 3) bought renewing: P5's table, its EXPIRED ends it at once", async () => {
    await w.teardown();
    await w.setup({ clock: T0, link: ONCE_LINK });
    const id = await o.owned(k, { renewing: true, plan: EXTRA_PLANS.finite });
    expect(o.heldOf(id)?.sub).toMatchObject({ autoRenew: true });
    expect(o.endOf(id)).toBe(z5End(w.fake, id).end);
    for (let i = 0; i < 2; i++) {
      toDue(id);
      w.fake.renew(id);
      await o.drain();
    }
    expect(fakeStatus(id)).toBe('EXPIRED');
    expect(o.heldOf(id)).toBeNull();
    expect(o.cancels(id)).toBe(0);
  });
});

describe.each(KINDS)('P5P Q12: never installed, for %s', (_name, k) => {
  it('refunded in full before its first delivery: 200, nothing installed; the cancel sent', async () => {
    const id = await o.buy(k);
    w.fake.configure(id, { finalCycle: 'stays-active' });
    w.fake.approve(id);
    w.fake.refund(o.sales(id)[0]);
    const outs = await o.drain();
    expect(outs.every(x => x.status === 200)).toBe(true);
    expect([o.heldOf(id), o.installLines(id).length, fakeStatus(id)]).toEqual([null, 0, 'CANCELLED']);
  });

  it('its onceEnd(T) passed when its first event is read: nothing installed, the cancel sent when the read is ACTIVE', async () => {
    const id = await o.buy(k);
    w.fake.configure(id, { finalCycle: 'stays-active' });
    w.fake.approve(id);
    w.later(40 * DAY);
    const outs = await o.drain();
    expect(outs.every(x => x.status === 200)).toBe(true);
    expect([o.heldOf(id), o.cancels(id), fakeStatus(id)]).toEqual([null, 1, 'CANCELLED']);
  });

  it.each(FINAL_CYCLES)('removed with "Cancel & remove now" and redelivered in the same process, under %s: not installed again', async final => {
    const id = await o.owned(k, { settings: { finalCycle: final } });
    const reply = await w.op('cancelPaidSubscriptionImmediately', holderOf(k));
    expect(reply.ok).toBe(true);
    await o.drain();
    expect(o.heldOf(id)).toBeNull();
    for (const done of [...w.delivered]) if (done.event?.resource?.id === id || done.event?.resource?.billing_agreement_id === id) await w.deliver(done.event);
    expect(o.heldOf(id)).toBeNull();
    expect(o.installLines(id)).toHaveLength(1);
  });
});

describe('P5P Q14: the price migration of a pay-once subscription [R9]', () => {
  const OTHER = `guild:${IDS[1]}`;
  const revises = (id: string): number => w.fake.callsOf('POST', new RegExp(`^/v1/billing/subscriptions/${id}/revise$`)).length;
  async function migrated(failRead: boolean): Promise<{ once: string; renewing: string; decisions: any[]; readsDuring: number }> {
    const once = await o.owned('guild', { settings: { finalCycle: 'stays-active' } });
    const reply = await w.buyMember(OTHER, IDS[1], { tierId: 'gold', plan: planId('gold', 'cheap') });
    w.fake.approve(reply.subscriptionId!);
    await o.drain();
    const renewing = reply.subscriptionId!;
    const pm = o.premium();
    const migration = await pm.scheduleMigration({
      providerId: 'paypal', sourceTierId: 'gold', sourceOfferingId: 'o-gold', sourceVariantId: planId('gold', 'cheap'),
      targetTierId: 'gold', targetOfferingId: 'o-gold', targetVariantId: planId('gold', 'dear'),
      effectiveDate: new Date(Date.now() + DAY).toISOString(), message: '',
    });
    await w.settle();
    for (const holder of [holderOf('guild'), OTHER]) expect(pm.recordMigrationDecision(migration.id, holder, 'accepted')).toBe(true);
    await w.settle();
    if (failRead) w.fake.fail('GET', new RegExp(`^/v1/billing/subscriptions/${once}$`), { status: 500 });
    const readsBefore = o.reads(once);
    w.later(2 * DAY);
    await pm.processDueMigrations();
    await w.settle();
    const stored = (w.stored()?.migrations ?? []).find((m: any) => m.id === migration.id);
    return { once, renewing, decisions: stored?.decisions ?? [], readsDuring: o.reads(once) - readsBefore };
  }

  it('accepted: the pay-once one gets one read, no revise, its decision failed with PR1 and the entry unchanged; the renewing one is revised', async () => {
    const { once, renewing, decisions, readsDuring } = await migrated(false);
    expect([revises(once), revises(renewing), readsDuring]).toEqual([0, 1, 1]);
    const decision = decisions.find((d: any) => d.providerSubId === once);
    expect(decision).toMatchObject({ outcome: 'failed', outcomeNote: `PayPal subscription ${once} was sold as one payment and has no later payment to reprice; it was not migrated.` });
    expect(decisions.find((d: any) => d.providerSubId === renewing)).toMatchObject({ outcome: 'migrated' });
    expect(o.heldOf(once)!.sub).toMatchObject({ tierId: 'gold', variantId: planId('gold', 'cheap'), autoRenew: false });
  });

  it("a renewing subscription's read answering 500 (W9, review 1 B7): its decision failed with the can't-confirm form, no revise", async () => {
    const once = await o.owned('guild', { settings: { finalCycle: 'stays-active' } });
    const reply = await w.buyMember(OTHER, IDS[1], { tierId: 'gold', plan: planId('gold', 'cheap') });
    const renewing = reply.subscriptionId!;
    w.fake.approve(renewing);
    await o.drain();
    const pm = o.premium();
    const migration = await pm.scheduleMigration({
      providerId: 'paypal', sourceTierId: 'gold', sourceOfferingId: 'o-gold', sourceVariantId: planId('gold', 'cheap'),
      targetTierId: 'gold', targetOfferingId: 'o-gold', targetVariantId: planId('gold', 'dear'),
      effectiveDate: new Date(Date.now() + DAY).toISOString(), message: '',
    });
    await w.settle();
    for (const holder of [holderOf('guild'), OTHER]) expect(pm.recordMigrationDecision(migration.id, holder, 'accepted')).toBe(true);
    await w.settle();
    w.fake.fail('GET', new RegExp(`^/v1/billing/subscriptions/${renewing}$`), { status: 500 });
    w.later(2 * DAY);
    await pm.processDueMigrations();
    await w.settle();
    const decisions = ((w.stored()?.migrations ?? []).find((m: any) => m.id === migration.id)?.decisions ?? []) as any[];
    expect(revises(renewing)).toBe(0);
    expect(decisions.find((d: any) => d.providerSubId === renewing)).toMatchObject({
      outcome: 'failed', outcomeNote: `Can't confirm whether PayPal subscription ${renewing} was sold as one payment (PayPal answered 500: An internal server error has occurred.); it was not migrated.`,
    });
    expect(o.heldOf(renewing)!.sub).toMatchObject({ variantId: planId('gold', 'cheap') });
    expect(once).toBeTruthy();
  });

  it("the read answering 500: PR1's can't-confirm form, no revise", async () => {
    const { once, decisions } = await migrated(true);
    expect(revises(once)).toBe(0);
    expect(decisions.find((d: any) => d.providerSubId === once)).toMatchObject({
      outcome: 'failed', outcomeNote: `Can't confirm whether PayPal subscription ${once} was sold as one payment (PayPal answered 500: An internal server error has occurred.); it was not migrated.`,
    });
  });
});

describe.each(KINDS)('P5P review 1, A1 to A3: texts after a refund, PL18, a cycle the bot cannot count, for %s', (_name, k) => {
  const cancelPath = (id: string): RegExp => new RegExp(`^/v1/billing/subscriptions/${id}/cancel$`);
  /** A held pay-once subscription whose only sale is refunded in full; the refund event taken out of the queue. */
  async function refundedHeld(): Promise<[string, PayPalEvent]> {
    const id = await heldActive(k);
    w.fake.refund(o.sales(id)[0]);
    const event = o.take('PAYMENT.SALE.REFUNDED', id);
    w.fake.queue.length = 0;
    return [id, event];
  }
  /** Held, a second sale taken while the cancel failed, then the cancel landed. */
  async function twoSalesHeld(): Promise<[string, string, string]> {
    const id = await heldActive(k, { ignoreOverride: true });
    toDue(id);
    w.fake.renew(id);
    await o.drain();
    const [a, b] = o.sales(id);
    return [id, a, b];
  }
  const uncountable = (id: string): void => {
    const plan = w.fake.plans.get(w.fake.subscriptions.get(id)!.plan_id)!;
    plan.billing_cycles.find((c: any) => c.tenure_type === 'REGULAR').frequency = { interval_unit: 'FORTNIGHT', interval_count: 1 };
  };

  it("A1: the refund's cancel refused (422 with the fake ACTIVE): 400 saying the tier was ended; the resend, not held, says the bot holds none", async () => {
    const [id, event] = await refundedHeld();
    w.fake.fail('POST', cancelPath(id), { status: 422, message: 'Refused by the p5p row.' }, 2);
    const out = await w.deliver(event);
    expect([out.status, o.errorOf(out), o.heldOf(id)]).toEqual([400, RF.refused(id, true, 'Refused by the p5p row', 'ACTIVE'), null]);
    const calls = o.cancels(id);
    const again = await w.deliver(event);
    expect([again.status, o.errorOf(again), o.cancels(id)]).toEqual([400, RF.refused(id, false, 'Refused by the p5p row', 'ACTIVE'), calls + 1]);
  });

  it("A1: the refund's cancel answering 503: 400 with the can't-confirm form, the tier ended", async () => {
    const [id, event] = await refundedHeld();
    w.fake.fail('POST', cancelPath(id), { status: 503 });
    const out = await w.deliver(event);
    expect([out.status, o.errorOf(out), o.heldOf(id)]).toEqual([400, RF.unsure(id, true, 'PayPal answered 503: An internal server error has occurred.'), null]);
  });

  it("A1: the refund's cancel never sent (a refused sign-in): 400 with the not-sent form, the tier ended", async () => {
    const [id, event] = await refundedHeld();
    const hold = w.fake.hold('GET', /\/transactions\?/);
    const first = w.deliver(event);
    await hold.reached;
    (getPaymentRegistry().get('paypal') as any).tokenCache = null;
    w.fake.fail('POST', /^\/v1\/oauth2\/token$/, { status: 401 });
    hold.release();
    const out = await first;
    expect([out.status, o.errorOf(out), o.heldOf(id)]).toEqual([400, RF.notSent(id, true, 'the bot could not sign in to PayPal: PayPal answered 401'), null]);
  });

  it("A1: the refund's cancel 4xx and its read answering 404: 400 with the 404 form, not PL9", async () => {
    const [id, event] = await refundedHeld();
    w.fake.fail('POST', cancelPath(id), { status: 422 });
    const hold = w.fake.hold('POST', cancelPath(id));
    const first = w.deliver(event);
    await hold.reached;
    w.fake.fail('GET', new RegExp(`^/v1/billing/subscriptions/${id}$`), { status: 404 });
    hold.release();
    const out = await first;
    expect([out.status, o.errorOf(out), o.heldOf(id)]).toEqual([400, RF.missing(id, true), null]);
    expect(w.logged('PayPal has no subscription')).toEqual([]);
  });

  it('A2: the later sale refunded after "Cancel & remove now": PL18 says the bot holds no tier', async () => {
    const [id, , b] = await twoSalesHeld();
    expect((await w.op('cancelPaidSubscriptionImmediately', holderOf(k))).ok).toBe(true);
    await o.drain();
    expect(o.heldOf(id)).toBeNull();
    w.fake.refund(b);
    const out = await only('PAYMENT.SALE.REFUNDED', id);
    expect(out.status).toBe(200);
    expect(w.logged(PL18_NONE(b, id, k))).toHaveLength(1);
    expect(w.logged('keeps its tier')).toEqual([]);
  });

  it('A2: the later sale refunded once the held end has passed: ended, and PL18 says the paid period ended (review 2, A4)', async () => {
    const [id, a, b] = await twoSalesHeld();
    const end = o.endOf(id);
    w.later(end - Date.now() + HOUR);
    w.fake.refund(b);
    const out = await only('PAYMENT.SALE.REFUNDED', id);
    expect([out.status, o.heldOf(id)]).toEqual([200, null]);
    expect(w.logged(PL18_ENDED(b, id, k, o.saleTime(a), end))).toHaveLength(1);
    expect(w.logged('holds no tier')).toEqual([]);
    expect(w.logged('keeps its tier')).toEqual([]);
  });

  it('A4: the later sale refunded, the refund the first event delivered while unheld: installed with onceEnd(T), PL18 says until that end', async () => {
    const id = await o.buy(k);
    w.fake.configure(id, { finalCycle: 'stays-active', ignoreOverride: true });
    w.fake.approve(id);
    toDue(id);
    w.fake.renew(id);
    w.fake.queue.length = 0;
    const [a, b] = o.sales(id);
    w.fake.refund(b);
    const out = await only('PAYMENT.SALE.REFUNDED', id);
    expect(out.status).toBe(200);
    expect(o.heldOf(id)?.location).toBe('active');
    expect(o.endOf(id)).toBe(onceEnd(w.fake, id));
    expect(w.logged(PL18(b, id, k, o.saleTime(a), onceEnd(w.fake, id)!))).toHaveLength(1);
    expect(w.logged('holds no tier')).toEqual([]);
  });

  it('A3: a paid one premium does not hold, its plan cycle uncountable: 200, nothing installed, PL19 asks for a refund, the cancel sent', async () => {
    const id = await o.buy(k);
    w.fake.configure(id, { finalCycle: 'stays-active' });
    w.fake.approve(id);
    uncountable(id);
    const out = await only('BILLING.SUBSCRIPTION.ACTIVATED', id);
    expect([out.status, o.heldOf(id), fakeStatus(id)]).toEqual([200, null, 'CANCELLED']);
    const T = o.saleTime(o.sales(id)[0]);
    expect(w.logged(PL19(id, k, T, w.fake.subscriptions.get(id)!.plan_id))).toHaveLength(1);
  });

  it('A3: a later sale refunded on a held one whose plan cycle became uncountable: 200, the entry kept, PL18 with no end', async () => {
    const [id, a, b] = await twoSalesHeld();
    const before = o.plain();
    uncountable(id);
    w.fake.refund(b);
    const out = await only('PAYMENT.SALE.REFUNDED', id);
    expect([out.status, o.errorOf(out)]).toEqual([200, '']);
    expect(o.plain()).toEqual(before);
    expect(w.logged(PL18_UNCOUNTED(b, id, k, o.saleTime(a)))).toHaveLength(1);
  });
});
