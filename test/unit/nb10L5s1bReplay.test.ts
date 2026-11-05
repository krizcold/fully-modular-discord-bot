import fs from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 mutation gate, chunk 1 of premiumManager.ts, the replay of premium-tiers.events.jsonl: the replay's audit lines
// queued after the exit drain land as whole lines; a replay dropped at the stop forgets its own lines (so the exit
// log claims none of them lost, also after an earlier replay's marks landed) and keeps another op's install line,
// whose loss the exit log still reports.

const hooks = vi.hoisted(() => ({
  save: null as null | ((file: string) => unknown),
  append: null as null | ((file: string) => unknown),
  confirm: null as null | ((ticket: unknown, ms: number, real: (t: any, ms: number) => Promise<string>) => Promise<string>),
}));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  return {
    ...real,
    saveDataTracked: (f: string, o: any, d: unknown) => (hooks.save?.(f) as any) ?? real.saveDataTracked(f, o, d),
    appendDataTracked: (f: string, o: any, l: string) => (hooks.append?.(f) as any) ?? real.appendDataTracked(f, o, l),
  };
});
vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataBackends/fileBackend')>();
  return {
    ...real,
    confirmFile: (ticket: any, ms: number) => (hooks.confirm ? hooks.confirm(ticket, ms, real.confirmFile as any) : real.confirmFile(ticket, ms)),
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

import {
  getPremiumManager,
  invalidatePremiumCache,
  resetPremiumManager,
  startPremiumTickers,
} from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { flushAll } from '../../src/bot/internalSetup/utils/dataManager';
import { AUDIT, clearGlobal, gate, JOURNAL, logged, paidSub, PREMIUM, quiet, rawOf, settleQueue, state, tick, writePremium } from './nb10PremiumRig';

type Manager = ReturnType<typeof getPremiumManager>;
const role = process.env.BOT_PROCESS_ROLE;
const journalLine = (writer: string, n: number, event: object) => `${JSON.stringify({ writer, n, event })}\n`;
const expired = (providerSubId: string, guildId: string) => ({
  type: 'subscription.expired', providerId: 'discord', providerSubId, guildId,
  state: { ...state('expired'), endDate: new Date(Date.now() - 1000).toISOString() },
});
const failedEvent = { type: 'subscription.renewal-failed', providerId: 'discord', providerSubId: 'nope', guildId: 'g-none', reason: 'card' };
const normal = (pm: Manager) => vi.waitFor(() => expect(pm.cacheState()).toBe('normal'), { timeout: 5000, interval: 10 });

/** Stops the cache when the replay waits for the `at`-th time; `before` runs first. */
function stopAtWait(pm: Manager, at: number, before?: (real: (ledger: any) => Promise<void>) => Promise<void>): () => number {
  const real = pm.settled.bind(pm);
  let calls = 0;
  vi.spyOn(pm, 'settled').mockImplementation(async (ledger: any) => {
    calls += 1;
    if (calls === at) {
      if (before) await before(real);
      pm.markStopped('stopping');
    }
    return real(ledger);
  });
  return () => calls;
}

let spies: ReturnType<typeof quiet>;
beforeAll(() => clearGlobal());
beforeEach(async () => {
  spies = quiet();
  process.env.BOT_PROCESS_ROLE = 'bot';
  hooks.save = null;
  hooks.append = null;
  hooks.confirm = null;
  await settleQueue();
  resetPremiumManager();
  reg.current = null;
  clearGlobal();
});
afterEach(async () => {
  hooks.save = null;
  hooks.append = null;
  hooks.confirm = null;
  resetPremiumManager();
  reg.current = null;
  await settleQueue();
  vi.restoreAllMocks();
});
afterAll(() => {
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe("the replay's audit lines after the exit drain", () => {
  it('land in premium-tiers.audit.jsonl as whole lines, one per event', async () => {
    writePremium({
      g1: { active: paidSub('sA', 'ps0', 'low', 'discord'), paused: [] },
      g2: { active: paidSub('sB', 'ps9', 'low', 'discord'), paused: [] },
    });
    fs.writeFileSync(JOURNAL, journalLine('w1', 1, expired('ps0', 'g1')) + journalLine('w1', 2, expired('ps9', 'g2')));
    // The watch for the marks' save is still waiting when the exit drain lands it.
    hooks.confirm = () => new Promise<string>(() => undefined);
    const pm = getPremiumManager();
    startPremiumTickers();
    await normal(pm);
    await flushAll();
    expect(pm.afterDrain()).toBe(true);
    await settleQueue();
    const lines = (rawOf(AUDIT) ?? '').split('\n').filter(l => l !== '');
    expect(lines.map(l => JSON.parse(l)).map(e => `${e.action}:${e.guildId}`)).toEqual(['subscription.expire.paid:g1', 'subscription.expire.paid:g2']);
  });
});

describe('a replay dropped at the stop', () => {
  async function secondReplayStoppedAt(at: number): Promise<Manager> {
    writePremium({ g1: { active: paidSub('sA', 'ps0', 'low', 'discord'), paused: [] } });
    fs.writeFileSync(JOURNAL, journalLine('w1', 1, failedEvent));
    const pm = getPremiumManager();
    startPremiumTickers();
    await normal(pm);
    // The first replay's marks landed: its journal is gone.
    await vi.waitFor(() => expect(rawOf(JOURNAL)).toBeNull(), { timeout: 5000, interval: 10 });
    fs.writeFileSync(JOURNAL, journalLine('w2', 1, expired('ps0', 'g1')));
    const calls = stopAtWait(pm, at);
    invalidatePremiumCache();
    pm.getFullConfig();
    await vi.waitFor(() => expect(calls()).toBeGreaterThanOrEqual(at), { timeout: 5000, interval: 10 });
    await tick(30);
    expect(pm.isStopped()).toBe(true);
    return pm;
  }

  it('in its loop: the exit log claims none of its lines lost after an earlier replay landed', async () => {
    const pm = await secondReplayStoppedAt(1);
    spies.error.mockClear();
    pm.logLossesAtExit();
    expect(logged(spies.error).filter(l => l.includes('did not reach the disk'))).toEqual([]);
    expect(rawOf(JOURNAL)).not.toBeNull();
  });

  it('at its last wait: the exit log claims none of its lines lost after an earlier replay landed', async () => {
    const pm = await secondReplayStoppedAt(2);
    spies.error.mockClear();
    pm.logLossesAtExit();
    expect(logged(spies.error).filter(l => l.includes('did not reach the disk'))).toEqual([]);
    expect(rawOf(JOURNAL)).not.toBeNull();
  });

  it("keeps another op's install line for a subscription its lines name, and the exit log reports that line's loss", async () => {
    writePremium({ g1: { active: paidSub('sA', 'ps0', 'high', 'discord'), paused: [] } });
    const pause = gate();
    getPaymentRegistry().register({
      id: 'slow', displayName: 'Slow', capabilities: { supportsPause: true }, isConfigured: () => true,
      pauseSubscription: () => pause.promise,
      resumeSubscription: async () => undefined,
    } as any);
    const pm = getPremiumManager();
    startPremiumTickers();
    const never = { kind: 'file', path: AUDIT, seq: 1, record: { landed: 0 } };
    hooks.append = file => (file === 'premium-tiers.audit.jsonl' ? { outcome: 'appended', ticket: never } : undefined);
    // A lower tier bought while High is active waits in the queue; its install line is written after the provider's pause.
    getPaymentRegistry().emitEvent({ type: 'subscription.created', providerId: 'slow', providerSubId: 'ps1', guildId: 'g1', tierId: 'low', offeringId: 'o1', state: state() } as any);
    fs.writeFileSync(JOURNAL, journalLine('w2', 1, expired('ps0', 'g1')));
    const calls = stopAtWait(pm, 1, async real => {
      pause.open();
      await real(undefined);
    });
    invalidatePremiumCache();
    pm.getFullConfig();
    await vi.waitFor(() => expect(calls()).toBeGreaterThanOrEqual(1), { timeout: 5000, interval: 10 });
    await tick(30);
    expect(pm.isStopped()).toBe(true);
    spies.error.mockClear();
    pm.logLossesAtExit();
    const lost = logged(spies.error).filter(l => l.includes('did not reach the disk'));
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatch(/^\[PremiumManager\] The audit line subscription\.install\.paid \(guild g1, subscription ps1\) did not reach the disk before this stop and is lost: \{/);
  });
});

describe('the watch for the save that carries the marks', () => {
  it("a watch whose ticket the disk dropped leaves a later replay's ticket in place: that replay's journal is deleted", async () => {
    writePremium({});
    fs.writeFileSync(JOURNAL, journalLine('w1', 1, failedEvent));
    // The first replay's save gets a ticket that never lands; the disk later answers it dropped.
    let used = false;
    hooks.save = file => {
      if (used || file !== 'premium-tiers.json') return undefined;
      used = true;
      return { outcome: 'saved', ticket: { kind: 'file', path: PREMIUM, seq: 1, record: { landed: 0 } } };
    };
    const first = gate<string>();
    const second = gate();
    let confirms = 0;
    hooks.confirm = (ticket, ms, real) => {
      confirms += 1;
      if (confirms === 1) return first.promise;
      if (confirms === 2) return second.promise.then(() => real(ticket, ms));
      return real(ticket, ms);
    };
    const pm = getPremiumManager();
    startPremiumTickers();
    await normal(pm);
    await vi.waitFor(() => expect(confirms).toBe(1), { timeout: 5000, interval: 10 });
    fs.appendFileSync(JOURNAL, journalLine('w2', 1, failedEvent));
    invalidatePremiumCache();
    pm.getFullConfig();
    await normal(pm);
    await vi.waitFor(() => expect(confirms).toBe(2), { timeout: 5000, interval: 10 });
    first.open('unavailable');
    await tick(10);
    second.open();
    await vi.waitFor(() => expect(rawOf(JOURNAL)).toBeNull(), { timeout: 3000, interval: 10 });
  });
});
