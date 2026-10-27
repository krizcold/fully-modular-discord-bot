import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import {
  LOST_MARKS_PER_SCOPE,
  noteScopeRefusal,
  noteScopeTicket,
  pendingFor,
  saveMark,
  stampOf,
  setLeft,
  firstSeqOf,
} from '../../src/bot/internalSetup/utils/dataBackends/scopeRecord';
import type { LedgerTicket } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';

// BT-5, the scope record (notes/BT.md, "BT-5 design sheet: final", decision 1 and "Tests first", scopeRecord (pure)).
// Driven with hand-made tickets, so no store is needed: every write noted under a scope is answered for by its key's
// latest ticket until it lands, and a set that leaves before landing leaves a lost mark that pendingFor reports.

type LandingRecord = { landed: number };
type WorkingSet = { landedSeq: number; state?: string };

let guilds = 9800;
const freshGuild = () => String(++guilds);

const record = (): LandingRecord => ({ landed: 0 });
const workingSet = (): WorkingSet => ({ landedSeq: 0 });
/** A carry a later manager keeps: the fate a lost mark answers pending by. */
const KEPT = { outcome: () => 'kept' as const };

const fileTicket = (rec: LandingRecord, seq: number, guildId = '0', name = 'a.json') =>
  ({ kind: 'file', path: `/data/${guildId}/m/${name}`, seq, record: rec }) as unknown as LedgerTicket;
const wsTicket = (set: WorkingSet, guildId: string, seq: number) =>
  ({ kind: 'ws', manager: {}, set, guildId, seq }) as unknown as LedgerTicket;

/** Notes the ticket and returns its stamp: the counter is raised first, so the stamp is the mark right after. */
function note(scope: string, ticket: LedgerTicket): number {
  noteScopeTicket(scope, ticket);
  return saveMark().stamp;
}

/** A scope with one set noted and left unlanded, n times over; returns the lost marks' stamps in order. */
function loseSets(scope: string, n: number, carried = false): number[] {
  const stamps: number[] = [];
  for (let i = 0; i < n; i++) {
    const set = workingSet();
    stamps.push(note(scope, wsTicket(set, scope, 1)));
    setLeft(set, carried ? () => KEPT : undefined);
  }
  return stamps;
}

describe('the counter and its stamps', () => {
  it('starts at 0, and each noted write raises it by one, so a write noted after a mark is stamped above it', () => {
    expect(saveMark().stamp).toBe(0);
    const guildId = freshGuild();
    const first = fileTicket(record(), 1, guildId);
    noteScopeTicket(guildId, first);
    expect(saveMark().stamp).toBe(1);
    noteScopeTicket('global', fileTicket(record(), 1, 'global'));
    expect(saveMark().stamp).toBe(2);
    expect(pendingFor(guildId, 0).tickets).toEqual([first]);
    expect(pendingFor(guildId, 1).tickets).toEqual([]);
  });

  it('keeps 32 lost marks per scope', () => {
    expect(LOST_MARKS_PER_SCOPE).toBe(32);
  });

  it('answers nothing, unpruned, for a scope never noted', () => {
    expect(pendingFor(freshGuild(), 0)).toEqual({ tickets: [], lost: [], refused: [], pruned: false });
    expect(pendingFor(freshGuild(), saveMark().stamp)).toEqual({ tickets: [], lost: [], refused: [], pruned: false });
  });

  it('reading the record raises no stamp: only a noted write does', () => {
    const guildId = freshGuild();
    const set = workingSet();
    note(guildId, wsTicket(set, guildId, 1));
    const mark = saveMark().stamp;
    pendingFor(guildId, 0);
    setLeft(set);
    setLeft(workingSet(), () => KEPT);
    expect(saveMark().stamp).toBe(mark);
  });
});

