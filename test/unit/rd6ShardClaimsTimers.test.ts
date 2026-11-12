import { afterEach, describe, expect, it, vi } from 'vitest';

import { ShardClaims, type ShardClaimsDeps } from '../../src/bot/internalSetup/fleet/shardClaims';
import { MemClaimStore } from '../helpers/fakeClaimStore';
import { AT, OLD, T, standbyStore } from '../helpers/standbyRig';

const ME = { processId: 'p-rd6', nodeId: 'n-rd6', nodeName: 'R' };

function build(store: MemClaimStore, over: Partial<ShardClaimsDeps> = {}) {
  const lines: string[] = [];
  const put = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  const claims = new ShardClaims({
    store, me: ME, timings: T, capacity: 4, takeoverSeconds: 30, returns: false, restartable: true, startedAt: 0,
    fitness: () => null, gateClosed: () => false, isStopping: () => false, stopServingStep: () => undefined,
    noteLapsed: () => undefined, noteLost: () => undefined, restartForShards: () => true, countSetting: () => null,
    reshardOverlap: () => true, log: { log: put, warn: put, error: put }, ...over,
  });
  return { claims, lines };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("rd6 a standby's loss disarms the deadline", () => {
  it('leaves no timer armed once the loss ended the standby', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const store = standbyStore(4, 8);
    const ends: unknown[] = [];
    const r = build(store, { me: { ...ME, nodeId: OLD.nodeId, nodeName: OLD.nodeName }, standby: { attempt: AT, count: 8, onEnd: end => { ends.push(end); } } });
    expect(await r.claims.firstRenewal()).toBe(true);
    const took = await r.claims.standbyTake();
    expect(took?.pairs.length).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBe(1);
    const shard = took!.pairs[0].shardId;
    store.rows.get(`8:${shard}`)!.holderProcess = 'p-other';
    await r.claims.renewOnce();
    expect(ends).toEqual([{ kind: 'failed', cause: `shard ${shard}'s claim is no longer this process's` }]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('rd6 the renewal lane sends nothing while the claims are paused', () => {
  it('sends no renewal after the database stop, on a call or on the lane timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const store = new MemClaimStore(() => Date.now());
    store.count = 2;
    const r = build(store);
    expect(await r.claims.firstRenewal()).toBe(true);
    const renew = vi.spyOn(store, 'renew');
    r.claims.start();
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(renew).toHaveBeenCalledTimes(1);
    r.claims.stopServingForDatabase('the disk is full');
    await r.claims.renewOnce();
    await vi.advanceTimersByTimeAsync(T.renewMs * 3);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(r.claims.snapshot().renewalError).toBeNull();
    await r.claims.stopLanes();
  });
});
