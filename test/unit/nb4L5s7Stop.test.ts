import { EventEmitter } from 'events';
import { afterAll, describe, expect, it, vi } from 'vitest';

// NB4 decisions 12, 16 and 19, run through the real clientInitializer.ts: main() runs at import over faked
// collaborators. main() adds its steps to the one stop (dataManager.ts, which drains and exits): its stop step begins
// the claims' stop, closes the gateway, and stops the samplers and flushes the totals only once the metrics are ready
// (the flush never while the maintenance gate is closed); its release step releases the claims. The clientReady
// once-handler starts no module code once the process stopped serving its shards.

const h = vi.hoisted(() => {
  const state = {
    lines: [] as string[],
    signals: new Map<string, Array<() => unknown>>(),
    stopSteps: [] as Array<() => Promise<void>>,
    releaseSteps: [] as Array<() => Promise<void>>,
    releaseBoot: (() => undefined) as () => void,
    ingestStarted: false,
    gateClosed: false,
    stopped: false,
    barrierCalls: 0,
    barrier: null as null | Promise<string>,
    recover: null as null | Promise<void>,
    client: null as any,
    calls: { stopSamplers: 0, flushTotals: 0, beginStop: 0, finishStop: 0, recoverPanels: 0, autoUpdater: 0, stopMainWatch: 0 },
    closes: [] as string[],
  };
  const realOn = process.on;
  vi.spyOn(process, 'on').mockImplementation(function (this: unknown, event: string | symbol, listener: (...a: any[]) => void) {
    if (event === 'SIGTERM' || event === 'SIGINT' || event === '') {
      const list = state.signals.get(String(event)) ?? [];
      list.push(listener);
      state.signals.set(String(event), list);
      return process;
    }
    return realOn.call(process, event as any, listener);
  } as any);
  const capture = (...a: unknown[]) => { state.lines.push(a.map(String).join(' ')); };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
  return state;
});

