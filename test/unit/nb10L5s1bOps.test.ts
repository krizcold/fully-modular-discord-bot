import fs from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 mutation gate, chunk 1 of premiumManager.ts: stored premium messages load as saved; a journal line whose event
// type is not a string holds nothing; the web UI never journals a provider event; a save or an audit line refused by
// a deposition answers not saved and names it; an install line the disk refused is written by the next delivery; a
// disposed cache logs nothing at exit; a failed replay is logged; a save reached after the stop, while the file
// cannot be read or while kept events wait, is refused and changes nothing on disk.

const hooks = vi.hoisted(() => ({
  save: null as null | ((file: string) => unknown),
  append: null as null | ((file: string) => unknown),
}));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  return {
    ...real,
    saveDataTracked: (f: string, o: any, d: unknown) => (hooks.save?.(f) as any) ?? real.saveDataTracked(f, o, d),
    appendDataTracked: (f: string, o: any, l: string) => (hooks.append?.(f) as any) ?? real.appendDataTracked(f, o, l),
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

import {
  getPremiumManager,
  invalidatePremiumCache,
  resetPremiumManager,
  startPremiumTickers,
} from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { markPaymentLedger, runSealed } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { AUDIT, clearGlobal, gate, JOURNAL, jsonOf, linesOf, logged, paidSub, PREMIUM, quiet, rawOf, settleQueue, state, writePremium } from './nb10PremiumRig';

type Manager = ReturnType<typeof getPremiumManager>;
const role = process.env.BOT_PROCESS_ROLE;
const asBot = (bot: boolean) => {
  if (bot) process.env.BOT_PROCESS_ROLE = 'bot';
  else delete process.env.BOT_PROCESS_ROLE;
};
const PREMIUM_DOC = 'global:/premium-tiers.json';
const refusedAs = (cause: string) => () => ({ outcome: 'refused', cause });
const failedEvent = { type: 'subscription.renewal-failed', providerId: 'fake', providerSubId: 'nope', guildId: 'g-none', reason: 'card' };
const created = (providerSubId: string, guildId = 'g1') => ({
  type: 'subscription.created', providerId: 'fake', providerSubId, guildId, tierId: 'low', offeringId: 'o1', state: state(),
});
const installLines = () => linesOf(AUDIT).filter(l => l?.action === 'subscription.install.paid');

function redeliver(pm: Manager, event: object) {
  return runSealed('console', null, 'premium', async ledger => {
    markPaymentLedger(ledger, 'payment.webhook');
    getPaymentRegistry().emitEvent(event as any);
    await pm.settled(ledger);
  });
}

/** A provider whose cancel waits for the gate the test opens. */
function slowProvider(): { open: () => void } {
  const cancel = gate();
  getPaymentRegistry().register({
    id: 'slow', displayName: 'Slow', capabilities: { supportsCancel: true }, isConfigured: () => true,
    cancelSubscription: () => cancel.promise,
  } as any);
  return { open: () => cancel.open() };
}

/** Starts an immediate cancel of g1's paid sub in its own op, runs `meanwhile` during the provider call, and answers the op. */
async function cancelAcross(pm: Manager, meanwhile: () => void): Promise<{ answer: boolean; refused: Array<{ cause: string; doc: string }> }> {
  const provider = slowProvider();
  return runSealed('console', null, 'premium', async ledger => {
    const done = pm.cancelPaidSubscriptionImmediately('g1');
    meanwhile();
    provider.open();
    const answer = await done;
    return { answer, refused: ledger.refusedDocs().map(r => ({ cause: r.cause, doc: r.doc })) };
  });
}

let spies: ReturnType<typeof quiet>;
beforeAll(() => clearGlobal());
beforeEach(async () => {
  spies = quiet();
  hooks.save = null;
  hooks.append = null;
  await settleQueue();
  resetPremiumManager();
  reg.current = null;
  clearGlobal();
  asBot(false);
});
afterEach(async () => {
  hooks.save = null;
  hooks.append = null;
  resetPremiumManager();
  reg.current = null;
  await settleQueue();
  vi.restoreAllMocks();
});
afterAll(() => {
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe('premium-tiers.json as loaded', () => {
  it('stored messages are answered as saved, over the defaults', () => {
    writePremium({}, { messages: { moduleBlocked: 'Ask an admin for Gold.' } });
    const pm = getPremiumManager();
    expect(pm.getMessages().moduleBlocked).toBe('Ask an admin for Gold.');
    expect(pm.getFullConfig().messages.moduleBlocked).toBe('Ask an admin for Gold.');
  });
});

describe('the web UI and the event journal', () => {
  it('a journal line whose event type is not a string holds nothing', () => {
    writePremium({});
    fs.writeFileSync(JOURNAL, `${JSON.stringify({ writer: 'w1', n: 1, event: { ...failedEvent, type: 5 } })}\n`);
    expect(getPremiumManager().heldEventsText()).toBeNull();
  });

  it('a provider event while premium-tiers.json cannot be read is not journaled by the web UI', async () => {
    fs.writeFileSync(PREMIUM, '{broken');
    const pm = getPremiumManager();
    expect(pm.cacheState()).toBe('unreadable');
    getPaymentRegistry().emitEvent(failedEvent as any);
    await settleQueue();
    expect(rawOf(JOURNAL)).toBeNull();
    expect(logged(spies.warn).filter(l => l.includes('arrived while'))).toEqual([]);
  });
});

describe('a save in the bot', () => {
  it('that throws is logged by its tag and answers not saved', () => {
    asBot(true);
    writePremium({});
    const pm = getPremiumManager();
    hooks.save = file => {
      if (file === 'premium-tiers.json') throw new Error('disk on fire');
      return undefined;
    };
    pm.setMessages({ moduleBlocked: 'x' });
    expect(spies.error.mock.calls.some((c: unknown[]) => c[0] === '[PremiumManager] Failed to save config:' && String(c[1]).includes('disk on fire'))).toBe(true);
  });

  it('refused because another process took the data files answers not saved and is not retried', async () => {
    asBot(true);
    writePremium({});
    const before = rawOf(PREMIUM);
    const pm = getPremiumManager();
    hooks.save = file => (file === 'premium-tiers.json' ? refusedAs('writer-lost')() : undefined);
    expect(pm.setMessages({ moduleBlocked: 'x' })).toBe(false);
    hooks.save = null;
    await settleQueue();
    expect(rawOf(PREMIUM)).toBe(before);
  });
});

describe('an audit line refused by a deposition in the bot', () => {
  it('is logged as lost to the other process, under guild none when it names no guild', async () => {
    asBot(true);
    writePremium({});
    const pm = getPremiumManager();
    hooks.append = file => (file === 'premium-tiers.audit.jsonl' ? refusedAs('writer-lost')() : undefined);
    expect(pm.setMessages({ moduleBlocked: 'x' })).toBe(true);
    const lost = logged(spies.error).filter(l => l.startsWith('[PremiumManager] The audit line message.update'));
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatch(/^\[PremiumManager\] The audit line message\.update \(guild none, [^)]+\) was not written: another process took the data files; it is lost$/);
  });
});

describe('an install line the disk refused', () => {
  it('in the web UI, is written by the next delivery', async () => {
    writePremium({});
    const pm = getPremiumManager();
    hooks.append = file => (file === 'premium-tiers.audit.jsonl' ? refusedAs('storage-failing')() : undefined);
    getPaymentRegistry().emitEvent(created('psW', 'g7') as any);
    await pm.settled(undefined);
    hooks.append = null;
    await settleQueue();
    expect(installLines()).toEqual([]);
    await redeliver(pm, created('psW', 'g7'));
    await settleQueue();
    const lines = installLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ guildId: 'g7', metadata: { redelivered: true } });
  });

  it('in the bot, refused by the stop, is written by the next delivery', async () => {
    asBot(true);
    writePremium({});
    const pm = getPremiumManager();
    hooks.append = file => (file === 'premium-tiers.audit.jsonl' ? refusedAs('node-stopping')() : undefined);
    getPaymentRegistry().emitEvent(created('psS', 'g8') as any);
    await pm.settled(undefined);
    hooks.append = null;
    await settleQueue();
    expect(installLines()).toEqual([]);
    await redeliver(pm, created('psS', 'g8'));
    await settleQueue();
    const lines = installLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ guildId: 'g8', metadata: { redelivered: true } });
  });
});