describe('noting a write', () => {
  it('lists an unlanded file write for a mark taken before it, and not for one taken after it', () => {
    const guildId = freshGuild();
    const before = saveMark().stamp;
    const ticket = fileTicket(record(), 1, guildId);
    const stamp = note(guildId, ticket);
    expect(stamp).toBe(before + 1);
    expect(pendingFor(guildId, before).tickets).toEqual([ticket]);
    expect(pendingFor(guildId, stamp).tickets).toEqual([]);
  });

  it('lists an unlanded working-set write for a mark taken before it, and not for one taken after it', () => {
    const guildId = freshGuild();
    const before = saveMark().stamp;
    const ticket = wsTicket(workingSet(), guildId, 1);
    const stamp = note(guildId, ticket);
    expect(pendingFor(guildId, before).tickets).toEqual([ticket]);
    expect(pendingFor(guildId, stamp).tickets).toEqual([]);
  });

  it('a later ticket on the same landing record replaces the earlier one and takes the new stamp', () => {
    const guildId = freshGuild();
    const rec = record();
    const first = fileTicket(rec, 1, guildId);
    const second = fileTicket(rec, 2, guildId);
    note(guildId, first);
    const mark = saveMark().stamp;
    const stamp = note(guildId, second);
    expect(pendingFor(guildId, 0).tickets).toEqual([second]);
    expect(pendingFor(guildId, mark).tickets).toEqual([second]);
    expect(pendingFor(guildId, stamp).tickets).toEqual([]);
  });

  it('a later ticket on the same working set replaces the earlier one, and another set of the guild is its own entry', () => {
    const guildId = freshGuild();
    const set = workingSet();
    const other = workingSet();
    note(guildId, wsTicket(set, guildId, 1));
    const latest = wsTicket(set, guildId, 2);
    note(guildId, latest);
    const elsewhere = wsTicket(other, guildId, 1);
    note(guildId, elsewhere);
    const listed = pendingFor(guildId, 0).tickets;
    expect(listed).toHaveLength(2);
    expect(listed).toContain(latest);
    expect(listed).toContain(elsewhere);
  });

  it('a ticket with a lower seq on the same key does not replace the higher one', () => {
    const guildId = freshGuild();
    const rec = record();
    const high = fileTicket(rec, 7, guildId);
    note(guildId, high);
    note(guildId, fileTicket(rec, 5, guildId));
    expect(pendingFor(guildId, 0).tickets).toEqual([high]);
    const set = workingSet();
    const highWs = wsTicket(set, guildId, 4);
    note(guildId, highWs);
    note(guildId, wsTicket(set, guildId, 3));
    expect(pendingFor(guildId, 0).tickets).toHaveLength(2);
    expect(pendingFor(guildId, 0).tickets).toContain(highWs);
  });

  it('a ticket noted again after a mark at the same seq (an absent delete carrying the earlier delete) is listed for that mark', () => {
    const guildId = freshGuild();
    const rec = record();
    const deleted = fileTicket(rec, 3, guildId);
    note(guildId, deleted);
    const mark = saveMark().stamp;
    note(guildId, fileTicket(rec, 3, guildId));
    const listed = pendingFor(guildId, mark).tickets;
    expect(listed).toHaveLength(1);
    expect(listed[0].seq).toBe(3);
    const set = workingSet();
    note(guildId, wsTicket(set, guildId, 5));
    const wsMark = saveMark().stamp;
    note(guildId, wsTicket(set, guildId, 5));
    expect(pendingFor(guildId, wsMark).tickets.filter(ticket => ticket.kind === 'ws').map(ticket => ticket.seq)).toEqual([5]);
  });

  it('a lower-seq ticket noted after a mark keeps the higher ticket, and that ticket is listed for the mark', () => {
    const guildId = freshGuild();
    const rec = record();
    const high = fileTicket(rec, 7, guildId);
    note(guildId, high);
    const mark = saveMark().stamp;
    note(guildId, fileTicket(rec, 5, guildId));
    expect(pendingFor(guildId, mark).tickets).toEqual([high]);
  });

  it('a lower-seq ticket noted after a mark, already landed, leaves the higher ticket unlisted for that mark (gates_r9)', () => {
    const guildId = freshGuild();
    const rec = record();
    const high = fileTicket(rec, 7, guildId);
    note(guildId, high);
    const mark = saveMark().stamp;
    rec.landed = 5;
    note(guildId, fileTicket(rec, 5, guildId));
    expect(pendingFor(guildId, mark).tickets).toEqual([]);
    expect(pendingFor(guildId, mark - 1).tickets).toEqual([high]);
  });
});

