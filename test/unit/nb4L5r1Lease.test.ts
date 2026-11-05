import { afterEach, describe, expect, it, vi } from 'vitest';

import { LeaseRuntime } from '../../src/bot/internalSetup/fleet/leaseRuntime';
import type { IngestService } from '../../src/bot/internalSetup/ingest/ingestService';
import { setStoppedServingHook } from '../../src/bot/internalSetup/utils/servingGate';

// NB4 decision 16: the stop-serving step stops the gateway on any timer handle, and once the stop settled it leaves
// no bound timer armed.

afterEach(() => {
  setStoppedServingHook(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fakeIngest() {
  const state = { started: false, stops: [] as string[] };
  const ingest = {
    setShardPlan: () => undefined,
    isStarted: () => state.started,
    start: async () => { state.started = true; return 'ok'; },
    stop: async (reason: string) => { state.stops.push(reason); state.started = false; },
    getClient: () => null,
  };
  return { ingest: ingest as unknown as IngestService, state };
}

const lease = (shardId: number, claim: number) => ({ leaseId: `l${shardId}`, shardId, claim });
const STOP_REASON = 'this process stopped serving its shards';

describe('the stop-serving step', () => {
  it('stops the gateway when the timer handle has no unref', async () => {
    const { ingest, state } = fakeIngest();
    const runtime = new LeaseRuntime(ingest);
    await runtime.applyGrant({ processId: 'p', shardCount: 4, leases: [lease(1, 5)] });
    runtime.setToken('t');
    await Promise.resolve();
    expect(state.started).toBe(true);
    vi.stubGlobal('setTimeout', () => 1);
    expect(() => runtime.stopServing(10_000)).not.toThrow();
    vi.unstubAllGlobals();
    await new Promise(resolve => setImmediate(resolve));
    expect(state.stops).toEqual([STOP_REASON]);
    expect(state.started).toBe(false);
  });

  it('leaves no bound timer armed once the gateway stop settled', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { ingest, state } = fakeIngest();
    const runtime = new LeaseRuntime(ingest);
    await runtime.applyGrant({ processId: 'p', shardCount: 4, leases: [lease(1, 5)] });
    runtime.setToken('t');
    await vi.advanceTimersByTimeAsync(0);
    expect(state.started).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    runtime.stopServing(10_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.stops).toEqual([STOP_REASON]);
    expect(vi.getTimerCount()).toBe(0);
    expect(runtime.getStillConnected()).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });
});
