import fs from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 test 26, rounds 4 and 6, with real premium ops: a deposition during a local premium op answers by what landed
// (case e: an op sent while the deposed one still waits answers the deposed text and takes nothing); in the bot, a
// grantManual awaiting a provider pause after its save landed answers writer-lost, not saved in full, and sends no
// notice (case g), a webhook held in its fetch across the deposition answers 503 (case f), and a cancel whose provider
// call returned before it answers writer-lost (case c).

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
const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { BotManager, deposedRouteText, inLocalOp } from '../../src/webui/botManager';
import { getPremiumManager, resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { webhookAnswer } from '../../src/webui/routes/hopFailure';
import { queuedFilePaths } from '../../src/bot/internalSetup/utils/dataBackends/fileBackend';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { applySharedOp, PROVIDER_SENTENCE } from '../../src/bot/internalSetup/utils/sharedOps';
import { reopenSharedWrites, setSharedWriteGate } from '../../src/bot/internalSetup/utils/dataManager';
import { checkWriterLock, configureWriterLock, releaseWriterLock, takeWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { failFlushes } from '../helpers/configRig';
import { freshWriterLock } from '../helpers/nb10Rig';
import { AUDIT, clearGlobal, gate, jsonOf, linesOf, logged, paidSub, PREMIUM, quiet, rawOf, settleQueue, tick, writePremium } from './nb10PremiumRig';

const OTHER = 5454;
const LOST_IN_PART = "Another process took over the bot's data files, so your change was not saved in full.";
const RELOAD = 'Reload to see it before you try again: trying again could apply the saved part twice.';
const live = new Set<number>([process.pid, OTHER]);
const role = process.env.BOT_PROCESS_ROLE;
let spies: ReturnType<typeof quiet>;

function deposeNow(): void {
  fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: OTHER, start: null, role: 'bot', at: Date.now() }));
  expect(checkWriterLock()).toMatchObject({ kind: 'deposed' });
}

/** A provider whose cancel and pause wait for the gates the test opens. */
function registerSlow(cancel: Promise<unknown>, pause: Promise<unknown>): void {
  getPaymentRegistry().register({
    id: 'slow', displayName: 'Slow', capabilities: { supportsCancel: true, supportsPause: true }, isConfigured: () => true,
    cancelSubscription: () => cancel,
    pauseSubscription: () => pause,
  } as any);
}

