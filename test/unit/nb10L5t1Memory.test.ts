import fs from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// A provider event that arrives while premium waits to apply its kept events is kept in memory when it is this
// process's own; a later event the stopped replay caused names in its log line that an exit line may call it lost.

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
import { clearGlobal, JOURNAL, logged, paidSub, quiet, settleQueue, state, tick, writePremium } from './nb10PremiumRig';

const role = process.env.BOT_PROCESS_ROLE;
const LATER = new Date(Date.now() + 90 * 86_400_000).toISOString();

function setup(late: { beforeEmit?: () => void; emitted?: boolean }): void {
  const paused = { ...paidSub('sB', 'ps1', 'low', 'slow'), status: 'paused', pausedAt: new Date().toISOString(), remainingDaysAtPause: 10 };
  writePremium({ g1: { active: paidSub('sA', 'ps0', 'high', 'discord'), paused: [paused] } });
  const expired = { type: 'subscription.expired', providerId: 'discord', providerSubId: 'ps0', guildId: 'g1', state: { ...state('expired'), endDate: new Date(Date.now() - 1000).toISOString() } };
  fs.writeFileSync(JOURNAL, `${JSON.stringify({ writer: 'w1', n: 1, event: expired })}\n`);
  getPaymentRegistry().register({
    id: 'slow', displayName: 'Slow', capabilities: { supportsPause: true }, isConfigured: () => true,
    pauseSubscription: async () => undefined,
    resumeSubscription: async (providerSubId: string) => {
      await tick(20);
      late.beforeEmit?.();
      getPaymentRegistry().emitEvent({ type: 'subscription.renewed', providerId: 'slow', providerSubId, guildId: 'g1', state: { ...state(), endDate: LATER } } as any);
      late.emitted = true;
    },
  } as any);
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

describe('a replay that applied an event kept only in this process', () => {
  it('logs, for a later event it caused that the stop refused, that an exit line may name it as lost', async () => {
    const late: { beforeEmit?: () => void; emitted?: boolean } = {};
    setup(late);
    const pm = getPremiumManager();
    hooks.save = file => (file === 'premium-tiers.json' ? { outcome: 'refused', cause: 'io' } : undefined);
    const { error } = quiet();
    getPaymentRegistry().emitEvent({ type: 'subscription.renewed', providerId: 'other', providerSubId: 'nobody', guildId: 'g9', state: state() } as any);
    expect(pm.cacheState()).toBe('replaying');
    late.beforeEmit = () => pm.finalStop();
    startPremiumTickers();
    await vi.waitFor(() => expect(late.emitted).toBe(true), { timeout: 5000, interval: 2 });
    await settleQueue();
    expect(pm.getFullConfig().subscriptions.g1.active?.endDate).not.toBe(LATER);
    const lines = logged(error).filter(l => l.includes(', caused by applying a kept provider event, '));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('. If an exit line says the kept provider events stay in premium-tiers.events.jsonl, the next normal start of the bot applies that provider event again unless an exit line names it as lost; otherwise this event is lost: {');
    expect(lines[0]).toContain('"type":"subscription.renewed"');
  });

  it('leaves that clause out when every applied event came from premium-tiers.events.jsonl', async () => {
    const late: { beforeEmit?: () => void; emitted?: boolean } = {};
    setup(late);
    const pm = getPremiumManager();
    hooks.save = file => (file === 'premium-tiers.json' ? { outcome: 'refused', cause: 'io' } : undefined);
    const { error } = quiet();
    late.beforeEmit = () => pm.finalStop();
    startPremiumTickers();
    await vi.waitFor(() => expect(late.emitted).toBe(true), { timeout: 5000, interval: 2 });
    await settleQueue();
    const lines = logged(error).filter(l => l.includes(', caused by applying a kept provider event, '));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('applies that provider event again; otherwise this event is lost: {');
    expect(lines[0]).not.toContain('unless an exit line names it as lost');
  });
});
