import { describe, expect, it } from 'vitest';

import {
  applyRenewal,
  fenceAdmits,
  planTake,
  type ClaimRow,
  type FenceKey,
  type NodeRow,
  type TakeInput,
} from '../../src/bot/internalSetup/fleet/claimRules';

// NB4 decisions 8 and 10, and the clock rule of the renewal: which saves the fence admits, which rows a take takes,
// which it leaves to their own machine, and when a gap above the cap gives other rows their whole TTL again.

function row(over: Partial<ClaimRow> = {}): ClaimRow {
  return {
    shardCount: 4,
    shardId: 0,
    claim: 7,
    holderProcess: 'p-a',
    holderNode: 'node-a',
    holderName: 'alpha',
    homeNode: 'node-a',
    released: false,
    reserved: false,
    takenAt: 0,
    renewedAt: 0,
    ttlMs: 30_000,
    expiresUpMs: 200_000,
    extended: false,
    ...over,
  };
}

function node(over: Partial<NodeRow> = {}): NodeRow {
  return {
    nodeId: 'node-b',
    nodeName: 'bravo',
    processId: 'p-b2',
    capacity: 4,
    takeoverSeconds: 30,
    fit: true,
    restartable: true,
    returns: true,
    seenAgoMs: 1000,
    healthyForMs: 600_000,
    ...over,
  };
}

const me = { processId: 'p-me', nodeId: 'node-me', nodeName: 'mine' };

function input(over: Partial<TakeInput> = {}): TakeInput {
  return { me, capacity: 4, boot: false, known: [], shardCount: 1, rows: [], nodes: [], upMs: 100_000, uPrimeMs: 100_000, ...over };
}

const takenIds = (plan: ReturnType<typeof planTake>) => plan.takes.map(t => [t.shardId, t.above]);

describe('applyRenewal: the gap cap', () => {
  it('a gap exactly at the cap renews only my pairs and leaves other rows unextended', () => {
    const other = row({ holderProcess: 'p-other', expiresUpMs: 10_000, ttlMs: 15_000 });
    const res = applyRenewal([other], { upMs: 0, tickedAt: 0, lastGapMs: 0 }, 7500, 'p-me', [], 15_000);
    expect(res.clock).toEqual({ upMs: 7500, tickedAt: 7500, lastGapMs: 7500 });
    expect(res.returned).toEqual([]);
    expect(other.expiresUpMs).toBe(10_000);
    expect(other.extended).toBe(false);
  });
});

describe('fenceAdmits (decision 8)', () => {
  const token: FenceKey = { shardCount: 4, shardId: 2, claim: 7, processId: 'p-a' };
  const held = row({ shardId: 2 });

  it('admits a save under the row this process holds', () => {
    expect(fenceAdmits(held, token, undefined)).toBe(true);
    expect(fenceAdmits(held, token, 7)).toBe(true);
  });
  it('refuses a save when the shard has no row', () => {
    expect(fenceAdmits(undefined, token, undefined)).toBe(false);
  });
  it('refuses a save under another shard count', () => {
    expect(fenceAdmits(row({ shardId: 2, shardCount: 8 }), token, undefined)).toBe(false);
  });
  it('refuses a save under another shard id', () => {
    expect(fenceAdmits(row({ shardId: 3 }), { ...token, shardId: 2 }, undefined)).toBe(false);
  });
  it('refuses a save whose claim number the row no longer holds, same process', () => {
    expect(fenceAdmits(row({ shardId: 2, claim: 8 }), token, undefined)).toBe(false);
  });
  it('refuses a save when another process holds the same claim number', () => {
    expect(fenceAdmits(row({ shardId: 2, holderProcess: 'p-z' }), token, undefined)).toBe(false);
  });
  it('refuses a save over a newer guild stamp', () => {
    expect(fenceAdmits(held, token, 8)).toBe(false);
  });
});