beforeAll(() => clearGlobal());
beforeEach(async () => {
  spies = quiet();
  await settleQueue();
  resetPremiumManager();
  reg.current = null;
  notices.sent = [];
  clearGlobal();
});
afterEach(async () => {
  setSharedWriteGate(null);
  // A take from depth 0 forgets the deposition; the release leaves the lock free for the next test.
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { force: true });
  takeWriterLock();
  while (writerLockDepth() > 0) releaseWriterLock();
  fs.rmSync(writerLockPath(), { force: true });
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

describe('the web UI deposed during a real premium op (NB10 test 26)', () => {
  beforeEach(() => {
    delete process.env.BOT_PROCESS_ROLE;
    setSharedWriteGate(() => inLocalOp());
    freshWriterLock('webui', live);
  });

  it('a cancel whose audit line landed and whose provider call returned before the deposition answers not saved in full', async () => {
    writePremium({ g2: { active: paidSub('s2', 'ps2', 'low', 'slow'), paused: [] } });
    const before = rawOf(PREMIUM);
    const cancel = gate();
    registerSlow(cancel.promise, Promise.resolve());
    const manager = new BotManager();
    const reply = manager.runSharedOp('premium.cancelPaidSubscriptionImmediately', { args: ['g2'] });
    await tick(30);
    const undo = failFlushes(PREMIUM);
    try {
      cancel.open();
      await vi.waitFor(() => expect(linesOf(AUDIT).map(l => l.action)).toEqual(['subscription.cancel.paid']), { timeout: 5000, interval: 10 });
      deposeNow();
      expect(await reply).toEqual({
        ok: false, status: 503, code: 'held-elsewhere',
        error: `Another process took the data files (a bot process this web UI did not start, pid ${OTHER}) while your change was being saved; it was not saved in full. What was saved: premium-tiers.audit.jsonl. Reload to see it before you try again: trying again could apply the saved part twice. ${PROVIDER_SENTENCE}`,
      });
    } finally {
      undo();
    }
    await settleQueue();
    expect(rawOf(PREMIUM)).toBe(before);
    expect(JSON.parse(fs.readFileSync(writerLockPath(), 'utf8')).pid).toBe(OTHER);
  }, 30_000);

  it('case (e): an op sent while the deposed cancel waits answers the deposed text and takes nothing; after it, a new op runs alone', async () => {
    writePremium({ g2: { active: paidSub('s2', 'ps2', 'low', 'slow'), paused: [] } });
    const cancel = gate();
    registerSlow(cancel.promise, Promise.resolve());
    const manager = new BotManager();
    const cancelling = manager.runSharedOp('premium.cancelPaidSubscriptionImmediately', { args: ['g2'] });
    await tick(30);
    deposeNow();
    fs.unlinkSync(writerLockPath());
    const lower = { ...jsonOf(PREMIUM).tiers.low, displayName: 'Lower' };
    expect(await manager.runSharedOp('premium.setTier', { args: ['low', lower] })).toMatchObject({
      ok: false, code: 'held-elsewhere', error: deposedRouteText({ role: 'bot', pid: OTHER }),
    });
    expect(fs.existsSync(writerLockPath())).toBe(false);
    expect(jsonOf(PREMIUM).tiers.low.displayName).toBe('Low');

    cancel.open();
    const answered: any = await cancelling;
    expect(answered).toMatchObject({ ok: false, code: 'held-elsewhere' });
    expect(answered.error).toBe(`Another process took the data files (a bot process this web UI did not start, pid ${OTHER}) while your change was being saved; nothing was saved. ${PROVIDER_SENTENCE}`);
    await settleQueue();
    expect(jsonOf(PREMIUM).subscriptions.g2.active).toBeTruthy();
    expect(linesOf(AUDIT)).toEqual([]);

    expect(await manager.runSharedOp('premium.setTier', { args: ['low', lower] })).toMatchObject({ ok: true });
    expect(jsonOf(PREMIUM).tiers.low.displayName).toBe('Lower');
    expect(fs.existsSync(writerLockPath())).toBe(false);
  }, 30_000);
});

describe('the bot deposed during a real premium op (NB10 test 26 case g)', () => {
  it('a grantManual awaiting a provider pause after its save landed answers writer-lost, not saved in full, with the provider sentence and sends no notice', async () => {
    process.env.BOT_PROCESS_ROLE = 'bot';
    while (writerLockDepth() > 0) releaseWriterLock();
    fs.rmSync(writerLockPath(), { force: true });
    configureWriterLock('bot', { pid: () => process.pid, alive: p => live.has(p), startOf: () => null, now: () => Date.now() });
    expect(takeWriterLock().kind).toBe('taken');
    writePremium({ g1: { active: paidSub('s1', 'ps1', 'low', 'slow'), paused: [] } });
    const pause = gate();
    registerSlow(Promise.resolve(), pause.promise);
    const reply = applySharedOp({ op: 'premium.grantManual', args: { args: ['g1', 'high', 30] } });
    await vi.waitFor(() => expect(jsonOf(PREMIUM).subscriptions.g1.active.tierId).toBe('high'), { timeout: 5000, interval: 10 });
    await settleQueue();
    const granted = rawOf(PREMIUM);
    deposeNow();
    pause.open();
    const answered: any = await reply;
    expect(answered).toMatchObject({ ok: false, code: 'unconfirmed', answer: 'writer-lost', partial: true });
    expect(answered.error).toBe(`${LOST_IN_PART} What was saved: premium-tiers.json, premium-tiers.audit.jsonl. ${RELOAD} ${PROVIDER_SENTENCE}`);
    expect(answered.error).not.toContain('Please try again');
    await tick(20);
    expect(notices.sent).toEqual([]);
    const warned = [...logged(spies.warn), ...logged(spies.error)];
    expect(warned.some(l => l.startsWith('[PremiumManager] The manual.grant.added notice for guild g1 was not sent'))).toBe(true);
    expect((await import('../../src/bot/internalSetup/utils/premiumManager')).getPremiumManager().isStopped()).toBe(true);
    await settleQueue();
    expect(rawOf(PREMIUM)).toBe(granted);
    const saved = jsonOf(PREMIUM).subscriptions.g1;
    expect(saved.active).toMatchObject({ tierId: 'high', source: 'manual' });
    expect(saved.paused.map((x: any) => x.id)).toEqual(['s1']);
    expect(linesOf(AUDIT).map(l => l.action)).toEqual(['subscription.pause']);
    expect(JSON.parse(fs.readFileSync(writerLockPath(), 'utf8')).pid).toBe(OTHER);
  });

  function takeAsBot(): void {
    process.env.BOT_PROCESS_ROLE = 'bot';
    while (writerLockDepth() > 0) releaseWriterLock();
    fs.rmSync(writerLockPath(), { force: true });
    configureWriterLock('bot', { pid: () => process.pid, alive: p => live.has(p), startOf: () => null, now: () => Date.now() });
    expect(takeWriterLock().kind).toBe('taken');
  }

  it('case (f): a payment.webhook whose handler is held in its fetch across the deposition writes nothing, logs the event once and answers 503', async () => {
    takeAsBot();
    writePremium({});
    getPremiumManager();
    const before = rawOf(PREMIUM);
    const fetched = gate();
    const event = { type: 'subscription.created', providerId: 'hook', providerSubId: 'ph1', guildId: 'g1', tierId: 'low', offeringId: 'o1', state: { status: 'active', startDate: new Date().toISOString(), endDate: new Date(Date.now() + 86_400_000).toISOString(), autoRenew: true } };
    getPaymentRegistry().register({
      id: 'hook', displayName: 'Hook', capabilities: {}, isConfigured: () => true,
      handleWebhook: async () => {
        await fetched.promise;
        getPaymentRegistry().emitEvent(event as any);
      },
    } as any);
    const reply = applySharedOp({ op: 'payment.webhook', args: { providerId: 'hook', body: Buffer.from('{}').toString('base64'), signature: '' } });
    await tick(30);
    deposeNow();
    fetched.open();
    const answered: any = await reply;
    expect(answered).toMatchObject({ ok: false });
    expect(webhookAnswer(answered).status).toBe(503);
    await settleQueue();
    expect(rawOf(PREMIUM)).toBe(before);
    expect(rawOf(AUDIT)).toBeNull();
    const lines = logged(spies.error).filter(l => l.includes('subscription ph1'));
    expect(lines).toEqual([`[PremiumManager] A subscription.created event from hook (subscription ph1, guild g1) was not applied: another process took the data files; the request that raised it is answered as not saved, and a webhook's provider sends it again: ${JSON.stringify(event)}`]);
  });

  it("case (c): a child's cancelPaidSubscriptionImmediately whose provider call returned before the deposition answers writer-lost with the provider sentence", async () => {
    takeAsBot();
    writePremium({ g2: { active: paidSub('s2', 'ps2', 'low', 'slow'), paused: [] } });
    const before = rawOf(PREMIUM);
    const cancel = gate();
    registerSlow(cancel.promise, Promise.resolve());
    const reply = applySharedOp({ op: 'premium.cancelPaidSubscriptionImmediately', args: { args: ['g2'] } });
    await tick(30);
    const undo = failFlushes(PREMIUM);
    try {
      cancel.open();
      await vi.waitFor(() => expect(linesOf(AUDIT).map(l => l.action)).toEqual(['subscription.cancel.paid']), { timeout: 5000, interval: 10 });
      expect(queuedFilePaths()).toContain(PREMIUM);
      deposeNow();
      const answered: any = await reply;
      expect(answered).toMatchObject({ ok: false, code: 'unconfirmed', answer: 'writer-lost', partial: true });
      expect(answered.error).toBe(`${LOST_IN_PART} What was saved: premium-tiers.audit.jsonl. ${RELOAD} ${PROVIDER_SENTENCE}`);
      expect(answered.error).not.toContain('Please try again');
    } finally {
      undo();
    }
    await settleQueue();
    expect(rawOf(PREMIUM)).toBe(before);
    expect(logged(spies.error).filter(l => l.startsWith(`[Data] Not saved: ${PREMIUM}; another process`))).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(writerLockPath(), 'utf8')).pid).toBe(OTHER);
  }, 30_000);
});
