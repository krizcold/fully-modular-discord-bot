import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 L5 refuted survivors (premiumManager.ts, expiry tick and due migrations): a stopped cache's tick reads
// premium-tiers.json once and logs nothing more; a tick whose expiry pass finds the file gone unreadable leaves the
// ending-soon marks alone, so no grant is warned twice; due migrations apply only pending ones whose date has come
// (the date itself included), and the first one is marked before control returns to the caller.

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
// Each read of premium-tiers.json takes the next step while steps remain: 'real' reads the file, a string is
// returned as the file's text, an Error is thrown.
const reads = vi.hoisted(() => ({ path: '', steps: [] as Array<'real' | string | Error>, count: 0 }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  return {
    ...real,
    readRawStrict: (file: string) => {
      if (file === reads.path) {
        reads.count++;
        const step = reads.steps.shift();
        if (step instanceof Error) throw step;
        if (typeof step === 'string' && step !== 'real') return step;
      }
      return real.readRawStrict(file);
    },
  };
});
const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { PremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { AUDIT, clearGlobal, jsonOf, linesOf, logged, PREMIUM, quiet, settleQueue, tick, writePremium } from './nb10PremiumRig';

const G = '900000000000000931';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const role = process.env.BOT_PROCESS_ROLE;

let spies: ReturnType<typeof quiet>;
const managers: PremiumManager[] = [];
const manager = (): PremiumManager => {
  const pm = new PremiumManager();
  managers.push(pm);
  pm.load();
  return pm;
};

const manualSub = (id: string, endMs: number) => ({
  id, tierId: 'low', source: 'manual', startDate: new Date(Date.now() - 10 * DAY).toISOString(),
  endDate: new Date(endMs).toISOString(), autoRenew: false, status: 'active',
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
});

function migration(id: string, status: string, effectiveMs: number): Record<string, unknown> {
  return {
    id, providerId: 'gone', sourceTierId: 'low', sourceOfferingId: 'o1', sourceVariantId: 'v1',
    targetTierId: 'high', targetOfferingId: 'o2', targetVariantId: 'v2', effectiveDate: new Date(effectiveMs).toISOString(),
    message: '', scheduledAt: new Date(effectiveMs - DAY).toISOString(), scheduledBy: 'admin', status, decisions: [],
  };
}

const eacces = (): Error => Object.assign(new Error('permission denied'), { code: 'EACCES' });
const CHANGED = JSON.stringify({ tiers: {}, subscriptions: {}, note: 'changed by another process' });
const cannotBeRead = (): string[] => logged(spies.error).filter(l => l.includes('premium-tiers.json cannot be read'));
const storedMigration = (id: string) => (jsonOf(PREMIUM).migrations as any[]).find(m => m.id === id);
const cancelLines = () => linesOf(AUDIT).filter(l => l.action === 'migration.cancelled');

beforeEach(async () => {
  spies = quiet();
  delete process.env.BOT_PROCESS_ROLE;
  reg.current = null;
  notes.calls = [];
  reads.path = PREMIUM;
  reads.steps = [];
  reads.count = 0;
  await settleQueue();
  clearGlobal();
});
afterEach(async () => {
  reads.steps = [];
  for (const pm of managers.splice(0)) pm.dispose();
  vi.useRealTimers();
  await settleQueue();
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
  vi.restoreAllMocks();
});

describe('the expiry tick of a stopped cache', () => {
  it('reads premium-tiers.json once and neither logs it unreadable nor turns the cache unreadable', async () => {
    writePremium({ [G]: { active: manualSub('m1', Date.now() + HOUR), paused: [] } });
    const pm = manager();
    pm.markStopped('stopping');
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    pm.startExpiryChecker(1000);
    reads.count = 0;
    reads.steps = ['real', CHANGED, eacces()];
    vi.advanceTimersByTime(1000);
    pm.stopExpiryChecker();
    vi.useRealTimers();
    reads.steps = [];
    await tick();
    expect(cannotBeRead()).toEqual([]);
    expect(reads.count).toBe(1);
    expect(pm.unreadableText()).toBeNull();
    expect(notes.calls).toEqual([]);
  });
});

describe('a tick whose expiry pass finds premium-tiers.json unreadable', () => {
  it('keeps the ending-soon mark, so the grant is warned once after the file can be read again', async () => {
    writePremium({ [G]: { active: manualSub('m1', Date.now() + HOUR), paused: [] } });
    const pm = manager();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    pm.startExpiryChecker(1000);
    vi.advanceTimersByTime(1000);
    await tick();
    expect(notes.calls.filter(c => c.kind === 'manual.grant.ending-soon')).toHaveLength(1);

    reads.steps = ['real', CHANGED, eacces()];
    vi.advanceTimersByTime(1000);
    await tick();
    expect(reads.steps).toEqual([]);
    expect(cannotBeRead()).toHaveLength(1);

    pm.invalidate();
    vi.advanceTimersByTime(1000);
    await tick();
    pm.stopExpiryChecker();
    expect(pm.unreadableText()).toBeNull();
    expect(notes.calls.filter(c => c.kind === 'manual.grant.ending-soon')).toHaveLength(1);
  });
});

describe('due migrations', () => {
  it('marks the first pending due migration before returning, past an applied one listed first', async () => {
    const past = Date.now() - HOUR;
    writePremium({}, { migrations: [migration('m-applied', 'applied', past), migration('m-due', 'pending', past)] });
    const pm = manager();
    const run = pm.processDueMigrations();
    expect(pm.cancelMigration('m-due')).toBe(false);
    await run;
    await settleQueue();
    expect(storedMigration('m-due').status).toBe('cancelled');
    expect(storedMigration('m-applied').status).toBe('applied');
    const lines = cancelLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ actor: 'system', migrationId: 'm-due', metadata: { reason: 'provider-unavailable' } });
  });

  it('leaves a pending migration whose date has not come', async () => {
    writePremium({}, { migrations: [migration('m-later', 'pending', Date.now() + DAY)] });
    const pm = manager();
    await pm.processDueMigrations();
    await settleQueue();
    expect(storedMigration('m-later').status).toBe('pending');
    expect(cancelLines()).toEqual([]);
  });

  it('applies a pending migration whose date is exactly now', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.UTC(2026, 10, 4, 12, 0, 0, 0);
    vi.setSystemTime(now);
    writePremium({}, { migrations: [migration('m-now', 'pending', now)] });
    const pm = manager();
    await pm.processDueMigrations();
    vi.useRealTimers();
    await settleQueue();
    expect(storedMigration('m-now').status).toBe('cancelled');
    expect(cancelLines()).toEqual([expect.objectContaining({ migrationId: 'm-now', metadata: { reason: 'provider-unavailable' } })]);
  });
});
