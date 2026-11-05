import fs from 'fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// NB10 test 41, the gatekeeper's ruling on finding 16, through the bot's real stop: the replay's save lands in the exit
// drain, the after-drain step queues its install line and the stop runs one more drain pass before it exits. The stop
// runs once per process, so this file holds only this case (nb10JournalStopLost.test.ts holds the save that never lands).

const reg = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  return { ...real, getPaymentRegistry: () => (reg.current ??= new real.PaymentProviderRegistry()) };
});
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async () => ({ delivered: true, via: 'dm' }),
}));

import { getPremiumManager, resetPremiumManager, startPremiumTickers } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { addFinalStopStep, beginStop, installStopHandler } from '../../src/bot/internalSetup/utils/dataManager';
import { AUDIT, clearGlobal, JOURNAL, jsonOf, linesOf, logged, PREMIUM, quiet, rawOf, settleQueue, state, writePremium } from './nb10PremiumRig';

const role = process.env.BOT_PROCESS_ROLE;
const signals = { term: process.listeners('SIGTERM'), int: process.listeners('SIGINT') };
beforeAll(async () => {
  process.env.BOT_PROCESS_ROLE = 'bot';
  await settleQueue();
  resetPremiumManager();
  clearGlobal();
});
afterAll(() => {
  for (const l of process.listeners('SIGTERM')) if (!signals.term.includes(l)) process.off('SIGTERM', l);
  for (const l of process.listeners('SIGINT')) if (!signals.int.includes(l)) process.off('SIGINT', l);
  resetPremiumManager();
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
  vi.restoreAllMocks();
});

describe("the replay's install line and the bot's real stop", () => {
  it('the save lands in the exit drain: the line lands in the second pass before the exit, once, and the exit logs nothing', async () => {
    const spies = quiet();
    const flush = { failing: false };
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(((file: any, flags?: any, mode?: any) => {
      if (flush.failing && String(file).startsWith(`${PREMIUM}.`) && flags === 'w') {
        return Promise.reject(Object.assign(new Error('EIO: injected'), { code: 'EIO' }));
      }
      return open(file, flags, mode);
    }) as any);
    let atExit: any[] | null = null;
    let exitCode: number | undefined | null = null;
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      atExit = linesOf(AUDIT);
      exitCode = code;
      return undefined as never;
    }) as typeof process.exit);

    writePremium();
    fs.writeFileSync(JOURNAL, `${JSON.stringify({ writer: 'w1', n: 1, event: { type: 'subscription.created', providerId: 'fake', providerSubId: 'j1', guildId: 'g4', tierId: 'low', offeringId: 'o1', state: state() } })}\n`);
    reg.current = null;
    getPaymentRegistry().register({
      id: 'fake', displayName: 'Fake', capabilities: { supportsPause: true }, isConfigured: () => true,
      handleWebhook: async () => undefined, cancelSubscription: async () => undefined,
    } as any);
    installStopHandler();
    const pm = getPremiumManager();
    flush.failing = true;
    startPremiumTickers();
    await vi.waitFor(() => expect(pm.cacheState()).toBe('normal'), { timeout: 5000, interval: 20 });
    await settleQueue();
    expect(rawOf(AUDIT)).toBeNull();
    expect(jsonOf(PREMIUM).eventsApplied ?? {}).toEqual({});

    addFinalStopStep(() => { flush.failing = false; });
    await beginStop();
    await vi.waitFor(() => expect(atExit).not.toBeNull(), { timeout: 15_000, interval: 20 });
    expect(exitCode).toBe(0);
    expect(pm.isStopped()).toBe(true);
    expect(jsonOf(PREMIUM).eventsApplied).toEqual({ w1: 1 });
    expect(jsonOf(PREMIUM).subscriptions.g4.active).toMatchObject({ providerSubId: 'j1', tierId: 'low' });
    const installs = (atExit as unknown as any[]).filter(l => l.action === 'subscription.install.paid');
    expect(installs).toHaveLength(1);
    expect(installs[0].guildId).toBe('g4');
    expect(linesOf(AUDIT).filter(l => l.action === 'subscription.install.paid')).toHaveLength(1);
    spies.error.mockClear();
    pm.logLossesAtExit();
    expect(logged(spies.error)).toEqual([]);
  }, 30_000);
});
