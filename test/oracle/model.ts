import fc from 'fast-check';
import { expect } from 'vitest';
import type * as JudgeModule from './judge.mjs';

// A model of a correct store, and every check the checker must pass, written
// against a judge module so the same checks also run against mutants of it.
//
// The model: every lane is sequential; an applied operation takes effect at
// one instant strictly inside its request, except an unanswered or ambiguous
// one, which may also land after the writer gave up; a read sees the effects
// before its own instant. The checker must raise no verdict on any such
// history, and must name each fault injected into one.

type J = typeof JudgeModule;
type Cls = 'ACKED' | 'HELD' | 'REFUSED-D' | 'REFUSED-A' | 'UNKNOWN';
interface Step { lane: number; kind: 'u' | 'h' | 'd' | 'r'; hot: number; gap: number; dur: number; cls: Cls; frac: number; applied: boolean; late: boolean; readFails: boolean; pick: number }
interface Op { id: number; lane: string; op: 'write' | 'delete'; kind: 'u' | 'h'; key: string; c: number; h: string | null; at: number; ansAt: number; cls: Cls; effectAt: number | null }
type ReadResult = { s: 'present'; h: string } | { s: 'absent' } | { s: 'error'; err: string };
interface ReadOp { id: number; lane: string; key: string; kind: 'u' | 'h'; at0: number; at1: number; t: number; result: ReadResult }

export const RUN = 'r1';
export const GUILD = '123456789012';

const stepModel = {
  lane: fc.nat(2),
  kind: fc.constantFrom<'u' | 'h' | 'd' | 'r'>('u', 'u', 'h', 'h', 'd', 'r'),
  hot: fc.nat(1),
  gap: fc.integer({ min: 0, max: 20 }),
  dur: fc.integer({ min: 1, max: 40 }),
  cls: fc.constantFrom<Cls>('ACKED', 'ACKED', 'ACKED', 'HELD', 'HELD', 'REFUSED-D', 'REFUSED-A', 'UNKNOWN'),
  frac: fc.double({ min: 0.01, max: 0.99, noNaN: true }),
  applied: fc.boolean(),
  late: fc.boolean(),
  readFails: fc.constantFrom(false, false, false, false, true),
  pick: fc.nat(1000),
};
const worldArb = fc.array(fc.record(stepModel), { minLength: 1, maxLength: 80 }).map(simulate);
// Contention on one hot doc, read back often: the case a stale hot read needs.
const hotWorldArb = fc.array(
  fc.record({ ...stepModel, lane: fc.nat(1), kind: fc.constantFrom<'h' | 'r'>('h', 'h', 'r'), hot: fc.constant(0), readFails: fc.constant(false) }),
  { minLength: 3, maxLength: 40 },
).map(simulate);

function simulate(steps: Step[]) {
  const cursor = [0, 0, 0];
  const ops: Op[] = [];
  const reads: ReadOp[] = [];
  const unique = [0, 0, 0];
  const counters = new Map<string, number>();
  const deletable: string[][] = [[], [], []];
  const ackedUnique: string[][] = [[], [], []];
  const failing = new Set<number>();
  let id = 0;
  for (const s of steps) {
    const lane = `l${s.lane}`;
    const at = cursor[s.lane] + s.gap;
    const ansAt = at + s.dur;
    const indeterminate = s.cls === 'REFUSED-A' || s.cls === 'UNKNOWN';
    const effectAt = s.cls === 'ACKED' || s.cls === 'HELD' || (indeterminate && s.applied)
      ? (indeterminate && s.late ? ansAt + s.frac * 200 : at + s.frac * s.dur)
      : null;
    if (s.kind === 'r') {
      const hotKey = `${RUN}-h${s.hot}.json`;
      // Any lane's committed docs, so a read can overlap another lane's write.
      const pool = ackedUnique.flat();
      const key = s.pick % 2 === 0 || pool.length === 0 ? hotKey : pool[s.pick % pool.length];
      reads.push({ id: ++id, lane, key, kind: key === hotKey ? 'h' : 'u', at0: at, at1: ansAt, t: at + s.frac * s.dur, result: { s: 'absent' } });
      if (s.readFails) failing.add(id);
    } else if (s.kind === 'd') {
      const pool = deletable[s.lane];
      if (pool.length === 0) continue;
      const key = pool.splice(s.pick % pool.length, 1)[0];
      ops.push({ id: ++id, lane, op: 'delete', kind: 'u', key, c: 0, h: null, at, ansAt, cls: s.cls, effectAt });
    } else if (s.kind === 'u') {
      unique[s.lane] += 1;
      const key = `${RUN}-${lane}-u${unique[s.lane]}.json`;
      ops.push({ id: ++id, lane, op: 'write', kind: 'u', key, c: unique[s.lane], h: `hu-${key}`, at, ansAt, cls: s.cls, effectAt });
      if (s.cls === 'ACKED') {
        deletable[s.lane].push(key);
        ackedUnique[s.lane].push(key);
      }
    } else {
      const key = `${RUN}-h${s.hot}.json`;
      const c = (counters.get(`${lane} ${key}`) ?? 0) + 1;
      counters.set(`${lane} ${key}`, c);
      ops.push({ id: ++id, lane, op: 'write', kind: 'h', key, c, h: `hh-${lane}-${key}-${c}`, at, ansAt, cls: s.cls, effectAt });
    }
    cursor[s.lane] = ansAt;
  }
  const effects = ops.filter(o => o.effectAt !== null).sort((a, b) => (a.effectAt as number) - (b.effectAt as number));
  const stateAt = (t: number) => {
    const state = new Map<string, string>();
    for (const e of effects) {
      if ((e.effectAt as number) >= t) break;
      if (e.op === 'write') state.set(e.key, e.h as string);
      else state.delete(e.key);
    }
    return state;
  };
  for (const r of reads) {
    const h = stateAt(r.t).get(r.key);
    r.result = failing.has(r.id) ? { s: 'error', err: '429' } : h === undefined ? { s: 'absent' } : { s: 'present', h };
  }
  return { ops, reads, final: stateAt(Infinity) };
}

type World = ReturnType<typeof simulate>;

/**
 * The writer logs of a world. Split: lane l2 writes its own log on another
 * clock, a million ms ahead, as a writer on a second host would.
 */
