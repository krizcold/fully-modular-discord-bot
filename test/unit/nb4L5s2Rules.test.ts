import { describe, expect, it } from 'vitest';

import {
  aboveReason,
  claimState,
  decideShardCount,
  planReturns,
  planTake,
  type ClaimRow,
  type Me,
  type NodeRow,
} from '../../src/bot/internalSetup/fleet/claimRules';

// NB4 decisions 10, 11, 13 and 21 over the pure claim rules: the take's order and its no-room count, the count a take
// runs under, the shards a stop hands over, and the state and above-target reason the operator sees.

const ME: Me = { processId: 'pA', nodeId: 'A', nodeName: 'alpha' };
const UP = 100_000;

function row(shardId: number, over: Partial<ClaimRow> = {}): ClaimRow {
  return {
    shardCount: 4,
    shardId,
    claim: 1,
    holderProcess: 'pB',
    holderNode: 'B',
    holderName: 'beta',
    homeNode: 'B',
    released: false,
    reserved: false,
    takenAt: 0,
    renewedAt: 0,
    ttlMs: 30_000,
    expiresUpMs: 0,
    extended: false,
    ...over,
  };
}

function node(nodeId: string, over: Partial<NodeRow> = {}): NodeRow {
  return {
    nodeId,
    nodeName: `n-${nodeId}`,
    processId: `p${nodeId}`,
    capacity: 5,
    takeoverSeconds: 30,
    fit: true,
    restartable: true,
    returns: true,
    seenAgoMs: 1000,
    healthyForMs: 400_000,
    ...over,
  };
}

const takeIds = (takes: Array<{ shardId: number; above: string | null }>) => takes.map(t => [t.shardId, t.above]);

describe('nb4L5s2 planTake order and no-room count', () => {
  it('takes a shard homed on this machine before lower shards homed elsewhere', () => {
    const rows = [row(0), row(1), row(2), row(3, { homeNode: 'A' })];
    const plan = planTake({ me: ME, capacity: 1, boot: false, known: [], shardCount: 4, rows, nodes: [], upMs: UP, uPrimeMs: UP });
    expect(takeIds(plan.takes)).toEqual([[3, null], [0, 'no-room'], [1, 'no-room'], [2, 'no-room']]);
    expect(plan.leftToOthers).toBe(0);
  });

  it('takes above the target only what other fit machines have no room for, lowest shards first', () => {
    const rows = [row(0), row(1), row(2, { homeNode: 'A' })];
    const nodes = [
      node('A', { capacity: 5 }),
      node('C', { capacity: 1 }),
      node('D', { capacity: 5, fit: false }),
    ];
    const plan = planTake({ me: ME, capacity: 0, boot: false, known: [], shardCount: 3, rows, nodes, upMs: UP, uPrimeMs: UP });
    expect(takeIds(plan.takes)).toEqual([[0, 'no-room'], [1, 'no-room']]);
    expect(plan.leftToOthers).toBe(1);
  });
});

describe('nb4L5s2 decideShardCount', () => {
  const live = row(0, { expiresUpMs: UP + 10_000 });
  const releasedLive = row(1, { released: true, expiresUpMs: UP + 10_000 });

  it('writes the local count and deletes other counts when none is stored', () => {
    expect(decideShardCount(null, 4, [], UP)).toEqual({ kind: 'use', count: 4, write: true, deleteOthers: true, adopted: null });
  });

  it('uses the stored count unchanged when the local one matches, even with live rows', () => {
    expect(decideShardCount(4, 4, [live], UP)).toEqual({ kind: 'use', count: 4, write: false, deleteOthers: false, adopted: null });
  });

  it('uses the stored count unchanged when no local count is set', () => {
    expect(decideShardCount(4, null, [], UP)).toEqual({ kind: 'use', count: 4, write: false, deleteOthers: false, adopted: null });
  });

  it('keeps the stored count while one row is live, even beside a released row', () => {
    expect(decideShardCount(4, 6, [live, releasedLive], UP)).toEqual({ kind: 'use', count: 4, write: false, deleteOthers: false, adopted: { local: 6 } });
  });

  it('switches to the local count when the only unexpired row is released', () => {
    expect(decideShardCount(4, 6, [releasedLive], UP)).toEqual({ kind: 'use', count: 6, write: true, deleteOthers: true, adopted: null });
  });
});

