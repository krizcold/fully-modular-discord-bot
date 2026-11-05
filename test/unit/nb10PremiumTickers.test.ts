import fs from 'fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB10 test 40 (decision 23): constructing the PremiumManager and the payment registry (an op while bootShards() runs)
// arms no expiry timer and no provider tick; startPremiumTickers(), called once the notifier has its client, arms
// both, and a provider registered later starts at once; the web UI and a maintenance boot arm neither.

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
import { DummyProvider } from '../../src/bot/internalSetup/utils/payment/dummyProvider';
import { applySharedOp } from '../../src/bot/internalSetup/utils/sharedOps';
import { markMaintenanceBoot } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { clearGlobal, DUMMY_STATE, quiet, settleQueue } from './nb10PremiumRig';

const role = process.env.BOT_PROCESS_ROLE;
const provider = (id: string) => ({ id, displayName: id, capabilities: {}, isConfigured: () => true, start: vi.fn(), stop: vi.fn() });

beforeEach(async () => {
  quiet();
  await settleQueue();
  resetPremiumManager();
  reg.current = null;
  clearGlobal();
  process.env.BOT_PROCESS_ROLE = 'bot';
});
afterEach(async () => {
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

describe('the tickers start with the Discord client', () => {
  it('an op before the client arms nothing; startPremiumTickers arms the expiry check and every provider, and a later one at once', async () => {
    const early = provider('early');
    getPaymentRegistry().register(early as any);
    expect(await applySharedOp({ op: 'premium.setMessages', args: { args: [{ moduleBlocked: 'x' }] } })).toMatchObject({ ok: true });
    expect((getPremiumManager() as any).expiryTimer).toBeNull();
    expect(early.start).not.toHaveBeenCalled();
    startPremiumTickers();
    expect((getPremiumManager() as any).expiryTimer).not.toBeNull();
    expect(early.start).toHaveBeenCalledTimes(1);
    const late = provider('late');
    getPaymentRegistry().register(late as any);
    expect(late.start).toHaveBeenCalledTimes(1);
    getPremiumManager().stopExpiryChecker();
  });

  it('the Dummy provider arms its tick before it loads, so a state that cannot be read still gets a tick', () => {
    fs.mkdirSync(DUMMY_STATE, { recursive: true });
    const dummy = new DummyProvider();
    getPaymentRegistry().register(dummy);
    startPremiumTickers();
    expect((dummy as any).tickTimer).not.toBeNull();
    expect(dummy.cannotReadText()).toMatch(/^payment-providers\/dummy\/state\.json cannot be read/);
    dummy.stop();
    getPremiumManager().stopExpiryChecker();
  });

  it('the web UI process arms neither', () => {
    delete process.env.BOT_PROCESS_ROLE;
    const p = provider('p');
    getPaymentRegistry().register(p as any);
    startPremiumTickers();
    getPaymentRegistry().startTickers();
    expect((getPremiumManager() as any).expiryTimer).toBeNull();
    expect(p.start).not.toHaveBeenCalled();
  });
});

// Last: a maintenance boot cannot be undone in this process.
describe('a maintenance boot', () => {
  it('arms neither the expiry check nor a provider tick', () => {
    markMaintenanceBoot();
    const p = provider('p');
    getPaymentRegistry().register(p as any);
    startPremiumTickers();
    expect((getPremiumManager() as any).expiryTimer).toBeNull();
    expect(p.start).not.toHaveBeenCalled();
  });
});
