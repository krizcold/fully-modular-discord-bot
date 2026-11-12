import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// shardBoot.ts with its modules mocked and fake timers: the deps a JSON bot's boot hands its JsonReshard, the boot's
// single flight, and a promoted Postgres standby's 300 s bound on the data layer's verdict.

const h = vi.hoisted(() => ({
  gatewayCalls: 0,
  dataState: 'serving' as string,
  stopping: false,
  unfit: null as string | null,
  health: 'healthy' as string,
  kind: 'file' as 'postgres' | 'file',
  leaves: [] as Array<[string, unknown]>,
  restarts: [] as string[],
  plans: [] as Array<{ shards: number[]; shardCount: number }>,
  throttlers: 0,
  deps: null as any,
  ledger: null as any,
}));

vi.mock('../../src/bot/internalSetup/fleet/placement', async orig => ({
  ...(await orig<any>()),
  fetchGatewayInfoResult: vi.fn(async () => { h.gatewayCalls += 1; return { info: { recommendedShards: 2, sessionStartLimit: null }, error: null }; }),
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
    isStarted: () => false,
    start: async () => 'ok',
    stop: async () => undefined,
    getClient: () => null,
    setIdentifyThrottler: () => { h.throttlers += 1; },
  };
  return { getIngestService: () => fake };
});
vi.mock('../../src/bot/internalSetup/utils/dataBackends/boot', async orig => ({
  ...(await orig<any>()),
  getDataBootStatus: () => ({ state: h.dataState }),
}));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<any>()),
  getBackendHealth: () => ({ state: h.health, oldestDirtyMs: 0, dirtyBytes: 0, lastError: null }),
  getGuildDataBackend: () => null,
  isStopping: () => h.stopping,
}));
vi.mock('../../src/bot/internalSetup/utils/maintenance', async orig => ({
  ...(await orig<any>()),
  maintenanceUnfit: () => h.unfit,
  startLeave: (reason: string, handOver?: unknown) => { h.leaves.push([reason, handOver]); },
  requestRestart: (reason: string) => { h.restarts.push(reason); },
}));
vi.mock('../../src/utils/envLoader', async orig => ({
  ...(await orig<any>()),
  resolveDataBackend: () => h.kind,
}));
vi.mock('../../src/bot/internalSetup/fleet/reshard', async orig => {
  const actual = await orig<any>();
  class CapturedJsonReshard extends actual.JsonReshard {
    constructor(deps: any) { super(deps); h.deps = deps; }
  }
  return { ...actual, JsonReshard: CapturedJsonReshard };
});
vi.mock('../../src/bot/internalSetup/fleet/identifyLedger', async orig => {
  const actual = await orig<any>();
  class CapturedLedger extends actual.IdentifyLedger {
    constructor(...args: any[]) { super(...args); h.ledger = this; }
  }
  return { ...actual, IdentifyLedger: CapturedLedger };
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  vi.resetModules();
  Object.assign(h, {
    gatewayCalls: 0, dataState: 'serving', stopping: false, unfit: null, health: 'healthy', kind: 'file',
    leaves: [], restarts: [], plans: [], throttlers: 0, deps: null, ledger: null,
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => {
  (await import('../../src/bot/internalSetup/fleet/shardBoot')).getJsonReshard()?.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function jsonBoot() {
  const mod = await import('../../src/bot/internalSetup/fleet/shardBoot');
  const ctx = await mod.bootShards();
  expect(h.deps).not.toBeNull();
  return { mod, ctx, deps: h.deps };
}

describe("a JSON bot's reshard deps", () => {
  it('recommendation: a read 1 min old and one exactly 15 min old count, one 15 min and 1 ms old does not', async () => {
    const { deps } = await jsonBoot();
    const rec = vi.spyOn(h.ledger, 'getRecommendation');
    rec.mockReturnValue({ shards: 5, readAt: Date.now() });
    expect(deps.recommendation()).toBe(5);
    rec.mockReturnValue({ shards: 5, readAt: Date.now() - 60_000 });
    expect(deps.recommendation()).toBe(5);
    rec.mockReturnValue({ shards: 6, readAt: Date.now() - 15 * 60_000 });
    expect(deps.recommendation()).toBe(6);
    rec.mockReturnValue({ shards: 7, readAt: Date.now() - 15 * 60_000 - 1 });
    expect(deps.recommendation()).toBeNull();
    rec.mockReturnValue(null);
    expect(deps.recommendation()).toBeNull();
  });

  it('fitness: null when fit, the maintenance key first, then stopping, then the backend health', async () => {
    const { deps } = await jsonBoot();
    expect(deps.fitness()).toBeNull();
    h.unfit = 'leaving';
    h.stopping = true;
    h.health = 'degraded';
    expect(deps.fitness()).toBe('leaving');
    h.unfit = null;
    expect(deps.fitness()).toBe('stopping');
    h.stopping = false;
    expect(deps.fitness()).toBe('the data backend is degraded');
    h.health = 'healthy';
    expect(deps.fitness()).toBeNull();
  });

  it('startedAgoMs: the ms since the boot started the reshard timer', async () => {
    const { deps } = await jsonBoot();
    expect(deps.startedAgoMs()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(deps.startedAgoMs()).toBe(5_000);
  });

  it("budget: null while the ledger has no read, the ledger's figures with resetAt in the future once it has one", async () => {
    const { deps } = await jsonBoot();
    expect(deps.budget()).toBeNull();
    vi.spyOn(h.ledger, 'getBudgetInfo').mockReturnValue({ total: 1000, remaining: 900, resetAfterMs: 60_000, fetchedAgoMs: 0, stale: false, unavailable: false });
    expect(deps.budget()).toEqual({ stale: false, remaining: 900, resetAt: Date.now() + 60_000 });
  });

  it('send: a message reaches process.send', async () => {
    const hadSend = typeof process.send === 'function';
    const original = process.send;
    if (!hadSend) (process as any).send = () => true;
    try {
      const { deps } = await jsonBoot();
      expect(typeof deps.send).toBe('function');
      const got: unknown[] = [];
      (process as any).send = (m: unknown) => { got.push(m); return true; };
      try {
        deps.send({ type: 'control:reshard-standby', data: { attempt: 'x' } });
      } finally {
        (process as any).send = original;
      }
      expect(got).toEqual([{ type: 'control:reshard-standby', data: { attempt: 'x' } }]);
    } finally {
      (process as any).send = original;
    }
  });

  it("handOver: the gateway stops (an empty plan), the serving hook reports stopped, NB2's leave runs with the attempt", async () => {
    const { mod } = await jsonBoot();
    const { stoppedServing } = await import('../../src/bot/internalSetup/utils/servingGate');
    const stop = vi.spyOn(mod.getLeaseRuntime()!, 'stopServing');
    expect(stoppedServing()).toBe(false);
    const before = h.plans.length;
    h.deps.handOver('the reshard to 4 shards finished', 'att-1');
    expect(stop).toHaveBeenCalledWith(10_000);
    expect(h.plans.slice(before)).toEqual([{ shards: [], shardCount: 2 }]);
    expect(stoppedServing()).toBe(true);
    expect(h.leaves).toEqual([['the reshard to 4 shards finished', { attempt: 'att-1' }]]);
  });

  it("the fleet state shows the JSON reshard's fields: a promoted JSON standby's finished reshard as the last one", async () => {
    const mod = await import('../../src/bot/internalSetup/fleet/shardBoot');
    const { LeaseRuntime } = await import('../../src/bot/internalSetup/fleet/leaseRuntime');
    const { getIngestService } = await import('../../src/bot/internalSetup/ingest/ingestService');
    await mod.bootShards({ taken: { json: true, count: 3, from: 1, runtime: new LeaseRuntime(getIngestService()) } });
    const { getFleetState } = await import('../../src/bot/internalSetup/fleet/state');
    const state = getFleetState() as any;
    expect(state.lastReshard).toEqual({ from: 1, to: 3, method: 'overlap', state: 'done', endedAt: expect.any(Number), reason: null });
    expect(state.reshard).toBeNull();
    expect(state.reshardWait).toBeNull();
  });

  it('a plain JSON boot sets the identify throttler', async () => {
    await jsonBoot();
    expect(h.throttlers).toBe(1);
  });

  it('a promoted JSON standby keeps the identify throttler it built', async () => {
    const mod = await import('../../src/bot/internalSetup/fleet/shardBoot');
    const { LeaseRuntime } = await import('../../src/bot/internalSetup/fleet/leaseRuntime');
    const { getIngestService } = await import('../../src/bot/internalSetup/ingest/ingestService');
    await mod.bootShards({ taken: { json: true, count: 2, runtime: new LeaseRuntime(getIngestService()) } });
    expect(h.throttlers).toBe(0);
  });
});

describe('bootShards runs one boot at a time', () => {
  it('two calls before the first resolves share one promise and one gateway read', async () => {
    const mod = await import('../../src/bot/internalSetup/fleet/shardBoot');
    const a = mod.bootShards();
    const b = mod.bootShards();
    expect(b).toBe(a);
    await a;
    expect(h.gatewayCalls).toBe(1);
  });

  it('after a boot that failed, the next call boots again', async () => {
    const mod = await import('../../src/bot/internalSetup/fleet/shardBoot');
    const { LeaseRuntime } = await import('../../src/bot/internalSetup/fleet/leaseRuntime');
    const { getIngestService } = await import('../../src/bot/internalSetup/ingest/ingestService');
    const wrong = {
      count: 1, processId: 'not-this-process', pairs: [], runtime: new LeaseRuntime(getIngestService()),
      stopLanes: async () => undefined, release: async () => undefined,
    };
    await expect(mod.bootShards({ taken: wrong as any })).rejects.toThrow(/not this process's/);
    const ctx = await mod.bootShards();
    expect(ctx.shardCount).toBe(2);
  });
});

describe("a promoted Postgres standby's 300 s bound on the data layer's verdict", () => {
  async function standby() {
    h.kind = 'postgres';
    h.dataState = 'starting';
    const { processId } = await import('../../src/bot/internalSetup/fleet/processId');
    const { LeaseRuntime } = await import('../../src/bot/internalSetup/fleet/leaseRuntime');
    const { getIngestService } = await import('../../src/bot/internalSetup/ingest/ingestService');
    const release = vi.fn(async () => undefined);
    const taken = {
      count: 2, processId: processId(), pairs: [], runtime: new LeaseRuntime(getIngestService()),
      stopLanes: vi.fn(async () => undefined), release,
    };
    const mod = await import('../../src/bot/internalSetup/fleet/shardBoot');
    void mod.bootShards({ taken: taken as any });
    return { release };
  }

  it('the release runs at 300 s exactly, not before', async () => {
    const { release } = await standby();
    await vi.advanceTimersByTimeAsync(299_999);
    expect(release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(h.restarts).toHaveLength(1);
  });

  it('the bound counts from the wait, not from the process start: 200 s into the process, 10 s of waiting release nothing', async () => {
    await vi.advanceTimersByTimeAsync(200_000);
    const { release } = await standby();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(release).not.toHaveBeenCalled();
    expect(h.restarts).toEqual([]);
    await vi.advanceTimersByTimeAsync(290_000);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
