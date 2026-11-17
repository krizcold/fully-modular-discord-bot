import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';

// NB37 mutation survivors (group F): the global config editor's upload, the web UI's leave answer, the held-writes
// check and the save run's subsystem re-save, the gate's global-write refusal, the claims store's order read and
// answer, and the serving renewal's order read.

const MODULE = 'nb37f';
const MODULE_FILE = 'nb37f.json';
const PLAIN = 'nb37fplain';
const PLAIN_FILE = 'nb37fplain.json';
const schema = {
  id: MODULE_FILE,
  name: 'NB37 F editor',
  description: 'test schema',
  properties: { a: { type: 'number', default: 0, description: 'a' }, b: { type: 'string', default: 'x', description: 'b' } },
};

const h = vi.hoisted(() => ({ files: [] as any[], stub: null as null | { settled: boolean; resave: string[] } }));
vi.mock('../../src/bot/internalSetup/utils/configDiscovery', async orig => ({
  ...(await orig<any>()),
  discoverConfigFiles: () => h.files,
  discoverGlobalDataFiles: () => [],
  getConfigFileMetadata: (id: string) => h.files.find(f => f.id === id && f.category === 'config') ?? null,
}));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig =>
  (await import('../helpers/longConfirm')).longConfirm(await orig<typeof import('../../src/bot/internalSetup/utils/dataManager')>()));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/workingSet', async orig => {
  const real = await orig<typeof import('../../src/bot/internalSetup/utils/dataBackends/workingSet')>();
  const stub = {
    writesSettled: () => h.stub!.settled,
    flushOnTheWire: () => false,
    flushAllDirty: () => Promise.resolve([] as string[]),
    landedFlushes: () => 0,
    dirtyGuildIds: () => [] as string[],
    resaveGuilds: () => h.stub!.resave,
    unansweredGuilds: () => ({ all: [] as string[], only: [] as string[] }),
  };
  return { ...real, getWorkingSet: () => (h.stub ? stub : real.getWorkingSet()) };
});

import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import panel from '../../src/bot/internalSetup/panels/configEditorGlobalPanel';
import { ROOT_CONFIG_PATH, saveGlobalConfig } from '../../src/bot/internalSetup/utils/configManager';
import { runSealed } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { _resetRowQueue } from '../../src/bot/internalSetup/utils/sharedStore';
import { BotManager } from '../../src/webui/botManager';
import {
  MaintenanceRefusal, orderRefusesGlobalWrite, setMaintenanceGate, setOrderRefusal,
} from '../../src/bot/internalSetup/utils/maintenanceGate';
import { dataUnavailableMessage } from '../../src/bot/internalSetup/utils/dataBackends/boot';
import { ClaimFailure, ClaimStore } from '../../src/bot/internalSetup/fleet/claimStore';
import { claimTimings } from '../../src/bot/internalSetup/fleet/claimRules';
import { ShardClaims, type ShardClaimsDeps } from '../../src/bot/internalSetup/fleet/shardClaims';
import { setBackendKind } from '../helpers/backendKind';
import { ME, MESSAGE, OrderStore, order, settle } from '../helpers/nx5Rig';

const T = claimTimings(30);
const moduleFile = dataPath('global', MODULE, MODULE_FILE);
const plainFile = dataPath('global', PLAIN, PLAIN_FILE);
const text = (value: unknown) => JSON.stringify(value, null, 2);

let errors: unknown[][] = [];
let warns: string[] = [];

