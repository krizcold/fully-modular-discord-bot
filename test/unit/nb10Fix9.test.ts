import fs from 'fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 code review round 8, the fixer's regression tests: a cancel whose subscription another op removed is judged
// after a stop by the last premium save handed to the disk, so a deposition's drop and a removal made only in memory
// never answer ok (NB10-R8-D2, NB10-R9-O1); a Stop sent while a restart drains makes it a stop (NB10-R9-O2).

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

import { ROUTE_TEXT } from '../../src/webui/botManager';
import { getPremiumManager, resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { applySharedOp, PROVIDER_SENTENCE } from '../../src/bot/internalSetup/utils/sharedOps';
import { queuedFilePaths } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { runSealed } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { reopenSharedWrites, setSharedWriteGate } from '../../src/bot/internalSetup/utils/dataManager';
import { checkWriterLock, configureWriterLock, releaseWriterLock, takeWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { forks } from '../helpers/forkMock';
import { failFlushes } from '../helpers/configRig';
import { answering, exitChild, freshWriterLock, resetForks, startedWith } from '../helpers/nb10Rig';
import { clearGlobal, gate, jsonOf, paidSub, PREMIUM, quiet, settleQueue, tick, writePremium } from './nb10PremiumRig';

const G = '900000000000000966';
const OTHER = 5455;
const live = new Set<number>([process.pid, OTHER]);
const role = process.env.BOT_PROCESS_ROLE;

const op = (name: string, ...args: unknown[]) => applySharedOp({ op: name, args: { args } });

function takeAsBot(): void {
  process.env.BOT_PROCESS_ROLE = 'bot';
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { force: true });
  configureWriterLock('bot', { pid: () => process.pid, alive: p => live.has(p), startOf: () => null, now: () => Date.now() });
  expect(takeWriterLock().kind).toBe('taken');
}

function deposeNow(): void {
  fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: OTHER, start: null, role: 'bot', at: Date.now() }));
  expect(checkWriterLock()).toMatchObject({ kind: 'deposed' });
}

/** A provider whose cancels wait, in call order, for the gates given. */
function registerCancels(...gates: Promise<unknown>[]): void {
  let call = 0;
  getPaymentRegistry().register({
    id: 'slow', displayName: 'Slow', capabilities: { supportsCancel: true }, isConfigured: () => true,
    cancelSubscription: () => gates[call++] ?? Promise.resolve(),
  } as any);
}

const removeElsewhere = () => runSealed('console', null, null, async () => {
  const pm = getPremiumManager() as any;
  delete pm.config.subscriptions[G];
  pm.save();
});

beforeEach(async () => {
  quiet();
  await settleQueue();
  resetPremiumManager();
  reg.current = null;
  clearGlobal();
});

afterEach(async () => {
  for (const child of forks.children) if (child.exitCode === null) exitChild(child);
  setSharedWriteGate(null);
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { recursive: true, force: true });
  takeWriterLock();
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { recursive: true, force: true });
  reopenSharedWrites();
  resetPremiumManager();
  reg.current = null;
  await settleQueue();
  vi.restoreAllMocks();
});

afterAll(() => {
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe('a cancel whose subscription another op removed, judged by the last premium save (NB10-R8-D2, NB10-R9-O1)', () => {
  it("answers writer-lost when a deposition dropped that op's unflushed save", async () => {
    takeAsBot();
    writePremium({ [G]: { active: paidSub('sA', 'pA', 'low', 'slow'), paused: [] } });
    const cancel = gate();
    registerCancels(cancel.promise);
    const reply = op('premium.cancelPaidSubscriptionImmediately', G);
    await tick(30);
    const undo = failFlushes(PREMIUM);
    try {
      await removeElsewhere();
      expect(queuedFilePaths()).toContain(PREMIUM);
      deposeNow();
      expect(queuedFilePaths()).not.toContain(PREMIUM);
      cancel.open();
      const answered: any = await reply;
      expect(answered.ok).toBe(false);
      expect(answered).toMatchObject({ code: 'unconfirmed', answer: 'writer-lost' });
      expect(answered.error).toContain(PROVIDER_SENTENCE);
    } finally {
      undo();
    }
    await settleQueue();
    expect(jsonOf(PREMIUM).subscriptions[G].active.id).toBe('sA');
  }, 20_000);

  it('a second cancel of a subscription the first removed only in memory after the stop answers not saved', async () => {
    takeAsBot();
    writePremium({ [G]: { active: paidSub('sA', 'pA', 'low', 'slow'), paused: [] } });
    const first = gate();
    const second = gate();
    registerCancels(first.promise, second.promise);
    const one = op('premium.cancelPaidSubscriptionImmediately', G);
    const two = op('premium.cancelPaidSubscriptionImmediately', G);
    await tick(30);
    const pm = getPremiumManager() as any;
    pm.stopped = 'stopping';
    try {
      first.open();
      expect(await one).toMatchObject({ ok: false, answer: 'node-stopping' });
      expect(pm.config.subscriptions[G]).toBeUndefined();
      second.open();
      const answered: any = await two;
      expect(answered.ok).toBe(false);
      expect(answered).toMatchObject({ code: 'unconfirmed', answer: 'node-stopping' });
      expect(answered.error).toContain(PROVIDER_SENTENCE);
    } finally {
      pm.stopped = null;
    }
    expect(jsonOf(PREMIUM).subscriptions[G].active.id).toBe('sA');
  });
});

describe("a Stop sent while a restart's stop drains makes it a stop (NB10-R9-O2)", () => {
  it('routes and the answer of an op sent before read as a stop, and nothing starts again', async () => {
    delete process.env.BOT_PROCESS_ROLE;
    resetForks();
    freshWriterLock('webui', new Set([process.pid, 77]));
    const { manager, child } = await startedWith([{ stage: 'shared' }, { stage: 'guild' }]);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    answering(child, async m => {
      if (m.type === 'shared:op') {
        await held;
        return { ok: false, code: 'unconfirmed', answer: 'node-stopping', partial: false, error: 'The bot is restarting, so your change was not saved. Please try again in a moment.' };
      }
      return undefined;
    });
    const sent = manager.runSharedOp('premium.grantManual', { args: [] });
    await tick(10);
    const restarting = manager.restart();
    await tick(10);
    expect((manager.writerRoute('shared') as any).error).toBe(ROUTE_TEXT.restarting);
    const stopping = manager.shutdown(false);
    await tick(10);
    expect((manager.writerRoute('shared') as any).error).toBe(ROUTE_TEXT.stopping);
    release();
    const reply: any = await sent;
    expect(reply.error).toBe(`The bot is stopping, so your change was not saved. Save again once it is started. ${PROVIDER_SENTENCE}`);
    const before = forks.children.length;
    exitChild(child, 0);
    await stopping;
    expect(await restarting).toMatchObject({ success: false, reason: 'stopped' });
    expect(forks.children.length).toBe(before);
  });
});
