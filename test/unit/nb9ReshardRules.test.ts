import { describe, expect, it } from 'vitest';

import {
  callOffVerdict, closeVerdict, flipVerdict, spread, standbyAskVerdict, startVerdict, takeGateVerdict, takeOutcome,
  untilSeconds, waitingBootVerdict,
  type FactNode, type FactRow, type GateRead, type GateRow, type GateTake, type ReshardFacts, type ReshardRow,
} from '../../src/bot/internalSetup/fleet/reshardRules';

// NB9 test 1, the part 2 rows: the take gate (56, 73, 77, C1, D9), the boot's branch (74), takeOutcome (67, 69, 74,
// 77) and the standby ask (50, 65). Reads are what provisioning's seed, NB4's first take, decision 6's start and the
// gate's close leave in the reshard row and meta.

const U = 100_000;
const none = (meta: number | null): GateRead => ({ attempt: null, state: null, fromCount: null, toCount: null, metaCount: meta });
const att = (state: GateRead['state'], from: number, to: number, meta: number | null, attempt = 'a'): GateRead =>
  ({ attempt, state, fromCount: from, toCount: to, metaCount: meta });
const live = (shardCount: number, shardId = 0): GateRow => ({ shardCount, shardId, released: false, expiresUpMs: U + 30_000, holderName: 'm2' });
const released = (shardCount: number, shardId = 0): GateRow => ({ ...live(shardCount, shardId), released: true });
const expired = (shardCount: number, shardId = 0): GateRow => ({ ...live(shardCount, shardId), expiresUpMs: U });
const bootTake: GateTake = { boot: true, firstTake: true, localCount: 6 };
const running = (local: number | null): GateTake => ({ boot: false, firstTake: true, localCount: local });

describe('takeGateVerdict step (1), C1 and D9', () => {
  it.each([
    ['meta absent, localCount 4, boot', { boot: true, firstTake: true, localCount: 4 }, none(null), { kind: 'commit', n: 4, writeMeta: true }],
    ['meta absent, localCount 4, running', running(4), none(null), { kind: 'commit', n: 4, writeMeta: true }],
    ['meta absent, localCount null', running(null), none(null), { kind: 'need-count' }],
    ['meta 4, boot, localCount 6', bootTake, none(4), { kind: 'commit', n: 4, writeMeta: false }],
    ['meta 4, running, localCount 6', running(6), none(4), { kind: 'count' }],
    ['meta 4, running, localCount 4', running(4), none(4), { kind: 'commit', n: 4, writeMeta: false }],
    ['D9: meta absent, not a first take, localCount 4', { boot: false, firstTake: false, localCount: 4 }, none(null), { kind: 'count' }],
  ] as Array<[string, GateTake, GateRead, object]>)('%s', (_name, take, read, expected) => {
    expect(takeGateVerdict(take, read, [], U)).toMatchObject(expected);
  });
});

describe('takeGateVerdict steps (2) and (3), 56', () => {
  it('a live row of a third count: held', () => {
    expect(takeGateVerdict(running(4), none(4), [live(6)], U)).toMatchObject({ kind: 'held', rows: [live(6)] });
  });
  it('n = from_count with live to_count rows in standby: excepted; in cancelled: held', () => {
    expect(takeGateVerdict(running(4), att('standby', 4, 8, 4), [live(8)], U)).toMatchObject({ kind: 'commit', deleted: [] });
    expect(takeGateVerdict(running(4), att('cancelled', 4, 8, 4), [live(8)], U)).toMatchObject({ kind: 'commit' });
    expect(takeGateVerdict(running(4), none(4), [live(8)], U)).toMatchObject({ kind: 'held' });
  });
  it('n = to_count in flipped with a live from_count row: held; with only released and expired ones: the close', () => {
    const take: GateTake = { boot: true, firstTake: true, localCount: null };
    expect(takeGateVerdict(take, att('flipped', 4, 8, 8), [live(4)], U)).toMatchObject({ kind: 'held' });
    expect(takeGateVerdict(take, att('flipped', 4, 8, 8), [released(4, 0), expired(4, 1)], U))
      .toMatchObject({ kind: 'commit', n: 8, close: true, deleted: [released(4, 0), expired(4, 1)] });
  });
  it('n = from_count in standby keeps a released to_count row; in cancelled it is deleted', () => {
    expect(takeGateVerdict(running(4), att('standby', 4, 8, 4), [released(8)], U)).toMatchObject({ kind: 'commit', deleted: [] });
    expect(takeGateVerdict(running(4), att('cancelled', 4, 8, 4), [released(8)], U)).toMatchObject({ kind: 'commit', deleted: [released(8)] });
  });
});

