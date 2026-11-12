import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemClaimStore } from '../helpers/fakeClaimStore';

// shardBoot.ts: the identify throttler each boot sets, a promoted JSON standby's context and last reshard, the
// verdict wait of a boot that is no standby, the latched line, the claims pool's entry, and what the claims, the
// reshard driver and the database step layers are handed.

const h = vi.hoisted(() => ({
  gateway: { info: { recommendedShards: 4, sessionStartLimit: null } as any, error: null as string | null },
  dataState: 'serving' as string,
  stopping: false,
  kind: 'postgres' as 'postgres' | 'file',
  backend: null as any,
  ingest: null as any,
  ws: null as any,
  builders: [] as any[],
  layers: null as any,
  leaves: [] as string[],
}));

vi.mock('../../src/bot/internalSetup/fleet/placement', async orig => ({
  ...(await orig<any>()),
  fetchGatewayInfoResult: vi.fn(async () => h.gateway),
}));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/dataReadiness', async orig => ({
  ...(await orig<any>()),
  getDataReadiness: () => ({ onLeaseChanged: () => undefined }),
}));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async orig => ({
  ...(await orig<any>()),
  cleanOrphanTmpFiles: vi.fn(async () => {}),
}));
vi.mock('../../src/bot/internalSetup/fleet/nodeIdentity', async orig => ({
  ...(await orig<any>()),
  getNodeId: () => 'node-a', getNodeName: () => 'A', getAppVersion: () => '1.0.0',
}));
vi.mock('../../src/bot/internalSetup/ingest/ingestService', () => ({ getIngestService: () => h.ingest }));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/boot', async orig => ({
  ...(await orig<any>()),
  getDataBootStatus: () => ({ state: h.dataState }),
}));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/workingSet', async orig => ({
  ...(await orig<any>()),
  getWorkingSet: () => h.ws,
}));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<any>()),
  getBackendHealth: () => ({ state: 'healthy', oldestDirtyMs: 0, dirtyBytes: 0, lastError: null }),
  getGuildDataBackend: () => h.backend,
  isStopping: () => h.stopping,
}));
vi.mock('../../src/bot/internalSetup/utils/maintenance', async orig => ({
  ...(await orig<any>()),
  maintenanceUnfit: () => null,
  canRestart: () => true,
  restartForShards: () => false,
  startLeave: (reason: string) => { h.leaves.push(reason); },
  noteClaimsLapsed: () => undefined,
}));
vi.mock('../../src/bot/internalSetup/fleet/shardRecord', async orig => ({
  ...(await orig<any>()),
  readShardRecord: () => null,
  writeShardRecord: () => undefined,
}));
vi.mock('../../src/utils/envLoader', async orig => ({
  ...(await orig<any>()),
  resolveDataBackend: () => h.kind,
}));
vi.mock('../../src/bot/internalSetup/fleet/identifySlots', async orig => {
  const actual = await orig<any>();
  return {
    ...actual,
    slotThrottlerBuilder: (deps: any) => { h.builders.push(deps); return actual.slotThrottlerBuilder(deps); },
  };
});
vi.mock('../../src/bot/internalSetup/utils/dataBackends/mainDatabase', async orig => ({
  ...(await orig<any>()),
  setStepLayers: (layers: any) => { h.layers = layers; },
}));

const LATCHED_LINE = '[Shards] This bot process stopped writing to its database before it took shards (no cause recorded), so it connects no shard to Discord';
const FIFTEEN_MIN = 15 * 60_000;

class SlotStore extends MemClaimStore {
  reserves: Array<{ bucket: number; holder: string; signal: AbortSignal | undefined }> = [];
  async reserveIdentifySlot(bucket: number, holder: string, signal?: AbortSignal): Promise<{ granted: true }> {
    this.reserves.push({ bucket, holder, signal });
    return { granted: true };
  }
}

let lines: string[] = [];
let store: MemClaimStore;
let factoryUrls: string[] = [];
const savedToken = process.env.DISCORD_TOKEN;

function fakeIngest(withThrottler = true) {
  const fake: any = {
    setShardPlan: () => undefined,
    isStarted: () => false,
    start: vi.fn(async () => 'ok'),
    stop: vi.fn(async () => undefined),
    getClient: () => null,
  };
  if (withThrottler) fake.setIdentifyThrottler = vi.fn();
  return fake;
}