describe('an entry leaves once its write landed', () => {
  it('a landed write is not listed, at any mark', () => {
    const guildId = freshGuild();
    const rec = record();
    const set = workingSet();
    const before = saveMark().stamp;
    note(guildId, fileTicket(rec, 2, guildId));
    note(guildId, wsTicket(set, guildId, 3));
    expect(pendingFor(guildId, before).tickets).toHaveLength(2);
    rec.landed = 2;
    set.landedSeq = 3;
    expect(pendingFor(guildId, before).tickets).toEqual([]);
    expect(pendingFor(guildId, 0).tickets).toEqual([]);
  });

  it('a write landed only up to an earlier seq stays listed', () => {
    const guildId = freshGuild();
    const rec = record();
    const ticket = fileTicket(rec, 4, guildId);
    note(guildId, ticket);
    rec.landed = 3;
    expect(pendingFor(guildId, 0).tickets).toEqual([ticket]);
  });

  it('a ticket that had already landed when noted is never listed', () => {
    const guildId = freshGuild();
    const rec = { landed: 6 };
    note(guildId, fileTicket(rec, 6, guildId));
    expect(pendingFor(guildId, 0).tickets).toEqual([]);
  });

  it('a landed entry leaves at the next pendingFor of its scope', () => {
    const guildId = freshGuild();
    const rec = record();
    note(guildId, fileTicket(rec, 1, guildId));
    rec.landed = 1;
    expect(pendingFor(guildId, 0).tickets).toEqual([]);
    rec.landed = 0;
    expect(pendingFor(guildId, 0).tickets).toEqual([]);
  });

  it('a landed entry leaves when another write of its scope is noted', () => {
    const guildId = freshGuild();
    const set = workingSet();
    note(guildId, wsTicket(set, guildId, 1));
    set.landedSeq = 1;
    const later = fileTicket(record(), 1, guildId);
    note(guildId, later);
    set.landedSeq = 0;
    expect(pendingFor(guildId, 0).tickets).toEqual([later]);
    setLeft(set);
    expect(pendingFor(guildId, 0).lost).toEqual([]);
  });
});

