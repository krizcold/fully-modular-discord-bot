import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemClaimStore } from '../helpers/fakeClaimStore';

// NB4 boot (shardBoot.ts): the wait lines, the JSON boot's gateway warning, the fleet view's shard source and
// recommendation time, the HTTP 401 paths, the claims pool URL, the record kept across a restart, the loss line for
// two shards, the grant's record failure line and the order of the "Running" line's ids.

const h = vi.hoisted(() => ({
  gateway: { info: { recommendedShards: 4, sessionStartLimit: null } as any, error: null as string | null },
  gatewaySeq: [] as Array<{ info: any; error: string | null }>,
  onFetch: null as null | ((call: number) => void),
  gatewayCalls: 0,
  plans: [] as Array<{ shards: number[]; shardCount: number }>,
  grantTakesMs: 0,
  dataState: 'serving' as string,
  stopping: false,
  leaves: [] as string[],
  records: [] as any[],
  recordThrows: false,
  readRecord: null as any,
  kind: 'postgres' as 'postgres' | 'file' | 'throw',
  creds: null as null | Record<string, string | undefined>,
  skew: { perf: 0, wall: 0 },
}));

vi.mock('../../src/bot/internalSetup/fleet/placement', async orig => ({
  ...(await orig<any>()),
  fetchGatewayInfoResult: vi.fn(async () => {
    h.gatewayCalls += 1;
    h.onFetch?.(h.gatewayCalls);
    return h.gatewaySeq.length > 0 ? h.gatewaySeq.shift()! : h.gateway;
  }),
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
vi.mock('../../src/bot/internalSetup/ingest/ingestService', () => {
  const fake = {
    setShardPlan: (shards: number[], shardCount: number) => {
      h.plans.push({ shards: [...shards], shardCount });
      if (h.grantTakesMs > 0) vi.setSystemTime(Date.now() + h.grantTakesMs);
    },
    isStarted: () => false,
    start: vi.fn(async () => 'ok'),
    stop: vi.fn(async () => undefined),
    getClient: () => null,
  };
  return { getIngestService: () => fake };
});
vi.mock('../../src/bot/internalSetup/utils/dataBackends/boot', async orig => ({
  ...(await orig<any>()),
  getDataBootStatus: () => ({ state: h.dataState }),
}));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/workingSet', async orig => ({
  ...(await orig<any>()),
  getWorkingSet: () => ({
    heldGuilds: () => [], writesSettled: () => true, landedFlushes: () => 0, flushOnTheWire: () => false,
    flushAllDirty: async () => undefined, dirtyGuildIds: () => [], unansweredGuilds: () => ({ all: [], only: [] }), takeDropLines: () => [],
  }),
}));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<any>()),
  getBackendHealth: () => ({ state: 'healthy', oldestDirtyMs: 0, dirtyBytes: 0, lastError: null }),
  getGuildDataBackend: () => null,
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
  readShardRecord: () => (h.readRecord ? structuredClone(h.readRecord) : null),
  writeShardRecord: (record: any) => {
    if (h.recordThrows) throw new Error('EACCES: permission denied');
    h.records.push(structuredClone(record));
  },
}));
vi.mock('../../src/utils/envLoader', async orig => {
  const actual = await orig<any>();
  return {
    ...actual,
    resolveDataBackend: () => {
      if (h.kind === 'throw') throw new Error('DATA_BACKEND is not set to a known backend');
      return h.kind;
    },
    loadCredentials: (...args: unknown[]) => (h.creds ? { ...actual.loadCredentials(...args), ...h.creds } : actual.loadCredentials(...args)),
  };
});

const RENEW_MS = 5000;
const DEADLINE_MS = 20_000;
const TOKEN_LINE = '[Shards] Discord refused the bot token (HTTP 401); no shard is taken until the token is fixed and the bot restarts';
const FAILED = { info: null, error: 'HTTP 500' };
let timed: Array<{ text: string; at: number }> = [];
const lines = () => timed.map(l => l.text);
let store: MemClaimStore;
let factoryUrls: string[] = [];
const savedToken = process.env.DISCORD_TOKEN;

