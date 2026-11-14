import { EventEmitter } from 'events';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NB6 test 8's row 49 and test 70's cell 462, with D4's registration of cell 440 (wip-redesign/sheets/NB6.md:
// decision 14, C24, C25, D4; part 8), run through the real clientInitializer.ts runBot over faked collaborators: on a
// Postgres bot the stop step `stopSharedPass` is added before bootShared runs and before startSharedPass starts the
// pass timer and the listener; bootShared runs after bootShards and before the populate; startSharedPass after the
// modules load. A JSON bot adds no NB6 stop step and starts no pass; a maintenance boot runs none of it.

const h = vi.hoisted(() => {
  const state = {
    order: [] as string[],
    stopSteps: [] as Array<unknown>,
    pg: true,
    maintenance: false,
    bootResult: 'done' as 'done' | 'stopped',
    lines: [] as string[],
  };
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
  getPanelManager: () => ({ loadPanels: async () => undefined, registerPanel: () => undefined, recoverPanels: async () => undefined }),
}));
vi.mock('../../src/bot/internalSetup/utils/ipcPanelHandler', () => ({ setupPanelIPCHandlers: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/ipcCommandHandler', () => ({ setupCommandIPCHandlers: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/ipcDataHandler', () => ({ setupDataIPCHandlers: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/accessLogChannel', () => ({ setupAccessLogChannel: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/ipcMetricsHandler', () => ({ markMetricsReady: () => undefined, setupMetricsIPCHandlers: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/ipcFleetHandler', () => ({ setupFleetIPCHandlers: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/metrics/metricsCollector', () => ({ getMetricsCollector: () => ({ seedTotals: () => undefined, flushTotals: () => undefined }) }));
vi.mock('../../src/bot/internalSetup/utils/metrics/samplers', () => ({ startSamplers: () => undefined, stopSamplers: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/postgresBackend', () => ({ PostgresBackend: class {} }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async () => {
  const { PostgresBackend } = await import('../../src/bot/internalSetup/utils/dataBackends/postgresBackend');
  const pgBackend = new (PostgresBackend as unknown as new () => object)();
  return {
    addStopStep: (step: unknown) => { h.stopSteps.push(step); h.order.push('addStopStep'); },
    addReleaseStep: () => undefined,
    getGuildDataBackend: () => (h.pg ? pgBackend : null),
    sweepGraveyard: async () => undefined,
    DataBackendUnavailableError: class extends Error {},
  };
});
vi.mock('../../src/bot/internalSetup/utils/sharedMirror', () => {
  const stopSharedPass = () => undefined;
  return {
    stopSharedPass,
    bootShared: async () => { h.order.push('bootShared'); return h.bootResult; },
    startSharedPass: () => { h.order.push('startSharedPass'); },
  };
});
vi.mock('../../src/bot/internalSetup/utils/sharedOps', () => ({ setupSharedOpsIPC: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/moduleApply', () => ({
  recoverModuleApplies: () => { h.order.push('recovery'); },
  beginBootApplies: () => { h.order.push('bootApplies'); },
  bootCompileModules: async () => { h.order.push('compile'); },
  bootLoadCheck: async (_client: unknown, loaded: unknown[]) => { h.order.push('loadCheck'); return loaded; },
  setModuleApplyClient: () => undefined,
}));
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
  bootShards: async () => { h.order.push('bootShards'); return { startIngest: () => { h.order.push('startIngest'); } }; },
  getShardClaims: () => ({ beginStop: () => undefined, finishStop: async () => undefined }),
}));
vi.mock('../../src/bot/internalSetup/fleet/guildRequests', () => ({ guildRequestsStopStep: async () => undefined, startGuildRequestSweep: () => undefined, requestGuildRequestPass: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/servingGate', () => ({ stoppedServing: () => false }));
vi.mock('../../src/bot/internalSetup/ingest/ingestService', () => ({
  getIngestService: () => ({
    close: async () => undefined,
    buildClient: () => Object.assign(new EventEmitter(), { user: { tag: 'bot#0001' } }),
  }),
}));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/replyGate', () => ({ installReplyGate: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/moduleLoader', () => ({ ModuleLoader: class { async loadAllModules() { h.order.push('loadModules'); return []; } } }));
vi.mock('../../src/bot/internalSetup/utils/moduleRegistry', () => ({
  getModuleRegistry: () => ({ setClient: () => undefined, getStats: () => ({ total: 0, byCategory: {} }), getAllModules: () => [] }),
}));
vi.mock('../../src/bot/internalSetup/utils/moduleEventManager', () => ({
  getModuleEventManager: () => ({ setClient: () => undefined, registerListener: () => undefined, getListenerCount: () => 0 }),
}));
vi.mock('../../src/bot/internalSetup/utils/configManager', () => ({ ensureConfigPopulated: () => { h.order.push('populate'); } }));
vi.mock('../../src/bot/internalSetup/utils/maintenance', () => ({
  decideBoot: async () => ({ mode: h.maintenance ? 'maintenance' : 'normal' }),
  installMaintenanceGate: () => undefined,
  markDiscordStarted: () => undefined,
  runMaintenanceBoot: async () => { h.order.push('maintenanceBoot'); },
  setupMaintenanceIPCAtBoot: () => undefined,
  watchDataBackend: () => undefined,
}));
vi.mock('../../src/bot/internalSetup/utils/maintenanceGate', () => ({ isMaintenanceGateClosed: () => false }));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/mainDatabase', () => ({ stopMainWatch: () => undefined, noteShardReconnect: () => undefined }));
vi.mock('../../src/bot/internalSetup/fleet/standbyBoot', () => ({ claimsStop: async () => undefined, endStandbyMaintenanceAnswers: () => undefined, l20Line: () => '' }));

afterAll(() => { vi.restoreAllMocks(); });

async function boot(): Promise<void> {
  vi.resetModules();
  const ci = await import('../../src/bot/internalSetup/clientInitializer');
  void ci.runBot({}).catch(error => h.lines.push(String(error)));
}

const nb6 = () => h.order.filter(step => ['addStopStep', 'bootShards', 'bootShared', 'populate', 'loadModules', 'startSharedPass', 'maintenanceBoot'].includes(step));

beforeEach(() => {
  h.order = [];
  h.stopSteps = [];
  h.pg = true;
  h.maintenance = false;
  h.bootResult = 'done';
});

describe('cell 440\'s registration (D4) and decision 14\'s order', () => {
  it('a Postgres bot: the stop step stopSharedPass before bootShared; bootShared after bootShards, before the populate; the pass after the modules load', async () => {
    await boot();
    await vi.waitFor(() => expect(h.order).toContain('startSharedPass'));
    const { stopSharedPass } = await import('../../src/bot/internalSetup/utils/sharedMirror');
    expect(h.stopSteps).toHaveLength(3);
    expect(h.stopSteps[2]).toBe(stopSharedPass);
    expect(nb6()).toEqual(['addStopStep', 'addStopStep', 'bootShards', 'addStopStep', 'bootShared', 'populate', 'loadModules', 'startSharedPass']);
  });

  it('a stop ends bootShared: nothing after it runs', async () => {
    h.bootResult = 'stopped';
    await boot();
    await vi.waitFor(() => expect(h.order).toContain('bootShared'));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(nb6()).toEqual(['addStopStep', 'addStopStep', 'bootShards', 'addStopStep', 'bootShared']);
  });
});

describe('row 46 (part 18): the boot order of 45', () => {
  it('a Postgres bot: the recovery, the docs and the swaps (bootShared), one compile, the populate, loadModules with its load check, then the listener', async () => {
    await boot();
    await vi.waitFor(() => expect(h.order).toContain('startSharedPass'));
    const steps = ['bootShards', 'recovery', 'bootApplies', 'bootShared', 'compile', 'populate', 'loadModules', 'loadCheck', 'startSharedPass'];
    expect(h.order.filter(step => steps.includes(step))).toEqual(steps);
  });

  it('a JSON bot: no recovery, no boot compile and no load check', async () => {
    h.pg = false;
    await boot();
    await vi.waitFor(() => expect(h.order).toContain('loadModules'));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(h.order.filter(step => ['recovery', 'bootApplies', 'compile', 'loadModules', 'loadCheck'].includes(step))).toEqual(['loadModules']);
  });
});

describe('cell 462: a JSON bot (guard)', () => {
  it('adds no NB6 stop step and starts no pass or listener', async () => {
    h.pg = false;
    await boot();
    await vi.waitFor(() => expect(h.order).toContain('loadModules'));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(h.stopSteps).toHaveLength(2);
    expect(h.order).not.toContain('startSharedPass');
  });
});

describe('row 49: a maintenance boot', () => {
  it('runs no pass, no listener and adds no stop step', async () => {
    h.maintenance = true;
    await boot();
    await vi.waitFor(() => expect(h.order).toContain('maintenanceBoot'));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(nb6()).toEqual(['maintenanceBoot']);
  });
});
