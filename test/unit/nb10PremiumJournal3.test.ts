import fs from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 test 41, the cases neither nb10PremiumJournal.test.ts nor nb10PremiumJournal2.test.ts holds: (b) a journal line
// whose flush keeps failing at a stop, (c) the file fixed while a line is still queued, (g) a Discord command's save and
// premium-tiers.json's writes during the replay, (h) a crash inside the replay before its save, (i) a crash before the
// delete with the last line never landed, and the second half of (iii) (a throw in the replay's settle-and-save step).

const inject = vi.hoisted(() => ({ deleteThrows: false, saveThrowsOnce: false }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  return {
    ...real,
    saveDataTracked: (f: string, o: any, d: unknown) => {
      if (inject.saveThrowsOnce && f === 'premium-tiers.json') {
        inject.saveThrowsOnce = false;
        throw new Error('injected crash before the save');
      }
      return real.saveDataTracked(f, o, d);
    },
    deleteDataTracked: (f: string, o: any) => {
      if (inject.deleteThrows) throw new Error('injected delete failure');
      return real.deleteDataTracked(f, o);
    },
  };
});
const reg = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  return { ...real, getPaymentRegistry: () => (reg.current ??= new real.PaymentProviderRegistry()) };
});
const notices = vi.hoisted(() => ({ sent: [] as string[] }));
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async (guildId: string, kind: string) => {
    notices.sent.push(`${kind}:${guildId}`);
    return { delivered: true, via: 'dm' };
  },
}));

import { getPremiumManager, resetPremiumManager, startPremiumTickers } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import { runSealed } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { verdictOf } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { cancelQueued, queuedFilePaths } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { AUDIT, clearGlobal, gate, JOURNAL, jsonOf, linesOf, logged, paidSub, PREMIUM, quiet, rawOf, settleQueue, state, tick, writePremium } from './nb10PremiumRig';

const role = process.env.BOT_PROCESS_ROLE;
const later = new Date(Date.now() + 90 * 86_400_000).toISOString();
const expired = (providerSubId: string, guildId: string) => ({ type: 'subscription.expired', providerId: 'discord', providerSubId, guildId, state: { ...state('expired'), endDate: new Date(Date.now() - 1000).toISOString() } });
const renewed = (providerSubId: string, guildId: string) => ({ type: 'subscription.renewed', providerId: 'dummy', providerSubId, guildId, state: { ...state(), endDate: later } });
const createdEvent = (providerSubId: string, guildId: string, providerId: string) => ({ type: 'subscription.created', providerId, providerSubId, guildId, tierId: 'low', offeringId: 'o1', state: state() });
const subs = () => ({
  g1: { active: paidSub('s1', 'd1', 'low', 'discord'), paused: [] },
  g2: { active: paidSub('s2', 'dm1', 'low', 'dummy'), paused: [] },
  g3: { active: paidSub('s3', 'd3', 'low', 'discord'), paused: [] },
});
const manualHigh = () => ({ id: 'm1', tierId: 'high', source: 'manual', startDate: new Date().toISOString(), endDate: null, autoRenew: false, status: 'active', createdAt: '', updatedAt: '' });
const allLogs = (): string[] => [...logged(spies.warn), ...logged(spies.error)];
const realNow = Date.now.bind(Date);

let pause = gate();
function registerFake(): void {
  getPaymentRegistry().register({
    id: 'fake', displayName: 'Fake', capabilities: { supportsPause: true }, isConfigured: () => true,
    pauseSubscription: () => pause.promise,
    cancelSubscription: vi.fn(async () => undefined),
  } as any);
}

function newProcess(): ReturnType<typeof getPremiumManager> {
  resetPremiumManager();
  reg.current = null;
  registerFake();
  return getPremiumManager();
}

/** The process dies: what it still had queued for these files never lands. */
async function dies(pm: ReturnType<typeof getPremiumManager>, ...files: string[]): Promise<void> {
  pm.finalStop();
  await cancelQueued(files.filter(f => queuedFilePaths().includes(f)));
}

