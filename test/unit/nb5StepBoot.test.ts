import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemClaimStore } from '../helpers/fakeClaimStore';

// NB5 test 7 at the shard boot (shardBoot.ts), on the harness of nb4L5s11Boot.test.ts: the claims store built from
// the chosen entry, the latched boot, and a latch while the boot takes shards or retire() releases them.

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
  backend: null as any,
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
    resaveGuilds: () => [],
    heldGuilds: () => [], writesSettled: () => true, landedFlushes: () => 0, flushOnTheWire: () => false,
    flushAllDirty: async () => undefined, dirtyGuildIds: () => [], unansweredGuilds: () => ({ all: [], only: [] }), takeDropLines: () => [],
  }),
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
    recordThrows: false, readRecord: null, kind: 'postgres', creds: null, skew: { perf: 0, wall: 0 }, backend: null,
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

// NB5 TEST 7 AT THE BOOT (C5 (a) to (c), E2, F2's rows 7 and 8).

const DB_WHY = 'db1:5432/bot was replaced by node-b (generation 4)';
const STOPPED_LINE = `[Shards] This bot process stopped writing to its database while it was taking shards (${DB_WHY}), so it connects no shard to Discord`;
const lease = () => h.plans.at(-1);

// The shard modules load fresh for each row: the store throws that load's pause error.
beforeEach(async () => {
  const fresh = await import('../../src/bot/internalSetup/fleet/claimStore');
  store.pausedError = () => new fresh.ClaimPausedError();
});

async function claimsOf(mod: Awaited<ReturnType<typeof boot>>['mod']) {
  await vi.waitFor(() => expect(mod.getShardClaims()).not.toBeNull());
  return mod.getShardClaims()!;
}

describe('test 7 at the boot: the claims store follows the chosen entry (C5)', () => {
  it('(a) and (b): the store gets the chosen entry, and a move\'s new entry retargets it', async () => {
    const { PostgresBackend } = await import('../../src/bot/internalSetup/utils/dataBackends/postgresBackend');
    h.creds = { DATA_BACKEND_URL: 'postgres://bot@db1:5432/bot,postgres://bot@db2:5432/bot' };
    const listeners: Array<(entry: string) => void> = [];
    h.backend = Object.assign(Object.create(PostgresBackend.prototype), {
      chosenEntry: () => 'postgres://bot@db2:5432/bot',
      connectionState: () => ({ state: 'ready' }),
      onDatabaseChanged: (cb: (entry: string) => void) => { listeners.push(cb); },
      notifyLoginRefused: vi.fn(),
      latchReason: () => null,
      noteLapse: vi.fn(),
    });
    const retarget = vi.fn();
    (store as any).retarget = retarget;
    const { ready } = await boot();
    await ready;
    expect(factoryUrls).toEqual(['postgres://bot@db2:5432/bot']);
    listeners[0]('postgres://bot@db3:5432/bot');
    expect(retarget).toHaveBeenCalledWith('postgres://bot@db3:5432/bot');
  });

  it('(c) a backend latched when the verdict answers: no store, no take, the latched-boot line, no shard granted', async () => {
    const { PostgresBackend } = await import('../../src/bot/internalSetup/utils/dataBackends/postgresBackend');
    h.backend = Object.assign(Object.create(PostgresBackend.prototype), {
      chosenEntry: () => 'postgres://bot@db1:5432/bot',
      connectionState: () => ({ state: 'latched' }),
      latchReason: () => DB_WHY,
      onDatabaseChanged: vi.fn(),
      notifyLoginRefused: vi.fn(),
    });
    const { ready } = await boot();
    const ctx = await ready;
    expect(factoryUrls).toEqual([]);
    expect(store.takes).toEqual([]);
    expect(lines()).toContain(`[Shards] This bot process stopped writing to its database before it took shards (${DB_WHY}), so it connects no shard to Discord`);
    expect(ctx.shardCount).toBe(0);
    expect(lease()).toEqual({ shards: [], shardCount: 0 });
  });
});

