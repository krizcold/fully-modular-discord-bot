import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 L5 survivors (premiumManager.ts, migrations and refused admin changes): due migrations are applied one run at a
// time, each once, only when due; a migration replaced during its run takes decisions afterwards; the notices carry
// the tier and provider; nothing is applied, stamped or changed after the stop; a full config save keeps the event
// marks.

const reg = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  return { ...real, getPaymentRegistry: () => (reg.current ??= new real.PaymentProviderRegistry()) };
});
const notes = vi.hoisted(() => ({ calls: [] as Array<{ guildId: string; kind: string; payload: any }>, hold: null as Promise<void> | null }));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async (guildId: string, kind: string, payload: any) => {
    notes.calls.push({ guildId, kind, payload });
    if (notes.hold) await notes.hold;
    return { delivered: true, via: 'dm' };
  },
}));
const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { PremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { clearGlobal, gate, jsonOf, logged, paidSub, PREMIUM, quiet, settleQueue, tick, TIERS, writePremium } from './nb10PremiumRig';

const G = '900000000000000801';
const G2 = '900000000000000802';
const DAY = 86_400_000;
const role = process.env.BOT_PROCESS_ROLE;

let spies: ReturnType<typeof quiet>;
const managers: PremiumManager[] = [];
const manager = (): PremiumManager => {
  const pm = new PremiumManager();
  managers.push(pm);
  pm.load();
  return pm;
};

const sub = (id: string, providerSubId: string) => ({ ...paidSub(id, providerSubId, 'low', 'fake'), variantId: 'v1' });

function migration(id: string, effectiveMs: number, decisions: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    id, providerId: 'fake', sourceTierId: 'low', sourceOfferingId: 'o1', sourceVariantId: 'v1',
    targetTierId: 'high', targetOfferingId: 'o2', targetVariantId: 'v2', effectiveDate: new Date(effectiveMs).toISOString(),
    message: '', scheduledAt: new Date(Date.now() - DAY).toISOString(), scheduledBy: 'admin', status: 'pending', decisions,
  };
}
const decision = (guildId: string, subscriptionId: string, providerSubId: string, d: string, extra: Record<string, unknown> = {}) =>
  ({ guildId, subscriptionId, providerSubId, decision: d, ...extra });

/** The provider 'fake': each call is recorded and then waits for hold, when one is set. */
function provider(): { migrates: string[]; cancels: string[]; hold: Promise<void> | null } {
  const p = { migrates: [] as string[], cancels: [] as string[], hold: null as Promise<void> | null };
  getPaymentRegistry().register({
    id: 'fake', displayName: 'Fake Pay', isConfigured: () => true,
    capabilities: { supportsCancel: true, supportsPriceMigration: true },
    migrateSubscriptionPrice: async (id: string) => { p.migrates.push(id); if (p.hold) await p.hold; },
    cancelSubscription: async (id: string) => { p.cancels.push(id); if (p.hold) await p.hold; },
  } as any);
  return p;
}

const storedMigration = (id: string) => (jsonOf(PREMIUM).migrations as any[]).find(m => m.id === id);

/** Ends a run that would never end by stopping the cache after many reads of the migration list. */
function boundRuns(pm: PremiumManager): () => boolean {
  let reads = 0;
  let tripped = false;
  const list = (pm as any).config.migrations as any[];
  Object.defineProperty(list, 'find', {
    configurable: true,
    value(this: any[], ...args: any[]) {
      if (++reads > 50 && !tripped) {
        tripped = true;
        pm.markStopped('stopping');
      }
      return (Array.prototype.find as any).apply(this, args);
    },
  });
  return () => tripped;
}

beforeEach(async () => {
  spies = quiet();
  delete process.env.BOT_PROCESS_ROLE;
  reg.current = null;
  notes.calls = [];
  notes.hold = null;
  await settleQueue();
  clearGlobal();
});
afterEach(async () => {
  for (const pm of managers.splice(0)) pm.dispose();
  notes.hold = null;
  vi.useRealTimers();
  await settleQueue();
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
  vi.restoreAllMocks();
});