vi.mock('dotenv/config', () => ({}));
vi.mock('../../src/utils/envLoader', async orig => ({ ...(await orig<any>()), loadCredentials: () => ({}) }));
vi.mock('../../src/bot/internalSetup/utils/getAllFiles', () => ({ default: () => [] }));
vi.mock('../../src/bot/internalSetup/utils/panelManager', () => ({
  getPanelManager: () => ({
    loadPanels: async () => undefined,
    registerPanel: () => undefined,
    recoverPanels: () => { h.calls.recoverPanels += 1; return h.recover ?? Promise.resolve(); },
  }),
}));
vi.mock('../../src/bot/internalSetup/utils/ipcPanelHandler', () => ({ setupPanelIPCHandlers: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/ipcCommandHandler', () => ({ setupCommandIPCHandlers: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/ipcDataHandler', () => ({ setupDataIPCHandlers: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/accessLogChannel', () => ({ setupAccessLogChannel: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/ipcMetricsHandler', () => ({ markMetricsReady: () => undefined, setupMetricsIPCHandlers: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/ipcFleetHandler', () => ({ setupFleetIPCHandlers: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/metrics/metricsCollector', () => ({
  getMetricsCollector: () => ({ seedTotals: () => undefined, flushTotals: () => { h.calls.flushTotals += 1; } }),
}));
vi.mock('../../src/bot/internalSetup/utils/metrics/samplers', () => ({
  startSamplers: () => undefined,
  stopSamplers: () => { h.calls.stopSamplers += 1; },
}));
vi.mock('../../src/bot/internalSetup/utils/dataManager', () => ({
  addStopStep: (step: () => Promise<void>) => { h.stopSteps.push(step); },
  addReleaseStep: (step: () => Promise<void>) => { h.releaseSteps.push(step); },
  getGuildDataBackend: () => null,
  sweepGraveyard: async () => undefined,
  DataBackendUnavailableError: class extends Error {},
}));
vi.mock('../../src/bot/internalSetup/utils/sharedOps', () => ({ setupSharedOpsIPC: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/writerLock', () => ({ reportWriterStage: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/premiumManager', () => ({ startPremiumTickers: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/boot', () => ({
  initDataBackendLayer: () => undefined,
  awaitDataStartupBarrier: () => { h.barrierCalls += 1; return h.barrier ?? Promise.resolve('ready'); },
  dispatchGated: () => undefined,
  dataUnavailableMessage: () => '',
}));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/workingSet', () => ({ getWorkingSet: () => null }));
vi.mock('../../src/bot/internalSetup/utils/ipcReloadHandler', () => ({ setupReloadIPCHandlers: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/ipcToggleHandler', () => ({ setupToggleIPCHandlers: () => undefined, applyAllDisabledStatesOnBoot: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/ipcNotificationHandler', () => ({ setupIPCNotificationHandler: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/subscriptionNotifier', () => ({ getSubscriptionNotifier: () => ({ setClient: () => undefined }) }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', () => ({ getPaymentRegistry: () => ({ listAll: () => [], get: () => undefined }) }));
vi.mock('../../src/bot/internalSetup/utils/moduleAutoUpdater', () => ({ startModuleAutoUpdater: () => { h.calls.autoUpdater += 1; } }));
vi.mock('../../src/bot/internalSetup/fleet/shardBoot', () => ({
  bootShards: () => new Promise(resolve => {
    h.releaseBoot = () => resolve({ startIngest: () => { h.ingestStarted = true; } });
  }),
  getShardClaims: () => ({
    beginStop: () => { h.calls.beginStop += 1; },
    finishStop: async () => { h.calls.finishStop += 1; },
  }),
}));
vi.mock('../../src/bot/internalSetup/utils/servingGate', () => ({ stoppedServing: () => h.stopped }));
vi.mock('../../src/bot/internalSetup/ingest/ingestService', () => ({
  getIngestService: () => ({
    close: async (reason: string) => { h.closes.push(reason); },
    buildClient: () => {
      h.client = Object.assign(new EventEmitter(), { user: { tag: 'bot#0001' } });
      return h.client;
    },
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
vi.mock('../../src/bot/internalSetup/utils/maintenanceGate', () => ({ isMaintenanceGateClosed: () => h.gateClosed }));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/postgresBackend', () => ({ PostgresBackend: class {} }));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/mainDatabase', () => ({
  stopMainWatch: () => { h.calls.stopMainWatch += 1; },
  noteShardReconnect: () => undefined,
}));

import { main } from '../../src/bot/internalSetup/clientInitializer';

void main().catch(console.error);

const NOT_STARTED = '[Shards] Module initializers, panel recovery and the module auto-updater do not start: this process stopped serving its shards';
const STOPPED_AFTER = '[Shards] Panel recovery and the module auto-updater stopped: this process stopped serving its shards';
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

afterAll(() => { vi.restoreAllMocks(); });

function resetCalls() {
  for (const key of Object.keys(h.calls) as Array<keyof typeof h.calls>) h.calls[key] = 0;
  h.closes = [];
  h.lines = [];
}

describe('the stop steps main() adds (tests run in order: during the boot, then after it)', () => {
  it('during the boot, before the metrics start: one stop step and three release steps (the watch\'s stop, NB7\'s answer writes, then the claims), added with no signal listener of its own', async () => {
    await vi.waitFor(() => expect(h.stopSteps).toHaveLength(1));
    expect(h.ingestStarted).toBe(false);
    expect(h.releaseSteps).toHaveLength(3);
    expect(h.signals.get('SIGTERM') ?? []).toHaveLength(0);
    expect(h.signals.get('SIGINT') ?? []).toHaveLength(0);
  });

  it('during the boot, before the metrics start: the claims stop, the gateway closes, nothing is sampled or flushed, and the release step releases the claims', async () => {
    expect(h.ingestStarted).toBe(false);
    resetCalls();
    h.gateClosed = false;
    await h.stopSteps[0]();
    expect(h.calls).toMatchObject({ beginStop: 1, stopSamplers: 0, flushTotals: 0, finishStop: 0 });
    expect(h.closes).toEqual(['shutting down']);
    await h.releaseSteps[0]();
    expect(h.calls).toMatchObject({ stopMainWatch: 1, finishStop: 0 });
    await h.releaseSteps[1]();
    expect(h.calls).toMatchObject({ beginStop: 1, stopSamplers: 0, flushTotals: 0, finishStop: 0, stopMainWatch: 1 });
    await h.releaseSteps[2]();
    expect(h.calls).toMatchObject({ beginStop: 1, stopSamplers: 0, flushTotals: 0, finishStop: 1, stopMainWatch: 1 });
  });

  it('after the boot: the samplers stop, the totals flush while the maintenance gate is open and not while it is closed', async () => {
    h.releaseBoot();
    await vi.waitFor(() => expect(h.ingestStarted).toBe(true));
    expect(h.stopSteps).toHaveLength(1);
    resetCalls();
    h.gateClosed = false;
    await h.stopSteps[0]();
    expect(h.calls.stopSamplers).toBe(1);
    expect(h.calls.flushTotals).toBe(1);
    h.gateClosed = true;
    try {
      await h.stopSteps[0]();
    } finally {
      h.gateClosed = false;
    }
    expect(h.calls.stopSamplers).toBe(2);
    expect(h.calls.flushTotals).toBe(1);
  });
});

describe("the clientReady once-handler main() installs", () => {
  async function readyHandler() {
    await vi.waitFor(() => expect(h.ingestStarted).toBe(true));
    const listeners = (h.client as EventEmitter).listeners('clientReady');
    expect(listeners).toHaveLength(1);
    resetCalls();
    h.barrierCalls = 0;
    return listeners[0] as () => Promise<void>;
  }

  it('stopped serving before it runs, the data barrier never answering: its line at once, no barrier wait and no module code', async () => {
    const handler = await readyHandler();
    h.stopped = true;
    h.barrier = new Promise<string>(() => undefined);
    try {
      void handler();
      await tick();
      expect(h.lines).toContain(NOT_STARTED);
      expect(h.barrierCalls).toBe(0);
      expect(h.calls).toMatchObject({ recoverPanels: 0, autoUpdater: 0 });
      expect(h.lines.some(l => l.startsWith('[Initializer]'))).toBe(false);
    } finally {
      h.stopped = false;
      h.barrier = null;
    }
  });

  it('stopped serving while the data barrier waits: its line once the barrier answers, no initializer, no panel recovery, no auto-updater', async () => {
    const handler = await readyHandler();
    let answer: (v: string) => void = () => undefined;
    h.barrier = new Promise<string>(resolve => { answer = resolve; });
    try {
      const run = handler();
      await tick();
      expect(h.barrierCalls).toBe(1);
      h.stopped = true;
      answer('ready');
      await run;
      expect(h.lines.filter(l => l === NOT_STARTED)).toHaveLength(1);
      expect(h.calls).toMatchObject({ recoverPanels: 0, autoUpdater: 0 });
      expect(h.lines.some(l => l.startsWith('[Initializer]'))).toBe(false);
      expect(h.lines).not.toContain(STOPPED_AFTER);
    } finally {
      h.stopped = false;
      h.barrier = null;
    }
  });

  it('stopped serving while panel recovery runs: the auto-updater does not start and the later line is logged', async () => {
    const handler = await readyHandler();
    let recovered: () => void = () => undefined;
    h.recover = new Promise<void>(resolve => { recovered = resolve; });
    try {
      const run = handler();
      await vi.waitFor(() => expect(h.calls.recoverPanels).toBe(1));
      h.stopped = true;
      recovered();
      await run;
      expect(h.calls.autoUpdater).toBe(0);
      expect(h.lines).toContain(STOPPED_AFTER);
      expect(h.lines).not.toContain(NOT_STARTED);
    } finally {
      h.stopped = false;
      h.recover = null;
    }
  });

  it('serving throughout: the initializers, panel recovery and the auto-updater all run, with no stopped-serving line', async () => {
    const handler = await readyHandler();
    await handler();
    expect(h.barrierCalls).toBe(1);
    expect(h.lines).toContain('[Initializer] Running initialization for 0 modules...');
    expect(h.calls).toMatchObject({ recoverPanels: 1, autoUpdater: 1 });
    expect(h.lines).not.toContain(NOT_STARTED);
    expect(h.lines).not.toContain(STOPPED_AFTER);
  });
});
