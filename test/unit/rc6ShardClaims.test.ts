import { describe, expect, it } from 'vitest';

import { ShardClaims, type ShardClaimsDeps } from '../../src/bot/internalSetup/fleet/shardClaims';
import { MemClaimStore } from '../helpers/fakeClaimStore';
import { AT, OLD, T, standbyStore } from '../helpers/standbyRig';

const ME = { processId: 'p-rc6', nodeId: 'n-rc6', nodeName: 'R' };

function build(store: MemClaimStore, over: Partial<ShardClaimsDeps> = {}) {
  const lines: string[] = [];
  const put = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  let stopSteps = 0;
  const claims = new ShardClaims({
    store, me: ME, timings: T, capacity: 4, takeoverSeconds: 30, returns: false, restartable: true, startedAt: 0,
    fitness: () => null, gateClosed: () => false, isStopping: () => false, stopServingStep: () => { stopSteps += 1; },
    noteLapsed: () => undefined, noteLost: () => undefined, restartForShards: () => true, countSetting: () => null,
    reshardOverlap: () => true, log: { log: put, warn: put, error: put }, ...over,
  });
  return { claims, lines, stopSteps: () => stopSteps };
}

describe("rc6 the release names a standby's pairs only for promoted serve lanes", () => {
  it('a process not built from a standby names only the shards it took', async () => {
    const store = new MemClaimStore(() => Date.now());
    store.count = 2;
    const r = build(store, { standbyPairs: [{ shardCount: 8, shardId: 7, claim: 99 }] });
    const took = await r.claims.bootTake(async () => 2);
    expect(took?.pairs.map(p => p.shardId)).toEqual([0, 1]);
    const before = r.lines.length;
    await r.claims.finishStop();
    expect(r.lines.slice(before)).toEqual([
      "[Shards] Released shards 0, 1: kept for this machine's next start for 30 s, then free to any machine with room",
    ]);
  });
});

describe('rc6 the stop-serving step for a reshard runs once', () => {
  it('answers true the first time and false after, running the step once', () => {
    const r = build(new MemClaimStore(() => Date.now()));
    expect(r.claims.stopServingForReshard()).toBe(true);
    expect(r.claims.snapshot().stopped).toBe('reshard');
    expect(r.claims.stopServingForReshard()).toBe(false);
    expect(r.stopSteps()).toBe(1);
  });
});

describe("rc6 a standby's loss", () => {
  async function standby() {
    const store = standbyStore(4, 8);
    const ends: unknown[] = [];
    const r = build(store, { me: { ...ME, nodeId: OLD.nodeId, nodeName: OLD.nodeName }, standby: { attempt: AT, count: 8, onEnd: end => { ends.push(end); } } });
    expect(await r.claims.firstRenewal()).toBe(true);
    const took = await r.claims.standbyTake();
    expect(took?.pairs.length).toBeGreaterThan(0);
    return { ...r, store, ends, took: took! };
  }

  it("marks the claims stopped by the loss", async () => {
    const s = await standby();
    const shard = s.took.pairs[0].shardId;
    s.store.rows.get(`8:${shard}`)!.holderProcess = 'p-other';
    await s.claims.renewOnce();
    expect(s.ends).toEqual([{ kind: 'failed', cause: `shard ${shard}'s claim is no longer this process's` }]);
    expect(s.claims.snapshot().stopped).toBe('loss');
    await s.claims.stopLanes();
  });

  it('keeps the earlier stop reason when it already stopped serving', async () => {
    const s = await standby();
    expect(s.claims.stopServingForReshard()).toBe(true);
    const shard = s.took.pairs[0].shardId;
    s.store.rows.get(`8:${shard}`)!.holderProcess = 'p-other';
    await s.claims.renewOnce();
    expect(s.ends).toEqual([{ kind: 'failed', cause: `shard ${shard}'s claim is no longer this process's` }]);
    expect(s.claims.snapshot().stopped).toBe('reshard');
    await s.claims.stopLanes();
  });
});