describe('a set that leaves (setLeft)', () => {
  it('turns an unlanded entry into a lost mark with its stamp, not carried, for an evict', () => {
    const guildId = freshGuild();
    const set = workingSet();
    const stamp = note(guildId, wsTicket(set, guildId, 1));
    setLeft(set);
    expect(pendingFor(guildId, 0)).toEqual({ tickets: [], lost: [{ stamp, carry: null, deposed: false }], refused: [], pruned: false });
    expect(pendingFor(guildId, stamp - 1).lost).toEqual([{ stamp, carry: null, deposed: false }]);
    expect(pendingFor(guildId, stamp).lost).toEqual([]);
  });

  it('turns an unlanded entry into a carried lost mark for a quiesced manager', () => {
    const guildId = freshGuild();
    const set = workingSet();
    const stamp = note(guildId, wsTicket(set, guildId, 1));
    setLeft(set, () => KEPT);
    expect(pendingFor(guildId, 0)).toEqual({ tickets: [], lost: [{ stamp, carry: KEPT, deposed: false }], refused: [], pruned: false });
  });

  it('marks the lost writes of a fenced set as deposed', () => {
    const guildId = freshGuild();
    const set: WorkingSet = { landedSeq: 0, state: 'fenced' };
    const stamp = note(guildId, wsTicket(set, guildId, 1));
    setLeft(set);
    expect(pendingFor(guildId, 0).lost).toEqual([{ stamp, carry: null, deposed: true }]);
  });

  it('gives the lost mark the stamp of the latest write on the set', () => {
    const guildId = freshGuild();
    const set = workingSet();
    note(guildId, wsTicket(set, guildId, 1));
    const latest = note(guildId, wsTicket(set, guildId, 2));
    setLeft(set);
    expect(pendingFor(guildId, 0).lost).toEqual([{ stamp: latest, carry: null, deposed: false }]);
  });

  it('drops a landed entry and leaves no mark', () => {
    const guildId = freshGuild();
    const set = workingSet();
    note(guildId, wsTicket(set, guildId, 2));
    set.landedSeq = 2;
    setLeft(set);
    expect(pendingFor(guildId, 0)).toEqual({ tickets: [], lost: [], refused: [], pruned: false });
    const quiesced = workingSet();
    note(guildId, wsTicket(quiesced, guildId, 1));
    quiesced.landedSeq = 1;
    setLeft(quiesced, () => KEPT);
    expect(pendingFor(guildId, 0)).toEqual({ tickets: [], lost: [], refused: [], pruned: false });
  });

  it('does nothing for a set the record never saw', () => {
    const guildId = freshGuild();
    const ticket = wsTicket(workingSet(), guildId, 1);
    note(guildId, ticket);
    const before = pendingFor(guildId, 0);
    expect(() => setLeft(workingSet())).not.toThrow();
    expect(() => setLeft({}, () => KEPT)).not.toThrow();
    expect(pendingFor(guildId, 0)).toEqual(before);
    expect(before.tickets).toEqual([ticket]);
  });

  it('asks the carry for every write of its entry, from the first to the latest (delta round 4)', () => {
    const guildId = freshGuild();
    const set = workingSet();
    const first = wsTicket(set, guildId, 3);
    note(guildId, first);
    const latest = wsTicket(set, guildId, 5);
    const stamp = note(guildId, latest);
    expect(firstSeqOf(guildId, latest)).toBe(3);
    expect(firstSeqOf(guildId, first)).toBe(3);
    expect(firstSeqOf(freshGuild(), latest)).toBe(5);
    const asked: Array<[number, number]> = [];
    setLeft(set, (from, to) => { asked.push([from, to]); return KEPT; });
    expect(asked).toEqual([[3, 5]]);
    expect(pendingFor(guildId, 0).lost).toEqual([{ stamp, carry: KEPT, deposed: false }]);
  });

  it('notes no landed ticket: it neither lowers an entry\'s first seq nor stamps it again (delta round 6)', () => {
    const guildId = freshGuild();
    const set = workingSet();
    set.landedSeq = 3;
    const unlanded = wsTicket(set, guildId, 5);
    const stamp = note(guildId, unlanded);
    note(guildId, wsTicket(set, guildId, 2));
    expect(firstSeqOf(guildId, unlanded)).toBe(5);
    expect(pendingFor(guildId, stamp).tickets).toEqual([]);
  });

  it('asks the carry from the lowest seq noted: an absent delete takes its tombstone\'s own (delta round 5)', () => {
    const guildId = freshGuild();
    const set = workingSet();
    const latest = wsTicket(set, guildId, 5);
    note(guildId, latest);
    const absent = wsTicket(set, guildId, 2);
    const stamp = note(guildId, absent);
    expect(firstSeqOf(guildId, absent)).toBe(2);
    expect(pendingFor(guildId, 0).tickets).toEqual([latest]);
    const asked: Array<[number, number]> = [];
    setLeft(set, (from, to) => { asked.push([from, to]); return KEPT; });
    expect(asked).toEqual([[2, 5]]);
    expect(pendingFor(guildId, 0).lost).toEqual([{ stamp, carry: KEPT, deposed: false }]);
  });

  it('leaves one mark when the same set is reported twice', () => {
    const guildId = freshGuild();
    const set = workingSet();
    const stamp = note(guildId, wsTicket(set, guildId, 1));
    setLeft(set, () => KEPT);
    setLeft(set);
    expect(pendingFor(guildId, 0).lost).toEqual([{ stamp, carry: KEPT, deposed: false }]);
  });

  it('keeps reporting a lost mark: reading it does not consume it', () => {
    const guildId = freshGuild();
    const set = workingSet();
    const stamp = note(guildId, wsTicket(set, guildId, 1));
    setLeft(set);
    expect(pendingFor(guildId, 0).lost).toEqual([{ stamp, carry: null, deposed: false }]);
    note(guildId, fileTicket(record(), 1, guildId));
    expect(pendingFor(guildId, 0).lost).toEqual([{ stamp, carry: null, deposed: false }]);
  });

  it('a new set of the guild noted after the old one left is its own entry beside the lost mark', () => {
    const guildId = freshGuild();
    const old = workingSet();
    const stamp = note(guildId, wsTicket(old, guildId, 4));
    setLeft(old);
    const fresh = wsTicket(workingSet(), guildId, 1);
    note(guildId, fresh);
    expect(pendingFor(guildId, 0)).toEqual({ tickets: [fresh], lost: [{ stamp, carry: null, deposed: false }], refused: [], pruned: false });
    expect(pendingFor(guildId, stamp)).toEqual({ tickets: [fresh], lost: [], refused: [], pruned: false });
  });
});

