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
import { addCycles, customIdFor, type PayPalEvent } from '../helpers/p5PayPal';
import { BOT_CLIENT_ID, EXTRA_PLANS, heldPayPal, IDS, p5World, planId, TIERS, type Delivered, type PlanKind, type TierId } from '../helpers/p5World';

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
    expect(w.logged(`[PremiumManager] subscription.created from PayPal (subscription ${id}, ${words(k)}) was not installed: offering '${label}' does not sell variant '${EXTRA_PLANS.unlinked}' through PayPal. PayPal keeps billing it: cancel and refund it at PayPal.`).length).toBeGreaterThan(0);
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
    const line = `[PremiumManager] subscription.created from PayPal (subscription ${second}, ${words(k)}) was not installed: ${words(k)} already holds '${label}' at that priority. PayPal keeps billing it: cancel and refund it at PayPal.`;
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
