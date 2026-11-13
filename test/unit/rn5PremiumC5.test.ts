import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// L5 run A survivors, chunk 5 (premiumManager.ts): the tier-change notices, a deleted tier's queue, the audit lines of
// the admin changes, stacking into the queue and into the active slot, a failed install's items, a provider resume
// that fails, and the answers of cancel and reactivate when another change removed the subscription meanwhile.

const inject = vi.hoisted(() => ({ refuse: new Set<string>() }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  return {
    ...real,
    saveDataTracked: (f: string, o: any, d: unknown) => {
      if (inject.refuse.has(f)) throw new real.DataBackendUnavailableError('storage-failing' as any);
      return real.saveDataTracked(f, o, d);
    },
  };
});
const reg = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  return { ...real, getPaymentRegistry: () => (reg.current ??= new real.PaymentProviderRegistry()) };
});
const notices = vi.hoisted(() => ({ sent: [] as Array<{ guildId: string; kind: string; payload: any }> }));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async (guildId: string, kind: string, payload: any) => {
    notices.sent.push({ guildId, kind, payload });
    return { delivered: true, via: 'dm' };
  },
}));

import { getPremiumManager, resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { openItemsOf } from '../../src/bot/internalSetup/utils/premiumItems';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import type { PaymentProvider } from '../../src/bot/internalSetup/utils/payment/paymentTypes';
import { AUDIT, clearGlobal, jsonOf, linesOf, paidSub, PREMIUM, quiet, settleQueue, tick, TIERS, writePremium } from './nb10PremiumRig';

const G = 'g1';
const DAY = 86_400_000;

type Behaviour = {
  purchase?: () => Record<string, unknown> | undefined;
  cancel?: () => Promise<unknown>;
  reactivate?: () => Promise<unknown>;
  resume?: () => Promise<unknown>;
};
let pauses: string[] = [];

function provider(id: string, how: Behaviour = {}): PaymentProvider {
  return {
    id,
    displayName: `Pay ${id}`,
    isConfigured: () => true,
    capabilities: { canInitiatePurchase: true, supportsCancel: true, supportsReactivate: true, supportsCoupons: false, supportsPause: true },
    cancelSubscription: async () => (how.cancel ? how.cancel() : undefined),
    reactivateSubscription: async () => (how.reactivate ? how.reactivate() : undefined),
    pauseSubscription: async (providerSubId: string) => { pauses.push(providerSubId); },
    resumeSubscription: (how.resume ?? (async () => undefined)) as any,
    initiatePurchase: async () => ({
      providerSubId: 'ps-new',
      state: how.purchase ? how.purchase() : { status: 'active', startDate: new Date().toISOString(), endDate: new Date(Date.now() + 30 * DAY).toISOString(), autoRenew: false },
    }),
  } as unknown as PaymentProvider;
}

const manualSub = (id: string, tierId: string, extra: Record<string, unknown> = {}) => {
  const sub: any = { ...paidSub(id, 'unused', tierId), source: 'manual', ...extra };
  delete sub.providerSubId;
  delete sub.providerId;
  return sub;
};

const link = (providerId: string) => ({ providerId, enabled: true, mode: 'price', priceConfig: { entries: [{ variantId: 'v1' }] } });
const buyable = (...providerIds: string[]) => ({
  tiers: {
    ...TIERS,
    low: { ...TIERS.low, offerings: [{ id: 'o1', label: 'Low', providerLinks: providerIds.map(link) }] },
  },
  activatedProviders: Object.fromEntries(providerIds.map(p => [p, { defaultEnabled: false }])),
});

const m = () => getPremiumManager();
const audit = async () => { await settleQueue(); return linesOf(AUDIT); };
const stored = async () => { await settleQueue(); return jsonOf(PREMIUM); };
const noticesOf = (kind: string) => notices.sent.filter(n => n.kind === kind);

async function until(cond: () => boolean, ms = 1000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) return false;
    await tick(2);
  }
  return true;
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  ({ warn } = quiet());
  vi.stubEnv('BOT_PROCESS_ROLE', 'webui');
  inject.refuse.clear();
  await settleQueue();
  resetPremiumManager();
  reg.current = null;
  notices.sent = [];
  pauses = [];
  clearGlobal();
});
afterEach(async () => {
  vi.restoreAllMocks();
  inject.refuse.clear();
  resetPremiumManager();
  reg.current = null;
  await settleQueue();
  vi.unstubAllEnvs();
});

