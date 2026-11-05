import fs from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 mutation gate, chunk 4 of premiumManager.ts: the replay of premium-tiers.events.jsonl. The marks never go
// down; a stop during the replay's last wait writes nothing; a failed save step is logged as such and premium runs
// on; the watch for the save that carries the marks drops a ticket the disk dropped, stops with the cache, and
// reports its own failure; an event journaled after the replay's last read keeps the journal.

const reg = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  return { ...real, getPaymentRegistry: () => (reg.current ??= new real.PaymentProviderRegistry()) };
});
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async () => ({ delivered: true, via: 'dm' }),
}));
const hooks = vi.hoisted(() => ({
  save: null as null | ((file: string) => unknown),
  append: null as null | ((file: string) => void),
  confirm: null as null | ((ticket: unknown, ms: number, real: (t: any, ms: number) => Promise<string>) => Promise<string>),
  deletes: [] as number[],
}));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  return {
    ...real,
    saveDataTracked: (f: string, o: any, d: unknown) => {
      const faked = hooks.save?.(f);
      return faked ?? real.saveDataTracked(f, o, d);
    },
    appendDataTracked: (f: string, o: any, l: string) => {
      hooks.append?.(f);
      return real.appendDataTracked(f, o, l);
    },
    deleteDataTracked: (f: string, o: any) => {
      if (f === 'premium-tiers.events.jsonl') hooks.deletes.push(performance.now());
      return real.deleteDataTracked(f, o);
    },
  };
});
vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataBackends/fileBackend')>();
  return {
    ...real,
    confirmFile: (ticket: any, ms: number) => (hooks.confirm ? hooks.confirm(ticket, ms, real.confirmFile as any) : real.confirmFile(ticket, ms)),
  };
});

import { getPremiumManager, resetPremiumManager, startPremiumTickers } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import { outsideLedgers } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { AUDIT, clearGlobal, JOURNAL, jsonOf, linesOf, logged, paidSub, PREMIUM, quiet, rawOf, settleQueue, state, tick, writePremium } from './nb10PremiumRig';

type Manager = ReturnType<typeof getPremiumManager>;
const role = process.env.BOT_PROCESS_ROLE;
const later = new Date(Date.now() + 90 * 86_400_000).toISOString();
const expired = (providerSubId: string, guildId: string, providerId = 'discord') => ({ type: 'subscription.expired', providerId, providerSubId, guildId, state: { ...state('expired'), endDate: new Date(Date.now() - 1000).toISOString() } });
const renewed = (providerSubId: string, guildId: string, providerId = 'dummy') => ({ type: 'subscription.renewed', providerId, providerSubId, guildId, state: { ...state(), endDate: later } });
const subs = () => ({
  g1: { active: paidSub('s1', 'd1', 'low', 'discord'), paused: [] },
  g2: { active: paidSub('s2', 'dm1', 'low', 'dummy'), paused: [] },
});
const journalLine = (writer: string, n: number, event: object) => `${JSON.stringify({ writer, n, event })}\n`;
const fakeTicket = () => ({ kind: 'file' as const, path: PREMIUM, seq: 1, record: { landed: 0 } });

function newProcess(): Manager {
  resetPremiumManager();
  reg.current = null;
  return getPremiumManager();
}

/** Runs fn when the replay waits for the last time, after its loop handed `handed` events. */
function atLastWait(pm: Manager, handed: number, fn: () => void): void {
  const real = pm.settled.bind(pm);
  let calls = 0;
  vi.spyOn(pm, 'settled').mockImplementation((ledger: any) => {
    calls += 1;
    if (calls === handed + 1) fn();
    return real(ledger);
  });
}

/** One journaled expiry for g1 above the marks; the save after the replay gets a ticket that never lands. */
function replayWithLostTicket(): { pm: Manager; ticket: ReturnType<typeof fakeTicket> } {
  writePremium(subs());
  fs.writeFileSync(JOURNAL, journalLine('w1', 1, expired('d1', 'g1')));
  const pm = newProcess();
  const ticket = fakeTicket();
  atLastWait(pm, 1, () => {
    let used = false;
    hooks.save = file => {
      if (used || file !== 'premium-tiers.json') return undefined;
      used = true;
      return { outcome: 'saved', ticket };
    };
  });
  return { pm, ticket };
}

const normal = (pm: Manager) => vi.waitFor(() => expect(pm.cacheState()).toBe('normal'), { timeout: 5000, interval: 10 });

