import fs from 'fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// NB10-R10-T2, through the bot's real stop: an expire-now whose subscription another op removed, that op's save still
// queued and refused by the disk when the stop begins, is answered in the stop's words (no retry promised), and
// BotManager words it as the operator's Stop. The stop runs once per process, so this file holds only this stop.

const reg = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  return { ...real, getPaymentRegistry: () => (reg.current ??= new real.PaymentProviderRegistry()) };
});
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async () => ({ delivered: true, via: 'dm' }),
}));
const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('child_process', async orig => {
  const actual = await orig<typeof import('child_process')>();
  const { fakeFork } = await import('../helpers/forkMock');
  const fork = vi.fn(() => fakeFork());
  return { ...actual, fork, default: { ...actual, fork } };
});
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { getPremiumManager, resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { addFinalStopStep, beginStop, installStopHandler, isStopping } from '../../src/bot/internalSetup/utils/dataManager';
import { applySharedOp, PROVIDER_SENTENCE } from '../../src/bot/internalSetup/utils/sharedOps';
import { queuedFilePaths } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { runSealed } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { releaseWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { forks } from '../helpers/forkMock';
import { failFlushes } from '../helpers/configRig';
import { answering, exitChild, freshWriterLock, resetForks, startedWith } from '../helpers/nb10Rig';
import { clearGlobal, gate, paidSub, PREMIUM, quiet, settleQueue, tick, writePremium } from './nb10PremiumRig';

const G = '900000000000000867';
const role = process.env.BOT_PROCESS_ROLE;
const signals = { term: process.listeners('SIGTERM'), int: process.listeners('SIGINT') };
const STOP_HELD = 'The bot is stopping and could not confirm your change was saved; it may be lost. Check once the bot is started again.';
let childReply: any = null;

beforeAll(async () => {
  quiet();
  resetForks();
  freshWriterLock('webui', new Set([process.pid, 77]));
  resetPremiumManager();
  reg.current = null;
  await settleQueue();
  clearGlobal();
});

afterAll(async () => {
  for (const child of forks.children) if (child.exitCode === null) exitChild(child);
  for (const l of process.listeners('SIGTERM')) if (!signals.term.includes(l)) process.off('SIGTERM', l);
  for (const l of process.listeners('SIGINT')) if (!signals.int.includes(l)) process.off('SIGINT', l);
  resetPremiumManager();
  reg.current = null;
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { recursive: true, force: true });
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
  vi.restoreAllMocks();
});

describe("an expire-now whose subscription another op removed, that op's save queued at the bot's real stop", () => {
  it('answers held in the words of a stop: no retry is promised and the change may be lost', async () => {
    let exited = false;
    vi.spyOn(process, 'exit').mockImplementation((() => { exited = true; return undefined as never; }) as typeof process.exit);
    process.env.BOT_PROCESS_ROLE = 'bot';
    writePremium({ [G]: { active: paidSub('sA', 'pA', 'low', 'patreon'), paused: [] } });
    const cancel = gate();
    getPaymentRegistry().register({
      id: 'patreon', displayName: 'patreon', capabilities: { supportsCancel: true }, isConfigured: () => true,
      cancelSubscription: async () => { await cancel.promise; },
    } as any);
    const answer = applySharedOp({ op: 'premium.cancelPaidSubscriptionImmediately', args: { args: [G] } });
    await tick();
    const undo = failFlushes(PREMIUM);
    try {
      await runSealed('console', null, null, async () => {
        const pm = getPremiumManager() as any;
        delete pm.config.subscriptions[G];
        pm.save();
      });
      expect(queuedFilePaths()).toContain(PREMIUM);
      installStopHandler();
      let stoppingAtOpen: boolean | null = null;
      let stoppedAtOpen: unknown = null;
      addFinalStopStep(() => {
        stoppingAtOpen = isStopping();
        stoppedAtOpen = (getPremiumManager() as any).stopped;
        cancel.open();
      });
      void beginStop();
      const { reply, raw } = await answer.then(r => ({ reply: r as any, raw: fs.readFileSync(PREMIUM, 'utf8') }));
      expect(stoppingAtOpen).toBe(true);
      expect(stoppedAtOpen).toBe('stopping');
      expect(reply).toMatchObject({ ok: false, code: 'unconfirmed', answer: 'held' });
      expect(reply.error).toContain('could not confirm your change was saved; it may be lost');
      expect(reply.error).not.toContain('keeps retrying');
      expect(reply.error).not.toContain('Please check again in a few minutes');
      expect(reply.error).toContain(PROVIDER_SENTENCE);
      expect(JSON.parse(raw).subscriptions[G].active.id).toBe('sA');
      childReply = reply;
      await vi.waitFor(() => expect(exited).toBe(true), { timeout: 15_000, interval: 20 });
    } finally {
      undo();
    }
  }, 30_000);

  it("BotManager words that answer as the operator's Stop, with the provider sentence", async () => {
    expect(childReply).not.toBeNull();
    delete process.env.BOT_PROCESS_ROLE;
    const { manager, child } = await startedWith([{ stage: 'shared' }, { stage: 'guild' }]);
    const held = gate();
    answering(child, async m => {
      if (m.type === 'shared:op') {
        await held.promise;
        return childReply;
      }
      return undefined;
    });
    const sent = manager.runSharedOp('premium.cancelPaidSubscriptionImmediately', { args: [G] });
    await tick(10);
    const stopping = manager.shutdown(false);
    held.open();
    const reply: any = await sent;
    exitChild(child, 0);
    await stopping.catch(() => undefined);
    expect(reply).toMatchObject({ ok: false, code: 'unconfirmed', answer: 'held' });
    expect(reply.error).toBe(`${STOP_HELD} ${PROVIDER_SENTENCE}`);
    expect(reply.error).not.toContain('keeps retrying');
  });
});
