import fs from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 L5 survivors in premiumManager.ts: a non-object eventsApplied is never walked; the replay's watch sleeps on a
// timer handle that has no unref; an install line with a BOM or a trailing no-break space still counts as landed for a
// redelivery; the web UI's load starts no replay from events this process journaled while it was the bot.

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

import { getPremiumManager, resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { getPaymentRegistry } from '../../src/bot/internalSetup/utils/payment/paymentRegistry';
import { markPaymentLedger, runSealed } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { AUDIT, clearGlobal, JOURNAL, logged, paidSub, PREMIUM, quiet, rawOf, settleQueue, state, tick, writePremium } from './nb10PremiumRig';

const role = process.env.BOT_PROCESS_ROLE;
const asBot = (bot: boolean) => {
  if (bot) process.env.BOT_PROCESS_ROLE = 'bot';
  else delete process.env.BOT_PROCESS_ROLE;
};
type Manager = ReturnType<typeof getPremiumManager>;
const BOM = String.fromCharCode(0xfeff);
const NBSP = String.fromCharCode(0xa0);

function newProcess(): Manager {
  resetPremiumManager();
  reg.current = null;
  getPaymentRegistry().register({
    id: 'fake', displayName: 'Fake', capabilities: { supportsCancel: true }, isConfigured: () => true,
    cancelSubscription: async () => undefined,
  } as any);
  return getPremiumManager();
}

let spies: ReturnType<typeof quiet>;
beforeAll(() => clearGlobal());
beforeEach(async () => {
  spies = quiet();
  await settleQueue();
  resetPremiumManager();
  reg.current = null;
  clearGlobal();
  asBot(true);
});
afterEach(async () => {
  resetPremiumManager();
  reg.current = null;
  vi.restoreAllMocks();
  await settleQueue();
});
afterAll(() => {
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe('an eventsApplied that is not an object', () => {
  it('a string is never walked character by character and gives no marks', () => {
    writePremium({}, { eventsApplied: 'abcdef' });
    const spy = vi.spyOn(Object, 'entries');
    const pm = newProcess() as any;
    pm.load();
    const walked = spy.mock.calls.filter(c => typeof c[0] === 'string');
    spy.mockRestore();
    expect(walked).toEqual([]);
    expect(pm.config.eventsApplied).toBeUndefined();
    expect(pm.cacheState()).toBe('normal');
  });
});

describe("the watch for the replay's save", () => {
  it('sleeps on a timer handle without unref, and once the save lands writes the lines and deletes the journal', async () => {
    writePremium({});
    const pm = newProcess() as any;
    fs.writeFileSync(JOURNAL, `${JSON.stringify({ writer: 'w-old', n: 1, event: { type: 'subscription.expired' } })}\n`);
    const entry = { timestamp: '2026-10-01T00:00:00.000Z', actor: 'admin', action: 'tier.update', guildId: 'g1' };
    pm.raisedMarks = { 'w-old': 1 };
    pm.journal = [];
    pm.replayBuffer = [{ line: `${JSON.stringify(entry)}\n`, entry }];
    pm.marksTicket = null;
    const realSetTimeout = globalThis.setTimeout;
    (globalThis as any).setTimeout = (fn: () => void) => {
      realSetTimeout(fn, 1);
      return 1;
    };
    try {
      pm.watchMarks();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    pm.marksTicket = { kind: 'file', path: 'x', seq: 1, record: { landed: 1 } };
    await tick(20);
    await settleQueue();
    expect(logged(spies.error).filter(l => l.includes("The watch for the replay's save failed"))).toEqual([]);
    expect(rawOf(JOURNAL)).toBeNull();
    expect(rawOf(AUDIT)).toBe(`${JSON.stringify(entry)}\n`);
  });
});

describe('a redelivery reads install lines with Unicode whitespace around them', () => {
  const created = { type: 'subscription.created', providerId: 'fake', providerSubId: 'ps1', guildId: 'g1', tierId: 'low', offeringId: 'o1', state: state() };
  const install = JSON.stringify({ timestamp: 't', actor: 'admin', action: 'subscription.install.paid', guildId: 'g1', subscriptionId: 's1' });
  const installCount = () => (rawOf(AUDIT) ?? '').split('\n').filter(l => l.includes('"subscription.install.paid"')).length;

  async function redeliver(pm: Manager): Promise<void> {
    await runSealed('console', null, 'premium', async ledger => {
      markPaymentLedger(ledger, 'payment.webhook');
      getPaymentRegistry().emitEvent(created as any);
      await pm.settled(ledger);
    });
    await settleQueue();
  }

  it('a line that starts with a BOM is the landed install line: nothing more is written', async () => {
    writePremium({ g1: { active: paidSub('s1', 'ps1'), paused: [] } });
    fs.writeFileSync(AUDIT, `${BOM}${install}\n`);
    const pm = newProcess();
    await redeliver(pm);
    expect(rawOf(AUDIT)).toBe(`${BOM}${install}\n`);
    expect(installCount()).toBe(1);
  });

  it('a line that ends with a no-break space is the landed install line: nothing more is written', async () => {
    writePremium({ g1: { active: paidSub('s1', 'ps1'), paused: [] } });
    fs.writeFileSync(AUDIT, `${install}${NBSP}\n`);
    const pm = newProcess();
    await redeliver(pm);
    expect(rawOf(AUDIT)).toBe(`${install}${NBSP}\n`);
  });
});

describe('the web UI load after this process journaled events as the bot', () => {
  it('starts no replay and holds nothing', async () => {
    fs.writeFileSync(PREMIUM, '{ not json');
    const pm = newProcess();
    expect(pm.cacheState()).toBe('unreadable');
    getPaymentRegistry().emitEvent({ type: 'subscription.renewal-failed', providerId: 'fake', providerSubId: 'nope', guildId: 'g-none', reason: 'card' } as any);
    expect((pm as any).journal).toHaveLength(1);
    await settleQueue();
    fs.rmSync(JOURNAL, { force: true });
    asBot(false);
    writePremium({});
    pm.load();
    expect(pm.cacheState()).toBe('normal');
    expect(pm.heldEventsText()).toBeNull();
  });
});
