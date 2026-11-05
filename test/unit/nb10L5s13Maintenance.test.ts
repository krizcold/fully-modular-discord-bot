import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'discord.js';

// NB10 survivors, chunk 13: a maintenance boot registers the shared-op handler (the web UI's writes reach it while
// the bot is in maintenance), and its stop step closes the Discord client, bounded at 2 s.

const ctl = vi.hoisted(() => ({
  steps: [] as Array<() => void | Promise<void>>,
  sharedOps: 0,
}));

vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<any>()),
  addStopStep: (step: () => void | Promise<void>) => { ctl.steps.push(step); },
}));
vi.mock('../../src/bot/internalSetup/utils/sharedOps', async orig => ({
  ...(await orig<any>()),
  setupSharedOpsIPC: () => { ctl.sharedOps += 1; },
}));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', async orig => ({
  ...(await orig<any>()),
  getPaymentRegistry: () => ({ get: () => undefined, listAll: () => [], on: () => undefined, off: () => undefined }),
}));
vi.mock('../../src/bot/internalSetup/utils/premiumManager', async orig => ({ ...(await orig<any>()), getPremiumManager: () => ({}) }));
vi.mock('../../src/bot/internalSetup/utils/subscriptionNotifier', () => ({ getSubscriptionNotifier: () => ({ setClient: () => undefined }) }));

import { _resetMaintenance, runMaintenanceBoot } from '../../src/bot/internalSetup/utils/maintenance';

beforeEach(() => {
  ctl.steps.length = 0;
  ctl.sharedOps = 0;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  _resetMaintenance();
});

async function boot(): Promise<Client | null> {
  return runMaintenanceBoot(
    { cause: 'login-refused', message: 'down for s13' },
    { shards: async () => 1, login: async () => undefined, loginProbe: async () => 'refused', retryMs: 3_600_000, sleep: async () => undefined },
  );
}

describe('a maintenance boot', () => {
  it('registers the shared-op handler once', async () => {
    await boot();
    expect(ctl.sharedOps).toBe(1);
  });

  it('its stop step destroys the Discord client it logged in', async () => {
    const destroy = vi.spyOn(Client.prototype, 'destroy').mockImplementation(async () => undefined);
    const client = await boot();
    expect(ctl.steps).toHaveLength(1);
    await ctl.steps[0]();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(destroy.mock.instances[0]).toBe(client);
  });

  it('its stop step ends after 2 s when the client destroy never settles, and not before', async () => {
    const destroy = vi.spyOn(Client.prototype, 'destroy').mockImplementation(() => new Promise<void>(() => undefined));
    await boot();
    vi.useFakeTimers();
    let ended = false;
    void Promise.resolve(ctl.steps[0]()).then(() => { ended = true; });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(ended).toBe(true);
  });
});
