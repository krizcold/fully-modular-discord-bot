import fs from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 test 41 (decision 12): a line of premium-tiers.events.jsonl that is not a whole event (no writer string, no
// number, no event type) is never taken as a pending event; the bot's replay logs each such line once and passes over
// blank lines without a word.

const reg = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  return { ...real, getPaymentRegistry: () => (reg.current ??= new real.PaymentProviderRegistry()) };
});
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async () => ({ delivered: true, via: 'dm' }),
}));

import { getPremiumManager, resetPremiumManager, startPremiumTickers } from '../../src/bot/internalSetup/utils/premiumManager';
import { clearGlobal, JOURNAL, logged, quiet, rawOf, settleQueue, writePremium } from './nb10PremiumRig';

const role = process.env.BOT_PROCESS_ROLE;
const asBot = (bot: boolean) => {
  if (bot) process.env.BOT_PROCESS_ROLE = 'bot';
  else delete process.env.BOT_PROCESS_ROLE;
};
const HOLDS = 'Premium holds provider events the bot has not applied yet (premium-tiers.events.jsonl); nothing was saved. Start the bot to apply them, then try again.';
const event = { type: 'subscription.renewal-failed', providerId: 'fake', providerSubId: 'nope', guildId: 'g-none', reason: 'card' };
const WRITER_NUMBER = JSON.stringify({ writer: 5, n: 1, event });
const N_STRING = JSON.stringify({ writer: 'w1', n: '1', event });

let spies: ReturnType<typeof quiet>;
beforeAll(() => clearGlobal());
beforeEach(async () => {
  spies = quiet();
  await settleQueue();
  resetPremiumManager();
  reg.current = null;
  clearGlobal();
  asBot(false);
});
afterEach(async () => {
  resetPremiumManager();
  reg.current = null;
  await settleQueue();
  vi.restoreAllMocks();
});
afterAll(() => {
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe('the web UI reads the journal', () => {
  it('a whole pending event holds premium changes', () => {
    writePremium({});
    fs.writeFileSync(JOURNAL, `${JSON.stringify({ writer: 'w1', n: 1, event })}\n`);
    expect(getPremiumManager().heldEventsText()).toBe(HOLDS);
  });

  it('a line whose writer is not a string holds nothing', () => {
    writePremium({});
    fs.writeFileSync(JOURNAL, `${WRITER_NUMBER}\n`);
    expect(getPremiumManager().heldEventsText()).toBeNull();
  });

  it('a line whose number is a string holds nothing', () => {
    writePremium({});
    fs.writeFileSync(JOURNAL, `${N_STRING}\n`);
    expect(getPremiumManager().heldEventsText()).toBeNull();
  });
});

describe('the bot replays the journal', () => {
  it('a damaged line is logged once by its text; a blank line is passed over silently', async () => {
    asBot(true);
    writePremium({});
    fs.writeFileSync(JOURNAL, `${JSON.stringify({ writer: 'w1', n: 1, event })}\n   \n${WRITER_NUMBER}\n`);
    const pm = getPremiumManager();
    expect(pm.cacheState()).toBe('replaying');
    startPremiumTickers();
    await vi.waitFor(() => expect(pm.cacheState()).toBe('normal'), { timeout: 5000, interval: 10 });
    await vi.waitFor(() => expect(rawOf(JOURNAL)).toBeNull(), { timeout: 5000, interval: 10 });
    const skipped = logged(spies.warn).filter(l => l.startsWith('[PremiumManager] Skipped a line of premium-tiers.events.jsonl'));
    expect(skipped).toEqual([`[PremiumManager] Skipped a line of premium-tiers.events.jsonl that cannot be read (cut short or damaged): ${WRITER_NUMBER}`]);
  });
});
