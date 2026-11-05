import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 code review round 5, the fixer's regression tests: a premium change that awaits a provider finds its
// subscription again by id afterwards (D2, O1), and the provider-link unlink stops only on a step that did not save
// (D1, O2).

const reg = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  return { ...real, getPaymentRegistry: () => (reg.current ??= new real.PaymentProviderRegistry()) };
});
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async () => ({ delivered: true, via: 'dm' }),
}));
const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { getPremiumManager, resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import { releaseWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { freshWriterLock, resetForks } from '../helpers/nb10Rig';
import { AUDIT, clearGlobal, gate, jsonOf, linesOf, paidSub, PREMIUM, settleQueue, tick, writePremium } from './nb10PremiumRig';

const G = '900000000000000555';
const role = process.env.BOT_PROCESS_ROLE;

type Held = { cancels: string[]; open: (providerSubId: string) => void; pauses: string[]; openPause: (providerSubId: string) => void };

/** A provider whose cancel and pause calls wait until the test opens them, one gate per provider subscription id. */
function heldProvider(id = 'patreon'): Held {
  const gates = new Map<string, ReturnType<typeof gate>>();
  const pauseGates = new Map<string, ReturnType<typeof gate>>();
  const of = (map: Map<string, ReturnType<typeof gate>>, key: string) => {
    if (!map.has(key)) map.set(key, gate());
    return map.get(key)!;
  };
  const held: Held = {
    cancels: [],
    pauses: [],
    open: key => of(gates, key).open(undefined),
    openPause: key => of(pauseGates, key).open(undefined),
  };
  getPaymentRegistry().register({
    id, displayName: id, capabilities: { supportsCancel: true, supportsPause: true }, isConfigured: () => true,
    cancelSubscription: async (providerSubId: string) => { held.cancels.push(providerSubId); await of(gates, providerSubId).promise; },
    pauseSubscription: async (providerSubId: string) => { held.pauses.push(providerSubId); await of(pauseGates, providerSubId).promise; },
  } as any);
  return held;
}

const paused = (id: string, providerSubId: string, tierId = 'low', providerId = 'patreon') =>
  ({ ...paidSub(id, providerSubId, tierId, providerId), status: 'paused', remainingDaysAtPause: 10 });

const expiredGrant = () => ({
  ...paidSub('m0', '', 'low'), source: 'manual', providerId: undefined, providerSubId: undefined,
  endDate: new Date(Date.now() - 60_000).toISOString(),
});

const op = (name: string, ...args: unknown[]) => applySharedOp({ op: name, args: { args } });
const expireTick = () => (getPremiumManager() as any).checkExpiry();

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  delete process.env.BOT_PROCESS_ROLE;
  resetForks();
  freshWriterLock('webui', new Set([process.pid, 77]));
  resetPremiumManager();
  reg.current = null;
  await settleQueue();
  clearGlobal();
});

afterEach(async () => {
  resetPremiumManager();
  reg.current = null;
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { recursive: true, force: true });
  await settleQueue();
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
  vi.restoreAllMocks();
});

describe('a paused cancel finds its subscription again after the provider call (D2, O1)', () => {
  it('two interleaved cancels each remove their own entry, whichever provider call returns first', async () => {
    writePremium({ [G]: { active: paidSub('sA', 'pA', 'high', 'patreon'), paused: [paused('s0', 'p0'), paused('s1', 'p1'), paused('s2', 'p2')] } });
    const held = heldProvider();
    const first = op('premium.cancelAndRemovePausedSubscription', G, 's0');
    const second = op('premium.cancelAndRemovePausedSubscription', G, 's1');
    await tick();
    expect(held.cancels).toEqual(['p0', 'p1']);
    held.open('p0');
    expect(await first).toEqual({ ok: true, result: true });
    held.open('p1');
    expect(await second).toEqual({ ok: true, result: true });
    await settleQueue();
    expect(jsonOf(PREMIUM).subscriptions[G].paused.map((p: any) => p.id)).toEqual(['s2']);
    expect(linesOf(AUDIT).filter(l => l.action === 'subscription.cancel.paid').map(l => l.subscriptionId)).toEqual(['s0', 's1']);
  });

  it('an entry the expiry tick resumed meanwhile is removed from the active slot, and the manual grant behind it stays', async () => {
    writePremium(
      { [G]: { active: expiredGrant(), paused: [paused('sP', 'pP', 'high'), { ...paused('m1', '', 'low'), source: 'manual', providerId: undefined, providerSubId: undefined }] } },
      { providerAccountLinks: { patreon: { acct1: G } } },
    );
    const held = heldProvider();
    const answer = op('premium.unlinkProviderAccount', G, 'patreon');
    await tick();
    expect(held.cancels).toEqual(['pP']);
    expireTick();
    expect(getPremiumManager().getFullConfig().subscriptions[G].active?.id).toBe('sP');
    held.open('pP');
    expect(await answer).toEqual({ ok: true, result: true });
    await settleQueue();
    const stored = jsonOf(PREMIUM);
    expect(stored.subscriptions[G].active.id).toBe('m1');
    expect(stored.subscriptions[G].paused).toEqual([]);
    expect(stored.providerAccountLinks.patreon).toBeUndefined();
    expect(held.cancels).toEqual(['pP']);
  });

  it('cancelling the active paid subscription keeps a grant installed during the provider call', async () => {
    writePremium({ [G]: { active: paidSub('sA', 'pA', 'low', 'patreon'), paused: [] } });
    const held = heldProvider();
    held.openPause('pA');
    const answer = op('premium.cancelPaidSubscriptionImmediately', G);
    await tick();
    expect(await op('premium.grantManual', G, 'high', 5)).toEqual({ ok: true, result: true });
    held.open('pA');
    expect(await answer).toEqual({ ok: true, result: true });
    await settleQueue();
    const subs = jsonOf(PREMIUM).subscriptions[G];
    expect(subs.active.source).toBe('manual');
    expect(subs.active.tierId).toBe('high');
    expect(subs.paused).toEqual([]);
  });
});