describe('the bound on lost marks', () => {
  it('keeps 32 lost marks unpruned', () => {
    const guildId = freshGuild();
    const stamps = loseSets(guildId, 32);
    const answer = pendingFor(guildId, 0);
    expect(answer.pruned).toBe(false);
    expect(answer.lost.map(mark => mark.stamp).sort((a, b) => a - b)).toEqual(stamps);
  });

  it('the 33rd lost mark drops the oldest and raises prunedThrough to its stamp', () => {
    const guildId = freshGuild();
    const stamps = loseSets(guildId, 33);
    expect(pendingFor(guildId, 0).pruned).toBe(true);
    expect(pendingFor(guildId, stamps[0] - 1).pruned).toBe(true);
    const atPruned = pendingFor(guildId, stamps[0]);
    expect(atPruned.pruned).toBe(false);
    expect(atPruned.lost.map(mark => mark.stamp).sort((a, b) => a - b)).toEqual(stamps.slice(1));
    expect(pendingFor(guildId, stamps[32]).pruned).toBe(false);
  });

  it('each further lost mark raises prunedThrough to the next oldest stamp', () => {
    const guildId = freshGuild();
    const stamps = loseSets(guildId, 34);
    expect(pendingFor(guildId, stamps[1] - 1).pruned).toBe(true);
    const atPruned = pendingFor(guildId, stamps[1]);
    expect(atPruned.pruned).toBe(false);
    expect(atPruned.lost.map(mark => mark.stamp).sort((a, b) => a - b)).toEqual(stamps.slice(2));
  });

  it('a since below prunedThrough reports pruned while still listing the unlanded entries', () => {
    const guildId = freshGuild();
    const stamps = loseSets(guildId, 33);
    const ticket = fileTicket(record(), 1, guildId);
    note(guildId, ticket);
    const answer = pendingFor(guildId, stamps[0] - 1);
    expect(answer.pruned).toBe(true);
    expect(answer.tickets).toEqual([ticket]);
  });

  it('pruning one scope leaves another unpruned', () => {
    const pruned = freshGuild();
    const other = freshGuild();
    const ticket = wsTicket(workingSet(), other, 1);
    note(other, ticket);
    loseSets(pruned, 33);
    expect(pendingFor(pruned, 0).pruned).toBe(true);
    expect(pendingFor(other, 0)).toEqual({ tickets: [ticket], lost: [], refused: [], pruned: false });
  });

  it('drops the lowest stamp, not the first mark made, when sets leave out of stamp order', () => {
    const guildId = freshGuild();
    const early = workingSet();
    const earlyStamp = note(guildId, wsTicket(early, guildId, 1));
    const later = loseSets(guildId, 32);
    setLeft(early);
    expect(pendingFor(guildId, earlyStamp - 1).pruned).toBe(true);
    const atEarly = pendingFor(guildId, earlyStamp);
    expect(atEarly.pruned).toBe(false);
    expect(atEarly.lost.map(mark => mark.stamp).sort((a, b) => a - b)).toEqual(later);
  });

  it('never lowers prunedThrough when a later prune drops a lower stamp', () => {
    const guildId = freshGuild();
    const early = workingSet();
    const earlyStamp = note(guildId, wsTicket(early, guildId, 1));
    const lost = loseSets(guildId, 33);
    expect(pendingFor(guildId, lost[0]).pruned).toBe(false);
    setLeft(early);
    expect(earlyStamp).toBeLessThan(lost[0]);
    expect(pendingFor(guildId, lost[0] - 1).pruned).toBe(true);
  });
});

