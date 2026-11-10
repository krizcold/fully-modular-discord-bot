import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decideMain, type NoticeRead, type Probe } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';

// NB24 section 8 test 3: for any probes whose top generation is 1 or above and any notice naming two or more
// machines, decideMain never answers 'chosen' (the seed model of nb5DecideProperty.test.ts).

const MACHINES = ['m1', 'm2', 'm3'];

const answered = (i: number) => fc.record({
  inRecovery: fc.boolean(),
  readOnly: fc.boolean(),
  generation: fc.integer({ min: 0, max: 4 }),
  machine: fc.constantFrom('m1', 'm2', 'm3'),
  since: fc.constantFrom('2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'),
  sysid: fc.constantFrom<string | null>('x', 'y', null),
  started: fc.constantFrom('t1', 't2', 't3'),
  storeId: fc.constantFrom<string | null>('s1', 's2', null),
}).map((r): Probe => ({ kind: 'answered', address: `db${i}:5432/bot`, entry: `e${i}`, ...r }));

const probe = (i: number): fc.Arbitrary<Probe> => fc.oneof(
  { weight: 4, arbitrary: answered(i) },
  { weight: 1, arbitrary: fc.constant<Probe>({ kind: 'refused', address: `db${i}:5432/bot`, entry: `e${i}` }) },
  { weight: 1, arbitrary: fc.constant<Probe>({ kind: 'failed', address: `db${i}:5432/bot`, entry: `e${i}`, cause: 'timeout' }) },
);

const probes = fc.integer({ min: 1, max: 5 }).chain(n => fc.tuple(...Array.from({ length: n }, (_, i) => probe(i))));
const marker = fc.constantFrom<string | null>('s1', 's2', null);
const tieNotice: fc.Arbitrary<NoticeRead> = fc.record({
  generation: fc.integer({ min: 1, max: 5 }),
  machines: fc.subarray(MACHINES, { minLength: 2 }),
  first: fc.nat(),
}).map(({ generation, machines, first }): NoticeRead => ({
  kind: 'notice', generation, machine: machines[first % machines.length], date: '2026-04-01T00:00:00.000Z', machines,
}));

/** The top generation among the answers decideMain keeps (those of the marker's store, or of no recorded store). */
const topOf = (list: Probe[], m: string | null) =>
  Math.max(-1, ...list.map(p => (p.kind === 'answered' && (m === null || p.storeId === null || p.storeId === m) ? p.generation : -1)));

describe('NB24 test 3: decideMain property', () => {
  it('never chooses at a top generation of 1 or above while the notice names two or more machines', () => {
    fc.assert(fc.property(probes, marker, tieNotice, fc.boolean(), (list, m, notice, off) => {
      fc.pre(topOf(list, m) >= 1);
      const d = decideMain(list, notice, { markerStoreId: m, noticeCheckOff: off });
      expect(d.outcome).not.toBe('chosen');
    }), { numRuns: 2_000 });
  });
});
