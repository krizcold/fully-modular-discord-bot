import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { PREMIUM_KEY, premiumRig } from '../helpers/nb6PremiumRig';
import { DAY_MS, DUMMY_KEY, MONTHLY, dummyRig, dummyTier } from '../helpers/nb6DummyRig';
import { gh, uh } from '../helpers/p1Holder';

// P1 claims 13 (the Dummy's block) and 21 (part 4d): the Dummy keeps `guildId` in its record and gains `buyerId`; its
// list answers by holder with the buyer; its tick reads premium and sends its events by holder, and skips a record
// whose server id is not a Discord id; it sells servers only, so a user's purchase is refused (X3) and its file is
// left as it was. The real DummyProvider and PremiumManager in the bot role over the scripted shared tables
// (nb6DummyProvider.test.ts's rig).

vi.mock('fs', async orig => (await import('../helpers/forwardingFs')).forwardingFs(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  let registry: InstanceType<typeof real.PaymentProviderRegistry> | null = null;
  return { ...real, getPaymentRegistry: () => (registry ??= new real.PaymentProviderRegistry()) };
});
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async () => ({ delivered: true, via: 'dm' }),
}));

const r = premiumRig();
const d = dummyRig(r);

const S1 = '70000000000000001';
const S2 = '70000000000000002';
const BUYER = '80000000000000001';
const USER = '80000000000000005';
const X3 = 'Dummy (Development) does not sell user subscriptions.';
const X10 = "Dummy (Development)'s record does not name the Discord user who paid; cancel it at Dummy (Development) instead";
const premiumSub = (guild: string) => r.row()?.subscriptions?.[gh(guild)]?.active;
const storedText = () => r.m.state.rows.docs.get(DUMMY_KEY)?.body.toString('utf8') ?? null;

/** Collects the walk batches the tick sends to premium. */
function walkBatches(): any[] {
  const batches: any[] = [];
  getPaymentRegistry().on('provider.walk-batch', batch => batches.push(batch));
  return batches;
}

/** Collects the reader calls the tick makes. */
function readerCalls(): { calls: string[][]; restore: () => void } {
  const registry = getPaymentRegistry();
  const real = registry.readSubscription.bind(registry);
  const calls: string[][] = [];
  const spy = vi.spyOn(registry, 'readSubscription').mockImplementation((providerId, holder, providerSubId) => {
    calls.push([providerId, holder, providerSubId]);
    return real(providerId, holder, providerSubId);
  });
  return { calls, restore: () => spy.mockRestore() };
}

beforeEach(async () => {
  await d.setup();
});
afterEach(async () => {
  await d.teardown();
});

describe('P1 claim 21: the Dummy stores and lists the buyer', () => {
  it("a server purchase stores the buyer in the Dummy's record, beside today's guildId, and in premium's subscription", async () => {
    const bought = await d.buy(S1);
    expect(bought.providerSubId).toBe('dummy_1');
    const record = d.record('dummy_1');
    expect(record).toMatchObject({ providerSubId: 'dummy_1', guildId: S1, buyerId: BUYER, tierId: 'gold', offeringId: 'o1', variantId: MONTHLY, status: 'active' });
    expect(Object.keys(record)).toEqual([
      'providerSubId', 'guildId', 'buyerId', 'tierId', 'offeringId', 'variantId', 'durationDays', 'startDate', 'endDate', 'autoRenew', 'status', 'createdAt', 'updatedAt',
    ]);
    expect(premiumSub(S1)).toMatchObject({ providerId: 'dummy', providerSubId: 'dummy_1', buyerId: BUYER });
  });

  it('its list answers by holder: holder and buyer in the metadata and no server id; nothing for another server or a user', async () => {
    await d.buy(S1);
    const listed = await d.dummy.listSubscriptionsFor!(gh(S1));
    expect(listed).toHaveLength(1);
    expect(listed[0].providerSubId).toBe('dummy_1');
    expect(listed[0].metadata).toEqual({ holder: gh(S1), buyerId: BUYER, tierId: 'gold', offeringId: 'o1', variantId: MONTHLY, couponCode: undefined });
    expect(await d.dummy.listSubscriptionsFor!(gh(S2))).toEqual([]);
    expect(await d.dummy.listSubscriptionsFor!(uh(S1))).toEqual([]);
    expect(await d.dummy.listSubscriptionsFor!('guild:g1' as any)).toEqual([]);
  });

  it('a record without a buyer (as the Dummy wrote every record before P1) is listed with none, and its adoption plan is X10', async () => {
    const made = await d.dummy.initiatePurchase({ holder: gh(S2), tierId: 'gold', offeringId: 'o1', variantId: MONTHLY } as any);
    const madeId = made.providerSubId!;
    await d.settle();
    expect(d.record(madeId)).not.toHaveProperty('buyerId');
    const listed = await d.dummy.listSubscriptionsFor!(gh(S2));
    expect(listed.map(l => l.metadata)).toEqual([{ holder: gh(S2), tierId: 'gold', offeringId: 'o1', variantId: MONTHLY, couponCode: undefined }]);

    const orphans = await r.pm().findOrphansFor(gh(S2));
    expect(orphans.map(o => [o.providerId, o.ref.providerSubId, o.plan])).toEqual([
      ['dummy', madeId, { kind: 'refuse', reason: X10, line: `It cannot be adopted: ${X10}.` }],
    ]);
    const before = r.row();
    await expect(r.pm().adoptOrphan(gh(S2), 'dummy', madeId, { kind: 'install' })).rejects.toThrow(`Subscription '${madeId}' was not adopted: ${X10}.`);
    await d.settle();
    expect(r.row()).toEqual(before);
    expect(premiumSub(S2)).toBeUndefined();
  });
});