describe('scopes are kept apart', () => {
  it('entries and lost marks of one scope are never listed for another, global included', () => {
    const since = saveMark().stamp;
    const a = freshGuild();
    const b = freshGuild();
    const inA = fileTicket(record(), 1, a);
    const inGlobal = fileTicket(record(), 1, 'global', 'g.json');
    note(a, inA);
    note('global', inGlobal);
    const set = workingSet();
    const lostStamp = note(b, wsTicket(set, b, 1));
    setLeft(set, () => KEPT);
    expect(pendingFor(a, since)).toEqual({ tickets: [inA], lost: [], refused: [], pruned: false });
    expect(pendingFor('global', since)).toEqual({ tickets: [inGlobal], lost: [], refused: [], pruned: false });
    expect(pendingFor(b, since)).toEqual({ tickets: [], lost: [{ stamp: lostStamp, carry: KEPT, deposed: false }], refused: [], pruned: false });
  });

  it('a set that leaves turns only its own scope\'s entry into a lost mark', () => {
    const a = freshGuild();
    const b = freshGuild();
    const set = workingSet();
    const stamp = note(a, wsTicket(set, a, 1));
    const inB = wsTicket(workingSet(), b, 1);
    note(b, inB);
    setLeft(set);
    expect(pendingFor(a, 0).lost).toEqual([{ stamp, carry: null, deposed: false }]);
    expect(pendingFor(b, 0)).toEqual({ tickets: [inB], lost: [], refused: [], pruned: false });
  });
});

type Op =
  | { t: 'note'; scope: number; slot: number; step: number }
  | { t: 'land'; scope: number; slot: number; behind: number }
  | { t: 'leave'; scope: number; slot: number; carried: boolean }
  | { t: 'mark' }
  | { t: 'check'; scope: number; mark: number };

const scopeIx = fc.integer({ min: 0, max: 1 });
const slotIx = fc.integer({ min: 0, max: 3 });
const op: fc.Arbitrary<Op> = fc.oneof(
  { arbitrary: fc.record({ t: fc.constant('note' as const), scope: scopeIx, slot: slotIx, step: fc.integer({ min: -1, max: 2 }) }), weight: 4 },
  { arbitrary: fc.record({ t: fc.constant('land' as const), scope: scopeIx, slot: slotIx, behind: fc.integer({ min: 0, max: 1 }) }), weight: 2 },
  { arbitrary: fc.record({ t: fc.constant('leave' as const), scope: scopeIx, slot: slotIx, carried: fc.boolean() }), weight: 2 },
  { arbitrary: fc.record({ t: fc.constant('mark' as const) }), weight: 1 },
  { arbitrary: fc.record({ t: fc.constant('check' as const), scope: scopeIx, mark: fc.nat() }), weight: 2 },
);