describe('a tier made stricter', () => {
  it('tells the guilds whose active or paused subscription is on that tier, and no other guild', async () => {
    const tiers = {
      free: TIERS.free,
      low: { displayName: 'Low', priority: 1, overrides: { mod: { x: 5 } }, offerings: [] },
      mid: { displayName: 'Mid', priority: 2, overrides: {}, offerings: [] },
      high: { displayName: 'High', priority: 3, overrides: {}, offerings: [] },
    };
    writePremium({
      gA: { active: manualSub('a1', 'low'), paused: [] },
      gB: { active: manualSub('b1', 'high'), paused: [manualSub('b2', 'mid', { status: 'paused', remainingDaysAtPause: 5 })] },
      gC: { active: manualSub('c1', 'high'), paused: [manualSub('c2', 'low', { status: 'paused', remainingDaysAtPause: 5 })] },
    }, { tiers });
    expect(m().setTier('low', { displayName: 'Low', priority: 1, overrides: {}, offerings: [] } as any)).toBe(true);
    await settleQueue();
    expect(noticesOf('tier.config-change-affecting-subscriber').map(n => n.guildId).sort()).toEqual(['gA', 'gC']);
  });
});

describe('deleting a tier', () => {
  it('resumes the paused subscription behind the deleted active one, and the audit line names the admin', async () => {
    writePremium({ [G]: { active: manualSub('mh', 'high'), paused: [manualSub('ml', 'low', { status: 'paused', remainingDaysAtPause: 5 })] } });
    expect(m().deleteTier('high')).toBe(true);
    const subs = (await stored()).subscriptions[G];
    expect(subs.active?.id).toBe('ml');
    expect(subs.active?.status).toBe('active');
    expect(subs.paused).toEqual([]);
    const line = (await audit()).find(l => l.action === 'tier.delete');
    expect(line?.actor).toBe('admin');
  });
});

describe('activating a provider', () => {
  it('answers true when saved, and the audit line names the admin', async () => {
    writePremium();
    expect(m().setProviderActivation('fake', true)).toBe(true);
    expect((await stored()).activatedProviders.fake).toEqual({ defaultEnabled: false });
    const line = (await audit()).find(l => l.action === 'provider.activation.set');
    expect(line?.actor).toBe('admin');
  });
});

describe('extending a manual subscription', () => {
  it('answers true, and the audit line names the admin with the days added and the end dates before and after', async () => {
    const sub = manualSub('m1', 'low');
    writePremium({ [G]: { active: sub, paused: [] } });
    expect(m().extendManual(G, 5)).toBe(true);
    const after = (await stored()).subscriptions[G].active.endDate;
    expect(Date.parse(after) - Date.parse(sub.endDate)).toBe(5 * DAY);
    const line = (await audit()).find(l => l.action === 'subscription.extend.manual');
    expect(line?.actor).toBe('admin');
    expect(line?.metadata).toEqual({ addDays: 5, before: sub.endDate, after });
  });
});

