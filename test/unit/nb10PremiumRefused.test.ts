import fs from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 test 34 (decisions 12 and 20): in the bot a premium or Dummy save the disk refuses stays in the cache, answers
// held and is written by the retry, with its audit lines in order; a refusal of the stop or a deposition is never
// held; after the final stop step nothing is written, every later change, line, event and notice is refused and
// logged. In the local chain a refused change is dropped before the next op.

const inject = vi.hoisted(() => ({ refuse: new Map<string, string>() }));
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

const safety = vi.hoisted(() => ({ recordCrash: vi.fn(), isInSafeMode: () => false, getStatus: () => ({}) }));
vi.mock('../../src/utils/updateSafety', () => ({ getSafetyManager: () => safety }));

import { BotManager, inLocalOp } from '../../src/webui/botManager';
import { setSharedWriteGate } from '../../src/bot/internalSetup/utils/dataManager';
import { failFlushes } from '../helpers/configRig';
import { freshWriterLock } from '../helpers/nb10Rig';
import { getPremiumManager, resetPremiumManager, startPremiumTickers } from '../../src/bot/internalSetup/utils/premiumManager';
import { DummyProvider } from '../../src/bot/internalSetup/utils/payment/dummyProvider';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { applySharedOp, invalidateSharedCaches, PROVIDER_SENTENCE } from '../../src/bot/internalSetup/utils/sharedOps';
import { runSealed } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { verdictOf } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { reopenSharedWrites } from '../../src/bot/internalSetup/utils/dataManager';
import { checkWriterLock, configureWriterLock, releaseWriterLock, takeWriterLock, writerLockDepth, writerLockPath } from '../../src/bot/internalSetup/utils/writerLock';
import { AUDIT, clearGlobal, DUMMY_STATE, gate, JOURNAL, jsonOf, linesOf, logged, paidSub, PREMIUM, quiet, rawOf, settleQueue, tick, writePremium } from './nb10PremiumRig';

const role = process.env.BOT_PROCESS_ROLE;
const STORAGE = 'storage-failing';
const refuse = (...files: string[]) => { for (const f of files) inject.refuse.set(f, STORAGE); };
const recover = () => inject.refuse.clear();
const grant = (guildId = 'g1', tierId = 'high') => applySharedOp({ op: 'premium.grantManual', args: { args: [guildId, tierId, 30] } });

