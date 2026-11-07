import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemClaimStore } from '../helpers/fakeClaimStore';

// NB9 test 19 (code review 1, lane B finding 5): a promoted standby's lapse after the redraw and the grant, through
// shardBoot.ts with nb9ServeVerdict's mocks and fake timers. Its own file: a boot an earlier row leaves pending
// keeps the leave's save from settling. The store holds the standby's rows of W as its take wrote them.

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

describe("test 19: a promoted standby's lapse (41, NB4)", () => {
  it("test 19 (code review 1, B5): a lapse after the redraw and the grant reaches requestRestart's 'control:restart-bot', never process.exit(0)", async () => {
    const p = await promoted();
    const exits: unknown[] = [];
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { exits.push(code); }) as any);
    await p.mod.bootShards({ taken: p.taken });
    expect(store.redraws).toHaveLength(1);
    expect(p.grants.at(-1)).toMatchObject({ processId: p.pid, shardCount: 2 });
    store.renewMode = new Error('connect ECONNREFUSED 127.0.0.1:5432');
    await vi.advanceTimersByTimeAsync(30_000);
    const m = await import('../../src/bot/internalSetup/utils/maintenance');
    const watch = m.watchDataBackend({ onLoginRefused: () => undefined, askDatabase: async () => 'answers' as const }, { retryMs: 1_000_000_000 });
    await watch!.probeNow();
    await vi.advanceTimersByTimeAsync(5_000);
    const restarts = sent.filter(s => s?.type === 'control:restart-bot');
    m._resetMaintenance();
    m._setMaintenanceSender(null);
    expect(restarts).toHaveLength(1);
    expect(restarts[0].data.reason).toMatch(/^The shard claims lapsed \(no renewal for \d+ s\) and the database answers$/);
    expect(exits).not.toContain(0);
  });
});