describe('planTake (decision 10): rows of this process', () => {
  it('skips a pair it already knows and counts it toward the capacity', () => {
    const plan = planTake(input({
      shardCount: 2,
      capacity: 1,
      known: [{ shardCount: 4, shardId: 0, claim: 7 }],
      rows: [row({ shardId: 0, holderProcess: 'p-me', holderNode: 'node-me' })],
    }));
    expect(takenIds(plan)).toEqual([[1, 'no-room']]);
  });

  it('a known pair whose row another process holds is held elsewhere, not skipped or counted', () => {
    const plan = planTake(input({
      shardCount: 2,
      capacity: 1,
      known: [{ shardCount: 4, shardId: 0, claim: 7 }],
      rows: [row({ shardId: 0, holderProcess: 'p-other', holderNode: 'node-b', holderName: 'bravo' })],
    }));
    expect(plan.heldElsewhere).toBe(1);
    expect(plan.elsewhere).toEqual([{ shardId: 0, holderName: 'bravo' }]);
    expect(takenIds(plan)).toEqual([[1, null]]);
  });

  it('takes again a live row it holds under a pair it does not know, within capacity', () => {
    const plan = planTake(input({
      shardCount: 1,
      capacity: 1,
      rows: [row({ shardId: 0, holderProcess: 'p-me', holderNode: 'node-me' })],
    }));
    expect(takenIds(plan)).toEqual([[0, null]]);
    expect(plan.heldElsewhere).toBe(0);
  });

  it('an own take past the capacity is marked above for own, one within it is not', () => {
    const rows = [
      row({ shardId: 0, holderProcess: 'p-me', holderNode: 'node-me' }),
      row({ shardId: 1, holderProcess: 'p-me', holderNode: 'node-me' }),
    ];
    expect(takenIds(planTake(input({ shardCount: 2, capacity: 1, rows })))).toEqual([[0, null], [1, 'own']]);
    expect(takenIds(planTake(input({ shardCount: 2, capacity: 5, rows })))).toEqual([[0, null], [1, null]]);
  });
});

describe('planTake (decision 10): live rows', () => {
  it('at boot, a live row of this node renewed by a copied process counts as held elsewhere, with no wait', () => {
    const plan = planTake(input({
      boot: true,
      rows: [row({ shardId: 0, holderProcess: 'p-old', holderNode: 'node-me' })],
      copied: new Set([0]),
    }));
    expect(plan.wait).toBeNull();
    expect(plan.heldElsewhere).toBe(1);
    expect(plan.takes).toEqual([]);
  });

  it('a live row another process of this node holds is held elsewhere but not listed as another machine', () => {
    const plan = planTake(input({ rows: [row({ shardId: 0, holderProcess: 'p-old', holderNode: 'node-me' })] }));
    expect(plan.heldElsewhere).toBe(1);
    expect(plan.elsewhere).toEqual([]);
    expect(plan.takes).toEqual([]);
  });
});

