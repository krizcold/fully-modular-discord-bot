import fs from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// premiumManager.ts on a JSON bot (NB10 decision 13, NB6 decisions 47, 63, 64): a failed install forgets its carry; a
// redelivery's audit read judges the file save, skips only real notSaved marks and reads the file again after the
// cache is dropped; a change refused by a deposition at its write logs its audit line as lost to the deposition; a
// stop during a provider call refuses the audit file in the op's ledger. The data facade is the real one, with a hook
// on the premium-tiers.json save.

const hook = vi.hoisted(() => ({ onSave: null as null | ((file: string) => unknown) }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  return {
    ...real,
    saveDataTracked: (f: string, o: any, d: unknown) => {
      const scripted = hook.onSave?.(f);
      if (scripted !== undefined) return scripted;
      return real.saveDataTracked(f, o, d);
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
import { markPaymentLedger, runSealed } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { AUDIT, clearGlobal, gate, linesOf, logged, paidSub, quiet, settleQueue, state, tick, writePremium } from './nb10PremiumRig';

const role = process.env.BOT_PROCESS_ROLE;
const AUDIT_DOC = 'global:/premium-tiers.audit.jsonl';
type Manager = ReturnType<typeof getPremiumManager>;
let cancelGate = gate<unknown>();

function newProcess(): Manager {
  resetPremiumManager();
  reg.current = null;
  getPaymentRegistry().register({
    id: 'fake', displayName: 'Fake', capabilities: { supportsCancel: true }, isConfigured: () => true,
    cancelSubscription: () => cancelGate.promise,
  } as any);
  return getPremiumManager();
}
const created = (providerSubId: string, guildId = 'g1') => ({
  type: 'subscription.created', providerId: 'fake', providerSubId, guildId, tierId: 'low', offeringId: 'o1', state: state(),
});
/** A webhook delivery of the event in a payment op; answers the op's ledger. */
function redeliver(pm: Manager, event: object) {
  return runSealed('console', null, 'premium', async ledger => {
    markPaymentLedger(ledger, 'payment.webhook');
    getPaymentRegistry().emitEvent(event as any);
    await pm.settled(ledger);
    return { refused: ledger.refusedDocs(), tickets: ledger.tickets() };
  });
}
const installLines = () => linesOf(AUDIT).filter(l => l?.action === 'subscription.install.paid');
const auditLine = (entry: object) => `${JSON.stringify({ timestamp: 't', actor: 'admin', ...entry })}\n`;
const withS1 = () => writePremium({ g1: { active: paidSub('s1', 'ps1'), paused: [] } });

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await tick(2);
}

let spies: ReturnType<typeof quiet>;
beforeAll(() => clearGlobal());
beforeEach(async () => {
  spies = quiet();
  hook.onSave = null;
  cancelGate = gate<unknown>();
  await settleQueue();
  resetPremiumManager();
  reg.current = null;
  clearGlobal();
  writePremium();
  process.env.BOT_PROCESS_ROLE = 'bot';
});
afterEach(async () => {
  hook.onSave = null;
  cancelGate.open(undefined);
  resetPremiumManager();
  reg.current = null;
  fs.rmSync(AUDIT, { recursive: true, force: true });
  vi.restoreAllMocks();
  await settleQueue();
});
afterAll(() => {
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe('an install that fails', () => {
  it('leaves none of its audit line and notice for the exit to report', async () => {
    withS1();
    const pm = newProcess();
    getPaymentRegistry().emitEvent(created('ps9') as any);
    await until(() => logged(spies.error).some(l => l.includes('installAsyncSubscription failed')));
    expect(logged(spies.error).filter(l => l.includes('installAsyncSubscription failed'))).toHaveLength(1);
    spies.error.mockClear();
    spies.warn.mockClear();
    pm.markStopped('stopping');
    pm.logLossesAtExit();
    expect(logged(spies.error).filter(l => l.includes('subscription.install.paid'))).toEqual([]);
    expect(logged(spies.warn).filter(l => l.includes('paid.sub.started'))).toEqual([]);
  });
});

describe("a redelivery's read of the audit file", () => {
  it('that fails still judges a save of premium-tiers.json in the op', async () => {
    withS1();
    fs.mkdirSync(AUDIT);
    const pm = newProcess();
    const ledger = await redeliver(pm, created('ps1'));
    expect(ledger.refused.filter(r => r.doc === AUDIT_DOC).map(r => r.cause)).toEqual(['io']);
    expect(ledger.tickets).toHaveLength(1);
  });

  it('counts an install line whose metadata is null', async () => {
    withS1();
    fs.writeFileSync(AUDIT, auditLine({ action: 'subscription.install.paid', guildId: 'g1', subscriptionId: 's1', metadata: null }));
    const pm = newProcess();
    const ledger = await redeliver(pm, created('ps1'));
    await settleQueue();
    expect(ledger.refused).toEqual([]);
    expect(logged(spies.error).filter(l => l.includes('installAsyncSubscription failed'))).toEqual([]);
    expect(installLines()).toHaveLength(1);
  });

  it('counts an install line whose metadata is text', async () => {
    withS1();
    fs.writeFileSync(AUDIT, auditLine({ action: 'subscription.install.paid', guildId: 'g1', subscriptionId: 's1', metadata: 'notSaved' }));
    const pm = newProcess();
    const ledger = await redeliver(pm, created('ps1'));
    await settleQueue();
    expect(ledger.refused).toEqual([]);
    expect(logged(spies.error).filter(l => l.includes('installAsyncSubscription failed'))).toEqual([]);
    expect(installLines()).toHaveLength(1);
  });

  it('is made again after the cache is dropped, for a line read from the file', async () => {
    withS1();
    fs.writeFileSync(AUDIT, auditLine({ action: 'subscription.install.paid', guildId: 'g1', subscriptionId: 's1' }));
    const pm = newProcess();
    await redeliver(pm, created('ps1'));
    await settleQueue();
    expect(installLines()).toHaveLength(1);
    fs.rmSync(AUDIT, { force: true });
    pm.invalidate();
    await redeliver(pm, created('ps1'));
    await settleQueue();
    const lines = installLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ subscriptionId: 's1', metadata: { redelivered: true } });
  });

  it('is made again after the cache is dropped, for a line this process wrote and landed', async () => {
    const pm = newProcess();
    getPaymentRegistry().emitEvent(created('psN', 'g3') as any);
    await pm.settled(undefined);
    await settleQueue();
    expect(installLines()).toHaveLength(1);
    fs.rmSync(AUDIT, { force: true });
    pm.invalidate();
    await redeliver(pm, created('psN', 'g3'));
    await settleQueue();
    const lines = installLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ guildId: 'g3', metadata: { redelivered: true } });
  });
});

describe('a change refused by a deposition found at its write', () => {
  it('logs its audit line as lost to the deposition', async () => {
    const pm = newProcess();
    pm.getMessages();
    hook.onSave = file => {
      if (file !== 'premium-tiers.json') return undefined;
      pm.markStopped('deposed');
      return { outcome: 'refused', cause: 'writer-lost' };
    };
    expect(pm.setMessages({ upgradeButtonLabel: 'Lost' })).toBe(false);
    const lines = logged(spies.error).filter(l => l.includes('The audit line message.update'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[PremiumManager\] The audit line message\.update \(guild none, [^)]+\) was not written: another process took the data files; it is lost$/);
  });
});

describe('a stop during the provider call of a cancel', () => {
  it('refuses the audit file in the op, beside premium-tiers.json', async () => {
    withS1();
    const pm = newProcess();
    const refused = await runSealed('console', null, 'premium', async ledger => {
      const cancelled = pm.cancelPaidSubscription('g1');
      await tick(2);
      pm.markStopped('stopping');
      cancelGate.open(state());
      expect(await cancelled).toBe(false);
      return ledger.refusedDocs().map(r => ({ cause: r.cause, doc: r.doc }));
    });
    expect(refused).toContainEqual({ cause: 'node-stopping', doc: AUDIT_DOC });
    expect(refused).toContainEqual({ cause: 'node-stopping', doc: 'global:/premium-tiers.json' });
  });
});
