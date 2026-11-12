import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemClaimStore } from '../helpers/fakeClaimStore';

// shardBoot.ts with its modules mocked and fake timers, on the harnesses of nb9ServeVerdict.test.ts (a promoted
// standby's serve) and nb5StepBoot.test.ts (the boot's first renewal): the step layers it hands the data layer, the
// end of the boot when the first renewal gives up, and the standby's redraw, record, Running line and keptSessions.

const h = vi.hoisted(() => ({
  gateway: { info: { recommendedShards: 2, sessionStartLimit: null } as any, error: null as string | null },
  dataState: 'serving' as string,
  stopping: false,
  backend: null as any,
  leaves: [] as string[],
  records: [] as any[],
  recordThrows: false,
  readRecord: null as any,
  plans: [] as Array<{ shards: number[]; shardCount: number }>,
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
vi.mock('../../src/bot/internalSetup/ingest/ingestService', () => {
  const fake = {
    setShardPlan: (shards: number[], shardCount: number) => { h.plans.push({ shards: [...shards], shardCount }); },
    isStarted: () => false, start: vi.fn(async () => 'ok'), stop: vi.fn(async () => undefined), getClient: () => null,
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
    resaveGuilds: () => [], heldGuilds: () => [], writesSettled: () => true, landedFlushes: () => 0, flushOnTheWire: () => false,
    flushAllDirty: async () => undefined, dirtyGuildIds: () => [], unansweredGuilds: () => ({ all: [], only: [] }), takeDropLines: () => [],
    replaceShardClaim: () => undefined, guildsOfShard: () => [],
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
vi.mock('../../src/utils/envLoader', async orig => ({
  ...(await orig<any>()),
  resolveDataBackend: () => 'postgres',
}));

const RENEW_MS = 5000;
const DB_WHY = 'db1:5432/bot was replaced by node-b (generation 4)';
const STOPPED_LINE = `[Shards] This bot process stopped writing to its database while it was taking shards (${DB_WHY}), so it connects no shard to Discord`;
const AT = 'a1b2c3d4-0000-4000-8000-0000000000aa';
let lines: string[] = [];
let store: MemClaimStore;
const savedToken = process.env.DISCORD_TOKEN;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  vi.resetModules();
  Object.assign(h, {
    gateway: { info: { recommendedShards: 2, sessionStartLimit: null }, error: null }, dataState: 'serving', stopping: false,
    backend: null, leaves: [], records: [], recordThrows: false, readRecord: null, plans: [],
  });
  delete process.env.FLEET_SHARD_CAPACITY;
  delete process.env.FLEET_TAKEOVER_SECONDS;
  delete process.env.FLEET_SHARD_COUNT;
  process.env.DISCORD_TOKEN = 'test-token';
  lines = [];
  const capture = (...args: unknown[]) => { lines.push(args.map(a => (a instanceof Error ? a.message : String(a))).join(' ')); };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
  store = new MemClaimStore(() => Date.now());
  const fresh = await import('../../src/bot/internalSetup/fleet/claimStore');
  store.pausedError = () => new fresh.ClaimPausedError();
});
afterEach(async () => {
  const { getShardClaims } = await import('../../src/bot/internalSetup/fleet/shardBoot');
  getShardClaims()?.beginStop();
  const claims = getShardClaims() as any;
  if (claims?.renewTimer) clearInterval(claims.renewTimer);
  if (savedToken === undefined) delete process.env.DISCORD_TOKEN;
  else process.env.DISCORD_TOKEN = savedToken;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function pgBackend() {
  const { PostgresBackend } = await import('../../src/bot/internalSetup/utils/dataBackends/postgresBackend');
  h.backend = Object.assign(Object.create(PostgresBackend.prototype), {
    connectionState: () => ({ state: 'serving' }), latchReason: () => null, chosenEntry: () => 'postgres://a', noteLapse: () => undefined,
    notifyLoginRefused: () => undefined, onDatabaseChanged: () => undefined,
  });
}

/** The standby's rows of `count` as its take wrote them, the attempt 'done'; taken as standbyBoot builds it. */
async function promoted(opts: { count?: number; pairs?: number[]; grantMs?: number } = {}) {
  const { processId } = await import('../../src/bot/internalSetup/fleet/processId');
  const { LeaseRuntime } = await import('../../src/bot/internalSetup/fleet/leaseRuntime');
  const pid = processId();
  const count = opts.count ?? 2;
  const ids = opts.pairs ?? [0, 1];
  store.count = count;
  store.reshard = { attempt: AT, state: 'done', fromCount: 1, toCount: count };
  for (const s of ids) {
    store.rows.set(`${count}:${s}`, {
      shardCount: count, shardId: s, claim: 70 + s, holderProcess: pid, holderNode: 'node-a', holderName: 'A', homeNode: 'node-a',
      released: false, reserved: false, takenAt: 0, renewedAt: 0, ttlMs: 30_000, expiresUpMs: 1_000_000, extended: false,
    } as any);
  }
  const grants: any[] = [];
  const runtime = new LeaseRuntime({ setShardPlan: () => undefined, isStarted: () => false, start: async () => 'ok', stop: async () => undefined, getClient: () => null } as any);
  runtime.applyGrant = (async (grant: any) => {
    grants.push(grant);
    if (opts.grantMs) vi.setSystemTime(Date.now() + opts.grantMs);
  }) as any;
  const taken = {
    count, processId: pid, pairs: ids.map(s => ({ shardCount: count, shardId: s, claim: 70 + s })), runtime,
    stopLanes: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    onServing: vi.fn(),
  };
  const mod = await import('../../src/bot/internalSetup/fleet/shardBoot');
  mod._setClaimStoreFactory(() => store);
  return { mod, taken, grants, pid };
}

function serve(p: Awaited<ReturnType<typeof promoted>>) {
  let ctx: any = null;
  let settled = false;
  void p.mod.bootShards({ taken: p.taken }).then(c => { ctx = c; settled = true; }, () => { settled = true; });
  return { ctx: () => ctx, settled: () => settled };
}

/** Wraps the store's redraw; `after` sees and may change a 'done' answer before the claims get it. */
function onRedrawDone(after: (pairs: any[]) => any[] | void) {
  const redraw = store.redraw.bind(store);
  store.redraw = async (...args: Parameters<MemClaimStore['redraw']>) => {
    const answer = await redraw(...args);
    if (answer.kind === 'done') answer.pairs = after(answer.pairs) ?? answer.pairs;
    return answer;
  };
}

describe('the step layers a Postgres boot hands the data layer', () => {
  async function layers() {
    await pgBackend();
    const p = await promoted();
    await p.mod.bootShards({ taken: p.taken });
    const { stepLayers } = await import('../../src/bot/internalSetup/utils/dataBackends/mainDatabase');
    return { p, stepLayers };
  }

  it('holdsShard answers true only for a pair this process holds, by shard id and count together', async () => {
    const { p, stepLayers } = await layers();
    expect(p.mod.getShardClaims()!.heldPairs().map(x => [x.shardId, x.shardCount])).toEqual([[0, 2], [1, 2]]);
    expect(stepLayers.holdsShard(0, 2)).toBe(true);
    expect(stepLayers.holdsShard(1, 2)).toBe(true);
    expect(stepLayers.holdsShard(5, 2)).toBe(false);
    expect(stepLayers.holdsShard(0, 3)).toBe(false);
    expect(stepLayers.holdsShard(5, 3)).toBe(false);
  });

  it('attemptEnded pauses the claims lanes: the store is paused and no renewal reaches it after', async () => {
    const { stepLayers } = await layers();
    await vi.advanceTimersByTimeAsync(RENEW_MS);
    expect(store.renewals.length).toBeGreaterThan(0);
    expect(store.paused).toBe(false);
    stepLayers.attemptEnded();
    const sent = store.renewals.length;
    await vi.advanceTimersByTimeAsync(3 * RENEW_MS);
    expect(store.paused).toBe(true);
    expect(store.renewals.length).toBe(sent);
  });
});

describe('the boot when the first renewal gives up', () => {
  async function failingFirstRenewal() {
    store.renewMode = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5432'), { code: 'ECONNREFUSED' });
    const mod = await import('../../src/bot/internalSetup/fleet/shardBoot');
    mod._setClaimStoreFactory(() => store);
    let ctx: any = null;
    let settled = false;
    void mod.bootShards().then(c => { ctx = c; settled = true; }, () => { settled = true; });
    await vi.waitFor(() => expect(mod.getShardClaims()).not.toBeNull());
    await vi.waitFor(() => expect(lines.some(l => l.startsWith('[Shards] Cannot take shards yet: the claim renewal failed'))).toBe(true));
    return { mod, claims: mod.getShardClaims()!, ctx: () => ctx, settled: () => settled };
  }

  it('a latch: no shard, and the shard record with its kept-at-stop list is left as it was', async () => {
    h.readRecord = { shardCount: 2, shardIds: [0, 1], processId: 'p-old', at: '2026-11-01T00:00:00.000Z', keptAtStop: [0] };
    const b = await failingFirstRenewal();
    b.claims.stopServingForDatabase(DB_WHY);
    store.renewMode = 'ok';
    await vi.advanceTimersByTimeAsync(RENEW_MS);
    expect(b.settled()).toBe(true);
    expect(b.ctx().shardCount).toBe(0);
    expect(lines.filter(l => l === STOPPED_LINE)).toHaveLength(1);
    expect(h.records).toEqual([]);
    expect(store.takes).toEqual([]);
  });

  it('a stop and a latch together: the boot never resolves and logs no latch line', async () => {
    const b = await failingFirstRenewal();
    h.stopping = true;
    b.claims.stopServingForDatabase(DB_WHY);
    store.renewMode = 'ok';
    await vi.advanceTimersByTimeAsync(3 * RENEW_MS);
    expect(b.settled()).toBe(false);
    expect(lines.some(l => l === STOPPED_LINE)).toBe(false);
  });
});

describe("a promoted standby's redraw and grant", () => {
  it('a latch at the redraw\'s answer: no shard, the latch line once, and the boot resolves', async () => {
    const p = await promoted();
    onRedrawDone(() => { queueMicrotask(() => p.mod.getShardClaims()!.stopServingForDatabase(DB_WHY)); });
    const s = serve(p);
    await vi.advanceTimersByTimeAsync(RENEW_MS);
    expect(s.settled()).toBe(true);
    expect(s.ctx().shardCount).toBe(0);
    expect(lines.filter(l => l === STOPPED_LINE)).toHaveLength(1);
    expect(p.grants).toEqual([{ processId: null, shardCount: 0, leases: [] }]);
    expect(lines.some(l => l.startsWith('[Shards] Running'))).toBe(false);
  });

  it('writes the shard record of the served set', async () => {
    const p = await promoted();
    await p.mod.bootShards({ taken: p.taken });
    expect(h.records).toEqual([{ shardCount: 2, shardIds: [0, 1], processId: p.pid, at: new Date().toISOString() }]);
  });

  it('a record write that fails: the could-not-write line with its cause, and the shards still run', async () => {
    h.recordThrows = true;
    const p = await promoted();
    const ctx = await p.mod.bootShards({ taken: p.taken });
    expect(lines).toContain('[Shards] Could not write the shard record: EACCES: permission denied');
    expect(lines).toContain('[Shards] Running 2 of 2 shard(s) in this process: 0, 1 (after the reshard)');
    expect(ctx.shardCount).toBe(2);
  });

  it('the Running line lists the shards in ascending order when the redraw answers them in another', async () => {
    const p = await promoted();
    onRedrawDone(pairs => [...pairs].reverse());
    await p.mod.bootShards({ taken: p.taken });
    expect(p.mod.getShardClaims()!.heldPairs().map(x => x.shardId)).toEqual([1, 0]);
    expect(lines).toContain('[Shards] Running 2 of 2 shard(s) in this process: 0, 1 (after the reshard)');
  });

  it("the fleet state's recommendation time is the ledger's seed from the boot's /gateway/bot read", async () => {
    const p = await promoted({ grantMs: 7000 });
    const before = Date.now();
    await p.mod.bootShards({ taken: p.taken });
    expect(Date.now()).toBe(before + 7000);
    const { getFleetState } = await import('../../src/bot/internalSetup/fleet/state');
    const state = getFleetState();
    expect(state.recommendedShards).toBe(2);
    expect(state.recommendedAt).toBe(before);
  });
});

describe("keptSessions: true only when the grant is exactly the standby's set and count", () => {
  it('the same set: keptSessions true', async () => {
    const p = await promoted();
    const ctx = await p.mod.bootShards({ taken: p.taken });
    expect(ctx.keptSessions).toBe(true);
  });

  it('a standby with no pairs: keptSessions unset', async () => {
    const p = await promoted({ pairs: [] });
    const ctx = await p.mod.bootShards({ taken: p.taken });
    expect(p.grants.at(-1)).toMatchObject({ processId: p.pid, shardCount: 2, leases: [] });
    expect(ctx.shardCount).toBe(2);
    expect(ctx.keptSessions).toBeUndefined();
  });

  it('the redraw returns another shard in place of one of the set: keptSessions unset', async () => {
    const p = await promoted({ count: 3 });
    onRedrawDone(pairs => pairs.map(x => (x.shardId === 1 ? { ...x, shardId: 2 } : x)));
    const ctx = await p.mod.bootShards({ taken: p.taken });
    expect(p.grants.at(-1).leases.map((l: any) => l.shardId)).toEqual([0, 2]);
    expect(ctx.keptSessions).toBeUndefined();
  });

  it('a redraw answered after the deadline whose renewal drops a pair: one shard granted, nothing lost, keptSessions unset', async () => {
    const p = await promoted();
    store.takeMode = 'hang';
    onRedrawDone(() => { store.rows.get('2:1')!.released = true; });
    const s = serve(p);
    await vi.waitFor(() => expect(store.redraws).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(25_000);
    store.releaseHung();
    await vi.advanceTimersByTimeAsync(RENEW_MS);
    expect(s.settled()).toBe(true);
    expect(p.grants.at(-1).leases.map((l: any) => l.shardId)).toEqual([0]);
    expect(h.leaves).toEqual([]);
    expect(s.ctx().keptSessions).toBeUndefined();
  });
});