describe('takeGateVerdict for the takes that write meta, 73', () => {
  it('13 toward 4 from 8 after done 4 -> 8 with a live count-8 row: held; with it released: commit, meta 4', () => {
    const direct: GateTake = { boot: true, firstTake: false, localCount: 4, writesMeta: { kind: 'direct', from: 8 } };
    expect(takeGateVerdict(direct, att('done', 4, 8, 8), [live(8)], U)).toMatchObject({ kind: 'held' });
    expect(takeGateVerdict(direct, att('done', 4, 8, 8), [released(8)], U)).toMatchObject({ kind: 'commit', n: 4, writeMeta: true });
  });
  it('NB4 first take with meta 4 present takes under 4 (C1); a running take with another count is refused', () => {
    expect(takeGateVerdict({ boot: true, firstTake: true, localCount: 8 }, none(4), [], U)).toMatchObject({ kind: 'commit', n: 4, writeMeta: false });
  });
  it('12 for attempt a when the row shows a cancelled, and attempt b stopping: count', () => {
    const change: GateTake = { boot: true, firstTake: false, localCount: 8, writesMeta: { kind: 'change', attempt: 'a' } };
    expect(takeGateVerdict(change, att('cancelled', 4, 8, 4), [], U)).toMatchObject({ kind: 'count' });
    expect(takeGateVerdict(change, att('stopping', 4, 8, 4, 'b'), [], U)).toMatchObject({ kind: 'count' });
    expect(takeGateVerdict(change, att('stopping', 4, 8, 4), [released(4)], U)).toMatchObject({ kind: 'commit', n: 8, writeMeta: true, deleted: [released(4)] });
    expect(takeGateVerdict(change, att('stopping', 4, 8, 4), [live(4)], U)).toMatchObject({ kind: 'held' });
  });
  it('13 with from 8 when meta reads 4, and with an attempt in standby: count', () => {
    const direct: GateTake = { boot: true, firstTake: false, localCount: 6, writesMeta: { kind: 'direct', from: 8 } };
    expect(takeGateVerdict(direct, none(4), [], U)).toMatchObject({ kind: 'count' });
    expect(takeGateVerdict(direct, att('standby', 8, 10, 8), [], U)).toMatchObject({ kind: 'count' });
  });
});

describe('takeGateVerdict with bootTake, 77', () => {
  const free = [released(4, 1)];
  it('n 4, meta 4, attempt a stopping 4 -> 8: boot take refused count with an empty delete set; running take commits', () => {
    expect(takeGateVerdict(bootTake, att('stopping', 4, 8, 4), free, U)).toEqual({ kind: 'count', read: att('stopping', 4, 8, 4) });
    expect(takeGateVerdict(running(4), att('stopping', 4, 8, 4), free, U)).toMatchObject({ kind: 'commit' });
  });
  it('boot take in standby with a live count-8 row, in cancelled, and after done: commit', () => {
    expect(takeGateVerdict(bootTake, att('standby', 4, 8, 4), [live(8)], U)).toMatchObject({ kind: 'commit', n: 4 });
    expect(takeGateVerdict(bootTake, att('cancelled', 4, 8, 4), [], U)).toMatchObject({ kind: 'commit', n: 4 });
    expect(takeGateVerdict(bootTake, att('done', 4, 8, 8), [], U)).toMatchObject({ kind: 'commit', n: 8 });
  });
});