function workingSet() {
  return {
    resaveGuilds: () => [], heldGuilds: () => [], writesSettled: () => true, landedFlushes: () => 0, flushOnTheWire: () => false,
    flushAllDirty: async () => undefined, dirtyGuildIds: () => [], unansweredGuilds: () => ({ all: [], only: [] }), takeDropLines: () => [],
    replaceShardClaim: vi.fn(), guildsOfShard: vi.fn((shardId: number) => [`guild-of-${shardId}`]),
  };
}

async function pgBackend(over: Record<string, unknown> = {}) {
  const { PostgresBackend } = await import('../../src/bot/internalSetup/utils/dataBackends/postgresBackend');
  return Object.assign(Object.create(PostgresBackend.prototype), {
    chosenEntry: () => 'postgres://bot@db:5432/bot',
    connectionState: () => ({ state: 'ready' }),
    onDatabaseChanged: vi.fn(),
    notifyLoginRefused: vi.fn(),
    latchReason: () => null,
    noteLapse: vi.fn(),
    ...over,
  });
}

// The first import transforms the whole module graph; done here, it does not count against the first test's time.
beforeAll(async () => {
  await import('../../src/bot/internalSetup/fleet/shardBoot');
  await import('../../src/bot/internalSetup/fleet/state');
  await import('../../src/bot/internalSetup/utils/dataBackends/postgresBackend');
}, 120_000);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  vi.resetModules();
  Object.assign(h, {
    gateway: { info: { recommendedShards: 4, sessionStartLimit: null }, error: null }, dataState: 'serving', stopping: false,
    kind: 'postgres', backend: null, ingest: fakeIngest(), ws: workingSet(), builders: [], layers: null, leaves: [],
  });
  delete process.env.FLEET_SHARD_CAPACITY;
  delete process.env.FLEET_SHARD_COUNT;
  delete process.env.FLEET_TAKEOVER_SECONDS;
  process.env.DISCORD_TOKEN = 'test-token';
  lines = [];
  factoryUrls = [];
  const capture = (...args: unknown[]) => { lines.push(args.map(a => (a instanceof Error ? a.message : String(a))).join(' ')); };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
  store = new MemClaimStore(() => Date.now());
});
afterEach(async () => {
  const mod = await import('../../src/bot/internalSetup/fleet/shardBoot');
  mod.getJsonReshard()?.stop();
  mod.getShardClaims()?.beginStop();
  const claims = mod.getShardClaims() as any;
  if (claims?.renewTimer) clearInterval(claims.renewTimer);
  if (savedToken === undefined) delete process.env.DISCORD_TOKEN;
  else process.env.DISCORD_TOKEN = savedToken;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function load() {
  const mod = await import('../../src/bot/internalSetup/fleet/shardBoot');
  mod._setClaimStoreFactory(url => { factoryUrls.push(url); return store; });
  return mod;
}

async function boot(opts?: Parameters<Awaited<ReturnType<typeof load>>['bootShards']>[0]) {
  const mod = await load();
  const ready = mod.bootShards(opts);
  let settled = false;
  void ready.then(() => { settled = true; }, () => { settled = true; });
  return { mod, ready, settled: () => settled };
}

describe('the JSON boot', () => {
  it('a fresh boot sets one identify throttler, and its context keeps no sessions', async () => {
    h.kind = 'file';
    const { ready } = await boot();
    const ctx = await ready;
    expect(ctx.shardCount).toBe(4);
    expect(h.ingest.setIdentifyThrottler).toHaveBeenCalledTimes(1);
    expect(h.ingest.setIdentifyThrottler.mock.calls[0][0]).toBeTypeOf('function');
    expect(h.builders).toHaveLength(1);
    expect(['parent', 'local']).toContain(h.builders[0].mode);
    expect(ctx.keptSessions).toBeUndefined();
  });

  it('a promoted JSON standby keeps the throttler it built, keeps its sessions, and shows no last reshard when the web UI sent no count', async () => {
    h.kind = 'file';
    const { LeaseRuntime } = await import('../../src/bot/internalSetup/fleet/leaseRuntime');
    const runtime = new LeaseRuntime(h.ingest);
    const { ready } = await boot({ taken: { json: true, count: 2, runtime } });
    const ctx = await ready;
    expect(ctx.shardCount).toBe(2);
    expect(ctx.keptSessions).toBe(true);
    expect(h.ingest.setIdentifyThrottler).not.toHaveBeenCalled();
    expect(h.builders).toHaveLength(0);
    const { getFleetState } = await import('../../src/bot/internalSetup/fleet/state');
    expect(getFleetState().lastReshard).toBeNull();
  });
});

describe('the verdict wait of a boot that is no standby', () => {
  it('a stop already begun does not end the wait once the data layer serves: the claims store is built', async () => {
    h.stopping = true;
    await boot();
    await vi.advanceTimersByTimeAsync(0);
    expect(factoryUrls).toEqual(['']);
  });

  it('has no 300 s bound: after 301 s of verifying it still waits, with no L33 line and no settle', async () => {
    h.dataState = 'verifying';
    const { settled } = await boot();
    await vi.advanceTimersByTimeAsync(301_000);
    expect(settled()).toBe(false);
    const { L33_LINE } = await import('../../src/bot/internalSetup/fleet/shardClaims');
    expect(lines).not.toContain(L33_LINE);
    expect(factoryUrls).toEqual([]);
  });
});

describe('the latch before the take', () => {
  it('names "no cause recorded" when the backend holds no latch reason', async () => {
    h.backend = await pgBackend({ connectionState: () => ({ state: 'latched' }), latchReason: () => null });
    const { ready } = await boot();
    const ctx = await ready;
    expect(lines).toContain(LATCHED_LINE);
    expect(ctx.shardCount).toBe(0);
    expect(factoryUrls).toEqual([]);
  });
});

describe('the claims pool', () => {
  it('is built on an empty entry when Postgres is configured but the backend is not a PostgresBackend', async () => {
    const { ready } = await boot();
    await ready;
    expect(factoryUrls).toEqual(['']);
  });
});

describe('the identify throttler on Postgres', () => {
  it('a store with an identify slot sets one database throttler whose reserve asks the store for this process', async () => {
    const slots = new SlotStore(() => Date.now());
    store = slots;
    const { ready } = await boot();
    await ready;
    const { processId } = await import('../../src/bot/internalSetup/fleet/processId');
    expect(h.ingest.setIdentifyThrottler).toHaveBeenCalledTimes(1);
    expect(h.builders).toHaveLength(1);
    expect(h.builders[0].mode).toBe('database');
    await expect(h.builders[0].reserve(3)).resolves.toEqual({ granted: true });
    expect(slots.reserves).toEqual([{ bucket: 3, holder: processId(), signal: undefined }]);
  });

  it('a store with no identify slot sets no throttler', async () => {
    const { ready } = await boot();
    await ready;
    expect(h.ingest.setIdentifyThrottler).not.toHaveBeenCalled();
    expect(h.builders).toHaveLength(0);
  });

  it('an ingest service with no throttler hook still boots over a store with an identify slot', async () => {
    h.ingest = fakeIngest(false);
    store = new SlotStore(() => Date.now());
    const { ready } = await boot();
    const ctx = await ready;
    expect(ctx.shardCount).toBe(4);
    expect(lines.filter(l => l.startsWith('[Shards] Running'))).toEqual(['[Shards] Running 4 of 4 shard(s) in this process: 0, 1, 2, 3']);
  });
});

describe('a promoted Postgres standby', () => {
  it('hands the claims its pairs as from a standby, and sets no database throttler over a store with an identify slot', async () => {
    const { processId } = await import('../../src/bot/internalSetup/fleet/processId');
    const { LeaseRuntime } = await import('../../src/bot/internalSetup/fleet/leaseRuntime');
    const pid = processId();
    const slots = new SlotStore(() => Date.now());
    store = slots;
    store.count = 2;
    store.reshard = { attempt: 'a1b2c3d4-0000-4000-8000-0000000000c2', state: 'done', fromCount: 1, toCount: 2 } as any;
    for (const s of [0, 1]) {
      store.rows.set(`2:${s}`, {
        shardCount: 2, shardId: s, claim: 70 + s, holderProcess: pid, holderNode: 'node-a', holderName: 'A', homeNode: 'node-a',
        released: false, reserved: false, takenAt: 0, renewedAt: 0, ttlMs: 30_000, expiresUpMs: 1_000_000, extended: false,
      } as any);
    }
    const runtime = new LeaseRuntime(fakeIngest(false));
    runtime.applyGrant = (async () => undefined) as any;
    const pairs = [0, 1].map(s => ({ shardCount: 2, shardId: s, claim: 70 + s }));
    const taken = {
      count: 2, processId: pid, pairs, runtime,
      stopLanes: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
      onServing: vi.fn(),
    };
    const { mod, ready } = await boot({ taken });
    await ready;
    const deps = (mod.getShardClaims() as any).deps;
    expect(deps.fromStandby).toBe(true);
    expect(deps.standbyPairs).toEqual(pairs);
    expect(h.ingest.setIdentifyThrottler).not.toHaveBeenCalled();
    expect(h.builders).toHaveLength(0);
  });

  it('a boot that is no standby hands the claims neither mark', async () => {
    const { mod, ready } = await boot();
    await ready;
    const deps = (mod.getShardClaims() as any).deps;
    expect(deps.fromStandby).toBeUndefined();
    expect(deps.standbyPairs).toBeUndefined();
  });
});

describe('what the claims are handed', () => {
  it('a new claim goes into the working set\'s fence', async () => {
    const { mod, ready } = await boot();
    await ready;
    (mod.getShardClaims() as any).deps.replaceShardClaim(2, 555);
    expect(h.ws.replaceShardClaim).toHaveBeenCalledWith(2, 555);
  });

  it('a shard\'s guilds come from the working set, and none when there is no working set', async () => {
    const { mod, ready } = await boot();
    await ready;
    const deps = (mod.getShardClaims() as any).deps;
    expect(deps.guildsOfShard(1)).toEqual(['guild-of-1']);
    h.ws = null;
    expect(deps.guildsOfShard(1)).toEqual([]);
  });

  it('a page read reaches the reshard driver', async () => {
    const { mod, ready } = await boot();
    await ready;
    const driver = mod.getReshard()!;
    const onPage = vi.spyOn(driver, 'onPage').mockResolvedValue(undefined);
    const page = { marker: 'page-1' } as any;
    await (mod.getShardClaims() as any).deps.onPage(page);
    expect(onPage).toHaveBeenCalledTimes(1);
    expect(onPage).toHaveBeenCalledWith(page);
  });
});

describe('the reshard driver', () => {
  it('is built over a store with a work client, and its wait shows in the fleet view', async () => {
    const { mod, ready } = await boot();
    await ready;
    const driver = mod.getReshard();
    expect(driver).not.toBeNull();
    const wait = { wanted: 8, source: 'discord' as const, reason: 'Discord allows 3 more gateway logins' };
    vi.spyOn(driver!, 'wait').mockReturnValue(wait);
    const { getFleetState } = await import('../../src/bot/internalSetup/fleet/state');
    expect(getFleetState().reshardWait).toEqual(wait);
  });

  it('sends through the parent channel', async () => {
    const original = process.send;
    if (!original) (process as any).send = () => true;
    let deps: any;
    try {
      const { mod, ready } = await boot();
      await ready;
      deps = (mod.getReshard() as any).deps;
    } finally {
      if (!original) delete (process as any).send;
    }
    expect(deps.send).toBeTypeOf('function');
    const got: unknown[] = [];
    const held = process.send;
    (process as any).send = (message: unknown) => { got.push(message); return true; };
    try {
      deps.send({ type: 'rc2:probe' });
    } finally {
      (process as any).send = held;
    }
    expect(got).toEqual([{ type: 'rc2:probe' }]);
  });

  it('reads the identify budget with its reset as a wall time ahead', async () => {
    h.gateway = { info: { recommendedShards: 4, sessionStartLimit: { total: 1000, remaining: 990, resetAfterMs: 3_600_000, maxConcurrency: 1 } }, error: null };
    const t0 = Date.now();
    const { mod, ready } = await boot();
    const ctx = await ready;
    expect(ctx.shardCount).toBe(4);
    const budget = (mod.getReshard() as any).deps.budget();
    expect(budget).toEqual({ stale: false, remaining: 986, resetAt: t0 + 3_600_000 });
  });

  it('reads Discord\'s recommendation up to exactly 15 minutes old, and none after', async () => {
    const t0 = Date.now();
    const { mod, ready } = await boot();
    await ready;
    const recommendation = (mod.getReshard() as any).deps.recommendation;
    expect(recommendation()).toBe(4);
    vi.setSystemTime(t0 + FIFTEEN_MIN);
    expect(recommendation()).toBe(4);
    vi.setSystemTime(t0 + FIFTEEN_MIN + 1);
    expect(recommendation()).toBeNull();
  });
});

describe('the database step layers', () => {
  it('stop serving for the step\'s reason when the backend holds no latch', async () => {
    h.backend = await pgBackend();
    const { mod, ready } = await boot();
    await ready;
    expect(h.layers).not.toBeNull();
    h.layers.stopServing('the move to the new database failed');
    expect(mod.getShardClaims()!.databaseStopWhy()).toBe('the move to the new database failed');
  });

  it('stop serving for the latch reason when the backend holds one', async () => {
    let latch: string | null = null;
    h.backend = await pgBackend({ latchReason: () => latch });
    const { mod, ready } = await boot();
    await ready;
    latch = 'the disk is full';
    h.layers.stopServing('the move to the new database failed');
    expect(mod.getShardClaims()!.databaseStopWhy()).toBe('the disk is full');
  });
});
