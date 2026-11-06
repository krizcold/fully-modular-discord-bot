import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemClaimStore } from '../helpers/fakeClaimStore';
import { stopSteps } from '../helpers/stopRig';

// NB4 decisions 6, 7, 10, 13, 14, 16 and 22: the Postgres boot over a fake claims store. The take waits for the first
// completed renewal; a take acknowledged after D is renewed before the grant; a predecessor's rows are waited for with
// one true line; the boot's lines, the shard record and the Client's shard set; the boot's own fitness function; a loss
// rewrites the record and starts the leave in one step. The record (shards.json) is written at the grant, at a loss and
// at a completed release (keptAtStop), and the boot take reads it and rewrites it without keptAtStop before its grant.

const h = vi.hoisted(() => ({
  gateway: { info: { recommendedShards: 4, sessionStartLimit: null } as any, error: null as string | null },
  gatewayCalls: 0,
  plans: [] as Array<{ shards: number[]; shardCount: number }>,
  starts: 0,
  dataState: 'serving' as string,
  health: 'healthy',
  stopping: false,
  maint: null as string | null,
  held: [] as Array<{ guildId: string; reason: string | null }>,
  canRestart: true,
  restarts: [] as string[],
  leaves: [] as string[],
  lapses: [] as number[],
  records: [] as any[],
  recordThrows: false,
  backend: null as any,
  kind: 'postgres' as 'postgres' | 'file',
  realReadiness: false,
  actualReadiness: null as any,
  realRecord: false,
  ingestStarted: false,
  stopHangs: false,
  stopAt: [] as number[],
  skew: { perf: 0, wall: 0 },
}));

vi.mock('../../src/bot/internalSetup/fleet/placement', async orig => ({
  ...(await orig<any>()),
  fetchGatewayInfoResult: vi.fn(async () => { h.gatewayCalls += 1; return h.gateway; }),
}));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/dataReadiness', async orig => ({
  ...(h.actualReadiness = await orig<any>()),
  getDataReadiness: () => (h.realReadiness ? h.actualReadiness.getDataReadiness() : { onLeaseChanged: () => undefined }),
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
    setShardPlan: (shards: number[], shardCount: number) => h.plans.push({ shards: [...shards], shardCount }),
    isStarted: () => h.ingestStarted,
    start: vi.fn(async () => { h.starts += 1; return 'ok'; }),
    stop: vi.fn(() => { h.stopAt.push(Date.now()); return h.stopHangs ? new Promise<void>(() => undefined) : Promise.resolve(); }),
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
    heldGuilds: () => h.held, writesSettled: () => true, landedFlushes: () => 0, flushOnTheWire: () => false,
    flushAllDirty: async () => undefined, dirtyGuildIds: () => [], unansweredGuilds: () => ({ all: [], only: [] }), takeDropLines: () => [],
  }),
}));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<any>()),
  getBackendHealth: () => ({ state: h.health, oldestDirtyMs: 0, dirtyBytes: 0, lastError: null }),
  getGuildDataBackend: () => h.backend,
  isStopping: () => h.stopping,
}));
vi.mock('../../src/bot/internalSetup/utils/maintenance', async orig => ({
  ...(await orig<any>()),
  maintenanceUnfit: () => h.maint,
  canRestart: () => h.canRestart,
  restartForShards: (reason: string, fitness: () => string | null) => {
    if (fitness() !== null) return false;
    h.restarts.push(reason);
    return true;
  },
  startLeave: (reason: string) => { h.leaves.push(reason); },
  noteClaimsLapsed: (seconds: number) => { h.lapses.push(seconds); },
}));
vi.mock('../../src/bot/internalSetup/fleet/shardRecord', async orig => {
  const actual = await orig<any>();
  return {
    ...actual,
    writeShardRecord: (record: any) => {
      if (h.recordThrows) throw new Error('EACCES: permission denied');
      h.records.push(structuredClone(record));
      if (h.realRecord) actual.writeShardRecord(record);
    },
  };
});
vi.mock('../../src/utils/envLoader', async orig => ({
  ...(await orig<any>()),
  resolveDataBackend: () => h.kind,
}));

