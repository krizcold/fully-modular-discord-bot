import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  callOffVerdict, closeVerdict, flipVerdict, spread, standbyAskVerdict, takeGateVerdict, takeOutcome, wantedCount,
  type FactNode, type FactRow, type GateRead, type GateRow, type GateTake, type ReshardFacts, type ReshardRow,
  type SpreadMachine, type TakeKind,
} from '../../src/bot/internalSetup/fleet/reshardRules';
import { processId } from '../../src/bot/internalSetup/fleet/processId';
import { ShardClaims } from '../../src/bot/internalSetup/fleet/shardClaims';
import { claimTimings } from '../../src/bot/internalSetup/fleet/claimRules';
import { MemClaimStore } from '../helpers/fakeClaimStore';

// NB9 test 2: properties of the pure verdicts over random reshard rows, meta values, claim rows and machines.

const U = 100_000;
const NOW = 1_800_000_000_000;
const states = fc.constantFrom<GateRead['state']>(null, 'standby', 'flipped', 'stopping', 'done', 'cancelled');
const count = fc.integer({ min: 1, max: 5 });
const readArb = fc.record({
  attempt: fc.constantFrom<string | null>(null, 'a'),
  state: states,
  fromCount: fc.option(count, { nil: null }),
  toCount: fc.option(count, { nil: null }),
  metaCount: fc.option(count, { nil: null }),
});
const gateRowArb = fc.record({
  shardCount: count,
  shardId: fc.integer({ min: 0, max: 4 }),
  released: fc.boolean(),
  expiresUpMs: fc.constantFrom(U - 1, U, U + 1, U + 30_000),
  holderName: fc.constantFrom('m1', 'm2'),
});
const takeArb: fc.Arbitrary<GateTake> = fc.oneof(
  fc.record({ boot: fc.boolean(), firstTake: fc.constant(true), localCount: fc.option(count, { nil: null }) }),
  fc.record({ boot: fc.constant(false), firstTake: fc.constant(false), localCount: fc.constant(null), count }),
  fc.record({ boot: fc.boolean(), firstTake: fc.constant(false), localCount: count, writesMeta: fc.constant({ kind: 'change' as const, attempt: 'a' }) }),
  // P4-1: 13's direct change runs only when W differs from the stored count (74), so it never writes its own count.
  fc.tuple(fc.boolean(), count, count).filter(([, local, from]) => local !== from)
    .map(([boot, localCount, from]) => ({ boot, firstTake: false, localCount, writesMeta: { kind: 'direct' as const, from } })),
);
const live = (r: GateRow) => !r.released && r.expiresUpMs > U;
const open = (s: GateRead['state']) => s === 'standby' || s === 'flipped' || s === 'stopping';

describe('test 2: the take gate (56, 73, 77)', () => {
  it('commits exactly when step (1) passes and no live row of another count lies outside the exception', () => {
    fc.assert(fc.property(takeArb, readArb, fc.array(gateRowArb, { maxLength: 6 }), (take, read, rows) => {
      const verdict = takeGateVerdict(take, read, rows, U);
      let n: number | null;
      if (take.writesMeta) {
        const ok = take.writesMeta.kind === 'change'
          ? read.attempt === 'a' && read.state === 'stopping' && read.fromCount !== null && read.metaCount === read.fromCount && read.toCount === take.localCount
          : read.metaCount === take.writesMeta.from && !open(read.state);
        n = ok ? take.localCount : null;
      } else if (take.count !== undefined) n = read.metaCount === take.count ? take.count : null;
      else if (read.metaCount === null) n = take.firstTake ? take.localCount : null;
      else if (take.boot) n = read.state === 'stopping' ? null : read.metaCount;
      else n = take.localCount === read.metaCount ? read.metaCount : null;
      if (n === null) {
        expect(['count', 'need-count']).toContain(verdict.kind);
        return;
      }
      const blocking = rows.filter(r => r.shardCount !== n && live(r)
        && !(n === read.fromCount && r.shardCount === read.toCount && read.metaCount === read.fromCount));
      expect(verdict.kind).toBe(blocking.length > 0 ? 'held' : 'commit');
      if (verdict.kind !== 'commit') return;
      for (const d of verdict.deleted) {
        expect(live(d)).toBe(false);
        expect(d.shardCount === read.toCount && open(read.state)).toBe(false);
      }
      expect(verdict.close).toBe(read.state === 'flipped' && read.toCount === n && read.attempt !== null);
      expect(rows.some(r => r.shardCount !== n && r.shardCount !== read.toCount && live(r))).toBe(false);
    }), { numRuns: 2000 });
  });

  it('a take that writes meta never commits beside a live row of another count, and a boot take never over a stopping read', () => {
    fc.assert(fc.property(takeArb, readArb, fc.array(gateRowArb, { maxLength: 6 }), (take, read, rows) => {
      const verdict = takeGateVerdict(take, read, rows, U);
      if (verdict.kind !== 'commit') return;
      if (take.writesMeta) expect(rows.some(r => r.shardCount !== verdict.n && live(r))).toBe(false);
      if (take.boot && !take.writesMeta && read.metaCount !== null) expect(read.state).not.toBe('stopping');
    }), { numRuns: 2000 });
  });

  it('the boot flag changes no answer for a take that writes meta or carries its count (C1 gives the boot and running takes their own n)', () => {
    fc.assert(fc.property(takeArb, readArb, fc.array(gateRowArb, { maxLength: 6 }), (take, read, rows) => {
      if (!take.writesMeta && take.count === undefined) return;
      expect(takeGateVerdict({ ...take, boot: true }, read, rows, U)).toEqual(takeGateVerdict({ ...take, boot: false }, read, rows, U));
    }), { numRuns: 1000 });
  });
});

