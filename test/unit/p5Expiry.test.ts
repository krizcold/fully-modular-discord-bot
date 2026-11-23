import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P5 claim 9 (sheet P5, Revision 9, Z8's checker branch): premium's expiry checker frees the slot of a PayPal
// subscription (a provider declaring `endsAtPaidEnd`) whose end has passed and whose id is not in flight, with one
// paid.sub.expired notice, and resumes the queue; it leaves every other provider's paid subscription to its events.
// Purchases go through the real checkout, approved by the fake; premium's copy comes from delivered events; both
// backends. The Stripe row runs in P3's world (helpers/p3World.ts); the disk row on the JSON files.

vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => (await import('../helpers/p1Mocks')).bareRegistry(await orig<any>()));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', async () => (await import('../helpers/p1Mocks')).noticeModule());

import { dataPath } from '../../src/utils/dataRoot';
import { getPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { failFlushes } from '../helpers/configRig';
import { z5End } from '../helpers/p5Model';
import { heldPayPal, IDS, p5World, planId, TIERS, type Delivered } from '../helpers/p5World';
import { onceEnd } from '../helpers/p5Model';
import { FakeRefusal } from '../helpers/p5PayPal';
import { FINAL_CYCLES, onceKit } from '../helpers/p5pOnce';
import { heldStripe, IDS as P3_IDS, p3World } from '../helpers/p3World';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const T0 = Date.UTC(2027, 0, 31, 12);
const HOLDER = `guild:${IDS[0]}`;
const BUYER = IDS[0];

describe.each([['the JSON files', 'json' as const], ['the mirror rig', 'rig' as const]])('P5 claim 9 on %s: the checker frees a PayPal slot at its end', (_name, backend) => {
  const w = p5World(backend);
  beforeEach(async () => { await w.setup({ clock: T0 }); });
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  const premium = (): any => getPremiumManager();
  const drain = async (): Promise<Delivered[]> => {
    const outs = await w.drain();
    await w.settle();
    outs.push(...await w.drain());
    return outs;
  };
  async function owned(level: 'low' | 'high' = 'low'): Promise<string> {
    const tierId = TIERS.guild[level];
    const reply = await w.buyMember(HOLDER, BUYER, { tierId, plan: planId(tierId, 'cheap') });
    if (!reply.subscriptionId) throw new Error(`the purchase made no subscription: ${JSON.stringify(reply.body)}`);
    w.fake.approve(reply.subscriptionId);
    await drain();
    return reply.subscriptionId;
  }
  const heldOf = (id: string) => heldPayPal(w.stored()).find(h => h.sub.providerSubId === id) ?? null;
  const ended = () => w.notices().filter(n => n.kind === 'paid.sub.expired');
  const endLines = () => w.auditLines().filter(l => l.action === 'subscription.expire.paid');
  const endOf = (id: string): number => Date.parse(heldOf(id)!.sub.endDate);
  const toJust = (at: number, offset: number): void => w.later(at + offset - Date.now());

  it.each([['auto-renew on', false], ['auto-renew off', true]])('past its end, with %s: it leaves the slot with one notice and the queued entry resumes', async (_label, cancelled) => {
    const high = await owned('high');
    const low = await owned('low');
    expect([heldOf(high)?.location, heldOf(low)?.location]).toEqual(['active', 'paused']);
    if (cancelled) {
      w.fake.buyerCancel(high);
      await drain();
      expect(heldOf(high)!.sub).toMatchObject({ status: 'active', autoRenew: false });
    }
    const end = endOf(high);
    toJust(end, -HOUR);
    await w.tick();
    expect([heldOf(high)?.location, ended()]).toEqual(['active', []]);
    toJust(end, HOUR);
    await w.tick();
    expect(heldOf(high)).toBeNull();
    expect(heldOf(low)?.location).toBe('active');
    expect(ended()).toEqual([{ to: HOLDER, kind: 'paid.sub.expired' }]);
    expect(endLines().map(l => l.providerId)).toEqual(['paypal']);
    await w.tick();
    expect([ended().length, endLines().length]).toEqual([1, 1]);
  });

  it('a renewal delivered before the end keeps it with no notice; one delivered after the checker freed it installs it again', async () => {
    const id = await owned();
    const first = endOf(id);
    toJust(first, -2 * DAY);
    w.fake.renew(id, { at: Date.now() });
    await drain();
    expect(endOf(id)).toBe(z5End(w.fake, id).end);
    toJust(first, HOUR);
    await w.tick();
    expect([heldOf(id)?.location, ended()]).toEqual(['active', []]);
    const second = endOf(id);
    toJust(second, HOUR);
    await w.tick();
    expect(heldOf(id)).toBeNull();
    expect(ended()).toHaveLength(1);
    w.fake.renew(id, { at: Date.now() });
    await drain();
    expect(heldOf(id)).toMatchObject({ location: 'active', sub: { status: 'active' } });
    expect(endOf(id)).toBe(z5End(w.fake, id).end);
    expect(endOf(id)).toBeGreaterThan(Date.now());
  });

  it('a renewal in flight when the end passes: the checker does not free the slot, and after it lands premium holds the new end', async () => {
    const id = await owned();
    const end = endOf(id);
    toJust(end, -HOUR);
    const pm = premium();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const realInstall = pm.installAsyncSubscription.bind(pm);
    const reached: string[] = [];
    vi.spyOn(pm, 'installAsyncSubscription').mockImplementation(async (event: any) => {
      reached.push(event.providerSubId);
      await gate;
      return realInstall(event);
    });
    const registry: any = (await import('../../src/bot/internalSetup/utils/payment/paymentRegistry')).getPaymentRegistry();
    const view = heldOf(id)!.sub;
    registry.emitEvent({ type: 'subscription.created', providerId: 'paypal', providerSubId: id, holder: HOLDER, buyerId: BUYER, tierId: view.tierId, offeringId: view.offeringId, variantId: view.variantId, state: { status: 'active', startDate: view.startDate, endDate: view.endDate, autoRenew: true, meta: view.providerMeta } });
    expect(reached).toEqual([id]);
    w.fake.renew(id, { at: Date.now() });
    const renewal = w.drain();
    toJust(end, HOUR);
    (getPremiumManager() as any).checkExpiry();
    expect(premium().config.subscriptions[HOLDER]?.active?.providerSubId).toBe(id);
    release();
    await renewal;
    await drain();
    expect(heldOf(id)).toMatchObject({ location: 'active', sub: { status: 'active' } });
    expect(endOf(id)).toBe(z5End(w.fake, id).end);
    expect(endOf(id)).toBeGreaterThan(Date.now());
    await w.tick();
    expect([heldOf(id)?.location, ended()]).toEqual(['active', []]);
  });

  it('a failing subscription PayPal never suspends leaves the slot when its windowed end passes', async () => {
    const id = await owned();
    w.later(33 * DAY);
    w.fake.failPayment(id, { count: 0 });
    await drain();
    const model = z5End(w.fake, id);
    expect(model.windowApplies).toBe(true);
    expect(endOf(id)).toBe(model.end);
    toJust(model.end!, -HOUR);
    await w.tick();
    expect(heldOf(id)?.location).toBe('active');
    toJust(model.end!, HOUR);
    await w.tick();
    expect(heldOf(id)).toBeNull();
    expect(ended()).toHaveLength(1);
  });

  it('a resumed entry whose activate the fake refuses is freed at its resumed end', async () => {
    const low = await owned('low');
    const high = await owned('high');
    w.fake.fail('POST', /\/activate$/, { status: 422, issue: 'SUBSCRIPTION_STATUS_INVALID' });
    w.later(5 * DAY);
    w.fake.expire(high);
    await drain();
    expect(heldOf(low)).toMatchObject({ location: 'active', sub: { providerMeta: { paypalStatus: 'SUSPENDED' } } });
    const end = endOf(low);
    toJust(end, -HOUR);
    await w.tick();
    expect(heldOf(low)?.location).toBe('active');
    const before = ended().length;
    toJust(end, HOUR);
    await w.tick();
    expect(heldOf(low)).toBeNull();
    expect(ended().length).toBe(before + 1);
  });

  if (backend === 'json') {
    it('the disk refusing writes: the cache holds it ended at once, the file after the folder takes writes; one notice, no second end', async () => {
      const id = await owned();
      const end = endOf(id);
      toJust(end, HOUR);
      const undo = failFlushes(dataPath('global', 'premium-tiers.json'));
      try {
        await w.tick();
        expect(premium().config.subscriptions[HOLDER]?.active ?? null).toBeNull();
        expect(heldOf(id)?.location).toBe('active');
        await w.tick();
      } finally {
        undo();
      }
      await w.settle();
      await w.tick();
      expect(heldOf(id)).toBeNull();
      expect(ended()).toHaveLength(1);
      expect(endLines()).toHaveLength(1);
    });
  }
});

describe.each([['the JSON files', 'json' as const], ['the mirror rig', 'rig' as const]])('P5 claim 9 on %s: a Stripe subscription past its end is left to its events', (_name, backend) => {
  const w = p3World(backend);
  beforeEach(async () => {
    for (const level of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
    await w.setup();
  });
  afterEach(async () => {
    await w.teardown();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('the checker leaves it in the slot, with no notice', async () => {
    const holder = `guild:${P3_IDS[0]}`;
    const bought = await w.buyMember(holder, P3_IDS[1]);
    w.fake.complete(bought.sessionId!, { paid: true });
    await w.drain();
    const held = heldStripe(w.stored()).find(h => h.holder === holder)!;
    expect(held.location).toBe('active');
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(Date.parse(held.sub.endDate) + DAY);
    (getPremiumManager() as any).checkExpiry();
    await w.settle();
    expect(heldStripe(w.stored()).find(h => h.holder === holder)).toMatchObject({ location: 'active', sub: { status: 'active' } });
    expect(w.notices().filter(n => n.kind === 'paid.sub.expired')).toEqual([]);
  });
});

describe.each([['the JSON files', 'json' as const], ['the mirror rig', 'rig' as const]])('P5P Q4 on %s: the checker frees a pay-once subscription at onceEnd(T) [R1]', (_name, backend) => {
  const w = p5World(backend);
  const o = onceKit(w);
  beforeEach(async () => { await w.setup({ clock: T0 }); });
  afterEach(async () => {
    await w.teardown();
    vi.restoreAllMocks();
  });

  it.each(FINAL_CYCLES)('under %s: held until onceEnd(T) and freed at it with one notice, the queued entry resuming; the renew at its due date is refused', async final => {
    const id = await o.owned('guild', { level: 'high', settings: { finalCycle: final } });
    const low = await o.owned('guild', { renewing: true });
    expect([o.heldOf(id)?.location, o.heldOf(low)?.location]).toEqual(['active', 'paused']);
    const end = o.endOf(id);
    expect(end).toBe(onceEnd(w.fake, id));
    const ended = () => w.notices().filter(n => n.kind === 'paid.sub.expired');
    w.later(end - Date.now() - HOUR);
    await w.tick();
    expect([o.heldOf(id)?.location, ended()]).toEqual(['active', []]);
    const sub = w.fake.subscriptions.get(id)!;
    expect(() => w.fake.renew(id, { at: w.fake.dueOf(sub, 1) })).toThrow(FakeRefusal);
    w.later(2 * HOUR);
    await w.tick();
    expect(o.heldOf(id)).toBeNull();
    expect(o.heldOf(low)?.location).toBe('active');
    expect(ended()).toEqual([{ to: HOLDER, kind: 'paid.sub.expired' }]);
  });
});
