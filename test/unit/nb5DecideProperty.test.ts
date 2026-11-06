import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  decideMain, type AnsweredProbe, type NoticeRead, type Probe,
} from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';

// NB5 section 8 test 4: properties of decideMain over arbitrary probe sets.

const STORES = ['s1', 's2'];
const writable = (p: AnsweredProbe) => !p.inRecovery && !p.readOnly;

const answered = (i: number) => fc.record({
  inRecovery: fc.boolean(),
  readOnly: fc.boolean(),
  generation: fc.integer({ min: 0, max: 4 }),
  machine: fc.constantFrom('m1', 'm2', 'm3'),
  since: fc.constantFrom('2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'),
  sysid: fc.constantFrom<string | null>('x', 'y', null),
  started: fc.constantFrom('t1', 't2', 't3'),
  storeId: fc.constantFrom<string | null>('s1', 's2', null),
}).map((r): Probe => ({ kind: 'answered', address: `db${i}:5432/bot`, entry: `e${i}`, ...r }));

const probe = (i: number): fc.Arbitrary<Probe> => fc.oneof(
  { weight: 4, arbitrary: answered(i) },
  { weight: 1, arbitrary: fc.constant<Probe>({ kind: 'refused', address: `db${i}:5432/bot`, entry: `e${i}` }) },
  { weight: 1, arbitrary: fc.constant<Probe>({ kind: 'failed', address: `db${i}:5432/bot`, entry: `e${i}`, cause: 'timeout' }) },
);

const probes = fc.integer({ min: 0, max: 5 }).chain(n => fc.tuple(...Array.from({ length: n }, (_, i) => probe(i))));
const marker = fc.constantFrom<string | null>('s1', 's2', null);
const noticeArb: fc.Arbitrary<NoticeRead> = fc.oneof(
  fc.constant<NoticeRead>({ kind: 'none' }),
  fc.constant<NoticeRead>({ kind: 'failed', cause: 'timeout' }),
  fc.record({ generation: fc.integer({ min: 1, max: 5 }), machine: fc.constantFrom('m1', 'm2', 'm3') })
    .map((n): NoticeRead => ({ kind: 'notice', date: '2026-04-01T00:00:00.000Z', ...n })),
);

function decide(list: Probe[], markerStoreId: string | null, notice: NoticeRead) {
  return decideMain(list, notice, { markerStoreId, noticeCheckOff: false });
}

const ofStore = (p: Probe, m: string | null): p is AnsweredProbe =>
  p.kind === 'answered' && (m === null || p.storeId === null || p.storeId === m);

describe('decideMain properties', () => {
  it('a chosen database is writable, of the store, at the highest generation and alone there', () => {
    fc.assert(fc.property(probes, marker, noticeArb, (list, m, notice) => {
      const d = decide(list, m, notice);
      if (d.outcome !== 'chosen') return;
      const c = d.chosen;
      expect(writable(c)).toBe(true);
      if (m !== null && c.storeId !== null) expect(c.storeId).toBe(m);
      for (const p of list) if (ofStore(p, m)) expect(c.generation).toBeGreaterThanOrEqual(p.generation);
      if (notice.kind === 'notice' && c.generation >= 1) expect(c.generation).toBeGreaterThanOrEqual(notice.generation);
      if (c.generation >= 1) expect(notice.kind).not.toBe('failed');
      for (const p of list) {
        if (!ofStore(p, m) || p === c || !writable(p) || p.generation !== c.generation) continue;
        const same = p.started === c.started && (p.sysid === null || c.sysid === null || p.sysid === c.sysid);
        expect(same).toBe(true);
      }
    }));
  });

  it('adding a database of the store with a higher generation never leaves the same choice', () => {
    fc.assert(fc.property(probes, marker, noticeArb, answered(9), (list, m, notice, extra) => {
      const d = decide(list, m, notice);
      if (d.outcome !== 'chosen') return;
      const higher = { ...(extra as AnsweredProbe), storeId: m, generation: d.generation + 1 };
      const after = decide([...list, higher], m, notice);
      if (after.outcome === 'chosen') expect(after.chosen.address).not.toBe(d.chosen.address);
    }));
  });

  it('removing a database never turns a tie into a choice below the highest generation', () => {
    fc.assert(fc.property(probes, marker, noticeArb, fc.nat(), (list, m, notice, k) => {
      const d = decide(list, m, notice);
      if (d.outcome !== 'tie' || list.length === 0) return;
      const without = list.filter((_, i) => i !== k % list.length);
      const after = decide(without, m, notice);
      if (after.outcome !== 'chosen') return;
      for (const p of without) if (ofStore(p, m)) expect(after.chosen.generation).toBeGreaterThanOrEqual(p.generation);
    }));
  });

  it('an address failed with an unreadable generation or store id never leaves a choice', () => {
    const cause = fc.constantFrom('an unreadable generation (more than one row)', 'an unreadable generation (permission denied)', 'an unreadable store id (permission denied)');
    fc.assert(fc.property(probes, marker, noticeArb, cause, fc.nat(), (list, m, notice, why, at) => {
      const unreadable: Probe = { kind: 'failed', address: 'db9:5432/bot', entry: 'e9', cause: why };
      const withIt = [...list];
      withIt.splice(at % (list.length + 1), 0, unreadable);
      expect(decide(withIt, m, notice).outcome).not.toBe('chosen');
      expect(decideMain(withIt, notice, { markerStoreId: m, noticeCheckOff: true }).outcome).not.toBe('chosen');
    }));
  });
});
