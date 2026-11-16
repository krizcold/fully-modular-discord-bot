import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemClaimStore } from '../helpers/fakeClaimStore';

// NB35 (1): the real shardBoot.ts bootShards hands runBot the data layer's refusal in its context. A refused Postgres
// boot, a pending verdict that turns refused and a JSON bot whose DATA_BACKEND was refused carry the reason; a pending
// verdict that turns serving carries none, so runBot's shared boot runs after it as before.

const h = vi.hoisted(() => ({
  gateway: { info: { recommendedShards: 4, sessionStartLimit: null } as any, error: null as string | null },
  dataState: 'serving' as string,
  refusalReason: null as string | null,
  kind: 'postgres' as 'postgres' | 'file',
  backend: null as any,
  ingest: null as any,
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
vi.mock('../../src/bot/internalSetup/ingest/ingestService', () => ({ getIngestService: () => h.ingest }));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/boot', async orig => ({
  ...(await orig<any>()),
  getDataBootStatus: () => ({ state: h.dataState, refusalReason: h.dataState === 'refused' ? h.refusalReason : null }),
}));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/workingSet', async orig => ({
  ...(await orig<any>()),
  getWorkingSet: () => null,
}));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<any>()),
  getBackendHealth: () => ({ state: 'healthy', oldestDirtyMs: 0, dirtyBytes: 0, lastError: null }),
  getGuildDataBackend: () => h.backend,
  isStopping: () => false,
}));
vi.mock('../../src/bot/internalSetup/utils/maintenance', async orig => ({
  ...(await orig<any>()),
  maintenanceUnfit: () => null,
  canRestart: () => true,
  restartForShards: () => false,
  startLeave: () => undefined,
  noteClaimsLapsed: () => undefined,
}));
vi.mock('../../src/bot/internalSetup/fleet/shardRecord', async orig => ({
  ...(await orig<any>()),
  readShardRecord: () => null,
  writeShardRecord: () => undefined,
}));
vi.mock('../../src/utils/envLoader', async orig => ({
  ...(await orig<any>()),
  resolveDataBackend: () => h.kind,
}));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/mainDatabase', async orig => ({
  ...(await orig<any>()),
  setStepLayers: () => undefined,
}));

const REASON = "the configured database is not the one this deployment's data lives in (store store-b vs recorded store-a)";
const REFUSED_LINE = '[Shards] The data layer refused this database, so this bot process connects no shard to Discord';
const savedToken = process.env.DISCORD_TOKEN;
let lines: string[] = [];

function fakeIngest() {
  return {
    setShardPlan: () => undefined,
    isStarted: () => false,
    start: vi.fn(async () => 'ok'),
    stop: vi.fn(async () => undefined),
    getClient: () => null,
    setIdentifyThrottler: vi.fn(),
  };
}

beforeAll(async () => {
  await import('../../src/bot/internalSetup/fleet/shardBoot');
}, 120_000);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  Object.assign(h, { dataState: 'serving', refusalReason: null, kind: 'postgres', backend: null, ingest: fakeIngest() });
  delete process.env.FLEET_SHARD_CAPACITY;
  delete process.env.FLEET_SHARD_COUNT;
  delete process.env.FLEET_TAKEOVER_SECONDS;
  process.env.DISCORD_TOKEN = 'test-token';
  lines = [];
  const capture = (...args: unknown[]) => { lines.push(args.map(a => (a instanceof Error ? a.message : String(a))).join(' ')); };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
});
afterEach(async () => {
  const mod = await import('../../src/bot/internalSetup/fleet/shardBoot');
  mod.getJsonReshard()?.stop();
  mod.getShardClaims()?.beginStop();
  const claims = mod.getShardClaims() as any;
  if (claims?.renewTimer) clearInterval(claims.renewTimer);
  if (savedToken === undefined) delete process.env.DISCORD_TOKEN;
  else process.env.DISCORD_TOKEN = savedToken;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function boot() {
  vi.resetModules();
  const mod = await import('../../src/bot/internalSetup/fleet/shardBoot');
  mod._setClaimStoreFactory(() => new MemClaimStore(() => Date.now()));
  const ready = mod.bootShards();
  let settled = false;
  void ready.then(() => { settled = true; }, () => { settled = true; });
  return { ready, settled: () => settled };
}

describe('NB35 (1): the data verdict in the shard boot context', () => {
  it('a refused Postgres boot: no shard, and the context carries the refusal reason', async () => {
    h.dataState = 'refused';
    h.refusalReason = REASON;
    const { ready } = await boot();
    const ctx = await ready;
    expect(lines).toContain(REFUSED_LINE);
    expect(ctx.shardCount).toBe(0);
    expect(ctx.dataRefusal).toBe(REASON);
  });

  it('a pending verdict: no context while it waits; turned refused it carries the reason, turned serving it carries none', async () => {
    h.dataState = 'starting';
    const first = await boot();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(first.settled()).toBe(false);
    h.refusalReason = REASON;
    h.dataState = 'refused';
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await first.ready).dataRefusal).toBe(REASON);

    h.dataState = 'starting';
    h.refusalReason = null;
    const second = await boot();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(second.settled()).toBe(false);
    h.dataState = 'serving';
    await vi.advanceTimersByTimeAsync(1_000);
    const ctx = await second.ready;
    expect(ctx.shardCount).toBe(4);
    expect(ctx.dataRefusal).toBeUndefined();
  });

  it('a JSON bot whose DATA_BACKEND was refused: its shards run, and the context carries the reason', async () => {
    h.kind = 'file';
    h.dataState = 'refused';
    h.refusalReason = 'Invalid DATA_BACKEND value "sqlite"';
    const { ready } = await boot();
    const ctx = await ready;
    expect(ctx.shardCount).toBe(4);
    expect(ctx.dataRefusal).toBe('Invalid DATA_BACKEND value "sqlite"');
  });
});
