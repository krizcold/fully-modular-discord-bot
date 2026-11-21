import { afterEach, describe, expect, it, vi } from 'vitest';

// P2 claims 6 and 7 (part 2): every path of sheet P2 section 2's table, for a server and for a user, through premium
// and the real DummyProvider, on the JSON files and on the mirror rig; and the price change at the provider. Each row
// reads both stored documents: premium-tiers.json (premium's copy) and the Dummy's state.json (its record).

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

import { getPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { gh, uh } from '../helpers/p1Holder';
import { notices } from '../helpers/p1Mocks';
import { BUYER, SERVERS, p1World } from '../helpers/p1World';
import { DUMMY_VARIANT, dummyDriver } from '../helpers/p2DummyDriver';

const A = SERVERS[0];
const DAY_MS = 86_400_000;
const YEARLY = 'dummy_yearly_9999';
const X11 = 'Price changes cannot be scheduled for a user tier: a user has no page to accept or decline one until the "My account" page exists.';

const KINDS = [
  { kind: 'server', who: gh(A), low: 'low', high: 'high', buyer: BUYER },
  { kind: 'user', who: uh(A), low: 'vlow', high: 'vhigh', buyer: A },
] as const;

type Driver = ReturnType<typeof dummyDriver>;
type World = ReturnType<typeof p1World>;
let current: World | null = null;

async function world(backend: 'json' | 'rig'): Promise<{ w: World; driver: Driver }> {
  const driver = dummyDriver();
  const w = p1World(backend, driver);
  current = w;
  await w.setup();
  await w.addSoldUserTiers();
  notices.sent.length = 0;
  return { w, driver };
}

afterEach(async () => {
  if (current) await current.teardown();
  current = null;
  vi.restoreAllMocks();
});

const idOf = (reply: any): string => reply.result.providerSubId as string;
const record = (driver: Driver, id: string): any => driver.document().subscriptions[id];
const methods = (driver: Driver, from: number): string[] => driver.calls().slice(from).map(c => c.method);

describe.each([['json'], ['rig']] as const)('%s', backend => {
  describe.each(KINDS)('claim 6: the paths for a $kind', k => {
    it('purchase, renewal by the tick, cancel at period end, renew again, cancel again; the notice goes to the holder', async () => {
      const { w, driver } = await world(backend);
      const bought = await w.purchase(k.who, k.low);
      expect(bought).toMatchObject({ ok: true });
      const id = idOf(bought);
      const active = w.recordOf(k.who).active;
      expect(active).toMatchObject({ providerId: 'dummy', providerSubId: id, buyerId: k.buyer, status: 'active', autoRenew: true });
      expect(record(driver, id)).toMatchObject({ holder: k.who, buyerId: k.buyer, status: 'active', autoRenew: true, endDate: active.endDate });
      expect(notices.sent).toEqual([{ to: k.who, kind: 'paid.sub.started' }]);

      const end = Date.parse(active.endDate);
      w.advance(31);
      await w.tick();
      await w.settle();
      expect(Date.parse(w.recordOf(k.who).active.endDate)).toBe(end + 30 * DAY_MS);
      expect(Date.parse(record(driver, id).endDate)).toBe(end + 30 * DAY_MS);

      for (const [op, autoRenew] of [['cancelPaidSubscription', false], ['reactivatePaidSubscription', true], ['cancelPaidSubscription', false]] as const) {
        expect(await w.op(op, k.who)).toMatchObject({ ok: true, result: true });
        expect([w.recordOf(k.who).active.autoRenew, record(driver, id).autoRenew]).toEqual([autoRenew, autoRenew]);
      }
      expect(notices.sent.every(n => n.to === k.who)).toBe(true);
    });

    it('a purchase behind a higher one starts paused at both with resumesAt the active end and no pause call; at the end a tick expires the higher and resumes it with fresh dates; cancel now ends it', async () => {
      const { w, driver } = await world(backend);
      const high = idOf(await w.purchase(k.who, k.high));
      const callsBefore = driver.calls().length;
      const low = idOf(await w.purchase(k.who, k.low));
      const highEnd = w.recordOf(k.who).active.endDate;
      expect(methods(driver, callsBefore)).toEqual(['listSubscriptionsFor', 'initiatePurchase']);
      expect(w.recordOf(k.who).paused.map((p: any) => [p.providerSubId, p.status])).toEqual([[low, 'paused']]);
      expect(record(driver, low)).toMatchObject({ status: 'paused', paused: true, resumesAt: highEnd });

      expect(await w.op('cancelPaidSubscription', k.who)).toMatchObject({ ok: true, result: true });
      w.advance(31);
      await w.tick();
      await w.settle();
      expect(record(driver, high).status).toBe('expired');
      const resumed = w.recordOf(k.who).active;
      expect(resumed).toMatchObject({ providerSubId: low, status: 'active' });
      expect(w.recordOf(k.who).paused).toEqual([]);
      expect(Math.abs(Date.parse(resumed.startDate) - Date.now())).toBeLessThan(5 * 60_000);
      await vi.waitFor(() => expect(record(driver, low)).toMatchObject({ status: 'active', endDate: resumed.endDate }), { timeout: 5000, interval: 20 });

      expect(await w.cancelNow(k.who)).toMatchObject({ ok: true, result: true });
      expect(w.recordOf(k.who)).toBeNull();
      expect(record(driver, low).status).toBe('expired');
    });

    it('a higher purchase pauses the active one at the Dummy with resumesAt null and one pause call', async () => {
      const { w, driver } = await world(backend);
      const low = idOf(await w.purchase(k.who, k.low));
      const callsBefore = driver.calls().length;
      const high = idOf(await w.purchase(k.who, k.high));
      expect(methods(driver, callsBefore)).toEqual(['listSubscriptionsFor', 'initiatePurchase', 'pauseSubscription']);
      expect(w.recordOf(k.who).active.providerSubId).toBe(high);
      expect(w.recordOf(k.who).paused.map((p: any) => [p.providerSubId, p.status])).toEqual([[low, 'paused']]);
      expect(record(driver, low)).toMatchObject({ status: 'paused', paused: true, resumesAt: null });
      expect(record(driver, high)).toMatchObject({ status: 'active', holder: k.who, buyerId: k.buyer });
    });
  });

  describe('claim 7: the price change at the provider', () => {
    it("migrateSubscriptionPrice on a user's record sets the variant, the duration and the end and keeps holder and buyer", async () => {
      const { w, driver } = await world(backend);
      const id = idOf(await w.purchase(uh(A), 'vlow'));
      const before = record(driver, id);
      await driver.provider().migrateSubscriptionPrice(id, YEARLY, 'none');
      await w.settle();
      const after = record(driver, id);
      expect(after).toMatchObject({ holder: uh(A), buyerId: A, variantId: YEARLY, durationDays: 365 });
      expect(after.endDate).not.toBe(before.endDate);
    });

    it('scheduleMigration on a user tier throws X11 and state.json keeps its bytes', async () => {
      const { w, driver } = await world(backend);
      expect((await w.purchase(uh(A), 'vlow')).ok).toBe(true);
      const bytes = driver.bytes();
      const reply = await w.op('scheduleMigration', {
        providerId: 'dummy', sourceTierId: 'vlow', sourceOfferingId: 'o-vlow', sourceVariantId: DUMMY_VARIANT,
        targetTierId: 'vmid', targetOfferingId: 'o-vmid', targetVariantId: DUMMY_VARIANT,
        effectiveDate: new Date(Date.now() + 3_600_000).toISOString(), message: 'the price changes',
      });
      expect(reply.ok).toBe(false);
      expect(reply.error).toContain(X11);
      expect(driver.bytes()).toBe(bytes);
    });

    it.each(KINDS)('a variant changed at the Dummy alone is written back to premium\'s at the second tick ($kind)', async k => {
      const { w, driver } = await world(backend);
      const id = idOf(await w.purchase(k.who, k.low));
      await driver.provider().migrateSubscriptionPrice(id, YEARLY, 'none');
      await w.settle();
      expect(record(driver, id).variantId).toBe(YEARLY);
      await w.tick();
      expect(record(driver, id).variantId).toBe(YEARLY);
      await w.tick();
      expect(record(driver, id)).toMatchObject({ variantId: DUMMY_VARIANT, endDate: w.recordOf(k.who).active.endDate, holder: k.who });
    });
  });
});

describe('the rig: a renewal batch premium dropped because its own expiry save landed inside the tick', () => {
  it('after the first tick the Dummy is one period ahead with the drop warning, the second changes nothing, the third repairs it and the renewal counts once', async () => {
    const { w, driver } = await world('rig');
    getPremiumManager().startExpiryChecker();
    const user = uh(SERVERS[1]);
    expect(await w.grant(gh(A), 'low', 1)).toMatchObject({ ok: true });
    const bought = await w.purchase(user, 'vlow');
    expect(bought).toMatchObject({ ok: true });
    const id = idOf(bought);
    const end = Date.parse(w.recordOf(user).active.endDate);
    expect(Date.parse(record(driver, id).endDate)).toBe(end);

    w.advance(30);
    expect(w.logged('was not applied')).toEqual([]);
    await w.tick();
    await w.settle();
    expect(Date.parse(record(driver, id).endDate)).toBe(end + 30 * DAY_MS);
    expect(Date.parse(w.recordOf(user).active.endDate)).toBe(end);
    expect(w.recordOf(gh(A))?.active ?? null).toBeNull();
    expect(w.logged('was not applied')).toEqual([
      `[PremiumManager] The subscription.renewed event for subscription ${id} was not applied: premium-tiers.json changed after the Dummy provider read it; the Dummy provider compares the subscription with the bot's copy again at its next checks`,
    ]);

    const afterFirst = [driver.bytes(), JSON.stringify(w.stored())];
    await w.tick();
    await w.settle();
    expect([driver.bytes(), JSON.stringify(w.stored())]).toEqual(afterFirst);
    expect(w.logged(`[DummyProvider] Subscription ${id} now matches the bot's copy`)).toEqual([]);

    await w.tick();
    await w.settle();
    expect(Date.parse(record(driver, id).endDate)).toBe(end + 30 * DAY_MS);
    expect(w.recordOf(user).active).toMatchObject({ providerSubId: id, status: 'active', endDate: record(driver, id).endDate });
    expect(w.logged('was not applied')).toHaveLength(1);
    expect(w.logged(`[DummyProvider] Subscription ${id} now matches the bot's copy`)).toHaveLength(1);

    await w.tick();
    await w.settle();
    expect([Date.parse(record(driver, id).endDate), Date.parse(w.recordOf(user).active.endDate)]).toEqual([end + 30 * DAY_MS, end + 30 * DAY_MS]);
  });
});
