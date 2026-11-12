import { EventEmitter } from 'events';
import { Partials } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// clientInitializer.ts's real runBot() with every module it starts a stand-in that records: the intents line of a
// login, the partials the built client gets, the reconnect notes on the shard events, the Postgres-only steps (the
// shared pass with the guild request pass, the module apply client), the module panels registered in the module's
// boot start window, and the intents line of a promoted standby whose sessions stayed.

const h = vi.hoisted(() => ({
  order: [] as string[],
  backend: null as unknown,
  modules: [] as any[],
  context: {} as Record<string, unknown>,
  client: null as any,
  buildOptions: null as any,
  reconnects: 0,
  sharedPass: [] as unknown[],
  applyClients: [] as unknown[],
  handed: new Map<string, unknown>(),
  openStarts: new Map<string, unknown>(),
  requestPass: () => undefined,
}));

vi.mock('dotenv/config', () => ({}));
vi.mock('../../src/utils/envLoader', async orig => ({ ...(await orig<any>()), loadCredentials: () => ({}) }));
vi.mock('../../src/bot/internalSetup/utils/getAllFiles', () => ({ default: () => [] }));
vi.mock('../../src/bot/internalSetup/utils/panelManager', () => ({
  getPanelManager: () => ({
    loadPanels: async () => undefined,
    registerPanel: (panel: any) => { h.order.push(`registerPanel ${panel.id}`); },
    recoverPanels: async () => undefined,
  }),
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
  getModuleRegistry: () => ({ setClient: () => undefined, getStats: () => ({ total: 0, byCategory: {} }), getAllModules: () => h.modules }),
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
  startSharedPass: (opts: unknown) => { h.sharedPass.push(opts); },
  stopSharedPass: async () => undefined,
}));
vi.mock('../../src/bot/internalSetup/utils/moduleApply', async orig => ({
  ...(await orig<any>()),
  recoverModuleApplies: () => undefined,
  beginBootApplies: () => undefined,
  bootCompileModules: async () => undefined,
  bootLoadCheck: async (_client: unknown, loaded: unknown) => loaded,
  setModuleApplyClient: (client: unknown) => { h.applyClients.push(client); },
}));
vi.mock('../../src/bot/internalSetup/utils/moduleCrashes', async orig => ({
  ...(await orig<any>()),
  bootStartOf: (name: string) => h.handed.get(name),
  openStarts: h.openStarts,
  openWindow: (start: any) => { h.order.push(`openWindow ${start.label}`); },
  closeWindow: (start: any) => { h.order.push(`closeWindow ${start.label}`); },
}));
vi.mock('../../src/bot/internalSetup/utils/maintenance', async orig => ({
  ...(await orig<any>()),
  decideBoot: async () => ({ mode: 'normal' }),
  setupMaintenanceIPCAtBoot: () => undefined,
  watchDataBackend: () => undefined,
  installMaintenanceGate: () => undefined,
  markDiscordStarted: () => undefined,
}));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/mainDatabase', () => ({
  stopMainWatch: () => undefined,
  noteShardReconnect: () => { h.reconnects += 1; },
  setStepLayers: () => undefined,
}));
vi.mock('../../src/bot/internalSetup/fleet/guildRequests', () => ({
  guildRequestsStopStep: async () => undefined,
  requestGuildRequestPass: h.requestPass,
  startGuildRequestSweep: () => undefined,
}));
vi.mock('../../src/bot/internalSetup/utils/servingGate', async orig => ({ ...(await orig<any>()), stoppedServing: () => false }));
vi.mock('../../src/bot/internalSetup/fleet/shardBoot', async orig => ({
  ...(await orig<any>()),
  bootShards: async () => ({ ...h.context, startIngest: () => undefined }),
  getShardClaims: () => null,
  getLeaseRuntime: () => null,
}));

/** A discord.js Client as runBot uses it; emit only records (no 'clientReady' work runs), fire calls the listeners. */
function fakeClient(intents: number) {
  const events = new EventEmitter();
  const emitted: string[] = [];
  const client: any = {
    options: { intents },
    user: { tag: 'bot#0001' },
    isReady: () => true,
    on: (event: string, fn: (...a: any[]) => void) => { events.on(event, fn); return client; },
    once: (event: string, fn: (...a: any[]) => void) => { events.once(event, fn); return client; },
    emit: (event: string) => { emitted.push(event); return true; },
    fire: (event: string) => events.emit(event),
    emitted,
  };
  return client;
}

vi.mock('../../src/bot/internalSetup/ingest/ingestService', () => {
  const service = {
    buildClient: (options: { intents: number[] }) => {
      h.buildOptions = options;
      h.client = fakeClient(options.intents.reduce((a, b) => a | b, 0));
      return h.client;
    },
    adoptClient: (client: unknown) => { h.client = client; return client; },
    getClient: () => h.client,
    close: async () => undefined,
  };
  return { getIngestService: () => service, IngestService: class {} };
});

const DEFAULT_BITS = 1 | 2 | 512 | 32768 | 1024;
const DEFAULT_NAMES = ['Guilds', 'GuildMembers', 'GuildMessages', 'MessageContent', 'GuildMessageReactions'];

