import { EventEmitter } from 'events';
import { afterAll, describe, expect, it, vi } from 'vitest';

// NB4 decisions 12, 16 and 19, run through the real clientInitializer.ts: main() runs at import over faked
// collaborators. The one stop handler is on both signals; its steps stop the samplers and flush the totals only once
// the metrics are ready (the flush never while the maintenance gate is closed), release the claims and exit; the
// clientReady once-handler starts no module code once the process stopped serving its shards.

const h = vi.hoisted(() => {
  const state = {
    lines: [] as string[],
    signals: new Map<string, Array<() => unknown>>(),
    stopRuns: 0,
    steps: null as null | Record<string, (...a: any[]) => any>,
    releaseBoot: (() => undefined) as () => void,
    ingestStarted: false,
    gateClosed: false,
    stopped: false,
    barrierCalls: 0,
    barrier: null as null | Promise<string>,
    recover: null as null | Promise<void>,
    client: null as any,
    calls: { stopSamplers: 0, flushTotals: 0, beginStop: 0, finishStop: 0, recoverPanels: 0, autoUpdater: 0 },
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
  drainForExit: async () => undefined,
  getGuildDataBackend: () => null,
  stopHandler: (body: () => Promise<void>) => () => { h.stopRuns += 1; return body(); },
  sweepGraveyard: async () => undefined,
  DataBackendUnavailableError: class extends Error {},
}));
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
vi.mock('../../src/bot/internalSetup/utils/stopSteps', () => ({
  runStopSteps: async (steps: Record<string, (...a: any[]) => any>) => { h.steps = steps; },
}));
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
vi.mock('../../src/bot/internalSetup/utils/configManager', () => ({ ensureConfigPopulated: () => undefined }));
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

import '../../src/bot/internalSetup/clientInitializer';

const NOT_STARTED = '[Shards] Module initializers, panel recovery and the module auto-updater do not start: this process stopped serving its shards';
const STOPPED_AFTER = '[Shards] Panel recovery and the module auto-updater stopped: this process stopped serving its shards';
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

afterAll(() => { vi.restoreAllMocks(); });

function resetCalls() {
  for (const key of Object.keys(h.calls) as Array<keyof typeof h.calls>) h.calls[key] = 0;
  h.closes = [];
  h.steps = null;
  h.lines = [];
}

/** Sends the signal as the OS would: every listener main() installed for it. */
function signal(name: 'SIGTERM' | 'SIGINT') {
  for (const listener of h.signals.get(name) ?? []) listener();
}

describe('the stop handler main() installs (tests run in order: during the boot, then after it)', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)('%s during the boot, before the metrics start: the claims stop, the gateway closes, nothing is sampled or flushed, the claims release and the process exits 0', async name => {
    await vi.waitFor(() => expect(h.signals.get(name)?.length).toBe(1));
    expect(h.ingestStarted).toBe(false);
    resetCalls();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      const runsBefore = h.stopRuns;
      signal(name);
      expect(h.stopRuns).toBe(runsBefore + 1);
      await vi.waitFor(() => expect(h.steps).not.toBeNull());
      const steps = h.steps!;
      steps.beginStop();
      steps.stopSamplers();
      await steps.closeGateway();
      h.gateClosed = false;
      steps.flushTotals();
      await steps.finishStop();
      steps.exit(0);
      expect(h.calls).toMatchObject({ beginStop: 1, stopSamplers: 0, flushTotals: 0, finishStop: 1 });
      expect(h.closes).toEqual(['shutting down']);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      exit.mockRestore();
    }
  });

  it('after the boot: the samplers stop, the totals flush while the maintenance gate is open and not while it is closed', async () => {
    h.releaseBoot();
    await vi.waitFor(() => expect(h.ingestStarted).toBe(true));
    resetCalls();
    signal('SIGTERM');
    await vi.waitFor(() => expect(h.steps).not.toBeNull());
    const steps = h.steps!;
    steps.stopSamplers();
    expect(h.calls.stopSamplers).toBe(1);
    h.gateClosed = false;
    steps.flushTotals();
    expect(h.calls.flushTotals).toBe(1);
    h.gateClosed = true;
    try {
      steps.flushTotals();
    } finally {
      h.gateClosed = false;
    }
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
