import { describe, expect, it } from 'vitest';

import {
  closeVerdict, flipVerdict, gateStepOne, readyNewCount, spread, startVerdict, takeOutcome, waitingBootVerdict,
} from '../../src/bot/internalSetup/fleet/reshardRules';
import type { FactNode, FactRow, GateRead, ReshardFacts, ReshardRow, SpreadMachine } from '../../src/bot/internalSetup/fleet/reshardRules';

const UP = 50_000;
const NOW = 1_000_000;

function read(over: Partial<GateRead>): GateRead {
  return { attempt: null, state: null, fromCount: null, toCount: null, metaCount: null, ...over };
}

function row(over: Partial<ReshardRow>): ReshardRow {
  return {
    attempt: null, state: null, method: null, fromCount: null, toCount: null, target: null, targetBy: null,
    targetAtMs: null, startedAtMs: null, untilAtMs: null, retryAfterMs: null, failures: 0, ...over,
  };
}

function claim(over: Partial<FactRow>): FactRow {
  return {
    shardCount: 2, shardId: 0, released: false, expiresUpMs: UP + 10_000, ready: true, renewedAgoMs: 0, ttlMs: 30_000,
    holderProcess: 'p1', holderNode: 'n1', holderName: 'one', ...over,
  };
}

function node(over: Partial<FactNode>): FactNode {
  return {
    nodeId: 'n1', nodeName: 'one', processId: 'p1', fit: true, restartable: true, reshardOverlap: true, seenAgoMs: 0,
    takeoverSeconds: 30, ...over,
  };
}

function facts(over: Partial<ReshardFacts>): ReshardFacts {
  return { row: row({}), metaCount: 2, upMs: UP, nowMs: NOW, rows: [], nodes: [], ...over };
}

function machine(nodeId: string, nodeName: string, capacity = 1): SpreadMachine {
  return { nodeId, nodeName, capacity, takeoverSeconds: 30 };
}

describe('ra31 gate step one and the boot branch', () => {
  it('refuses a count change whose row has no from_count, even when meta is also unset', () => {
    const take = { boot: false, firstTake: false, localCount: 4, writesMeta: { kind: 'change' as const, attempt: 'a1' } };
    expect(gateStepOne(take, read({ attempt: 'a1', state: 'stopping', fromCount: null, toCount: 4, metaCount: null })))
      .toEqual({ kind: 'count' });
    expect(gateStepOne(take, read({ attempt: 'a1', state: 'stopping', fromCount: 2, toCount: 4, metaCount: 2 })))
      .toEqual({ kind: 'on', n: 4, writeMeta: true });
  });

  it('takes the boot take when no W is known, even with no live row of meta', () => {
    expect(waitingBootVerdict(read({ metaCount: 3 }), null, false)).toBe('boot-take');
    expect(waitingBootVerdict(read({ metaCount: 3 }), 5, false)).toBe('direct-change');
  });
});

describe('ra31 take outcome lines', () => {
  it('logs L32 for a held count-writing take when the stored count was not held', () => {
    expect(takeOutcome('count-writing', 'held')).toEqual({ then: 'retry', line: 'L32' });
    expect(takeOutcome('count-writing', 'held', undefined, undefined, true)).toEqual({ then: 'retry', line: null });
  });

  it('logs L13 only when the flipped attempt is toward the take count', () => {
    const flipped = read({ attempt: 'a1', state: 'flipped', fromCount: 2, toCount: 5, metaCount: 2 });
    expect(takeOutcome('boot', 'held', flipped, 3)).toEqual({ then: 'retry', line: 'L32' });
    expect(takeOutcome('boot', 'held', flipped, 5)).toEqual({ then: 'retry', line: 'L13' });
  });
});

describe('ra31 spread order', () => {
  it('fills the other machines in node_name order when they arrive already sorted', () => {
    const others = [machine('ia', 'alpha'), machine('ib', 'bravo'), machine('ic', 'charlie')];
    expect(spread(3, machine('me', 'zulu', 0), others)).toEqual(['ia', 'ib', 'ic']);
  });

  it('fills the other machines in node_name order when they arrive unsorted', () => {
    const others = [machine('ic', 'charlie'), machine('ia', 'alpha'), machine('id', 'delta'), machine('ib', 'bravo')];
    expect(spread(4, machine('me', 'zulu', 0), others)).toEqual(['ia', 'ib', 'ic', 'id']);
  });

  it('keeps the given order of machines that share a node_name', () => {
    const others = [machine('p', 'same'), machine('q', 'same'), machine('r', 'same')];
    expect(spread(3, machine('me', 'zulu', 0), others)).toEqual(['p', 'q', 'r']);
  });
});