describe('due migrations', () => {
  it('a second run started while one applies leaves the next due migration to the first run', async () => {
    writePremium(
      { [G]: { active: sub('s1', 'p1'), paused: [] }, [G2]: { active: sub('s2', 'p2'), paused: [] } },
      { migrations: [
        migration('m1', Date.now() - 1000, [decision(G, 's1', 'p1', 'accepted')]),
        migration('m2', Date.now() - 1000, [decision(G2, 's2', 'p2', 'accepted')]),
      ] },
    );
    const pm = manager();
    const p = provider();
    const held = gate();
    p.hold = held.promise;
    const first = pm.processDueMigrations();
    await tick();
    const second = pm.processDueMigrations();
    await tick();
    expect(p.migrates).toEqual(['p1']);
    held.open();
    await Promise.all([first, second]);
    expect(p.migrates).toEqual(['p1', 'p2']);
    await settleQueue();
    expect(storedMigration('m1').status).toBe('applied');
    expect(storedMigration('m2').status).toBe('applied');
  });

  it('a pending migration whose date has not come is not applied', async () => {
    writePremium(
      { [G]: { active: sub('s1', 'p1'), paused: [] } },
      { migrations: [migration('mf', Date.now() + DAY, [decision(G, 's1', 'p1', 'accepted')])] },
    );
    const pm = manager();
    const p = provider();
    const tripped = boundRuns(pm);
    await pm.processDueMigrations();
    expect(tripped()).toBe(false);
    expect(p.migrates).toEqual([]);
    expect(pm.getMigration('mf')!.status).toBe('pending');
    await settleQueue();
    expect(storedMigration('mf').status).toBe('pending');
  });

  it('a migration whose date is exactly now is applied', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.parse('2026-11-04T12:00:00.000Z');
    vi.setSystemTime(now);
    writePremium(
      { [G]: { active: sub('s1', 'p1'), paused: [] } },
      { migrations: [migration('m1', now, [decision(G, 's1', 'p1', 'accepted')])] },
    );
    const pm = manager();
    const p = provider();
    await pm.processDueMigrations();
    expect(p.migrates).toEqual(['p1']);
    expect(pm.getMigration('m1')!.status).toBe('applied');
  });

  it('a later run applies a migration that came due after an earlier run ended', async () => {
    writePremium(
      { [G]: { active: sub('s1', 'p1'), paused: [] }, [G2]: { active: sub('s2', 'p2'), paused: [] } },
      { migrations: [migration('m1', Date.now() - 1000, [decision(G, 's1', 'p1', 'accepted')])] },
    );
    const pm = manager();
    const p = provider();
    await pm.processDueMigrations();
    expect(p.migrates).toEqual(['p1']);
    const cfg = pm.getFullConfig();
    cfg.migrations.push(migration('m2', Date.now() - 1000, [decision(G2, 's2', 'p2', 'accepted')]) as any);
    expect(pm.setFullConfig(cfg)).toBe(true);
    await pm.processDueMigrations();
    expect(p.migrates).toEqual(['p1', 'p2']);
    await settleQueue();
    expect(storedMigration('m2').status).toBe('applied');
  });

  it('a migration replaced by a config save during its run is not applied again, and takes a decision after the run', async () => {
    writePremium(
      { [G]: { active: sub('s1', 'p1'), paused: [] } },
      { migrations: [migration('m1', Date.now() - 1000, [decision(G, 's1', 'p1', 'accepted')])] },
    );
    const pm = manager();
    const p = provider();
    const before = pm.getFullConfig();
    const held = gate();
    p.hold = held.promise;
    const run = pm.processDueMigrations();
    await tick();
    expect(p.migrates).toEqual(['p1']);
    expect(pm.setFullConfig(before)).toBe(true);
    held.open();
    await run;
    expect(p.migrates).toEqual(['p1']);
    expect(pm.getMigration('m1')!.status).toBe('pending');
    expect(pm.recordMigrationDecision('m1', G, 'declined')).toBe(true);
    await settleQueue();
    expect(storedMigration('m1').decisions[0].decision).toBe('declined');
  });

  it('a migration whose provider call ends after the stop is not marked applied, and no audit line is reported lost', async () => {
    writePremium(
      { [G]: { active: sub('s1', 'p1'), paused: [] } },
      { migrations: [migration('m1', Date.now() - 1000, [decision(G, 's1', 'p1', 'accepted')])] },
    );
    const pm = manager();
    const p = provider();
    const held = gate();
    p.hold = held.promise;
    const run = pm.processDueMigrations();
    await tick();
    pm.markStopped('stopping');
    held.open();
    await run;
    expect(pm.getMigration('m1')!.status).toBe('pending');
    expect(logged(spies.error).filter(l => l.includes('migration.applied'))).toEqual([]);
    await settleQueue();
    expect(storedMigration('m1').status).toBe('pending');
  });
});

