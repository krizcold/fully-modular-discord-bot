import { describe, expect, it } from 'vitest';

import { callOffVerdict, chooseMethod, closeVerdict, standbyAskVerdict } from '../../src/bot/internalSetup/fleet/reshardRules';
import type { FactNode, FactRow, MethodNode, ReshardFacts, ReshardRow } from '../../src/bot/internalSetup/fleet/reshardRules';

const UP = 50_000;
const NOW = 1_000_000;

function row(over: Partial<ReshardRow>): ReshardRow {
  return {
    attempt: 'a1', state: 'standby', method: 'overlap', fromCount: 2, toCount: 4, target: null, targetBy: null,
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

function machine(over: Partial<MethodNode>): MethodNode {
  return {
    nodeName: 'A', restartable: true, reshardOverlap: true, memoryRoom: true, memoryFreeMb: 900, memoryUseMb: 300,
    memoryError: null, memoryAgoMs: 0, startedAgoMs: 20 * 60_000, ...over,
  };
}

describe('rc6 the close names the expired old rows in shard order', () => {
  it('sorts the unreleased old shards ascending', () => {
    const rows = [3, 1, 2].map(shardId => claim({ shardId, expiresUpMs: UP }));
    const f = facts({ row: row({ state: 'flipped' }), rows });
    expect(closeVerdict(f, 'a1')).toEqual({ close: true, expired: [1, 2, 3] });
  });
});

describe('rc6 the call-off of a stopping attempt', () => {
  const stopping = (over: Partial<ReshardRow>) => row({ state: 'stopping', method: 'stop-start', ...over });

  it('ignores live rows of the new count once until_at passed', () => {
    const rows = [claim({ shardCount: 4, shardId: 0, holderName: 'new-holder' })];
    expect(callOffVerdict(facts({ row: stopping({ untilAtMs: NOW - 1 }), rows }))).toBeNull();
  });

  it('ignores a released old row once until_at passed', () => {
    const rows = [claim({ released: true, holderName: 'gone' })];
    expect(callOffVerdict(facts({ row: stopping({ untilAtMs: NOW - 1 }), rows }))).toBeNull();
  });

  it('answers null when no old row exists after until_at', () => {
    expect(callOffVerdict(facts({ row: stopping({ untilAtMs: NOW - 1 }), rows: [] }))).toBeNull();
  });

  it('calls off at until_at itself while an old row is live', () => {
    const rows = [claim({ holderName: 'one' })];
    expect(callOffVerdict(facts({ row: stopping({ untilAtMs: NOW }), rows })))
      .toEqual({ reason: 'one did not stop within 10 min', failures: 0, retryNow: false });
  });

  it('names a removed FLEET_SHARD_COUNT even when the row holds no to_count', () => {
    const r = stopping({ toCount: null, target: null, targetBy: 'B', targetAtMs: 2000, startedAtMs: 1000 });
    expect(callOffVerdict(facts({ row: r }))).toEqual({
      reason: 'FLEET_SHARD_COUNT was removed on B after this reshard started', failures: 0, retryNow: true,
    });
  });

  it('leaves the machine name empty when target_by is unset', () => {
    const r = stopping({ target: 6, targetBy: null, targetAtMs: 2000, startedAtMs: 1000 });
    expect(callOffVerdict(facts({ row: r }))?.reason).toBe('FLEET_SHARD_COUNT was changed to 6 on  after this reshard started');
  });
});

describe('rc6 the call-off of a standby attempt at until_at counts the connected new shards', () => {
  const passed = (w: number) => row({ fromCount: 1, toCount: w, untilAtMs: NOW - 1, startedAtMs: NOW - 1 - 10 * 60_000 });

  it('counts no shard id beyond W - 1', () => {
    const rows = [claim({ shardCount: 2, shardId: 0 }), claim({ shardCount: 2, shardId: 2 })];
    expect(callOffVerdict(facts({ row: passed(2), rows }))?.reason).toBe('not all 2 new shards were connected within 10 min (1 were)');
  });

  it('does not count a live ready row of the old count', () => {
    const rows = [claim({ shardCount: 1, shardId: 0 })];
    expect(callOffVerdict(facts({ row: passed(2), rows }))?.reason).toBe('not all 2 new shards were connected within 10 min (0 were)');
  });

  it('does not count a released row of W that reads ready', () => {
    const rows = [claim({ shardCount: 2, shardId: 0, released: true })];
    expect(callOffVerdict(facts({ row: passed(2), rows }))?.reason).toBe('not all 2 new shards were connected within 10 min (0 were)');
  });

  it('counts a row of W only for its own shard', () => {
    const rows = [claim({ shardCount: 3, shardId: 0 })];
    expect(callOffVerdict(facts({ row: passed(3), rows }))?.reason).toBe('not all 3 new shards were connected within 10 min (1 were)');
  });
});

describe('rc6 the call-off reads the holder machine of each live old row', () => {
  it('judges the machine that holds the row, not the first one listed', () => {
    const rows = [claim({ shardId: 0, holderNode: 'n2', holderName: 'two' })];
    const nodes = [node({}), node({ nodeId: 'n2', nodeName: 'two', fit: false })];
    expect(callOffVerdict(facts({ rows, nodes }))).toEqual({ reason: 'two is not healthy', failures: 0, retryNow: false });
  });

  it("names the machine by its heartbeat's node name", () => {
    const rows = [claim({ holderName: 'one' })];
    const nodes = [node({ nodeName: 'Alpha', fit: false })];
    expect(callOffVerdict(facts({ rows, nodes }))?.reason).toBe('Alpha is not healthy');
  });
});

describe('rc6 the method choice', () => {
  it('rules overlap out once 6 minutes passed with no reading', () => {
    expect(chooseMethod([machine({ memoryAgoMs: null, startedAgoMs: 6 * 60_000 })], 0, 'setting'))
      .toEqual({ method: 'stop-start', reason: 'A has no memory reading from its manager' });
  });

  it('accepts a reading exactly 15 minutes old', () => {
    expect(chooseMethod([machine({ memoryAgoMs: 15 * 60_000 })], 0, 'setting')).toEqual({ method: 'overlap' });
  });

  it('says no error was given when the failed reading has none', () => {
    expect(chooseMethod([machine({ memoryRoom: null, memoryError: null })], 0, 'discord')).toEqual({
      method: null, reason: "can't confirm that A has room in memory: its manager could not take the reading (no error given)",
    });
  });

  it('shows a question mark for unknown memory figures', () => {
    expect(chooseMethod([machine({ memoryRoom: false, memoryFreeMb: null, memoryUseMb: null })], 0, 'setting'))
      .toEqual({ method: 'stop-start', reason: 'A has no room in memory (? MB free, ? MB used)' });
  });

  it("keeps a machine's reason over the two called-off tries", () => {
    expect(chooseMethod([machine({ restartable: false })], 2, 'setting'))
      .toEqual({ method: 'stop-start', reason: 'A runs without the web UI' });
  });
});

describe('rc6 the standby ask while busy', () => {
  it('gives the default passing reason when B2 named none', () => {
    expect(standbyAskVerdict({
      attempt: 'a1', exiting: false, overlapEnded: null, standbyOfAttempt: false, busy: true, forkedFor: null, memoryReason: null,
    })).toEqual({ state: 'refused', kind: 'passing', reason: 'another operation is in progress' });
  });
});
