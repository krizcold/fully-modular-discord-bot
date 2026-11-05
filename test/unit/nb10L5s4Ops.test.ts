import fs from 'fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 mutation gate, chunk 4 of premiumManager.ts: the entry refusal of each premium change while
// premium-tiers.json cannot be read, the global config save's cleanup text, the member notices' payloads, a due
// migration that finds its subscription again by id, and a stacking pause of a subscription with no day left.

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
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { clearGlobal, gate, jsonOf, logged, paidSub, PREMIUM, quiet, rawOf, settleQueue, TIERS, tick, writePremium } from './nb10PremiumRig';

const role = process.env.BOT_PROCESS_ROLE;
const DAY = 86_400_000;

function registerFake(extra: Record<string, unknown> = {}): void {
  getPaymentRegistry().register({
    id: 'fake', displayName: 'Fake', capabilities: {}, isConfigured: () => true, ...extra,
  } as any);
}

const manual = (id: string, tierId: string, days: number | null = 30) => ({
  id, tierId, source: 'manual', status: 'active', autoRenew: false,
  startDate: new Date().toISOString(), endDate: days === null ? null : new Date(Date.now() + days * DAY).toISOString(),
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
});
const queued = (sub: Record<string, unknown>, remainingDaysAtPause: number) => ({ ...sub, status: 'paused', remainingDaysAtPause });
const noticesOf = (kind: string) => notices.sent.filter(n => n.kind === kind);