describe('nb4L5s2 planReturns', () => {
  const mine = (shardId: number, homeNode: string) => row(shardId, { holderProcess: 'pA', holderNode: 'A', homeNode, expiresUpMs: UP + 10_000 });
  const pair = (shardId: number) => ({ shardCount: 4, shardId, claim: 1 });

  it('never names this machine as the receiver of a move', () => {
    const rows = [mine(0, 'A'), mine(1, 'A')];
    const nodes = [node('A', { capacity: 10 }), node('B', { capacity: 10 })];
    expect(planReturns({ me: ME, capacity: 1, held: [pair(0), pair(1)], rows, nodes, upMs: UP }))
      .toEqual([{ shardId: 1, receiver: 'B', move: true }]);
  });

  it('returns the lowest shard first and no more than the home machine has room for', () => {
    const rows = [mine(1, 'B'), mine(3, 'B')];
    const nodes = [node('B', { capacity: 1 })];
    expect(planReturns({ me: ME, capacity: 10, held: [pair(3), pair(1)], rows, nodes, upMs: UP }))
      .toEqual([{ shardId: 1, receiver: 'B', move: false }]);
  });

  it('does not move a shard it already returned home', () => {
    const rows = [mine(0, 'B'), mine(1, 'B')];
    const nodes = [node('B', { capacity: 5 })];
    expect(planReturns({ me: ME, capacity: 1, held: [pair(0), pair(1)], rows, nodes, upMs: UP }))
      .toEqual([{ shardId: 0, receiver: 'B', move: false }, { shardId: 1, receiver: 'B', move: false }]);
  });

  it('moves nothing when the shards left after returns fit the capacity', () => {
    const rows = [mine(0, 'B'), mine(1, 'A')];
    const nodes = [node('B', { capacity: 5 })];
    expect(planReturns({ me: ME, capacity: 2, held: [pair(0), pair(1)], rows, nodes, upMs: UP }))
      .toEqual([{ shardId: 0, receiver: 'B', move: false }]);
  });

  it('moves the highest own shard after a return, never the returned one again', () => {
    const rows = [mine(0, 'B'), mine(1, 'A'), mine(2, 'A')];
    const nodes = [node('B', { capacity: 5 })];
    expect(planReturns({ me: ME, capacity: 1, held: [pair(0), pair(1), pair(2)], rows, nodes, upMs: UP }))
      .toEqual([{ shardId: 0, receiver: 'B', move: false }, { shardId: 2, receiver: 'B', move: true }]);
  });

  it('moves shards homed elsewhere first, then the highest own shard', () => {
    const rows = [mine(0, 'C'), mine(1, 'A'), mine(2, 'A')];
    const nodes = [node('B', { capacity: 5 })];
    expect(planReturns({ me: ME, capacity: 1, held: [pair(1), pair(2), pair(0)], rows, nodes, upMs: UP }))
      .toEqual([{ shardId: 0, receiver: 'B', move: true }, { shardId: 2, receiver: 'B', move: true }]);
  });
});

describe('nb4L5s2 claimState', () => {
  it('shows expired when the holder node still runs the process that let it expire', () => {
    const r = row(0, { expiresUpMs: UP - 1000 });
    expect(claimState(r, 0, node('B', { processId: 'pB' }), UP)).toEqual({ state: 'expired' });
  });

  it('shows expired once the deferral after a holder restart has run out', () => {
    const holder = node('B', { processId: 'pB2' });
    expect(claimState(row(0, { expiresUpMs: UP - 40_000 }), 0, holder, UP)).toEqual({ state: 'expired' });
    expect(claimState(row(0, { expiresUpMs: UP - 30_000 }), 0, holder, UP)).toEqual({ state: 'expired' });
    expect(claimState(row(0, { expiresUpMs: UP - 29_999 }), 0, holder, UP)).toEqual({ state: 'expired-deferred', deferredMs: 1 });
  });

  it('shows a reserve as kept once three renewals passed without one', () => {
    const long = row(0, { released: true, reserved: true, ttlMs: 60_000, expiresUpMs: UP + 1000 });
    expect(claimState(long, 20_000, undefined, UP)).toEqual({ state: 'kept' });
    expect(claimState(long, 14_000, undefined, UP)).toEqual({ state: 'reserved' });
    const short = row(0, { released: true, reserved: true, ttlMs: 6000, expiresUpMs: UP + 1000 });
    expect(claimState(short, 4000, undefined, UP)).toEqual({ state: 'kept' });
    expect(claimState(short, 2000, undefined, UP)).toEqual({ state: 'reserved' });
  });
});

describe('nb4L5s2 aboveReason', () => {
  it('never names the node itself as the receiver', () => {
    const self = node('X', { capacity: 2 });
    expect(aboveReason(self, [self], [], UP)).toEqual({ kind: 'no-room' });
  });

  it('does not wait on a machine that is not fit', () => {
    const self = node('X');
    const unfit = node('Y', { fit: false, restartable: true, healthyForMs: null, capacity: 2 });
    expect(aboveReason(self, [self, unfit], [], UP)).toEqual({ kind: 'no-room' });
  });
});
