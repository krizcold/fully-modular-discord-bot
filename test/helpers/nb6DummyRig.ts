import { vi } from 'vitest';
import { DummyProvider } from '../../src/bot/internalSetup/utils/payment/dummyProvider';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { runSharedPass } from '../../src/bot/internalSetup/utils/sharedMirror';
import { PREMIUM_KEY, type premiumRig } from './nb6PremiumRig';

// The Dummy provider on a Postgres bot (NB6 part 12): the real DummyProvider registered in the test's registry beside
// the real PremiumManager of premiumRig, over the same scripted shared tables. Its state.json is the shared key
// global/payment-providers/dummy/state.json. The tick is driven through start()'s interval with a fake setInterval;
// Date is faked with shouldAdvanceTime, so the time can jump while every bound still runs on real timers.

export const DUMMY_KEY = 'global/payment-providers/dummy/state.json';
export const MONTHLY = 'dummy_monthly_999';
export const YEARLY = 'dummy_yearly_9999';
export const DAY_MS = 86_400_000;
export const ELSEWHERE = 'another machine changed premium-tiers.json (or the Dummy state) at the same time';

const SEED: Record<string, object> = {
  [MONTHLY]: { variantId: MONTHLY, label: 'Monthly', amount: 999, currency: 'USD', durationDays: 30, recurring: true, active: true },
  [YEARLY]: { variantId: YEARLY, label: 'Yearly (save 16%)', amount: 9999, currency: 'USD', durationDays: 365, recurring: true, active: true },
};

/** A tier with one offering sold through the Dummy provider (its monthly and yearly variants). */
export const dummyTier = (name: string, priority: number, offeringId: string) => ({
  displayName: name,
  priority,
  overrides: {},
  offerings: [{
    id: offeringId,
    label: name,
    providerLinks: [{
      providerId: 'dummy',
      enabled: true,
      mode: 'price',
      priceConfig: { entries: [{ variantId: MONTHLY }, { variantId: YEARLY }] },
      cache: { syncedAt: '2026-01-01T00:00:00.000Z', variants: [SEED[MONTHLY], SEED[YEARLY]] },
    }],
  }],
});

export function dummyRig(r: ReturnType<typeof premiumRig>) {
  const made: DummyProvider[] = [];
  const rig = {
    dummy: null as unknown as DummyProvider,
    /** The rig's bot: tiers gold (2, offering o1) and silver (1, offering o2) sold through the Dummy, which is activated. */
    async setup(asBot = true): Promise<void> {
      await r.setup(asBot);
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], shouldAdvanceTime: true });
      rig.dummy = rig.make();
      getPaymentRegistry().register(rig.dummy);
      rig.dummy.start();
      const pm = r.pm();
      pm.setTier('gold', dummyTier('Gold', 2, 'o1') as any);
      pm.setTier('silver', dummyTier('Silver', 1, 'o2') as any);
      pm.setProviderActivation('dummy', true);
      await r.settle();
    },
    async teardown(): Promise<void> {
      for (const d of made.splice(0)) d.dispose();
      getPaymentRegistry().unregister('dummy');
      getPaymentRegistry().setSubscriptionReader(null);
      await r.teardown();
    },
    /** Another Dummy provider instance on the same store (another machine's, or the next process's). */
    make(): DummyProvider {
      const d = new DummyProvider();
      made.push(d);
      return d;
    },
    /** One minute passes: the tick runs, then every op it started and every op its effects started settles. */
    async tick(): Promise<void> {
      vi.advanceTimersByTime(60_000);
      await rig.settle();
    },
    async settle(): Promise<void> {
      for (let i = 0; i < 3; i++) {
        await r.settle();
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await r.settle();
    },
    /** The time jumps by `days`. */
    later(days: number): void {
      vi.setSystemTime(Date.now() + days * DAY_MS);
    },
    /** A purchase through premium (the Dummy's own purchase path), settled. */
    async buy(guild = 'g1', tierId = 'gold', offeringId = tierId === 'gold' ? 'o1' : 'o2', variantId = MONTHLY): Promise<any> {
      const result = await r.pm().initiatePaidSubscription(guild, tierId, offeringId, { providerId: 'dummy', variantId });
      await rig.settle();
      return result;
    },
    /** The stored state.json, parsed; null with no row. */
    stored(): any {
      const row = r.m.state.rows.docs.get(DUMMY_KEY);
      return row ? JSON.parse(row.body.toString('utf8')) : null;
    },
    record(id: string): any {
      return rig.stored()?.subscriptions?.[id] ?? null;
    },
    /** Another machine's write of state.json, changed by fn from the stored one, then this machine's pass. */
    async otherDummy(fn: (state: any) => void): Promise<void> {
      const state = rig.stored();
      fn(state);
      r.m.state.rows.put(DUMMY_KEY, JSON.stringify(state, null, 2));
      await runSharedPass();
    },
    /** Another machine's write of premium-tiers.json, changed by fn from the stored one; the pass only when `pass`. */
    async otherPremium(fn: (config: any) => void, pass = true): Promise<void> {
      const config = r.row();
      fn(config);
      r.m.state.rows.put(PREMIUM_KEY, JSON.stringify(config, null, 2));
      if (pass) await runSharedPass();
    },
    /** The writes of a key committed so far. */
    writes(key: string): number {
      return r.m.state.rows.history.filter(h => h.key === key).length;
    },
  };
  return rig;
}