/** Answers its takes with the taken shards in descending order. */
class DescendingTakeStore extends MemClaimStore {
  answered: number[][] = [];
  override async take(...args: Parameters<MemClaimStore['take']>): ReturnType<MemClaimStore['take']> {
    const answer = await super.take(...args);
    if (answer.kind === 'done') {
      answer.taken = [...answer.taken].sort((x, y) => y.pair.shardId - x.pair.shardId);
      this.answered.push(answer.taken.map(t => t.pair.shardId));
    }
    return answer;
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  vi.resetModules();
  Object.assign(h, {
    gateway: { info: { recommendedShards: 4, sessionStartLimit: null }, error: null }, gatewaySeq: [], onFetch: null,
    gatewayCalls: 0, plans: [], grantTakesMs: 0, dataState: 'serving', stopping: false, leaves: [], records: [],
    recordThrows: false, readRecord: null, kind: 'postgres', creds: null, skew: { perf: 0, wall: 0 },
  });
  delete process.env.FLEET_SHARD_CAPACITY;
  delete process.env.FLEET_TAKEOVER_SECONDS;
  delete process.env.FLEET_SHARD_COUNT;
  process.env.DISCORD_TOKEN = 'test-token';
  timed = [];
  factoryUrls = [];
  const capture = (...args: unknown[]) => { timed.push({ text: args.map(a => (a instanceof Error ? a.message : String(a))).join(' '), at: Date.now() }); };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
  store = new MemClaimStore(() => Date.now());
});
afterEach(async () => {
  const { getShardClaims } = await import('../../src/bot/internalSetup/fleet/shardBoot');
  getShardClaims()?.beginStop();
  const claims = getShardClaims() as any;
  if (claims?.renewTimer) clearInterval(claims.renewTimer);
  delete process.env.FLEET_SHARD_CAPACITY;
  delete process.env.FLEET_TAKEOVER_SECONDS;
  delete process.env.FLEET_SHARD_COUNT;
  if (savedToken === undefined) delete process.env.DISCORD_TOKEN;
  else process.env.DISCORD_TOKEN = savedToken;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function boot() {
  const mod = await import('../../src/bot/internalSetup/fleet/shardBoot');
  mod._setClaimStoreFactory(url => { factoryUrls.push(url); return store; });
  const ready = mod.bootShards();
  let settled = false;
  void ready.then(() => { settled = true; }, () => { settled = true; });
  return { mod, ready, settled: () => settled };
}

function otherNode(capacity: number) {
  store.nodes.set('node-x', {
    nodeId: 'node-x', nodeName: 'X', processId: 'p-x', capacity, takeoverSeconds: 30, fit: true, restartable: true, returns: true,
    seenAgoMs: 0, healthyForMs: null, seenAt: Date.now(), healthySince: Date.now(),
  });
}

describe('the wait for the database verdict', () => {
  it('logs the wait line at once, not again before 30 s, again at exactly 30 s, then takes once the data layer serves', async () => {
    h.dataState = 'verifying';
    const t0 = Date.now();
    const { ready } = await boot();
    const waits = () => timed.filter(l => l.text === '[Shards] Waiting for the database to verify before taking shards (state: verifying)').map(l => l.at - t0);
    await vi.advanceTimersByTimeAsync(0);
    expect(waits()).toEqual([0]);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(waits()).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(waits()).toEqual([0, 30_000]);
    expect(store.renewals).toEqual([]);
    h.dataState = 'serving';
    await vi.advanceTimersByTimeAsync(1000);
    await ready;
    expect(store.takes.length).toBeGreaterThanOrEqual(1);
  });
});

describe('the JSON boot', () => {
  it('a data backend setting that cannot be resolved is not Postgres: every shard runs here and no claim is taken', async () => {
    h.kind = 'throw';
    const { ready } = await boot();
    const ctx = await ready;
    expect(lines()).toContain('[Shards] Running all 4 shard(s) in this process');
    expect(ctx.shardCount).toBe(4);
    expect(store.renewals).toEqual([]);
    expect(store.takes).toEqual([]);
  });

  it('a failed /gateway/bot with a token logs the one-shard warning and runs one shard', async () => {
    h.kind = 'file';
    h.gateway = FAILED;
    const { ready } = await boot();
    const ctx = await ready;
    expect(lines().filter(l => l.includes('/gateway/bot failed'))).toEqual(['[Shards] /gateway/bot failed (HTTP 500); assuming 1 recommended shard']);
    expect(ctx.shardCount).toBe(1);
  });

  it('a failed /gateway/bot with no token logs no gateway warning', async () => {
    h.kind = 'file';
    h.gateway = FAILED;
    delete process.env.DISCORD_TOKEN;
    const { ready } = await boot();
    await ready;
    expect(lines().filter(l => l.includes('/gateway/bot'))).toEqual([]);
    expect(lines()).toContain('[Shards] Running all 1 shard(s) in this process');
  });

  it('an answered /gateway/bot with a token logs no gateway warning', async () => {
    h.kind = 'file';
    const { ready } = await boot();
    await ready;
    expect(lines().filter(l => l.includes('/gateway/bot'))).toEqual([]);
  });
});

describe('the fleet view after the boot', () => {
  it('names Discord as the shard source when /gateway/bot answered', async () => {
    h.kind = 'file';
    const { ready } = await boot();
    await ready;
    const { getFleetState } = await import('../../src/bot/internalSetup/fleet/state');
    expect(getFleetState().shardSource).toBe('discord');
  });

  it('names the fallback as the shard source when /gateway/bot failed', async () => {
    h.kind = 'file';
    h.gateway = FAILED;
    const { ready } = await boot();
    await ready;
    const { getFleetState } = await import('../../src/bot/internalSetup/fleet/state');
    expect(getFleetState().shardSource).toBe('fallback');
  });

  async function recommendation() {
    const t0 = Date.now();
    h.grantTakesMs = 1000;
    const { ready } = await boot();
    await ready;
    const { getFleetState } = await import('../../src/bot/internalSetup/fleet/state');
    const state = getFleetState();
    return { t0, shards: state.recommendedShards, at: state.recommendedAt };
  }

  it('a JSON boot reports Discord\'s recommendation as read before the grant, not when a slow grant ended', async () => {
    h.kind = 'file';
    const r = await recommendation();
    expect(h.plans.at(-1)).toEqual({ shards: [0, 1, 2, 3], shardCount: 4 });
    expect(r.shards).toBe(4);
    expect(r.at).toBe(r.t0);
  });

  it('a refused database reports Discord\'s recommendation as read before the empty grant', async () => {
    h.dataState = 'refused';
    const r = await recommendation();
    expect(h.plans.at(-1)).toEqual({ shards: [], shardCount: 0 });
    expect(r.shards).toBe(4);
    expect(r.at).toBe(r.t0);
  });

  it('a Postgres boot reports Discord\'s recommendation as read before the grant', async () => {
    process.env.FLEET_SHARD_CAPACITY = '2';
    otherNode(2);
    const r = await recommendation();
    expect(h.plans.at(-1)).toEqual({ shards: [0, 1], shardCount: 4 });
    expect(r.shards).toBe(4);
    expect(r.at).toBe(r.t0);
  });
});

describe('HTTP 401', () => {
  it('at the boot\'s /gateway/bot read: one token line, and the claims store is never built, renewed or asked', async () => {
    h.gateway = { info: null, error: 'HTTP 401' };
    const { ready } = await boot();
    const ctx = await ready;
    expect(lines().filter(l => l === TOKEN_LINE)).toHaveLength(1);
    expect(factoryUrls).toEqual([]);
    expect(store.renewals).toEqual([]);
    expect(store.takes).toEqual([]);
    expect(h.gatewayCalls).toBe(1);
    expect(ctx.shardCount).toBe(0);
  });

  it('while resolving the count: a stop that begins during the retirement leaves the boot unresolved and grants nothing', async () => {
    h.gateway = FAILED;
    h.onFetch = call => {
      if (call === 2) {
        store.renewMode = 'hang';
        h.gateway = { info: null, error: 'HTTP 401' };
      }
    };
    const { mod, settled } = await boot();
    await vi.advanceTimersByTimeAsync(0);
    expect(lines().filter(l => l === TOKEN_LINE)).toHaveLength(1);
    expect(settled()).toBe(false);
    h.stopping = true;
    store.renewMode = 'ok';
    store.releaseHung();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(RENEW_MS);
    expect(settled()).toBe(false);
    expect(mod.getFleetContext()).toBeNull();
    expect(h.plans).toEqual([]);
  });
});

describe('the shard count while /gateway/bot fails', () => {
  it('FLEET_SHARD_COUNT decides the count with no second /gateway/bot read', async () => {
    h.gateway = FAILED;
    process.env.FLEET_SHARD_COUNT = '2';
    process.env.FLEET_SHARD_CAPACITY = '2';
    const { ready, settled } = await boot();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled()).toBe(true);
    const ctx = await ready;
    expect(ctx.shardCount).toBe(2);
    expect(h.gatewayCalls).toBe(1);
    expect(lines().some(l => l.startsWith('[Shards] Cannot resolve the shard count yet'))).toBe(false);
  });

  it('logs the count line at the first failure and again at exactly 30 s, then takes once /gateway/bot answers', async () => {
    h.gateway = FAILED;
    const t0 = Date.now();
    const { ready } = await boot();
    const countLines = () => timed.filter(l => l.text.startsWith('[Shards] Cannot resolve the shard count yet'));
    await vi.advanceTimersByTimeAsync(0);
    expect(countLines().map(l => l.text)).toEqual(['[Shards] Cannot resolve the shard count yet: /gateway/bot failed (HTTP 500); retrying every 5 s unless the database holds a count']);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(h.gatewayCalls).toBeGreaterThanOrEqual(6);
    expect(countLines()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(countLines().map(l => l.at - t0)).toEqual([0, 30_000]);
    expect(store.takes.every(t => t.localCount === null)).toBe(true);
    h.gateway = { info: { recommendedShards: 4, sessionStartLimit: null }, error: null };
    await vi.advanceTimersByTimeAsync(RENEW_MS);
    const ctx = await ready;
    expect(ctx.shardCount).toBe(4);
  });
});

describe('the claims pool URL', () => {
  it('is DATA_BACKEND_URL with its surrounding spaces trimmed', async () => {
    h.creds = { DATA_BACKEND_URL: '  postgres://bot@db:5432/bot \n' };
    const { ready } = await boot();
    await ready;
    expect(factoryUrls).toEqual(['postgres://bot@db:5432/bot']);
  });

  it('is empty when DATA_BACKEND_URL is not set', async () => {
    h.creds = { DATA_BACKEND_URL: undefined };
    const { ready } = await boot();
    await ready;
    expect(factoryUrls).toEqual(['']);
  });
});

describe('the record of shards kept at the last stop', () => {
  const kept = { shardCount: 4, shardIds: [2], processId: 'p-old', at: '2026-11-01T00:00:00.000Z', keptAtStop: [2] };

  it('is rewritten without keptAtStop before the boot take answers', async () => {
    h.readRecord = kept;
    store.takeMode = 'hang';
    await boot();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.takes).toHaveLength(1);
    expect(h.plans).toEqual([]);
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({ shardCount: 4, shardIds: [2], processId: 'p-old', at: kept.at });
    expect(h.records[0].keptAtStop).toBeUndefined();
  });

  it('a rewrite that throws logs its line and the boot take still runs', async () => {
    h.readRecord = kept;
    h.recordThrows = true;
    store.takeMode = 'hang';
    await boot();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.takes).toHaveLength(1);
    expect(lines()).toContain('[Shards] Could not rewrite the shard record: EACCES: permission denied');
  });
});