let logs: unknown[][];
let warns: string[];
beforeEach(() => {
  vi.resetModules();
  h.order.length = 0;
  h.backend = null;
  h.modules = [];
  h.context = {};
  h.client = null;
  h.buildOptions = null;
  h.reconnects = 0;
  h.sharedPass.length = 0;
  h.applyClients.length = 0;
  h.handed.clear();
  h.openStarts.clear();
  logs = [];
  warns = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a); });
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.map(String).join(' ')); });
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function run(opts: Record<string, unknown> = {}): Promise<void> {
  const ci = await import('../../src/bot/internalSetup/clientInitializer');
  await ci.runBot(opts as any);
}

async function postgres(): Promise<void> {
  const { PostgresBackend } = await import('../../src/bot/internalSetup/utils/dataBackends/postgresBackend');
  h.backend = Object.create(PostgresBackend.prototype);
}

function panelModule(name: string, displayName: string, panelIds: string[]) {
  return {
    manifest: { name, version: '1.0.0', displayName, description: 'a test module', author: 'a', category: 'misc' },
    path: `/modules/${name}`, events: new Map(), exports: new Map(), initialized: false, importedFiles: [], commands: [],
    panels: panelIds.map(id => ({ id })),
  } as any;
}

const loggedPlain = () => logs.map(a => a.map(String).join(' '));

describe('the login of a normal boot', () => {
  it('logs the intents it logs in with and builds the client with the message, reaction and user partials', async () => {
    await run();
    expect(logs).toContainEqual(['Logging in with intents:', DEFAULT_NAMES]);
    expect(h.buildOptions.partials).toEqual([Partials.Message, Partials.Reaction, Partials.User]);
    expect(h.buildOptions.intents.reduce((a: number, b: number) => a | b, 0)).toBe(DEFAULT_BITS);
  });

  it('a shardReady and a shardResume each note one reconnect to the main database watch', async () => {
    await run();
    expect(h.reconnects).toBe(0);
    h.client.fire('shardReady');
    expect(h.reconnects).toBe(1);
    h.client.fire('shardResume');
    expect(h.reconnects).toBe(2);
  });

  it('a file-mode boot starts no shared pass and hands no client to the module apply', async () => {
    await run();
    expect(h.sharedPass).toEqual([]);
    expect(h.applyClients).toEqual([]);
  });

  it("a Postgres boot starts the shared pass with the guild request pass and hands the built client to the module apply", async () => {
    await postgres();
    await run();
    expect(h.sharedPass).toHaveLength(1);
    expect((h.sharedPass[0] as any).guildRequests).toBe(h.requestPass);
    expect(h.applyClients).toEqual([h.client]);
  });
});

describe('a promoted standby with its Client', () => {
  it('logs no intents line for the adopted client', async () => {
    const adopted = fakeClient(DEFAULT_BITS);
    await run({ client: adopted });
    expect(h.client).toBe(adopted);
    expect(loggedPlain().some(l => l.startsWith('Logging in with intents:'))).toBe(false);
  });

  it('whose sessions stayed and logged in with every intent the modules ask: no missing intents line', async () => {
    h.context = { keptSessions: true };
    const adopted = fakeClient(DEFAULT_BITS);
    await run({ client: adopted });
    expect(adopted.emitted).toEqual(['clientReady']);
    expect(warns.filter(w => w.startsWith('[Shards] The modules ask for gateway intents'))).toEqual([]);
  });
});

describe('module panels at boot', () => {
  it("each panel is registered, logged and counted, inside the module's boot start window when that start is still open", async () => {
    const start = { label: 'alpha-start' };
    h.handed.set('alpha', start);
    h.openStarts.set('alpha', start);
    h.modules = [panelModule('alpha', 'Alpha', ['p1', 'p2'])];
    await run();
    expect(h.order.filter(o => /Window|registerPanel/.test(o))).toEqual([
      'openWindow alpha-start', 'registerPanel p1', 'registerPanel p2', 'closeWindow alpha-start',
    ]);
    const plain = loggedPlain();
    expect(plain).toContain("[Bot] Registered panel 'p1' from module 'Alpha'");
    expect(plain).toContain("[Bot] Registered panel 'p2' from module 'Alpha'");
    expect(plain).toContain('[Bot] Registered 2 module panels');
  });

  it('a handed start that is no longer the open one opens no window around the panels', async () => {
    h.handed.set('beta', { label: 'beta-old' });
    h.openStarts.set('beta', { label: 'beta-new' });
    h.modules = [panelModule('beta', 'Beta', ['q1'])];
    await run();
    expect(h.order.filter(o => /Window|registerPanel/.test(o))).toEqual(['registerPanel q1']);
    expect(loggedPlain()).toContain('[Bot] Registered 1 module panels');
  });

  it('a module the boot handed no start registers its panels with no window', async () => {
    h.modules = [panelModule('gamma', 'Gamma', ['r1'])];
    await run();
    expect(h.order.filter(o => /Window|registerPanel/.test(o))).toEqual(['registerPanel r1']);
  });
});