describe('test 7 at the boot: a latch while the boot takes shards (E2)', () => {
  it('during the take\'s sleep after a failure: no take after the latch, E2\'s line once, no lease, no Running line', async () => {
    store.takeMode = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5432'), { code: 'ECONNREFUSED' });
    const { mod, ready } = await boot();
    const claims = await claimsOf(mod);
    await vi.waitFor(() => expect(store.takes.length).toBeGreaterThan(0));
    const takes = store.takes.length;
    claims.stopServingForDatabase(DB_WHY);
    store.takeMode = 'ok';
    await vi.advanceTimersByTimeAsync(RENEW_MS);
    const ctx = await ready;
    expect(store.takes.length).toBe(takes);
    expect(lines().filter(l => l === STOPPED_LINE)).toHaveLength(1);
    expect(lines().filter(l => l.startsWith('[Shards] Cannot take shards yet: the take failed'))).toHaveLength(1);
    expect(lines().some(l => l.startsWith('[Shards] Running'))).toBe(false);
    expect(ctx.shardCount).toBe(0);
    expect(lease()).toEqual({ shards: [], shardCount: 0 });
  });

  it('with the take\'s connect held across the latch: nothing taken, no failure line, E2\'s line, no lease', async () => {
    const take = store.take.bind(store);
    store.take = (...args: Parameters<MemClaimStore['take']>) => {
      store.connectMode = 'hang';
      return take(...args);
    };
    const { mod, ready } = await boot();
    const claims = await claimsOf(mod);
    await vi.waitFor(() => expect(store.connectMode).toBe('hang'));
    await vi.advanceTimersByTimeAsync(0);
    claims.stopServingForDatabase(DB_WHY);
    store.connectMode = 'ok';
    store.releaseConnects();
    const ctx = await ready;
    expect(store.takes).toEqual([]);
    expect(lines().some(l => l.startsWith('[Shards] Cannot take shards yet'))).toBe(false);
    expect(lines().filter(l => l === STOPPED_LINE)).toHaveLength(1);
    expect(ctx.shardCount).toBe(0);
  });

  it('during the first renewal\'s sleep: firstRenewal ends, no take, no second failure line, E2\'s line, no lease', async () => {
    store.renewMode = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5432'), { code: 'ECONNREFUSED' });
    const { mod, ready } = await boot();
    const claims = await claimsOf(mod);
    await vi.waitFor(() => expect(lines().some(l => l.startsWith('[Shards] Cannot take shards yet: the claim renewal failed'))).toBe(true));
    claims.stopServingForDatabase(DB_WHY);
    store.renewMode = 'ok';
    await vi.advanceTimersByTimeAsync(RENEW_MS);
    const ctx = await ready;
    expect(store.takes).toEqual([]);
    expect(lines().filter(l => l.startsWith('[Shards] Cannot take shards yet'))).toHaveLength(1);
    expect(lines().filter(l => l === STOPPED_LINE)).toHaveLength(1);
    expect(ctx.shardCount).toBe(0);
  });

  it('at the take\'s answer: the pairs stay held, E2\'s line, no lease, no Running line', async () => {
    const mod = await import('../../src/bot/internalSetup/fleet/shardBoot');
    const take = store.take.bind(store);
    let taken: number[] = [];
    store.take = async (...args: Parameters<MemClaimStore['take']>) => {
      const answer = await take(...args);
      if (answer.kind === 'done') taken = answer.taken.map(t => t.pair.shardId);
      queueMicrotask(() => mod.getShardClaims()!.stopServingForDatabase(DB_WHY));
      return answer;
    };
    const { ready } = await boot();
    const ctx = await ready;
    const claims = mod.getShardClaims()!;
    expect(taken.length).toBeGreaterThan(0);
    expect(claims.heldPairs().map(p => p.shardId)).toEqual(taken);
    expect(lines().filter(l => l === STOPPED_LINE)).toHaveLength(1);
    expect(lines().some(l => l.startsWith('[Shards] Running'))).toBe(false);
    expect(ctx.shardCount).toBe(0);
  });

  it('F2 row 7: a latch inside the HTTP 401 path: the token line, then E2\'s line once; no release, no not-sent line, no lease, the claims kept', async () => {
    h.gateway = FAILED;
    let claims: any = null;
    h.onFetch = call => {
      if (call === 3) {
        claims.stopServingForDatabase(DB_WHY);
        h.gateway = { info: null, error: 'HTTP 401' };
      }
    };
    const { mod, ready } = await boot();
    claims = await claimsOf(mod);
    await vi.advanceTimersByTimeAsync(RENEW_MS);
    const ctx = await ready;
    expect(lines().filter(l => l === TOKEN_LINE)).toHaveLength(1);
    expect(lines().filter(l => l === STOPPED_LINE)).toHaveLength(1);
    expect(lines().indexOf(TOKEN_LINE)).toBeLessThan(lines().indexOf(STOPPED_LINE));
    expect(store.releases).toEqual([]);
    expect(lines().some(l => l.startsWith('[Shards] The release was not sent'))).toBe(false);
    expect(ctx.shardCount).toBe(0);
    expect(mod.getShardClaims()).toBe(claims);
  });
});