describe('migration notices', () => {
  it('an accepted decision sends migration.applied with the target tier and the provider name', async () => {
    writePremium(
      { [G]: { active: sub('s1', 'p1'), paused: [] } },
      { migrations: [migration('m1', Date.now() - 1000, [decision(G, 's1', 'p1', 'accepted')])] },
    );
    const pm = manager();
    provider();
    await pm.processDueMigrations();
    const sent = notes.calls.filter(c => c.kind === 'migration.applied');
    expect(sent).toEqual([{ guildId: G, kind: 'migration.applied', payload: { tierName: 'High', providerName: 'Fake Pay' } }]);
  });

  it('a silent decision under the cancel policy sends migration.silence-applied saying it cancels at period end', async () => {
    writePremium(
      { [G]: { active: sub('s1', 'p1'), paused: [] } },
      { migrations: [migration('m1', Date.now() - 1000, [decision(G, 's1', 'p1', 'pending', { notifiedAt: new Date().toISOString() })])] },
    );
    const pm = manager();
    const p = provider();
    await pm.processDueMigrations();
    expect(p.cancels).toEqual(['p1']);
    const sent = notes.calls.filter(c => c.kind === 'migration.silence-applied');
    expect(sent).toEqual([{ guildId: G, kind: 'migration.silence-applied', payload: { tierName: 'High', details: 'Set to cancel at period end.' } }]);
  });

  it('an owner who accepts gets migration.accepted with the target tier and the date', () => {
    const eff = Date.now() + DAY;
    writePremium(
      { [G]: { active: sub('s1', 'p1'), paused: [] } },
      { migrations: [migration('m1', eff, [decision(G, 's1', 'p1', 'pending')])] },
    );
    const pm = manager();
    expect(pm.recordMigrationDecision('m1', G, 'accepted')).toBe(true);
    expect(notes.calls).toEqual([{ guildId: G, kind: 'migration.accepted', payload: { tierName: 'High', endDate: new Date(eff).toISOString() } }]);
  });

  it('an owner who declines gets migration.declined', () => {
    const eff = Date.now() + DAY;
    writePremium(
      { [G]: { active: sub('s1', 'p1'), paused: [] } },
      { migrations: [migration('m1', eff, [decision(G, 's1', 'p1', 'pending')])] },
    );
    const pm = manager();
    expect(pm.recordMigrationDecision('m1', G, 'declined')).toBe(true);
    expect(notes.calls).toEqual([{ guildId: G, kind: 'migration.declined', payload: { tierName: 'High', endDate: new Date(eff).toISOString() } }]);
  });

  it('a request delivered after the stop is not stamped as delivered', async () => {
    const tiers = JSON.parse(JSON.stringify(TIERS));
    const link = (variantId: string) => ({ providerId: 'fake', enabled: true, mode: 'price', priceConfig: { entries: [{ variantId }] }, cache: { syncedAt: '', variants: [{ variantId, label: variantId }] } });
    tiers.low.offerings[0].providerLinks = [link('v1')];
    tiers.high.offerings[0].providerLinks = [link('v2')];
    writePremium({ [G]: { active: sub('s1', 'p1'), paused: [] } }, { tiers });
    const pm = manager();
    provider();
    const held = gate();
    notes.hold = held.promise;
    const m = await pm.scheduleMigration({
      providerId: 'fake', sourceTierId: 'low', sourceOfferingId: 'o1', sourceVariantId: 'v1',
      targetTierId: 'high', targetOfferingId: 'o2', targetVariantId: 'v2',
      effectiveDate: new Date(Date.now() + DAY).toISOString(), message: 'moving',
    });
    await tick();
    expect(notes.calls.map(c => c.kind)).toEqual(['migration.scheduled']);
    pm.markStopped('stopping');
    held.open();
    await tick(20);
    expect(pm.getMigration(m.id)!.decisions[0].notifiedAt).toBeUndefined();
    expect(logged(spies.warn).filter(l => l.includes('not recorded'))).toEqual([]);
  });
});

describe('admin changes after the stop', () => {
  const setup = (): PremiumManager => {
    writePremium(
      { [G]: { active: sub('s1', 'p1'), paused: [] } },
      { messages: { moduleBlocked: 'custom block' }, migrations: [migration('m1', Date.now() + DAY, [decision(G, 's1', 'p1', 'pending')])] },
    );
    const pm = manager();
    pm.markStopped('stopping');
    return pm;
  };

  it('resetting the messages is refused and keeps them', () => {
    const pm = setup();
    expect(pm.resetMessages()).toBe(false);
    expect(pm.getMessages().moduleBlocked).toBe('custom block');
  });

  it('setting the silence policy is refused and keeps it', () => {
    const pm = setup();
    expect(pm.setMigrationSilencePolicy('continue')).toBe(false);
    expect(pm.getMigrationSilencePolicy()).toBe('cancel');
  });

  it('recording a decision is refused and keeps it pending', () => {
    const pm = setup();
    expect(pm.recordMigrationDecision('m1', G, 'accepted')).toBe(false);
    expect(pm.getMigration('m1')!.decisions[0].decision).toBe('pending');
  });

  it('cancelling a migration is refused and keeps it pending', () => {
    const pm = setup();
    expect(pm.cancelMigration('m1')).toBe(false);
    expect(pm.getMigration('m1')!.status).toBe('pending');
  });

  it('saving a full config is refused and keeps the loaded one', () => {
    const pm = setup();
    const cfg = pm.getFullConfig();
    cfg.messages.moduleBlocked = 'other';
    cfg.migrations = [];
    expect(pm.setFullConfig(cfg)).toBe(false);
    expect(pm.getMessages().moduleBlocked).toBe('custom block');
    expect(pm.listMigrations().map(m => m.id)).toEqual(['m1']);
  });
});

describe('a full config save', () => {
  it('keeps the event marks the cache holds when the saved config has none', async () => {
    writePremium({}, { eventsApplied: { w1: 4 } });
    const pm = manager();
    const cfg = pm.getFullConfig();
    delete cfg.eventsApplied;
    cfg.messages.moduleBlocked = 'saved';
    expect(pm.setFullConfig(cfg)).toBe(true);
    await settleQueue();
    const stored = jsonOf(PREMIUM);
    expect(stored.messages.moduleBlocked).toBe('saved');
    expect(stored.eventsApplied).toEqual({ w1: 4 });
  });
});