describe("P1 claims 13 and 21: the Dummy's tick speaks holders", () => {
  it('reads premium by holder and sends its renewal and expiry by holder; premium applies them under the sha rule', async () => {
    await d.buy(S1);
    await d.buy(S2);
    expect(await r.pm().cancelPaidSubscription(gh(S2))).toBe(true);
    await d.settle();
    const end1 = premiumSub(S1).endDate;
    const batches = walkBatches();
    const reads = readerCalls();
    d.later(31);
    await d.tick();
    reads.restore();

    expect(reads.calls).toEqual([['dummy', gh(S1), 'dummy_1'], ['dummy', gh(S2), 'dummy_2']]);
    expect(batches).toHaveLength(1);
    expect(batches[0].events.map((e: any) => [e.type, e.providerSubId, e.holder, 'guildId' in e])).toEqual([
      ['subscription.renewed', 'dummy_1', gh(S1), false],
      ['subscription.expired', 'dummy_2', gh(S2), false],
    ]);
    expect(Date.parse(premiumSub(S1).endDate)).toBe(Date.parse(end1) + 30 * DAY_MS);
    expect(premiumSub(S2)).toBeUndefined();
    expect(r.logged('was not applied')).toEqual([]);
  });

  it("skips a record whose server id is 'g1' (written by another machine) and still handles the record beside it", async () => {
    await d.buy(S1);
    const oddId = (await d.dummy.initiatePurchase({ holder: gh(S2), buyerId: BUYER, tierId: 'gold', offeringId: 'o1', variantId: MONTHLY } as any)).providerSubId!;
    await d.settle();
    await d.otherDummy(state => { state.subscriptions[oddId].guildId = 'g1'; });
    const oddBefore = d.record(oddId);
    const end1 = premiumSub(S1).endDate;
    const batches = walkBatches();
    const reads = readerCalls();
    d.later(31);
    const errors = vi.spyOn(console, 'error');
    const warns = vi.spyOn(console, 'warn');
    await d.tick();
    await d.tick();
    reads.restore();
    const errorCount = errors.mock.calls.length;
    const warnCount = warns.mock.calls.length;
    errors.mockRestore();
    warns.mockRestore();

    expect(reads.calls.every(c => c[1] === gh(S1))).toBe(true);
    expect(d.record(oddId)).toEqual(oddBefore);
    expect(batches.flatMap(b => b.events.map((e: any) => e.providerSubId))).toEqual(['dummy_1']);
    expect(Date.parse(premiumSub(S1).endDate)).toBe(Date.parse(end1) + 30 * DAY_MS);
    expect(await d.dummy.listSubscriptionsFor!(gh(S2))).toEqual([]);
    expect([errorCount, warnCount]).toEqual([0, 0]);
  });
});

describe('P1 claim 13: the Dummy sells servers only', () => {
  it("a user purchase made straight at the Dummy throws X3 and the Dummy's stored file is unchanged", async () => {
    await d.buy(S1);
    const before = storedText();
    await expect(d.dummy.initiatePurchase({ holder: uh(USER), buyerId: USER, tierId: 'gold', offeringId: 'o1', variantId: MONTHLY } as any)).rejects.toThrow(X3);
    await d.settle();
    expect(storedText()).toBe(before);
    expect((await d.dummy.initiatePurchase({ holder: gh(S2), buyerId: BUYER, tierId: 'gold', offeringId: 'o1', variantId: MONTHLY } as any)).providerSubId).toBe('dummy_2');
  });

  it("a user purchase through premium is refused with X3 before the Dummy is called; the Dummy's file is unchanged", async () => {
    getPaymentRegistry().unregister('dummy');
    const vip = { ...dummyTier('VIP', 3, 'ov'), kind: 'user' };
    r.pm().setTier('vip', vip as any);
    await d.settle();
    getPaymentRegistry().register(d.dummy);
    d.dummy.start();
    expect(r.row().tiers.vip.kind).toBe('user');
    await d.buy(S1);
    const before = storedText();
    const premiumBefore = r.m.state.rows.docs.get(PREMIUM_KEY)?.body.toString('utf8');
    const purchase = vi.spyOn(d.dummy, 'initiatePurchase');
    const list = vi.spyOn(d.dummy, 'listSubscriptionsFor' as any);

    await expect(r.pm().initiatePaidSubscription(uh(USER), 'vip', 'ov', { buyerId: USER, providerId: 'dummy', variantId: MONTHLY })).rejects.toThrow(X3);
    await d.settle();

    expect(purchase).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    purchase.mockRestore();
    list.mockRestore();
    expect(storedText()).toBe(before);
    expect(r.m.state.rows.docs.get(PREMIUM_KEY)?.body.toString('utf8')).toBe(premiumBefore);
  });

  it("declares that it sells servers", () => {
    expect(d.dummy.capabilities.sells).toEqual(['guild']);
  });
});