interface Slot {
  key: LandingRecord | WorkingSet;
  ws: boolean;
  top: number;
}

describe('the scope record, over random runs', () => {
  it('lists every unlanded entry and every lost mark stamped after since, and nothing stamped at or before it', () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 30 }), ops => {
        const scopes = [freshGuild(), freshGuild()];
        const slots: Slot[][] = scopes.map(() => [0, 1, 2, 3].map(i => ({ key: i < 2 ? record() : workingSet(), ws: i >= 2, top: 0 })));
        const entries = scopes.map(() => new Map<object, { ticket: LedgerTicket; stamp: number }>());
        const lost: Array<Array<{ stamp: number; carry: typeof KEPT | null; deposed: boolean }>> = scopes.map(() => []);
        const marks = [0, saveMark().stamp];
        const ids = new Map<LedgerTicket, number>();
        const isLanded = (ticket: LedgerTicket) =>
          ticket.kind === 'file' ? ticket.record.landed >= ticket.seq : ticket.set.landedSeq >= ticket.seq;

        const check = (s: number, since: number) => {
          const answer = pendingFor(scopes[s], since);
          const expected = [...entries[s].values()].filter(e => e.stamp > since && !isLanded(e.ticket)).map(e => ids.get(e.ticket)!);
          expect(answer.tickets.map(ticket => ids.get(ticket)).sort()).toEqual(expected.sort());
          const lostAfter = lost[s].filter(mark => mark.stamp > since).sort((a, b) => a.stamp - b.stamp);
          expect([...answer.lost].sort((a, b) => a.stamp - b.stamp)).toEqual(lostAfter);
          expect(answer.pruned).toBe(false);
        };

        for (const step of ops) {
          if (step.t === 'mark') {
            marks.push(saveMark().stamp);
          } else if (step.t === 'check') {
            check(step.scope, marks[step.mark % marks.length]);
          } else if (step.t === 'note') {
            const slot = slots[step.scope][step.slot];
            const seq = Math.max(1, slot.top + step.step);
            slot.top = Math.max(slot.top, seq);
            const ticket = slot.ws
              ? wsTicket(slot.key as WorkingSet, scopes[step.scope], seq)
              : fileTicket(slot.key as LandingRecord, seq, scopes[step.scope], `f${step.slot}.json`);
            ids.set(ticket, ids.size);
            const stamp = note(scopes[step.scope], ticket);
            // A write landed when noted owes nothing and changes no entry.
            if (isLanded(ticket)) continue;
            const entry = entries[step.scope].get(slot.key);
            entries[step.scope].set(slot.key, { ticket: entry && entry.ticket.seq >= seq ? entry.ticket : ticket, stamp });
          } else if (step.t === 'land') {
            const slot = slots[step.scope][step.slot];
            const upTo = slot.top - step.behind;
            if (slot.ws) (slot.key as WorkingSet).landedSeq = Math.max((slot.key as WorkingSet).landedSeq, upTo);
            else (slot.key as LandingRecord).landed = Math.max((slot.key as LandingRecord).landed, upTo);
          } else {
            const slot = slots[step.scope][2 + (step.slot % 2)];
            const entry = entries[step.scope].get(slot.key);
            setLeft(slot.key, step.carried ? () => KEPT : undefined);
            if (entry) {
              if (!isLanded(entry.ticket)) lost[step.scope].push({ stamp: entry.stamp, carry: step.carried ? KEPT : null, deposed: false });
              entries[step.scope].delete(slot.key);
            }
            slot.key = workingSet();
            slot.top = 0;
          }
        }
        for (const since of marks) for (const s of [0, 1]) check(s, since);
      }),
      { numRuns: 300 },
    );
  });
});