let spies: ReturnType<typeof quiet>;
beforeAll(() => clearGlobal());
beforeEach(async () => {
  spies = quiet();
  process.env.BOT_PROCESS_ROLE = 'bot';
  hooks.save = null;
  hooks.append = null;
  hooks.confirm = null;
  hooks.deletes = [];
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

describe('the replay and its marks', () => {
  it('a writer whose lines were all covered keeps its higher mark when another writer is applied', async () => {
    writePremium(subs(), { eventsApplied: { w1: 5 } });
    fs.writeFileSync(JOURNAL, journalLine('w1', 1, renewed('dm1', 'g2')) + journalLine('w2', 1, expired('d1', 'g1')));
    const pm = newProcess();
    startPremiumTickers();
    await normal(pm);
    await vi.waitFor(() => expect(rawOf(JOURNAL)).toBeNull(), { timeout: 5000, interval: 10 });
    await settleQueue();
    const saved = jsonOf(PREMIUM);
    expect(saved.eventsApplied).toEqual({ w1: 5, w2: 1 });
    expect(saved.subscriptions.g1.active).toBeUndefined();
  });

  it('a stop during the last wait writes nothing and leaves the replay unfinished', async () => {
    writePremium(subs());
    fs.writeFileSync(JOURNAL, journalLine('w1', 1, expired('d1', 'g1')));
    const before = rawOf(PREMIUM);
    const pm = newProcess();
    let stopped = false;
    atLastWait(pm, 1, () => { pm.markStopped('stopping'); stopped = true; });
    startPremiumTickers();
    await vi.waitFor(() => expect(stopped).toBe(true), { timeout: 5000, interval: 10 });
    await tick(30);
    await settleQueue();
    expect(rawOf(PREMIUM)).toBe(before);
    expect(pm.cacheState()).toBe('replaying');
    expect(rawOf(JOURNAL)).not.toBeNull();
  });

  it('a save step that throws is logged as the save step, and premium runs normally', async () => {
    writePremium(subs());
    fs.writeFileSync(JOURNAL, journalLine('w1', 1, expired('d1', 'g1')));
    const pm = newProcess();
    atLastWait(pm, 1, () => {
      vi.spyOn(pm as any, 'writeCache').mockImplementationOnce(() => { throw new Error('disk gone'); });
    });
    startPremiumTickers();
    await vi.waitFor(() => expect(logged(spies.error)).toContain("[PremiumManager] The replay's save step failed (disk gone)"), { timeout: 5000, interval: 10 });
    expect(pm.cacheState()).toBe('normal');
    expect(logged(spies.error).some(l => l.includes('The replay of premium-tiers.events.jsonl failed'))).toBe(false);
  });

  it('an event journaled after the replay read its last line keeps the journal file', async () => {
    writePremium(subs());
    fs.writeFileSync(JOURNAL, journalLine('w1', 1, expired('d1', 'g1')));
    const pm = newProcess();
    atLastWait(pm, 1, () => outsideLedgers(() => getPaymentRegistry().emitEvent(renewed('dm1', 'g2') as any)));
    startPremiumTickers();
    await normal(pm);
    await vi.waitFor(() => expect(linesOf(AUDIT).some(l => l.action === 'subscription.expire.paid')).toBe(true), { timeout: 5000, interval: 10 });
    await settleQueue();
    const kept = linesOf(JOURNAL);
    expect(kept.map(l => l.event.providerSubId)).toEqual(['d1', 'dm1']);
    expect(hooks.deletes).toEqual([]);
  });

  it('an append of the replay audit lines that throws is logged as that append', async () => {
    writePremium(subs());
    fs.writeFileSync(JOURNAL, journalLine('w1', 1, expired('d1', 'g1')));
    const pm = newProcess();
    atLastWait(pm, 1, () => {
      hooks.append = file => {
        if (file !== 'premium-tiers.audit.jsonl') return;
        throw new Proxy({}, { getPrototypeOf() { throw new Error('disk gone'); } });
      };
    });
    startPremiumTickers();
    await vi.waitFor(() => expect(logged(spies.error)).toContain("[PremiumManager] The append of the replay's audit lines failed (disk gone)"), { timeout: 5000, interval: 10 });
    expect(logged(spies.error).some(l => l.includes("The watch for the replay's save failed"))).toBe(false);
  });
});

describe("the watch for the replay's save", () => {
  it('a ticket the disk dropped is let go, and the next save that lands deletes the journal', async () => {
    const { pm, ticket } = replayWithLostTicket();
    hooks.confirm = (t, ms, real) => (t === ticket ? Promise.resolve('unavailable') : real(t, ms));
    startPremiumTickers();
    await normal(pm);
    await tick(20);
    expect(await applySharedOp({ op: 'premium.setMessages', args: { args: [{ moduleBlocked: 'x' }] } })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(rawOf(JOURNAL)).toBeNull(), { timeout: 4000, interval: 20 });
    await settleQueue();
    expect(jsonOf(PREMIUM).eventsApplied).toEqual({ w1: 1 });
    expect(linesOf(AUDIT).some(l => l.action === 'subscription.expire.paid')).toBe(true);
  });

  it('a watch that throws logs its failure', async () => {
    const { pm, ticket } = replayWithLostTicket();
    hooks.confirm = (t, ms, real) => (t === ticket ? Promise.reject(new Error('disk gone')) : real(t, ms));
    startPremiumTickers();
    await normal(pm);
    await vi.waitFor(() => expect(logged(spies.error)).toContain("[PremiumManager] The watch for the replay's save failed (disk gone)"), { timeout: 3000, interval: 10 });
  });

  it('the watch ends with the stop and asks the disk nothing more', async () => {
    const { pm, ticket } = replayWithLostTicket();
    let asked = 0;
    hooks.confirm = (t, ms, real) => {
      if (t !== ticket) return real(t, ms);
      asked += 1;
      if (asked === 1) pm.markStopped('stopping');
      return Promise.resolve('pending');
    };
    startPremiumTickers();
    await vi.waitFor(() => expect(asked).toBe(1), { timeout: 5000, interval: 10 });
    await tick(1300);
    expect(asked).toBe(1);
  });

  it('a save that lands deletes the journal without waiting for the idle pause', async () => {
    writePremium(subs());
    fs.writeFileSync(JOURNAL, journalLine('w1', 1, expired('d1', 'g1')));
    const okAt: number[] = [];
    hooks.confirm = (t, ms, real) => real(t, ms).then(answer => {
      if (answer === 'ok') okAt.push(performance.now());
      return answer;
    });
    const pm = newProcess();
    startPremiumTickers();
    await normal(pm);
    await vi.waitFor(() => expect(hooks.deletes.length).toBeGreaterThan(0), { timeout: 4000, interval: 10 });
    expect(okAt.length).toBeGreaterThan(0);
    expect(hooks.deletes[0] - okAt[0]).toBeLessThan(800);
  });
});