describe('waitingBootVerdict, 74', () => {
  it.each([
    ['meta absent', none(null), 4, null, 'first-take'],
    ['stopping', att('stopping', 4, 8, 4), 8, null, 'count-change'],
    ['standby', att('standby', 4, 8, 4), 8, null, 'boot-take'],
    ['flipped', att('flipped', 4, 8, 8), 8, null, 'boot-take'],
    ['no attempt, meta = W', none(4), 4, null, 'boot-take'],
    ['meta other than W, no live row of meta', att('done', 2, 4, 4), 6, false, 'direct-change'],
    ['meta other than W, a live row of meta', none(4), 6, true, 'boot-take'],
  ] as const)('%s', (_name, read, wanted, liveOfMeta, expected) => {
    expect(waitingBootVerdict(read, wanted, liveOfMeta)).toBe(expected);
  });
});

describe('takeOutcome, 67, 69, 74 and 77', () => {
  it.each([
    ['boot', 'failed', { then: 'retry', line: 'take-error' }],
    ['running', 'failed', { then: 'next-tick', line: null }],
    ['redraw', 'failed', { then: 'retry-until-d', line: null }],
    ['retake', 'failed', { then: 'next-pass', line: null }],
    ['count-writing', 'failed', { then: 'retry', line: 'take-error' }],
    ['boot', 'count', { then: 'retry', line: null }],
    ['running', 'count', { then: 'next-tick', line: null }],
    ['redraw', 'count', { then: 'loss', line: null }],
    ['retake', 'count', { then: 'loss', line: null }],
    ['count-writing', 'count', { then: 'retry', line: null }],
    ['boot', 'held', { then: 'retry', line: 'L32' }],
    ['running', 'held', { then: 'next-tick', line: 'L32' }],
    ['redraw', 'held', { then: 'loss', line: 'L32' }],
    ['retake', 'held', { then: 'next-pass', line: 'L32' }],
  ] as const)('%s %s', (kind, result, expected) => {
    expect(takeOutcome(kind, result)).toEqual(expected);
  });
  it('a boot take held in flipped toward its n logs L13; 13 held on the stored count logs nothing', () => {
    expect(takeOutcome('boot', 'held', att('flipped', 4, 8, 8), 8)).toEqual({ then: 'retry', line: 'L13' });
    expect(takeOutcome('count-writing', 'held', none(8), 4, true)).toEqual({ then: 'retry', line: null });
    expect(takeOutcome('count-writing', 'held', none(8), 4, false)).toEqual({ then: 'retry', line: 'L32' });
  });
});

describe('standbyAskVerdict, 65', () => {
  const ask = { attempt: 'a', exiting: false, overlapEnded: null, standbyOfAttempt: false, busy: false, forkedFor: null, memoryReason: null };
  const mark = { attempt: 'a', code: 1, signal: null };
  const reason = "the previous bot process ended (code 1, signal null) while the second bot process ran, so room for both can't be confirmed";
  it.each([
    ['a living standby', { standbyOfAttempt: true }],
    ['no standby, forkedFor a', { forkedFor: 'a' }],
    ['forkedFor b', { forkedFor: 'b' }],
  ])('mark a and an ask for a with %s: refused, memory', (_name, extra) => {
    expect(standbyAskVerdict({ ...ask, ...extra, overlapEnded: mark })).toEqual({ state: 'refused', kind: 'memory', reason });
  });
  it('the web UI exiting answers passing first; a mark for b leaves a to round 2 order', () => {
    expect(standbyAskVerdict({ ...ask, exiting: true, overlapEnded: mark })).toMatchObject({ state: 'refused', kind: 'passing' });
    const other = { ...mark, attempt: 'b' };
    expect(standbyAskVerdict({ ...ask, overlapEnded: other, standbyOfAttempt: true, memoryReason: 'no room' })).toEqual({ state: 'running' });
    expect(standbyAskVerdict({ ...ask, overlapEnded: other, forkedFor: 'a', memoryReason: 'no room' })).toEqual({ state: 'started' });
    expect(standbyAskVerdict({ ...ask, overlapEnded: other, memoryReason: 'no room' })).toEqual({ state: 'refused', kind: 'memory', reason: 'no room' });
    expect(standbyAskVerdict({ ...ask, busy: true })).toMatchObject({ state: 'refused', kind: 'passing' });
    expect(standbyAskVerdict({ ...ask, busy: true, busyReason: 'the bot is being stopped or restarted' })).toEqual({ state: 'refused', kind: 'passing', reason: 'the bot is being stopped or restarted' });
  });
});