beforeEach(() => {
  errors = [];
  warns = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(String(args[0])); });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args); });
});
afterEach(() => {
  h.stub = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------------------
// The global config editor's upload modal.
// ---------------------------------------------------------------------------------------------------------------

describe('the global config upload', () => {
  let users = 0;
  let download: { ok: boolean; body: string } = { ok: true, body: '' };

  function upload(fileId: string): Promise<string> {
    users += 1;
    const interaction = {
      fields: {
        getTextInputValue: () => '',
        getUploadedFiles: () => ({ size: 1, first: () => ({ url: 'https://cdn.invalid/upload.json' }) }),
      },
    };
    const context = { userId: `nb37f-${users}`, panelId: 'config_editor_global', data: {}, interaction, accessMethod: 'system_panel' } as any;
    return (async () => {
      let response: unknown;
      await runSealed('panel', null, null, async () => {
        response = await panel.handleModal!(context, `upload_${fileId}`);
        return 'payload';
      });
      await dm.flushAll();
      return JSON.stringify(response);
    })();
  }

  function clean(): void {
    fs.rmSync(dataPath('global', MODULE), { recursive: true, force: true });
    fs.rmSync(dataPath('global', PLAIN), { recursive: true, force: true });
    fs.rmSync(ROOT_CONFIG_PATH, { force: true });
    fs.rmSync(dataPath('.shared-mirror.json'), { force: true });
  }

  const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

  beforeEach(async () => {
    download = { ok: true, body: '' };
    vi.stubGlobal('fetch', async () => ({ ok: download.ok, text: async () => download.body }));
    h.files = [
      { id: 'config.json', path: ROOT_CONFIG_PATH, name: 'Main Bot Config', description: '', category: 'config', exists: true },
      { id: MODULE_FILE, path: moduleFile, name: schema.name, description: '', category: 'config', exists: true, schema, moduleName: MODULE },
      { id: PLAIN_FILE, path: plainFile, name: 'Plain', description: '', category: 'config', exists: true, moduleName: PLAIN },
    ];
    _resetRowQueue();
    clean();
    setBackendKind('file');
    saveGlobalConfig(MODULE_FILE, { a: 1 });
    saveGlobalConfig(PLAIN_FILE, { q: 0 });
    await dm.flushAll();
  });
  afterEach(() => {
    _resetRowQueue();
    setBackendKind(null);
    clean();
  });

  it('a download that fails answers that it failed and changes nothing, even with a body', async () => {
    download = { ok: false, body: text({ a: 7 }) };
    const shown = await upload(MODULE_FILE);
    expect(shown).toContain(JSON.stringify('## Error\nFailed to download the uploaded file.').slice(1, -1));
    expect(read(moduleFile)).toEqual({ a: 1 });
  });

  it('a JSON array is refused as not an object, and nothing is saved', async () => {
    download.body = text([5, 6]);
    const shown = await upload(MODULE_FILE);
    expect(shown).toContain(JSON.stringify('## Error\nData must be a JSON object').slice(1, -1));
    expect(read(moduleFile)).toEqual({ a: 1 });
  });

  it('with a schema, only the values that differ from the defaults are saved, a key the schema lacks among them', async () => {
    download.body = text({ a: 5, b: 'x', z: 1 });
    const shown = await upload(MODULE_FILE);
    expect(shown).not.toContain('## Error');
    expect(read(moduleFile)).toEqual({ a: 5, z: 1 });
  });

  it('the schema is the config file\'s, not that of a data file of the same id listed before it', async () => {
    h.files.unshift({ id: MODULE_FILE, path: dataPath('global', MODULE, 'other.json'), name: 'data twin', description: '', category: 'data', exists: true });
    download.body = text({ a: 5, b: 'x' });
    await upload(MODULE_FILE);
    expect(read(moduleFile)).toEqual({ a: 5 });
  });

  it('without a schema, the whole upload is saved', async () => {
    download.body = text({ q: 3 });
    const shown = await upload(PLAIN_FILE);
    expect(shown).not.toContain('## Error');
    expect(read(plainFile)).toEqual({ q: 3 });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// BotManager.leaveMaintenance: only the answers it knows are passed on.
// ---------------------------------------------------------------------------------------------------------------

describe('BotManager.leaveMaintenance with an answer it does not know', () => {
  const call = (self: object) => (BotManager.prototype as any).leaveMaintenance.call(self);
  const child = (reply: unknown) => ({ isRunning: () => true, botProcess: {}, stageReached: () => true, sendIPCMessage: vi.fn(async () => reply) });
  const UNKNOWN = { restarting: null, note: "can't confirm whether the bot restarts: it did not answer the request to leave maintenance" };
  const ANSWERED_LINE = '[BotManager] The bot process answered the request to leave maintenance without accepting it';

  it.each([
    ['leaving false with a cause it does not name', { leaving: false, heldBy: 'other' }],
    ['leaving false with an unknown cause and a why', { leaving: false, heldBy: 'other', why: 'a read failed' }],
    ['leaving null with a cause and no why', { leaving: null, heldBy: 'order' }],
    ['leaving null without a why', { leaving: null }],
    ['leaving something else with a why', { leaving: 'yes', why: 'a timeout' }],
    ['no answer value', undefined],
  ])('%s gives can\'t confirm and logs that the answer did not accept', async (_what, reply) => {
    expect(await call(child(reply))).toEqual(UNKNOWN);
    expect(warns).toEqual([ANSWERED_LINE]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// hasHeldWrites and the save run's subsystem re-save, over a stub working set.
// ---------------------------------------------------------------------------------------------------------------

describe('hasHeldWrites over the working set', () => {
  it('a working set whose writes have not settled is held, with nothing pending re-save', () => {
    h.stub = { settled: false, resave: [] };
    expect(dm.hasHeldWrites()).toBe(true);
  });

  it('a set pending re-save is held, with every write settled', () => {
    h.stub = { settled: true, resave: ['g1'] };
    expect(dm.hasHeldWrites()).toBe(true);
  });

  it('guard: settled with nothing pending is not held', () => {
    h.stub = { settled: true, resave: [] };
    expect(dm.hasHeldWrites()).toBe(false);
  });
});

describe('the save run asks each subsystem to save again', () => {
  it('a subsystem whose re-save throws is logged and the run goes on to its answer', async () => {
    h.stub = { settled: true, resave: [] };
    const failure = new Error('premium write failed');
    const thrower = { resaveHeld: () => { throw failure; }, heldFiles: () => [] as string[] };
    let second = 0;
    const next = { resaveHeld: () => { second += 1; }, heldFiles: () => [] as string[] };
    dm.addHeldSaver(thrower);
    dm.addHeldSaver(next);
    try {
      const counts = await dm.saveHeldWrites(1000);
      expect(counts).toMatchObject({ unsavedGuilds: 0, unsavedFiles: 0 });
    } finally {
      dm.removeHeldSaver(thrower);
      dm.removeHeldSaver(next);
    }
    expect(second).toBe(1);
    expect(errors).toEqual([['[Data] A held change could not be saved again:', failure]]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The maintenance gate.
// ---------------------------------------------------------------------------------------------------------------

describe('the order refuses a global write only while the gate is closed', () => {
  afterEach(() => {
    setOrderRefusal(false);
    setMaintenanceGate(null);
  });

  it('the refusal on with the gate open refuses no global write; with the gate closed it does', () => {
    setMaintenanceGate(null);
    setOrderRefusal(true);
    expect(orderRefusesGlobalWrite()).toBe(false);
    setMaintenanceGate({ cause: 'order', message: MESSAGE });
    expect(orderRefusesGlobalWrite()).toBe(true);
  });

  it('a Dummy provider refusal answers the maintenance text', () => {
    expect(dataUnavailableMessage(new MaintenanceRefusal('refused').causeKey)).toBe('The bot is in maintenance, so your change was not saved. Please try again later.');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The claims store's order read and answer.
// ---------------------------------------------------------------------------------------------------------------

function poolRejecting(answer: () => unknown, hangConnect = false) {
  const pool = {
    connect() {
      if (hangConnect) return new Promise(() => undefined);
      return Promise.resolve({
        query() {
          const a = answer();
          return a instanceof Promise ? a : Promise.reject(a);
        },
        release() { /* kept */ },
      });
    },
    async end() { /* nothing open */ },
    on() { return pool; },
  };
  return pool;
}

function poolAnswering(rows: any[]) {
  const pool = {
    async connect() {
      return { query: async () => ({ rows, rowCount: rows.length }), release() { /* kept */ } };
    },
    async end() { /* nothing open */ },
    on() { return pool; },
  };
  return pool;
}

function storeWith(pool: object): any {
  const store = new ClaimStore('postgres://nobody@127.0.0.1:1/none', T, () => undefined);
  void (store as any).pool.end().catch(() => undefined);
  (store as any).pool = pool;
  return store;
}

const ACK = {
  orderId: 'o-1', processId: 'p-a', nodeId: 'node-a', nodeName: 'A', saved: true, unsavedGuilds: 0, unsavedFiles: 0,
  unansweredGuilds: 0, unconfirmedFiles: 0, unansweredFiles: 0, resaveGuilds: 0,
};

describe('the claims store\'s order read', () => {
  it('a row whose message is null reads an empty message', async () => {
    const store = storeWith(poolAnswering([{ order_id: 'o-1', state: 'maintenance', message: null, current: true }]));
    expect(await store.readSaveOrder()).toEqual({ orderId: 'o-1', state: 'maintenance', message: '', current: true });
  });

  it('a read that rejects with null rejects with null, not a TypeError', async () => {
    const store = storeWith(poolRejecting(() => null));
    let caught: unknown = 'none';
    await store.readSaveOrder().catch((error: unknown) => { caught = error; });
    expect(caught).toBeNull();
  });

  it('a thrown function carrying 42P01 is not an object: the read rejects with it', async () => {
    const thrown = Object.assign(() => undefined, { code: '42P01' });
    const store = storeWith(poolRejecting(() => thrown));
    let caught: unknown = 'none';
    await store.readSaveOrder().then(() => { caught = 'resolved'; }, (error: unknown) => { caught = error; });
    expect(caught).toBe(thrown);
  });

  it('a read that rejects with undefined rejects with the claims failure', async () => {
    const store = storeWith(poolRejecting(() => undefined));
    let caught: unknown = 'none';
    await store.readSaveOrder().catch((error: unknown) => { caught = error; });
    expect(caught).toBeInstanceOf(ClaimFailure);
  });

  it('a connect that never answers rejects naming the save order read', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const store = storeWith(poolRejecting(() => undefined, true));
    let caught: any = null;
    void store.readSaveOrder().catch((error: unknown) => { caught = error; });
    await vi.advanceTimersByTimeAsync(T.renewMs + 10);
    expect(caught?.message).toBe('the save order read got no answer in time');
  });
});

describe('the claims store\'s save answer', () => {
  it('a write that rejects with undefined rejects with the claims failure', async () => {
    const store = storeWith(poolRejecting(() => undefined));
    let caught: unknown = 'none';
    await store.writeSaveAck(ACK).catch((error: unknown) => { caught = error; });
    expect(caught).toBeInstanceOf(ClaimFailure);
  });

  it('a write that fails with a server error rejects with that error', async () => {
    const pgFailure = Object.assign(new Error('permission denied for table save_acks'), { code: '42501' });
    const store = storeWith(poolRejecting(() => pgFailure));
    let caught: unknown = 'none';
    await store.writeSaveAck(ACK).catch((error: unknown) => { caught = error; });
    expect(caught).toBe(pgFailure);
  });

  it('a connect that never answers rejects naming the save answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const store = storeWith(poolRejecting(() => undefined, true));
    let caught: any = null;
    void store.writeSaveAck(ACK).catch((error: unknown) => { caught = error; });
    await vi.advanceTimersByTimeAsync(T.renewMs + 10);
    expect(caught?.message).toBe('the save answer got no answer in time');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The serving renewal's order read.
// ---------------------------------------------------------------------------------------------------------------

function claimsRig(store: OrderStore, over: Partial<ShardClaimsDeps> = {}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  const reads: unknown[] = [];
  const claims = new ShardClaims({
    store, me: ME, timings: T, capacity: 4, takeoverSeconds: 30, returns: true, restartable: true, startedAt: 0,
    clocks: () => ({ perf: performance.now(), wall: Date.now() }),
    fitness: () => null,
    gateClosed: () => false,
    isStopping: () => false,
    stopServingStep: () => undefined,
    noteLapsed: () => undefined,
    noteLost: () => undefined,
    restartForShards: () => true,
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    onSaveOrder: (read: unknown) => { reads.push(read); },
    ...over,
  } as ShardClaimsDeps);
  return { claims, reads };
}

describe('the order read after a serving renewal', () => {
  it('a read still running when the next renewal succeeds starts no second read', async () => {
    const store = new OrderStore(() => Date.now());
    store.saveOrder = order();
    store.orderDelayMs = T.renewMs * 10;
    const { claims, reads } = claimsRig(store);
    claims.start();
    await claims.firstRenewal();
    await settle();
    await vi.advanceTimersByTimeAsync(T.renewMs * 2);
    await settle();
    expect(store.orderReads).toBe(1);
    expect(reads).toEqual([]);
    void claims.stopLanes();
  });

  it('a read answered after a later renewal failed is dropped', async () => {
    const store = new OrderStore(() => Date.now());
    store.saveOrder = order();
    store.orderDelayMs = Math.floor(T.renewMs * 1.5);
    const { claims, reads } = claimsRig(store);
    claims.start();
    await claims.firstRenewal();
    await settle();
    store.renewMode = new Error('read ECONNRESET');
    await vi.advanceTimersByTimeAsync(T.renewMs * 2);
    await settle();
    expect(store.orderReads).toBe(1);
    expect(reads).toContain('unknown');
    expect(reads).not.toContainEqual(order());
    void claims.stopLanes();
  });

  it('a standby\'s renewal that fails sends no unknown read', async () => {
    const store = new OrderStore(() => Date.now());
    store.renewMode = new Error('read ECONNRESET');
    const { claims, reads } = claimsRig(store, { standby: { attempt: 'r-1', count: 4, onEnd: () => undefined } } as any);
    claims.start();
    await vi.advanceTimersByTimeAsync(T.renewMs * 3);
    await settle();
    expect((store as any).standbyRenewals.length).toBeGreaterThan(0);
    expect(reads).toEqual([]);
    void claims.stopLanes();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The Postgres boot hands the claims store's order read to maintenance (shardBoot), over nb4Boot's stand-ins.
// ---------------------------------------------------------------------------------------------------------------

const b = {
  attached: [] as any[],
  drops: 0,
  backend: null as any,
};

function mockBootModules(): void {
  vi.doMock('../../src/bot/internalSetup/fleet/placement', async orig => ({
    ...(await orig<any>()),
    fetchGatewayInfoResult: async () => ({ info: { recommendedShards: 4, sessionStartLimit: null }, error: null }),
  }));
  vi.doMock('../../src/bot/internalSetup/utils/dataBackends/dataReadiness', async orig => ({
    ...(await orig<any>()),
    getDataReadiness: () => ({ onLeaseChanged: () => undefined }),
  }));
  vi.doMock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async orig => ({
    ...(await orig<any>()),
    cleanOrphanTmpFiles: async () => undefined,
  }));
  vi.doMock('../../src/bot/internalSetup/fleet/nodeIdentity', async orig => ({
    ...(await orig<any>()),
    getNodeId: () => 'node-a', getNodeName: () => 'A', getAppVersion: () => '1.0.0',
  }));
  vi.doMock('../../src/bot/internalSetup/ingest/ingestService', () => {
    const fake = {
      setShardPlan: () => undefined,
      isStarted: () => false,
      start: async () => 'ok',
      stop: () => Promise.resolve(),
      getClient: () => null,
    };
    return { getIngestService: () => fake };
  });
  vi.doMock('../../src/bot/internalSetup/utils/dataBackends/boot', async orig => ({
    ...(await orig<any>()),
    getDataBootStatus: () => ({ state: 'serving' }),
  }));
  vi.doMock('../../src/bot/internalSetup/utils/dataBackends/workingSet', async orig => ({
    ...(await orig<any>()),
    getWorkingSet: () => ({
      resaveGuilds: () => [],
      heldGuilds: () => [], writesSettled: () => true, landedFlushes: () => 0, flushOnTheWire: () => false,
      flushAllDirty: async () => undefined, dirtyGuildIds: () => [], unansweredGuilds: () => ({ all: [], only: [] }), takeDropLines: () => [],
    }),
  }));
  vi.doMock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
    ...(await orig<any>()),
    getBackendHealth: () => ({ state: 'healthy', oldestDirtyMs: 0, dirtyBytes: 0, lastError: null }),
    getGuildDataBackend: () => b.backend,
    isStopping: () => false,
  }));
  vi.doMock('../../src/bot/internalSetup/utils/maintenance', async orig => ({
    ...(await orig<any>()),
    maintenanceUnfit: () => null,
    canRestart: () => true,
    restartForShards: () => true,
    startLeave: () => undefined,
    noteClaimsLapsed: () => undefined,
    attachSaveOrderSource: (source: unknown) => { b.attached.push(source); },
    dropSaveOrderRead: () => { b.drops += 1; },
  }));
  vi.doMock('../../src/bot/internalSetup/fleet/shardRecord', async orig => ({
    ...(await orig<any>()),
    writeShardRecord: () => undefined,
  }));
  vi.doMock('../../src/utils/envLoader', async orig => ({
    ...(await orig<any>()),
    resolveDataBackend: () => 'postgres',
  }));
}

const BOOT_MODULES = [
  '../../src/bot/internalSetup/fleet/placement',
  '../../src/bot/internalSetup/utils/dataBackends/dataReadiness',
  '../../src/bot/internalSetup/utils/dataBackends/fileBackend',
  '../../src/bot/internalSetup/fleet/nodeIdentity',
  '../../src/bot/internalSetup/ingest/ingestService',
  '../../src/bot/internalSetup/utils/dataBackends/boot',
  '../../src/bot/internalSetup/utils/dataBackends/workingSet',
  '../../src/bot/internalSetup/utils/dataManager',
  '../../src/bot/internalSetup/utils/maintenance',
  '../../src/bot/internalSetup/fleet/shardRecord',
  '../../src/utils/envLoader',
];

describe('the Postgres boot and the save order source', () => {
  let mod: any = null;
  let changed: ((next: string) => void) | null = null;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
    vi.resetModules();
    mockBootModules();
    b.attached = [];
    b.drops = 0;
    changed = null;
    delete process.env.FLEET_SHARD_CAPACITY;
    delete process.env.FLEET_TAKEOVER_SECONDS;
    const { PostgresBackend } = await import('../../src/bot/internalSetup/utils/dataBackends/postgresBackend');
    b.backend = Object.assign(Object.create(PostgresBackend.prototype), {
      notifyLoginRefused: () => undefined,
      chosenEntry: () => 'postgres://bot@db:5432/bot',
      connectionState: () => ({ state: 'ready' }),
      latchReason: () => null,
      noteLapse: () => undefined,
      onDatabaseChanged: (fn: (next: string) => void) => { changed = fn; },
    });
    mod = await import('../../src/bot/internalSetup/fleet/shardBoot');
  });
  afterEach(() => {
    const claims = mod?.getShardClaims() as any;
    claims?.beginStop();
    if (claims?.renewTimer) clearInterval(claims.renewTimer);
    for (const path of BOOT_MODULES) vi.doUnmock(path);
    vi.resetModules();
    b.backend = null;
  });

  async function bootWith(store: object): Promise<void> {
    mod._setClaimStoreFactory(() => store);
    await mod.bootShards();
  }

  it('a store with the order read and the answer is attached: its read and its answer reach the store', async () => {
    const store = new OrderStore(() => Date.now());
    store.saveOrder = order();
    await bootWith(store);
    expect(b.attached).toHaveLength(1);
    expect(b.attached[0].me).toEqual({ processId: expect.any(String), nodeId: 'node-a', nodeName: 'A' });
    const reads = store.orderReads;
    expect(await b.attached[0].read()).toEqual(order());
    expect(store.orderReads).toBe(reads + 1);
  });

  it('a store with the answer but no order read attaches no source', async () => {
    const { MemClaimStore } = await import('../helpers/fakeClaimStore');
    const store = Object.assign(new MemClaimStore(() => Date.now()), { writeSaveAck: async () => true });
    await bootWith(store);
    expect(b.attached).toEqual([]);
  });

  it('a change of database drops the kept order read', async () => {
    await bootWith(new OrderStore(() => Date.now()));
    expect(changed).not.toBeNull();
    expect(b.drops).toBe(0);
    changed!('postgres://bot@db2:5432/bot');
    expect(b.drops).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The normal boot attaches the entitlement bridge to its Client (clientInitializer), over nb10's stand-ins.
// ---------------------------------------------------------------------------------------------------------------

const ci = {
  reported: [] as string[],
  events: [] as string[],
};

const CLIENT_MODULES: Array<[string, () => Record<string, unknown>]> = [
  ['dotenv/config', () => ({})],
  ['../../src/bot/internalSetup/utils/getAllFiles', () => ({ default: () => [] })],
  ['../../src/bot/internalSetup/utils/panelManager', () => ({
    getPanelManager: () => ({ loadPanels: async () => undefined, registerPanel: () => undefined, recoverPanels: async () => undefined }),
  })],
  ['../../src/bot/internalSetup/utils/ipcPanelHandler', () => ({ setupPanelIPCHandlers: () => undefined })],
  ['../../src/bot/internalSetup/utils/ipcCommandHandler', () => ({ setupCommandIPCHandlers: () => undefined })],
  ['../../src/bot/internalSetup/utils/ipcDataHandler', () => ({ setupDataIPCHandlers: () => undefined })],
  ['../../src/bot/internalSetup/utils/accessLogChannel', () => ({ setupAccessLogChannel: () => undefined })],
  ['../../src/bot/internalSetup/utils/ipcMetricsHandler', () => ({ markMetricsReady: () => undefined, setupMetricsIPCHandlers: () => undefined })],
  ['../../src/bot/internalSetup/utils/ipcFleetHandler', () => ({ setupFleetIPCHandlers: () => undefined })],
  ['../../src/bot/internalSetup/utils/metrics/metricsCollector', () => ({
    getMetricsCollector: () => ({ seedTotals: () => undefined, flushTotals: () => undefined }),
  })],
  ['../../src/bot/internalSetup/utils/metrics/samplers', () => ({ startSamplers: () => undefined, stopSamplers: () => undefined })],
  ['../../src/bot/internalSetup/utils/ipcReloadHandler', () => ({ setupReloadIPCHandlers: () => undefined })],
  ['../../src/bot/internalSetup/utils/ipcToggleHandler', () => ({ setupToggleIPCHandlers: () => undefined, applyAllDisabledStatesOnBoot: () => undefined })],
  ['../../src/bot/internalSetup/utils/ipcNotificationHandler', () => ({ setupIPCNotificationHandler: () => undefined })],
  ['../../src/bot/internalSetup/utils/subscriptionNotifier', () => ({ getSubscriptionNotifier: () => ({ setClient: () => undefined }) })],
  ['../../src/bot/internalSetup/utils/payment/paymentRegistry', () => ({
    getPaymentRegistry: () => ({
      listAll: () => [],
      get: (id: string) => (id === 'discord'
        ? { attachGatewayBridge: (attach: (event: string, handler: (payload: unknown) => void) => void) => { attach('entitlementCreate', () => undefined); } }
        : undefined),
      on: () => undefined,
      off: () => undefined,
    }),
  })],
  ['../../src/bot/internalSetup/utils/moduleAutoUpdater', () => ({ startModuleAutoUpdater: () => undefined })],
  ['../../src/bot/internalSetup/fleet/shardBoot', () => ({ bootShards: async () => ({ startIngest: () => undefined }), getShardClaims: () => null })],
  ['../../src/bot/internalSetup/ingest/ingestService', () => ({
    getIngestService: () => ({
      buildClient: () => ({ once: () => undefined, on: (event: string) => { ci.events.push(event); }, user: null }),
      close: async () => undefined,
    }),
  })],
  ['../../src/bot/internalSetup/utils/moduleLoader', () => ({ ModuleLoader: class { async loadAllModules() { return []; } } })],
  ['../../src/bot/internalSetup/utils/moduleRegistry', () => ({
    getModuleRegistry: () => ({ setClient: () => undefined, getStats: () => ({ total: 0, byCategory: {} }) }),
  })],
];

const CLIENT_SPREAD: Array<[string, Record<string, unknown>]> = [
  ['../../src/utils/envLoader', { loadCredentials: () => ({}) }],
  ['../../src/bot/internalSetup/utils/premiumManager', { startPremiumTickers: () => undefined, getPremiumManager: () => undefined }],
  ['../../src/bot/internalSetup/utils/configManager', { ensureConfigPopulated: () => undefined }],
  ['../../src/bot/internalSetup/utils/dataBackends/boot', { initDataBackendLayer: () => undefined }],
  ['../../src/bot/internalSetup/utils/dataManager', { addStopStep: () => undefined, getGuildDataBackend: () => null, sweepGraveyard: async () => undefined }],
  ['../../src/bot/internalSetup/utils/sharedOps', { setupSharedOpsIPC: () => undefined }],
  ['../../src/bot/internalSetup/utils/maintenance', {
    decideBoot: async () => ({ mode: 'normal' }),
    setupMaintenanceIPCAtBoot: () => undefined,
    watchDataBackend: () => undefined,
    installMaintenanceGate: () => undefined,
    markDiscordStarted: () => undefined,
  }],
];

describe('the normal boot\'s entitlement bridge', () => {
  afterEach(() => {
    for (const [path] of CLIENT_MODULES) vi.doUnmock(path);
    for (const [path] of CLIENT_SPREAD) vi.doUnmock(path);
    vi.resetModules();
  });

  it('the boot hands its Client the Discord provider\'s entitlement events', async () => {
    vi.resetModules();
    for (const [path, factory] of CLIENT_MODULES) vi.doMock(path, factory);
    for (const [path, over] of CLIENT_SPREAD) vi.doMock(path, async (orig: () => Promise<any>) => ({ ...(await orig()), ...over }));
    ci.reported = [];
    ci.events = [];
    const realSend = process.send;
    const role = process.env.BOT_PROCESS_ROLE;
    process.env.BOT_PROCESS_ROLE = 'bot';
    (process as any).send = (message: any) => {
      if (message?.type === 'data:writer') ci.reported.push(message.data.stage);
      return true;
    };
    try {
      void (await import('../../src/bot/internalSetup/clientInitializer')).main().catch(console.error);
      await vi.waitFor(() => expect(ci.reported).toContain('guild'), { timeout: 5000, interval: 5 });
      await vi.waitFor(() => expect(ci.events).toContain('entitlementCreate'), { timeout: 5000, interval: 5 });
    } finally {
      (process as any).send = realSend;
      if (role === undefined) delete process.env.BOT_PROCESS_ROLE;
      else process.env.BOT_PROCESS_ROLE = role;
    }
  });
});