const T = { renewMs: 5000, deadlineMs: 20_000, ttlMs: 30_000 };
let lines: string[] = [];
let store: MemClaimStore;
let onRefused: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  vi.resetModules();
  Object.assign(h, {
    kind: 'postgres',
    gateway: { info: { recommendedShards: 4, sessionStartLimit: null }, error: null }, gatewayCalls: 0, plans: [], starts: 0,
    dataState: 'serving', health: 'healthy', stopping: false, maint: null, held: [], canRestart: true, restarts: [],
    leaves: [], lapses: [], records: [], recordThrows: false, backend: null, realReadiness: false, realRecord: false,
    ingestStarted: false, stopHangs: false, stopAt: [], skew: { perf: 0, wall: 0 },
  });
  delete process.env.FLEET_SHARD_CAPACITY;
  delete process.env.FLEET_TAKEOVER_SECONDS;
  lines = [];
  const capture = (...args: unknown[]) => { lines.push(args.map(a => (a instanceof Error ? a.message : String(a))).join(' ')); };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
  store = new MemClaimStore(() => Date.now());
  onRefused = null;
});
afterEach(async () => {
  const { getShardClaims } = await import('../../src/bot/internalSetup/fleet/shardBoot');
  getShardClaims()?.beginStop();
  const claims = getShardClaims() as any;
  if (claims?.renewTimer) clearInterval(claims.renewTimer);
  delete process.env.FLEET_SHARD_CAPACITY;
  delete process.env.FLEET_TAKEOVER_SECONDS;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function boot() {
  const mod = await import('../../src/bot/internalSetup/fleet/shardBoot');
  mod._setClaimStoreFactory((_url, _timings, refused) => { onRefused = refused; return store; });
  return { mod, ready: mod.bootShards() };
}

/** Another machine, fit and seen, holding its own rows or none. */
function otherNode(capacity: number) {
  store.nodes.set('node-x', {
    nodeId: 'node-x', nodeName: 'X', processId: 'p-x', capacity, takeoverSeconds: 30, fit: true, restartable: true, returns: true,
    seenAgoMs: 0, healthyForMs: null, seenAt: Date.now(), healthySince: Date.now(),
  });
}

function seedRow(shardId: number, over: Record<string, unknown>) {
  store.rows.set(`4:${shardId}`, {
    shardCount: 4, shardId, claim: 50 + shardId, holderProcess: 'p-x', holderNode: 'node-x', holderName: 'X', homeNode: 'node-x',
    released: false, reserved: false, takenAt: 0, renewedAt: 0, ttlMs: 30_000, expiresUpMs: 1_000_000, extended: false, ...over,
  } as any);
}

describe('the boot lines, the record and the Client', () => {
  it('with two held: "Running 2 of 4", the record holds the count and both ids when bootShards resolves, and the login runs', async () => {
    const { IdentifyLedger } = await import('../../src/bot/internalSetup/fleet/identifyLedger');
    const charge = vi.spyOn(IdentifyLedger.prototype, 'charge');
    process.env.FLEET_SHARD_CAPACITY = '2';
    otherNode(2);
    const { ready } = await boot();
    const ctx = await ready;
    expect(ctx.shardCount).toBe(4);
    expect(charge.mock.calls).toEqual([[2]]);
    expect(lines.join(String.fromCharCode(10))).toContain('[Shards] Running 2 of 4 shard(s) in this process: 0, 1');
    expect(h.records.at(-1)).toMatchObject({ shardCount: 4, shardIds: [0, 1] });
    expect(h.plans.at(-1)).toEqual({ shards: [0, 1], shardCount: 4 });
    ctx.startIngest('token');
    expect(h.starts).toBe(1);
    expect([...store.rows.values()].filter(r => r.holderNode === 'node-a').map(r => r.shardId).sort()).toEqual([0, 1]);
  });

  it('with none held: the "none" line with its three counts, an empty record and plan, and no login', async () => {
    const { IdentifyLedger } = await import('../../src/bot/internalSetup/fleet/identifyLedger');
    const charge = vi.spyOn(IdentifyLedger.prototype, 'charge');
    for (const id of [0, 1, 2, 3]) seedRow(id, {});
    otherNode(4);
    const { ready } = await boot();
    const ctx = await ready;
    expect(charge.mock.calls).toEqual([[0]]);
    expect(lines.join(String.fromCharCode(10))).toContain('[Shards] Running none of 4 shard(s) (FLEET_SHARD_CAPACITY 1): 4 held by other machines, 0 waiting for their own machine to restart, 0 left to machines with room');
    expect(h.records.at(-1)).toMatchObject({ shardCount: 4, shardIds: [] });
    expect(h.plans.at(-1)).toEqual({ shards: [], shardCount: 4 });
    ctx.startIngest('token');
    expect(h.starts).toBe(0);
  });

  it('with none held, the empty grant settles the real startup barrier at once, with no timer advanced', async () => {
    const { FakeStore } = await import('../helpers/fakeStore');
    const { initWorkingSet } = await import('../../src/bot/internalSetup/utils/dataBackends/workingSet');
    const { initDataReadiness } = await import('../../src/bot/internalSetup/utils/dataBackends/dataReadiness');
    const { awaitDataStartupBarrier } = await import('../../src/bot/internalSetup/utils/dataBackends/boot');
    const data = new FakeStore();
    const driver = initDataReadiness(data, initWorkingSet(data), { held: true });
    driver.release();
    h.realReadiness = true;
    for (const id of [0, 1, 2, 3]) seedRow(id, {});
    otherNode(4);
    let settled = false;
    const barrier = awaitDataStartupBarrier().then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    const { ready } = await boot();
    const now = Date.now();
    await ready;
    expect(h.plans.at(-1)).toEqual({ shards: [], shardCount: 4 });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(true);
    await barrier;
    expect(Date.now()).toBe(now);
    let late = false;
    void awaitDataStartupBarrier().then(() => { late = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(late).toBe(true);
    expect(lines.some(l => l.startsWith('[Data] Startup barrier timed out'))).toBe(false);
    driver.stop();
  });

  it('a JSON boot holds every shard, takes no claim and never touches the claims store', async () => {
    h.kind = 'file';
    const { ready } = await boot();
    await ready;
    expect(lines.join(String.fromCharCode(10))).toContain('[Shards] Running all 4 shard(s) in this process');
    expect(store.renewals).toEqual([]);
    expect(store.takes).toEqual([]);
  });

  it('a refused data layer logs its line, never touches the store and logs in nothing', async () => {
    h.dataState = 'refused';
    const { ready } = await boot();
    const ctx = await ready;
    expect(lines.join(String.fromCharCode(10))).toContain('[Shards] The data layer refused this database, so this bot process connects no shard to Discord');
    expect(store.renewals).toEqual([]);
    ctx.startIngest('token');
    expect(h.starts).toBe(0);
  });

  it('a refused JSON data layer still logs in every shard: no refused line, no claim, and the gateway starts', async () => {
    h.kind = 'file';
    h.dataState = 'refused';
    const { ready } = await boot();
    const ctx = await ready;
    const text = lines.join(String.fromCharCode(10));
    expect(text).toContain('[Shards] Running all 4 shard(s) in this process');
    expect(text).not.toContain('[Shards] The data layer refused this database');
    expect(h.plans.at(-1)).toEqual({ shards: [0, 1, 2, 3], shardCount: 4 });
    ctx.startIngest('token');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.starts).toBe(1);
    expect(store.renewals).toEqual([]);
    expect(store.takes).toEqual([]);
  });

  it('/gateway/bot answering 401 logs the token line once and takes nothing', async () => {
    h.gateway = { info: null, error: 'HTTP 401' };
    const { ready } = await boot();
    const ctx = await ready;
    expect(lines.filter(l => l === '[Shards] Discord refused the bot token (HTTP 401); no shard is taken until the token is fixed and the bot restarts')).toHaveLength(1);
    expect(store.takes).toEqual([]);
    ctx.startIngest('token');
    expect(h.starts).toBe(0);
  });
});

describe('the boot take', () => {
  it('starts only after the first renewal completed; a failing renewal is logged at its first failure and 30 s later, not every try', async () => {
    store.renewMode = new Error('connect ECONNREFUSED');
    const { ready } = await boot();
    const failLine = `[Shards] Cannot take shards yet: the claim renewal failed (unreachable); retrying every ${T.renewMs / 1000} s`;
    await vi.advanceTimersByTimeAsync(0);
    expect(lines.filter(l => l === failLine)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(store.takes).toEqual([]);
    expect(store.renewals.length).toBeGreaterThanOrEqual(5);
    expect(lines.filter(l => l === failLine)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(lines.filter(l => l === failLine)).toHaveLength(2);
    store.renewMode = 'ok';
    await vi.advanceTimersByTimeAsync(T.renewMs);
    await ready;
    expect(store.takes.length).toBeGreaterThanOrEqual(1);
  });

  it('a failing take is logged at its first failure and again 30 s later', async () => {
    store.takeMode = new Error('Query read timeout');
    const { ready } = await boot();
    const failLine = `[Shards] Cannot take shards yet: the take failed (timeout); retrying every ${T.renewMs / 1000} s`;
    await vi.advanceTimersByTimeAsync(0);
    expect(lines.filter(l => l === failLine)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(lines.filter(l => l === failLine)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(lines.filter(l => l === failLine)).toHaveLength(2);
    store.takeMode = 'ok';
    await vi.advanceTimersByTimeAsync(T.renewMs);
    await ready;
  });

  it('a take acknowledged after D is renewed before the grant, and a pair that renewal misses is not granted', async () => {
    process.env.FLEET_SHARD_CAPACITY = '2';
    otherNode(2);
    store.bounds = { renewMs: T.renewMs, workMs: 2 * T.renewMs };
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
    const { ready } = await boot();
    vi.doUnmock('../../src/bot/internalSetup/fleet/shardClaims');
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.takes).toHaveLength(1);
    h.skew.perf += T.deadlineMs + 1000;
    h.skew.wall += T.deadlineMs + 1000;
    store.renewMode = 'hang';
    store.takeMode = 'ok';
    store.releaseHung();
    await vi.advanceTimersByTimeAsync(0);
    store.renewMode = 'ok';
    const row = store.rows.get('4:1')!;
    Object.assign(row, { holderProcess: 'p-other' });
    store.releaseHung();
    await vi.advanceTimersByTimeAsync(0);
    const ctx = await ready;
    const grant = h.plans.at(-1)!;
    expect(grant.shards).toEqual([0]);
    expect(store.renewals.some(r => r.pairs.map(p => p.shardId).join() === '0,1')).toBe(true);
    expect(lines.join(String.fromCharCode(10))).toContain('[Shards] Running 1 of 4 shard(s) in this process: 0');
    expect(h.records.at(-1)).toMatchObject({ shardIds: [0] });
    expect(ctx.shardCount).toBe(4);
  });

  it('waits for its predecessor\'s rows with one wait line during the countdown, then takes them at expiry', async () => {
    seedRow(0, { holderProcess: 'p-old', holderNode: 'node-a', holderName: 'A', homeNode: 'node-a', expiresUpMs: 20_000, renewedAt: -100_000 });
    seedRow(1, { holderProcess: 'p-old', holderNode: 'node-a', holderName: 'A', homeNode: 'node-a', expiresUpMs: 20_000, renewedAt: -100_000 });
    process.env.FLEET_SHARD_CAPACITY = '4';
    const { ready } = await boot();
    await vi.advanceTimersByTimeAsync(0);
    const waits = () => lines.filter(l => l.startsWith('[Shards] Shards 0, 1 are still claimed by this machine\'s previous bot process'));
    expect(waits()).toHaveLength(1);
    expect(waits()[0]).toMatch(/taking them in (19|20) s$/);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(waits()).toHaveLength(1);
    expect(store.rows.get('4:0')!.holderProcess).toBe('p-old');
    await vi.advanceTimersByTimeAsync(15_000);
    await ready;
    expect(store.rows.get('4:0')!.holderProcess).not.toBe('p-old');
    expect(lines.some(l => l.startsWith('[Shards] Another bot process with this machine\'s id'))).toBe(false);
  });

  it('the wait line counts from u\': a take read 6 s after the last tick logs the time left once, and the next ticks do not repeat it', async () => {
    seedRow(0, { holderProcess: 'p-old', holderNode: 'node-a', holderName: 'A', homeNode: 'node-a', expiresUpMs: 20_000, renewedAt: -100_000 });
    seedRow(1, { holderProcess: 'p-old', holderNode: 'node-a', holderName: 'A', homeNode: 'node-a', expiresUpMs: 20_000, renewedAt: -100_000 });
    process.env.FLEET_SHARD_CAPACITY = '4';
    store.takeMode = 'hang';
    const { ready } = await boot();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.takes).toHaveLength(1);
    expect(store.clock.upMs).toBe(0);
    await vi.advanceTimersByTimeAsync(4000);
    const tickedAt = store.clock.tickedAt;
    store.dbNow = () => Date.now() + 2000;
    expect(store.dbNow() - tickedAt).toBe(6000);
    store.takeMode = 'ok';
    store.releaseHung();
    await vi.advanceTimersByTimeAsync(0);
    const waits = () => lines.filter(l => l.startsWith('[Shards] Shards 0, 1 are still claimed by this machine\'s previous bot process'));
    expect(waits()).toEqual(['[Shards] Shards 0, 1 are still claimed by this machine\'s previous bot process, which stopped without releasing them; taking them in 14 s']);
    expect(store.clock.upMs).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.clock.upMs).toBe(7000);
    expect(store.clock.lastGapMs).toBe(7000);
    expect(store.rows.get('4:0')!.extended).toBe(false);
    await vi.advanceTimersByTimeAsync(14_000);
    expect(waits()).toHaveLength(1);
    expect(store.rows.get('4:0')!.holderProcess).toBe('p-old');
    await vi.advanceTimersByTimeAsync(10_000);
    await ready;
    expect(store.rows.get('4:0')!.holderProcess).not.toBe('p-old');
    expect(store.rows.get('4:1')!.holderProcess).not.toBe('p-old');
    expect(waits()).toHaveLength(1);
  });

  it('planTake\'s wait is the row\'s expiry less u\', while the expiry test uses the stored clock', async () => {
    const { planTake } = await import('../../src/bot/internalSetup/fleet/claimRules');
    const row = {
      shardCount: 4, shardId: 0, claim: 7, holderProcess: 'p-old', holderNode: 'node-a', holderName: 'A', homeNode: 'node-a',
      released: false, reserved: false, takenAt: 0, renewedAt: 0, ttlMs: 30_000, expiresUpMs: 70_000, extended: false,
    };
    const input = {
      me: { processId: 'p-new', nodeId: 'node-a', nodeName: 'A' }, capacity: 4, boot: true, known: [], shardCount: 1,
      rows: [row], nodes: [], upMs: 50_000, uPrimeMs: 56_000,
    };
    expect(planTake(input).wait).toEqual({ shardIds: [0], remainingMs: 14_000 });
    expect(planTake({ ...input, uPrimeMs: 50_000 }).wait).toEqual({ shardIds: [0], remainingMs: 20_000 });
    expect(planTake({ ...input, uPrimeMs: 75_000 }).wait).toEqual({ shardIds: [0], remainingMs: 0 });
    const expired = planTake({ ...input, upMs: 70_000, uPrimeMs: 70_000 });
    expect(expired.wait).toBeNull();
    expect(expired.takes.map(t => t.shardId)).toEqual([0]);
  });

  it('a tick after a gap above G extends the predecessor\'s rows: the boot logs the new wait, no copied-id line, and takes them at the extended expiry', async () => {
    seedRow(0, { holderProcess: 'p-old', holderNode: 'node-a', holderName: 'A', homeNode: 'node-a', expiresUpMs: 20_000, renewedAt: -100_000 });
    process.env.FLEET_SHARD_CAPACITY = '4';
    const { ready } = await boot();
    await vi.advanceTimersByTimeAsync(0);
    const waits = () => lines.filter(l => l.startsWith('[Shards] Shards 0 are still claimed by this machine\'s previous bot process'));
    expect(waits()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(waits()).toHaveLength(1);
    store.clock.tickedAt -= 60_000;
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(store.rows.get('4:0')!.extended).toBe(true);
    const extendedTo = store.rows.get('4:0')!.expiresUpMs;
    expect(extendedTo).toBeGreaterThan(20_000);
    expect(waits()).toHaveLength(2);
    expect(waits()[1]).toMatch(/taking them in (29|30) s$/);
    expect(lines.some(l => l.startsWith('[Shards] Another bot process with this machine\'s id'))).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(store.rows.get('4:0')!.holderProcess).toBe('p-old');
    await vi.advanceTimersByTimeAsync(15_000);
    await ready;
    expect(store.rows.get('4:0')!.holderProcess).not.toBe('p-old');
    expect(waits()).toHaveLength(2);
  });

  it('a predecessor row renewed after this process\'s first renewal logs the copied-id line; one renewed before it logs none', async () => {
    seedRow(0, { holderProcess: 'p-old', holderNode: 'node-a', holderName: 'A', homeNode: 'node-a', expiresUpMs: 20_000, renewedAt: -100_000 });
    seedRow(1, { holderProcess: 'p-old', holderNode: 'node-a', holderName: 'A', homeNode: 'node-a', expiresUpMs: 20_000, renewedAt: -100_000 });
    process.env.FLEET_SHARD_CAPACITY = '4';
    const { ready } = await boot();
    await vi.advanceTimersByTimeAsync(0);
    const firstRenewal = store.renewals.length > 0 ? Date.now() : 0;
    store.rows.get('4:1')!.renewedAt = firstRenewal - 1;
    await vi.advanceTimersByTimeAsync(T.renewMs);
    const copied = () => lines.filter(l => l.startsWith('[Shards] Another bot process with this machine\'s id (node-a)'));
    expect(copied()).toHaveLength(0);
    store.rows.get('4:0')!.renewedAt = Date.now();
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(copied()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    await ready;
    expect(store.rows.get('4:1')!.holderNode).toBe('node-a');
    expect(store.rows.get('4:1')!.holderProcess).not.toBe('p-old');
  });
});

describe('the boot\'s fitness function (T2, decision 14)', () => {
  async function fitness() {
    process.env.FLEET_SHARD_CAPACITY = '4';
    const { mod, ready } = await boot();
    await ready;
    const claims = mod.getShardClaims() as any;
    return claims.deps.fitness as () => string | null;
  }

  it('is fit with every input as it should be, and names each input flipped alone', async () => {
    const fit = await fitness();
    expect(fit()).toBeNull();
    h.dataState = 'verifying';
    expect(fit()).toBe('the data layer does not serve');
    h.dataState = 'serving';
    h.maint = 'the maintenance gate is closed';
    expect(fit()).toBe('the maintenance gate is closed');
    h.maint = null;
    h.stopping = true;
    expect(fit()).toBe('stopping');
    h.stopping = false;
    h.health = 'degraded';
    expect(fit()).toBe('the data backend is degraded');
    h.health = 'healthy';
    h.held = [{ guildId: '1', reason: null }, { guildId: '2', reason: 'SQLSTATE 53100 could not extend file' }];
    expect(fit()).toBe('a save is failing');
    h.held = [{ guildId: '1', reason: null }];
    expect(fit()).toBeNull();
  });

  it('a held guild whose flush fails keeps the work lane from reserving and asking for a restart', async () => {
    process.env.FLEET_SHARD_CAPACITY = '4';
    seedRow(3, { expiresUpMs: 1_000_000 });
    otherNode(4);
    const { ready } = await boot();
    await ready;
    Object.assign(store.rows.get('4:3')!, { expiresUpMs: 0, holderProcess: 'p-dead', holderNode: 'node-dead' });
    h.held = [{ guildId: '1', reason: 'timeout' }];
    const takes = store.takes.length;
    await vi.advanceTimersByTimeAsync(T.renewMs * 3);
    expect(store.takes.length).toBe(takes);
    expect(h.restarts).toEqual([]);
    expect(store.renewals.at(-1)!.heartbeat.fit).toBe(false);
    h.held = [];
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(store.takes.length).toBe(takes + 1);
    expect(h.restarts).toEqual(['take shard 3']);
  });
});

describe('a refused login on the claims pool (T13)', () => {
  it('the onRefused the boot hands the claims store calls the backend\'s notifyLoginRefused', async () => {
    const { PostgresBackend } = await import('../../src/bot/internalSetup/utils/dataBackends/postgresBackend');
    const notify = vi.fn();
    h.backend = Object.assign(Object.create(PostgresBackend.prototype), {
      notifyLoginRefused: notify,
      chosenEntry: () => 'postgres://bot@db:5432/bot',
      connectionState: () => ({ state: 'ready' }),
      onDatabaseChanged: vi.fn(),
    });
    const { ready } = await boot();
    await ready;
    expect(onRefused).not.toBeNull();
    onRefused!();
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe('a loss after the grant (T13 (d), unit 7)', () => {
  it('rewrites the record without the lost shard and starts the leave in the same step; an unread row gets its line', async () => {
    process.env.FLEET_SHARD_CAPACITY = '2';
    otherNode(2);
    const { ready } = await boot();
    await ready;
    expect(h.records.at(-1)).toMatchObject({ shardIds: [0, 1] });
    Object.assign(store.rows.get('4:1')!, { claim: 999, holderProcess: 'p-x', holderNode: 'node-x' });
    store.readMode = new Error('Query read timeout');
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(h.records.at(-1)).toMatchObject({ shardCount: 4, shardIds: [0] });
    expect(h.leaves).toEqual(['Shard 1 is no longer held by this process']);
    await vi.advanceTimersByTimeAsync(0);
    expect(lines.join(String.fromCharCode(10))).toContain('[Shards] Shard 1 is no longer held by this process; its claim row could not be read (timeout)');
    expect(h.plans.at(-1)).toEqual({ shards: [], shardCount: 4 });
  });

  it('the leave starts in the same step as the loss, while the row read still hangs; two bounded tries later the unread-row line', async () => {
    process.env.FLEET_SHARD_CAPACITY = '2';
    otherNode(2);
    const { ready } = await boot();
    await ready;
    const { ClaimTimeoutError } = await import('../../src/bot/internalSetup/fleet/claimStore');
    store.timeoutError = what => new ClaimTimeoutError(what);
    store.bounds = { renewMs: T.renewMs, workMs: 2 * T.renewMs };
    Object.assign(store.rows.get('4:1')!, { claim: 999, holderProcess: 'p-x', holderNode: 'node-x' });
    store.readMode = 'hang';
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(h.leaves).toEqual(['Shard 1 is no longer held by this process']);
    expect(h.records.at(-1)).toMatchObject({ shardCount: 4, shardIds: [0] });
    expect(h.plans.at(-1)).toEqual({ shards: [], shardCount: 4 });
    expect(store.abandoned.work).toBe(0);
    expect(lines.some(l => l.startsWith('[Shards] Shard 1 '))).toBe(false);
    await vi.advanceTimersByTimeAsync(2 * T.renewMs);
    expect(store.abandoned.work).toBe(2);
    expect(lines).toContain('[Shards] Shard 1 is no longer held by this process; its claim row could not be read (timeout)');
  });

  it('a record write that throws still starts the leave in the same step', async () => {
    process.env.FLEET_SHARD_CAPACITY = '2';
    otherNode(2);
    const { ready } = await boot();
    await ready;
    h.recordThrows = true;
    Object.assign(store.rows.get('4:0')!, { claim: 999, holderProcess: 'p-x', holderNode: 'node-x' });
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(h.leaves).toEqual(['Shard 0 is no longer held by this process']);
    expect(lines.join(String.fromCharCode(10))).toContain('[Shards] Could not rewrite the shard record: EACCES: permission denied');
  });
});

describe('during module loading (unit 6, R2-T4)', () => {
  it('a lapse: the login at the end connects nothing', async () => {
    process.env.FLEET_SHARD_CAPACITY = '2';
    otherNode(2);
    const { ready } = await boot();
    const ctx = await ready;
    expect(h.plans.at(-1)).toEqual({ shards: [0, 1], shardCount: 4 });
    store.renewMode = 'hang';
    await vi.advanceTimersByTimeAsync(T.deadlineMs);
    expect(h.lapses).toEqual([20]);
    ctx.startIngest('token');
    expect(h.starts).toBe(0);
  });

  it('a SIGTERM: the stop handler releases the held rows with the Released line and exits once', async () => {
    process.env.FLEET_SHARD_CAPACITY = '2';
    otherNode(2);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((() => undefined) as unknown) as typeof process.exit);
    const dm = await import('../../src/bot/internalSetup/utils/dataManager');
    const { mod, ready } = await boot();
    const order: string[] = [];
    const handler = dm.stopHandler(stopSteps({ claims: () => mod.getShardClaims(), drainForExit: dm.drainForExit, hasWorkingSet: () => true, order }));
    const ctx = await ready;
    h.stopping = true;
    const stopped = handler();
    await vi.advanceTimersByTimeAsync(6000);
    await stopped;
    expect(store.releases).toHaveLength(1);
    expect(lines).toContain("[Shards] Released shards 0, 1: kept for this machine's next start for 30 s, then free to any machine with room");
    expect([...store.rows.values()].filter(r => r.holderProcess !== 'p-x').every(r => r.released)).toBe(true);
    expect(exit.mock.calls).toEqual([[0]]);
    expect(order).toEqual(['beginStop', 'stopSamplers', 'closeGateway', 'flushTotals', 'drain', 'finishStop', 'exit']);
    expect(lines.some(l => l.includes('A stop step failed'))).toBe(false);
    ctx.startIngest('token');
    expect(h.starts).toBe(0);
  });
});

describe('a lapse after the grant', () => {
  it('stops serving at D: the lease empties and NB2 hears of the lapse', async () => {
    process.env.FLEET_SHARD_CAPACITY = '2';
    otherNode(2);
    const { ready } = await boot();
    await ready;
    store.renewMode = 'hang';
    await vi.advanceTimersByTimeAsync(T.deadlineMs);
    expect(h.plans.at(-1)).toEqual({ shards: [], shardCount: 4 });
    expect(h.lapses).toEqual([20]);
  });

  it.each([30, 60])('with FLEET_TAKEOVER_SECONDS %i, a gateway stop that never settles leaves each held shard reported as maybe still connected at TTL / 3 after the stop, not before (NB4-R9-T3)', async seconds => {
    process.env.FLEET_TAKEOVER_SECONDS = String(seconds);
    const ttlMs = seconds * 1000;
    process.env.FLEET_SHARD_CAPACITY = '2';
    otherNode(2);
    const { ready } = await boot();
    await ready;
    expect(h.plans.at(-1)).toEqual({ shards: [0, 1], shardCount: 4 });
    Object.assign(h, { ingestStarted: true, stopHangs: true });
    store.renewMode = 'hang';
    await vi.advanceTimersByTimeAsync((2 * ttlMs) / 3);
    expect(h.plans.at(-1)).toEqual({ shards: [], shardCount: 4 });
    expect(h.stopAt).toHaveLength(1);
    const still = () => lines.filter(l => l.includes('may still be connected'));
    const wait = h.stopAt[0] + ttlMs / 3 - 1 - Date.now();
    expect(wait).toBeGreaterThanOrEqual(0);
    await vi.advanceTimersByTimeAsync(wait);
    expect(still()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(still()).toEqual(['[Shards] Shard 0 may still be connected to Discord', '[Shards] Shard 1 may still be connected to Discord']);
  });
});

describe("the last start's record through the boot wiring (NB4-R7-T2)", () => {
  let file = '';
  const recordFile = () => file;
  const stored = () => JSON.parse(fs.readFileSync(recordFile(), 'utf-8'));
  const restarted = () => lines.filter(l => l.includes('while it restarted'));

  beforeEach(async () => {
    file = (await import('../../src/bot/internalSetup/fleet/shardRecord')).shardRecordPath();
    fs.rmSync(file, { force: true });
    h.realRecord = true;
    process.env.FLEET_SHARD_CAPACITY = '1';
    for (const id of [0, 1, 3]) seedRow(id, {});
    otherNode(4);
  });
  afterEach(() => {
    fs.rmSync(file, { force: true });
  });

  /** The first process: boots on shard 2, and runs the stop handler's steps when stop is set. */
  async function firstProcess(stop: boolean) {
    vi.spyOn(process, 'exit').mockImplementation(((() => undefined) as unknown) as typeof process.exit);
    const dm = await import('../../src/bot/internalSetup/utils/dataManager');
    const { mod, ready } = await boot();
    const steps = stopSteps({ claims: () => mod.getShardClaims(), drainForExit: dm.drainForExit, hasWorkingSet: () => true });
    await ready;
    expect(h.plans.at(-1)).toEqual({ shards: [2], shardCount: 4 });
    expect(stored()).toMatchObject({ shardCount: 4, shardIds: [2] });
    if (stop) {
      h.stopping = true;
      const stopped = steps();
      await vi.advanceTimersByTimeAsync(6000);
      await stopped;
    } else {
      const claims = mod.getShardClaims() as any;
      claims.beginStop();
      if (claims.renewTimer) clearInterval(claims.renewTimer);
    }
  }

  /** B takes shard 2 once it expired; a take keeps the row's home. */
  function bTakesShard2() {
    Object.assign(store.rows.get('4:2')!, {
      claim: 99, holderProcess: 'p-b', holderNode: 'node-b', holderName: 'B', released: false, reserved: false,
      takenAt: Date.now(), renewedAt: Date.now(), expiresUpMs: store.clock.upMs + 1_000_000,
    });
  }

  async function nextBoot() {
    h.stopping = false;
    h.plans = [];
    lines = [];
    vi.resetModules();
    const { ready } = await boot();
    return ready;
  }

  it('a shard the release kept for this machine and B took during the restart: the next boot logs the line once, read before its own record', async () => {
    await firstProcess(true);
    expect(lines).toContain("[Shards] Released shards 2: kept for this machine's next start for 30 s, then free to any machine with room");
    expect(store.rows.get('4:2')).toMatchObject({ holderNode: 'node-a', released: true, homeNode: 'node-a' });
    expect(stored()).toMatchObject({ shardCount: 4, shardIds: [2], keptAtStop: [2] });
    bTakesShard2();
    await nextBoot();
    expect(restarted()).toEqual(['[Shards] Shard 2 kept for this machine was taken by B while it restarted']);
    expect(h.plans.at(-1)).toEqual({ shards: [], shardCount: 4 });
    const after = stored();
    expect(after).toMatchObject({ shardCount: 4, shardIds: [] });
    expect('keptAtStop' in after).toBe(false);
  });

  it('a process that never completed its release (a crash): B takes the shard, and the next boot logs no line', async () => {
    await firstProcess(false);
    expect(store.releases).toHaveLength(0);
    expect('keptAtStop' in stored()).toBe(false);
    bTakesShard2();
    await nextBoot();
    expect(restarted()).toEqual([]);
    expect(stored()).toMatchObject({ shardCount: 4, shardIds: [] });
  });
});