let spies: ReturnType<typeof quiet>;
beforeAll(() => clearGlobal());
beforeEach(async () => {
  spies = quiet();
  recover();
  await settleQueue();
  resetPremiumManager();
  reg.current = null;
  notices.sent = [];
  clearGlobal();
  writePremium();
  process.env.BOT_PROCESS_ROLE = 'bot';
});
afterEach(async () => {
  recover();
  resetPremiumManager();
  for (const p of reg.current?.listAll() ?? []) (p as any).dispose?.();
  reg.current = null;
  await settleQueue();
  vi.restoreAllMocks();
});
afterAll(() => {
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe('a refused save in the bot is held and retried', () => {
  it('premium.grantManual answers held with the provider sentence, stays in the cache and lands once the disk recovers', async () => {
    refuse('premium-tiers.json', 'premium-tiers.audit.jsonl');
    const reply: any = await grant();
    expect(reply).toMatchObject({ ok: false, code: 'unconfirmed', answer: 'held' });
    expect(reply.error).toContain('the bot keeps retrying');
    expect(reply.error.endsWith(PROVIDER_SENTENCE)).toBe(true);
    expect(getPremiumManager().resolveActiveTier('g1').tierId).toBe('high');
    expect(notices.sent).toContain('manual.grant.added:g1');
    recover();
    await vi.waitFor(() => expect(jsonOf(PREMIUM).subscriptions.g1.active.tierId).toBe('high'), { timeout: 5000, interval: 50 });
    await vi.waitFor(() => expect(linesOf(AUDIT).map(l => l.action)).toEqual(['subscription.grant.manual']), { timeout: 5000, interval: 50 });
  });

  it("a Discord command's refused premium save answers held the same way", async () => {
    refuse('premium-tiers.json');
    const verdict = await runSealed('interaction', null, 'mod', async ledger => {
      getPremiumManager().setMessages({ moduleBlocked: 'no' });
      return verdictOf([ledger]);
    });
    expect(verdict).toMatchObject({ ok: false, answer: 'held' });
  });

  it('a refusal of the stop is never held: it answers not saved and nothing retries it', async () => {
    inject.refuse.set('premium-tiers.json', 'node-stopping');
    const verdict = await runSealed('console', null, null, async ledger => {
      getPremiumManager().setMessages({ moduleBlocked: 'no' });
      return verdictOf([ledger]);
    });
    expect(verdict).toMatchObject({ ok: false, answer: 'node-stopping' });
    expect((getPremiumManager() as any).saveHeld).toBe(false);
    expect((getPremiumManager() as any).retryTimer).toBeNull();
  });

  it('the folder refusing both files: each op answers held, and the retry writes each change and its lines once, in order', async () => {
    const dummy = new DummyProvider();
    getPaymentRegistry().register(dummy);
    const bought = await dummy.initiatePurchase({ guildId: 'g2', tierId: 'low', offeringId: 'o1', variantId: 'dummy_monthly_999' } as any);
    writePremium({ g2: { active: paidSub('s2', bought.providerSubId!, 'low', 'dummy'), paused: [] } });
    refuse('premium-tiers.json', 'premium-tiers.audit.jsonl');
    expect(await grant('g1')).toMatchObject({ answer: 'held' });
    expect(await applySharedOp({ op: 'premium.cancelPaidSubscriptionImmediately', args: { args: ['g2'] } })).toMatchObject({ answer: 'held' });
    const stricter = { ...jsonOf(PREMIUM).tiers.high, overrides: {} };
    expect(await applySharedOp({ op: 'premium.setTier', args: { args: ['high', stricter] } })).toMatchObject({ answer: 'held' });
    recover();
    await vi.waitFor(() => expect(linesOf(AUDIT)).toHaveLength(3), { timeout: 5000, interval: 50 });
    expect(linesOf(AUDIT).map(l => l.action)).toEqual(['subscription.grant.manual', 'subscription.cancel.paid', 'tier.update']);
    await vi.waitFor(() => expect(jsonOf(PREMIUM).subscriptions.g1?.active?.tierId).toBe('high'), { timeout: 5000, interval: 50 });
    const saved = jsonOf(PREMIUM);
    expect(saved.subscriptions.g1.active.tierId).toBe('high');
    expect(saved.subscriptions.g2).toBeUndefined();
  });

  it('a held stricter setTier dispatches the subscriber notice at once and writes its tier.update line through the retry', async () => {
    const base = jsonOf(PREMIUM);
    writePremium({ g1: { active: paidSub('s1', 'ps1', 'high'), paused: [] } }, {
      tiers: { ...base.tiers, high: { ...base.tiers.high, overrides: { nb10mod: { feature: true } } } },
    });
    refuse('premium-tiers.json', 'premium-tiers.audit.jsonl');
    const stricter = { ...jsonOf(PREMIUM).tiers.high, overrides: {} };
    const reply: any = await applySharedOp({ op: 'premium.setTier', args: { args: ['high', stricter] } });
    expect(reply).toMatchObject({ ok: false, code: 'unconfirmed', answer: 'held' });
    expect(notices.sent).toEqual(['tier.config-change-affecting-subscriber:g1']);
    expect(linesOf(AUDIT)).toEqual([]);
    recover();
    await vi.waitFor(() => expect(linesOf(AUDIT).map(l => l.action)).toEqual(['tier.update']), { timeout: 5000, interval: 50 });
    await vi.waitFor(() => expect(jsonOf(PREMIUM).tiers.high.overrides).toEqual({}), { timeout: 5000, interval: 50 });
    expect(jsonOf(PREMIUM).tiers.high.overrides).toEqual({});
    expect(notices.sent).toEqual(['tier.config-change-affecting-subscriber:g1']);
  });

  it('the Dummy state the same: held, then written by the retry', async () => {
    const dummy = new DummyProvider();
    getPaymentRegistry().register(dummy);
    refuse('state.json');
    const reply = await applySharedOp({ op: 'dummy.adminSetVariant', args: { args: [{ variantId: 'v9', label: 'V9', amount: 1, currency: 'USD', durationDays: 1, recurring: false, active: true }] } });
    expect(reply).toMatchObject({ ok: false, code: 'unconfirmed', answer: 'held' });
    recover();
    await vi.waitFor(() => expect(Object.keys(jsonOf(DUMMY_STATE)?.variants ?? {})).toContain('v9'), { timeout: 5000, interval: 50 });
  });
});

describe('the final stop step', () => {
  it('logs a held change and each held line; then nothing is written, and later changes, lines and notices are refused', async () => {
    writePremium({ g2: { active: paidSub('s2', 'ps2', 'low', 'slow'), paused: [] } });
    const cancel = gate();
    getPaymentRegistry().register({
      id: 'slow', displayName: 'Slow', capabilities: { supportsCancel: true }, isConfigured: () => true,
      cancelSubscription: () => cancel.promise,
    } as any);
    const dummy = new DummyProvider();
    getPaymentRegistry().register(dummy);
    refuse('premium-tiers.json', 'premium-tiers.audit.jsonl');
    expect(await grant('g1')).toMatchObject({ answer: 'held' });
    const pm = getPremiumManager();
    startPremiumTickers();
    expect((dummy as any).tickTimer).not.toBeNull();
    expect((pm as any).expiryTimer).not.toBeNull();
    const resumed = applySharedOp({ op: 'premium.cancelPaidSubscriptionImmediately', args: { args: ['g2'] } });
    await tick(20);
    pm.finalStop();
    dummy.finalStop();
    expect((dummy as any).tickTimer).toBeNull();
    const errors = logged(spies.error);
    expect(errors).toContain('[PremiumManager] premium-tiers.json holds changes the disk refused; they are lost with this stop');
    expect(errors.some(l => /^\[PremiumManager\] The audit line subscription\.grant\.manual \(guild g1, .+\) was refused by the disk and is lost with this stop$/.test(l))).toBe(true);
    expect((pm as any).retryTimer).toBeNull();
    expect((pm as any).expiryTimer).toBeNull();
    cancel.open();
    const late: any = await resumed;
    expect(late.ok).toBe(false);
    expect(late.answer).toBe('node-stopping');
    expect(logged(spies.error).some(l => /^\[PremiumManager\] The audit line subscription\.cancel\.paid \(guild g2, .+\) was not written: the bot is stopping; it is lost$/.test(l))).toBe(true);
    expect(logged(spies.warn).some(l => l === '[PremiumManager] The paid.sub.cancelled-by-user notice for guild g2 was not sent: the bot is stopping')).toBe(true);
    const before = pm.getSubscriptions('g3');
    expect(await grant('g3')).toMatchObject({ ok: false, answer: 'node-stopping' });
    expect(pm.getSubscriptions('g3')).toEqual(before);
    recover();
    await new Promise(resolve => setTimeout(resolve, 1500));
    await settleQueue();
    expect(jsonOf(PREMIUM).subscriptions.g1).toBeUndefined();
    expect(jsonOf(PREMIUM).subscriptions.g2.active).toBeTruthy();
    expect(linesOf(AUDIT)).toEqual([]);
  });

  it("an event after the stop is refused: a webhook's op answers not saved and the log says its provider sends it again; a tick's is lost", async () => {
    const fetched = gate();
    getPaymentRegistry().register({
      id: 'hook', displayName: 'Hook', capabilities: {}, isConfigured: () => true,
      handleWebhook: async (body: Buffer) => {
        await fetched.promise;
        getPaymentRegistry().emitEvent(JSON.parse(body.toString()));
      },
    } as any);
    const event = { type: 'subscription.created', providerId: 'hook', providerSubId: 'h1', guildId: 'g5', tierId: 'low', offeringId: 'o1', state: { status: 'active', startDate: new Date().toISOString(), endDate: null, autoRenew: true } };
    const pm = getPremiumManager();
    const reply = applySharedOp({ op: 'payment.webhook', args: { providerId: 'hook', body: Buffer.from(JSON.stringify(event)).toString('base64') } });
    await tick(20);
    pm.finalStop();
    fetched.open();
    expect(await reply).toMatchObject({ ok: false, answer: 'node-stopping' });
    expect(logged(spies.error).some(l => l.startsWith('[PremiumManager] A subscription.created event from hook (subscription h1, guild g5) was not applied: the bot is stopping; the request that raised it is answered as not saved, and a webhook\'s provider sends it again: {'))).toBe(true);
    getPaymentRegistry().emitEvent({ ...event, providerSubId: 'h2' } as any);
    expect(logged(spies.error).some(l => l.startsWith('[PremiumManager] A subscription.created event from hook (subscription h2, guild g5) was not applied: the bot is stopping; it is lost: {'))).toBe(true);
    await settleQueue();
    expect(jsonOf(PREMIUM).subscriptions.g5).toBeUndefined();
  });
});

describe('a deposition', () => {
  it('stops premium at once: saves answer writer-lost, notices are not sent, nothing claims a retry', async () => {
    const pm = getPremiumManager();
    while (writerLockDepth() > 0) releaseWriterLock();
    fs.rmSync(writerLockPath(), { force: true });
    configureWriterLock('bot', { pid: () => process.pid, alive: () => true, startOf: () => null, now: () => Date.now() });
    try {
      expect(takeWriterLock().kind).toBe('taken');
      fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: process.pid + 1, start: null, role: 'webui', at: Date.now() }));
      expect(checkWriterLock().kind).toBe('deposed');
      expect(pm.isStopped()).toBe(true);
      const verdict = await runSealed('console', null, null, async ledger => {
        expect(await pm.grantManual('g1', 'high', 3)).toBe(false);
        return verdictOf([ledger]);
      });
      expect(verdict).toMatchObject({ ok: false, answer: 'writer-lost' });
      expect(pm.resolveActiveTier('g1').tierId).toBe('free');
      expect((pm as any).retryTimer).toBeNull();
    } finally {
      // A take from depth 0 forgets the deposition; the release leaves the lock free for the next test.
      fs.rmSync(writerLockPath(), { force: true });
      takeWriterLock();
      while (writerLockDepth() > 0) releaseWriterLock();
      reopenSharedWrites();
    }
  });

  /** Takes the lock as the bot, runs body, then the lock names another process and the check deposes this one. */
  async function deposedAfter(body: () => Promise<void>): Promise<void> {
    while (writerLockDepth() > 0) releaseWriterLock();
    fs.rmSync(writerLockPath(), { force: true });
    configureWriterLock('bot', { pid: () => process.pid, alive: () => true, startOf: () => null, now: () => Date.now() });
    try {
      expect(takeWriterLock().kind).toBe('taken');
      await body();
      fs.writeFileSync(writerLockPath(), JSON.stringify({ pid: process.pid + 1, start: null, role: 'webui', at: Date.now() }));
      expect(checkWriterLock().kind).toBe('deposed');
    } catch (error) {
      fs.rmSync(writerLockPath(), { force: true });
      takeWriterLock();
      while (writerLockDepth() > 0) releaseWriterLock();
      reopenSharedWrites();
      throw error;
    }
  }

  function undepose(): void {
    fs.rmSync(writerLockPath(), { force: true });
    takeWriterLock();
    while (writerLockDepth() > 0) releaseWriterLock();
    reopenSharedWrites();
  }

  it('a change and an audit line held from an earlier storage refusal are each logged once, worded for the deposition', async () => {
    try {
      const pm = getPremiumManager();
      const dummy = new DummyProvider();
      getPaymentRegistry().register(dummy);
      await deposedAfter(async () => {
        refuse('premium-tiers.json', 'premium-tiers.audit.jsonl');
        expect(await grant('g1')).toMatchObject({ ok: false, answer: 'held' });
        startPremiumTickers();
        expect((pm as any).expiryTimer).not.toBeNull();
        expect((dummy as any).tickTimer).not.toBeNull();
      });
      recover();
      expect(pm.isStopped()).toBe(true);
      spies.error.mockClear();
      pm.finalStop();
      dummy.finalStop();
      pm.logLossesAtExit();
      expect((dummy as any).tickTimer).toBeNull();
      const errors = logged(spies.error);
      expect(errors.filter(l => l === '[PremiumManager] premium-tiers.json holds changes the disk refused; they are lost: another process took the data files')).toHaveLength(1);
      expect(errors.filter(l => /^\[PremiumManager\] The audit line subscription\.grant\.manual \(guild g1, [^)]+\) was refused by the disk and is lost: another process took the data files$/.test(l))).toHaveLength(1);
      expect(errors.filter(l => l.includes('with this stop') || l.includes('the bot is stopping'))).toEqual([]);
      expect((pm as any).expiryTimer).toBeNull();
      expect((pm as any).retryTimer).toBeNull();
      await settleQueue();
      expect(jsonOf(PREMIUM).subscriptions).toEqual({});
      expect(rawOf(AUDIT)).toBeNull();
    } finally {
      undepose();
    }
  });

  it('an event whose journal line has not landed is logged once at the exit, worded for the deposition', async () => {
    const event = { type: 'subscription.expired', providerId: 'discord', providerSubId: 'd1', guildId: 'g1', state: { status: 'expired', startDate: new Date().toISOString(), endDate: new Date(Date.now() - 1000).toISOString(), autoRenew: false } };
    try {
      fs.writeFileSync(PREMIUM, '{ broken');
      const pm = getPremiumManager();
      await deposedAfter(async () => {
        expect(pm.cacheState()).toBe('unreadable');
        refuse('premium-tiers.events.jsonl');
        getPaymentRegistry().emitEvent(event as any);
        recover();
      });
      spies.error.mockClear();
      pm.finalStop();
      pm.logLossesAtExit();
      const errors = logged(spies.error);
      expect(errors).toEqual([`[PremiumManager] A subscription.expired event from discord (subscription d1, guild g1) was received while premium-tiers.json could not be read and is lost: another process took the data files: ${JSON.stringify(event)}`]);
      expect(rawOf(PREMIUM)).toBe('{ broken');
      expect(rawOf(JOURNAL)).toBeNull();
    } finally {
      undepose();
    }
  });
});