describe('ra31 ready test and live machine bounds', () => {
  it('counts a row renewed exactly at 3 x min(ttl/6, 5000) ms as not ready', () => {
    expect(readyNewCount(facts({ rows: [claim({ renewedAgoMs: 15_000, ttlMs: 30_000 })] }), 2)).toBe(0);
    expect(readyNewCount(facts({ rows: [claim({ renewedAgoMs: 14_999, ttlMs: 30_000 })] }), 2)).toBe(1);
  });

  it('bounds the ready window by ttl/6 when that is under 5000 ms', () => {
    expect(readyNewCount(facts({ rows: [claim({ renewedAgoMs: 5_000, ttlMs: 6_000 })] }), 2)).toBe(0);
    expect(readyNewCount(facts({ rows: [claim({ renewedAgoMs: 2_999, ttlMs: 6_000 })] }), 2)).toBe(1);
  });

  it('counts only live rows of W', () => {
    const rows = [
      claim({ shardCount: 3, shardId: 0 }),
      claim({ shardCount: 2, shardId: 1, released: true }),
      claim({ shardCount: 2, shardId: 2, expiresUpMs: UP }),
      claim({ shardCount: 2, shardId: 3 }),
    ];
    expect(readyNewCount(facts({ rows }), 2)).toBe(1);
  });

  it('does not count a live ready row of another count', () => {
    expect(readyNewCount(facts({ rows: [claim({ shardCount: 3 })] }), 2)).toBe(0);
  });

  it('does not count a released ready row of W', () => {
    expect(readyNewCount(facts({ rows: [claim({ released: true })] }), 2)).toBe(0);
  });
});

describe('ra31 start verdict', () => {
  const ok = () => facts({ metaCount: 2, row: row({ state: 'done' }) });

  it('refuses with count while meta is unset', () => {
    expect(startVerdict(facts({ metaCount: null }), 3, 'stop-start')).toBe('count');
    expect(startVerdict(ok(), 3, 'stop-start')).toBeNull();
  });

  it('starts once retry_after has passed, and waits while it is ahead', () => {
    expect(startVerdict({ ...ok(), row: row({ retryAfterMs: NOW - 1 }) }, 3, 'stop-start')).toBeNull();
    expect(startVerdict({ ...ok(), row: row({ retryAfterMs: NOW + 1 }) }, 3, 'stop-start')).toBe('retry');
  });

  it('starts when retry_after equals now', () => {
    expect(startVerdict({ ...ok(), row: row({ retryAfterMs: NOW }) }, 3, 'stop-start')).toBeNull();
  });

  it('refuses unfit when one live machine is unfit and another is fit', () => {
    const nodes = [node({ nodeId: 'n1', fit: true }), node({ nodeId: 'n2', fit: false })];
    expect(startVerdict({ ...ok(), nodes }, 3, 'stop-start')).toBe('unfit');
  });

  it('ignores an unfit machine last seen exactly at its takeover time', () => {
    const nodes = [node({ fit: false, seenAgoMs: 30_000, takeoverSeconds: 30 })];
    expect(startVerdict({ ...ok(), nodes }, 3, 'stop-start')).toBeNull();
    expect(startVerdict({ ...ok(), nodes: [node({ fit: false, seenAgoMs: 29_999 })] }, 3, 'stop-start')).toBe('unfit');
  });
});

describe('ra31 flip verdict', () => {
  const ready = (count: number) => [claim({ shardCount: count, shardId: 0 }), claim({ shardCount: count, shardId: 1 })];

  it('flips a standby attempt with every new row ready', () => {
    const f = facts({ metaCount: 1, row: row({ attempt: 'a1', state: 'standby', fromCount: 1, toCount: 2 }), rows: ready(2) });
    expect(flipVerdict(f, 'a1')).toBe(true);
  });

  it('never flips an attempt that is not standby', () => {
    const f = facts({ metaCount: 1, row: row({ attempt: 'a1', state: 'flipped', fromCount: 1, toCount: 2 }), rows: ready(2) });
    expect(flipVerdict(f, 'a1')).toBe(false);
  });

  it('never flips an attempt with no from_count, even when meta is unset', () => {
    const f = facts({ metaCount: null, row: row({ attempt: 'a1', state: 'standby', fromCount: null, toCount: 2 }), rows: ready(2) });
    expect(flipVerdict(f, 'a1')).toBe(false);
  });

  it('never flips on ready rows of a count other than to_count', () => {
    const f = facts({ metaCount: 1, row: row({ attempt: 'a1', state: 'standby', fromCount: 1, toCount: 2 }), rows: ready(3) });
    expect(flipVerdict(f, 'a1')).toBe(false);
  });

  it('checks a live old row against the machine that holds it', () => {
    const base = { metaCount: 1, row: row({ attempt: 'a1', state: 'standby', fromCount: 1, toCount: 2 }) };
    const old = claim({ shardCount: 1, shardId: 0, holderNode: 'n2', holderProcess: 'p2' });
    const fitFirst = [node({ nodeId: 'n1', processId: 'p2' }), node({ nodeId: 'n2', processId: 'p2', fit: false })];
    expect(flipVerdict(facts({ ...base, rows: [...ready(2), old], nodes: fitFirst }), 'a1')).toBe(false);
    const unfitFirst = [node({ nodeId: 'n1', processId: 'p2', fit: false }), node({ nodeId: 'n2', processId: 'p2' })];
    expect(flipVerdict(facts({ ...base, rows: [...ready(2), old], nodes: unfitFirst }), 'a1')).toBe(true);
  });
});

describe('ra31 close verdict', () => {
  it('never closes a flipped row that holds no attempt', () => {
    const f = facts({ row: row({ attempt: null, state: 'flipped', fromCount: 1, toCount: 2 }) });
    expect(closeVerdict(f, null)).toEqual({ close: false, expired: [] });
    const g = facts({ row: row({ attempt: 'a1', state: 'flipped', fromCount: 1, toCount: 2 }) });
    expect(closeVerdict(g, null)).toEqual({ close: true, expired: [] });
  });
});