describe('after the grant', () => {
  it('a record write that throws at the grant logs its line and the boot still finishes', async () => {
    h.recordThrows = true;
    process.env.FLEET_SHARD_CAPACITY = '2';
    otherNode(2);
    const { ready } = await boot();
    const ctx = await ready;
    expect(lines()).toContain('[Shards] Could not write the shard record: EACCES: permission denied');
    expect(ctx.shardCount).toBe(4);
  });

  it('losing two shards in one renewal starts one leave that names both', async () => {
    process.env.FLEET_SHARD_CAPACITY = '2';
    otherNode(2);
    const { ready } = await boot();
    await ready;
    expect(h.plans.at(-1)).toEqual({ shards: [0, 1], shardCount: 4 });
    for (const id of [0, 1]) Object.assign(store.rows.get(`4:${id}`)!, { claim: 900 + id, holderProcess: 'p-x', holderNode: 'node-x' });
    await vi.advanceTimersByTimeAsync(RENEW_MS);
    expect(h.leaves).toEqual(['Shard 0, 1 are no longer held by this process']);
    expect(h.records.at(-1)).toMatchObject({ shardCount: 4, shardIds: [] });
  });

  it('the Running line lists the held shards in ascending order whatever order the take answered them in', async () => {
    const descending = new DescendingTakeStore(() => Date.now());
    store = descending;
    process.env.FLEET_SHARD_CAPACITY = '2';
    otherNode(2);
    const { ready } = await boot();
    await ready;
    expect(descending.answered).toEqual([[1, 0]]);
    expect(lines()).toContain('[Shards] Running 2 of 4 shard(s) in this process: 0, 1');
  });
});