describe('test 2: takeOutcome (67) and the standby ask (65)', () => {
  it('runs the loss step only for a refusal, never for a failed statement', () => {
    const kinds: TakeKind[] = ['boot', 'running', 'redraw', 'retake', 'count-writing'];
    for (const kind of kinds) expect(takeOutcome(kind, 'failed').then).not.toBe('loss');
  });

  it('never answers started or running for the marked attempt', () => {
    fc.assert(fc.property(fc.boolean(), fc.boolean(), fc.boolean(), fc.option(fc.constantFrom('a', 'b'), { nil: null }), fc.option(fc.string(), { nil: null }),
      (exiting, standbyOfAttempt, busy, forkedFor, memoryReason) => {
        const answer = standbyAskVerdict({ attempt: 'a', exiting, overlapEnded: { attempt: 'a', code: 1, signal: null }, standbyOfAttempt, busy, forkedFor, memoryReason });
        expect(answer.state).toBe('refused');
      }));
  });
});

describe('test 2: wantedCount (4)', () => {
  it('never falls below the stored count without a target', () => {
    fc.assert(fc.property(fc.option(count, { nil: null }), fc.option(count, { nil: null }), (stored, recommendation) => {
      const w = wantedCount(null, stored, recommendation);
      if (stored !== null) expect(w).toBeGreaterThanOrEqual(stored);
    }));
  });
});

const machineArb = fc.record({ capacity: fc.integer({ min: 0, max: 4 }), takeoverSeconds: fc.constantFrom(30, 60) });

describe('test 2: spread (12, 36)', () => {
  it('gives every shard of W one machine, and no machine more than its target before every target is full', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 16 }), machineArb, fc.array(machineArb, { maxLength: 4 }), (w, mine, rest) => {
      const me: SpreadMachine = { nodeId: 'n-me', nodeName: 'ME', ...mine };
      const others: SpreadMachine[] = rest.map((m, i) => ({ nodeId: `n-${i}`, nodeName: `M${(i * 7) % 5}${i}`, ...m }));
      const owner = spread(w, me, others);
      expect(owner).toHaveLength(w);
      const ids = new Set([me, ...others].map(m => m.nodeId));
      for (const nodeId of owner) expect(ids.has(nodeId)).toBe(true);
      const total = [me, ...others].reduce((s, m) => s + m.capacity, 0);
      for (const m of [me, ...others]) {
        const got = owner.filter(id => id === m.nodeId).length;
        if (w <= total) expect(got).toBeLessThanOrEqual(m.capacity);
        else expect(got).toBeGreaterThanOrEqual(m.capacity);
      }
    }), { numRuns: 1000 });
  });

  it('a spread row holder never equals a process id: processId() holds no colon', () => {
    expect(processId()).not.toContain(':');
    expect(processId()).toBe(processId());
    expect(`spread:${processId()}`).not.toBe(processId());
  });
});

