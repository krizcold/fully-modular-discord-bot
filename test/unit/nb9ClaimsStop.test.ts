import { afterEach, describe, expect, it, vi } from 'vitest';

import { ShardClaims } from '../../src/bot/internalSetup/fleet/shardClaims';
import { ClaimTimeoutError } from '../../src/bot/internalSetup/fleet/claimStore';
import { claimTimings, type ClaimRow, type Pair } from '../../src/bot/internalSetup/fleet/claimRules';
import { MemClaimStore } from '../helpers/fakeClaimStore';

// NB9 test 27, part 4a's rows (D2, E5): the release of a promoted standby's serve lanes before and after its redraw.
// The store holds the rows the standby's take wrote (holder = the process id, count W, live, not released); the serve
// lanes' ShardClaims is built with fromStandby and taken's pairs, as bootShards({ taken }) builds it. The claimsStop
// order rows are part 4b's.

const T = claimTimings(30);
const ME = { processId: 'p-standby', nodeId: 'n-a', nodeName: 'A' };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function standbyRow(shardId: number, claim: number): ClaimRow {
  return {
    shardCount: 2, shardId, claim, holderProcess: ME.processId, holderNode: ME.nodeId, holderName: 'A', homeNode: ME.nodeId,
    released: false, reserved: false, takenAt: 0, renewedAt: 0, ttlMs: T.ttlMs, expiresUpMs: 10_000_000, extended: false,
  };
}

function serveLanes() {
  const store = new MemClaimStore(() => Date.now());
  store.count = 2;
  store.rows.set('2:0', standbyRow(0, 70));
  store.rows.set('2:1', standbyRow(1, 71));
  const pairs: Pair[] = [{ shardCount: 2, shardId: 0, claim: 70 }, { shardCount: 2, shardId: 1, claim: 71 }];
  const lines: string[] = [];
  const log = { log: (l: string) => lines.push(l), warn: (l: string) => lines.push(l), error: (l: string) => lines.push(l) };
  const claims = new ShardClaims({
    store, me: ME, timings: T, capacity: 4, takeoverSeconds: 30, returns: false, restartable: true, startedAt: 0,
    fitness: () => null, gateClosed: () => false, isStopping: () => false, stopServingStep: () => undefined,
    noteLapsed: () => undefined, noteLost: () => undefined, restartForShards: () => true, countSetting: () => null, log,
    fromStandby: true, standbyPairs: pairs,
  });
  return { store, claims, lines };
}

describe('test 27: the release of a promoted standby before its redraw (D2, E5)', () => {
  it("D2: a stop before the redraw sends one release with this process's id; the standby's rows read released and kept, and the kept line names them", async () => {
    const r = serveLanes();
    await r.claims.finishStop();
    expect(r.store.releases).toHaveLength(1);
    expect(r.store.releases[0].me.processId).toBe(ME.processId);
    for (const s of [0, 1]) expect(r.store.rows.get(`2:${s}`)).toMatchObject({ released: true, holderNode: ME.nodeId });
    expect(r.lines).toEqual(["[Shards] Released shards 0, 1: kept for this machine's next start for 30 s, then free to any machine with room"]);
  });

  it("E5: a release whose COMMIT gets no answer names taken's shards in the can't-confirm form", async () => {
    const r = serveLanes();
    r.store.releaseFailsAt = 'commit';
    r.store.releaseMode = new ClaimTimeoutError('the release');
    await r.claims.finishStop();
    expect(r.lines).toEqual(['[Shards] The release of shards 0, 1 got no answer within 2 s (timeout); it may still have applied, and otherwise any machine with room may take them once their claims expire']);
  });

  it('E5: a release that fails outright names them in the failure form', async () => {
    const r = serveLanes();
    r.store.releaseFailsAt = 'statement';
    r.store.releaseMode = Object.assign(new Error('could not serialize access'), { code: '40001' });
    await r.claims.finishStop();
    expect(r.lines).toEqual(['[Shards] Could not release shards 0, 1 (SQLSTATE 40001 could not serialize access); any machine with room may take them once their claims expire']);
  });

  it("E5: after a redraw whose COMMIT landed and whose answer was lost, a release that answers the shards released logs only the release line for each", async () => {
    const r = serveLanes();
    // The redraw's COMMIT landed: each row holds its new claim; the process never recorded the answer.
    r.store.rows.get('2:0')!.claim = 90;
    r.store.rows.get('2:1')!.claim = 91;
    await r.claims.finishStop();
    expect(r.lines).toEqual(["[Shards] Released shards 0, 1: kept for this machine's next start for 30 s, then free to any machine with room"]);
  });
});
