import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { premiumRig } from '../helpers/nb6PremiumRig';
import { DAY_MS, MONTHLY, dummyRig, dummyTier } from '../helpers/nb6DummyRig';
import { gh, uh } from '../helpers/p1Holder';

// P1 claims 13 (the Dummy's block) and 21 (part 4d): the Dummy's record names its holder and its buyer; its list
// answers by holder with the buyer; its tick reads premium and sends its events by holder. That the Dummy sells users,
// and the records its load leaves out, are pinned in p2Shape.test.ts.
// The real DummyProvider and PremiumManager in the bot role over the scripted shared tables (nb6DummyProvider.test.ts's
// rig).

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
const premiumSub = (guild: string) => r.row()?.subscriptions?.[gh(guild)]?.active;

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
  it("a server purchase stores the holder and the buyer in the Dummy's record, and the buyer in premium's subscription", async () => {
    const bought = await d.buy(S1);
    expect(bought.providerSubId).toBe('dummy_1');
    const record = d.record('dummy_1');
    expect(record).toMatchObject({ providerSubId: 'dummy_1', holder: gh(S1), buyerId: BUYER, tierId: 'gold', offeringId: 'o1', variantId: MONTHLY, status: 'active' });
    expect(Object.keys(record)).toEqual([
      'providerSubId', 'holder', 'buyerId', 'tierId', 'offeringId', 'variantId', 'durationDays', 'startDate', 'endDate', 'autoRenew', 'status', 'createdAt', 'updatedAt',
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
});

describe('P2 claim 3: the Dummy sells servers and users', () => {
  it("a user purchase made straight at the Dummy stores a record under the user's key, paid by the user", async () => {
    await d.buy(S1);
    const bought = await d.dummy.initiatePurchase({ holder: uh(USER), buyerId: USER, tierId: 'gold', offeringId: 'o1', variantId: MONTHLY } as any);
    await d.settle();
    expect(bought.providerSubId).toBe('dummy_2');
    expect(d.record('dummy_2')).toMatchObject({ providerSubId: 'dummy_2', holder: uh(USER), buyerId: USER, status: 'active' });
    expect((await d.dummy.listSubscriptionsFor!(uh(USER))).map(l => l.providerSubId)).toEqual(['dummy_2']);
    expect((await d.dummy.listSubscriptionsFor!(gh(USER))).map(l => l.providerSubId)).toEqual([]);
  });

  it("a user purchase through premium asks the Dummy's list for the user, then buys and installs under the user's key with the user as buyer", async () => {
    const vip = { ...dummyTier('VIP', 3, 'ov'), kind: 'user' };
    r.pm().setTier('vip', vip as any);
    await d.settle();
    expect(r.row().tiers.vip.kind).toBe('user');
    const purchase = vi.spyOn(d.dummy, 'initiatePurchase');
    const list = vi.spyOn(d.dummy, 'listSubscriptionsFor' as any);

    const bought = await r.pm().initiatePaidSubscription(uh(USER), 'vip', 'ov', { buyerId: USER, providerId: 'dummy', variantId: MONTHLY });
    await d.settle();
    const listedFor = list.mock.calls.map(c => c[0]);
    const boughtWith = purchase.mock.calls.map(c => [(c[0] as any).holder, (c[0] as any).buyerId]);
    purchase.mockRestore();
    list.mockRestore();

    expect(listedFor).toEqual([uh(USER)]);
    expect(boughtWith).toEqual([[uh(USER), USER]]);
    expect(bought.providerSubId).toBe('dummy_1');
    expect(d.record('dummy_1')).toMatchObject({ holder: uh(USER), buyerId: USER, tierId: 'vip', status: 'active' });
    expect(r.row().subscriptions[uh(USER)].active).toMatchObject({ providerId: 'dummy', providerSubId: 'dummy_1', tierId: 'vip', buyerId: USER });
    expect(r.row().subscriptions[gh(USER)]).toBeUndefined();
  });

  it('declares that it sells servers and users', () => {
    expect(d.dummy.capabilities.sells).toEqual(['guild', 'user']);
  });
});