describe('test 7 at the boot: retire()\'s release meets a latch (E3, F2 row 8)', () => {
  async function retiring() {
    h.gateway = FAILED;
    h.onFetch = call => { if (call === 3) h.gateway = { info: null, error: 'HTTP 401' }; };
    const booted = await boot();
    const claims = await claimsOf(booted.mod);
    return { ...booted, claims };
  }

  it('(a) the latch after COMMIT was sent: the can\'t-confirm line once, no Released line, one release, none more at a second stop', async () => {
    store.releaseMode = 'hang';
    store.releaseFailsAt = 'commit';
    const { ready, claims } = await retiring();
    await vi.advanceTimersByTimeAsync(RENEW_MS);
    await vi.waitFor(() => expect(store.releases).toHaveLength(1));
    claims.stopServingForDatabase(DB_WHY);
    store.releaseHung();
    const ctx = await ready;
    const line = `[Shards] Can't confirm whether the release applied: this process stopped writing to its database while the release waited for its answer (${DB_WHY}); any shard row still naming this process frees once its claim expires`;
    expect(lines().filter(l => l === line)).toHaveLength(1);
    expect(lines().some(l => l.startsWith('[Shards] Released shards'))).toBe(false);
    expect(h.records.some(r => r.keptAtStop !== undefined)).toBe(false);
    await claims.finishStop();
    expect(store.releases).toHaveLength(1);
    expect(lines().some(l => l === STOPPED_LINE)).toBe(false);
    expect(ctx.shardCount).toBe(0);
  });

  it('(b) the release\'s connect held across the latch: the did-not-apply line once, and no release statement reaches the store', async () => {
    const { ready, claims } = await retiring();
    store.connectMode = 'hang';
    await vi.advanceTimersByTimeAsync(RENEW_MS);
    await vi.waitFor(() => expect(lines().filter(l => l === TOKEN_LINE)).toHaveLength(1));
    claims.stopServingForDatabase(DB_WHY);
    store.connectMode = 'ok';
    for (let i = 0; i < 5; i++) {
      store.releaseConnects();
      await vi.advanceTimersByTimeAsync(0);
    }
    const ctx = await ready;
    const line = `[Shards] The release did not apply: this process stopped writing to its database before the release sent its COMMIT (${DB_WHY}); any shard row still naming this process frees once its claim expires`;
    expect(lines().filter(l => l === line)).toHaveLength(1);
    expect(store.releases).toEqual([]);
    expect(ctx.shardCount).toBe(0);
  });
});