// Part 2b: the spread (12, 36), the start (6), the flip (8), the close (10) and the call-offs (11, 32, 33, 66).

describe('spread, 12', () => {
  const m = (nodeId: string, capacity: number) => ({ nodeId, nodeName: nodeId.toUpperCase(), capacity, takeoverSeconds: 30 });
  it.each([
    ['W below the targets', 4, m('me', 3), [m('b', 3), m('a', 1)], ['me', 'me', 'me', 'a']],
    ['W equal to the targets', 7, m('me', 3), [m('b', 3), m('a', 1)], ['me', 'me', 'me', 'a', 'b', 'b', 'b']],
    ['W above the targets: round-robin from this machine', 10, m('me', 3), [m('b', 3), m('a', 1)], ['me', 'me', 'me', 'a', 'b', 'b', 'b', 'me', 'a', 'b']],
    ['targets 0 and 1', 3, m('me', 0), [m('a', 1)], ['a', 'me', 'a']],
    ['this machine alone', 2, m('me', 1), [], ['me', 'me']],
  ] as Array<[string, number, ReturnType<typeof m>, Array<ReturnType<typeof m>>, string[]]>)('%s', (_name, w, me, others, expected) => {
    expect(spread(w, me, others)).toEqual(expected);
  });
});

const NOW = 1_800_000_000_000;
const rrow = (over: Partial<ReshardRow> = {}): ReshardRow => ({
  attempt: 'a', state: 'standby', method: 'overlap', fromCount: 2, toCount: 4, target: null, targetBy: null, targetAtMs: null,
  startedAtMs: NOW - 60_000, untilAtMs: NOW + 600_000, retryAfterMs: null, failures: 0, ...over,
});
const node = (nodeId: string, over: Partial<FactNode> = {}): FactNode => ({
  nodeId, nodeName: nodeId.toUpperCase(), processId: `p-${nodeId}`, fit: true, restartable: true, reshardOverlap: true,
  seenAgoMs: 1000, takeoverSeconds: 30, ...over,
});
const frow = (shardCount: number, shardId: number, over: Partial<FactRow> = {}): FactRow => ({
  shardCount, shardId, released: false, expiresUpMs: U + 30_000, ready: false, renewedAgoMs: 1000, ttlMs: 30_000,
  holderProcess: 'p-n1', holderNode: 'n1', holderName: 'N1', ...over,
});
const ready4 = [0, 1, 2, 3].map(s => frow(4, s, { ready: true, holderProcess: 'p-s', holderNode: 'n2', holderName: 'N2' }));
const facts = (over: Partial<ReshardFacts> = {}): ReshardFacts => ({
  row: rrow(), metaCount: 2, upMs: U, nowMs: NOW, rows: [frow(2, 0), frow(2, 1), ...ready4], nodes: [node('n1'), node('n2')], ...over,
});

