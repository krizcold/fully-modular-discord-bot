import fs from 'fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 L5 survivors (premiumManager.ts, load and refusal texts): a premium-tiers.json that is not a JSON object leaves
// the cache unreadable and says so once per cause; it is read again 5 s after a failed load or at once after
// invalidate(), and logs that it can be read again; the refusal texts load the file first; a bot with no journal
// deletes none.

const inject = vi.hoisted(() => ({ refuseDelete: false }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>();
  return {
    ...real,
    deleteDataTracked: (f: string, o: any) => (inject.refuseDelete ? { outcome: 'refused', cause: 'storage-failing' } : real.deleteDataTracked(f, o)),
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

import { PremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { clearGlobal, JOURNAL, logged, PREMIUM, quiet, settleQueue, writePremium } from './nb10PremiumRig';

const role = process.env.BOT_PROCESS_ROLE;
const asBot = (bot: boolean) => {
  if (bot) process.env.BOT_PROCESS_ROLE = 'bot';
  else delete process.env.BOT_PROCESS_ROLE;
};
const journalLine = (writer: string, n: number) => `${JSON.stringify({ writer, n, event: { type: 'subscription.renewed', providerId: 'fake', providerSubId: 'p1', guildId: 'g1' } })}\n`;
const NOT_OBJECT = 'premium-tiers.json cannot be read (invalid JSON: not a JSON object); nothing was saved. Fix or restore the file, then try again.';

let spies: ReturnType<typeof quiet>;
const managers: PremiumManager[] = [];
const manager = (): PremiumManager => {
  const pm = new PremiumManager();
  managers.push(pm);
  return pm;
};
const unreadableLogs = () => logged(spies.error).filter(l => l.includes('premium-tiers.json cannot be read'));

beforeEach(() => {
  spies = quiet();
  inject.refuseDelete = false;
  reg.current = null;
  clearGlobal();
  asBot(false);
});
afterEach(async () => {
  for (const pm of managers.splice(0)) pm.dispose();
  inject.refuseDelete = false;
  vi.restoreAllMocks();
  await settleQueue();
});
afterAll(() => {
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe('a premium-tiers.json that is not a JSON object', () => {
  it('an array leaves the cache unreadable and names the cause in the refusal text', () => {
    fs.writeFileSync(PREMIUM, '[]');
    const pm = manager();
    pm.load();
    expect(pm.cacheState()).toBe('unreadable');
    expect(pm.unreadableText()).toBe(NOT_OBJECT);
  });

  it('null leaves the cache unreadable', () => {
    fs.writeFileSync(PREMIUM, 'null');
    const pm = manager();
    pm.load();
    expect(pm.cacheState()).toBe('unreadable');
    expect(pm.unreadableText()).toBe(NOT_OBJECT);
  });

  it('a number leaves the cache unreadable', () => {
    fs.writeFileSync(PREMIUM, '5');
    const pm = manager();
    pm.load();
    expect(pm.cacheState()).toBe('unreadable');
    expect(pm.unreadableText()).toBe(NOT_OBJECT);
  });

  it('a file that cannot be read is logged under its name', () => {
    fs.mkdirSync(PREMIUM);
    const pm = manager();
    pm.load();
    expect(pm.cacheState()).toBe('unreadable');
    expect(unreadableLogs()).toHaveLength(1);
    expect(unreadableLogs()[0]).toMatch(/^\[PremiumManager\] premium-tiers\.json cannot be read \(E[A-Z]+\); premium answers Free and premium changes are refused until it can be read$/);
  });
});

describe('the unreadable log and the reload', () => {
  it('one cause is logged once across loads; a new cause is logged again', () => {
    fs.writeFileSync(PREMIUM, '[]');
    const pm = manager();
    pm.load();
    pm.invalidate();
    expect(pm.unreadableText()).toBe(NOT_OBJECT);
    expect(unreadableLogs()).toHaveLength(1);
    fs.writeFileSync(PREMIUM, '{ broken');
    pm.invalidate();
    expect(pm.unreadableText()).toMatch(/^premium-tiers\.json cannot be read \(invalid JSON: /);
    expect(unreadableLogs()).toHaveLength(2);
  });

  it('after invalidate() a fixed file is read at once and logged as readable again', () => {
    fs.writeFileSync(PREMIUM, '[]');
    const pm = manager();
    pm.load();
    writePremium();
    pm.invalidate();
    expect(pm.unreadableText()).toBeNull();
    expect(pm.cacheState()).toBe('normal');
    expect(logged(vi.spyOn(console, 'log'))).toContain('[PremiumManager] premium-tiers.json can be read again');
  });

  it('a failed load is tried again once 5 s have passed, not before', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    fs.writeFileSync(PREMIUM, '[]');
    const pm = manager();
    pm.load();
    writePremium();
    now.mockReturnValue(1_004_999);
    expect(pm.unreadableText()).toBe(NOT_OBJECT);
    now.mockReturnValue(1_005_000);
    expect(pm.unreadableText()).toBeNull();
  });

  it('unreadableText() loads a manager that has not loaded yet', () => {
    fs.writeFileSync(PREMIUM, '[]');
    expect(manager().unreadableText()).toBe(NOT_OBJECT);
  });
});

describe('heldEventsText()', () => {
  it('in the web UI it loads the file first, so marks that cover the journal refuse nothing', () => {
    writePremium({}, { eventsApplied: { w1: 5 } });
    fs.writeFileSync(JOURNAL, journalLine('w1', 3));
    expect(manager().heldEventsText()).toBeNull();
    fs.writeFileSync(JOURNAL, journalLine('w1', 6));
    expect(manager().heldEventsText()).toMatch(/^Premium holds provider events the bot has not applied yet/);
  });

  it('in the bot it answers from its own state, not from a journal file written after its load', () => {
    asBot(true);
    writePremium();
    const pm = manager();
    pm.load();
    fs.writeFileSync(JOURNAL, journalLine('w1', 1));
    expect(pm.heldEventsText()).toBeNull();
  });
});

describe('the journal delete at load', () => {
  it('a bot with no journal file deletes none, so a refused delete is never logged', () => {
    asBot(true);
    writePremium();
    inject.refuseDelete = true;
    manager().load();
    expect(logged(spies.error).filter(l => l.includes('could not be deleted'))).toEqual([]);
    writePremium({}, { eventsApplied: { w1: 1 } });
    fs.writeFileSync(JOURNAL, journalLine('w1', 1));
    manager().load();
    expect(logged(spies.error).filter(l => l.includes('premium-tiers.events.jsonl could not be deleted (storage-failing)'))).toHaveLength(1);
  });
});

describe('the refusal text of an entry check', () => {
  it('a stopped manager refuses with the stop words', async () => {
    writePremium();
    const pm = manager();
    pm.load();
    pm.markStopped('stopping');
    await expect(pm.initiatePaidSubscription('g1', 'low', 'o1', { providerId: 'fake', variantId: 'v1' })).rejects.toThrowError(/^Nothing was saved: the bot is stopping\.$/);
  });

  it('a file fixed between the entry check and the text answers the general refusal', async () => {
    const times = [1_000_000, 1_001_000, 1_006_000];
    let calls = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => times[Math.min(calls++, times.length - 1)]);
    fs.writeFileSync(PREMIUM, '[]');
    const pm = manager();
    pm.load();
    writePremium();
    await expect(pm.initiatePaidSubscription('g1', 'low', 'o1', { providerId: 'fake', variantId: 'v1' })).rejects.toThrowError(/^Premium cannot take changes right now; nothing was saved\.$/);
  });
});
