import fs from 'fs';
import { afterAll, describe, expect, it, vi } from 'vitest';

// NB10 decision 23: in a new bot process, kept provider events wait until startPremiumTickers() has run; the first
// load of the process must not start their replay. This file holds one test so its load is the process's first.

const reg = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/payment/paymentRegistry')>();
  return { ...real, getPaymentRegistry: () => (reg.current ??= new real.PaymentProviderRegistry()) };
});
vi.mock('../../src/bot/internalSetup/utils/premiumNotifications', () => ({
  dispatchPremiumNotification: async () => ({ delivered: true, via: 'dm' }),
}));

import { getPremiumManager, resetPremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { clearGlobal, JOURNAL, quiet, settleQueue, writePremium } from './nb10PremiumRig';

const role = process.env.BOT_PROCESS_ROLE;
afterAll(async () => {
  resetPremiumManager();
  await settleQueue();
  vi.restoreAllMocks();
  if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
  else process.env.BOT_PROCESS_ROLE = role;
});

describe('the first load of a bot process', () => {
  it('holds the kept events until the tickers start', () => {
    quiet();
    clearGlobal();
    process.env.BOT_PROCESS_ROLE = 'bot';
    writePremium({});
    const event = { type: 'subscription.renewal-failed', providerId: 'fake', providerSubId: 'nope', guildId: 'g-none', reason: 'card' };
    fs.writeFileSync(JOURNAL, `${JSON.stringify({ writer: 'w1', n: 1, event })}\n`);
    const pm = getPremiumManager();
    expect(pm.heldEventsText()).toBe('Premium holds provider events received while premium-tiers.json could not be read; the bot applies them once it runs normally and is connected to Discord. Nothing was saved. Try again then.');
  });
});