describe('the exit log', () => {
  it('a live cache logs a kept event as lost; a disposed one logs nothing', () => {
    asBot(true);
    fs.writeFileSync(PREMIUM, '{broken');
    hooks.append = file => (file === 'premium-tiers.events.jsonl' ? refusedAs('storage-failing')() : undefined);
    const pm = getPremiumManager();
    getPaymentRegistry().emitEvent(failedEvent as any);
    spies.error.mockClear();
    pm.logLossesAtExit();
    expect(logged(spies.error).filter(l => l.includes('was received while premium-tiers.json could not be read and is lost'))).toHaveLength(1);
    pm.dispose();
    spies.error.mockClear();
    pm.logLossesAtExit();
    expect(logged(spies.error)).toEqual([]);
  });
});

describe('a replay that cannot read the journal', () => {
  it('is logged as failed, keeps the journal, and leaves the cache unreadable', async () => {
    asBot(true);
    writePremium({});
    fs.writeFileSync(JOURNAL, `${JSON.stringify({ writer: 'w1', n: 1, event: failedEvent })}\n`);
    const pm = getPremiumManager();
    expect(pm.cacheState()).toBe('replaying');
    fs.rmSync(JOURNAL);
    fs.mkdirSync(JOURNAL);
    startPremiumTickers();
    await vi.waitFor(() => expect(pm.cacheState()).toBe('unreadable'), { timeout: 5000, interval: 10 });
    const failed = logged(spies.error).filter(l => l.includes('The replay of premium-tiers.events.jsonl failed'));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatch(/^\[PremiumManager\] The replay of premium-tiers\.events\.jsonl failed \(.+\); the journal stays and is replayed at the next load$/);
  });
});

