import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemClaimStore } from '../helpers/fakeClaimStore';
import { stopSteps } from '../helpers/stopRig';


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
    heldGuilds: () => h.held, writesSettled: () => true, landedFlushes: () => 0, flushOnTheWire: () => false,
    flushAllDirty: async () => undefined, dirtyGuildIds: () => [], takeDropLines: () => [],
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

describe('a loss writes the shards served minus the lost ones, under the lost pairs\' count (NB4 round 13)', () => {
  let file = '';
  const stored = () => JSON.parse(fs.readFileSync(file, 'utf-8'));
  const writePrevious = (record: Record<string, unknown>) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ processId: 'p-old', at: '2026-10-29T00:00:00.000Z', ...record }));
  };

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

  async function start(afterTake?: (mod: any) => void) {
    vi.spyOn(process, 'exit').mockImplementation(((() => undefined) as unknown) as typeof process.exit);
    const dm = await import('../../src/bot/internalSetup/utils/dataManager');
    const take = store.take.bind(store);
    const { mod, ready } = await boot();
    store.take = (async (...args: Parameters<typeof take>) => {
      const answer = await take(...args);
      afterTake?.(mod);
      return answer;
    }) as typeof store.take;
    const steps = stopSteps({ claims: () => mod.getShardClaims(), drainForExit: dm.drainForExit, hasWorkingSet: () => true });
    return { mod, ready, steps };
  }

  const bTakes = (shardId: number) => Object.assign(store.rows.get(`4:${shardId}`)!, {
    claim: 90 + shardId, holderProcess: 'p-b', holderNode: 'node-b', holderName: 'B', released: false, reserved: false,
    takenAt: Date.now(), renewedAt: Date.now(), expiresUpMs: store.clock.upMs + 1_000_000,
  });

  it('a stop during the boot take, a drain loss, then a failed release: the previous record minus the lost shard (NB4-R13-DATA-1)', async () => {
    writePrevious({ shardCount: 4, shardIds: [1, 2] });
    const { steps } = await start(() => { h.stopping = true; });
    await vi.advanceTimersByTimeAsync(100);
    expect(h.plans).toEqual([]);
    bTakes(1);
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(stored()).toEqual({ shardCount: 4, shardIds: [2], processId: expect.any(String), at: expect.any(String) });
    store.releaseMode = lockTimeout();
    const stopped = steps();
    await vi.advanceTimersByTimeAsync(6000);
    await stopped;
    expect(stored()).toMatchObject({ shardCount: 4, shardIds: [2] });
    expect(stored().keptAtStop).toBeUndefined();
    expect(h.records.every(r => r.shardCount > 0)).toBe(true);
  });

  it('a stop during the boot take with a previous record of another count: the record lists no shard and keeps the count (NB4-R13-RUN-2)', async () => {
    writePrevious({ shardCount: 2, shardIds: [0, 1] });
    const { steps } = await start(() => { h.stopping = true; });
    await vi.advanceTimersByTimeAsync(100);
    bTakes(1);
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(stored()).toMatchObject({ shardCount: 4, shardIds: [] });
    store.releaseMode = lockTimeout();
    const stopped = steps();
    await vi.advanceTimersByTimeAsync(6000);
    await stopped;
    expect(stored()).toMatchObject({ shardCount: 4, shardIds: [] });
    expect(h.records.every(r => r.shardCount > 0)).toBe(true);
  });

  it('a stop during the boot take, a drain loss, then a completed release: no shard this boot never served (NB4-R13-RUN-2)', async () => {
    writePrevious({ shardCount: 4, shardIds: [1, 2] });
    const { steps } = await start(() => { h.stopping = true; });
    await vi.advanceTimersByTimeAsync(100);
    bTakes(1);
    await vi.advanceTimersByTimeAsync(T.renewMs);
    const stopped = steps();
    await vi.advanceTimersByTimeAsync(6000);
    await stopped;
    expect(stored()).toMatchObject({ shardCount: 4, shardIds: [2], keptAtStop: [0] });
  });

  it('a lapse before the grant, then a loss: the record still lists no shard (NB4-R13-DATA-1)', async () => {
    writePrevious({ shardCount: 4, shardIds: [0, 1] });
    const { ready } = await start(mod => { (mod.getShardClaims() as any).stopped = 'lapse'; });
    await ready;
    expect(h.plans.at(-1)).toEqual({ shards: [], shardCount: 4 });
    expect(stored()).toMatchObject({ shardCount: 4, shardIds: [] });
    bTakes(1);
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(h.records.length).toBeGreaterThan(1);
    expect(stored()).toMatchObject({ shardCount: 4, shardIds: [] });
  });
});

