import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 code review round 5 (findings NB10-R6-*), the fixer's regression tests for premium: a cancel whose
// subscription the provider's own event removed answers done (D1); an install's cache change is saved before the
// provider pause is awaited (D2); a due migration is applied once, with changes to it refused while it runs (D3, D4, O1).

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
import { DummyProvider } from '../../src/bot/internalSetup/utils/payment/dummyProvider';
import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import { sharedOpFailure } from '../../src/webui/routes/hopFailure';
import { releaseWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { freshWriterLock, resetForks } from '../helpers/nb10Rig';
import { AUDIT, clearGlobal, gate, jsonOf, linesOf, paidSub, PREMIUM, settleQueue, tick, writePremium } from './nb10PremiumRig';

const G = '900000000000000666';
const G2 = '900000000000000667';
const role = process.env.BOT_PROCESS_ROLE;
const BUSY = 'This migration is being applied right now, so nothing was changed. Its outcome shows here when the run ends; reload later to see it.';

const op = (name: string, ...args: unknown[]) => applySharedOp({ op: name, args: { args } });

const paused = (id: string, providerSubId: string, tierId = 'low', providerId = 'patreon') =>
  ({ ...paidSub(id, providerSubId, tierId, providerId), status: 'paused', remainingDaysAtPause: 10 });

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

describe("expire now with the Dummy provider, whose own event removes the subscription during the call (D1)", () => {
  it('answers done: the subscription is gone, the paused one is active, and the route answers 200', async () => {
    writePremium({ [G]: { active: paidSub('sA', 'dA', 'low', 'dummy'), paused: [paused('sP', 'dP', 'low', 'patreon')] } });
    const dummy = new DummyProvider();
    getPaymentRegistry().register(dummy);
    dummy.adminListVariants();
    const now = new Date().toISOString();
    (dummy as any).state.subscriptions.dA = {
      providerSubId: 'dA', guildId: G, tierId: 'low', offeringId: 'o1', variantId: 'v1', durationDays: 30,
      startDate: now, endDate: new Date(Date.now() + 30 * 86_400_000).toISOString(), autoRenew: true, status: 'active',
      createdAt: now, updatedAt: now,
    };
    const reply = await op('premium.cancelPaidSubscriptionImmediately', G);
    expect(reply).toEqual({ ok: true, result: true });
    expect(sharedOpFailure(reply)).toBeNull();
    await settleQueue();
    const subs = jsonOf(PREMIUM).subscriptions[G];
    expect(subs.active.id).toBe('sP');
    expect(subs.paused).toEqual([]);
    dummy.stop();
  });
});

describe("an install that pauses the active subscription saves before the provider's pause (D2)", () => {
  // NB6 decision 63 (sheet 2606-2608): the grant's line and notice go out with the save before the pause, so a stop
  // during the pause leaves nothing of the op unsaved and the op answers ok (NB10 answered partial: its grant line was
  // written after the pause).
  it('a stop during the pause answers ok: the save before the pause took the grant line, and the store holds the grant once', async () => {
    writePremium({ [G]: { active: paidSub('sA', 'pA', 'low', 'patreon'), paused: [] } });
    const pause = gate();
    const pauses: string[] = [];
    getPaymentRegistry().register({
      id: 'patreon', displayName: 'patreon', capabilities: { supportsCancel: true, supportsPause: true }, isConfigured: () => true,
      cancelSubscription: async () => undefined,
      pauseSubscription: async (id: string) => { pauses.push(id); await pause.promise; },
    } as any);
    const answer = op('premium.grantManual', G, 'high', 5);
    await tick();
    expect(pauses).toEqual(['pA']);
    await settleQueue();
    const onDisk = jsonOf(PREMIUM).subscriptions[G];
    expect(onDisk.active.source).toBe('manual');
    expect(onDisk.paused.map((p: any) => p.id)).toEqual(['sA']);
    expect(linesOf(AUDIT).map(l => l.action)).toEqual(['subscription.grant.manual', 'subscription.pause']);
    (getPremiumManager() as any).stopped = 'stopping';
    pause.open();
    const reply: any = await answer;
    expect(reply).toMatchObject({ ok: true, result: true });
    expect(reply.partial).toBeUndefined();
    (getPremiumManager() as any).stopped = null;
    await settleQueue();
    const subs = jsonOf(PREMIUM).subscriptions[G];
    expect([subs.active, ...subs.paused].filter((s: any) => s.source === 'manual')).toHaveLength(1);
    expect(linesOf(AUDIT).map(l => l.action)).toEqual(['subscription.grant.manual', 'subscription.pause']);
  });
});

function migration(decisions: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id: 'mig1', providerId: 'patreon', sourceTierId: 'low', sourceOfferingId: 'o1', sourceVariantId: 'v1',
    targetTierId: 'low', targetOfferingId: 'o1', targetVariantId: 'v2', effectiveDate: new Date(Date.now() - 1000).toISOString(),
    message: '', scheduledAt: new Date().toISOString(), scheduledBy: 'admin', status: 'pending', decisions, ...extra,
  };
}

type MigrateProvider = { migrates: string[]; cancels: string[]; open: (id: string) => void };