describe('startVerdict, 6', () => {
  const none = rrow({ attempt: null, state: null, method: null, fromCount: null, toCount: null, startedAtMs: null, untilAtMs: null });
  const idleRows = [frow(2, 0), frow(2, 1)];
  const idle = facts({ row: none, rows: idleRows });
  it.each([
    ['every condition holds', idle, 4, 'overlap', null],
    ['W equals the stored count', idle, 2, 'overlap', 'count'],
    ['an attempt is open', facts({ rows: idleRows }), 4, 'overlap', 'open'],
    ['retry_after not passed', facts({ row: { ...none, retryAfterMs: NOW + 1000 }, rows: idleRows }), 4, 'overlap', 'retry'],
    ['a live machine is unfit', facts({ row: none, rows: idleRows, nodes: [node('n1', { fit: false })] }), 4, 'overlap', 'unfit'],
    ['an unfit machine not seen within its delay does not count', facts({ row: none, rows: idleRows, nodes: [node('n1'), node('n2', { fit: false, seenAgoMs: 40_000 })] }), 4, 'overlap', null],
    ['a live row of another count', facts({ row: none, rows: [...idleRows, frow(4, 0)] }), 4, 'overlap', 'held'],
    ['two overlap tries toward W were called off', facts({ row: { ...none, toCount: 4, failures: 2 }, rows: idleRows }), 4, 'overlap', 'failures'],
    ['two tries toward another count: kept at 0', facts({ row: { ...none, toCount: 6, failures: 2 }, rows: idleRows }), 4, 'overlap', null],
    ['stop-start after two tries', facts({ row: { ...none, toCount: 4, failures: 2 }, rows: idleRows }), 4, 'stop-start', null],
  ] as Array<[string, ReshardFacts, number, 'overlap' | 'stop-start', string | null]>)('%s', (_name, f, w, method, expected) => {
    expect(startVerdict(f, w, method)).toBe(expected);
  });

  it('U is 600 s plus 11 s per bucket round for overlap, 600 s for stop-start', () => {
    expect(untilSeconds('overlap', 8, 1)).toBe(688);
    expect(untilSeconds('overlap', 8, 16)).toBe(611);
    expect(untilSeconds('stop-start', 8, 1)).toBe(600);
  });
});

describe('flipVerdict, 8', () => {
  it.each([
    ['every new shard ready and fresh, the old machine fit', facts(), true],
    ['one new shard unready', facts({ rows: [frow(2, 0), ...ready4.slice(0, 3), { ...ready4[3], ready: false }] }), false],
    ['one new shard renewed 16 s ago', facts({ rows: [frow(2, 0), ...ready4.slice(0, 3), { ...ready4[3], renewedAgoMs: 16_000 }] }), false],
    ['one new shard missing', facts({ rows: [frow(2, 0), ...ready4.slice(0, 3)] }), false],
    ['the old machine unfit', facts({ nodes: [node('n1', { fit: false }), node('n2')] }), false],
    ['the old machine runs another process', facts({ nodes: [node('n1', { processId: 'p-new' }), node('n2')] }), false],
    ['the old machine not restartable', facts({ nodes: [node('n1', { restartable: false }), node('n2')] }), false],
    ['meta is not from_count', facts({ metaCount: 4 }), false],
    ['another attempt', facts({ row: rrow({ attempt: 'b' }) }), false],
    ['a released old row needs no fit machine', facts({ rows: [frow(2, 0, { released: true }), ...ready4], nodes: [node('n1', { fit: false }), node('n2')] }), true],
  ] as Array<[string, ReshardFacts, boolean]>)('%s', (_name, f, expected) => {
    expect(flipVerdict(f, 'a')).toBe(expected);
  });
});

describe('closeVerdict, 10', () => {
  const flipped = (rows: FactRow[]) => facts({ row: rrow({ state: 'flipped' }), metaCount: 4, rows });
  it('waits while an old row is live; closes with the expired rows named once none is', () => {
    expect(closeVerdict(flipped([frow(2, 0), ...ready4]), 'a')).toEqual({ close: false, expired: [] });
    expect(closeVerdict(flipped([frow(2, 0, { released: true }), frow(2, 1, { expiresUpMs: U }), ...ready4]), 'a')).toEqual({ close: true, expired: [1] });
    expect(closeVerdict(flipped(ready4), 'b')).toEqual({ close: false, expired: [] });
    expect(closeVerdict(facts({ rows: ready4 }), 'a')).toEqual({ close: false, expired: [] });
  });
});