describe('events kept in memory while premium-tiers.json cannot be read (NB10 tests 25 and 41)', () => {
  const event = { type: 'subscription.expired', providerId: 'discord', providerSubId: 'd1', guildId: 'g1', state: { status: 'expired', startDate: new Date().toISOString(), endDate: new Date(Date.now() - 1000).toISOString(), autoRenew: false } };

  it('the same process applies the kept event once the file can be read and the tickers run, and its mark covers its line', async () => {
    fs.writeFileSync(PREMIUM, '{ broken');
    const pm = getPremiumManager();
    expect(pm.cacheState()).toBe('unreadable');
    getPaymentRegistry().emitEvent(event as any);
    await settleQueue();
    expect(linesOf(JOURNAL)).toHaveLength(1);
    writePremium({ g1: { active: paidSub('s1', 'd1', 'low', 'discord'), paused: [] } });
    // The load is tried again at most every 5 s.
    (pm as any).lastLoadTry = -Infinity;
    expect(pm.resolveActiveTier('g1').tierId).toBe('low');
    expect(pm.cacheState()).toBe('replaying');
    startPremiumTickers();
    await vi.waitFor(() => expect(rawOf(JOURNAL)).toBeNull(), { timeout: 5000, interval: 20 });
    const saved = jsonOf(PREMIUM);
    expect(saved.subscriptions.g1.active).toBeUndefined();
    expect(Object.values(saved.eventsApplied)).toEqual([1]);
    expect(notices.sent).toEqual(['paid.sub.expired:g1']);
    pm.stopExpiryChecker();
  });

  it('an event whose journal line was refused stays in memory, and the exit logs it as lost with its JSON', async () => {
    fs.writeFileSync(PREMIUM, '{ broken');
    const pm = getPremiumManager();
    refuse('premium-tiers.events.jsonl');
    getPaymentRegistry().emitEvent(event as any);
    recover();
    expect(logged(spies.warn).some(l => l.includes('its line in premium-tiers.events.jsonl was refused (storage-failing), so it is kept in memory only'))).toBe(true);
    pm.finalStop();
    spies.error.mockClear();
    pm.logLossesAtExit();
    expect(logged(spies.error)).toEqual([`[PremiumManager] A subscription.expired event from discord (subscription d1, guild g1) was received while premium-tiers.json could not be read and is lost with this stop: ${JSON.stringify(event)}`]);
  });
});