describe('stacking a manual grant over a lower active one', () => {
  it('does not send the paid paused-by-stacking notice for a manual subscription', async () => {
    writePremium({ [G]: { active: manualSub('ml', 'low'), paused: [] } });
    expect(await m().grantManual(G, 'high', 10)).toBe(true);
    const subs = (await stored()).subscriptions[G];
    expect(subs.paused.map((p: any) => p.id)).toEqual(['ml']);
    expect(noticesOf('paid.sub.paused-by-stacking')).toEqual([]);
  });

  it('keeps the grant audit line and notice when the active one ran out between the check and the pause', async () => {
    const real = Date.now();
    let clock = real;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    writePremium({ [G]: { active: manualSub('ml', 'low', { endDate: new Date(real + 60_000).toISOString() }), paused: [] } });
    const low = (m() as any).config.tiers.low;
    Object.defineProperty(low, 'priority', { enumerable: true, configurable: true, get: () => { clock += 120_000; return 1; } });
    expect(await m().grantManual(G, 'high', 10)).toBe(true);
    const subs = (await stored()).subscriptions[G];
    expect(subs.active.tierId).toBe('high');
    expect(subs.paused).toEqual([]);
    const actions = (await audit()).map(l => l.action);
    expect(actions).toContain('subscription.grant.manual');
    expect(actions).not.toContain('subscription.pause');
    expect(noticesOf('manual.grant.added')).toHaveLength(1);
    expect(openItemsOf(m())).toEqual([]);
  });
});

describe('a grant whose install throws', () => {
  it('rejects, and leaves none of its items open', async () => {
    writePremium({ [G]: { active: manualSub('mh', 'high'), paused: [] } });
    (m() as any).config.subscriptions[G].paused = Object.freeze([]);
    await expect(m().grantManual(G, 'low', 10)).rejects.toThrow(TypeError);
    expect(openItemsOf(m())).toEqual([]);
    expect((await audit()).map(l => l.action)).not.toContain('subscription.grant.manual');
    expect(noticesOf('manual.grant.added')).toEqual([]);
  });
});

describe('a paid purchase', () => {
  it('bought into the queue is not paused again at the provider', async () => {
    writePremium({ [G]: { active: manualSub('mh', 'high'), paused: [] } }, buyable('fake'));
    getPaymentRegistry().register(provider('fake'));
    await m().initiatePaidSubscription(G, 'low', 'o1', { providerId: 'fake', variantId: 'v1' });
    const subs = (await stored()).subscriptions[G];
    expect(subs.paused.map((p: any) => p.providerSubId)).toEqual(['ps-new']);
    expect(pauses).toEqual([]);
  });

  it('at the same priority as an active manual grant rejects, and leaves none of its items open', async () => {
    writePremium({ [G]: { active: manualSub('ml', 'low'), paused: [] } }, buyable('fake'));
    getPaymentRegistry().register(provider('fake'));
    await expect(m().initiatePaidSubscription(G, 'low', 'o1', { providerId: 'fake', variantId: 'v1' })).rejects.toThrow("You already have a 'Low' subscription");
    expect(openItemsOf(m())).toEqual([]);
    expect((await stored()).subscriptions[G].active.id).toBe('ml');
  });

  it("from another provider that is paused takes the active slot as the provider gave it", async () => {
    const startDate = new Date(Date.now() - 5 * DAY).toISOString();
    const endDate = new Date(Date.now() + 10 * DAY).toISOString();
    writePremium({}, buyable('fake'));
    getPaymentRegistry().register(provider('fake', { purchase: () => ({ status: 'paused', startDate, endDate, autoRenew: false }) }));
    await m().initiatePaidSubscription(G, 'low', 'o1', { providerId: 'fake', variantId: 'v1' });
    const active = (await stored()).subscriptions[G].active;
    expect(active.status).toBe('paused');
    expect(active.startDate).toBe(startDate);
    expect(active.endDate).toBe(endDate);
  });

  it('from the Dummy that is active takes the active slot as the provider gave it', async () => {
    const startDate = new Date(Date.now() - 5 * DAY).toISOString();
    const endDate = new Date(Date.now() + 10 * DAY + 12 * 3_600_000).toISOString();
    writePremium({}, buyable('dummy'));
    getPaymentRegistry().register(provider('dummy', { purchase: () => ({ status: 'active', startDate, endDate, autoRenew: false }) }));
    await m().initiatePaidSubscription(G, 'low', 'o1', { providerId: 'dummy', variantId: 'v1' });
    const active = (await stored()).subscriptions[G].active;
    expect(active.status).toBe('active');
    expect(active.startDate).toBe(startDate);
    expect(active.endDate).toBe(endDate);
  });

  it('from the Dummy that is paused goes in active from now, with the days it had left', async () => {
    const t0 = Date.now();
    const startDate = new Date(t0 - 5 * DAY).toISOString();
    writePremium({}, buyable('dummy'));
    getPaymentRegistry().register(provider('dummy', { purchase: () => ({ status: 'paused', startDate, endDate: new Date(t0 + 10 * DAY).toISOString(), autoRenew: false }) }));
    await m().initiatePaidSubscription(G, 'low', 'o1', { providerId: 'dummy', variantId: 'v1' });
    const active = (await stored()).subscriptions[G].active;
    expect(active.status).toBe('active');
    expect(Date.parse(active.startDate)).toBeGreaterThanOrEqual(t0);
    expect(Math.abs(Date.parse(active.endDate) - (t0 + 10 * DAY))).toBeLessThan(60_000);
  });
});

