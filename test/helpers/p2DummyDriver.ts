import fs from 'fs';
import { vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import { flushAll } from '../../src/bot/internalSetup/utils/dataManager';
import { DummyProvider } from '../../src/bot/internalSetup/utils/payment/dummyProvider';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import type { premiumRig } from './nb6PremiumRig';
import type { SellerCall } from './p1Seller';
import { brokenHolders, brokenStacking, type DriverWorld, type SellerDriver, type SellerView } from './p1World';

// The real Dummy provider as P1's seller (sheet P2, section 5). Its state.json lives in the row's data folder, or on
// the mirror rig in the shared key. setInterval, clearInterval and Date are faked with shouldAdvanceTime, as
// nb6DummyRig.ts fakes them: Date keeps moving (atomicWrite's retry loop ends), the tick runs only when a row asks for
// it, and the clock jumps without running the timers in between. It takes no delivery and keeps no days left.

export const DUMMY_PATH = dataPath('global', 'payment-providers', 'dummy', 'state.json');
export const DUMMY_KEY = 'global/payment-providers/dummy/state.json';
export const DUMMY_VARIANT = 'dummy_monthly_999';
const DAY_MS = 86_400_000;
const MONTHLY = { variantId: DUMMY_VARIANT, label: 'Monthly', amount: 999, currency: 'USD', durationDays: 30, recurring: true, active: true };
/** The provider methods premium calls, recorded in order as the P1 seller records them. */
const CALLED = ['initiatePurchase', 'listSubscriptionsFor', 'pauseSubscription', 'resumeSubscription', 'cancelSubscription', 'reactivateSubscription', 'migrateSubscriptionPrice'] as const;

/** The holder of a stored Dummy record: the one reader of a record's owner for every P2 row. */
export const ownerOf = (record: any): string => record.holder;

export function dummyDriver(): SellerDriver & { provider(): DummyProvider; document(): any } {
  let rig: ReturnType<typeof premiumRig> | null = null;
  let provider: DummyProvider | null = null;
  const real = new Map<string, (...args: any[]) => any>();
  const calls: SellerCall[] = [];
  const live = (): DummyProvider => {
    if (!provider) throw new Error('dummyDriver: not attached');
    return provider;
  };
  const text = (): string | null => {
    if (rig) return rig.m.state.rows.docs.get(DUMMY_KEY)?.body.toString('utf8') ?? null;
    return fs.existsSync(DUMMY_PATH) ? fs.readFileSync(DUMMY_PATH, 'utf8') : null;
  };
  const state = (): any => {
    const raw = text();
    return raw === null ? null : JSON.parse(raw);
  };
  const ids = (): string[] => Object.keys(state()?.subscriptions ?? {});
  const view = (providerSubId: string): SellerView | null => {
    const record = state()?.subscriptions?.[providerSubId];
    return record ? { status: record.status, endDate: record.endDate ?? null, autoRenew: record.autoRenew } : null;
  };
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 4; i++) {
      if (rig) await rig.settle();
      else await flushAll();
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (rig) await rig.settle();
  };
  const tick = async (): Promise<void> => {
    vi.advanceTimersByTime(60_000);
    await settle();
  };

  return {
    name: 'dummy',
    id: 'dummy',
    variant: DUMMY_VARIANT,
    offering: (offeringId: string, label: string) => ({
      id: offeringId,
      label,
      providerLinks: [{
        providerId: 'dummy',
        enabled: true,
        mode: 'price',
        priceConfig: { entries: [{ variantId: DUMMY_VARIANT }] },
        cache: { syncedAt: '2026-01-01T00:00:00.000Z', variants: [MONTHLY] },
      }],
    }),
    async attach(onRig?: ReturnType<typeof premiumRig> | null): Promise<void> {
      rig = onRig ?? null;
      calls.length = 0;
      real.clear();
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], shouldAdvanceTime: true });
      const made = new DummyProvider();
      for (const method of CALLED) {
        const own = (made as any)[method].bind(made);
        real.set(method, own);
        (made as any)[method] = (...args: unknown[]) => {
          calls.push({ method, args });
          return own(...args);
        };
      }
      provider = made;
      getPaymentRegistry().register(made);
      made.start();
    },
    async detach(): Promise<void> {
      if (provider) {
        provider.dispose();
        getPaymentRegistry().unregister('dummy');
      }
      provider = null;
      vi.useRealTimers();
    },
    calls: () => calls,
    view,
    ids,
    bytes: () => text() ?? '',
    async unheld(world: DriverWorld, holder: string, tierId: string, opts: { paused?: boolean } = {}): Promise<string> {
      const before = new Set(ids());
      const bought = await world.purchase(holder, tierId);
      if (!bought.ok) throw new Error(`dummyDriver.unheld: the purchase of ${tierId} for ${holder} was refused: ${bought.error}`);
      const made = ids().filter(id => !before.has(id));
      if (made.length !== 1) throw new Error(`dummyDriver.unheld: the purchase made ${made.length} records`);
      const deleted = await world.deleteTier(tierId);
      if (!deleted.ok) throw new Error(`dummyDriver.unheld: deleteTier ${tierId} was refused: ${deleted.error}`);
      const remade = await world.remakeTier(tierId);
      if (!remade.ok) throw new Error(`dummyDriver.unheld: setTier ${tierId} was refused: ${remade.error}`);
      if (opts.paused && view(made[0])?.status !== 'paused') {
        // The pause premium makes when a higher purchase takes the slot, made with the Dummy's own method.
        await real.get('pauseSubscription')!(made[0], null);
        await world.settle();
      }
      return made[0];
    },
    async expire(world: DriverWorld, providerSubId: string): Promise<void> {
      const subscriptions = world.stored()?.subscriptions ?? {};
      const holder = Object.keys(subscriptions).find(key => subscriptions[key]?.active?.providerSubId === providerSubId);
      if (!holder) throw new Error(`dummyDriver.expire: premium holds no active ${providerSubId}`);
      if (view(providerSubId)?.autoRenew) {
        const cancelled = await world.op('cancelPaidSubscription', holder);
        if (!cancelled.ok) throw new Error(`dummyDriver.expire: the cancel at period end of ${providerSubId} was refused: ${cancelled.error}`);
      }
      const end = view(providerSubId)?.endDate ?? null;
      if (end === null) throw new Error(`dummyDriver.expire: ${providerSubId} has no end date`);
      if (Date.parse(end) >= Date.now()) vi.setSystemTime(Date.parse(end) + 1_000);
      await tick();
      await world.settle();
      if (view(providerSubId)?.status !== 'expired') throw new Error(`dummyDriver.expire: ${providerSubId} is ${JSON.stringify(view(providerSubId))} after the tick`);
    },
    delivers: false,
    keepsDaysLeft: false,
    advance(days: number): void {
      vi.setSystemTime(Date.now() + days * DAY_MS);
    },
    tick,
    provider: live,
    /** The stored state.json, parsed; null with none. */
    document: state,
  };
}

