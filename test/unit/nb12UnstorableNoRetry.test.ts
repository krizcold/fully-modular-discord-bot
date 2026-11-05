import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const inject = vi.hoisted(() => ({ unstorable: new Set<string>() }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  const ledger = await import('../../src/bot/internalSetup/utils/dataBackends/writeLedger');
  return {
    ...real,
    saveDataTracked: (f: string, o: any, d: unknown) => {
      if (!inject.unstorable.has(f)) return real.saveDataTracked(f, o, d);
      const reason = 'the file is past 4 MiB';
      ledger.recordRefusal('unstorable', `global:${o.category ?? ''}/${f}`, reason);
      return { outcome: 'refused', cause: 'unstorable', reason };
    },
  };
});
const reg = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  return { ...real, getPaymentRegistry: () => (reg.current ??= new real.PaymentProviderRegistry()) };
});
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async () => ({ delivered: true, via: 'dm' }),
}));
const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { getPremiumManager, resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { DummyProvider } from '../../src/bot/internalSetup/utils/payment/dummyProvider';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import { runSealed } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { verdictOf } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { clearGlobal, logged, quiet, settleQueue, writePremium } from './nb10PremiumRig';

const role = process.env.BOT_PROCESS_ROLE;
let spies: ReturnType<typeof quiet>;
beforeEach(async () => {
  spies = quiet();
  inject.unstorable.clear();
  await settleQueue();
  resetPremiumManager();
  reg.current = null;
  clearGlobal();
  writePremium();
  process.env.BOT_PROCESS_ROLE = 'bot';
});
afterEach(async () => {
  inject.unstorable.clear();
  resetPremiumManager();
  for (const p of reg.current?.listAll() ?? []) (p as any).dispose?.();
  reg.current = null;
  await settleQueue();
  vi.restoreAllMocks();
});
afterAll(() => {
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe('an unstorable save is final', () => {
  it('premium: not held, no retry armed, and the stop line names the size limit', async () => {
    const manager = getPremiumManager() as any;
    inject.unstorable.add('premium-tiers.json');
    const verdict = await runSealed('console', null, null, async ledger => {
      getPremiumManager().setMessages({ moduleBlocked: 'no' });
      return verdictOf([ledger]);
    });
    expect(verdict).toMatchObject({ ok: false, answer: 'unstorable' });
    expect(manager.saveHeld).toBe(false);
    expect(manager.retryTimer).toBeNull();
    manager.finalStop();
    const lines = logged(spies.error).filter(l => l.includes('premium-tiers.json holds changes'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('too large to store (one write holds at most 4 MiB)');
    expect(lines[0]).not.toContain('the disk refused');
  });

  it('Dummy provider: not held, no retry armed, and the stop line names the size limit', async () => {
    const dummy = new DummyProvider() as any;
    getPaymentRegistry().register(dummy);
    inject.unstorable.add('state.json');
    const reply = await applySharedOp({ op: 'dummy.adminSetVariant', args: { args: [{ variantId: 'v9', label: 'V9', amount: 1, currency: 'USD', durationDays: 1, recurring: false, active: true }] } });
    expect(reply).toMatchObject({ ok: false, answer: 'unstorable' });
    expect(dummy.saveHeld).toBe(false);
    expect(dummy.retryTimer).toBeNull();
    dummy.finalStop();
    const lines = logged(spies.error).filter(l => l.includes('holds changes'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('too large to store (one write holds at most 4 MiB)');
    expect(lines[0]).not.toContain('the disk refused');
  });

  it('premium: a retry of a save held for io that is refused unstorable ends the hold', async () => {
    const manager = getPremiumManager() as any;
    manager.saveHeld = true;
    inject.unstorable.add('premium-tiers.json');
    manager.retryPass();
    expect(manager.saveHeld).toBe(false);
    expect(manager.unstorableSave).toBe(true);
    expect(manager.retryTimer).toBeNull();
    manager.finalStop();
    const lines = logged(spies.error).filter(l => l.includes('premium-tiers.json holds changes'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('one write holds at most 4 MiB');
  });

  it('Dummy provider: a retry of a save held for io that is refused unstorable ends the hold', async () => {
    vi.useFakeTimers();
    try {
      const dummy = new DummyProvider() as any;
      getPaymentRegistry().register(dummy);
      dummy.saveHeld = true;
      inject.unstorable.add('state.json');
      dummy.armRetry();
      vi.advanceTimersByTime(dummy.retryDelay);
      expect(dummy.saveHeld).toBe(false);
      expect(dummy.unstorableSave).toBe(true);
      expect(dummy.retryTimer).toBeNull();
      dummy.finalStop();
      const lines = logged(spies.error).filter(l => l.includes('holds changes'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('one write holds at most 4 MiB');
    } finally {
      vi.useRealTimers();
    }
  });

  it('premium: after a replay refused unstorable, the stop line says the kept provider events apply again', async () => {
    const manager = getPremiumManager() as any;
    manager.raisedMarks = { w1: 3 };
    manager.marksTicket = null;
    inject.unstorable.add('premium-tiers.json');
    getPremiumManager().setMessages({ moduleBlocked: 'replayed' });
    expect(manager.unstorableSave).toBe(true);
    manager.finalStop();
    const lines = logged(spies.error).filter(l => l.includes('premium-tiers.json holds changes'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('one write holds at most 4 MiB');
    expect(lines[0]).toContain('premium-tiers.events.jsonl');
  });

  it('premium: a later saved write clears the unstorable mark', async () => {
    const manager = getPremiumManager() as any;
    inject.unstorable.add('premium-tiers.json');
    getPremiumManager().setMessages({ moduleBlocked: 'first' });
    expect(manager.unstorableSave).toBe(true);
    inject.unstorable.clear();
    getPremiumManager().setMessages({ moduleBlocked: 'second' });
    expect(manager.unstorableSave).toBe(false);
    manager.finalStop();
    expect(logged(spies.error).filter(l => l.includes('premium-tiers.json holds changes'))).toHaveLength(0);
  });
});
