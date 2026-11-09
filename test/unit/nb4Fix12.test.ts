import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemClaimStore } from '../helpers/fakeClaimStore';
import { stopSteps } from '../helpers/stopRig';

// Round 12 fixes of NB4: the shard record leaves out a shard lost in the exit drain at the loss itself, and a shard
// the release handed over; the release's failure line names only the shards still held.


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
    ingestStarted: false, stopHangs: false, stopAt: [],
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


const lockTimeout = () => Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });

describe('the shard record lists the shards served minus every shard lost or handed away (NB4 round 12)', () => {
  let file = '';
  const stored = () => JSON.parse(fs.readFileSync(file, 'utf-8'));

  beforeEach(async () => {
    file = (await import('../../src/bot/internalSetup/fleet/shardRecord')).shardRecordPath();
    fs.rmSync(file, { force: true });
    h.realRecord = true;
    process.env.FLEET_SHARD_CAPACITY = '2';
    for (const id of [2, 3]) seedRow(id, {});
    otherNode(4);
  });
  afterEach(() => {
    fs.rmSync(file, { force: true });
  });

  async function serveZeroAndOne() {
    vi.spyOn(process, 'exit').mockImplementation(((() => undefined) as unknown) as typeof process.exit);
    const dm = await import('../../src/bot/internalSetup/utils/dataManager');
    const { mod, ready } = await boot();
    const steps = stopSteps(dm, { claims: () => mod.getShardClaims() });
    await ready;
    expect(h.plans.at(-1)).toEqual({ shards: [0, 1], shardCount: 4 });
    expect(stored()).toMatchObject({ shardCount: 4, shardIds: [0, 1] });
    return { mod, steps };
  }

  const bTakes = (shardId: number) => Object.assign(store.rows.get(`4:${shardId}`)!, {
    claim: 90 + shardId, holderProcess: 'p-b', holderNode: 'node-b', holderName: 'B', released: false, reserved: false,
    takenAt: Date.now(), renewedAt: Date.now(), expiresUpMs: store.clock.upMs + 1_000_000,
  });

  it('a loss in the exit drain followed by a release that fails: the record already left the lost shard out (NB4-R11-RUN-1)', async () => {
    const { steps } = await serveZeroAndOne();
    h.stopping = true;
    bTakes(1);
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(h.leaves).toEqual([]);
    expect(stored()).toEqual({ shardCount: 4, shardIds: [0], processId: expect.any(String), at: expect.any(String) });
    store.releaseMode = lockTimeout();
    const stopped = steps();
    await vi.advanceTimersByTimeAsync(6000);
    await stopped;
    expect(store.releases.length).toBe(1);
    const record = stored();
    expect(record.shardIds).toEqual([0]);
    expect(record.keptAtStop).toBeUndefined();
  });

  it('the failure line names only the shards still held, never the one lost in the drain (NB4-R12-RUN-1)', async () => {
    const { steps } = await serveZeroAndOne();
    h.stopping = true;
    bTakes(1);
    await vi.advanceTimersByTimeAsync(T.renewMs);
    store.releaseMode = lockTimeout();
    const stopped = steps();
    await vi.advanceTimersByTimeAsync(6000);
    await stopped;
    expect(lines).toContain('[Shards] Could not release shards 0 (SQLSTATE 55P03 canceling statement due to lock timeout); any machine with room may take them once their claims expire');
    expect(lines.filter(l => /Could not release shards .*1/.test(l))).toEqual([]);
  });

  it('every held shard lost in the drain and a failed release: the line names no shard (NB4-R12-RUN-1)', async () => {
    const { steps } = await serveZeroAndOne();
    h.stopping = true;
    bTakes(0);
    bTakes(1);
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(stored().shardIds).toEqual([]);
    store.releaseMode = lockTimeout();
    const stopped = steps();
    await vi.advanceTimersByTimeAsync(6000);
    await stopped;
    expect(lines).toContain('[Shards] The release did not complete (error: SQLSTATE 55P03 canceling statement due to lock timeout); any shard row still naming this process frees once its claim expires');
    expect(lines.filter(l => l.startsWith('[Shards] Could not release'))).toEqual([]);
    expect(stored().shardIds).toEqual([]);
  });

  it('a record file error at a drain loss is logged and the stop goes on', async () => {
    const { steps } = await serveZeroAndOne();
    h.stopping = true;
    h.recordThrows = true;
    bTakes(1);
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(lines).toContain('[Shards] Could not rewrite the shard record: EACCES: permission denied');
    h.recordThrows = false;
    const stopped = steps();
    await vi.advanceTimersByTimeAsync(6000);
    await stopped;
    expect(stored()).toMatchObject({ shardCount: 4, shardIds: [0], keptAtStop: [0] });
  });

  it('a completed release that hands shard 1 to B: the record keeps only shard 0 (NB4-R12-T-HANDOVER-RECORD)', async () => {
    const { mod, steps } = await serveZeroAndOne();
    store.nodes.set('node-b', {
      nodeId: 'node-b', nodeName: 'B', processId: 'p-b', capacity: 1, takeoverSeconds: 30, fit: true, restartable: true, returns: true,
      seenAgoMs: 0, healthyForMs: null, seenAt: Date.now(), healthySince: Date.now() - 400_000,
    });
    h.stopping = true;
    (mod.getShardClaims() as any).returnList = [{ shardId: 1, receiver: 'node-b', move: false }];
    const stopped = steps();
    await vi.advanceTimersByTimeAsync(6000);
    await stopped;
    expect(lines).toContain('[Shards] Handed shard 1 to B');
    expect(stored()).toMatchObject({ shardCount: 4, shardIds: [0], keptAtStop: [0] });
  });
});
