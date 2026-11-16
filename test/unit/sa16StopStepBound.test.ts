import { EventEmitter } from 'events';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// main() runs at import over faked collaborators, as in nb4L5s7Stop.test.ts; its stop step is called by hand.

const h = vi.hoisted(() => {
  const state = {
    stopSteps: [] as Array<() => Promise<void>>,
    closes: [] as string[],
    close: null as null | Promise<void>,
    beginStop: 0,
  };
  const realOn = process.on;
  vi.spyOn(process, 'on').mockImplementation(function (this: unknown, event: string | symbol, listener: (...a: any[]) => void) {
    if (event === 'SIGTERM' || event === 'SIGINT') return process;
    return realOn.call(process, event as any, listener);
  } as any);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  return state;
});

vi.mock('dotenv/config', () => ({}));
vi.mock('../../src/utils/envLoader', async orig => ({ ...(await orig<any>()), loadCredentials: () => ({}) }));
vi.mock('../../src/bot/internalSetup/utils/getAllFiles', () => ({ default: () => [] }));
vi.mock('../../src/bot/internalSetup/utils/panelManager', () => ({
  getPanelManager: () => ({ loadPanels: async () => undefined, registerPanel: () => undefined, recoverPanels: () => Promise.resolve() }),
}));
vi.mock('../../src/bot/internalSetup/utils/ipcPanelHandler', () => ({ setupPanelIPCHandlers: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/ipcCommandHandler', () => ({ setupCommandIPCHandlers: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/ipcDataHandler', () => ({ setupDataIPCHandlers: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/accessLogChannel', () => ({ setupAccessLogChannel: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/ipcMetricsHandler', () => ({ markMetricsReady: () => undefined, setupMetricsIPCHandlers: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/ipcFleetHandler', () => ({ setupFleetIPCHandlers: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/metrics/metricsCollector', () => ({
  getMetricsCollector: () => ({ seedTotals: () => undefined, flushTotals: () => undefined }),
}));
vi.mock('../../src/bot/internalSetup/utils/metrics/samplers', () => ({ startSamplers: () => undefined, stopSamplers: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', () => ({
  addStopStep: (step: () => Promise<void>) => { h.stopSteps.push(step); },
  addReleaseStep: () => undefined,
  getGuildDataBackend: () => null,
  sweepGraveyard: async () => undefined,
  DataBackendUnavailableError: class extends Error {},
}));
vi.mock('../../src/bot/internalSetup/utils/sharedOps', () => ({ setupSharedOpsIPC: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/writerLock', () => ({ reportWriterStage: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/premiumManager', () => ({ startPremiumTickers: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/boot', () => ({
  initDataBackendLayer: () => undefined,
  awaitDataStartupBarrier: () => Promise.resolve('ready'),
  dispatchGated: () => undefined,
  dataUnavailableMessage: () => '',
}));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/workingSet', () => ({ getWorkingSet: () => null }));
vi.mock('../../src/bot/internalSetup/utils/ipcReloadHandler', () => ({ setupReloadIPCHandlers: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/ipcToggleHandler', () => ({ setupToggleIPCHandlers: () => undefined, applyAllDisabledStatesOnBoot: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/ipcNotificationHandler', () => ({ setupIPCNotificationHandler: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/subscriptionNotifier', () => ({ getSubscriptionNotifier: () => ({ setClient: () => undefined }) }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', () => ({ getPaymentRegistry: () => ({ listAll: () => [], get: () => undefined }) }));
vi.mock('../../src/bot/internalSetup/utils/moduleAutoUpdater', () => ({ startModuleAutoUpdater: () => undefined }));
vi.mock('../../src/bot/internalSetup/fleet/shardBoot', () => ({
  bootShards: () => new Promise(() => undefined),
  getShardClaims: () => ({ beginStop: () => { h.beginStop += 1; }, finishStop: async () => undefined }),
}));
vi.mock('../../src/bot/internalSetup/utils/servingGate', () => ({ stoppedServing: () => false }));
vi.mock('../../src/bot/internalSetup/ingest/ingestService', () => ({
  getIngestService: () => ({
    close: (reason: string) => { h.closes.push(reason); return h.close ?? Promise.resolve(); },
    buildClient: () => Object.assign(new EventEmitter(), { user: { tag: 'bot#0001' } }),
  }),
}));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/replyGate', () => ({ installReplyGate: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/moduleLoader', () => ({ ModuleLoader: class { async loadAllModules() { return []; } } }));
vi.mock('../../src/bot/internalSetup/utils/moduleRegistry', () => ({
  getModuleRegistry: () => ({ setClient: () => undefined, getStats: () => ({ total: 0, byCategory: {} }), getAllModules: () => [] }),
}));
vi.mock('../../src/bot/internalSetup/utils/moduleEventManager', () => ({
  getModuleEventManager: () => ({ setClient: () => undefined, registerListener: () => undefined, getListenerCount: () => 0 }),
}));
vi.mock('../../src/bot/internalSetup/utils/configManager', () => ({ ensureConfigPopulated: () => undefined, getConfigProperty: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/maintenance', () => ({
  decideBoot: async () => ({ mode: 'normal' }),
  installMaintenanceGate: () => undefined,
  markDiscordStarted: () => undefined,
  runMaintenanceBoot: async () => undefined,
  setupMaintenanceIPCAtBoot: () => undefined,
  watchDataBackend: () => undefined,
}));
vi.mock('../../src/bot/internalSetup/utils/maintenanceGate', () => ({ isMaintenanceGateClosed: () => false }));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/postgresBackend', () => ({ PostgresBackend: class {} }));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/mainDatabase', () => ({ stopMainWatch: () => undefined, noteShardReconnect: () => undefined }));

import { main } from '../../src/bot/internalSetup/clientInitializer';

void main().catch(() => undefined);

afterEach(() => {
  vi.useRealTimers();
  h.close = null;
});
afterAll(() => { vi.restoreAllMocks(); });

describe('sa16 the stop step main() adds, with a gateway close that never answers', () => {
  it('sa16 goes on 2 s after it began closing the gateway, not before', async () => {
    await vi.waitFor(() => expect(h.stopSteps).toHaveLength(1), { timeout: 5000, interval: 5 });
    h.close = new Promise<void>(() => undefined);
    h.closes.length = 0;
    vi.useFakeTimers();
    let done = false;
    void h.stopSteps[0]().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.closes).toEqual(['shutting down']);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });
});