const row = (over: Partial<ReshardRow> = {}): ReshardRow => ({
  attempt: 'a', state: 'standby', method: 'overlap', fromCount: 2, toCount: 4, target: null, targetBy: null, targetAtMs: null,
  startedAtMs: NOW - 60_000, untilAtMs: NOW + 600_000, retryAfterMs: null, failures: 0, ...over,
});
const factRowArb = (counts: number[]): fc.Arbitrary<FactRow> => fc.record({
  shardCount: fc.constantFrom(...counts),
  shardId: fc.integer({ min: 0, max: 3 }),
  released: fc.boolean(),
  expiresUpMs: fc.constantFrom(U - 1, U + 30_000),
  ready: fc.boolean(),
  renewedAgoMs: fc.constantFrom(1000, 14_000, 16_000),
  ttlMs: fc.constant(30_000),
  holderProcess: fc.constantFrom('p1', 'p2'),
  holderNode: fc.constantFrom('n1', 'n2'),
  holderName: fc.constantFrom('M1', 'M2'),
});
const nodeArb = (nodeId: string): fc.Arbitrary<FactNode> => fc.record({
  nodeId: fc.constant(nodeId), nodeName: fc.constant(nodeId.toUpperCase()), processId: fc.constantFrom('p1', 'p2'),
  fit: fc.boolean(), restartable: fc.boolean(), reshardOverlap: fc.boolean(), seenAgoMs: fc.constantFrom(1000, 40_000),
  takeoverSeconds: fc.constant(30),
});
const factsArb: fc.Arbitrary<ReshardFacts> = fc.record({
  row: fc.constantFrom(row(), row({ state: 'flipped' }), row({ state: 'stopping', method: 'stop-start' })),
  metaCount: fc.constantFrom(2, 4),
  upMs: fc.constant(U),
  nowMs: fc.constant(NOW),
  rows: fc.array(factRowArb([2, 4]), { maxLength: 8 }),
  nodes: fc.tuple(nodeArb('n1'), nodeArb('n2')).map(t => [...t]),
});
const liveFact = (r: FactRow) => !r.released && r.expiresUpMs > U;

describe('test 2: the flip (8), the close (10) and the call-off (11, 32)', () => {
  it('flipVerdict is false whenever a new shard lacks a live, ready, fresh row or a live old row\'s machine is unfit', () => {
    fc.assert(fc.property(factsArb, facts => {
      if (!flipVerdict(facts, 'a')) return;
      for (let s = 0; s < 4; s++) {
        expect(facts.rows.some(r => r.shardCount === 4 && r.shardId === s && liveFact(r) && r.ready && r.renewedAgoMs < 15_000)).toBe(true);
      }
      for (const r of facts.rows.filter(x => x.shardCount === 2 && liveFact(x))) {
        const node = facts.nodes.find(n => n.nodeId === r.holderNode)!;
        expect(node.fit && node.restartable && node.processId === r.holderProcess && node.seenAgoMs < 30_000).toBe(true);
      }
      expect(facts.row.state).toBe('standby');
      expect(facts.metaCount).toBe(2);
    }), { numRuns: 2000 });
  });

  it('closeVerdict is false while any old row is live', () => {
    fc.assert(fc.property(factsArb, facts => {
      if (closeVerdict(facts, 'a').close) {
        expect(facts.rows.some(r => r.shardCount === 2 && liveFact(r))).toBe(false);
        expect(facts.row.state).toBe('flipped');
      }
    }), { numRuns: 1000 });
  });

  it('never calls off a flipped attempt, nor for a count change unless target_at is after started_at', () => {
    fc.assert(fc.property(factsArb, fc.option(count, { nil: null }), fc.integer({ min: -2, max: 2 }), (facts, target, edge) => {
      const f: ReshardFacts = { ...facts, row: { ...facts.row, target, targetBy: 'M2', targetAtMs: facts.row.startedAtMs! + edge * 1000 } };
      const verdict = callOffVerdict(f);
      if (f.row.state === 'flipped') expect(verdict).toBeNull();
      if (verdict?.reason.startsWith('FLEET_SHARD_COUNT')) expect(edge).toBeGreaterThan(0);
    }), { numRuns: 2000 });
  });
});

