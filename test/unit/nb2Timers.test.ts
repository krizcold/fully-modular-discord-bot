import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB2 ruling 4: inside maintenance the timers that run module code or write data return at once on each tick.

const appStore = vi.hoisted(() => ({ calls: 0 }));
const graveyard = vi.hoisted(() => ({ calls: 0 }));

// Its providers load by require, which this suite does not resolve.
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', () => ({
  getPaymentRegistry: () => ({ get: () => undefined, on: () => undefined, off: () => undefined, emitEvent: () => undefined }),
}));
vi.mock('../../src/bot/internalSetup/utils/appStoreManager', () => ({
  getAppStoreManager: () => {
    appStore.calls += 1;
    return { getInstalledModules: () => [] };
  },
}));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async orig => ({
  ...(await orig<typeof import('../../src/bot/internalSetup/utils/dataBackends/fileBackend')>()),
  sweepGraveyard: async () => { graveyard.calls += 1; },
}));

import { setMaintenanceGate } from '../../src/bot/internalSetup/utils/maintenanceGate';
import { PremiumManager } from '../../src/bot/internalSetup/utils/premiumManager';
import { DummyProvider } from '../../src/bot/internalSetup/utils/payment/dummyProvider';
import { ServerBoostingProvider } from '../../src/bot/internalSetup/utils/payment/boostProvider';
import { startModuleAutoUpdater, stopModuleAutoUpdater } from '../../src/bot/internalSetup/utils/moduleAutoUpdater';
import { sweepGraveyard } from '../../src/bot/internalSetup/utils/dataManager';
import { dataPath } from '../../src/utils/dataRoot';

const close = () => setMaintenanceGate({ cause: 'hook', message: 'm' });
const open = () => setMaintenanceGate(null);

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  open();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ruling 4: timers return at once while the gate is closed', () => {
  it("premiumManager's expiry checker and due migrations", async () => {
    vi.useFakeTimers();
    const pm = new PremiumManager();
    const expiry = vi.spyOn(pm, 'checkExpiry').mockImplementation(() => undefined as any);
    const migrations = vi.spyOn(pm, 'processDueMigrations').mockImplementation(async () => undefined as any);
    pm.startExpiryChecker(1000);
    close();
    await vi.advanceTimersByTimeAsync(3000);
    expect(expiry).not.toHaveBeenCalled();
    expect(migrations).not.toHaveBeenCalled();
    open();
    await vi.advanceTimersByTimeAsync(1000);
    expect(expiry).toHaveBeenCalledTimes(1);
    expect(migrations).toHaveBeenCalledTimes(1);
    pm.dispose();
  });

  it("the dummy payment provider's tick", async () => {
    vi.useFakeTimers();
    const provider = new DummyProvider();
    const tick = vi.spyOn(provider as any, 'tick').mockImplementation(() => undefined);
    provider.start();
    close();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(tick).not.toHaveBeenCalled();
    open();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tick).toHaveBeenCalledTimes(1);
    provider.stop();
  });

  it("the boost provider's tick", async () => {
    process.env.BOOST_TARGET_GUILD_ID = '123456789012345678';
    try {
      const provider = new ServerBoostingProvider();
      (provider as any).client = { guilds: { fetch: vi.fn(), cache: new Map() } };
      close();
      await expect((provider as any).tick()).resolves.toBeUndefined();
      // Past the gate the tick loads the premium manager by require, which this suite does not resolve.
      open();
      await expect((provider as any).tick()).rejects.toThrow(/premiumManager/);
    } finally {
      delete process.env.BOOST_TARGET_GUILD_ID;
    }
  });

  it('the module auto-updater', async () => {
    const config = dataPath('global', 'appstore', 'config.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ autoUpdate: true }));
    vi.useFakeTimers();
    appStore.calls = 0;
    startModuleAutoUpdater({} as any);
    close();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(appStore.calls).toBe(0);
    open();
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(appStore.calls).toBe(1);
    stopModuleAutoUpdater();
  });

  it('the graveyard sweep', async () => {
    graveyard.calls = 0;
    close();
    await sweepGraveyard();
    expect(graveyard.calls).toBe(0);
    open();
    await sweepGraveyard();
    expect(graveyard.calls).toBe(1);
  });
});