describe('the provider-link unlink stops only on a step that did not save (D1, O2)', () => {
  it('a paused subscription that moved to the active slot meanwhile is cancelled there, and the link is removed', async () => {
    writePremium(
      { [G]: { active: expiredGrant(), paused: [paused('s1', 'p1', 'high'), paused('s2', 'p2', 'low')] } },
      { providerAccountLinks: { patreon: { acct1: G } } },
    );
    const held = heldProvider();
    const answer = op('premium.unlinkProviderAccount', G, 'patreon');
    await tick();
    expireTick();
    held.open('p1');
    await tick();
    expect(held.cancels).toEqual(['p1', 'p2']);
    held.open('p2');
    expect(await answer).toEqual({ ok: true, result: true });
    await settleQueue();
    const stored = jsonOf(PREMIUM);
    expect(stored.subscriptions[G]).toBeUndefined();
    expect(stored.providerAccountLinks.patreon).toBeUndefined();
  });

  it('a paused subscription another op removed meanwhile is skipped, and the link is removed', async () => {
    writePremium(
      { [G]: { paused: [paused('s1', 'p1', 'high'), paused('s2', 'p2', 'low')] } },
      { providerAccountLinks: { patreon: { acct1: G } } },
    );
    const held = heldProvider();
    const answer = op('premium.unlinkProviderAccount', G, 'patreon');
    await tick();
    const other = op('premium.cancelAndRemovePausedSubscription', G, 's2');
    await tick();
    held.open('p2');
    expect(await other).toEqual({ ok: true, result: true });
    held.open('p1');
    expect(await answer).toEqual({ ok: true, result: true });
    await settleQueue();
    const stored = jsonOf(PREMIUM);
    expect(stored.subscriptions[G]).toBeUndefined();
    expect(stored.providerAccountLinks.patreon).toBeUndefined();
    expect(held.cancels).toEqual(['p1', 'p2']);
  });

  it('a step whose save is refused stops the unlink with the link kept, and the answer is not ok', async () => {
    writePremium(
      { [G]: { paused: [paused('s1', 'p1', 'high')] } },
      { providerAccountLinks: { patreon: { acct1: G } } },
    );
    const held = heldProvider();
    const answer = op('premium.unlinkProviderAccount', G, 'patreon');
    await tick();
    (getPremiumManager() as any).stopped = 'stopping';
    held.open('p1');
    const reply: any = await answer;
    expect(reply.ok).toBe(false);
    expect(getPremiumManager().getFullConfig().providerAccountLinks.patreon).toEqual({ acct1: G });
    (getPremiumManager() as any).stopped = null;
  });
});

describe('an install that pauses the active subscription keeps a change made during the provider pause', () => {
  it('a second grant during the first grant\'s provider pause is queued, not overwritten', async () => {
    writePremium({ [G]: { active: paidSub('sA', 'pA', 'low', 'patreon'), paused: [] } });
    const held = heldProvider();
    const first = op('premium.grantManual', G, 'high', 5);
    await tick();
    expect(held.pauses).toEqual(['pA']);
    const second = op('premium.grantManual', G, 'low', 3);
    await tick();
    held.openPause('pA');
    expect(await first).toEqual({ ok: true, result: true });
    expect(await second).toEqual({ ok: true, result: true });
    await settleQueue();
    const subs = jsonOf(PREMIUM).subscriptions[G];
    expect(subs.active.tierId).toBe('high');
    expect(subs.active.source).toBe('manual');
    expect(subs.paused.map((p: any) => `${p.source}:${p.tierId}`).sort()).toEqual(['manual:low', 'paid:low']);
  });
});

describe('a due migration updates the subscription found again after the provider call', () => {
  it('a declined migration whose subscription resumed meanwhile turns auto-renew off on the resumed record', async () => {
    writePremium(
      { [G]: { active: expiredGrant(), paused: [{ ...paused('s1', 'p1', 'high'), variantId: 'v1' }] } },
      {
        migrations: [{
          id: 'mig1', providerId: 'patreon', sourceTierId: 'high', sourceOfferingId: 'o2', sourceVariantId: 'v1',
          targetTierId: 'high', targetOfferingId: 'o2', targetVariantId: 'v2', effectiveDate: new Date(Date.now() - 1000).toISOString(),
          message: '', scheduledAt: new Date().toISOString(), scheduledBy: 'admin', status: 'pending',
          decisions: [{ guildId: G, subscriptionId: 's1', providerSubId: 'p1', decision: 'declined' }],
        }],
      },
    );
    const held = heldProvider();
    (getPaymentRegistry().get('patreon') as any).migrateSubscriptionPrice = async () => undefined;
    const run = getPremiumManager().processDueMigrations();
    await tick();
    expect(held.cancels).toEqual(['p1']);
    expireTick();
    expect(getPremiumManager().getFullConfig().subscriptions[G].active?.id).toBe('s1');
    held.open('p1');
    await run;
    await settleQueue();
    const stored = jsonOf(PREMIUM);
    expect(stored.subscriptions[G].active.id).toBe('s1');
    expect(stored.subscriptions[G].active.autoRenew).toBe(false);
    expect(stored.migrations[0].decisions[0].outcome).toBe('cancelled');
  });
});