/** Appends to the journal fail with EIO while `on`; returns the switch. */
function failingAppend(): { on: boolean; calls: number } {
  const sw = { on: true, calls: 0 };
  const real = fs.promises.appendFile.bind(fs.promises);
  vi.spyOn(fs.promises, 'appendFile').mockImplementation((async (p: any, data: any, options?: any) => {
    if (String(p) === JOURNAL) {
      sw.calls += 1;
      if (sw.on) throw Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' });
    }
    return real(p, data, options);
  }) as typeof fs.promises.appendFile);
  return sw;
}

/** Date.now runs ahead by ms, so the 5 s load retry is due without waiting for it. */
function aheadBy(ms: number): void {
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + ms);
}

/** The renames that landed onto premium-tiers.json from here on. */
function countRenames(): { count: number } {
  const seen = { count: 0 };
  const real = fs.promises.rename.bind(fs.promises);
  vi.spyOn(fs.promises, 'rename').mockImplementation((async (from: fs.PathLike, to: fs.PathLike) => {
    await real(from, to);
    if (String(to) === PREMIUM) seen.count += 1;
  }) as typeof fs.promises.rename);
  return seen;
}

/** Journals the events in a new process with premium-tiers.json broken; the last `failing` lines never reach the disk. */
async function journalWhileBroken(events: object[], failing = 0): Promise<{ pm: ReturnType<typeof getPremiumManager>; append: { on: boolean } | null }> {
  fs.writeFileSync(PREMIUM, '{ broken');
  const pm = newProcess();
  expect(pm.cacheState()).toBe('unreadable');
  const landedCount = events.length - failing;
  for (const event of events.slice(0, landedCount)) getPaymentRegistry().emitEvent(event as any);
  await settleQueue();
  expect(linesOf(JOURNAL)).toHaveLength(landedCount);
  let append: { on: boolean } | null = null;
  if (failing > 0) {
    append = failingAppend();
    for (const event of events.slice(landedCount)) getPaymentRegistry().emitEvent(event as any);
    await tick(50);
    expect(linesOf(JOURNAL)).toHaveLength(landedCount);
  }
  return { pm, append };
}

