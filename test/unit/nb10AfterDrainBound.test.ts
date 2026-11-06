import fs from 'fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// NB10 code review round 10, NB10-R11-T2: the drain pass after the after-drain steps gives up on a line that never
// lands within its 5 s bound, though the working set never settles, and the exit handler logs that line with its JSON.
// The stop runs once per process, so this file holds only this case.

const ws = vi.hoisted(() => ({ phase2: false }));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/workingSet', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataBackends/workingSet')>();
  const stub = {
    writesSettled: () => !ws.phase2,
    flushOnTheWire: () => ws.phase2,
    flushAllDirty: () => (ws.phase2 ? new Promise<string[]>(() => undefined) : Promise.resolve([] as string[])),
    landedFlushes: () => 0,
    dirtyGuildIds: () => [] as string[],
    resaveGuilds: () => [] as string[],
    unansweredGuilds: () => ({ all: [] as string[], only: [] as string[] }),
    takeDropLines: () => [] as string[],
  };
  return { ...real, getWorkingSet: () => stub };
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
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { addFinalStopStep, beginStop, installStopHandler } from '../../src/bot/internalSetup/utils/dataManager';
import { getPending } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { AUDIT, clearGlobal, JOURNAL, jsonOf, logged, PREMIUM, quiet, rawOf, settleQueue, state, writePremium } from './nb10PremiumRig';

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

describe('the drain pass after the after-drain steps is bounded by 5 s (NB10-R11-T2)', () => {
  it('a line whose append never lands is given up within 5 s and the exit logs it with its JSON', async () => {
    const spies = quiet();
    const flush = { failing: false };
    const open = fs.promises.open.bind(fs.promises);
    const onTheWire: string[] = [];
    // In phase 2 the append's 'a+' open of the audit file is held for ever, so the file stays absent; the bytes that
    // try would write are its queued entry's.
    vi.spyOn(fs.promises, 'open').mockImplementation(((file: any, flags?: any, mode?: any) => {
      if (flush.failing && String(file).startsWith(`${PREMIUM}.`) && flags === 'w') {
        return Promise.reject(Object.assign(new Error('EIO: injected'), { code: 'EIO' }));
      }
      if (ws.phase2 && String(file) === AUDIT && flags === 'a+') {
        const entry = getPending(AUDIT);
        if (entry && entry.op !== 'delete') onTheWire.push(entry.content);
        return new Promise(() => undefined);
      }
      return open(file, flags, mode);
    }) as any);
    let exitedAt: number | null = null;
    let atExit: string | null = null;
    vi.spyOn(process, 'exit').mockImplementation((() => {
      exitedAt = Date.now();
      atExit = rawOf(AUDIT);
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
    const pm = getPremiumManager() as any;
    flush.failing = true;
    startPremiumTickers();
    await vi.waitFor(() => expect(pm.cacheState()).toBe('normal'), { timeout: 5000, interval: 20 });
    await settleQueue();
    expect(rawOf(AUDIT)).toBeNull();

    let stepAt: number | null = null;
    let stepQueued: boolean | null = null;
    const afterDrain = pm.afterDrain.bind(pm);
    vi.spyOn(pm, 'afterDrain').mockImplementation(() => {
      ws.phase2 = true;
      stepAt = Date.now();
      stepQueued = afterDrain();
      return stepQueued;
    });
    addFinalStopStep(() => { flush.failing = false; });
    await beginStop();
    await vi.waitFor(() => expect(exitedAt).not.toBeNull(), { timeout: 20_000, interval: 20 });

    expect(stepQueued).toBe(true);
    expect(jsonOf(PREMIUM).eventsApplied).toEqual({ w1: 1 });
    expect(onTheWire.length).toBeGreaterThan(0);
    const elapsed = exitedAt! - stepAt!;
    expect(elapsed).toBeGreaterThanOrEqual(5000);
    expect(elapsed).toBeLessThan(5600);
    expect(atExit).toBeNull();
    expect(rawOf(AUDIT)).toBeNull();

    const line = onTheWire[0].trim();
    expect(JSON.parse(line)).toMatchObject({ action: 'subscription.install.paid', guildId: 'g4' });
    spies.error.mockClear();
    pm.logLossesAtExit();
    const lost = logged(spies.error);
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatch(/^\[PremiumManager\] The audit line subscription\.install\.paid \(guild g4, subscription j1\) did not reach the disk before this stop and is lost: /);
    expect(lost[0].endsWith(line)).toBe(true);
  }, 30_000);
});