describe('callOffVerdict, 11, 32, 33, 66', () => {
  const budget = "Discord allows 3 more gateway logins until 10:00, and N2's new shards need 8";
  it.each([
    ['nothing to call off', facts(), undefined, null],
    ['until_at passed in standby', facts({ row: rrow({ untilAtMs: NOW - 1, startedAtMs: NOW - 660_000 }) }), undefined,
      { reason: 'not all 4 new shards were connected within 11 min (4 were)', failures: 1, retryNow: false }],
    ['an old row expired unreleased', facts({ rows: [frow(2, 0), frow(2, 1, { expiresUpMs: U }), ...ready4] }), undefined,
      { reason: 'shard 1 of N1 is no longer renewed', failures: 1, retryNow: false }],
    ['an old machine unfit', facts({ nodes: [node('n1', { fit: false }), node('n2')] }), undefined,
      { reason: 'N1 is not healthy', failures: 0, retryNow: false }],
    ['an old machine with no web UI', facts({ nodes: [node('n1', { restartable: false }), node('n2')] }), undefined,
      { reason: 'N1 has no web UI process to start a second bot process', failures: 0, retryNow: true }],
    ['overlap turned off on an old machine', facts({ nodes: [node('n1', { reshardOverlap: false }), node('n2')] }), undefined,
      { reason: 'resharding beside the running shards was turned off on N1', failures: 0, retryNow: true }],
    ['the setting changed after the start', facts({ row: rrow({ target: 6, targetBy: 'N2', targetAtMs: NOW - 1000 }) }), undefined,
      { reason: 'FLEET_SHARD_COUNT was changed to 6 on N2 after this reshard started', failures: 0, retryNow: true }],
    ['the setting removed after the start', facts({ row: rrow({ target: null, targetBy: 'N2', targetAtMs: NOW - 1000 }) }), undefined,
      { reason: 'FLEET_SHARD_COUNT was removed on N2 after this reshard started', failures: 0, retryNow: true }],
    ['the setting changed before the start', facts({ row: rrow({ target: 6, targetBy: 'N2', targetAtMs: NOW - 120_000 }) }), undefined, null],
    ['the setting set to to_count after the start', facts({ row: rrow({ target: 4, targetBy: 'N2', targetAtMs: NOW - 1000 }) }), undefined, null],
    ['a memory refusal', facts(), { reason: 'N1 could not start its new shards: the memory reading is 20 min old', countsFailure: true },
      { reason: 'N1 could not start its new shards: the memory reading is 20 min old', failures: 1, retryNow: false }],
    ['the budget', facts(), { reason: budget, countsFailure: false }, { reason: budget, failures: 0, retryNow: false }],
    ['stopping: until_at passed with a live old row', facts({ row: rrow({ state: 'stopping', method: 'stop-start', untilAtMs: NOW - 1 }), rows: [frow(2, 0)] }), undefined,
      { reason: 'N1 did not stop within 10 min', failures: 0, retryNow: false }],
    ['stopping: an old machine unfit is no reason', facts({ row: rrow({ state: 'stopping', method: 'stop-start' }), rows: [frow(2, 0)], nodes: [node('n1', { fit: false })] }), undefined, null],
    ['stopping: a caller reason is no reason', facts({ row: rrow({ state: 'stopping', method: 'stop-start' }), rows: [frow(2, 0)] }), { reason: 'x', countsFailure: true }, null],
    ['flipped: never', facts({ row: rrow({ state: 'flipped', untilAtMs: NOW - 1 }), metaCount: 4 }), { reason: 'x', countsFailure: true }, null],
  ] as Array<[string, ReshardFacts, { reason: string; countsFailure: boolean } | undefined, object | null]>)('%s', (_name, f, asked, expected) => {
    expect(callOffVerdict(f, asked)).toEqual(expected);
  });
});

// NB9 part 4a: chooseMethod (5, 33, 37) and handOverVerdict (25, 48).
import { chooseMethod, handOverVerdict, type MethodNode } from '../../src/bot/internalSetup/fleet/reshardRules';

const mnode = (over: Partial<MethodNode> = {}): MethodNode => ({
  nodeName: 'A', restartable: true, reshardOverlap: true, memoryRoom: true, memoryFreeMb: 900, memoryUseMb: 300,
  memoryError: null, memoryAgoMs: 60_000, startedAgoMs: 3_600_000, ...over,
});

