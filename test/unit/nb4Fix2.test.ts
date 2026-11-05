import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  gateway: [] as Array<{ info: any; error: string | null }>,
  setState: null as string | null,
  restores: 0,
  deletes: 0,
}));

vi.mock('../../src/bot/internalSetup/fleet/placement', async importOriginal => {
  const real: any = await importOriginal();
  return {
    ...real,
    fetchGatewayInfoResult: vi.fn(async () => h.gateway.shift() ?? { info: null, error: 'HTTP 401' }),
  };
});

vi.mock('../../src/utils/envLoader', async importOriginal => {
  const real: any = await importOriginal();
  return { ...real, resolveDataBackend: () => 'postgres', loadCredentials: () => ({ DATA_BACKEND_URL: 'postgres://fake/fake' }) };
});

vi.mock('../../src/bot/internalSetup/utils/dataBackends/boot', async importOriginal => {
  const real: any = await importOriginal();
  return { ...real, getDataBootStatus: () => ({ state: 'serving' }), awaitGuildDataReady: async () => true };
});

vi.mock('../../src/bot/internalSetup/utils/dataBackends/dataReadiness', async importOriginal => {
  const real: any = await importOriginal();
  return { ...real, getDataReadiness: () => ({ onLeaseChanged: () => undefined }) };
});

vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async importOriginal => {
  const real: any = await importOriginal();
  return { ...real, cleanOrphanTmpFiles: vi.fn(async () => {}) };
});

vi.mock('../../src/bot/internalSetup/utils/dataBackends/workingSet', async importOriginal => {
  const real: any = await importOriginal();
  return { ...real, getWorkingSet: () => (h.setState === null ? null : { stateOf: () => h.setState }) };
});

vi.mock('../../src/bot/internalSetup/utils/dataManager', async importOriginal => {
  const real: any = await importOriginal();
  return {
    ...real,
    restoreGuildFromGraveyard: vi.fn(async () => { h.restores += 1; return { ok: true }; }),
    deleteGuildNamespace: vi.fn(async () => { h.deletes += 1; return true; }),
  };
});

vi.mock('../../src/bot/internalSetup/fleet/nodeIdentity', async importOriginal => {
  const real: any = await importOriginal();
  return { ...real, getNodeId: () => 'node-a', getNodeName: () => 'Node A', getAppVersion: () => '1.0.0' };
});

vi.mock('../../src/bot/internalSetup/ingest/ingestService', () => {
  const fake = {
    setShardPlan: () => undefined,
    isStarted: () => false,
    start: async () => 'ok',
    stop: async () => {},
    getClient: () => null,
  };
  return { getIngestService: () => fake };
});

import { ShardClaims, type ShardClaimsDeps } from '../../src/bot/internalSetup/fleet/shardClaims';
import { claimState, claimTimings, type ClaimRow, type NodeRow, type Pair } from '../../src/bot/internalSetup/fleet/claimRules';
import { _setClaimStoreFactory, bootShards, getShardClaims, TOKEN_REFUSED_LINE } from '../../src/bot/internalSetup/fleet/shardBoot';
import { _setFleetStateSources, getFleetState } from '../../src/bot/internalSetup/fleet/state';
import { setStoppedServingHook } from '../../src/bot/internalSetup/utils/servingGate';
import { applyOperatorDataWrite } from '../../src/bot/internalSetup/utils/ipcDataHandler';
import { MemClaimStore } from '../helpers/fakeClaimStore';

// Round 2 fixes of NB4: a 401 on the boot's re-fetch retires the claims, the TTL bound and the restart request run
// while page reads fail, the deferral's rest is shown from u', and the panel's namespace delete and graveyard restore
// ask whether this process stopped serving.

const T = claimTimings(30);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setStoppedServingHook(null);
  h.setState = null;
  h.restores = 0;
  h.deletes = 0;
});