/** Premium's subscriptions from the Dummy, each with its holder. */
export function heldByPremium(doc: any): Array<{ holder: string; sub: any }> {
  const out: Array<{ holder: string; sub: any }> = [];
  for (const [key, record] of Object.entries<any>(doc?.subscriptions ?? {})) {
    for (const sub of [...(record.active ? [record.active] : []), ...(record.paused ?? [])]) {
      if (sub.providerId === 'dummy') out.push({ holder: key, sub });
    }
  }
  return out;
}

export const VIEW_FIELDS = ['status', 'endDate', 'autoRenew', 'variantId', 'resumesAt'] as const;

/** Decision 94's view of a record (dummyProvider.ts viewOf). */
export const recordView = (r: any) => ({
  status: r.paused ? 'paused' : r.status,
  endDate: r.endDate,
  autoRenew: r.autoRenew,
  variantId: r.variantId,
  resumesAt: r.paused ? (r.resumesAt ?? null) : null,
});

/** The fields of a record's view that differ from premium's answer for it (none when premium answers nothing). */
export function viewDiffers(holder: string, providerSubId: string, record: any): string[] {
  const answer: any = getPaymentRegistry().readSubscription('dummy', holder as any, providerSubId);
  if (!answer) return [];
  const view: any = recordView(record);
  return VIEW_FIELDS.filter(field => answer[field] !== undefined && view[field] !== answer[field]).map(field => `${field} ${view[field]} at the Dummy and ${answer[field]} in premium`);
}

/**
 * What premium's stored document and the Dummy's state break of A1 to A4 (sheet P2, claim 11) and P1's K1 to K4 and
 * N1 to N3; `settledTwice` checks A2 as well. `listers` are the holders whose lists A4 reads.
 */
export async function brokenAgreement(stored: any, driver: ReturnType<typeof dummyDriver>, state: any, settledTwice: boolean, listers: readonly string[]): Promise<string[]> {
  const broken: string[] = [];
  const records: Record<string, any> = state?.subscriptions ?? {};
  const held = heldByPremium(stored);
  for (const { holder: key, sub } of held) {
    const record = records[sub.providerSubId];
    if (!record) {
      broken.push(`A1: ${key} holds ${sub.providerSubId}, which the Dummy has no record of`);
      continue;
    }
    if (ownerOf(record) !== key) broken.push(`A1: ${key} holds ${sub.providerSubId}, whose Dummy record belongs to ${ownerOf(record)}`);
    if (record.buyerId !== sub.buyerId) broken.push(`A1: ${key} holds ${sub.providerSubId} paid by ${sub.buyerId}; the Dummy record names ${record.buyerId}`);
    if (settledTwice) for (const differs of viewDiffers(key, sub.providerSubId, record)) broken.push(`A2: ${sub.providerSubId} has ${differs} after two ticks`);
  }
  const holders = new Map<string, string>();
  for (const { holder: key, sub } of held) {
    const first = holders.get(sub.providerSubId);
    if (first !== undefined && first !== key) broken.push(`A3: ${sub.providerSubId} is held by ${first} and ${key}`);
    holders.set(sub.providerSubId, key);
  }
  for (const [id, record] of Object.entries<any>(records)) if (record.providerSubId !== id) broken.push(`A3: the record under ${id} is ${record.providerSubId}`);
  const lists = new Map<string, string[]>();
  for (const key of listers) lists.set(key, (await driver.provider().listSubscriptionsFor!(key as any)).map(ref => ref.providerSubId));
  for (const [id, record] of Object.entries<any>(records)) {
    if (record.status !== 'active' && record.status !== 'paused') continue;
    const owner = ownerOf(record);
    if (holders.get(id) !== owner && !(lists.get(owner) ?? []).includes(id)) broken.push(`A4: the live record ${id} of ${owner} is neither held by premium under it nor listed for it`);
    for (const [key, listed] of lists) if (key !== owner && listed.includes(id)) broken.push(`A4: the record ${id} of ${owner} is listed for ${key}`);
  }
  broken.push(...brokenStacking(stored), ...brokenHolders(stored));
  return broken;
}