describe('test 2: the target edge (52)', () => {
  const T = claimTimings(30);
  const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };
  const step = fc.record({
    who: fc.constantFrom(0, 1),
    outcome: fc.constantFrom<'ok' | 'fails' | 'lost'>('ok', 'ok', 'fails', 'lost'),
    reboot: fc.boolean(),
  });

  it('over two processes sharing one node id with two values, target_at changes at most once per boot plus once per lost reply', async () => {
    await fc.assert(fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 30 }), fc.constantFrom<[number | null, number | null]>([4, 8], [null, 6], [6, null]), async (steps, settings) => {
      const store = new MemClaimStore(() => 1_000_000);
      const boots = [0, 0];
      const lost = new Map<string, number>();
      const make = (who: number) => new ShardClaims({
        store, me: { processId: `p${who}-${boots[who]}`, nodeId: 'n-shared', nodeName: `M${who}` }, timings: T, capacity: 4,
        takeoverSeconds: 30, returns: false, restartable: true, startedAt: 0, fitness: () => null, gateClosed: () => false,
        isStopping: () => false, stopServingStep: () => undefined, noteLapsed: () => undefined, noteLost: () => undefined,
        restartForShards: () => true, countSetting: () => settings[who], log: quiet,
      });
      const procs = [make(0), make(1)];
      for (const s of steps) {
        if (s.reboot) {
          boots[s.who] += 1;
          procs[s.who] = make(s.who);
        }
        store.renewMode = s.outcome === 'ok' ? 'ok' : new Error('Connection terminated');
        store.renewFailsAt = s.outcome === 'lost' ? 'reply' : 'statement';
        await procs[s.who].renewOnce();
        if (s.outcome === 'lost') lost.set(procs[s.who].processId, (lost.get(procs[s.who].processId) ?? 0) + 1);
      }
      const writes = new Map<string, number>();
      for (const w of store.targetWrites) writes.set(w.processId, (writes.get(w.processId) ?? 0) + 1);
      for (const [pid, n] of writes) expect(n).toBeLessThanOrEqual(1 + (lost.get(pid) ?? 0));
    }), { numRuns: 300 });
  });
});

// NB9 part 4a: the properties of chooseMethod (5) and handOverVerdict (25).
import { chooseMethod, handOverVerdict, type MethodNode } from '../../src/bot/internalSetup/fleet/reshardRules';

const methodNodeArb: fc.Arbitrary<MethodNode> = fc.record({
  nodeName: fc.constantFrom('A', 'B', 'C'),
  restartable: fc.boolean(),
  reshardOverlap: fc.boolean(),
  memoryRoom: fc.constantFrom<boolean | null>(true, false, null),
  memoryFreeMb: fc.option(fc.integer({ min: 0, max: 4000 }), { nil: null }),
  memoryUseMb: fc.option(fc.integer({ min: 0, max: 4000 }), { nil: null }),
  memoryError: fc.option(fc.string(), { nil: null }),
  memoryAgoMs: fc.option(fc.integer({ min: 0, max: 30 * 60_000 }), { nil: null }),
  startedAgoMs: fc.integer({ min: 0, max: 30 * 60_000 }),
});

describe('chooseMethod and handOverVerdict, properties', () => {
  it('chooseMethod answers overlap only when every machine allows it with a fresh true reading and failures stay below 2', () => {
    fc.assert(fc.property(fc.array(methodNodeArb, { minLength: 1, maxLength: 4 }), fc.integer({ min: 0, max: 3 }), fc.constantFrom<'setting' | 'discord'>('setting', 'discord'), (nodes, failures, source) => {
      const answer = chooseMethod(nodes, failures, source);
      const allowed = failures < 2 && nodes.every(n => n.restartable && n.reshardOverlap && n.memoryRoom === true && n.memoryAgoMs !== null && n.memoryAgoMs <= 15 * 60_000);
      expect('method' in answer && answer.method === 'overlap').toBe(allowed);
      if ('method' in answer && answer.method === 'stop-start') expect(source).toBe('setting');
    }), { numRuns: 500 });
  });

  it('handOverVerdict is true exactly when a granted process\'s count differs from meta and it holds no live row of meta\'s count', () => {
    fc.assert(fc.property(fc.boolean(), fc.option(count, { nil: null }), fc.option(count, { nil: null }), fc.boolean(), (granted, ownCount, metaCount, heldLiveOfMeta) => {
      const expected = granted && ownCount !== null && metaCount !== null && ownCount !== metaCount && !heldLiveOfMeta;
      expect(handOverVerdict({ granted, ownCount, metaCount, heldLiveOfMeta })).toBe(expected);
    }), { numRuns: 300 });
  });
});