describe('refusals (review round 1, D1)', () => {
  it('lists a refusal stamped after since, marks it rewritten by a later whole write of its document, and keeps scopes apart', () => {
    const guildId = freshGuild();
    const before = saveMark().stamp;
    noteScopeRefusal(guildId, 'doc-a');
    const stamp = saveMark().stamp;
    expect(pendingFor(guildId, before).refused).toEqual([{ stamp, doc: 'doc-a', rewritten: false }]);
    expect(pendingFor(guildId, stamp).refused).toEqual([]);
    expect(pendingFor(freshGuild(), before).refused).toEqual([]);
    note(guildId, fileTicket(record(), 1, guildId, 'other.json'));
    expect(pendingFor(guildId, before).refused[0].rewritten).toBe(false);
    noteScopeTicket(guildId, fileTicket(record(), 1, guildId), 'doc-a');
    expect(pendingFor(guildId, before).refused[0].rewritten).toBe(true);
  });

  it('the 33rd refused document drops the lowest stamp and raises prunedThrough, never lowering it', () => {
    const guildId = freshGuild();
    const stamps: number[] = [];
    for (let i = 0; i < LOST_MARKS_PER_SCOPE + 1; i++) {
      noteScopeRefusal(guildId, `doc-${i}`);
      stamps.push(saveMark().stamp);
    }
    expect(pendingFor(guildId, stamps[0] - 1).pruned).toBe(true);
    expect(pendingFor(guildId, stamps[0]).pruned).toBe(false);
    expect(pendingFor(guildId, stamps[0]).refused).toHaveLength(LOST_MARKS_PER_SCOPE);
    const lost = loseSets(guildId, LOST_MARKS_PER_SCOPE + 1);
    expect(lost[0]).toBeGreaterThan(stamps[0]);
    expect(pendingFor(guildId, stamps[0]).pruned).toBe(true);
  });

  it('a refusal pruned after a higher lost-mark prune leaves prunedThrough where it was', () => {
    const guildId = freshGuild();
    const refusals: number[] = [];
    for (let i = 0; i < LOST_MARKS_PER_SCOPE; i++) {
      noteScopeRefusal(guildId, `doc-${i}`);
      refusals.push(saveMark().stamp);
    }
    const lost = loseSets(guildId, LOST_MARKS_PER_SCOPE + 1);
    expect(pendingFor(guildId, lost[0] - 1).pruned).toBe(true);
    noteScopeRefusal(guildId, 'doc-last');
    expect(refusals[0]).toBeLessThan(lost[0]);
    expect(pendingFor(guildId, lost[0] - 1).pruned).toBe(true);
  });
});

describe('marks (delta round 1)', () => {
  it('reads a mark back to its stamp, also after a JSON round trip', () => {
    const mark = saveMark();
    expect(stampOf(mark)).toBe(mark.stamp);
    expect(stampOf(JSON.parse(JSON.stringify(mark)))).toBe(mark.stamp);
    expect(stampOf({ ...mark, stamp: 0 })).toBe(0);
  });

  it('refuses a mark from another run, a number, a stamp out of range, and anything that is not a mark', () => {
    const mark = saveMark();
    for (const since of [
      { ...mark, run: 'an earlier run' }, mark.stamp, 0, Date.now(), { stamp: mark.stamp }, { run: mark.run },
      { ...mark, stamp: mark.stamp + 1 }, { ...mark, stamp: -1 }, { ...mark, stamp: 0.5 }, { ...mark, stamp: Number.NaN },
      { ...mark, stamp: String(mark.stamp) }, null, undefined, 'mark',
    ]) {
      expect(stampOf(since), JSON.stringify(since) ?? String(since)).toBeNull();
    }
  });

  it('gives each load of the record its own run, so a mark kept from before a restart is refused', async () => {
    const mark = saveMark();
    vi.resetModules();
    const again = await import('../../src/bot/internalSetup/utils/dataBackends/scopeRecord');
    expect(again.saveMark().run).not.toBe(mark.run);
    expect(again.stampOf(mark)).toBeNull();
    expect(again.stampOf(again.saveMark())).toBe(0);
  });
});
