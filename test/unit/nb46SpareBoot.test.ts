import fs from 'fs';
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NB46 rows 1, 8 and 9 (wip-redesign/notes/NB46-cause.md): clientInitializer.ts's real runBot() on a Postgres bot
// with the stand-ins of ra3RunBotBoot.test.ts, the real start bookkeeping (moduleCrashes) and the real store record. A
// module's boot start is opened and handed to its turn as the boot loop does; the lease runtime grants `h.leases`.

const h = vi.hoisted(() => ({
  backend: null as unknown,
  modules: [] as any[],
  client: null as any,
  leases: [] as unknown[],
  stopped: false,
  gate: false,
}));

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
vi.mock('../../src/bot/internalSetup/utils/metrics/metricsCollector', () => ({
  getMetricsCollector: () => ({ seedTotals: () => undefined, flushTotals: () => undefined }),
}));
vi.mock('../../src/bot/internalSetup/utils/metrics/samplers', () => ({ startSamplers: () => undefined, stopSamplers: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/ipcReloadHandler', () => ({ setupReloadIPCHandlers: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/ipcToggleHandler', () => ({ setupToggleIPCHandlers: () => undefined, applyAllDisabledStatesOnBoot: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/ipcNotificationHandler', () => ({ setupIPCNotificationHandler: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/subscriptionNotifier', () => ({ getSubscriptionNotifier: () => ({ setClient: () => undefined }) }));
vi.mock('../../src/bot/internalSetup/utils/payment/paymentRegistry', () => ({
  getPaymentRegistry: () => ({ listAll: () => [], get: () => undefined, on: () => undefined, off: () => undefined }),
}));
vi.mock('../../src/bot/internalSetup/utils/premiumManager', async orig => ({ ...(await orig<any>()), startPremiumTickers: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/moduleAutoUpdater', () => ({ startModuleAutoUpdater: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/moduleLoader', () => ({ ModuleLoader: class { async loadAllModules() { return h.modules; } } }));
vi.mock('../../src/bot/internalSetup/utils/moduleRegistry', () => ({
  getModuleRegistry: () => ({ setClient: () => undefined, getStats: () => ({ total: 0, byCategory: {} }), getAllModules: () => h.modules, getModule: () => undefined }),
}));
vi.mock('../../src/bot/internalSetup/utils/configManager', async orig => ({ ...(await orig<any>()), ensureConfigPopulated: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/boot', async orig => ({
  ...(await orig<any>()),
  initDataBackendLayer: () => undefined,
  awaitDataStartupBarrier: async () => 'ready',
}));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<any>()),
  addStopStep: () => undefined,
  addReleaseStep: () => undefined,
  getGuildDataBackend: () => h.backend,
  sweepGraveyard: async () => undefined,
}));
vi.mock('../../src/bot/internalSetup/utils/sharedOps', async orig => ({ ...(await orig<any>()), setupSharedOpsIPC: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/writerLock', async orig => ({ ...(await orig<any>()), reportWriterStage: () => undefined }));
vi.mock('../../src/bot/internalSetup/utils/sharedMirror', async orig => ({
  ...(await orig<any>()),
  bootShared: async () => 'ok',
  startSharedPass: () => undefined,
  stopSharedPass: async () => undefined,
}));
vi.mock('../../src/bot/internalSetup/utils/moduleApply', async orig => ({
  ...(await orig<any>()),
  recoverModuleApplies: () => undefined,
  beginBootApplies: () => undefined,
  bootCompileModules: async () => undefined,
  bootLoadCheck: async (_client: unknown, loaded: unknown) => loaded,
  setModuleApplyClient: () => undefined,
}));
vi.mock('../../src/bot/internalSetup/utils/maintenance', async orig => ({
  ...(await orig<any>()),
  decideBoot: async () => ({ mode: 'normal' }),
  setupMaintenanceIPCAtBoot: () => undefined,
  watchDataBackend: () => undefined,
  installMaintenanceGate: () => undefined,
  markDiscordStarted: () => undefined,
}));
vi.mock('../../src/bot/internalSetup/utils/maintenanceGate', async orig => ({ ...(await orig<any>()), isMaintenanceGateClosed: () => h.gate }));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/mainDatabase', () => ({
  stopMainWatch: () => undefined,
  noteShardReconnect: () => undefined,
  setStepLayers: () => undefined,
}));
vi.mock('../../src/bot/internalSetup/fleet/guildRequests', () => ({
  guildRequestsStopStep: async () => undefined,
  requestGuildRequestPass: () => undefined,
  startGuildRequestSweep: () => undefined,
}));
vi.mock('../../src/bot/internalSetup/utils/servingGate', async orig => ({ ...(await orig<any>()), stoppedServing: () => h.stopped }));
vi.mock('../../src/bot/internalSetup/fleet/shardBoot', async orig => ({
  ...(await orig<any>()),
  bootShards: async () => ({ startIngest: () => undefined }),
  getShardClaims: () => null,
  getLeaseRuntime: () => ({ getCurrent: () => ({ processId: 'p-spare', shardCount: 4, leases: h.leases }) }),
}));

function fakeClient(intents: number) {
  const events = new EventEmitter();
  const client: any = {
    options: { intents },
    user: { tag: 'bot#0001' },
    isReady: () => true,
    on: (event: string, fn: (...a: any[]) => void) => { events.on(event, fn); return client; },
    once: (event: string, fn: (...a: any[]) => void) => { events.once(event, fn); return client; },
    emit: () => true,
    fire: (event: string) => events.emit(event),
  };
  return client;
}

vi.mock('../../src/bot/internalSetup/ingest/ingestService', () => {
  const service = {
    buildClient: (options: { intents: number[] }) => {
      h.client = fakeClient(options.intents.reduce((a, b) => a | b, 0));
      return h.client;
    },
    adoptClient: (client: unknown) => { h.client = client; return client; },
    getClient: () => h.client,
    close: async () => undefined,
  };
  return { getIngestService: () => service, IngestService: class {} };
});

const SHA = 'a'.repeat(64);
const OLD = 'c'.repeat(64);

type Crashes = typeof import('../../src/bot/internalSetup/utils/moduleCrashes');
type Records = typeof import('../../src/bot/internalSetup/utils/sharedRecords');
let crashes: Crashes;
let records: Records;
let logs: string[];

beforeEach(async () => {
  vi.resetModules();
  h.modules = [];
  h.client = null;
  h.leases = [];
  h.stopped = false;
  h.gate = false;
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  crashes = await import('../../src/bot/internalSetup/utils/moduleCrashes');
  records = await import('../../src/bot/internalSetup/utils/sharedRecords');
  crashes._resetModuleCrashes();
  fs.rmSync(records.storeRecordPath(), { force: true });
  const { PostgresBackend } = await import('../../src/bot/internalSetup/utils/dataBackends/postgresBackend');
  h.backend = Object.create(PostgresBackend.prototype);
});
afterEach(() => {
  crashes._resetModuleCrashes();
  fs.rmSync(records.storeRecordPath(), { force: true });
  vi.restoreAllMocks();
});

function moduleNamed(name: string) {
  return {
    manifest: { name, version: '1.0.0', displayName: name, description: 'a test module', author: 'a', category: 'misc' },
    path: `/modules/${name}`, events: new Map(), exports: new Map(), initialized: false, importedFiles: [], commands: [], panels: [],
  } as any;
}

/** The boot loop's start of an App Store module: opened with its entry's sha and handed to its turn. */
function bootStart(name: string, sha = SHA) {
  const start = crashes.startModule(name, sha, '1.0.0', `/modules/${name}`, { boot: true });
  if (typeof start === 'string') throw new Error(start);
  crashes.handToBootTurn(start);
  h.modules.push(moduleNamed(name));
  return start;
}

/** m's entry with an apply this boot swapped in, from OLD to SHA, as the boot pass leaves it before the turn. */
function bootApplied(): void {
  const read = records.readStoreRecord();
  if (!read.ok) throw new Error(read.reason);
  read.record.modules.m = {
    sha: OLD, stamp: null, files: {}, main: '1:ALPHA', built: null, failedSha: null, retryAt: null, heldSha: null, status: null,
    applying: { from: OLD, to: SHA, backup: null, displaced: 'backups', tag: '1:ALPHA', version: '1.0.0', updatedBy: 'BRAVO/p-bravo' },
  };
  records.writeStoreRecord(read.record);
}

const applyingOf = (module: string) => {
  const read = records.readStoreRecord();
  return read.ok ? read.record.modules[module]?.applying ?? null : 'unread';
};

async function runBot(): Promise<void> {
  const ci = await import('../../src/bot/internalSetup/clientInitializer');
  await ci.runBot({} as any);
}

describe('row 1: a Postgres boot granted no shard', () => {
  it("ends every handed boot start when runBot returns, so the module's start state is null", async () => {
    bootStart('m');
    bootStart('n');
    expect(crashes.startStateOf('m')).toBe('c');
    await runBot();
    expect(crashes.startStateOf('m')).toBeNull();
    expect(crashes.startStateOf('n')).toBeNull();
    expect(crashes.openStarts.has('m')).toBe(false);
    expect(crashes.openStarts.has('n')).toBe(false);
    expect(logs.some(l => l.startsWith('[Initializer] Running initialization'))).toBe(false);
  });
});

describe('row 8 (guard): a boot granted shards', () => {
  it('keeps its boot starts open until clientReady and ends them in the turns', async () => {
    h.leases = [{ shardId: 0 }, { shardId: 1 }];
    const start = bootStart('m');
    await runBot();
    expect(crashes.startStateOf('m')).toBe('c');
    expect(crashes.openStarts.get('m')).toBe(start);
    h.client.fire('clientReady');
    await vi.waitFor(() => expect(crashes.openStarts.has('m')).toBe(false));
    expect(crashes.startStateOf('m')).toBeNull();
    expect(logs.some(l => l.startsWith('[Initializer] Running initialization'))).toBe(true);
  });
});

describe('row 9 (guard): a boot granted no shard that cannot apply', () => {
  it('that stopped serving keeps its boot starts and the entry keeps applying', async () => {
    bootApplied();
    h.stopped = true;
    const start = bootStart('m');
    await runBot();
    expect(crashes.openStarts.get('m')).toBe(start);
    expect(crashes.startStateOf('m')).toBe('c');
    expect(applyingOf('m')).toMatchObject({ from: OLD, to: SHA });
  });

  it('with the maintenance gate closed keeps its boot starts and the entry keeps applying', async () => {
    bootApplied();
    h.gate = true;
    const start = bootStart('m');
    await runBot();
    expect(crashes.openStarts.get('m')).toBe(start);
    expect(crashes.startStateOf('m')).toBe('c');
    expect(applyingOf('m')).toMatchObject({ from: OLD, to: SHA });
  });
});
