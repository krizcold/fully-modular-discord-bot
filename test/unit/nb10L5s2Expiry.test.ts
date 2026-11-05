import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 L5 survivors (premiumManager.ts, expiry tick, pause audit, cancels judged after the stop, replay state): the
// expiry tick's notices carry the tier, notes and end date; a pause is audited as the admin's; a cancel whose
// subscription another change removed answers by what the saved text is known to hold; isPremiumReplaying follows
// the cache.

const reg = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  return { ...real, getPaymentRegistry: () => (reg.current ??= new real.PaymentProviderRegistry()) };
});
const notes = vi.hoisted(() => ({ calls: [] as Array<{ guildId: string; kind: string; payload: any }> }));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async (guildId: string, kind: string, payload: any) => {
    notes.calls.push({ guildId, kind, payload });
    return { delivered: true, via: 'dm' };
  },
}));
const inject = vi.hoisted(() => ({ refuseSave: false }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  return {
    ...real,
    saveDataTracked: (f: string, o: any, d: unknown) => (inject.refuseSave ? { outcome: 'refused', cause: 'storage-failing' } : real.saveDataTracked(f, o, d)),
  };
});
const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { getPremiumManager, isPremiumReplaying, PremiumManager, resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { AUDIT, clearGlobal, gate, JOURNAL, linesOf, paidSub, quiet, settleQueue, tick, TIERS, writePremium } from './nb10PremiumRig';

const G = '900000000000000811';
const HOUR = 3_600_000;
const role = process.env.BOT_PROCESS_ROLE;

const managers: PremiumManager[] = [];
const manager = (): PremiumManager => {
  const pm = new PremiumManager();
  managers.push(pm);
  pm.load();
  return pm;
};

const manualSub = (id: string, endMs: number, notesText: string) => ({
  id, tierId: 'low', source: 'manual', startDate: new Date(Date.now() - 10 * 24 * HOUR).toISOString(),
  endDate: new Date(endMs).toISOString(), autoRenew: false, status: 'active', notes: notesText,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
});

function cancelProvider(): { cancels: string[]; held: ReturnType<typeof gate<void>> } {
  const p = { cancels: [] as string[], held: gate<void>() };
  getPaymentRegistry().register({
    id: 'fake', displayName: 'Fake Pay', isConfigured: () => true, capabilities: { supportsCancel: true },
    cancelSubscription: async (id: string) => { p.cancels.push(id); await p.held.promise; },
  } as any);
  return p;
}

const fullConfig = (subscriptions: Record<string, unknown>): any => ({
  tiers: JSON.parse(JSON.stringify(TIERS)), subscriptions, messages: {}, providerAccountLinks: {}, activatedProviders: {},
  migrations: [], migrationSilencePolicy: 'cancel',
});

beforeEach(async () => {
  quiet();
  delete process.env.BOT_PROCESS_ROLE;
  inject.refuseSave = false;
  reg.current = null;
  notes.calls = [];
  resetPremiumManager();
  await settleQueue();
  clearGlobal();
});
afterEach(async () => {
  for (const pm of managers.splice(0)) pm.dispose();
  resetPremiumManager();
  inject.refuseSave = false;
  await settleQueue();
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
  vi.restoreAllMocks();
});

describe('the expiry tick', () => {
  it('a manual grant past its end sends manual.grant.ended with the tier name and the grant notes', async () => {
    writePremium({ [G]: { active: manualSub('m1', Date.now() - HOUR, 'gift for events'), paused: [] } });
    const pm = manager();
    pm.startExpiryChecker(5);
    await vi.waitFor(() => expect(notes.calls.some(c => c.kind === 'manual.grant.ended')).toBe(true), { timeout: 2000, interval: 5 });
    pm.stopExpiryChecker();
    expect(notes.calls.filter(c => c.kind === 'manual.grant.ended')).toEqual([
      { guildId: G, kind: 'manual.grant.ended', payload: { tierName: 'Low', notes: 'gift for events' } },
    ]);
  });

  it('a manual grant ending within a day sends manual.grant.ending-soon with the tier name and the end date', async () => {
    const end = Date.now() + HOUR;
    writePremium({ [G]: { active: manualSub('m1', end, 'trial'), paused: [] } });
    const pm = manager();
    pm.startExpiryChecker(5);
    await vi.waitFor(() => expect(notes.calls.some(c => c.kind === 'manual.grant.ending-soon')).toBe(true), { timeout: 2000, interval: 5 });
    pm.stopExpiryChecker();
    expect(notes.calls.filter(c => c.kind === 'manual.grant.ending-soon')).toEqual([
      { guildId: G, kind: 'manual.grant.ending-soon', payload: { tierName: 'Low', endDate: new Date(end).toISOString() } },
    ]);
  });
});

describe('a higher grant pausing the active one', () => {
  it('writes the subscription.pause audit line with the admin as actor', async () => {
    writePremium();
    const pm = manager();
    expect(await pm.grantManual(G, 'low', 30)).toBe(true);
    expect(await pm.grantManual(G, 'high', 30)).toBe(true);
    await settleQueue();
    const pauses = linesOf(AUDIT).filter(l => l.action === 'subscription.pause');
    expect(pauses).toHaveLength(1);
    expect(pauses[0].actor).toBe('admin');
    expect(pauses[0].guildId).toBe(G);
  });
});

describe('a cancel whose subscription another change removed, judged after the stop', () => {
  it('answers not saved when the saved text is no longer known (the cache was dropped)', async () => {
    writePremium({ [G]: { active: paidSub('s1', 'p1', 'low', 'fake'), paused: [] } });
    const pm = manager();
    const p = cancelProvider();
    const answer = pm.cancelPaidSubscriptionImmediately(G);
    await tick();
    expect(p.cancels).toEqual(['p1']);
    const cfg = pm.getFullConfig();
    cfg.subscriptions = {};
    expect(pm.setFullConfig(cfg)).toBe(true);
    pm.invalidate();
    pm.markStopped('stopping');
    p.held.open();
    expect(await answer).toBe(false);
  });

  it('answers done when the last saved text holds the guild without that subscription and without a paused list', async () => {
    writePremium();
    const pm = manager();
    const noId: Record<string, unknown> = { ...paidSub('x', 'p1', 'low', 'fake') };
    delete noId.id;
    expect(pm.setFullConfig(fullConfig({ [G]: { active: noId, paused: [] } }))).toBe(true);
    const p = cancelProvider();
    const answer = pm.cancelPaidSubscriptionImmediately(G);
    await tick();
    expect(p.cancels).toEqual(['p1']);
    expect(pm.setFullConfig(fullConfig({ [G]: { active: paidSub('other', 'p9', 'low', 'fake') } }))).toBe(true);
    await settleQueue();
    inject.refuseSave = true;
    expect(pm.setFullConfig(fullConfig({}))).toBe(false);
    pm.markStopped('stopping');
    p.held.open();
    expect(await answer).toBe(true);
  });
});

describe('isPremiumReplaying', () => {
  it('is false with no premium cache and with a normal one', () => {
    expect(isPremiumReplaying()).toBe(false);
    writePremium();
    getPremiumManager();
    expect(isPremiumReplaying()).toBe(false);
  });

  it('is true while the bot holds provider events it has not applied', () => {
    process.env.BOT_PROCESS_ROLE = 'bot';
    writePremium();
    const event = { type: 'subscription.renewed', providerId: 'fake', providerSubId: 'p1', guildId: G };
    fs.writeFileSync(JOURNAL, `${JSON.stringify({ writer: 'w-old', n: 1, event })}\n`);
    expect(getPremiumManager().cacheState()).toBe('replaying');
    expect(isPremiumReplaying()).toBe(true);
  });
});