describe('the local chain (web UI, no child)', () => {
  it('through one BotManager chain: op 1 cancelled by land-or-cancel answers disk with the provider sentence; op 2 writes no grant', async () => {
    delete process.env.BOT_PROCESS_ROLE;
    setSharedWriteGate(() => inLocalOp());
    freshWriterLock('webui');
    const undo = failFlushes(PREMIUM);
    try {
      const manager = new BotManager();
      const first = manager.runSharedOp('premium.grantManual', { args: ['g1', 'high', 30] });
      const stricter = { ...jsonOf(PREMIUM).tiers.low, displayName: 'Lower' };
      const second = manager.runSharedOp('premium.setTier', { args: ['low', stricter] });
      const one: any = await first;
      expect(one).toMatchObject({ ok: false, code: 'disk' });
      expect(one.error).toContain('premium-tiers.json');
      expect(one.error.endsWith(PROVIDER_SENTENCE)).toBe(true);
      undo();
      expect(await second).toMatchObject({ ok: true });
      await settleQueue();
      expect(jsonOf(PREMIUM).tiers.low.displayName).toBe('Lower');
      expect(jsonOf(PREMIUM).subscriptions.g1).toBeUndefined();
      expect(getPremiumManager().resolveActiveTier('g1').tierId).toBe('free');
      expect(fs.existsSync(writerLockPath())).toBe(false);
    } finally {
      undo();
      setSharedWriteGate(null);
    }
  }, 30_000);

  it('op 1 refused, then the caches are dropped: op 2 writes a file without op 1 change', async () => {
    delete process.env.BOT_PROCESS_ROLE;
    refuse('premium-tiers.json');
    const first: any = await grant('g1');
    expect(first).toMatchObject({ ok: false, code: 'unconfirmed', answer: STORAGE });
    expect(first.error.endsWith(PROVIDER_SENTENCE)).toBe(true);
    invalidateSharedCaches();
    recover();
    const stricter = { ...jsonOf(PREMIUM).tiers.low, displayName: 'Lower' };
    expect(await applySharedOp({ op: 'premium.setTier', args: { args: ['low', stricter] } })).toMatchObject({ ok: true });
    await settleQueue();
    expect(jsonOf(PREMIUM).tiers.low.displayName).toBe('Lower');
    expect(jsonOf(PREMIUM).subscriptions.g1).toBeUndefined();
    expect(getPremiumManager().resolveActiveTier('g1').tierId).toBe('free');
  });
});
