import { EventEmitter } from 'events';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NB35 (1), run through the real clientInitializer.ts runBot over faked collaborators: once bootShards hands back a
// context whose data layer refused the database, the boot runs no module recovery, no boot applies, no shared pass
// (neither bootShared nor startSharedPass), no boot compile and no populate, and logs one [Shared] line with the
// refusal's reason. The modules still load from what is on disk, and at clientReady the module auto-updater does not start.

const h = vi.hoisted(() => {
  const state = {
    order: [] as string[],
    pg: true,
    dataRefusal: undefined as string | undefined,
    lines: [] as string[],
    client: null as import('events').EventEmitter | null,
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
    addStopStep: () => undefined,
    addReleaseStep: () => undefined,
    getGuildDataBackend: () => (h.pg ? pgBackend : null),
    sweepGraveyard: async () => undefined,
    DataBackendUnavailableError: class extends Error {},
  };
});
vi.mock('../../src/bot/internalSetup/utils/sharedMirror', () => ({
  stopSharedPass: () => undefined,
  bootShared: async () => { h.order.push('bootShared'); return 'done'; },
  startSharedPass: () => { h.order.push('startSharedPass'); },
}));
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
vi.mock('../../src/bot/internalSetup/utils/moduleAutoUpdater', () => ({ startModuleAutoUpdater: () => { h.order.push('autoUpdater'); } }));
vi.mock('../../src/bot/internalSetup/fleet/shardBoot', () => ({
  bootShards: async () => {
    h.order.push('bootShards');
    return {
      nodeId: 'node-a', nodeName: 'A', shardCount: 0,
      startIngest: () => { h.order.push('startIngest'); },
      ...(h.dataRefusal !== undefined ? { dataRefusal: h.dataRefusal } : {}),
    };
  },
  getShardClaims: () => ({ beginStop: () => undefined, finishStop: async () => undefined }),
}));
vi.mock('../../src/bot/internalSetup/fleet/guildRequests', () => ({ guildRequestsStopStep: async () => undefined, startGuildRequestSweep: () => undefined, requestGuildRequestPass: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/servingGate', () => ({ stoppedServing: () => false }));
vi.mock('../../src/bot/internalSetup/ingest/ingestService', () => ({
  getIngestService: () => ({
    close: async () => undefined,
    buildClient: () => {
      h.client = Object.assign(new EventEmitter(), { user: { tag: 'bot#0001' } });
      return h.client;
    },
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
  decideBoot: async () => ({ mode: 'normal' }),
  installMaintenanceGate: () => undefined,
  markDiscordStarted: () => undefined,
  runMaintenanceBoot: async () => undefined,
  setupMaintenanceIPCAtBoot: () => undefined,
  watchDataBackend: () => undefined,
}));
vi.mock('../../src/bot/internalSetup/utils/maintenanceGate', () => ({ isMaintenanceGateClosed: () => false }));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/mainDatabase', () => ({ stopMainWatch: () => undefined, noteShardReconnect: () => undefined }));
vi.mock('../../src/bot/internalSetup/fleet/standbyBoot', () => ({ claimsStop: async () => undefined, endStandbyMaintenanceAnswers: () => undefined, l20Line: () => '' }));

afterAll(() => { vi.restoreAllMocks(); });

const REASON = 'the configured database is not the one this deployment\'s data lives in (store store-b vs recorded store-a)';
const LEFT_LINE = `[Shared] Left the shared files, the App Store modules and config.json as they are: the data layer refused to serve (${REASON})`;
const WRITERS = ['recovery', 'bootApplies', 'bootShared', 'compile', 'populate', 'startSharedPass'];

async function boot(): Promise<void> {
  vi.resetModules();
  const ci = await import('../../src/bot/internalSetup/clientInitializer');
  void ci.runBot({}).catch(error => h.lines.push(String(error)));
}

beforeEach(() => {
  h.order = [];
  h.lines = [];
  h.pg = true;
  h.dataRefusal = undefined;
  h.client = null;
});

describe('NB35 (1): a boot whose data layer refused the database', () => {
  it('a Postgres bot: no recovery, apply, shared pass, compile or populate; the modules load; one [Shared] line names the refusal', async () => {
    h.dataRefusal = REASON;
    await boot();
    await vi.waitFor(() => expect(h.order).toContain('loadCheck'));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(h.order.filter(step => WRITERS.includes(step))).toEqual([]);
    expect(h.order.filter(step => ['bootShards', 'loadModules', 'loadCheck'].includes(step))).toEqual(['bootShards', 'loadModules', 'loadCheck']);
    expect(h.lines.filter(line => line.startsWith('[Shared]'))).toEqual([LEFT_LINE]);
    expect(h.lines).not.toContain('[Bot] Synchronizing config.json with schema...');
  });

  it('a JSON bot whose DATA_BACKEND was refused: no populate, the same line', async () => {
    h.pg = false;
    h.dataRefusal = REASON;
    await boot();
    await vi.waitFor(() => expect(h.order).toContain('loadModules'));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(h.order.filter(step => WRITERS.includes(step))).toEqual([]);
    expect(h.lines.filter(line => line.startsWith('[Shared]'))).toEqual([LEFT_LINE]);
  });

  it.each([['Postgres', true], ['JSON', false]])('a refused %s bot does not start the module auto-updater at clientReady', async (_kind, pg) => {
    h.pg = pg;
    h.dataRefusal = REASON;
    await ready();
    await vi.waitFor(() => expect(h.lines).toContain(UPDATER_LINE));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(h.order).not.toContain('autoUpdater');
  });

  it('guard: a bot whose data layer serves starts the module auto-updater at clientReady', async () => {
    await ready();
    await vi.waitFor(() => expect(h.order).toContain('autoUpdater'));
    expect(h.lines).not.toContain(UPDATER_LINE);
  });
});

const UPDATER_LINE = '[Bot] The module auto-updater did not start: the data layer refused to serve, so the App Store modules stay as they are';

async function ready(): Promise<void> {
  await boot();
  await vi.waitFor(() => expect(h.client?.listenerCount('clientReady')).toBe(1));
  h.client!.emit('clientReady');
  await vi.waitFor(() => expect(h.lines).toContain('[Initializer] Initialization complete.'));
}