describe('an immediate cancel whose save comes after the provider call', () => {
  const withSlow = () => writePremium({ g1: { active: paidSub('s1', 'px1', 'low', 'slow'), paused: [] } });

  it('after the stop came, answers not saved, refused by the stop, and the file keeps the subscription', async () => {
    asBot(true);
    withSlow();
    const pm = getPremiumManager();
    const { answer, refused } = await cancelAcross(pm, () => pm.markStopped('stopping'));
    expect(answer).toBe(false);
    expect(refused).toContainEqual({ cause: 'node-stopping', doc: PREMIUM_DOC });
    await settleQueue();
    expect(jsonOf(PREMIUM).subscriptions.g1.active.id).toBe('s1');
  });

  it('after premium-tiers.json became unreadable, answers not saved and leaves the file as it is', async () => {
    withSlow();
    const pm = getPremiumManager();
    const { answer, refused } = await cancelAcross(pm, () => {
      fs.writeFileSync(PREMIUM, '{broken');
      pm.getMessages();
      expect(pm.cacheState()).toBe('unreadable');
    });
    expect(answer).toBe(false);
    expect(refused).toContainEqual({ cause: 'io', doc: PREMIUM_DOC });
    await settleQueue();
    expect(rawOf(PREMIUM)).toBe('{broken');
  });

  it('after kept provider events began waiting, answers not saved and the file keeps the subscription', async () => {
    asBot(true);
    withSlow();
    const pm = getPremiumManager();
    const { answer, refused } = await cancelAcross(pm, () => {
      fs.writeFileSync(JOURNAL, `${JSON.stringify({ writer: 'w9', n: 1, event: failedEvent })}\n`);
      invalidatePremiumCache();
      pm.getFullConfig();
      expect(pm.cacheState()).toBe('replaying');
    });
    expect(answer).toBe(false);
    expect(refused).toContainEqual({ cause: 'not-ready', doc: PREMIUM_DOC });
    await settleQueue();
    expect(jsonOf(PREMIUM).subscriptions.g1.active.id).toBe('s1');
  });
});