function rig(over: Partial<ShardClaimsDeps> = {}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  const store = new MemClaimStore(() => Date.now());
  const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const calls = { restarts: [] as string[] };
  const state = { fit: null as string | null, restart: true };
  const claims = new ShardClaims({
    store,
    me: { processId: 'p-a', nodeId: 'node-a', nodeName: 'A' },
    timings: T,
    capacity: 4,
    takeoverSeconds: 30,
    returns: true,
    restartable: true,
    startedAt: 0,
    fitness: () => state.fit,
    gateClosed: () => false,
    isStopping: () => false,
    stopServingStep: () => undefined,
    noteLapsed: () => undefined,
    noteLost: () => undefined,
    restartForShards: reason => { calls.restarts.push(reason); return state.restart; },
    log,
    ...over,
  });
  const lines = () => [...log.log.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls].map(c => String(c[0]));
  return { store, claims, calls, state, lines };
}

async function reservedShard3(r: ReturnType<typeof rig>) {
  r.claims.start();
  expect(await r.claims.firstRenewal()).toBe(true);
  await r.claims.bootTake(async () => 4);
  r.claims.noteGranted();
  Object.assign(r.store.rows.get('4:3')!, { released: false, holderProcess: 'p-dead', holderNode: 'node-dead', expiresUpMs: 0 });
  r.claims['held'] = r.claims['held'].filter((p: Pair) => p.shardId !== 3);
  await vi.advanceTimersByTimeAsync(T.renewMs);
  expect(r.claims.snapshot().reserved.map(p => p.shardId)).toEqual([3]);
}

describe('a reservation and its restart request while page reads fail (NB4-R2-RUN-2)', () => {
  it('a stale reservation is given up at TTL and leaves the renewal', async () => {
    const r = rig();
    r.state.restart = false;
    await reservedShard3(r);
    r.state.fit = 'a save is failing';
    r.store.readMode = Object.assign(new Error('canceling statement'), { code: '57014' });
    await vi.advanceTimersByTimeAsync(T.ttlMs + T.renewMs);
    expect(r.lines().some(l => l.startsWith('[Shards] Gave up the reservation of shard 3'))).toBe(true);
    expect(r.claims.snapshot().reserved).toEqual([]);
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.store.renewals.at(-1)!.pairs.map(p => p.shardId)).not.toContain(3);
  });

  it('the restart is asked once the process is fit, with no page read', async () => {
    const r = rig();
    r.state.restart = false;
    await reservedShard3(r);
    expect(r.claims.snapshot().restartWaiting).not.toBeNull();
    r.store.readMode = Object.assign(new Error('canceling statement'), { code: '57014' });
    r.state.restart = true;
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(r.claims.snapshot()).toMatchObject({ pendingRestart: 'take shard 3', restartWaiting: null });
    expect(r.claims.snapshot().pageReadError).toMatchObject({ kind: 'error', code: '57014' });
  });
});

describe("the deferral's rest is shown from u' (NB4-R2-RUN-3)", () => {
  const row: ClaimRow = {
    shardCount: 2, shardId: 0, claim: 5, holderProcess: 'p-old', holderNode: 'node-b', holderName: 'B', homeNode: 'node-b',
    released: false, reserved: false, takenAt: 0, renewedAt: 0, ttlMs: 30_000, expiresUpMs: 100_000, extended: false,
  };
  const holder: NodeRow = {
    nodeId: 'node-b', nodeName: 'B', processId: 'p-new', capacity: 1, takeoverSeconds: 30, fit: true, restartable: true,
    returns: true, seenAgoMs: 1000, healthyForMs: 1000,
  };

  it('judges the state on the stored clock and the rest on u', () => {
    expect(claimState(row, 0, holder, 105_000, 109_000)).toEqual({ state: 'expired-deferred', deferredMs: 21_000 });
    expect(claimState(row, 0, holder, 105_000)).toEqual({ state: 'expired-deferred', deferredMs: 25_000 });
    expect(claimState(row, 0, holder, 129_000, 131_000)).toEqual({ state: 'expired-deferred', deferredMs: 0 });
  });

  it('the fleet page shows the two times of one row from the same u', () => {
    vi.useFakeTimers({ toFake: ['performance', 'Date'] });
    const page = { shardCount: 1, upMs: 105_000, uPrimeMs: 109_000, rows: [{ ...row, renewedAgoMs: 0 }], nodes: [holder] };
    const claims = {
      snapshot: () => ({
        processId: 'p-a', held: [], reserved: [], page, pageReadAt: performance.now(), renewalError: null, pageReadError: null,
        pendingRestart: null, restartWaiting: null, returning: [], stopped: null, renewMs: T.renewMs,
      }),
    };
    const runtime = { getCurrent: () => null, shardStatuses: () => [], getStillConnected: () => [] };
    const ledger = { getRecommendation: () => null, getBudgetInfo: () => null };
    _setFleetStateSources({
      nodeId: 'node-a', nodeName: 'A', appVersion: '1', shardSource: 'discord', recommendedShards: null, recommendedAt: null,
      runtime: runtime as any, ingest: { getClient: () => null } as any, ledger: ledger as any, claims: claims as any,
    });
    const shown = getFleetState().claims[0];
    expect(shown).toMatchObject({ state: 'expired-deferred', expiredAgoMs: 9000, deferredMs: 21_000 });
    expect(shown.expiredAgoMs! + shown.deferredMs!).toBe(30_000);
  });
});