describe('the none-held release line once a take answered (NB4-R13-T-NONEHELD, NB4-R13-RUN-1)', () => {
  const NONE = '; any shard row still naming this process frees once its claim expires';

  beforeEach(() => {
    process.env.FLEET_SHARD_CAPACITY = '2';
    otherNode(4);
  });

  async function serve() {
    vi.spyOn(process, 'exit').mockImplementation(((() => undefined) as unknown) as typeof process.exit);
    const dm = await import('../../src/bot/internalSetup/utils/dataManager');
    const { mod, ready } = await boot();
    const steps = stopSteps({ claims: () => mod.getShardClaims(), drainForExit: dm.drainForExit, hasWorkingSet: () => true });
    await ready;
    return { steps };
  }

  const bTakes = (shardId: number) => Object.assign(store.rows.get(`4:${shardId}`)!, {
    claim: 90 + shardId, holderProcess: 'p-b', holderNode: 'node-b', holderName: 'B', released: false, reserved: false,
    takenAt: Date.now(), renewedAt: Date.now(), expiresUpMs: store.clock.upMs + 1_000_000,
  });

  it('every pair lost before the stop, then a release that fails', async () => {
    for (const id of [2, 3]) seedRow(id, {});
    const { steps } = await serve();
    expect(h.plans.at(-1)).toEqual({ shards: [0, 1], shardCount: 4 });
    bTakes(0);
    bTakes(1);
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(h.leaves.length).toBe(1);
    h.stopping = true;
    store.releaseMode = lockTimeout();
    const stopped = steps();
    await vi.advanceTimersByTimeAsync(6000);
    await stopped;
    expect(lines).toContain(`[Shards] The release did not complete (error: SQLSTATE 55P03 canceling statement due to lock timeout)${NONE}`);
    expect(lines.filter(l => l.includes('boot take may have claimed'))).toEqual([]);
  });

  it('an empty grant, then a release that fails', async () => {
    for (const id of [0, 1, 2, 3]) seedRow(id, {});
    const { steps } = await serve();
    expect(h.plans.at(-1)).toEqual({ shards: [], shardCount: 4 });
    h.stopping = true;
    store.releaseMode = lockTimeout();
    const stopped = steps();
    await vi.advanceTimersByTimeAsync(6000);
    await stopped;
    expect(store.releases.length).toBe(1);
    expect(lines).toContain(`[Shards] The release did not complete (error: SQLSTATE 55P03 canceling statement due to lock timeout)${NONE}`);
    expect(lines.filter(l => l.includes('boot take may have claimed') || l.includes('Could not reach the database'))).toEqual([]);
  });

  it.each([
    ['refused', { kind: 'refused' } as const, false, true],
    ['a connect error', { kind: 'unreachable', detail: 'ECONNREFUSED' } as const, false, false],
    ['no answer after sending', { kind: 'timeout' } as const, true, true],
    ['a server error', { kind: 'error', code: '55P03', message: 'lock timeout' } as const, false, true],
  ])('%s: the line says the release did not complete, never that the database was unreachable', async (_name, failure, sent, connected) => {
    const { releaseFailureLine, describeFailureClass } = await import('../../src/bot/internalSetup/fleet/shardClaims');
    expect(releaseFailureLine([], failure as any, sent, connected)).toBe(`[Shards] The release did not complete (${describeFailureClass(failure as any)})${NONE}`);
  });

  it('a take that never answered gets the same line', async () => {
    const { releaseFailureLine } = await import('../../src/bot/internalSetup/fleet/shardClaims');
    expect(releaseFailureLine([], { kind: 'timeout' }, false, true)).toBe(`[Shards] The release did not complete (timeout)${NONE}`);
  });
});