let spies: ReturnType<typeof quiet>;
beforeEach(async () => {
  spies = quiet();
  process.env.BOT_PROCESS_ROLE = 'bot';
  resetPremiumManager();
  reg.current = null;
  await settleQueue();
  clearGlobal();
  notices.sent = [];
  registerFake();
});
afterEach(async () => {
  resetPremiumManager();
  reg.current = null;
  await settleQueue();
  vi.restoreAllMocks();
});
afterAll(() => {
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe('while premium-tiers.json cannot be read, each change is refused before it touches the cache', () => {
  beforeEach(() => {
    fs.writeFileSync(PREMIUM, '{ broken');
    expect(getPremiumManager().cacheState()).toBe('unreadable');
  });

  it('setTier answers false and the cache holds no new tier', () => {
    const pm = getPremiumManager();
    expect(pm.setTier('low', { displayName: 'Low', priority: 1, overrides: {}, offerings: [] })).toBe(false);
    expect(pm.getTier('low')).toBeNull();
    expect(rawOf(PREMIUM)).toBe('{ broken');
  });

  it('deleteTier answers false', () => {
    expect(getPremiumManager().deleteTier('low')).toBe(false);
  });

  it('setProviderActivation answers false and the cache keeps the provider inactive', () => {
    const pm = getPremiumManager();
    expect(pm.setProviderActivation('fake', true)).toBe(false);
    expect(pm.getFullConfig().activatedProviders.fake).toBeUndefined();
    expect(pm.setProviderActivation('fake', true)).toBe(false);
  });

  it('extendManual and revokeManual answer false', () => {
    const pm = getPremiumManager();
    expect(pm.extendManual('g1', 5)).toBe(false);
    expect(pm.revokeManual('g1')).toBe(false);
  });

  it('a saved global config says the paid tier cleanup did not save, and answers saved', () => {
    const pm = getPremiumManager();
    expect(pm.setGlobalModuleConfig('nb10mod', { values: { a: 1 } } as any)).toBe(true);
    expect(logged(spies.error)).toContain('[PremiumManager] Global config for nb10mod saved, but the paid tier cleanup did not save');
  });
});

describe('member notices carry the tier and its details', () => {
  it('a stricter tier tells its subscribers what changed', async () => {
    writePremium({ g1: { active: paidSub('s1', 'p1', 'low', 'fake'), paused: [] } },
      { tiers: { ...TIERS, low: { ...TIERS.low, overrides: { nb10mod: { x: 1 } } } } });
    const pm = getPremiumManager();
    expect(pm.setTier('low', { displayName: 'Low', priority: 1, overrides: {}, offerings: [] })).toBe(true);
    await tick();
    expect(noticesOf('tier.config-change-affecting-subscriber')).toEqual([{
      guildId: 'g1', kind: 'tier.config-change-affecting-subscriber',
      payload: { tierName: 'Low', details: 'Some perks or limits were reduced. Open the subscription panel to see the latest tier contents.' },
    }]);
  });

  it('a paid subscription paused by a higher grant is named by its tier, with its days left', async () => {
    writePremium({ g1: { active: paidSub('s1', 'p1', 'low', 'fake'), paused: [] } });
    expect(await getPremiumManager().grantManual('g1', 'high', null)).toBe(true);
    await tick();
    expect(noticesOf('paid.sub.paused-by-stacking').map(n => n.payload)).toEqual([{ tierName: 'Low', providerName: 'Fake', remainingDays: 30 }]);
  });

  it('a paused paid subscription whose tier is gone is named by its tier id', async () => {
    writePremium({ g1: { active: paidSub('s1', 'p1', 'ghost', 'fake'), paused: [] } });
    expect(await getPremiumManager().grantManual('g1', 'high', null)).toBe(true);
    await tick();
    expect(noticesOf('paid.sub.paused-by-stacking').map(n => n.payload.tierName)).toEqual(['ghost']);
  });

  it('a grant tells the guild its tier, end date and notes', async () => {
    writePremium({});
    expect(await getPremiumManager().grantManual('g2', 'high', 10, 'thanks')).toBe(true);
    await tick();
    const added = noticesOf('manual.grant.added');
    expect(added).toHaveLength(1);
    await settleQueue();
    expect(added[0].payload).toEqual({ tierName: 'High', endDate: jsonOf(PREMIUM).subscriptions.g2.active.endDate, notes: 'thanks' });
    expect(Date.parse(added[0].payload.endDate)).toBeGreaterThan(Date.now() + 9 * DAY);
  });

  it('a revoke names the revoked tier', async () => {
    writePremium({ g3: { active: manual('m3', 'low'), paused: [] } });
    expect(getPremiumManager().revokeManual('g3')).toBe(true);
    await tick();
    expect(noticesOf('manual.grant.revoked').map(n => n.payload)).toEqual([{ tierName: 'Low' }]);
  });

  it('a queued grant with no day left ends with its tier named, or its tier id when the tier is gone', async () => {
    writePremium({
      g4: { active: manual('m4', 'high'), paused: [queued(manual('q4', 'low'), 0)] },
      g5: { active: manual('m5', 'high'), paused: [queued(manual('q5', 'ghost'), 0)] },
    });
    const pm = getPremiumManager();
    expect(pm.revokeManual('g4')).toBe(true);
    expect(pm.revokeManual('g5')).toBe(true);
    await tick();
    expect(noticesOf('manual.grant.ended').map(n => [n.guildId, n.payload])).toEqual([['g4', { tierName: 'Low' }], ['g5', { tierName: 'ghost' }]]);
  });

  it('a queued paid subscription with no day left ends as expired, named by its tier id when the tier is gone', async () => {
    writePremium({ g6: { active: manual('m6', 'high'), paused: [queued(paidSub('q6', 'p6', 'ghost', 'fake'), 0)] } });
    expect(getPremiumManager().revokeManual('g6')).toBe(true);
    await tick();
    expect(noticesOf('paid.sub.expired').map(n => n.payload)).toEqual([{ tierName: 'ghost', providerName: 'Fake' }]);
  });

  it('a queued paid subscription that resumes is named by its tier, or its tier id when the tier is gone', async () => {
    writePremium({
      g7: { active: manual('m7', 'high'), paused: [queued(paidSub('q7', 'p7', 'low', 'fake'), 10)] },
      g8: { active: manual('m8', 'high'), paused: [queued(paidSub('q8', 'p8', 'ghost', 'fake'), 10)] },
    });
    const pm = getPremiumManager();
    expect(pm.revokeManual('g7')).toBe(true);
    expect(pm.revokeManual('g8')).toBe(true);
    await tick();
    const resumed = noticesOf('paid.sub.resumed-from-queue');
    expect(resumed.map(n => [n.guildId, n.payload.tierName, n.payload.providerName])).toEqual([['g7', 'Low', 'Fake'], ['g8', 'ghost', 'Fake']]);
    expect(Date.parse(resumed[0].payload.endDate)).toBeGreaterThan(Date.now() + 9 * DAY);
  });
});

describe('a due migration updates the subscription it finds again by id', () => {
  const migration = (subscriptionId: string, providerSubId: string) => ({
    migrations: [{
      id: 'mig1', providerId: 'fake', sourceTierId: 'low', sourceOfferingId: 'o1', sourceVariantId: 'v1',
      targetTierId: 'high', targetOfferingId: 'o2', targetVariantId: 'v2', effectiveDate: new Date(Date.now() - 1000).toISOString(),
      message: '', scheduledAt: new Date().toISOString(), scheduledBy: 'admin', status: 'pending',
      decisions: [{ guildId: 'g1', subscriptionId, providerSubId, decision: 'accepted' }],
    }],
  });

  it('the second paused entry, not the active one or the first paused one, gets the new plan', async () => {
    writePremium({
      g1: {
        active: manual('m1', 'high'),
        paused: [queued({ ...paidSub('sX', 'pX', 'low', 'fake'), variantId: 'v1' }, 10), queued({ ...paidSub('sT', 'pT', 'low', 'fake'), variantId: 'v1' }, 10)],
      },
    }, migration('sT', 'pT'));
    registerFake({ migrateSubscriptionPrice: async () => undefined });
    await getPremiumManager().processDueMigrations();
    await settleQueue();
    const stored = jsonOf(PREMIUM);
    expect(stored.migrations[0].decisions[0].outcome).toBe('migrated');
    const subs = stored.subscriptions.g1;
    expect([subs.active.id, subs.active.tierId, subs.active.variantId]).toEqual(['m1', 'high', undefined]);
    expect(subs.paused.map((p: any) => [p.id, p.tierId, p.variantId])).toEqual([['sX', 'low', 'v1'], ['sT', 'high', 'v2']]);
  });

  it('a guild whose subscriptions went during the provider call still records the migration as done', async () => {
    writePremium({ g1: { active: { ...paidSub('sT', 'pT', 'low', 'fake'), variantId: 'v1' }, paused: [] } }, migration('sT', 'pT'));
    const held = gate();
    let called = false;
    registerFake({ migrateSubscriptionPrice: async () => { called = true; await held.promise; } });
    const pm = getPremiumManager();
    const run = pm.processDueMigrations();
    await vi.waitFor(() => expect(called).toBe(true), { timeout: 2000, interval: 5 });
    expect(pm.deleteTier('low')).toBe(true);
    held.open();
    await run;
    await settleQueue();
    const stored = jsonOf(PREMIUM);
    expect(stored.subscriptions.g1).toBeUndefined();
    expect(stored.migrations[0].decisions[0]).toMatchObject({ outcome: 'migrated' });
    expect(stored.migrations[0].decisions[0].outcomeNote).toBeUndefined();
  });
});

describe('a stacking pause of a subscription that has no day left', () => {
  it('replaces it outright and saves the new active subscription', async () => {
    const end = Date.now() + 60_000;
    writePremium({ g1: { active: { ...paidSub('s1', 'p1', 'low', 'fake'), endDate: new Date(end).toISOString() }, paused: [] } });
    const pm = getPremiumManager();
    pm.getFullConfig();
    const realNow = Date.now.bind(Date);
    let shifted = false;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      if (!shifted && String(new Error().stack).includes('pauseActiveIntoQueue')) {
        shifted = true;
        return end + 1;
      }
      return realNow();
    });
    expect(await pm.grantManual('g1', 'high', null)).toBe(true);
    expect(shifted).toBe(true);
    await settleQueue();
    const subs = jsonOf(PREMIUM).subscriptions.g1;
    expect([subs.active.source, subs.active.tierId]).toEqual(['manual', 'high']);
    expect(subs.paused).toEqual([]);
  });
});