function migrateProvider(): MigrateProvider {
  const gates = new Map<string, ReturnType<typeof gate>>();
  const of = (id: string) => {
    if (!gates.has(id)) gates.set(id, gate());
    return gates.get(id)!;
  };
  const p: MigrateProvider = { migrates: [], cancels: [], open: id => of(id).open(undefined) };
  getPaymentRegistry().register({
    id: 'patreon', displayName: 'patreon', capabilities: { supportsCancel: true, supportsPause: true }, isConfigured: () => true,
    cancelSubscription: async (id: string) => { p.cancels.push(id); },
    pauseSubscription: async () => undefined,
    migrateSubscriptionPrice: async (id: string) => { p.migrates.push(id); await of(id).promise; },
  } as any);
  return p;
}

const silent = (guildId: string, subscriptionId: string, providerSubId: string) =>
  ({ guildId, subscriptionId, providerSubId, decision: 'pending', notifiedAt: new Date().toISOString() });

describe('a due migration is applied once, and changes to it are refused while it runs (D3, D4, O1)', () => {
  it('a second due run while the first awaits the provider applies nothing, and no subscriber is cancelled', async () => {
    writePremium(
      {
        [G]: { active: { ...paidSub('s1', 'p1', 'low', 'patreon'), variantId: 'v1' }, paused: [] },
        [G2]: { active: { ...paidSub('s2', 'p2', 'low', 'patreon'), variantId: 'v1' }, paused: [] },
      },
      { migrationSilencePolicy: 'continue', migrations: [migration([silent(G, 's1', 'p1'), silent(G2, 's2', 'p2')])] },
    );
    const provider = migrateProvider();
    const first = getPremiumManager().processDueMigrations();
    await tick();
    expect(provider.migrates).toEqual(['p1']);
    await getPremiumManager().processDueMigrations();
    expect(provider.migrates).toEqual(['p1']);
    provider.open('p1');
    await tick();
    expect(provider.migrates).toEqual(['p1', 'p2']);
    await getPremiumManager().processDueMigrations();
    provider.open('p2');
    await first;
    await settleQueue();
    expect(provider.migrates).toEqual(['p1', 'p2']);
    expect(provider.cancels).toEqual([]);
    const stored = jsonOf(PREMIUM);
    expect(stored.migrations[0].status).toBe('applied');
    expect(stored.migrations[0].decisions.map((d: any) => d.outcome)).toEqual(['migrated', 'migrated']);
    expect(stored.subscriptions[G].active.variantId).toBe('v2');
    expect(stored.subscriptions[G2].active.autoRenew).toBe(true);
  });

  it("an operator's cancel and an owner's decline during the run are refused with nothing changed; afterwards the migration is applied", async () => {
    writePremium(
      { [G]: { active: { ...paidSub('s1', 'p1', 'low', 'patreon'), variantId: 'v1' }, paused: [] } },
      { migrationSilencePolicy: 'continue', migrations: [migration([silent(G, 's1', 'p1')])] },
    );
    const provider = migrateProvider();
    const run = getPremiumManager().processDueMigrations();
    await tick();
    expect(provider.migrates).toEqual(['p1']);
    const cancel: any = await op('premium.cancelMigration', 'mig1');
    expect(cancel).toEqual({ ok: false, code: 'changed', error: BUSY });
    expect(sharedOpFailure(cancel)).toEqual({ status: 409, error: BUSY });
    const decline: any = await op('premium.recordMigrationDecision', 'mig1', G, 'declined');
    expect(decline).toEqual({ ok: false, code: 'changed', error: BUSY });
    provider.open('p1');
    await run;
    await settleQueue();
    const stored = jsonOf(PREMIUM);
    expect(stored.migrations[0].status).toBe('applied');
    expect(stored.migrations[0].decisions[0].outcome).toBe('migrated');
    expect(linesOf(AUDIT).map(l => l.action)).not.toContain('migration.cancelled');
    expect(linesOf(AUDIT).map(l => l.action)).not.toContain('migration.decision');
    expect(provider.cancels).toEqual([]);
    expect(await op('premium.cancelMigration', 'mig1')).toEqual({ ok: true, result: false });
  });

  it('a decision already applied is skipped, and a silent-applied one without an outcome follows the policy', async () => {
    const applied = new Date(Date.now() - 5000).toISOString();
    writePremium(
      {
        [G]: { active: { ...paidSub('s1', 'p1', 'low', 'patreon'), variantId: 'v1' }, paused: [] },
        [G2]: { active: { ...paidSub('s2', 'p2', 'low', 'patreon'), variantId: 'v1' }, paused: [] },
      },
      {
        migrationSilencePolicy: 'continue',
        migrations: [migration([
          { ...silent(G, 's1', 'p1'), decision: 'silent-applied', outcome: 'migrated', appliedAt: applied },
          { ...silent(G2, 's2', 'p2'), decision: 'silent-applied' },
        ])],
      },
    );
    const provider = migrateProvider();
    provider.open('p2');
    await getPremiumManager().processDueMigrations();
    await settleQueue();
    expect(provider.migrates).toEqual(['p2']);
    expect(provider.cancels).toEqual([]);
    const stored = jsonOf(PREMIUM);
    expect(stored.migrations[0].decisions[0]).toMatchObject({ outcome: 'migrated', appliedAt: applied });
    expect(stored.migrations[0].decisions[1].outcome).toBe('migrated');
  });
});
