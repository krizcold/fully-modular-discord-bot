import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemClaimStore } from '../helpers/fakeClaimStore';
import { stopSteps } from '../helpers/stopRig';
import { mount } from '../helpers/jsxRig';

// Round 11 fixes of NB4: a shard lost in the exit drain, or one the release did not return, leaves the shard record's
// shardIds; the Machines table reads "not healthy now" for a machine with no healthy_since, which may still serve.


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

describe('the shard record after a release that did not return every shard (NB4-R11-RUN-1)', () => {
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
    const steps = stopSteps({ claims: () => mod.getShardClaims(), drainForExit: dm.drainForExit, hasWorkingSet: () => true });
    await ready;
    expect(h.plans.at(-1)).toEqual({ shards: [0, 1], shardCount: 4 });
    expect(stored()).toMatchObject({ shardCount: 4, shardIds: [0, 1] });
    return steps;
  }

  const bTakesShard1 = () => Object.assign(store.rows.get('4:1')!, {
    claim: 99, holderProcess: 'p-b', holderNode: 'node-b', holderName: 'B', released: false, reserved: false,
    takenAt: Date.now(), renewedAt: Date.now(), expiresUpMs: store.clock.upMs + 1_000_000,
  });

  it('B takes shard 1 before the stop: the record keeps only shard 0, in shardIds and in keptAtStop', async () => {
    const steps = await serveZeroAndOne();
    h.stopping = true;
    bTakesShard1();
    const stopped = steps();
    await vi.advanceTimersByTimeAsync(6000);
    await stopped;
    expect(lines).toContain('[Shards] Shard 1 was no longer held by this process at the release');
    const record = stored();
    expect(record).toMatchObject({ shardCount: 4, shardIds: [0], keptAtStop: [0] });
  });

  it('a loss found by a renewal in the exit drain: the lost shard leaves shardIds and no leave starts', async () => {
    const steps = await serveZeroAndOne();
    h.stopping = true;
    bTakesShard1();
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(h.leaves).toEqual([]);
    expect(h.records.at(-1)).toEqual({ shardCount: 4, shardIds: [0], processId: expect.any(String), at: expect.any(String) });
    const stopped = steps();
    await vi.advanceTimersByTimeAsync(6000);
    await stopped;
    expect(stored()).toMatchObject({ shardCount: 4, shardIds: [0], keptAtStop: [0] });
  });

  it('a release that returns every shard leaves shardIds whole', async () => {
    const steps = await serveZeroAndOne();
    h.stopping = true;
    const stopped = steps();
    await vi.advanceTimersByTimeAsync(6000);
    await stopped;
    expect(stored()).toMatchObject({ shardCount: 4, shardIds: [0, 1], keptAtStop: [0, 1] });
  });
});

describe("the Machines table's Healthy for column (NB4-R11-DATA-1)", () => {
  const FLEET_VIEW = fileURLToPath(new URL('../../src/webui/public/components/usage/FleetView.jsx', import.meta.url));
  const node = (over: Record<string, unknown>) => ({
    nodeId: 'node-a', name: 'A', target: 2, held: 2, fit: true, restartable: true, returns: true, healthyForMs: 400_000,
    seenAgoMs: 2000, takeoverSeconds: 30, aboveReason: null, ...over,
  });
  function cells(nodes: unknown[]): string[] {
    const fleet = { dataBackend: 'postgres', claims: [], nodes, claimsReadAgoMs: 1000, renewalError: null, stillConnected: [], pendingRestart: null, restartWaiting: null };
    const view = mount(FLEET_VIEW, 'FleetClaimsCard', { fleet }, {});
    return view.all(el => el.type === 'td').map(el => view.text(el));
  }

  it('an unfit machine that still holds and serves its shards reads "not healthy now", never "not serving"', () => {
    const text = cells([node({ fit: false, healthyForMs: null, held: 2 })]);
    expect(text).toContain('not healthy now');
    expect(text.join(' ')).not.toContain('not serving');
    expect(text).toContain('2s ago');
  });

  it('a healthy machine reads its duration', () => {
    expect(cells([node({})])).toContain('6m 40s');
  });
});
