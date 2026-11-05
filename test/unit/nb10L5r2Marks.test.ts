import fs from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 mutation gate, premiumManager.ts: a replay that handed nothing leaves eventsApplied as it was, also when a
// stored mark is negative; a skipped line of a writer with no mark adds no key; a held save whose retry timer has no
// unref still answers held.

const hooks = vi.hoisted(() => ({ save: null as null | ((file: string) => unknown) }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  return {
    ...real,
    saveDataTracked: (f: string, o: any, d: unknown) => (hooks.save?.(f) as any) ?? real.saveDataTracked(f, o, d),
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

import { getPremiumManager, resetPremiumManager, startPremiumTickers } from '../../src/bot/internalSetup/utils/premiumManager';
import { clearGlobal, JOURNAL, jsonOf, paidSub, PREMIUM, quiet, rawOf, settleQueue, state, writePremium } from './nb10PremiumRig';

type Manager = ReturnType<typeof getPremiumManager>;
const role = process.env.BOT_PROCESS_ROLE;
const later = new Date(Date.now() + 90 * 86_400_000).toISOString();
const expired = (providerSubId: string, guildId: string) => ({ type: 'subscription.expired', providerId: 'discord', providerSubId, guildId, state: { ...state('expired'), endDate: new Date(Date.now() - 1000).toISOString() } });
const renewed = (providerSubId: string, guildId: string) => ({ type: 'subscription.renewed', providerId: 'dummy', providerSubId, guildId, state: { ...state(), endDate: later } });
const subs = () => ({
  g1: { active: paidSub('s1', 'd1', 'low', 'discord'), paused: [] },
  g2: { active: paidSub('s2', 'dm1', 'low', 'dummy'), paused: [] },
});
const journalLine = (writer: string, n: number, event: object) => `${JSON.stringify({ writer, n, event })}\n`;
const normal = (pm: Manager) => vi.waitFor(() => expect(pm.cacheState()).toBe('normal'), { timeout: 5000, interval: 5 });

/** Runs the replay to its end and waits for its save to land. */
async function replayed(pm: Manager): Promise<void> {
  startPremiumTickers();
  await normal(pm);
  await vi.waitFor(() => expect(rawOf(JOURNAL)).toBeNull(), { timeout: 5000, interval: 5 });
  await settleQueue();
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
  vi.unstubAllGlobals();
  resetPremiumManager();
  reg.current = null;
  await settleQueue();
  vi.restoreAllMocks();
});
afterAll(() => {
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe('the marks a replay saves', () => {
  it('a replay that handed nothing keeps a negative mark as stored', async () => {
    writePremium(subs(), { eventsApplied: { w: -5 } });
    fs.writeFileSync(JOURNAL, journalLine('w', -4, renewed('dm1', 'g2')));
    resetPremiumManager();
    const pm = getPremiumManager();
    pm.getFullConfig();
    expect(pm.cacheState()).toBe('replaying');
    // The journal is replaced before the replay reads it: its one line is covered by the mark.
    fs.writeFileSync(JOURNAL, journalLine('w', -7, renewed('dm1', 'g2')));
    await replayed(pm);
    const saved = jsonOf(PREMIUM);
    expect(saved.eventsApplied).toEqual({ w: -5 });
    expect(saved.subscriptions.g2.active.endDate).not.toBe(later);
  });

  it('a skipped line of a writer with no mark adds no key to eventsApplied', async () => {
    writePremium(subs());
    fs.writeFileSync(JOURNAL, journalLine('a', 1, expired('d1', 'g1')) + journalLine('b', 0, renewed('dm1', 'g2')));
    resetPremiumManager();
    const pm = getPremiumManager();
    await replayed(pm);
    const saved = jsonOf(PREMIUM);
    expect(saved.eventsApplied).toEqual({ a: 1 });
    expect(saved.subscriptions.g1.active).toBeUndefined();
  });
});

describe('a held save', () => {
  it('answers held when the retry timer handle has no unref', () => {
    writePremium(subs());
    const pm = getPremiumManager();
    const config = pm.getFullConfig();
    expect(pm.cacheState()).toBe('normal');
    const before = rawOf(PREMIUM);
    hooks.save = file => (file === 'premium-tiers.json' ? { outcome: 'refused', cause: 'io' } : undefined);
    const timers: number[] = [];
    vi.stubGlobal('setTimeout', () => { timers.push(1); return 1; });
    config.messages = { ...config.messages, welcome: 'held text' } as any;
    let answer: boolean | undefined;
    expect(() => { answer = pm.setFullConfig(config); }).not.toThrow();
    vi.unstubAllGlobals();
    expect(answer).toBe(true);
    expect(timers.length).toBeGreaterThan(0);
    expect(rawOf(PREMIUM)).toBe(before);
    expect((pm.getFullConfig().messages as any).welcome).toBe('held text');
  });
});
