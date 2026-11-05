import { afterEach, describe, expect, it, vi } from 'vitest';

import { LeaseRuntime } from '../../src/bot/internalSetup/fleet/leaseRuntime';
import { IngestService } from '../../src/bot/internalSetup/ingest/ingestService';
import { setStoppedServingHook } from '../../src/bot/internalSetup/utils/servingGate';
import { initDataReadiness, type DataReadinessDriver } from '../../src/bot/internalSetup/utils/dataBackends/dataReadiness';
import { initWorkingSet } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { admitGuildAction } from '../../src/bot/internalSetup/utils/dataBackends/boot';
import { FakeStore } from '../helpers/fakeStore';
import { setBackendKind } from '../helpers/backendKind';

// NB4 decisions 16 and 19: no login without a lease; the stop-serving step stops the gateway at once, bounded at
// TTL / 3; an empty plan writes no shards into the Client.

const drivers: DataReadinessDriver[] = [];

afterEach(() => {
  for (const driver of drivers.splice(0)) driver.stop();
  setBackendKind(null);
  setStoppedServingHook(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fakeIngest() {
  const state = { started: false, plans: [] as Array<{ shards: number[]; shardCount: number }>, starts: 0, stops: [] as string[], stopHangs: false };
  const ingest = {
    setShardPlan: (shards: number[], shardCount: number) => { state.plans.push({ shards: [...shards], shardCount }); },
    isStarted: () => state.started,
    start: vi.fn(async () => { state.starts += 1; state.started = true; return 'ok'; }),
    stop: vi.fn(async (reason: string) => {
      state.stops.push(reason);
      if (state.stopHangs) await new Promise(() => undefined);
      state.started = false;
    }),
    getClient: () => null,
  };
  return { ingest: ingest as unknown as IngestService, state };
}

const lease = (shardId: number, claim: number) => ({ leaseId: `l${shardId}`, shardId, claim });

describe('the gated login', () => {
  it('an empty set logs in nothing, also when the token comes later', async () => {
    const { ingest, state } = fakeIngest();
    const runtime = new LeaseRuntime(ingest);
    await runtime.applyGrant({ processId: 'p', shardCount: 4, leases: [] });
    runtime.setToken('t');
    expect(state.starts).toBe(0);
  });

  it('a held set logs in once the token comes', async () => {
    const { ingest, state } = fakeIngest();
    const runtime = new LeaseRuntime(ingest);
    await runtime.applyGrant({ processId: 'p', shardCount: 4, leases: [lease(1, 5)] });
    runtime.setToken('t');
    expect(state.starts).toBe(1);
  });

  it('a pair past D at the login logs in nothing', async () => {
    const { ingest, state } = fakeIngest();
    const runtime = new LeaseRuntime(ingest);
    setStoppedServingHook(() => true);
    await runtime.applyGrant({ processId: 'p', shardCount: 4, leases: [lease(1, 5)] });
    runtime.setToken('t');
    expect(state.starts).toBe(0);
  });
});

describe('the stop-serving step', () => {
  it('empties the lease and stops the gateway at once, with no debounce; a later setToken logs in nothing', async () => {
    vi.useFakeTimers();
    const { ingest, state } = fakeIngest();
    const runtime = new LeaseRuntime(ingest);
    await runtime.applyGrant({ processId: 'p', shardCount: 4, leases: [lease(1, 5), lease(2, 6)] });
    runtime.setToken('t');
    runtime.stopServing(10_000);
    expect(state.stops).toEqual(['this process stopped serving its shards']);
    expect(runtime.getCurrent()!.leases).toEqual([]);
    expect(state.plans.at(-1)).toEqual({ shards: [], shardCount: 4 });
    runtime.setToken('t');
    expect(state.starts).toBe(1);
  });

  it('a gateway stop that does not settle within TTL / 3 reports its shards as maybe still connected', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ingest, state } = fakeIngest();
    const runtime = new LeaseRuntime(ingest);
    await runtime.applyGrant({ processId: 'p', shardCount: 4, leases: [lease(3, 5)] });
    runtime.setToken('t');
    state.stopHangs = true;
    runtime.stopServing(10_000);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(runtime.getStillConnected()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(runtime.getStillConnected()).toEqual([3]);
    expect(error.mock.calls.map(c => String(c[0]))).toContain('[Shards] Shard 3 may still be connected to Discord');
  });
});

describe('the Client with no shard set', () => {
  it('an empty plan writes neither shards nor shardCount into the built Client', () => {
    const control = new IngestService().buildClient({ intents: [] });
    const ingest = new IngestService();
    ingest.setShardPlan([], 4);
    const client = ingest.buildClient({ intents: [] });
    expect((client.options as any).shards).toEqual((control.options as any).shards);
    expect((client.options as any).shardCount).toEqual((control.options as any).shardCount);
    void client.destroy();
    void control.destroy();
  });
});

describe('the stop-serving step down to the data layer (NB4-R6-T1, decision 17)', () => {
  // Shard count 4: both guilds are on shard 1.
  const G1 = String(1n << 22n);
  const G5 = String(5n << 22n);

  async function servedShard1() {
    setBackendKind('postgres');
    const store = new FakeStore();
    const ws = initWorkingSet(store);
    const driver = initDataReadiness(store, ws, { held: false });
    drivers.push(driver);
    const { ingest } = fakeIngest();
    const runtime = new LeaseRuntime(ingest);
    await runtime.applyGrant({ processId: 'p', shardCount: 4, leases: [lease(1, 5)] });
    runtime.setToken('t');
    expect(driver.causeOf(G1, 0)).toBe('loading');
    await vi.waitFor(() => expect(ws.stateOf(G1)).toBe('ready'));
    return { store, ws, driver, runtime };
  }

  it('freezes the ready set in the same call and flushes its unsaved write under the old claim, before any debounce', async () => {
    const { store, ws, runtime } = await servedShard1();
    expect(ws.save(G1, 'm', 'a.json', '{"v":1}')).toBe('accepted');
    expect(store.commits).toHaveLength(0);
    runtime.stopServing(10_000);
    expect(ws.stateOf(G1)).toBe('frozen-retained');
    expect(ws.save(G1, 'm', 'b.json', '{"v":2}')).not.toBe('accepted');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(store.commits).toHaveLength(1);
    expect(store.commits[0].token.claim).toBe(5);
    expect(store.commits[0].token.shardId).toBe(1);
    expect(store.doc(G1, 'a.json')).toBe('{"v":1}');
    expect(store.doc(G1, 'b.json')).toBeUndefined();
    expect(ws.stateOf(G1)).toBe('frozen-retained');
  });

  it('a hold on a guild of the shard whose set is still hydrating answers not-served at its deadline, not loading', async () => {
    const { store, ws, runtime } = await servedShard1();
    store.hydrateMode = 'held';
    const hold = admitGuildAction(G5, performance.now() + 400);
    await vi.waitFor(() => expect(ws.stateOf(G5)).toBe('hydrating'));
    runtime.stopServing(10_000);
    expect(await hold).toEqual({ cause: 'not-served', mark: null });
    store.releaseHydrations('ok');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(ws.stateOf(G5)).not.toBe('ready');
  });
});