describe('a provider resume that rejects with no error object', () => {
  it('logs that the resume failed, naming the provider', async () => {
    writePremium({ [G]: { active: manualSub('mh', 'high'), paused: [{ ...paidSub('p1', 'ps1', 'low'), status: 'paused', remainingDaysAtPause: 5 }] } });
    getPaymentRegistry().register(provider('fake', { resume: () => Promise.reject(null) }));
    expect(m().revokeManual(G)).toBe(true);
    const text = "[PremiumManager] provider resumeSubscription failed for 'fake': null";
    expect(await until(() => warn.mock.calls.some((c: unknown[]) => String(c[0]) === text))).toBe(true);
    expect((await stored()).subscriptions[G].active.id).toBe('p1');
  });
});

describe('cancel and reactivate when another change removed the subscription during the provider call', () => {
  const state = () => ({ status: 'active', startDate: new Date().toISOString(), endDate: new Date(Date.now() + 30 * DAY).toISOString(), autoRenew: false });
  const removeMeanwhile = (refuse: boolean) => async () => {
    expect(m().deleteTier('low')).toBe(true);
    if (refuse) inject.refuse.add('premium-tiers.json');
    return state();
  };

  for (const what of ['cancel', 'reactivate'] as const) {
    const call = () => (what === 'cancel' ? m().cancelPaidSubscription(G) : m().reactivatePaidSubscription(G));

    it(`${what} answers true when the removal is saved`, async () => {
      writePremium({ [G]: { active: paidSub('p1', 'ps1', 'low'), paused: [] } });
      getPaymentRegistry().register(provider('fake', { [what]: removeMeanwhile(false) }));
      expect(await call()).toBe(true);
      expect((await stored()).subscriptions[G]).toBeUndefined();
    });

    it(`${what} answers false when the removal's save is refused`, async () => {
      writePremium({ [G]: { active: paidSub('p1', 'ps1', 'low'), paused: [] } });
      getPaymentRegistry().register(provider('fake', { [what]: removeMeanwhile(true) }));
      expect(await call()).toBe(false);
    });
  }

  it('reactivate answers true when the provider returns no state, and writes its audit line', async () => {
    writePremium({ [G]: { active: paidSub('p1', 'ps1', 'low'), paused: [] } });
    getPaymentRegistry().register(provider('fake'));
    expect(await m().reactivatePaidSubscription(G)).toBe(true);
    expect((await audit()).map(l => l.action)).toContain('subscription.reactivate.paid');
    expect(fs.existsSync(PREMIUM)).toBe(true);
  });
});