describe('a stop during the late-take renewal', () => {
  it('a stop that begins while a take acknowledged after D is renewed leaves the boot unresolved and grants nothing', async () => {
    process.env.FLEET_SHARD_CAPACITY = '2';
    otherNode(2);
    store.bounds = { renewMs: RENEW_MS, workMs: 2 * RENEW_MS };
    vi.doMock('../../src/bot/internalSetup/fleet/shardClaims', async orig => {
      const actual = await orig<any>();
      class ShardClaims extends actual.ShardClaims {
        constructor(deps: any) {
          super({ clocks: () => ({ perf: performance.now() + h.skew.perf, wall: Date.now() + h.skew.wall }), ...deps });
        }
      }
      return { ...actual, ShardClaims };
    });
    store.takeMode = 'hang';
    const { mod, settled } = await boot();
    vi.doUnmock('../../src/bot/internalSetup/fleet/shardClaims');
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.takes).toHaveLength(1);
    h.skew.perf += DEADLINE_MS + 1000;
    h.skew.wall += DEADLINE_MS + 1000;
    store.renewMode = 'hang';
    store.takeMode = 'ok';
    store.releaseHung();
    await vi.advanceTimersByTimeAsync(0);
    const renewalsBefore = store.renewals.length;
    h.stopping = true;
    store.renewMode = 'ok';
    store.releaseHung();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.renewals.length).toBe(renewalsBefore);
    expect(store.renewals.some(r => r.pairs.map(p => p.shardId).join() === '0,1')).toBe(true);
    expect(settled()).toBe(false);
    expect(h.plans).toEqual([]);
    expect(lines().some(l => l.startsWith('[Shards] Running'))).toBe(false);
    expect(h.records).toEqual([]);
    expect(mod.getFleetContext()).toBeNull();
  });
});
