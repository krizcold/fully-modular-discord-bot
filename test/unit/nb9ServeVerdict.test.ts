import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemClaimStore } from '../helpers/fakeClaimStore';

// NB9 test 26 (C5, D1, D2, D4, E1): bootShards({ taken }) of a promoted standby, shardBoot.ts with its modules mocked
// and fake timers. The store holds the standby's rows of W as its take wrote them (holder = this process's id, meta W,
// the attempt 'done'); taken carries the standby's runtime, its lanes' stop and its release, each recorded.

const h = vi.hoisted(() => ({
  gateway: { info: { recommendedShards: 2, sessionStartLimit: null } as any, error: null as string | null },
  dataState: 'serving' as string,
  stopping: false,
  backend: null as any,
  kind: 'postgres' as 'postgres' | 'file',
  runtimes: 0,
  leaves: [] as string[],
  factoryCalls: 0,
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
  const fake = { setShardPlan: () => undefined, isStarted: () => false, start: vi.fn(async () => 'ok'), stop: vi.fn(async () => undefined), getClient: () => null };
  return { getIngestService: () => fake };
});
vi.mock('../../src/bot/internalSetup/fleet/leaseRuntime', async orig => {
  const actual = await orig<any>();
  class CountedRuntime extends actual.LeaseRuntime {
    constructor(...args: any[]) { super(...args); h.runtimes += 1; }
  }
  return { ...actual, LeaseRuntime: CountedRuntime };
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
  startLeave: (reason: string) => { h.leaves.push(reason); },
}));
vi.mock('../../src/bot/internalSetup/fleet/shardRecord', async orig => ({
  ...(await orig<any>()),
  writeShardRecord: () => undefined,
  readShardRecord: () => null,
}));
vi.mock('../../src/utils/envLoader', async orig => ({
  ...(await orig<any>()),
  resolveDataBackend: () => h.kind,
}));

const AT = 'a1b2c3d4-0000-4000-8000-0000000000aa';
let lines: string[] = [];
let sent: any[] = [];
let store: MemClaimStore;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  vi.resetModules();
  Object.assign(h, {
    gateway: { info: { recommendedShards: 2, sessionStartLimit: null }, error: null }, dataState: 'serving', stopping: false,
    backend: null, kind: 'postgres', runtimes: 0, leaves: [], factoryCalls: 0,
  });
  lines = [];
  sent = [];
  const capture = (...args: unknown[]) => { lines.push(args.map(a => (a instanceof Error ? a.message : String(a))).join(' ')); };
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
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The standby's rows of count 2 as its take wrote them, meta 2, the attempt 'done'; taken as standbyBoot builds it. */
async function promoted(opts: { pairs?: number[] } = {}) {
  const { processId } = await import('../../src/bot/internalSetup/fleet/processId');
  const { LeaseRuntime } = await import('../../src/bot/internalSetup/fleet/leaseRuntime');
  const m = await import('../../src/bot/internalSetup/utils/maintenance');
  m._setMaintenanceSender(message => { sent.push(message); });
  const pid = processId();
  store.count = 2;
  store.reshard = { attempt: AT, state: 'done', fromCount: 1, toCount: 2 };
  const ids = opts.pairs ?? [0, 1];
  for (const s of ids) {
    store.rows.set(`2:${s}`, {
      shardCount: 2, shardId: s, claim: 70 + s, holderProcess: pid, holderNode: 'node-a', holderName: 'A', homeNode: 'node-a',
      released: false, reserved: false, takenAt: 0, renewedAt: 0, ttlMs: 30_000, expiresUpMs: 1_000_000, extended: false,
    } as any);
  }
  const grants: any[] = [];
  const runtime = new LeaseRuntime({ setShardPlan: () => undefined, isStarted: () => false, start: async () => 'ok', stop: async () => undefined, getClient: () => null } as any);
  runtime.applyGrant = (async (grant: any) => { grants.push(grant); }) as any;
  const constructed = h.runtimes;
  const events: string[] = [];
  const taken = {
    count: 2, processId: pid, pairs: ids.map(s => ({ shardCount: 2, shardId: s, claim: 70 + s })), runtime,
    stopLanes: vi.fn(async () => { events.push('stopLanes'); }),
    release: vi.fn(async () => { events.push('release'); lines.push('(the release ran)'); }),
    onServing: vi.fn(() => { events.push('serving'); }),
  };
  const mod = await import('../../src/bot/internalSetup/fleet/shardBoot');
  mod._setClaimStoreFactory(() => { h.factoryCalls += 1; return store; });
  return { mod, taken, grants, events, pid, runtimesBefore: constructed };
}