function logsOf(world: World, split = false): any[][] {
  const laneLog = (lane: string) => (split && lane === 'l2' ? 1 : 0);
  const shift = (lane: string) => (laneLog(lane) === 1 ? 1e6 : 0);
  const logs: any[][] = split
    ? [[{ t: 'start', run: RUN, guild: GUILD, lanes: [{ name: 'l0' }, { name: 'l1' }] }], [{ t: 'start', run: RUN, guild: GUILD, lanes: [{ name: 'l2' }] }]]
    : [[{ t: 'start', run: RUN, guild: GUILD, lanes: [{ name: 'l0' }, { name: 'l1' }, { name: 'l2' }] }]];
  for (const o of world.ops) {
    const d = shift(o.lane);
    const log = logs[laneLog(o.lane)];
    log.push({ t: 'send', id: o.id, lane: o.lane, op: o.op, kind: o.kind, key: o.key, c: o.c, h: o.h, at: o.at + d });
    const cls = o.cls === 'REFUSED-D' || o.cls === 'REFUSED-A' ? 'REFUSED' : o.cls;
    const status = o.cls === 'ACKED' ? 200 : o.cls === 'HELD' ? 202 : o.cls === 'UNKNOWN' ? 0 : 503;
    log.push({ t: 'ans', id: o.id, at: o.ansAt + d, status, cls, definite: o.cls === 'REFUSED-D' || o.cls === 'ACKED' || o.cls === 'HELD' });
  }
  const names = namesOf(world);
  for (const r of world.reads) {
    const d = shift(r.lane);
    const by = r.result.s === 'present' ? { by: names.get(r.result.h)?.lane } : {};
    logs[laneLog(r.lane)].push({ t: 'read', id: r.id, lane: r.lane, key: r.key, kind: r.kind, at0: r.at0 + d, at1: r.at1 + d, ...r.result, ...by });
  }
  for (const log of logs) log.push({ t: 'end' });
  return logs;
}

/**
 * The logs as a writer leaves them when log `which` is cut at world time t:
 * its later lines and its end line never arrive.
 */
function cutLogs(world: World, split: boolean, which: number, t: number): any[][] {
  return logsOf(world, split).map((log, i) => {
    if (i !== which) return log;
    const shift = split && i === 1 ? 1e6 : 0;
    return log.filter(e => e.t === 'start' || (e.t !== 'end' && (e.t === 'read' ? e.at1 : e.at) - shift < t));
  });
}

/** Each written hash, with the lane and counter its content names. */
const namesOf = (world: World) => new Map(world.ops.filter(o => o.op === 'write').map(o => [o.h as string, { lane: o.lane, c: o.c }]));

export function copyOf(name: string, docs: Map<string, string>, mode: 'judged' | 'lagging' = 'judged') {
  return { name, mode, complete: true, docs: new Map([...docs].map(([k, h]) => [k, { s: 'present' as const, h }])) };
}

/** A database copy of a world's docs, with the lane and counter each doc's content names, as dbCopy reads them. */
function namedCopyOf(world: World, docs: Map<string, string>) {
  const names = namesOf(world);
  return { name: 'db', mode: 'judged' as const, complete: true, docs: new Map([...docs].map(([k, h]) => [k, { s: 'present' as const, h, ...names.get(h) }])) };
}

const writesTo = (world: World, key: string) => world.ops.filter(o => o.op === 'write' && o.key === key);
const deletesOf = (world: World, key: string) => world.ops.filter(o => o.op === 'delete' && o.key === key);
const appliable = (o: Op) => o.cls !== 'REFUSED-D';

// Hand-built logs for the deterministic checks.
const start = (lanes: string[]) => ({ t: 'start', run: RUN, guild: GUILD, lanes: lanes.map(name => ({ name })) });
const send = (id: number, lane: string, key: string, c: number, h: string, at: number) =>
  ({ t: 'send', id, lane, op: 'write', kind: key.includes('-u') ? 'u' : 'h', key, c, h, at });
const ans = (id: number, at: number, cls = 'ACKED') =>
  ({ t: 'ans', id, at, status: cls === 'ACKED' ? 200 : cls === 'HELD' ? 202 : cls === 'UNKNOWN' ? 0 : 503, cls, definite: cls === 'ACKED' || cls === 'HELD' });
const u = (lane: string, n: number) => `${RUN}-${lane}-u${n}.json`;
const hot = (k: number) => `${RUN}-h${k}.json`;
/** Six acknowledged unique writes by lane a, at t = 10 to 60. */
const sixAcked = () => [1, 2, 3, 4, 5, 6].flatMap(n => [send(n, 'a', u('a', n), n, `x${n}`, n * 10), ans(n, n * 10 + 1)]);
const sixDocs = () => new Map([1, 2, 3, 4, 5, 6].map(n => [u('a', n), `x${n}`]));
const fleetNode = (nodeId: string, leases: number[], over: Partial<{
  name: string; initialized: boolean; table: ([number, string] | [number, string, string])[]; guildMap: Record<string, number>; shardCount: number;
}> = {}) => ({
  name: over.name ?? nodeId,
  state: {
    initialized: over.initialized ?? true, running: true, role: 'co-worker', standalone: false, nodeId, shardCount: over.shardCount ?? 2, followerHold: false,
    leases: leases.map(shardId => ({ shardId })),
    shardTable: (over.table ?? []).map(([shardId, owner, status]) => ({ shardId, nodeId: owner, status: status ?? 'Ready' })),
    guildMap: over.guildMap ?? {},
  },
});
/** n acknowledged unique writes by one lane, at t = 10, 20, ... */
const ackedRun = (lane: string, n: number) => Array.from({ length: n }, (_, i) => [send(i + 1, lane, u(lane, i + 1), i + 1, `x${i + 1}`, (i + 1) * 10), ans(i + 1, (i + 1) * 10 + 1)]).flat();

export interface Check { name: string; run: (J: J, numRuns: number) => void }

