import fs from 'fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const inject = vi.hoisted(() => ({ unstorable: new Set<string>() }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = (await import('../helpers/longConfirm')).longConfirm(await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>());
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
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { runSealed } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { verdictOf } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { clearGlobal, JOURNAL, logged, quiet, settleQueue, writePremium } from './nb10PremiumRig';

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
  reg.current = null;
  fs.rmSync(JOURNAL, { recursive: true, force: true });
  await settleQueue();
  vi.restoreAllMocks();
});
afterAll(() => {
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe('the stop line of an unstorable save with no kept provider events', () => {
  it('names the size limit and the loss, and says nothing of kept events or the journal', async () => {
    const manager = getPremiumManager() as any;
    inject.unstorable.add('premium-tiers.json');
    const verdict = await runSealed('console', null, null, async ledger => {
      getPremiumManager().setMessages({ moduleBlocked: 'no' });
      return verdictOf([ledger]);
    });
    expect(verdict).toMatchObject({ ok: false, answer: 'unstorable' });
    vi.mocked(console.error).mockClear();
    manager.finalStop();
    const lines = logged(spies.error).filter(l => l.includes('premium-tiers.json holds changes'));
    expect(lines).toEqual(['[PremiumManager] premium-tiers.json holds changes too large to store (one write holds at most 4 MiB); they are lost with this stop']);
  });
});

describe('an orphan listed while the journal cannot be read in the bot', () => {
  it('its plan refuses with the journal named, its errno and what to do', async () => {
    fs.mkdirSync(JOURNAL);
    getPaymentRegistry().register({
      id: 'fake', displayName: 'Fake', capabilities: { supportsPause: true }, isConfigured: () => true,
      listSubscriptionsForGuild: async () => [{
        providerSubId: 'orph',
        metadata: { guildId: 'g1', tierId: 'low', offeringId: 'o1', pausedDaysLeft: 5, pausedAt: '2026-11-01T00:00:00.000Z' },
        state: { status: 'paused', startDate: new Date().toISOString(), endDate: new Date(Date.now() + 86_400_000).toISOString(), autoRenew: true },
        display: { amountLabel: '', periodLabel: '', statusLabel: 'paused' },
      }],
      resumeSubscription: async () => undefined,
      pauseSubscription: async () => undefined,
    } as any);
    const pm = getPremiumManager();
    expect(pm.cacheState()).toBe('unreadable');
    const out = await pm.findOrphansForGuild('g1');
    expect(out).toHaveLength(1);
    const plan = out[0].plan as any;
    expect(plan.kind).toBe('refuse');
    expect(plan.reason).toMatch(/^premium-tiers\.events\.jsonl cannot be read in this process \(E[A-Z]+\); make that file readable, then reload the page$/);
    expect(plan.line).toBe(`It cannot be adopted: ${plan.reason}.`);
  });
});