describe("test 26: a promoted standby's serve (C5, D1, D2, D4, E1)", () => {
  it("'serving': stopLanes after the verdict, no new LeaseRuntime, the grant on taken.runtime with the standby's set, keptSessions true", async () => {
    h.dataState = 'starting';
    const p = await promoted();
    let ctx: any = null;
    void p.mod.bootShards({ taken: p.taken }).then(c => { ctx = c; });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(p.taken.stopLanes).not.toHaveBeenCalled();
    expect(h.factoryCalls).toBe(0);
    h.dataState = 'serving';
    await vi.advanceTimersByTimeAsync(2_000);
    expect(p.events.slice(0, 2)).toEqual(['stopLanes', 'serving']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ctx).not.toBeNull();
    expect(h.runtimes).toBe(p.runtimesBefore);
    expect(p.grants.at(-1)).toMatchObject({ processId: p.pid, shardCount: 2 });
    expect(p.grants.at(-1).leases.map((l: any) => l.shardId)).toEqual([0, 1]);
    expect(ctx.keptSessions).toBe(true);
    expect(store.redraws).toHaveLength(1);
    expect(lines).toContain('[Shards] Running 2 of 2 shard(s) in this process: 0, 1 (after the reshard)');
    expect(p.taken.release).not.toHaveBeenCalled();
  });

  it("one pair not returned: keptSessions unset and NB4's loss step for that pair after the grant", async () => {
    const p = await promoted();
    store.rows.get('2:1')!.released = true;
    const ctx = await p.mod.bootShards({ taken: p.taken });
    expect(ctx.keptSessions).toBeUndefined();
    expect(p.grants.at(-1).leases.map((l: any) => l.shardId)).toEqual([0]);
    expect(h.leaves).toEqual(['Shard 1 is no longer held by this process']);
  });

  it.each([
    ["'refused'", () => { h.dataState = 'refused'; }, '[Shards] The data layer refused this database, so this bot process connects no shard to Discord'],
    ['HTTP 401', () => { h.gateway = { info: null, error: 'HTTP 401' }; }, '[Shards] Discord refused the bot token (HTTP 401); no shard is taken until the token is fixed and the bot restarts'],
  ])('%s: the release, then the landed line, no shards on taken.runtime, keptSessions unset, no restart ask', async (_name, set, line) => {
    set();
    const p = await promoted();
    const ctx = await p.mod.bootShards({ taken: p.taken });
    expect(lines.indexOf('(the release ran)')).toBeLessThan(lines.indexOf(line));
    expect(lines.indexOf('(the release ran)')).toBeGreaterThanOrEqual(0);
    expect(ctx.shardCount).toBe(0);
    expect(ctx.keptSessions).toBeUndefined();
    expect(p.grants).toEqual([{ processId: null, shardCount: 0, leases: [] }]);
    expect(p.taken.stopLanes).not.toHaveBeenCalled();
    expect(h.factoryCalls).toBe(0);
    expect(sent.some(m => m.type === 'control:restart-bot')).toBe(false);
  });

  it('a latch: the release, the landed line, no shards', async () => {
    h.backend = Object.assign(Object.create((await import('../../src/bot/internalSetup/utils/dataBackends/postgresBackend')).PostgresBackend.prototype), {
      connectionState: () => ({ state: 'latched' }), latchReason: () => 'the main moved',
    });
    const p = await promoted();
    const ctx = await p.mod.bootShards({ taken: p.taken });
    expect(p.taken.release).toHaveBeenCalledTimes(1);
    expect(lines).toContain('[Shards] This bot process stopped writing to its database before it took shards (the main moved), so it connects no shard to Discord');
    expect(ctx.shardCount).toBe(0);
    expect(h.factoryCalls).toBe(0);
  });

  it("'starting' for 300 s: L33, then the release, then the restart ask with D4's reason; bootShards stays pending 600 s more", async () => {
    h.dataState = 'starting';
    const p = await promoted();
    let resolved = false;
    void p.mod.bootShards({ taken: p.taken }).then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(299_000);
    expect(p.taken.release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    const l33 = lines.indexOf('[Shards] The database was not verified 300 s after this process was promoted to run the new shards; releasing them now');
    expect(l33).toBeGreaterThanOrEqual(0);
    expect(lines.indexOf('(the release ran)')).toBeGreaterThan(l33);
    expect(lines).toContain('[Maintenance] The database was not verified 300 s after this process was promoted to run the new shards; asking the web UI process to restart the bot process');
    expect(lines.indexOf('[Maintenance] The database was not verified 300 s after this process was promoted to run the new shards; asking the web UI process to restart the bot process')).toBeGreaterThan(lines.indexOf('(the release ran)'));
    expect(sent.filter(m => m.type === 'control:restart-bot')).toEqual([{ type: 'control:restart-bot', data: { reason: 'The database was not verified 300 s after this process was promoted to run the new shards' } }]);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(resolved).toBe(false);
    expect(p.taken.stopLanes).not.toHaveBeenCalled();
    expect(h.factoryCalls).toBe(0);
  });

  it('D2: a stop during the verdict wait, then serving: no store, no stopLanes, bootShards pending', async () => {
    h.dataState = 'starting';
    const p = await promoted();
    let resolved = false;
    void p.mod.bootShards({ taken: p.taken }).then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(3_000);
    h.stopping = true;
    h.dataState = 'serving';
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.factoryCalls).toBe(0);
    expect(p.taken.stopLanes).not.toHaveBeenCalled();
    expect(p.taken.release).not.toHaveBeenCalled();
    expect(resolved).toBe(false);
  });

  it("E1: a stop that begins while stopLanes runs after 'serving': no serve lanes, no phase switch, bootShards pending", async () => {
    const p = await promoted();
    p.taken.stopLanes.mockImplementation(async () => { p.events.push('stopLanes'); h.stopping = true; });
    let resolved = false;
    void p.mod.bootShards({ taken: p.taken }).then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(p.events).toEqual(['stopLanes']);
    expect(p.taken.onServing).not.toHaveBeenCalled();
    expect(h.factoryCalls).toBe(0);
    expect(resolved).toBe(false);
  });

  it("C10 (code review 1, B3): onServing gets a reserve on the serve store, and after the store's retarget it reserves on the new pool", async () => {
    let changed: ((next: string) => void) | null = null;
    h.backend = Object.assign(Object.create((await import('../../src/bot/internalSetup/utils/dataBackends/postgresBackend')).PostgresBackend.prototype), {
      connectionState: () => ({ state: 'serving' }), latchReason: () => null, chosenEntry: () => 'postgres://a', noteLapse: () => undefined,
      notifyLoginRefused: () => undefined, onDatabaseChanged: (listener: (next: string) => void) => { changed = listener; },
    });
    const p = await promoted();
    let pool = 'postgres://a';
    const reserved: Array<[string, number, string]> = [];
    (store as any).reserveIdentifySlot = async (bucket: number, holder: string) => { reserved.push([pool, bucket, holder]); return { granted: true }; };
    (store as any).retarget = (next: string) => { pool = next; };
    await p.mod.bootShards({ taken: p.taken });
    const reserve = (p.taken.onServing.mock.calls[0] as unknown[])[0] as (bucket: number, holder: string) => Promise<unknown>;
    expect(typeof reserve).toBe('function');
    await expect(reserve(1, p.pid)).resolves.toEqual({ granted: true });
    changed!('postgres://b');
    await reserve(0, p.pid);
    expect(reserved).toEqual([['postgres://a', 1, p.pid], ['postgres://b', 0, p.pid]]);
  });

  it('a JSON taken: count W on taken.runtime, every shard, no new runtime, keptSessions true', async () => {
    h.kind = 'file';
    const p = await promoted();
    const ctx = await p.mod.bootShards({ taken: { json: true, count: 3, runtime: p.taken.runtime } });
    expect(ctx.shardCount).toBe(3);
    expect(ctx.keptSessions).toBe(true);
    expect(h.runtimes).toBe(p.runtimesBefore);
    expect(p.grants.at(-1).leases.map((l: any) => l.shardId)).toEqual([0, 1, 2]);
  });

  it("15 (code review 1, B4): after a JSON promotion the 30 s timer runs, and the Usage fields show the finished reshard's 'done'", async () => {
    h.kind = 'file';
    const p = await promoted();
    await p.mod.bootShards({ taken: { json: true, count: 3, from: 1, runtime: p.taken.runtime } });
    const json = p.mod.getJsonReshard();
    expect(json).not.toBeNull();
    const ticks = vi.spyOn(json!, 'tick');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ticks).toHaveBeenCalledTimes(1);
    expect(json!.fields()).toEqual({ reshard: null, lastReshard: { from: 1, to: 3, method: 'overlap', state: 'done', endedAt: expect.any(Number), reason: null } });
  });
});

// NB9 test 3, D11: O8 C6, the data layer chose another entry whose copy of the standby's rows expired.
describe('test 3, O8 C6 (D11): the redraw on the chosen entry returns none', () => {
  it("NB4's loss for every pair, the leave naming them, keptSessions unset", async () => {
    const p = await promoted();
    // Entry B: the rows came over in the copy, and B's clock moved past their expiry.
    for (const row of store.rows.values()) row.expiresUpMs = store.clock.upMs - 1;
    const ctx = await p.mod.bootShards({ taken: p.taken });
    expect(store.redraws).toHaveLength(1);
    expect(ctx.keptSessions).toBeUndefined();
    expect(p.grants.at(-1).leases).toEqual([]);
    expect(h.leaves).toEqual(['Shard 0, 1 are no longer held by this process']);
  });
});
