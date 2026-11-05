import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 L5 survivors (premiumManager.ts, saves, audit lines, the retry and the stop): a refused audit line in the bot
// is held and retried once per timer; a refusal of the stop loses it and logs it under its guild and the stop's
// words; the web UI neither holds nor retries; a disposed manager arms nothing, stops nothing and leaves no timer;
// a save refused in the web UI answers not saved and writes no audit line.

const inject = vi.hoisted(() => ({ refuse: new Map<string, string>(), throwAppend: false, attempts: new Map<string, number>() }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  const ledger = await import('../../src/bot/internalSetup/utils/dataBackends/writeLedger');
  const guard = (filename: string, options: any) => {
    inject.attempts.set(filename, (inject.attempts.get(filename) ?? 0) + 1);
    const cause = inject.refuse.get(filename);
    if (!cause) return;
    ledger.recordRefusal(cause as any, `global:${options.category ?? ''}/${filename}`);
    throw new real.DataBackendUnavailableError(cause as any);
  };
  return {
    ...real,
    saveDataTracked: (f: string, o: any, d: unknown) => { guard(f, o); return real.saveDataTracked(f, o, d); },
    appendDataTracked: (f: string, o: any, l: string) => {
      if (inject.throwAppend) throw new Error('boom');
      guard(f, o);
      return real.appendDataTracked(f, o, l);
    },
  };
});
const deposed = vi.hoisted(() => ({ listeners: [] as Array<(holder: any) => void> }));
vi.mock('../../src/bot/internalSetup/utils/writerLock', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/writerLock')>();
  return { ...real, deposedHolder: () => null, onDeposed: (fn: (holder: any) => void) => { deposed.listeners.push(fn); } };
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

import { PremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { runSealed } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { flushAll } from '../../src/bot/internalSetup/utils/dataManager';
import { AUDIT, clearGlobal, gate, linesOf, logged, quiet, settleQueue, writePremium } from './nb10PremiumRig';

const role = process.env.BOT_PROCESS_ROLE;
const asBot = (bot: boolean) => {
  if (bot) process.env.BOT_PROCESS_ROLE = 'bot';
  else delete process.env.BOT_PROCESS_ROLE;
};
const AUDIT_DOC = 'global:/premium-tiers.audit.jsonl';
const refuse = (file: string, cause = 'storage-failing') => inject.refuse.set(file, cause);
const recover = () => inject.refuse.clear();

let spies: ReturnType<typeof quiet>;
const managers: PremiumManager[] = [];
function loaded(): PremiumManager {
  const pm = new PremiumManager();
  managers.push(pm);
  pm.load();
  return pm;
}
const messageLines = () => linesOf(AUDIT).filter(l => l.action === 'message.update');

beforeEach(async () => {
  spies = quiet();
  recover();
  inject.throwAppend = false;
  inject.attempts.clear();
  await settleQueue();
  reg.current = null;
  clearGlobal();
  writePremium();
  asBot(true);
});
afterEach(async () => {
  vi.useRealTimers();
  for (const pm of managers.splice(0)) pm.dispose();
  recover();
  inject.throwAppend = false;
  vi.restoreAllMocks();
  await settleQueue();
});
afterAll(() => {
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe('a disposed manager', () => {
  it('skips the final stop step: it is not stopped and logs no held save', () => {
    const pm = loaded();
    refuse('premium-tiers.json');
    expect(pm.setMessages({ moduleBlocked: 'x' })).toBe(true);
    pm.dispose();
    spies.error.mockClear();
    pm.finalStop();
    expect(pm.isStopped()).toBe(false);
    expect(logged(spies.error)).toEqual([]);
  });

  it('leaves no retry timer behind', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pm = loaded();
    refuse('premium-tiers.json');
    expect(pm.setMessages({ moduleBlocked: 'x' })).toBe(true);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    pm.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is not stopped by a later deposition, while a live manager is', () => {
    const gone = loaded();
    const live = loaded();
    gone.dispose();
    expect(deposed.listeners.length).toBeGreaterThan(0);
    for (const listener of deposed.listeners) listener({ pid: 4242, role: 'webui' });
    expect(live.isStopped()).toBe(true);
    expect(gone.isStopped()).toBe(false);
  });
});

describe('a save refused in the web UI', () => {
  it('answers not saved and writes no audit line', async () => {
    asBot(false);
    const pm = loaded();
    refuse('premium-tiers.json');
    expect(pm.setMessages({ moduleBlocked: 'x' })).toBe(false);
    recover();
    await settleQueue();
    expect(messageLines()).toEqual([]);
  });
});

describe('an audit line refused by the stop', () => {
  it('is lost and logged under its guild with the stop words', async () => {
    const pm = loaded();
    refuse('premium-tiers.audit.jsonl', 'node-stopping');
    await pm.grantManual('g1', 'high', 30);
    const lost = logged(spies.error).filter(l => l.startsWith('[PremiumManager] The audit line subscription.grant.manual'));
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatch(/^\[PremiumManager\] The audit line subscription\.grant\.manual \(guild g1, [^)]+\) was not written: the bot is stopping; it is lost$/);
    recover();
    await settleQueue();
    expect(linesOf(AUDIT).filter(l => l.action === 'subscription.grant.manual')).toEqual([]);
  });

  it("an orphan cancel's line, written after the stop came, is logged with guild none", async () => {
    const cancel = gate();
    getPaymentRegistry().register({
      id: 'orph', displayName: 'Orph', capabilities: { supportsCancel: true }, isConfigured: () => true,
      cancelSubscription: () => cancel.promise,
    } as any);
    const pm = loaded();
    const done = pm.cancelOrphan('orph', 'px1');
    pm.markStopped('stopping');
    cancel.open();
    expect(await done).toBe(true);
    const lost = logged(spies.error).filter(l => l.startsWith('[PremiumManager] The audit line subscription.cancel.orphan'));
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatch(/^\[PremiumManager\] The audit line subscription\.cancel\.orphan \(guild none, [^)]+\) was not written: the bot is stopping; it is lost$/);
  });
});

describe('an audit line refused in the web UI', () => {
  it('is not marked as retried, so the op is not answered held', async () => {
    asBot(false);
    const pm = loaded();
    refuse('premium-tiers.audit.jsonl');
    const refused = await runSealed('console', null, 'premium', async ledger => {
      expect(pm.setMessages({ moduleBlocked: 'x' })).toBe(true);
      return ledger.refusedDocs().filter(r => r.doc === AUDIT_DOC);
    });
    expect(refused).toEqual([{ cause: 'storage-failing', doc: AUDIT_DOC, seq: expect.any(Number), retried: false }]);
  });
});

describe('an audit line the disk refuses in the bot', () => {
  it('is held and appended by the retry once the disk recovers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pm = loaded();
    refuse('premium-tiers.audit.jsonl');
    expect(pm.setMessages({ moduleBlocked: 'x' })).toBe(true);
    recover();
    vi.advanceTimersByTime(1000);
    vi.useRealTimers();
    await flushAll();
    await settleQueue();
    expect(messageLines()).toHaveLength(1);
  });

  it('a later line waits behind the held one: its op answers held under the held cause, and nothing jumps the order', async () => {
    const pm = loaded();
    refuse('premium-tiers.audit.jsonl');
    expect(pm.setMessages({ moduleBlocked: 'x' })).toBe(true);
    recover();
    const refused = await runSealed('console', null, 'premium', async ledger => {
      expect(pm.setMessages({ moduleBlocked: 'y' })).toBe(true);
      return ledger.refusedDocs().filter(r => r.doc === AUDIT_DOC);
    });
    expect(refused).toEqual([{ cause: 'storage-failing', doc: AUDIT_DOC, seq: expect.any(Number), retried: true }]);
    await settleQueue();
    expect(messageLines()).toEqual([]);
  });

  it('an append that throws is logged as a failed audit write', () => {
    const pm = loaded();
    inject.throwAppend = true;
    expect(pm.setMessages({ moduleBlocked: 'x' })).toBe(true);
    expect(spies.error.mock.calls.some((c: unknown[]) => c[0] === '[PremiumManager] writeAudit failed:')).toBe(true);
  });
});

describe('the retry timer', () => {
  it('two refused saves arm one timer: one retry runs when it fires', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pm = loaded();
    refuse('premium-tiers.json');
    expect(pm.setMessages({ moduleBlocked: 'x' })).toBe(true);
    expect(pm.setMessages({ moduleBlocked: 'y' })).toBe(true);
    expect(inject.attempts.get('premium-tiers.json')).toBe(2);
    vi.advanceTimersByTime(1000);
    expect(inject.attempts.get('premium-tiers.json')).toBe(3);
  });
});
