import { afterEach, describe, expect, it, vi } from 'vitest';

import { LeaseRuntime } from '../../src/bot/internalSetup/fleet/leaseRuntime';
import type { IngestService } from '../../src/bot/internalSetup/ingest/ingestService';
import { setStoppedServingHook } from '../../src/bot/internalSetup/utils/servingGate';

// NB4 decision 16: the stop-serving step stops a running gateway at once; a pending rebuild never runs after it, a
// gateway that never started is not stopped, a failed stop is logged, and a stop that settles clears the
// maybe-still-connected report.

afterEach(() => {
  setStoppedServingHook(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fakeIngest() {
  const state = {
    started: false,
    starts: 0,
    stops: [] as string[],
    stopResult: null as null | (() => Promise<void>),
  };
  const ingest = {
    setShardPlan: () => undefined,
    isStarted: () => state.started,
    start: async () => { state.starts += 1; state.started = true; return 'ok'; },
    stop: async (reason: string) => {
      state.stops.push(reason);
      if (state.stopResult) await state.stopResult();
      state.started = false;
    },
    getClient: () => null,
  };
  return { ingest: ingest as unknown as IngestService, state };
}

const lease = (shardId: number, claim: number) => ({ leaseId: `l${shardId}`, shardId, claim });
const STOP_REASON = 'this process stopped serving its shards';

describe('the stop-serving step', () => {
  it('a gateway rebuild still pending from a lease change never runs after the stop', async () => {
    vi.useFakeTimers();
    const { ingest, state } = fakeIngest();
    const runtime = new LeaseRuntime(ingest);
    await runtime.applyGrant({ processId: 'p', shardCount: 4, leases: [lease(1, 5)] });
    runtime.setToken('t');
    expect(state.started).toBe(true);
    await runtime.applyGrant({ processId: 'p', shardCount: 4, leases: [lease(1, 5), lease(2, 6)] });
    runtime.stopServing(10_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(state.stops).toEqual([STOP_REASON]);
    expect(state.starts).toBe(1);
    expect(state.started).toBe(false);
  });

  it('a gateway that never started is not stopped and nothing is reported as maybe still connected', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { ingest, state } = fakeIngest();
    const runtime = new LeaseRuntime(ingest);
    await runtime.applyGrant({ processId: 'p', shardCount: 4, leases: [lease(1, 5)] });
    expect(state.started).toBe(false);
    runtime.stopServing(10_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(state.stops).toEqual([]);
    expect(runtime.getStillConnected()).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });

  it('a gateway stop that fails is logged with its error', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { ingest, state } = fakeIngest();
    const runtime = new LeaseRuntime(ingest);
    await runtime.applyGrant({ processId: 'p', shardCount: 4, leases: [lease(1, 5)] });
    runtime.setToken('t');
    const failure = new Error('gateway would not close');
    state.stopResult = async () => { throw failure; };
    runtime.stopServing(10_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(error.mock.calls).toEqual([['[Shards] Could not stop the gateway:', failure]]);
  });

  it('a stop that settles within the bound reports no shard as maybe still connected, also once the bound passes', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { ingest } = fakeIngest();
    const runtime = new LeaseRuntime(ingest);
    await runtime.applyGrant({ processId: 'p', shardCount: 4, leases: [lease(3, 5)] });
    runtime.setToken('t');
    runtime.stopServing(10_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(runtime.getStillConnected()).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });

  it('a stop that settles after the bound clears its maybe-still-connected report', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { ingest, state } = fakeIngest();
    const runtime = new LeaseRuntime(ingest);
    await runtime.applyGrant({ processId: 'p', shardCount: 4, leases: [lease(3, 5)] });
    runtime.setToken('t');
    let settle: () => void = () => undefined;
    state.stopResult = () => new Promise<void>(resolve => { settle = resolve; });
    runtime.stopServing(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runtime.getStillConnected()).toEqual([3]);
    settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.getStillConnected()).toEqual([]);
  });
});