export function checks(): Check[] {
  const judgeWorld = (J: J, world: World, copies: ReturnType<typeof copyOf>[], split = false) =>
    J.judge({ history: J.buildHistory(logsOf(world, split)), copies, k: 0, noFleet: true });
  const only = (r: { verdicts: { v: string; key?: string; during?: boolean }[] }, v: string, key: string) => {
    expect(r.verdicts.some(x => x.v === v && x.key === key && !x.during)).toBe(true);
    expect(r.verdicts.filter(x => !x.during).every(x => x.key === key)).toBe(true);
  };
  const judgeLog = (J: J, log: any[], copies: any[], extra: Record<string, unknown> = {}) =>
    J.judge({ history: J.buildHistory([log]), copies, k: 0, noFleet: true, ...extra });

  return [
    // Silence on a correct store.
    { name: 'no verdict on any history a correct store allows', run: (J, numRuns) => fc.assert(fc.property(worldArb, world => {
      expect(judgeWorld(J, world, [copyOf('db', world.final)]).verdicts).toEqual([]);
    }), { numRuns }) },
    { name: 'no verdict across two logs on two clocks', run: (J, numRuns) => fc.assert(fc.property(worldArb, world => {
      expect(judgeWorld(J, world, [copyOf('db', world.final)], true).verdicts).toEqual([]);
    }), { numRuns }) },
    { name: 'no verdict beside a lagging copy holding an older prefix', run: (J, numRuns) => fc.assert(fc.property(worldArb, fc.double({ min: 0, max: 1, noNaN: true }), (world, cut) => {
      const end = Math.max(0, ...world.ops.map(o => o.ansAt));
      const older = new Map<string, string>();
      for (const e of world.ops.filter(o => o.effectAt !== null && (o.effectAt as number) < cut * end).sort((a, b) => (a.effectAt as number) - (b.effectAt as number))) {
        if (e.op === 'write') older.set(e.key, e.h as string);
        else older.delete(e.key);
      }
      expect(judgeWorld(J, world, [copyOf('db', world.final), copyOf('standby', older, 'lagging')]).verdicts).toEqual([]);
    }), { numRuns }) },
    { name: 'no firm verdict when a log is cut short, whatever its tail did', run: (J, numRuns) => fc.assert(fc.property(worldArb, fc.double({ min: 0, max: 1, noNaN: true }), fc.boolean(), (world, frac, split) => {
      const end = Math.max(0, ...world.ops.map(o => o.ansAt), ...world.reads.map(r => r.at1));
      const logs = cutLogs(world, split, split ? 1 : 0, frac * end);
      const r = J.judge({ history: J.buildHistory(logs), copies: [namedCopyOf(world, world.final)], k: 0, noFleet: true });
      expect(r.verdicts.filter(v => !v.provisional)).toEqual([]);
    }), { numRuns }) },
    { name: 'no verdict from failed reads or a partial app copy', run: (J, numRuns) => fc.assert(fc.property(worldArb, fc.array(fc.nat(2), { minLength: 200, maxLength: 200 }), (world, picks) => {
      const keys = [...new Set(world.ops.map(o => o.key))];
      const docs = new Map<string, any>();
      keys.forEach((key, i) => {
        const pick = picks[i % picks.length];
        if (pick === 1) docs.set(key, { s: 'error', err: '429' });
        if (pick === 2) docs.set(key, world.final.has(key) ? { s: 'present', h: world.final.get(key) } : { s: 'absent' });
      });
      const app = { name: 'app', mode: 'judged' as const, complete: false, docs, run: RUN, guild: GUILD, sample: false };
      expect(judgeWorld(J, world, [copyOf('db', world.final), app as any]).verdicts).toEqual([]);
    }), { numRuns }) },

    // Each fault, named on the doc it hit.
    { name: 'LOST: an acknowledged doc is missing', run: (J, numRuns) => fc.assert(fc.property(worldArb, fc.nat(), (world, pick) => {
      const keys = world.ops.filter(o => o.op === 'write' && o.kind === 'u' && o.cls === 'ACKED' && !deletesOf(world, o.key).some(appliable)).map(o => o.key);
      fc.pre(keys.length > 0);
      const key = keys[pick % keys.length];
      const docs = new Map(world.final);
      docs.delete(key);
      only(judgeWorld(J, world, [copyOf('db', docs)]), 'LOST', key);
    }), { numRuns }) },
    { name: 'ROLLBACK: a hot doc goes back to an older acknowledged counter', run: (J, numRuns) => fc.assert(fc.property(worldArb, fc.nat(), (world, pick) => {
      const older = world.ops.filter(o => o.op === 'write' && o.kind === 'h' && o.cls === 'ACKED'
        && writesTo(world, o.key).some(w => w.lane === o.lane && w.cls === 'ACKED' && w.c > o.c));
      fc.pre(older.length > 0);
      const o = older[pick % older.length];
      const docs = new Map(world.final);
      docs.set(o.key, o.h as string);
      only(judgeWorld(J, world, [copyOf('db', docs)]), 'ROLLBACK', o.key);
    }), { numRuns }) },
    { name: 'ROLLBACK: a hot doc goes back to an older held write', run: (J, numRuns) => fc.assert(fc.property(hotWorldArb, fc.nat(), (world, pick) => {
      const held = world.ops.filter(o => o.kind === 'h' && o.cls === 'HELD' && writesTo(world, o.key).some(w => w.lane === o.lane && w.cls === 'ACKED' && w.c > o.c));
      fc.pre(held.length > 0);
      const o = held[pick % held.length];
      const docs = new Map(world.final);
      docs.set(o.key, o.h as string);
      only(judgeWorld(J, world, [copyOf('db', docs)]), 'ROLLBACK', o.key);
    }), { numRuns }) },
    { name: 'HELD-MISSING: a held hot write was overtaken by an older one', run: (J, numRuns) => fc.assert(fc.property(hotWorldArb, fc.nat(), (world, pick) => {
      const cases = world.ops.filter(x => {
        if (x.kind !== 'h' || (x.cls !== 'ACKED' && x.cls !== 'HELD')) return false;
        const after = writesTo(world, x.key).filter(w => (w.cls === 'ACKED' || w.cls === 'HELD') && w !== x
          && ((w.lane === x.lane && w.c > x.c) || (w.lane !== x.lane && w.at > x.ansAt)));
        return after.length > 0 && after.every(w => w.cls === 'HELD');
      });
      fc.pre(cases.length > 0);
      const x = cases[pick % cases.length];
      const docs = new Map(world.final);
      docs.set(x.key, x.h as string);
      only(judgeWorld(J, world, [copyOf('db', docs)]), 'HELD-MISSING', x.key);
    }), { numRuns }) },
    { name: 'RESURRECTED: a doc whose delete was acknowledged is back', run: (J, numRuns) => fc.assert(fc.property(worldArb, fc.nat(), (world, pick) => {
      const dels = world.ops.filter(o => o.op === 'delete' && o.cls === 'ACKED');
      fc.pre(dels.length > 0);
      const d = dels[pick % dels.length];
      const docs = new Map(world.final);
      docs.set(d.key, writesTo(world, d.key)[0].h as string);
      only(judgeWorld(J, world, [copyOf('db', docs)]), 'RESURRECTED', d.key);
    }), { numRuns }) },
    { name: 'PHANTOM: a write refused before applying is present', run: (J, numRuns) => fc.assert(fc.property(worldArb, fc.nat(), (world, pick) => {
      const refused = world.ops.filter(o => o.op === 'write' && o.kind === 'u' && o.cls === 'REFUSED-D');
      fc.pre(refused.length > 0);
      const w = refused[pick % refused.length];
      const docs = new Map(world.final);
      docs.set(w.key, w.h as string);
      only(judgeWorld(J, world, [copyOf('db', docs)]), 'PHANTOM', w.key);
    }), { numRuns }) },
    { name: 'HELD-MISSING: a held unique doc never arrived', run: (J, numRuns) => fc.assert(fc.property(worldArb, fc.nat(), (world, pick) => {
      const held = world.ops.filter(o => o.op === 'write' && o.kind === 'u' && o.cls === 'HELD');
      fc.pre(held.length > 0);
      const w = held[pick % held.length];
      const docs = new Map(world.final);
      docs.delete(w.key);
      only(judgeWorld(J, world, [copyOf('db', docs)]), 'HELD-MISSING', w.key);
    }), { numRuns }) },
    { name: 'WRONG-CONTENT: a present doc holds bytes nobody wrote', run: (J, numRuns) => fc.assert(fc.property(worldArb, fc.nat(), (world, pick) => {
      const keys = [...world.final.keys()];
      fc.pre(keys.length > 0);
      const key = keys[pick % keys.length];
      const docs = new Map(world.final);
      docs.set(key, 'not-a-written-hash');
      only(judgeWorld(J, world, [copyOf('db', docs)]), 'WRONG-CONTENT', key);
    }), { numRuns }) },
    { name: 'FORK: two copies each hold an acknowledged doc the other lacks', run: (J, numRuns) => fc.assert(fc.property(worldArb, fc.nat(), fc.nat(), (world, p1, p2) => {
      const keys = world.ops.filter(o => o.op === 'write' && o.kind === 'u' && o.cls === 'ACKED' && deletesOf(world, o.key).length === 0).map(o => o.key);
      fc.pre(keys.length >= 2);
      const a = keys[p1 % keys.length];
      const b = keys[(p1 % keys.length + 1 + (p2 % (keys.length - 1))) % keys.length];
      const docsA = new Map(world.final);
      const docsB = new Map(world.final);
      docsA.delete(b);
      docsB.delete(a);
      expect(judgeWorld(J, world, [copyOf('a', docsA), copyOf('b', docsB, 'lagging')]).verdicts.some(v => v.v === 'FORK')).toBe(true);
    }), { numRuns }) },
    { name: 'a stale read during the run: an acknowledged doc served as absent', run: (J, numRuns) => fc.assert(fc.property(worldArb, fc.nat(), (world, pick) => {
      const stale = world.reads.filter(r => {
        if (r.kind !== 'u' || r.result.s !== 'present') return false;
        const w = writesTo(world, r.key)[0];
        return w.cls === 'ACKED' && w.ansAt < r.at0 && !deletesOf(world, r.key).some(d => appliable(d) && d.at <= r.at1);
      });
      fc.pre(stale.length > 0);
      const r = stale[pick % stale.length];
      r.result = { s: 'absent' };
      expect(judgeWorld(J, world, [copyOf('db', world.final)]).verdicts.some(v => v.v === 'LOST' && v.during && v.key === r.key)).toBe(true);
    }), { numRuns }) },
    { name: 'a stale read during the run: a hot doc served with an older counter', run: (J, numRuns) => fc.assert(fc.property(hotWorldArb, fc.nat(), (world, pick) => {
      const cases: { read: ReadOp; older: Op }[] = [];
      for (const r of world.reads) {
        if (r.kind !== 'h') continue;
        for (const o of writesTo(world, r.key)) {
          if (o.cls === 'ACKED' && writesTo(world, r.key).some(w => w.lane === o.lane && w.cls === 'ACKED' && w.c > o.c && w.ansAt < r.at0)) cases.push({ read: r, older: o });
        }
      }
      fc.pre(cases.length > 0);
      const { read, older } = cases[pick % cases.length];
      read.result = { s: 'present', h: older.h as string };
      expect(judgeWorld(J, world, [copyOf('db', world.final)]).verdicts.some(v => v.v === 'ROLLBACK' && v.during && v.key === read.key)).toBe(true);
    }), { numRuns }) },

    // The ordering rules, one hand-built case each, so no rule rests on what the generator happens to draw.
    { name: 'ordering rules, case by case', run: J => {
      const k = hot(0);
      const verdicts = (log: any[], docs: Map<string, string>, mode: 'judged' | 'lagging' = 'judged') =>
        judgeLog(J, [...log, { t: 'end' }], [copyOf('db', docs, mode)]).verdicts.map((v: { v: string }) => v.v);
      // Two lanes' writes that overlap may land in either order.
      const overlap = [start(['a', 'b']), send(1, 'a', k, 1, 'a1', 10), send(2, 'b', k, 1, 'b1', 20), ans(1, 30), ans(2, 40)];
      expect(verdicts(overlap, new Map([[k, 'a1']]))).toEqual([]);
      // One sent after the other was answered must land after it.
      const ordered = [start(['a', 'b']), send(1, 'a', k, 1, 'a1', 10), ans(1, 15), send(2, 'b', k, 1, 'b1', 20), ans(2, 40)];
      expect(verdicts(ordered, new Map([[k, 'a1']]))).toEqual(['LOST']);
      // A held write later in the lane must land too.
      const held = [start(['a']), send(1, 'a', k, 1, 'a1', 10), ans(1, 15), send(2, 'a', k, 2, 'a2', 20), ans(2, 25, 'HELD')];
      expect(verdicts(held, new Map([[k, 'a1']]))).toEqual(['HELD-MISSING']);
      // A write refused before applying must not be present.
      const refused = [start(['a']), send(1, 'a', u('a', 1), 1, 'x1', 10), { t: 'ans', id: 1, at: 15, status: 503, cls: 'REFUSED', definite: true }];
      expect(verdicts(refused, new Map([[u('a', 1), 'x1']]))).toEqual(['PHANTOM']);
      // A lagging copy may lack what was acknowledged; a judged one may not.
      const one = [start(['a']), send(1, 'a', u('a', 1), 1, 'x1', 10), ans(1, 15)];
      expect(verdicts(one, new Map(), 'lagging')).toEqual([]);
      expect(verdicts(one, new Map())).toEqual(['LOST']);
      // A read sent while the write was still in flight may miss it; one sent after its answer may not.
      const inflight = [...one.slice(0, 2), { t: 'read', id: 2, lane: 'a', key: u('a', 1), kind: 'u', at0: 12, at1: 13, s: 'absent' }, one[2]];
      expect(verdicts(inflight, new Map([[u('a', 1), 'x1']]))).toEqual([]);
      const after = [...one, { t: 'read', id: 2, lane: 'a', key: u('a', 1), kind: 'u', at0: 16, at1: 17, s: 'absent' }];
      expect(verdicts(after, new Map([[u('a', 1), 'x1']]))).toEqual(['LOST']);
      // Two logs keep two clocks: a send stamped later on the other clock orders nothing.
      const logA = [start(['a']), send(1, 'a', k, 1, 'a1', 10), ans(1, 15), { t: 'end' }];
      const logB = [start(['b']), send(1, 'b', k, 1, 'b1', 1e6), ans(1, 1e6 + 5), { t: 'end' }];
      expect(J.judge({ history: J.buildHistory([logA, logB]), copies: [copyOf('db', new Map([[k, 'a1']]))], k: 0, noFleet: true }).verdicts).toEqual([]);
    } },

    // What makes a run inconclusive, never a pass.
    { name: 'a window with too few acknowledged writes is inconclusive', run: J => {
      const log = [start(['a']), ...sixAcked(), { t: 'mark', label: 'begin kill', at: 100 }, { t: 'mark', label: 'end kill', at: 200 }, { t: 'end' }];
      const r = J.judge({ history: J.buildHistory([log]), copies: [copyOf('db', sixDocs())], k: 1, noFleet: true });
      expect(r.result).toBe('INCONCLUSIVE');
      expect(r.inconclusive.join('\n')).toMatch(/window kill: 0 acknowledged/);
    } },
    { name: 'a mark that is not exactly begin or end NAME is inconclusive', run: J => {
      for (const marks of [['Begin kill', 'End kill'], ['begin-kill', 'end-kill'], ['end kill'], ['begin kill'], ['begin kill', 'begin kill', 'end kill']]) {
        const log = [start(['a']), ...sixAcked(), ...marks.map((label, i) => ({ t: 'mark', label, at: 5 + i })), { t: 'end' }];
        expect(judgeLog(J, log, [copyOf('db', sixDocs())]).result).toBe('INCONCLUSIVE');
      }
      const good = [start(['a']), { t: 'mark', label: 'begin kill', at: 5 }, ...sixAcked(), { t: 'mark', label: 'end kill', at: 70 }, { t: 'end' }];
      expect(judgeLog(J, good, [copyOf('db', sixDocs())]).result).toBe('PASS');
      // A mark is stamped when the writer polls for it, so a slow poll moves window edges.
      const polled = (marksEvery: number) => [{ ...start(['a']), settings: { marksEvery } }, ...good.slice(1)];
      expect(judgeLog(J, polled(1000), [copyOf('db', sixDocs())]).result).toBe('PASS');
      expect(judgeLog(J, polled(60000), [copyOf('db', sixDocs())]).result).toBe('INCONCLUSIVE');
    } },
    { name: 'a run with no marks and too few acknowledged writes is inconclusive', run: J => {
      const log = [start(['a']), ...sixAcked(), { t: 'end' }];
      const r = J.judge({ history: J.buildHistory([log]), copies: [copyOf('db', sixDocs())], k: 7, noFleet: true });
      expect(r.result).toBe('INCONCLUSIVE');
      expect(r.inconclusive.join('\n')).toMatch(/only 6 acknowledged operations in the run, 7 needed/);
    } },
    { name: 'a required window that was never marked is inconclusive', run: J => {
      const log = [start(['a']), ...sixAcked(), { t: 'end' }];
      expect(judgeLog(J, log, [copyOf('db', sixDocs())], { windows: ['kill'] }).result).toBe('INCONCLUSIVE');
    } },
    { name: 'an app copy that could not read committed docs is inconclusive', run: J => {
      const log = [start(['a']), ...sixAcked(), { t: 'end' }];
      const errors = new Map([1, 2, 3, 4, 5, 6].map(n => [u('a', n), { s: 'error', err: '429' }]));
      const app = { name: 'app', mode: 'judged', complete: false, docs: errors, run: RUN, guild: GUILD, sample: false };
      const r = judgeLog(J, log, [copyOf('db', sixDocs()), app]);
      expect(r.result).toBe('INCONCLUSIVE');
      expect(r.inconclusive.join('\n')).toMatch(/app could not read 6 committed docs/);
    } },
    { name: 'an app copy missing rows is inconclusive unless it is a sample', run: J => {
      const log = [start(['a']), ...sixAcked(), { t: 'end' }];
      const two = new Map([1, 2].map(n => [u('a', n), { s: 'present', h: `x${n}` }]));
      const full = { name: 'app', mode: 'judged', complete: false, docs: two, run: RUN, guild: GUILD, sample: false };
      expect(judgeLog(J, log, [copyOf('db', sixDocs()), full]).result).toBe('INCONCLUSIVE');
      expect(judgeLog(J, log, [copyOf('db', sixDocs()), { ...full, sample: true }]).result).toBe('PASS');
      // A sample that holds no committed doc judged nothing.
      expect(judgeLog(J, log, [copyOf('db', sixDocs()), { ...full, docs: new Map(), sample: true }]).result).toBe('INCONCLUSIVE');
    } },
    { name: 'an app copy of another run is refused', run: J => {
      const log = [start(['a']), ...sixAcked(), { t: 'end' }];
      const other = { name: 'app', mode: 'judged', complete: false, docs: new Map(), run: 'r0', guild: GUILD, sample: false };
      expect(() => judgeLog(J, log, [copyOf('db', sixDocs()), other])).toThrow(/run r0/);
    } },
    { name: 'no judged copy is inconclusive', run: J => {
      const log = [start(['a']), ...sixAcked(), { t: 'end' }];
      expect(judgeLog(J, log, [copyOf('standby', sixDocs(), 'lagging')]).result).toBe('INCONCLUSIVE');
    } },
    { name: 'copies that must agree but differ are a FORK', run: J => {
      const log = [start(['a']), ...sixAcked(), { t: 'end' }];
      const five = sixDocs();
      five.delete(u('a', 6));
      const r = judgeLog(J, log, [copyOf('db', sixDocs()), copyOf('other', five, 'lagging')], { agree: ['db', 'other'] });
      expect(r.verdicts.some(v => v.v === 'FORK')).toBe(true);
    } },
    { name: 'a cut log is inconclusive, and only what its unlogged tail could explain is provisional', run: J => {
      const cutLog = [start(['a']), ...sixAcked()];
      expect(judgeLog(J, cutLog, [copyOf('db', sixDocs())]).result).toBe('INCONCLUSIVE');
      const named = (h: string, lane: string, c: number) => ({ s: 'present' as const, h, lane, c });
      const db = (docs: [string, ReturnType<typeof named>][], base = sixDocs()) => {
        const copy = copyOf('db', base);
        for (const [key, state] of docs) copy.docs.set(key, state);
        return copy;
      };
      // A writer that ran on past its cut log leaves docs only its tail names: listed, not a FAIL.
      const ranOn = judgeLog(J, cutLog, [db([[u('a', 400), named('x', 'a', 400)], [hot(0), named('h', 'a', 9)]])]);
      expect(ranOn.result).toBe('INCONCLUSIVE');
      expect(ranOn.verdicts.map(v => `${v.v} ${v.provisional}`)).toEqual(['PHANTOM true', 'PHANTOM true']);
      // A mass loss in the cut lane waits for the writer's complete log; with its end line it fails.
      const many = judgeLog(J, [start(['a']), ...ackedRun('a', 50)], [copyOf('db', new Map())]);
      expect(many.result).toBe('INCONCLUSIVE');
      expect(many.verdicts.filter(v => v.v === 'LOST' && v.provisional)).toHaveLength(50);
      expect(judgeLog(J, [start(['a']), ...ackedRun('a', 50), { t: 'end' }], [copyOf('db', new Map())]).result).toBe('FAIL');
      // Content naming an ended lane is no tail's: a cut log beside it changes nothing.
      const twoLogs = J.buildHistory([[start(['a']), send(1, 'a', hot(0), 1, 'h1', 10), ans(1, 11)], [start(['b']), { t: 'end' }]]);
      const judgeTwo = (docs: [string, ReturnType<typeof named>][]) => J.judge({ history: twoLogs, copies: [db(docs, new Map())], k: 0, noFleet: true }).result;
      expect(judgeTwo([[hot(0), named('h1', 'a', 1)]])).toBe('INCONCLUSIVE');
      expect(judgeTwo([[hot(0), named('altered', 'a', 2)]])).toBe('INCONCLUSIVE');
      expect(judgeTwo([[hot(0), named('altered', 'b', 2)]])).toBe('FAIL');
      expect(judgeTwo([[hot(0), named('h1', 'a', 1)], [u('a', 9), named('x', 'a', 9)]])).toBe('INCONCLUSIVE');
      expect(judgeTwo([[hot(0), named('h1', 'a', 1)], [u('b', 9), named('x', 'b', 9)]])).toBe('FAIL');
      // What no tail can explain still fails: a double lease, a resurrected doc, a rollback, a stale read, another writer's loss.
      expect(J.judge({ history: J.buildHistory([cutLog]), copies: [copyOf('db', sixDocs())], k: 0, fleet: [fleetNode('m', [0, 1]), fleetNode('w', [1])] }).result).toBe('FAIL');
      const del = [...cutLog, { t: 'send', id: 7, lane: 'a', op: 'delete', kind: 'u', key: u('a', 1), c: 0, h: null, at: 70 }, ans(7, 71)];
      expect(judgeLog(J, del, [copyOf('db', sixDocs())]).result).toBe('FAIL');
      const rolled = [start(['a']), send(1, 'a', hot(0), 1, 'h1', 10), ans(1, 11), send(2, 'a', hot(0), 2, 'h2', 20), ans(2, 21)];
      expect(judgeLog(J, rolled, [copyOf('db', new Map([[hot(0), 'h1']]))]).result).toBe('FAIL');
      const stale = [...cutLog, { t: 'read', id: 7, lane: 'a', key: u('a', 1), kind: 'u', at0: 70, at1: 71, s: 'absent' }];
      expect(judgeLog(J, stale, [copyOf('db', sixDocs())]).result).toBe('FAIL');
      const other = [start(['b']), send(1, 'b', u('b', 1), 1, 'y1', 10), ans(1, 11), { t: 'end' }];
      expect(J.judge({ history: J.buildHistory([cutLog, other]), copies: [copyOf('db', sixDocs())], k: 0, noFleet: true }).result).toBe('FAIL');
      // A read of hot content no logged write has: its own log holds every send before it, another writer's cut log may not.
      const hotA = [start(['a']), send(1, 'a', hot(0), 1, 'h1', 10), ans(1, 11)];
      const served = (id: number, lane: string, at: number) => ({ t: 'read', id, lane, key: hot(0), kind: 'h', at0: at, at1: at + 1, s: 'present', h: 'altered', by: 'a', c: 2 });
      const hotDb = () => copyOf('db', new Map([[hot(0), 'h1']]));
      expect(judgeLog(J, [...hotA, served(2, 'a', 20)], [hotDb()]).result).toBe('FAIL');
      const readInB = J.buildHistory([hotA, [start(['b']), served(1, 'b', 5), { t: 'end' }]]);
      expect(J.judge({ history: readInB, copies: [hotDb()], k: 0, noFleet: true }).result).toBe('INCONCLUSIVE');
      // A FORK whose one side lacks only docs of cut lanes may be unlogged deletes beside lag; of ended lanes it fails.
      const docsOf = (n: number[]) => new Map(n.map(i => [u('a', i), `x${i}`]));
      const forkA = judgeLog(J, cutLog, [copyOf('db', docsOf([1, 2, 3, 4, 5])), copyOf('standby', docsOf([1, 2, 3, 4, 6]), 'lagging')]);
      expect(forkA.verdicts.map(v => `${v.v} ${v.provisional}`).sort()).toEqual(['FORK true', 'LOST true']);
      const both = new Map([...sixDocs(), [u('b', 1), 'y1'], [u('b', 2), 'y2']]);
      const twoB = [start(['b']), send(1, 'b', u('b', 1), 1, 'y1', 10), ans(1, 11), send(2, 'b', u('b', 2), 2, 'y2', 20), ans(2, 21), { t: 'end' }];
      const forkB = J.judge({
        history: J.buildHistory([cutLog, twoB]), k: 0, noFleet: true,
        copies: [copyOf('db', both), copyOf('s1', new Map([[u('b', 1), 'y1']]), 'lagging'), copyOf('s2', new Map([[u('b', 2), 'y2']]), 'lagging')],
      });
      expect(forkB.result).toBe('FAIL');
      expect(forkB.verdicts.map(v => v.v)).toEqual(['FORK']);
    } },
    { name: 'reads during the run name resurrected, wrong and vanished docs', run: J => {
      const one = [start(['a']), send(1, 'a', u('a', 1), 1, 'x1', 10), ans(1, 11)];
      const during = (log: any[], docs: Map<string, string>) =>
        judgeLog(J, [...log, { t: 'end' }], [copyOf('db', docs)]).verdicts.filter((v: { during?: boolean }) => v.during).map((v: { v: string }) => v.v);
      const deleted = [...one, { t: 'send', id: 2, lane: 'a', op: 'delete', kind: 'u', key: u('a', 1), c: 0, h: null, at: 20 }, ans(2, 21),
        { t: 'read', id: 3, lane: 'a', key: u('a', 1), kind: 'u', at0: 30, at1: 31, s: 'present', h: 'x1' }];
      expect(during(deleted, new Map())).toEqual(['RESURRECTED']);
      const wrong = [...one, { t: 'read', id: 2, lane: 'a', key: u('a', 1), kind: 'u', at0: 30, at1: 31, s: 'present', h: 'other' }];
      expect(during(wrong, new Map([[u('a', 1), 'x1']]))).toEqual(['WRONG-CONTENT']);
      const vanished = [start(['a']), send(1, 'a', hot(0), 1, 'h1', 10), ans(1, 11), { t: 'read', id: 2, lane: 'a', key: hot(0), kind: 'h', at0: 30, at1: 31, s: 'absent' }];
      expect(during(vanished, new Map([[hot(0), 'h1']]))).toEqual(['LOST']);
    } },
    { name: 'a hot doc ending on an unanswered write after committed ones is inconclusive', run: J => {
      const k = hot(0);
      // a1 got no answer; b1 and a2 were committed after it gave up; the copy holds a1.
      const log = [start(['a', 'b']), send(1, 'a', k, 1, 'a1', 300), ans(1, 320, 'UNKNOWN'), send(2, 'b', k, 1, 'b1', 330), ans(2, 331),
        send(3, 'a', k, 2, 'a2', 340), ans(3, 341), { t: 'end' }];
      const r = judgeLog(J, log, [copyOf('db', new Map([[k, 'a1']]))]);
      expect(r.verdicts).toEqual([]);
      expect(r.result).toBe('INCONCLUSIVE');
      // Across lanes alone too.
      const cross = [start(['a', 'b']), send(1, 'a', k, 1, 'a1', 300), ans(1, 320, 'UNKNOWN'), send(2, 'b', k, 1, 'b1', 330), ans(2, 331), { t: 'end' }];
      expect(judgeLog(J, cross, [copyOf('db', new Map([[k, 'a1']]))]).result).toBe('INCONCLUSIVE');
      // And a read that serves it after the committed one was answered.
      const read = [...cross.slice(0, -1), { t: 'read', id: 3, lane: 'b', key: k, kind: 'h', at0: 340, at1: 341, s: 'present', h: 'a1' }, { t: 'end' }];
      const rr = judgeLog(J, read, [copyOf('db', new Map([[k, 'b1']]))]);
      expect(rr.verdicts).toEqual([]);
      expect(rr.result).toBe('INCONCLUSIVE');
    } },
    { name: 'missing or unreadable control facts are inconclusive', run: J => {
      const log = [start(['a']), ...sixAcked(), { t: 'end' }];
      const history = J.buildHistory([log]);
      const copies = [copyOf('db', sixDocs())];
      expect(J.judge({ history, copies, k: 0 }).result).toBe('INCONCLUSIVE');
      expect(J.judge({ history, copies, k: 0, fleet: [fleetNode('m', [0]), fleetNode('w', [1])] }).result).toBe('PASS');
      expect(J.judge({ history, copies, k: 0, fleet: [fleetNode('m', [0]), fleetNode('w', [1], { initialized: false })] }).result).toBe('INCONCLUSIVE');
      // In the second set too.
      const again = [fleetNode('m', [0]), fleetNode('w', [1], { initialized: false })];
      expect(J.judge({ history, copies, k: 0, fleet: [fleetNode('m', [0]), fleetNode('w', [1])], fleetAgain: again }).result).toBe('INCONCLUSIVE');
    } },
    { name: 'a shard leased twice, or against the shard table, is CONTROL', run: J => {
      const twice = J.judgeFleet([fleetNode('m', [0, 1]), fleetNode('w', [1])]).map(v => v.detail);
      expect(twice.some(d => /shard 1 is leased to 2 nodes/.test(d))).toBe(true);
      const table = J.judgeFleet([fleetNode('m', [0], { table: [[0, 'm'], [1, 'w']] }), fleetNode('x', [1])]).map(v => v.detail);
      expect(table.some(d => /shard 1 is leased by x, but a shard table gives it to w/.test(d))).toBe(true);
      expect(J.judgeFleet([fleetNode('m', [0], { table: [[0, 'm'], [1, 'w']] }), fleetNode('w', [1])])).toEqual([]);
      // A grant not yet confirmed names its target before the old holder lets go.
      expect(J.judgeFleet([fleetNode('m', [0], { table: [[0, 'm'], [1, 'w', 'pending']] }), fleetNode('x', [1])])).toEqual([]);
      // judge() counts them from one set of facts.
      const history = J.buildHistory([[start(['a']), ...sixAcked(), { t: 'end' }]]);
      const one = J.judge({ history, copies: [copyOf('db', sixDocs())], k: 0, fleet: [fleetNode('m', [0, 1]), fleetNode('w', [1])] });
      expect(one.verdicts.map(v => v.v)).toEqual(['CONTROL']);
    } },
    { name: 'a guild on two shards or out of range, or two shard counts, is CONTROL', run: J => {
      const guilds = J.judgeFleet([fleetNode('m', [0], { guildMap: { 10: 0, 11: 1 } }), fleetNode('w', [1], { guildMap: { 10: 1, 12: 5 } })]).map(v => v.detail);
      expect(guilds.some(d => /guild 10 is mapped to 2 shards/.test(d))).toBe(true);
      expect(guilds.some(d => /guild 12 to shard 5, outside 0 to 1/.test(d))).toBe(true);
      const counts = J.judgeFleet([fleetNode('m', [0]), fleetNode('w', [1], { shardCount: 3 })]).map(v => v.detail);
      expect(counts.some(d => /disagree on the shard count/.test(d))).toBe(true);
    } },
    { name: 'with two sets of control facts, only a CONTROL seen in both counts', run: J => {
      const log = [start(['a']), ...sixAcked(), { t: 'end' }];
      const history = J.buildHistory([log]);
      const copies = [copyOf('db', sixDocs())];
      const handoff = [fleetNode('x', [1]), fleetNode('w', [1])];
      const settled = [fleetNode('x', []), fleetNode('w', [1])];
      const once = J.judge({ history, copies, k: 0, fleet: handoff, fleetAgain: settled });
      expect(once.verdicts).toEqual([]);
      expect(once.notes.join('\n')).toMatch(/shard 1 is leased to 2 nodes/);
      // Either order: a CONTROL only the later set shows does not count either.
      expect(J.judge({ history, copies, k: 0, fleet: settled, fleetAgain: handoff }).verdicts).toEqual([]);
      // Facts, not file order or names: the same double lease listed the other way round, or with a third holder, still counts.
      const controls = (fleet: any[], fleetAgain: any[]) => J.judge({ history, copies, k: 0, fleet, fleetAgain }).verdicts.map(v => v.v);
      expect(controls(handoff, [fleetNode('w', [1]), fleetNode('x', [1])])).toEqual(['CONTROL']);
      expect(controls([...handoff, fleetNode('y', [])], [...handoff, fleetNode('y', [1])])).toEqual(['CONTROL']);
      const tableSet = (tag: string) => [fleetNode('m', [0], { name: `m-${tag}`, table: [[0, 'm'], [1, 'w']] }), fleetNode('x', [1], { name: `x-${tag}` })];
      expect(controls(tableSet('1'), tableSet('2'))).toEqual(['CONTROL']);
      // A node in one set only leaves the comparison unjudged.
      const missing = J.judge({ history, copies, k: 0, fleet: handoff, fleetAgain: [fleetNode('x', [1])] });
      expect(missing.result).toBe('INCONCLUSIVE');
      expect(missing.inconclusive.join('\n')).toMatch(/node w is in the first set/);
      expect(J.judge({ history, copies, k: 0, fleet: [fleetNode('x', [1])], fleetAgain: handoff }).inconclusive.join('\n')).toMatch(/node w is in the second set/);
      // Nodes are matched by id, so per-set file names leave nothing unmatched.
      expect(J.judge({ history, copies, k: 0, fleet: tableSet('1'), fleetAgain: tableSet('2') }).inconclusive).toEqual([]);
      // Each rule counts only what both sets show, in either order: a table conflict, two shard counts, a guild split, an out-of-range map.
      const seenOnce: [any[], any[]][] = [
        [[fleetNode('m', [0], { table: [[1, 'w']] }), fleetNode('x', [1])], [fleetNode('m', [0], { table: [[1, 'x']] }), fleetNode('x', [1])]],
        [[fleetNode('m', [0]), fleetNode('w', [1], { shardCount: 3 })], [fleetNode('m', [0]), fleetNode('w', [1])]],
        [[fleetNode('m', [0], { guildMap: { 10: 0 } }), fleetNode('w', [1], { guildMap: { 10: 1 } })], [fleetNode('m', [0], { guildMap: { 10: 1 } }), fleetNode('w', [1], { guildMap: { 10: 1 } })]],
        [[fleetNode('m', [0, 1], { guildMap: { 10: 5 } })], [fleetNode('m', [0, 1], { guildMap: { 10: 1 } })]],
      ];
      for (const [seen, gone] of seenOnce) {
        expect(controls(seen, gone)).toEqual([]);
        expect(controls(gone, seen)).toEqual([]);
        expect(controls(seen, seen)).toEqual(['CONTROL']);
      }
      // An out-of-range map is one node's state at one instant: a shard count that changed between the sets does not hide it.
      const outOfRange = (count: number) => [fleetNode('m', Array.from({ length: count }, (_, i) => i), { shardCount: count, guildMap: { 10: 5 } })];
      expect(controls(outOfRange(2), outOfRange(4))).toEqual(['CONTROL']);
      expect(J.judge({ history, copies, k: 0, fleet: handoff, fleetAgain: handoff }).verdicts.map(v => v.v)).toEqual(['CONTROL']);
    } },
  ];
}