describe('planTake (decision 10): expired rows', () => {
  const expired = (over: Partial<ClaimRow>) => row({ shardId: 0, expiresUpMs: 99_000, ...over });

  it('takes an expired row of this node after boot without deferring to the node\'s own process', () => {
    const plan = planTake(input({
      rows: [expired({ holderProcess: 'p-old', holderNode: 'node-me', homeNode: 'node-me' })],
      nodes: [node({ nodeId: 'node-me', processId: 'p-me' })],
    }));
    expect(takenIds(plan)).toEqual([[0, null]]);
    expect(plan.waitingForOwner).toBe(0);
  });

  it('leaves an expired row to its machine while that machine runs a new process within its takeover delay', () => {
    const plan = planTake(input({
      rows: [expired({ holderProcess: 'p-b1', holderNode: 'node-b', homeNode: 'node-b' })],
      nodes: [node({ nodeId: 'node-b', processId: 'p-b2', takeoverSeconds: 30 })],
    }));
    expect(plan.waitingForOwner).toBe(1);
    expect(plan.takes).toEqual([]);
  });

  it('takes the expired row once it has been expired for the holder machine\'s whole takeover delay', () => {
    const at = planTake(input({
      upMs: 129_000,
      rows: [expired({ holderProcess: 'p-b1', holderNode: 'node-b', homeNode: 'node-b' })],
      nodes: [node({ nodeId: 'node-b', processId: 'p-b2', takeoverSeconds: 30 })],
    }));
    expect(takenIds(at)).toEqual([[0, null]]);
    expect(at.waitingForOwner).toBe(0);
    const past = planTake(input({
      upMs: 200_000,
      rows: [expired({ holderProcess: 'p-b1', holderNode: 'node-b', homeNode: 'node-b' })],
      nodes: [node({ nodeId: 'node-b', processId: 'p-b2', takeoverSeconds: 30 })],
    }));
    expect(takenIds(past)).toEqual([[0, null]]);
  });

  it('takes an expired row whose holder process is still the machine\'s process (it stopped renewing)', () => {
    const plan = planTake(input({
      rows: [expired({ holderProcess: 'p-b2', holderNode: 'node-b', homeNode: 'node-b' })],
      nodes: [node({ nodeId: 'node-b', processId: 'p-b2', takeoverSeconds: 30 })],
    }));
    expect(takenIds(plan)).toEqual([[0, null]]);
    expect(plan.waitingForOwner).toBe(0);
  });

  it('at boot, leaves an expired row homed on a third machine to that machine within its takeover delay', () => {
    const plan = planTake(input({
      boot: true,
      rows: [expired({ holderProcess: 'p-b1', holderNode: 'node-b', homeNode: 'node-c' })],
      nodes: [node({ nodeId: 'node-c', processId: 'p-c', takeoverSeconds: 30 })],
    }));
    expect(plan.waitingForOwner).toBe(1);
    expect(plan.takes).toEqual([]);
  });

  it('at boot, takes an expired row homed on a third machine once its takeover delay passed', () => {
    const rows = [expired({ holderProcess: 'p-b1', holderNode: 'node-b', homeNode: 'node-c' })];
    const nodes = [node({ nodeId: 'node-c', processId: 'p-c', takeoverSeconds: 30 })];
    const at = planTake(input({ boot: true, upMs: 129_000, uPrimeMs: 129_000, rows, nodes }));
    expect(takenIds(at)).toEqual([[0, null]]);
    expect(at.waitingForOwner).toBe(0);
    const past = planTake(input({ boot: true, upMs: 200_000, uPrimeMs: 200_000, rows, nodes }));
    expect(takenIds(past)).toEqual([[0, null]]);
  });

  it('at boot, takes an expired row homed on a machine with no node row at once', () => {
    const plan = planTake(input({
      boot: true,
      upMs: 99_000,
      uPrimeMs: 99_000,
      rows: [expired({ holderProcess: 'p-b1', holderNode: 'node-b', homeNode: 'node-gone' })],
    }));
    expect(takenIds(plan)).toEqual([[0, null]]);
    expect(plan.waitingForOwner).toBe(0);
  });

  it('at boot, takes an expired row homed here without waiting for this machine\'s takeover delay', () => {
    const plan = planTake(input({
      boot: true,
      rows: [expired({ holderProcess: 'p-b1', holderNode: 'node-b', homeNode: 'node-me' })],
      nodes: [node({ nodeId: 'node-me', processId: 'p-me', takeoverSeconds: 30 })],
    }));
    expect(takenIds(plan)).toEqual([[0, null]]);
    expect(plan.waitingForOwner).toBe(0);
  });
});

describe('planTake (decision 10): the order of free shards', () => {
  it('a shard homed here goes first into the room, ahead of a lower shard with no row', () => {
    const plan = planTake(input({
      shardCount: 2,
      capacity: 1,
      rows: [row({ shardId: 1, holderProcess: 'p-b1', holderNode: 'node-b', homeNode: 'node-me', expiresUpMs: 99_000 })],
    }));
    expect(takenIds(plan)).toEqual([[1, null], [0, 'no-room']]);
  });

  it('two shards homed here go into the room by shard id', () => {
    const plan = planTake(input({
      shardCount: 2,
      capacity: 1,
      rows: [
        row({ shardId: 0, holderProcess: 'p-b1', holderNode: 'node-b', homeNode: 'node-me', expiresUpMs: 99_000 }),
        row({ shardId: 1, holderProcess: 'p-b1', holderNode: 'node-b', homeNode: 'node-me', expiresUpMs: 99_000 }),
      ],
    }));
    expect(takenIds(plan)).toEqual([[0, null], [1, 'no-room']]);
  });
});