describe("the panel's namespace delete and graveyard restore after the claims lapsed (NB4-R2-2)", () => {
  it.each(['delete-namespace', 'restore-graveyard'] as const)('%s answers frozen and writes nothing once stoppedServing is true', async op => {
    setStoppedServingHook(() => true);
    const reply = await applyOperatorDataWrite({ guildId: '123', module: '', filename: '', op });
    expect(reply).toEqual({ ok: false, code: 'frozen' });
    expect(h.restores + h.deletes).toBe(0);
  });

  it('restore-graveyard answers frozen while the guild set is frozen-retained', async () => {
    h.setState = 'frozen-retained';
    const reply = await applyOperatorDataWrite({ guildId: '123', module: '', filename: '', op: 'restore-graveyard' });
    expect(reply).toEqual({ ok: false, code: 'frozen' });
    expect(h.restores).toBe(0);
  });

  it('both still run while the process serves', async () => {
    setStoppedServingHook(() => false);
    expect(await applyOperatorDataWrite({ guildId: '123', module: '', filename: '', op: 'restore-graveyard' })).toEqual({ ok: true });
    expect(await applyOperatorDataWrite({ guildId: '123', module: '', filename: '', op: 'delete-namespace' })).toEqual({ ok: true });
    expect(h.restores).toBe(1);
    expect(h.deletes).toBe(1);
  });
});

describe("a 401 on the boot's re-fetch retires the claims (NB4-R2-1, NB4-R2-RUN-1)", () => {
  it('writes one last heartbeat with fit false, stops renewing, releases and runs no shard', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
    const store = new MemClaimStore(() => Date.now());
    _setClaimStoreFactory(() => store);
    h.gateway.push({ info: null, error: 'connect ECONNRESET' }, { info: null, error: 'connect ECONNRESET' }, { info: null, error: 'HTTP 401' });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const boot = bootShards();
    let done = false;
    void boot.then(() => { done = true; });
    for (let i = 0; i < 10 && !done; i++) await vi.advanceTimersByTimeAsync(T.renewMs);
    const ctx = await boot;
    expect(ctx.shardCount).toBe(0);
    expect(errors.mock.calls.filter(c => c[0] === TOKEN_REFUSED_LINE)).toHaveLength(1);
    expect(store.takes.length).toBeGreaterThan(0);
    expect(store.renewals.at(-1)!.heartbeat.fit).toBe(false);
    expect(store.nodes.get('node-a')!.fit).toBe(false);
    expect(store.releases).toHaveLength(1);
    expect(getShardClaims()).toBeNull();
    const renewals = store.renewals.length;
    await vi.advanceTimersByTimeAsync(3 * T.renewMs);
    expect(store.renewals.length).toBe(renewals);
    _setClaimStoreFactory(null);
  });
});
