import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// NB10 test 34 (rounds 4 and 6): the bot's real stop runs the premium cache's final step after the stop steps (the
// gateway close among them), and a PremiumManager first built after the final steps ran has its final step run at once
// and is stopped. The stop runs once per process, so this file holds only these cases.

const reg = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  return { ...real, getPaymentRegistry: () => (reg.current ??= new real.PaymentProviderRegistry()) };
});
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async () => ({ delivered: true, via: 'dm' }),
}));

import { getPremiumManager, resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { addStopStep, beginStop, installStopHandler } from '../../src/bot/internalSetup/utils/dataManager';
import { clearGlobal, gate, jsonOf, PREMIUM, quiet, settleQueue, writePremium } from './nb10PremiumRig';

const role = process.env.BOT_PROCESS_ROLE;
beforeAll(async () => {
  process.env.BOT_PROCESS_ROLE = 'bot';
  await settleQueue();
  resetPremiumManager();
  clearGlobal();
  writePremium();
});
afterAll(() => {
  resetPremiumManager();
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
  vi.restoreAllMocks();
});

describe("the premium cache's place in the bot's stop", () => {
  it('runs after the gateway close step, and a manager built after the final steps is stopped at once', async () => {
    quiet();
    const order: string[] = [];
    let exitCode: number | undefined | null = null;
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { exitCode = code; order.push('exit'); return undefined as never; }) as typeof process.exit);
    installStopHandler();
    const pm = getPremiumManager();
    expect(pm.isStopped()).toBe(false);
    const realFinal = pm.finalStop.bind(pm);
    vi.spyOn(pm, 'finalStop').mockImplementation(() => { order.push('premium final step'); return realFinal(); });
    const close = gate();
    addStopStep(async () => {
      order.push('gateway close started');
      await close.promise;
      order.push('gateway close ended');
    });

    const stopping = beginStop();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(order).toEqual(['gateway close started']);
    expect(pm.isStopped()).toBe(false);
    close.open();
    await stopping;
    await vi.waitFor(() => expect(order).toContain('exit'), { timeout: 10_000, interval: 10 });
    expect(order.slice(0, 3)).toEqual(['gateway close started', 'gateway close ended', 'premium final step']);
    expect(order.indexOf('premium final step')).toBeLessThan(order.indexOf('exit'));
    expect(exitCode).toBe(0);
    expect(pm.isStopped()).toBe(true);

    resetPremiumManager();
    const before = jsonOf(PREMIUM);
    const late = getPremiumManager();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(late).not.toBe(pm);
    expect(late.isStopped()).toBe(true);
    expect((late as any).retryTimer).toBeNull();
    expect((late as any).expiryTimer).toBeNull();
    expect(await late.grantManual('g1', 'high', 30)).toBe(false);
    expect(late.resolveActiveTier('g1').tierId).toBe('free');
    await settleQueue();
    expect(jsonOf(PREMIUM)).toEqual(before);
  }, 20_000);
});
