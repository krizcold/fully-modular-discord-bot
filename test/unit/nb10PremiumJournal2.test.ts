import fs from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 test 41, the cases nb10PremiumJournal.test.ts does not hold: (ii) a delete that keeps failing across starts,
// (iv) an op in S5 that triggers the load, (v) changes refused during the replay, (e) a member interaction that
// triggers the load, (vii) a cut append and its retry, (ix) a throw in the delete step, (xii) a covered journal whose
// unlink fails, and (xiii) (the replay's save failing ENOSPC, or refused with its line, at a stop).

const inject = vi.hoisted(() => ({ refuse: new Map<string, string>(), deleteThrows: false }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  const ledger = await import('../../src/bot/internalSetup/utils/dataBackends/writeLedger');
  const guard = (filename: string, options: any) => {
    const cause = inject.refuse.get(filename);
    if (!cause) return;
    ledger.recordRefusal(cause as any, `global:${options.category ?? ''}/${filename}`);
    throw new real.DataBackendUnavailableError(cause as any);
  };
  return {
    ...real,
    saveDataTracked: (f: string, o: any, d: unknown) => { guard(f, o); return real.saveDataTracked(f, o, d); },
    appendDataTracked: (f: string, o: any, l: string) => { guard(f, o); return real.appendDataTracked(f, o, l); },
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
import { dataPath } from '../../src/utils/dataRoot';
import { failFlushes } from '../helpers/configRig';
import { AUDIT, clearGlobal, gate, JOURNAL, jsonOf, linesOf, logged, paidSub, PREMIUM, quiet, rawOf, settleQueue, state, tick, writePremium } from './nb10PremiumRig';

const role = process.env.BOT_PROCESS_ROLE;
const later = new Date(Date.now() + 90 * 86_400_000).toISOString();
const expired = (providerSubId: string, guildId: string) => ({ type: 'subscription.expired', providerId: 'discord', providerSubId, guildId, state: { ...state('expired'), endDate: new Date(Date.now() - 1000).toISOString() } });
const renewed = (providerSubId: string, guildId: string) => ({ type: 'subscription.renewed', providerId: 'dummy', providerSubId, guildId, state: { ...state(), endDate: later } });
const createdEvent = (providerSubId: string, guildId: string, providerId: string) => ({ type: 'subscription.created', providerId, providerSubId, guildId, tierId: 'low', offeringId: 'o1', state: state() });
const subs = () => ({
  g1: { active: paidSub('s1', 'd1', 'low', 'discord'), paused: [] },
  g2: { active: paidSub('s2', 'dm1', 'low', 'dummy'), paused: [] },
});
const journalLine = (writer: string, n: number, event: object) => `${JSON.stringify({ writer, n, event })}\n`;
const manualHigh = () => ({ id: 'm1', tierId: 'high', source: 'manual', startDate: new Date().toISOString(), endDate: null, autoRenew: false, status: 'active', createdAt: '', updatedAt: '' });
const allLogs = (): string[] => [...logged(spies.warn), ...logged(spies.error)];

let pause = gate();
function registerFake(): void {
  getPaymentRegistry().register({
    id: 'fake', displayName: 'Fake', capabilities: { supportsPause: true }, isConfigured: () => true,
    pauseSubscription: () => pause.promise,
    cancelSubscription: vi.fn(async () => undefined),
  } as any);
}

/** A new bot process: a new manager and writer id; nothing loads until something reads premium. */
function freshProcess(): void {
  resetPremiumManager();
  reg.current = null;
  registerFake();
}

function newProcess(): ReturnType<typeof getPremiumManager> {
  freshProcess();
  return getPremiumManager();
}

/** The process dies: what it still had queued for these files never lands. */
async function dies(pm: ReturnType<typeof getPremiumManager>, ...files: string[]): Promise<void> {
  pm.finalStop();
  await cancelQueued(files.filter(f => queuedFilePaths().includes(f)));
}

async function replayed(pm: ReturnType<typeof getPremiumManager>): Promise<void> {
  await vi.waitFor(() => expect(pm.cacheState()).toBe('normal'), { timeout: 5000, interval: 20 });
  await vi.waitFor(() => expect(rawOf(JOURNAL)).toBeNull(), { timeout: 5000, interval: 20 });
  await settleQueue();
}

async function journalWhileBroken(events: object[]): Promise<string> {
  fs.writeFileSync(PREMIUM, '{ broken');
  const pm = newProcess();
  expect(pm.cacheState()).toBe('unreadable');
  for (const event of events) getPaymentRegistry().emitEvent(event as any);
  await settleQueue();
  const lines = linesOf(JOURNAL);
  expect(lines).toHaveLength(events.length);
  return lines[0].writer;
}

/** fs.promises.unlink of the journal fails with EIO while `failing.on`. */
function failingUnlink(): { on: boolean; calls: number } {
  const state = { on: true, calls: 0 };
  const real = fs.promises.unlink.bind(fs.promises);
  vi.spyOn(fs.promises, 'unlink').mockImplementation((async (p: fs.PathLike) => {
    if (String(p) === JOURNAL) {
      state.calls += 1;
      if (state.on) throw Object.assign(new Error('EIO: i/o error, unlink'), { code: 'EIO' });
    }
    return real(p);
  }) as typeof fs.promises.unlink);
  return state;
}

let spies: ReturnType<typeof quiet>;
beforeAll(() => clearGlobal());
beforeEach(async () => {
  spies = quiet();
  inject.refuse.clear();
  inject.deleteThrows = false;
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
  inject.refuse.clear();
  inject.deleteThrows = false;
  pause.open();
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

describe('NB10 test 41, further cases', () => {
  it('(ii) a delete that keeps failing: later starts hand nothing, keep the marks, and send no notice twice', async () => {
    await journalWhileBroken([expired('d1', 'g1'), renewed('dm1', 'g2')]);
    writePremium(subs());
    const unlink = failingUnlink();
    let pm = newProcess();
    startPremiumTickers();
    await vi.waitFor(() => expect(jsonOf(PREMIUM)?.eventsApplied).toBeTruthy(), { timeout: 5000, interval: 20 });
    await vi.waitFor(() => expect(unlink.calls).toBeGreaterThan(0), { timeout: 5000, interval: 20 });
    const marks = jsonOf(PREMIUM).eventsApplied;
    expect(notices.sent).toEqual(['paid.sub.expired:g1']);
    await dies(pm, JOURNAL, PREMIUM);
    expect(rawOf(JOURNAL)).not.toBeNull();

    for (let start = 2; start <= 3; start++) {
      const calls = unlink.calls;
      pm = newProcess();
      startPremiumTickers();
      await vi.waitFor(() => expect(pm.cacheState()).toBe('normal'), { timeout: 5000, interval: 20 });
      await vi.waitFor(() => expect(unlink.calls).toBeGreaterThan(calls), { timeout: 5000, interval: 20 });
      expect(jsonOf(PREMIUM).eventsApplied).toEqual(marks);
      await dies(pm, JOURNAL, PREMIUM);
      expect(rawOf(JOURNAL)).not.toBeNull();
    }
    const saved = jsonOf(PREMIUM);
    expect(saved.subscriptions.g1.active).toBeUndefined();
    expect(saved.subscriptions.g2.active.endDate).toBe(later);
    expect(notices.sent).toEqual(['paid.sub.expired:g1']);
  });

  it('(iv) a setTier in S5 triggers the load beside a journal: no handler or notice runs until startPremiumTickers', async () => {
    await journalWhileBroken([expired('d1', 'g1')]);
    const journal = rawOf(JOURNAL);
    writePremium(subs());
    freshProcess();
    const reply: any = await applySharedOp({ op: 'premium.setTier', args: { args: ['low', { displayName: 'L', priority: 1, overrides: {}, offerings: [] }] } });
    expect(reply).toMatchObject({ ok: false });
    expect(reply.error).toContain('Premium holds provider events');
    await tick(30);
    expect(notices.sent).toEqual([]);
    expect(rawOf(JOURNAL)).toBe(journal);
    expect(jsonOf(PREMIUM).subscriptions.g1.active).toBeTruthy();
    const pm = getPremiumManager();
    startPremiumTickers();
    await replayed(pm);
    expect(notices.sent).toEqual(['paid.sub.expired:g1']);
    expect(jsonOf(PREMIUM).subscriptions.g1.active).toBeUndefined();
  });

  it('(v) during the replay the module toggle and a command grant are refused before they change the cache or settings.json', async () => {
    writePremium({ g1: { active: manualHigh(), paused: [] } });
    const settings = dataPath('global', 'nb10mod', 'settings.json');
    fs.rmSync(settings, { force: true });
    fs.writeFileSync(PREMIUM, '{ broken');
    let pm = newProcess();
    getPaymentRegistry().emitEvent(createdEvent('ps1', 'g1', 'fake') as any);
    await settleQueue();
    writePremium({ g1: { active: manualHigh(), paused: [] } });
    pause = gate();
    pm = newProcess();
    startPremiumTickers();
    await vi.waitFor(() => expect(pm.cacheState()).toBe('replaying'), { timeout: 5000, interval: 10 });
    await tick(30);
    let toggled: unknown;
    try {
      toggled = pm.setGlobalModuleConfig('nb10mod', { enabled: false } as any, {});
    } catch (error) {
      toggled = error;
    }
    expect(toggled).not.toBe(true);
    await settleQueue();
    expect(fs.existsSync(settings)).toBe(false);
    const granted = await runSealed('interaction', null, 'mod', async ledger => {
      const ok = await pm.grantManual('g5', 'low', 30);
      return { ok, verdict: await verdictOf([ledger]) };
    });
    expect(granted.ok).toBe(false);
    expect(granted.verdict).toMatchObject({ ok: false });
    expect(pm.getSubscriptions('g5').active ?? null).toBeNull();
    pause.open();
    await replayed(pm);
    expect(fs.existsSync(settings)).toBe(false);
    expect(jsonOf(PREMIUM).subscriptions.g5).toBeUndefined();
    expect(JSON.stringify(jsonOf(PREMIUM))).not.toContain('nb10mod');
  });

  it("(e) a member interaction whose premium read triggers the load holds no ticket or refusal of the replay", async () => {
    await journalWhileBroken([renewed('dm1', 'g2')]);
    writePremium(subs());
    freshProcess();
    startPremiumTickers();
    const seen = await runSealed('interaction', null, 'mod', async ledger => {
      getPremiumManager().getTierOverrides('g2', 'mod');
      await replayed(getPremiumManager());
      return { tickets: ledger.tickets().length, refused: ledger.refusedDocs().length, verdict: await verdictOf([ledger]) };
    });
    expect(seen).toEqual({ tickets: 0, refused: 0, verdict: { ok: true } });
    expect(jsonOf(PREMIUM).subscriptions.g2.active.endDate).toBe(later);
  });

  it('(vii) an append cut short by ENOSPC, then its retry: no loss is logged, and the next replay applies each event once', async () => {
    fs.writeFileSync(PREMIUM, '{ broken');
    const pm = newProcess();
    const real = fs.promises.appendFile.bind(fs.promises);
    let cut = false;
    vi.spyOn(fs.promises, 'appendFile').mockImplementation((async (p: any, data: any, options?: any) => {
      if (String(p) === JOURNAL && !cut) {
        cut = true;
        const text = String(data);
        const lines = text.split('\n');
        expect(lines.filter(Boolean)).toHaveLength(2);
        await real(p, `${lines[0]}\n${lines[1].slice(0, Math.floor(lines[1].length / 2))}`, options);
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      }
      return real(p, data, options);
    }) as typeof fs.promises.appendFile);
    getPaymentRegistry().emitEvent(expired('d1', 'g1') as any);
    getPaymentRegistry().emitEvent(renewed('dm1', 'g2') as any);
    await vi.waitFor(() => expect(cut).toBe(true), { timeout: 5000, interval: 10 });
    await vi.waitFor(() => expect(queuedFilePaths()).not.toContain(JOURNAL), { timeout: 10_000, interval: 20 });
    pm.finalStop();
    spies.error.mockClear();
    pm.logLossesAtExit();
    expect(logged(spies.error).filter(l => l.includes('lost'))).toEqual([]);
    vi.mocked(fs.promises.appendFile).mockRestore();

    writePremium(subs());
    spies.warn.mockClear();
    const next = newProcess();
    startPremiumTickers();
    await replayed(next);
    expect(logged(spies.warn).filter(l => l.startsWith('[PremiumManager] Skipped a line of premium-tiers.events.jsonl'))).toHaveLength(1);
    const saved = jsonOf(PREMIUM);
    expect(saved.subscriptions.g1.active).toBeUndefined();
    expect(saved.subscriptions.g2.active.endDate).toBe(later);
    expect(notices.sent).toEqual(['paid.sub.expired:g1']);
  }, 30_000);

  it('(ix) a throw in the delete step leaves the cache live and a held grant lands once the disk recovers', async () => {
    await journalWhileBroken([renewed('dm1', 'g2')]);
    writePremium(subs());
    inject.deleteThrows = true;
    const pm = newProcess();
    startPremiumTickers();
    await vi.waitFor(() => expect(allLogs().some(l => l.startsWith('[PremiumManager] premium-tiers.events.jsonl could not be deleted'))).toBe(true), { timeout: 5000, interval: 20 });
    expect(pm.cacheState()).toBe('normal');
    expect(pm.resolveActiveTier('g2').tierId).toBe('low');
    inject.refuse.set('premium-tiers.json', 'storage-failing');
    expect(await applySharedOp({ op: 'premium.grantManual', args: { args: ['g3', 'high', 30] } })).toMatchObject({ answer: 'held' });
    expect(pm.cacheState()).toBe('normal');
    inject.refuse.clear();
    await vi.waitFor(() => expect(jsonOf(PREMIUM).subscriptions.g3?.active?.tierId).toBe('high'), { timeout: 5000, interval: 50 });
    expect(pm.resolveActiveTier('g2').tierId).toBe('low');
  });

  it('(xii) a covered journal whose unlink fails: the member interaction and the op hold nothing of it, and the retry deletes it', async () => {
    const event = renewed('dm1', 'g2');
    writePremium({ g2: { active: { ...paidSub('s2', 'dm1', 'low', 'dummy'), endDate: later }, paused: [] } }, { eventsApplied: { w1: 1 } });
    fs.writeFileSync(JOURNAL, journalLine('w1', 1, event));
    const unlink = failingUnlink();
    freshProcess();
    startPremiumTickers();
    const seen = await runSealed('interaction', null, 'mod', async ledger => {
      getPremiumManager().getTierOverrides('g2', 'mod');
      return { tickets: ledger.tickets().length, refused: ledger.refusedDocs().length, verdict: await verdictOf([ledger]) };
    });
    expect(seen).toEqual({ tickets: 0, refused: 0, verdict: { ok: true } });
    await vi.waitFor(() => expect(unlink.calls).toBeGreaterThan(0), { timeout: 5000, interval: 20 });
    expect(rawOf(JOURNAL)).not.toBeNull();

    resetPremiumManager();
    reg.current = null;
    registerFake();
    const reply: any = await applySharedOp({ op: 'premium.setTier', args: { args: ['low', { displayName: 'L2', priority: 1, overrides: {}, offerings: [] }] } });
    expect(reply).toEqual({ ok: true, result: true });
    unlink.on = false;
    await vi.waitFor(() => expect(rawOf(JOURNAL)).toBeNull(), { timeout: 10_000, interval: 50 });
    expect(jsonOf(PREMIUM).tiers.low.displayName).toBe('L2');
    expect(notices.sent).toEqual([]);
  }, 20_000);

  it("(xiii) the replay's save fails ENOSPC at a stop: nothing is called lost, no install line yet; the next start gives each effect once", async () => {
    const j1 = createdEvent('ent1', 'g3', 'discord');
    await journalWhileBroken([j1, renewed('dm1', 'g2')]);
    writePremium(subs());
    const undo = failFlushes(PREMIUM);
    let pm = newProcess();
    try {
      startPremiumTickers();
      await vi.waitFor(() => expect(pm.cacheState()).toBe('normal'), { timeout: 5000, interval: 20 });
      await tick(100);
      expect(linesOf(AUDIT).filter(l => l.action === 'subscription.install.paid')).toEqual([]);
      spies.error.mockClear();
      spies.warn.mockClear();
      pm.finalStop();
      pm.logLossesAtExit();
      expect(logged(spies.error).some(l => l.startsWith('[PremiumManager] The stop came before the kept provider events were saved'))).toBe(true);
      expect(allLogs().filter(l => (l.includes('ent1') || l.includes('dm1')) && l.includes('lost'))).toEqual([]);
      await cancelQueued([PREMIUM]);
    } finally {
      undo();
    }
    await settleQueue();
    expect(linesOf(AUDIT).filter(l => l.action === 'subscription.install.paid')).toEqual([]);
    expect(rawOf(JOURNAL)).not.toBeNull();

    pm = newProcess();
    startPremiumTickers();
    await replayed(pm);
    const saved = jsonOf(PREMIUM);
    expect(saved.subscriptions.g3.active.providerSubId).toBe('ent1');
    expect(saved.subscriptions.g2.active.endDate).toBe(later);
    expect(linesOf(AUDIT).filter(l => l.action === 'subscription.install.paid')).toHaveLength(1);
  }, 30_000);

  it("(xiii) the replay's save and line refused at a stop: the held-change line keeps the provider events in the journal, nothing about J1 is lost, and the next start gives each effect once", async () => {
    const j1 = createdEvent('ent1', 'g3', 'discord');
    await journalWhileBroken([j1, renewed('dm1', 'g2')]);
    writePremium(subs());
    const before = rawOf(PREMIUM);
    const journal = rawOf(JOURNAL);
    inject.refuse.set('premium-tiers.json', 'storage-failing');
    inject.refuse.set('premium-tiers.audit.jsonl', 'storage-failing');
    let pm = newProcess();
    startPremiumTickers();
    await vi.waitFor(() => expect(pm.cacheState()).toBe('normal'), { timeout: 5000, interval: 20 });
    await vi.waitFor(() => expect((pm as any).saveHeld).toBe(true), { timeout: 5000, interval: 20 });
    await tick(100);
    spies.error.mockClear();
    spies.warn.mockClear();
    pm.finalStop();
    pm.logLossesAtExit();
    const held = logged(spies.error).filter(l => l.startsWith('[PremiumManager] premium-tiers.json holds changes the disk refused'));
    expect(held).toHaveLength(1);
    expect(held[0].startsWith('[PremiumManager] premium-tiers.json holds changes the disk refused. The kept provider events stay in premium-tiers.events.jsonl, and the next normal start of the bot applies them again; any change made after them is ')).toBe(true);
    expect(allLogs().filter(l => l.includes('ent1') && l.includes('lost'))).toEqual([]);
    await settleQueue();
    expect(rawOf(PREMIUM)).toBe(before);
    expect(rawOf(AUDIT)).toBeNull();
    expect(rawOf(JOURNAL)).toBe(journal);

    inject.refuse.clear();
    pm = newProcess();
    startPremiumTickers();
    await replayed(pm);
    const saved = jsonOf(PREMIUM);
    expect(saved.subscriptions.g3.active.providerSubId).toBe('ent1');
    expect(saved.subscriptions.g3.paused).toEqual([]);
    expect(saved.subscriptions.g2.active.endDate).toBe(later);
    const installs = linesOf(AUDIT).filter(l => l.action === 'subscription.install.paid');
    expect(installs).toHaveLength(1);
    expect(JSON.stringify(installs[0])).toContain('g3');
  }, 30_000);
});