describe('chooseMethod, 5', () => {
  it.each([
    ['every machine allows it with a fresh true reading', [mnode(), mnode({ nodeName: 'B' })], 0, 'setting', { method: 'overlap' }],
    ['no web UI', [mnode({ restartable: false })], 0, 'setting', { method: 'stop-start', reason: 'A runs without the web UI' }],
    ['overlap off', [mnode({ reshardOverlap: false })], 0, 'setting', { method: 'stop-start', reason: 'resharding beside the running shards is off on A (FLEET_RESHARD_OVERLAP=false)' }],
    ['no room', [mnode({ memoryRoom: false, memoryFreeMb: 100, memoryUseMb: 700 })], 0, 'discord', { method: null, reason: 'A has no room in memory (100 MB free, 700 MB used)' }],
    ['room null: can\'t confirm', [mnode({ memoryRoom: null, memoryError: 'docker stats failed' })], 0, 'setting', { method: 'stop-start', reason: "can't confirm that A has room in memory: its manager could not take the reading (docker stats failed)" }],
    ['a reading 14 min old', [mnode({ memoryAgoMs: 14 * 60_000 })], 0, 'setting', { method: 'overlap' }],
    ['a reading 16 min old', [mnode({ memoryAgoMs: 16 * 60_000 })], 0, 'setting', { method: 'stop-start', reason: "A's memory reading is 16 min old" }],
    ['no reading, started 2 min ago: wait', [mnode({ memoryAgoMs: null, memoryRoom: null, startedAgoMs: 2 * 60_000 })], 0, 'discord', { wait: true, reason: "waiting up to 4 min for A's first memory reading" }],
    ['no reading, started 7 min ago', [mnode({ memoryAgoMs: null, memoryRoom: null, startedAgoMs: 7 * 60_000 })], 0, 'setting', { method: 'stop-start', reason: 'A has no memory reading from its manager' }],
    ['a refusal on B wins over a wait on A', [mnode({ memoryAgoMs: null, memoryRoom: null, startedAgoMs: 60_000 }), mnode({ nodeName: 'B', restartable: false })], 0, 'setting', { method: 'stop-start', reason: 'B runs without the web UI' }],
    ['failures 1', [mnode()], 1, 'discord', { method: 'overlap' }],
    ['failures 2, target', [mnode()], 2, 'setting', { method: 'stop-start', reason: 'two tries beside the running shards were called off' }],
    ['failures 2, Discord', [mnode()], 2, 'discord', { method: null, reason: 'two tries beside the running shards were called off' }],
  ] as Array<[string, MethodNode[], number, 'setting' | 'discord', object]>)('%s', (_name, nodes, failures, source, expected) => {
    expect(chooseMethod(nodes, failures, source)).toEqual(expected);
  });
});

describe('handOverVerdict, 25 and 48', () => {
  it.each([
    ['counts differ, nothing of meta held, granted', { granted: true, ownCount: 4, metaCount: 8, heldLiveOfMeta: false }, true],
    ['counts equal', { granted: true, ownCount: 8, metaCount: 8, heldLiveOfMeta: false }, false],
    ['holds a live row of meta\'s count', { granted: true, ownCount: 4, metaCount: 8, heldLiveOfMeta: true }, false],
    ['a boot whose bootShards has not resolved', { granted: false, ownCount: 4, metaCount: 8, heldLiveOfMeta: false }, false],
    ['no meta', { granted: true, ownCount: 4, metaCount: null, heldLiveOfMeta: false }, false],
    ['no count of its own', { granted: true, ownCount: null, metaCount: 8, heldLiveOfMeta: false }, false],
  ] as Array<[string, Parameters<typeof handOverVerdict>[0], boolean]>)('%s', (_name, input, expected) => {
    expect(handOverVerdict(input)).toBe(expected);
  });
});

describe('takeGateVerdict for a direct change to its own stored count (P4-1)', () => {
  it('commits under that count through the attempt exception: the answer the build gives today, pinned so a change shows', () => {
    const take: GateTake = { boot: true, firstTake: false, localCount: 1, writesMeta: { kind: 'direct', from: 1 } };
    expect(takeGateVerdict(take, att('cancelled', 1, 4, 1), [live(4)], U)).toMatchObject({ kind: 'commit', n: 1, deleted: [] });
  });
});
