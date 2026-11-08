import fs from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 fix 20: provider work the replay started but that emits its event after the replay ended saves to
// premium-tiers.json like any other event; provider work that emits during the replay is saved by the replay's own write.

const hooks = vi.hoisted(() => ({ save: null as null | ((file: string, data: any) => unknown) }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  return {
    ...real,
    saveDataTracked: (f: string, o: any, d: unknown) => (hooks.save?.(f, d) as any) ?? real.saveDataTracked(f, o, d),
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

import { getPremiumManager, resetPremiumManager, startPremiumTickers } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { AUDIT, clearGlobal, JOURNAL, jsonOf, linesOf, logged, paidSub, PREMIUM, quiet, rawOf, settleQueue, state, tick, writePremium } from './nb10PremiumRig';

const role = process.env.BOT_PROCESS_ROLE;
const LATER = new Date(Date.now() + 90 * 86_400_000).toISOString();

type Late = { atResume?: () => void; wait?: () => Promise<unknown>; beforeEmit?: () => void; event?: (providerSubId: string) => any; emitted?: boolean };

function setup(delayMs: number, late: Late = {}): void {
  const paused = { ...paidSub('sB', 'ps1', 'low', 'slow'), status: 'paused', pausedAt: new Date().toISOString(), remainingDaysAtPause: 10 };
  writePremium({ g1: { active: paidSub('sA', 'ps0', 'high', 'discord'), paused: [paused] } });
  const expired = { type: 'subscription.expired', providerId: 'discord', providerSubId: 'ps0', guildId: 'g1', state: { ...state('expired'), endDate: new Date(Date.now() - 1000).toISOString() } };
  fs.writeFileSync(JOURNAL, `${JSON.stringify({ writer: 'w1', n: 1, event: expired })}\n`);
  getPaymentRegistry().register({
    id: 'slow', displayName: 'Slow', capabilities: { supportsPause: true }, isConfigured: () => true,
    pauseSubscription: async () => undefined,
    resumeSubscription: async (providerSubId: string) => {
      late.atResume?.();
      if (delayMs > 0) await tick(delayMs);
      if (late.wait) await late.wait();
      late.beforeEmit?.();
      getPaymentRegistry().emitEvent(late.event?.(providerSubId) ?? { type: 'subscription.renewed', providerId: 'slow', providerSubId, guildId: 'g1', state: { ...state(), endDate: LATER } } as any);
      late.emitted = true;
    },
  } as any);
}

/** Each save() answer, with the endDate of the premium-tiers.json write it issued (undefined when it wrote nothing). */
function spySave(pm: ReturnType<typeof getPremiumManager>, inner?: (file: string) => unknown): Array<{ answer: boolean; wrote: string | undefined }> {
  const answers: Array<{ answer: boolean; wrote: string | undefined }> = [];
  let wrote: string | undefined;
  hooks.save = (file, data) => {
    if (file === 'premium-tiers.json') wrote = data?.subscriptions?.g1?.active?.endDate;
    return inner?.(file);
  };
  const real = (pm as any).save.bind(pm);
  (pm as any).save = (opts?: unknown) => {
    wrote = undefined;
    const op = real(opts);
    answers.push({ answer: op !== null, wrote });
    return op;
  };
  return answers;
}

beforeAll(() => clearGlobal());
beforeEach(async () => {
  quiet();
  process.env.BOT_PROCESS_ROLE = 'bot';
  hooks.save = null;
  await settleQueue();
  resetPremiumManager();
  reg.current = null;
  clearGlobal();
});
afterEach(async () => {
  hooks.save = null;
  resetPremiumManager();
  reg.current = null;
  await settleQueue();
  vi.restoreAllMocks();
});
afterAll(() => {
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe('a provider event the replay caused', () => {
  it('arriving after the replay ended is saved to premium-tiers.json, and save() answers true only once it is', async () => {
    setup(20);
    const pm = getPremiumManager();
    const answers = spySave(pm);
    startPremiumTickers();
    await vi.waitFor(() => expect(pm.cacheState()).toBe('normal'), { timeout: 5000, interval: 2 });
    await vi.waitFor(() => expect(pm.getFullConfig().subscriptions.g1.active?.endDate).toBe(LATER), { timeout: 5000, interval: 5 });
    await settleQueue();
    expect(jsonOf(PREMIUM).subscriptions.g1.active.id).toBe('sB');
    expect(jsonOf(PREMIUM).subscriptions.g1.active.endDate).toBe(LATER);
    const last = answers[answers.length - 1];
    expect(last).toEqual({ answer: true, wrote: LATER });
  });

  it('arriving during the replay is not saved on its own; the replay writes it with its marks', async () => {
    setup(0);
    let whileReplaying = 0;
    const pm = getPremiumManager();
    hooks.save = file => {
      if (file === 'premium-tiers.json' && pm.cacheState() === 'replaying') whileReplaying += 1;
      return undefined;
    };
    startPremiumTickers();
    await vi.waitFor(() => expect(pm.cacheState()).toBe('normal'), { timeout: 5000, interval: 2 });
    await settleQueue();
    expect(whileReplaying).toBe(0);
    const disk = jsonOf(PREMIUM);
    expect(disk.subscriptions.g1.active.id).toBe('sB');
    expect(disk.subscriptions.g1.active.endDate).toBe(LATER);
    expect(disk.eventsApplied).toEqual({ w1: 1 });
  });

  it('arriving after a replay the stop ended is not applied, and its one log line says the journal hands it again', async () => {
    const late: Late = {};
    setup(20, late);
    const before = rawOf(PREMIUM);
    const pm = getPremiumManager();
    const answers = spySave(pm);
    const { error } = quiet();
    let mark = -1;
    late.atResume = () => pm.finalStop();
    late.beforeEmit = () => { mark = answers.length; };
    startPremiumTickers();
    await vi.waitFor(() => expect(late.emitted).toBe(true), { timeout: 5000, interval: 2 });
    await settleQueue();
    expect(pm.getFullConfig().subscriptions.g1.active?.endDate).not.toBe(LATER);
    expect(rawOf(PREMIUM)).toBe(before);
    expect(answers.slice(mark).filter(a => a.answer)).toEqual([]);
    const lines = logged(error);
    const truthful = lines.filter(l => l.startsWith('[PremiumManager] A ') && l.includes(', caused by applying a kept provider event, was not applied: ') && l.includes('; the kept provider events were not saved, so the next normal start of the bot applies that provider event again: {'));
    expect(truthful).toHaveLength(1);
    expect(truthful[0]).toContain('"type":"subscription.renewed"');
    expect(lines.filter(l => l.includes('it is lost'))).toEqual([]);
    expect(linesOf(JOURNAL).filter(l => l.writer === 'w1' && l.n === 1 && l.event?.type === 'subscription.expired')).toHaveLength(1);
  });

  it('arriving after a replay whose marks were raised but not saved, its one log line points at the exit line', async () => {
    const late: Late = {};
    setup(20, late);
    const pm = getPremiumManager();
    spySave(pm, file => (file === 'premium-tiers.json' ? { outcome: 'refused', cause: 'io' } : undefined));
    const { error } = quiet();
    late.beforeEmit = () => pm.finalStop();
    startPremiumTickers();
    await vi.waitFor(() => expect(late.emitted).toBe(true), { timeout: 5000, interval: 2 });
    await settleQueue();
    expect((pm as any).raisedMarks).not.toBeNull();
    expect((pm as any).marksLanded()).toBe(false);
    const lines = logged(error).filter(l => l.includes(', caused by applying a kept provider event, '));
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith('[PremiumManager] A ')).toBe(true);
    expect(lines[0]).toContain(', caused by applying a kept provider event, was not applied: ');
    expect(lines[0]).toContain('. If an exit line says the kept provider events stay in premium-tiers.events.jsonl, the next normal start of the bot applies that provider event again; otherwise this event is lost: {');
    expect(lines[0]).toContain('"type":"subscription.renewed"');
  });

  it('arriving after a replay whose marks were saved, it logs the ordinary lost line', async () => {
    const late: Late = {};
    setup(20, late);
    const pm = getPremiumManager();
    const { error } = quiet();
    late.wait = () => vi.waitFor(() => expect((pm as any).marksLanded()).toBe(true), { timeout: 5000, interval: 2 });
    late.beforeEmit = () => pm.finalStop();
    startPremiumTickers();
    await vi.waitFor(() => expect(late.emitted).toBe(true), { timeout: 5000, interval: 2 });
    await settleQueue();
    const lines = logged(error);
    expect(lines.filter(l => l.includes('caused by applying'))).toEqual([]);
    const lost = lines.filter(l => l.startsWith('[PremiumManager] A ') && l.includes(' was not applied: ') && l.includes('; it is lost: {'));
    expect(lost).toHaveLength(1);
    expect(lost[0]).toContain('"type":"subscription.renewed"');
  });

  it('writing an audit line after the replay ended appends it, and the replay buffer holds nothing of it', async () => {
    const late: Late = {};
    setup(20, late);
    late.event = providerSubId => ({ type: 'subscription.expired', providerId: 'slow', providerSubId, guildId: 'g1', state: { ...state('expired'), endDate: new Date(Date.now() - 1000).toISOString() } });
    const pm = getPremiumManager();
    let afterEmit: any[] | null = null;
    const emit = getPaymentRegistry().emitEvent.bind(getPaymentRegistry());
    vi.spyOn(getPaymentRegistry(), 'emitEvent').mockImplementation((e: any) => {
      emit(e);
      if (e.providerSubId === 'ps1') afterEmit = [...(pm as any).replayBuffer];
    });
    startPremiumTickers();
    await vi.waitFor(() => expect(late.emitted).toBe(true), { timeout: 5000, interval: 2 });
    await settleQueue();
    const mine = (p: any) => p.entry.action === 'subscription.expire.paid' && p.entry.subscriptionId === 'sB';
    expect(afterEmit!.filter(mine)).toEqual([]);
    expect((pm as any).replayBuffer.filter(mine)).toEqual([]);
    await vi.waitFor(() => expect(linesOf(AUDIT).filter(l => l.action === 'subscription.expire.paid' && l.subscriptionId === 'sB')).toHaveLength(1), { timeout: 5000, interval: 5 });
  });

  it("saved after the replay's own save was refused, it carries the marks to disk, and the replay's audit lines are then placed", async () => {
    const late: Late = {};
    setup(20, late);
    const pm = getPremiumManager();
    let mark = -1;
    let refused = 0;
    const answers = spySave(pm, file => {
      if (file !== 'premium-tiers.json' || mark >= 0) return undefined;
      refused += 1;
      return { outcome: 'refused', cause: 'io' };
    });
    late.beforeEmit = () => { mark = answers.length; };
    startPremiumTickers();
    await vi.waitFor(() => expect(late.emitted).toBe(true), { timeout: 5000, interval: 2 });
    expect(refused).toBeGreaterThan(0);
    const ticket = (pm as any).marksTicket;
    expect(ticket).not.toBeNull();
    expect(answers[answers.length - 1]).toEqual({ answer: true, wrote: LATER });
    expect(ticket).toBe((pm as any).lastSaveTicket);
    await settleQueue();
    const disk = jsonOf(PREMIUM);
    expect(disk.eventsApplied).toEqual({ w1: 1 });
    expect(disk.subscriptions.g1.active.endDate).toBe(LATER);
    await vi.waitFor(() => expect(linesOf(AUDIT).filter(l => l.action === 'subscription.expire.paid' && l.subscriptionId === 'sA')).toHaveLength(1), { timeout: 5000, interval: 5 });
    expect((pm as any).replayBuffer).toEqual([]);
  });
});