let spies: ReturnType<typeof quiet>;
beforeAll(() => clearGlobal());
beforeEach(async () => {
  spies = quiet();
  inject.deleteThrows = false;
  inject.saveThrowsOnce = false;
  await settleQueue();
  resetPremiumManager();
  reg.current = null;
  notices.sent = [];
  clearGlobal();
  pause = gate();
  pause.open();
  process.env.BOT_PROCESS_ROLE = 'bot';
  registerFake();
});
afterEach(async () => {
  inject.deleteThrows = false;
  inject.saveThrowsOnce = false;
  pause.open();
  await cancelQueued(queuedFilePaths().filter(f => f === JOURNAL));
  vi.restoreAllMocks();
  resetPremiumManager();
  reg.current = null;
  await settleQueue();
  fs.rmSync(PREMIUM, { recursive: true, force: true });
});
afterAll(() => {
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe('NB10 test 41, the remaining cases', () => {
  it("(b) a journal line whose flush keeps failing at a stop: the exit handler logs the event as lost, with provider, type, providerSubId and guild", async () => {
    const { pm } = await journalWhileBroken([expired('d1', 'g1')], 1);
    expect(queuedFilePaths()).toContain(JOURNAL);
    pm.finalStop();
    spies.error.mockClear();
    pm.logLossesAtExit();
    const lost = logged(spies.error).filter(l => l.includes('lost'));
    expect(lost).toHaveLength(1);
    expect(lost[0]).toContain('subscription.expired event from discord (subscription d1, guild g1)');
    expect(lost[0]).toContain(JSON.stringify(expired('d1', 'g1')).slice(0, 40));
    expect(rawOf(JOURNAL)).toBeNull();
  });

  it('(c) the file fixed while the line is queued: the replay applies it once from memory, the mark covers it, and the line landing after a crash applies nothing twice', async () => {
    const { pm, append } = await journalWhileBroken([expired('d1', 'g1')], 1);
    writePremium(subs());
    inject.deleteThrows = true;
    aheadBy(6_000);
    expect(pm.getAllTiers()).toBeTruthy();
    startPremiumTickers();
    await vi.waitFor(() => expect(pm.cacheState()).toBe('normal'), { timeout: 5000, interval: 20 });
    await vi.waitFor(() => expect(jsonOf(PREMIUM)?.eventsApplied).toBeTruthy(), { timeout: 5000, interval: 20 });
    const marks = jsonOf(PREMIUM).eventsApplied;
    expect(Object.values(marks)).toEqual([1]);
    expect(jsonOf(PREMIUM).subscriptions.g1.active).toBeUndefined();
    expect(notices.sent).toEqual(['paid.sub.expired:g1']);
    append!.on = false;
    await vi.waitFor(() => expect(linesOf(JOURNAL)).toHaveLength(1), { timeout: 10_000, interval: 50 });
    await dies(pm, JOURNAL, PREMIUM);
    const after = rawOf(PREMIUM);

    const next = newProcess();
    startPremiumTickers();
    await vi.waitFor(() => expect(next.cacheState()).toBe('normal'), { timeout: 5000, interval: 20 });
    await settleQueue();
    expect(notices.sent).toEqual(['paid.sub.expired:g1']);
    expect(jsonOf(PREMIUM).subscriptions).toEqual(JSON.parse(after!).subscriptions);
    expect(jsonOf(PREMIUM).eventsApplied).toEqual(marks);
  }, 30_000);

  it('(i) J1 to J3 with J3 never landing: the replay hands all three and saves, a crash comes before the delete, and the next load hands nothing', async () => {
    const { pm } = await journalWhileBroken([expired('d1', 'g1'), renewed('dm1', 'g2'), expired('d3', 'g3')], 1);
    writePremium(subs());
    inject.deleteThrows = true;
    aheadBy(6_000);
    expect(pm.getAllTiers()).toBeTruthy();
    startPremiumTickers();
    await vi.waitFor(() => expect(jsonOf(PREMIUM)?.eventsApplied).toBeTruthy(), { timeout: 5000, interval: 20 });
    expect(Object.values(jsonOf(PREMIUM).eventsApplied)).toEqual([3]);
    await vi.waitFor(() => expect(allLogs().some(l => l.startsWith('[PremiumManager] premium-tiers.events.jsonl could not be deleted'))).toBe(true), { timeout: 5000, interval: 20 });
    await dies(pm, JOURNAL, PREMIUM);
    expect(linesOf(JOURNAL).map(l => l.n)).toEqual([1, 2]);
    const saved = rawOf(PREMIUM);
    const sent = [...notices.sent].sort();
    expect(sent).toEqual(['paid.sub.expired:g1', 'paid.sub.expired:g3']);

    inject.deleteThrows = false;
    const next = newProcess();
    startPremiumTickers();
    await vi.waitFor(() => expect(next.cacheState()).toBe('normal'), { timeout: 5000, interval: 20 });
    await vi.waitFor(() => expect(rawOf(JOURNAL)).toBeNull(), { timeout: 5000, interval: 20 });
    await settleQueue();
    expect([...notices.sent].sort()).toEqual(sent);
    const now = jsonOf(PREMIUM);
    expect(now.subscriptions).toEqual(JSON.parse(saved!).subscriptions);
    expect(now.subscriptions.g1.active).toBeUndefined();
    expect(now.subscriptions.g2.active.endDate).toBe(later);
    expect(now.subscriptions.g3.active).toBeUndefined();
  }, 30_000);

  it('(h) a crash inside the replay before its save: the next load hands every entry again and the file holds each effect once', async () => {
    await journalWhileBroken([createdEvent('ent1', 'g4', 'discord'), renewed('dm1', 'g2')]);
    writePremium(subs());
    const before = rawOf(PREMIUM);
    inject.saveThrowsOnce = true;
    let pm = newProcess();
    startPremiumTickers();
    await vi.waitFor(() => expect(inject.saveThrowsOnce).toBe(false), { timeout: 5000, interval: 20 });
    await dies(pm, JOURNAL, PREMIUM, AUDIT);
    expect(rawOf(PREMIUM)).toBe(before);
    expect(linesOf(JOURNAL)).toHaveLength(2);

    pm = newProcess();
    startPremiumTickers();
    await vi.waitFor(() => expect(pm.cacheState()).toBe('normal'), { timeout: 5000, interval: 20 });
    await vi.waitFor(() => expect(rawOf(JOURNAL)).toBeNull(), { timeout: 5000, interval: 20 });
    await settleQueue();
    const saved = jsonOf(PREMIUM);
    expect(saved.subscriptions.g4.active.providerSubId).toBe('ent1');
    expect(saved.subscriptions.g4.paused).toEqual([]);
    expect(saved.subscriptions.g2.active.endDate).toBe(later);
    expect(linesOf(AUDIT).filter(l => l.action === 'subscription.install.paid')).toHaveLength(1);
  }, 30_000);

  it("(iii) a throw in the replay's settle-and-save step: the cache is unreadable naming the journal and the error, the journal stays, and the next load retry replays it", async () => {
    await journalWhileBroken([expired('d1', 'g1'), renewed('dm1', 'g2')]);
    writePremium(subs());
    const pm = newProcess();
    vi.spyOn(pm, 'settled').mockRejectedValueOnce(new Error('injected settle failure'));
    startPremiumTickers();
    await vi.waitFor(() => expect(pm.cacheState()).toBe('unreadable'), { timeout: 5000, interval: 10 });
    expect(pm.unreadableText()).toBe('premium-tiers.events.jsonl cannot be read (injected settle failure); nothing was saved. Make that file readable (premium-tiers.json itself is fine), then try again.');
    expect(linesOf(JOURNAL)).toHaveLength(2);
    expect(jsonOf(PREMIUM).subscriptions.g1.active).toBeTruthy();

    aheadBy(6_000);
    expect(pm.getAllTiers()).toBeTruthy();
    await vi.waitFor(() => expect(pm.cacheState()).toBe('normal'), { timeout: 5000, interval: 20 });
    await vi.waitFor(() => expect(rawOf(JOURNAL)).toBeNull(), { timeout: 5000, interval: 20 });
    await settleQueue();
    const saved = jsonOf(PREMIUM);
    expect(saved.subscriptions.g1.active).toBeUndefined();
    expect(saved.subscriptions.g2.active.endDate).toBe(later);
  }, 30_000);

  it("(g) during the replay a setTier answers the applying text, a Discord command's save answers not saved, and premium-tiers.json is written once", async () => {
    writePremium({ g1: { active: manualHigh(), paused: [] } });
    fs.writeFileSync(PREMIUM, '{ broken');
    newProcess();
    getPaymentRegistry().emitEvent(createdEvent('ps1', 'g1', 'fake') as any);
    await settleQueue();
    writePremium({ g1: { active: manualHigh(), paused: [] } });
    pause = gate();
    const renames = countRenames();
    const pm = newProcess();
    startPremiumTickers();
    await vi.waitFor(() => expect(pm.cacheState()).toBe('replaying'), { timeout: 5000, interval: 10 });
    const op: any = await applySharedOp({ op: 'premium.setTier', args: { args: ['low', { displayName: 'L', priority: 1, overrides: {}, offerings: [] }] } });
    expect(op).toMatchObject({ ok: false });
    expect(op.error).toContain('Premium is applying provider events');
    const command = await runSealed('interaction', null, 'mod', async ledger => {
      const ok = pm.setMessages({ moduleBlocked: 'from a command' } as any);
      return { ok, verdict: await verdictOf([ledger]) };
    });
    expect(command.ok).toBe(false);
    expect(command.verdict).toMatchObject({ ok: false });
    pause.open();
    await vi.waitFor(() => expect(pm.cacheState()).toBe('normal'), { timeout: 5000, interval: 20 });
    await vi.waitFor(() => expect(rawOf(JOURNAL)).toBeNull(), { timeout: 5000, interval: 20 });
    await settleQueue();
    expect(renames.count).toBe(1);
    const saved = jsonOf(PREMIUM);
    expect(saved.tiers.low.displayName).toBe('Low');
    expect(JSON.stringify(saved.messages)).not.toContain('from a command');
    expect(saved.subscriptions.g1.paused.map((s: any) => s.providerSubId)).toEqual(['ps1']);
  }, 30_000);
});
