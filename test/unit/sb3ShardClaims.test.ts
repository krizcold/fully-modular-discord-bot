import { afterEach, describe, expect, it, vi } from 'vitest';

import { ShardClaims, type ShardClaimsDeps } from '../../src/bot/internalSetup/fleet/shardClaims';
import { MemClaimStore } from '../helpers/fakeClaimStore';
import { AT, OLD, T, standbyStore } from '../helpers/standbyRig';

const ME = { processId: 'p-sb3', nodeId: OLD.nodeId, nodeName: OLD.nodeName };

function build(store: MemClaimStore, clock: { shift: number }, over: Partial<ShardClaimsDeps> = {}) {
  const lines: string[] = [];
  const ends: unknown[] = [];
  const put = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  const claims = new ShardClaims({
    store, me: ME, timings: T, capacity: 4, takeoverSeconds: 30, returns: false, restartable: true, startedAt: 0,
    clocks: () => ({ perf: performance.now() + clock.shift, wall: Date.now() + clock.shift }),
    fitness: () => null, gateClosed: () => false, isStopping: () => false, stopServingStep: () => undefined,
    noteLapsed: () => undefined, noteLost: () => undefined, restartForShards: () => true, countSetting: () => null,
    reshardOverlap: () => true, log: { log: put, warn: put, error: put },
    standby: { attempt: AT, count: 8, onEnd: end => { ends.push(end); } },
    ...over,
  });
  return { claims, lines, ends };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a standby's lapse disarms the deadline", () => {
  it('ends the standby as failed and leaves no timer armed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const store = standbyStore(4, 8);
    const clock = { shift: 0 };
    const r = build(store, clock);
    expect(await r.claims.firstRenewal()).toBe(true);
    const took = await r.claims.standbyTake();
    expect(took?.pairs.length).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBe(1);
    clock.shift = T.deadlineMs + 1000;
    expect(r.claims.stoppedServing()).toBe(true);
    expect(r.ends).toEqual([{ kind: 'failed', cause: `no claim renewal for ${Math.round((T.deadlineMs + 1000) / 1000)} s` }]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the standby take's failure line", () => {
  it('is logged at the first failure and again only once 30 s passed since the last line', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const store = standbyStore(4, 8);
    const clock = { shift: 0 };
    const r = build(store, clock);
    const real = store.standbyTake.bind(store);
    const at = [0, 10_000, 29_999, 30_000];
    let calls = 0;
    vi.spyOn(store, 'standbyTake').mockImplementation(async (request, onBegin) => {
      if (calls < at.length) {
        clock.shift = at[calls++];
        throw new Error('connection reset');
      }
      return real(request, onBegin);
    });
    const take = r.claims.standbyTake();
    for (let i = 0; i < at.length; i++) await vi.advanceTimersByTimeAsync(T.renewMs);
    const took = await take;
    expect(took?.pairs.length).toBeGreaterThan(0);
    expect(calls).toBe(at.length);
    const failures = r.lines.filter(l => l.startsWith('[Shards] Cannot take shards yet: the take failed'));
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatch(/; retrying every 5 s$/);
  });
});
