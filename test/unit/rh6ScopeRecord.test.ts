import { describe, expect, it } from 'vitest';

import {
  LOST_MARKS_PER_SCOPE,
  noteScopeRefusal,
  noteScopeTicket,
  pendingFor,
  saveMark,
  setLeft,
} from '../../src/bot/internalSetup/utils/dataBackends/scopeRecord';

type Ticket = Parameters<typeof noteScopeTicket>[1];
type LandingRec = { landed: number; failed?: Array<{ from: number; through: number; errno: string | null; cut: boolean; what: 'lines' | 'whole' }> };
type Op = { state: string };
type WsSet = { landedSeq: number; state: string; unknownThrough?: number };

let guilds = 61000;
const freshGuild = () => String(++guilds);

const fileTicket = (record: LandingRec, seq: number, path: string) => ({ kind: 'file', path, seq, record }) as unknown as Ticket;
const rowTicket = (op: Op, key: string, seq = 1) => ({ kind: 'row', key, op, seq }) as unknown as Ticket;
const wsTicket = (set: WsSet, guildId: string, seq: number) => ({ kind: 'ws', manager: {}, set, guildId, seq }) as unknown as Ticket;

function note(scope: string, ticket: Ticket, rewrites?: string): number {
  noteScopeTicket(scope, ticket, rewrites);
  return saveMark().stamp;
}

const failAt = (record: LandingRec, seq: number) => {
  record.failed = [{ from: seq, through: seq, errno: 'EIO', cut: false, what: 'whole' }];
};

describe('rh6: a write already landed when noted owes nothing', () => {
  it('keeps no entry for a file write landed when noted, so a later failed range on its record is not reported', () => {
    const g = freshGuild();
    const before = saveMark().stamp;
    const record: LandingRec = { landed: 1 };
    note(g, fileTicket(record, 1, `/data/${g}/m/landed.json`));
    failAt(record, 1);
    expect(pendingFor(g, before)).toEqual({ tickets: [], lost: [], refused: [], pruned: false });
  });

  it('owes nothing for a row write whose op is already in the mirror', () => {
    const g = freshGuild();
    const before = saveMark().stamp;
    note(g, rowTicket({ state: 'mirror' }, 'doc-m'));
    expect(pendingFor(g, before)).toEqual({ tickets: [], lost: [], refused: [], pruned: false });
  });

  it('owes nothing for a row write whose op already landed', () => {
    const g = freshGuild();
    const before = saveMark().stamp;
    note(g, rowTicket({ state: 'landed' }, 'doc-l'));
    expect(pendingFor(g, before)).toEqual({ tickets: [], lost: [], refused: [], pruned: false });
  });

  it('answers through a row write that is still queued, then nothing once it reaches the mirror', () => {
    const g = freshGuild();
    const before = saveMark().stamp;
    const op: Op = { state: 'queued' };
    const ticket = rowTicket(op, 'doc-q');
    note(g, ticket);
    expect(pendingFor(g, before).tickets).toEqual([ticket]);
    op.state = 'mirror';
    expect(pendingFor(g, before).tickets).toEqual([]);
  });
});

describe('rh6: a settled row op leaves the entries', () => {
  it('turns a refused op into one refusal of the document it rewrites, and owes no ticket for it', () => {
    const g = freshGuild();
    const before = saveMark().stamp;
    const op: Op = { state: 'queued' };
    const stamp = note(g, rowTicket(op, 'key-r'), 'doc-r');
    op.state = 'refused';
    const first = pendingFor(g, before);
    expect(first).toEqual({ tickets: [], lost: [], refused: [{ stamp, doc: 'doc-r', rewritten: false }], pruned: false });
    expect(pendingFor(g, before)).toEqual(first);
  });

  it('keeps the refusal of an op noted without a rewritten document under its key', () => {
    const g = freshGuild();
    const before = saveMark().stamp;
    const op: Op = { state: 'queued' };
    const stamp = note(g, rowTicket(op, 'key-only'));
    op.state = 'refused';
    expect(pendingFor(g, before).refused).toEqual([{ stamp, doc: 'key-only', rewritten: false }]);
  });

  it('turns an unconfirmed op into exactly one lost mark, not deposed, and owes no ticket for it', () => {
    const g = freshGuild();
    const before = saveMark().stamp;
    const op: Op = { state: 'store' };
    const stamp = note(g, rowTicket(op, 'key-u'), 'doc-u');
    op.state = 'unconfirmed';
    expect(pendingFor(g, before)).toEqual({ tickets: [], lost: [{ stamp, deposed: false }], refused: [], pruned: false });
    expect(pendingFor(g, before)).toEqual({ tickets: [], lost: [{ stamp, deposed: false }], refused: [], pruned: false });
  });
});

describe('rh6: file tickets found unconfirmed', () => {
  it('reports the path as failed and owes no open ticket for a file write found unconfirmed', () => {
    const g = freshGuild();
    const before = saveMark().stamp;
    const path = `/data/${g}/m/a.json`;
    const record: LandingRec = { landed: 0 };
    const stamp = note(g, fileTicket(record, 1, path));
    failAt(record, 1);
    expect(pendingFor(g, before)).toEqual({ tickets: [], files: [{ path, tickets: [], failed: true }], lost: [], refused: [], pruned: false });
    expect(pendingFor(g, stamp)).toEqual({ tickets: [], lost: [], refused: [], pruned: false });
  });

  it('names no file ticket stamped at since itself, only those stamped after it', () => {
    const g = freshGuild();
    const path = `/data/${g}/m/b.json`;
    const record: LandingRec = { landed: 0 };
    const first = fileTicket(record, 1, path);
    const stamp = note(g, first);
    expect(pendingFor(g, stamp)).toEqual({ tickets: [], lost: [], refused: [], pruned: false });
    expect(pendingFor(g, stamp - 1)).toEqual({ tickets: [first], files: [{ path, tickets: [first], failed: false }], lost: [], refused: [], pruned: false });
  });
});

describe('rh6: a document keeps its latest refusal', () => {
  it('a later refusal of the same document replaces the earlier one', () => {
    const g = freshGuild();
    const before = saveMark().stamp;
    noteScopeRefusal(g, 'doc-twice');
    const first = saveMark().stamp;
    noteScopeRefusal(g, 'doc-twice');
    const second = saveMark().stamp;
    expect(pendingFor(g, before).refused).toEqual([{ stamp: second, doc: 'doc-twice', rewritten: false }]);
    expect(pendingFor(g, first).refused).toEqual([{ stamp: second, doc: 'doc-twice', rewritten: false }]);
  });

  it('a row op refused after a later refusal of its document was kept does not replace that later refusal', () => {
    const g = freshGuild();
    const op: Op = { state: 'queued' };
    const opStamp = note(g, rowTicket(op, 'key-x'), 'doc-x');
    noteScopeRefusal(g, 'doc-x');
    const later = saveMark().stamp;
    op.state = 'refused';
    expect(pendingFor(g, opStamp).refused).toEqual([{ stamp: later, doc: 'doc-x', rewritten: false }]);
    expect(pendingFor(g, opStamp - 1).refused).toEqual([{ stamp: later, doc: 'doc-x', rewritten: false }]);
  });

  it('past the bound drops the refusal with the lowest stamp, even when a refreshed document was kept first', () => {
    const g = freshGuild();
    const before = saveMark().stamp;
    const stamps: number[] = [];
    for (let i = 0; i < LOST_MARKS_PER_SCOPE; i++) {
      noteScopeRefusal(g, `doc-${i}`);
      stamps.push(saveMark().stamp);
    }
    noteScopeRefusal(g, 'doc-0');
    noteScopeRefusal(g, `doc-${LOST_MARKS_PER_SCOPE}`);
    const answer = pendingFor(g, before);
    const docs = answer.refused.map(r => r.doc);
    expect(docs).toHaveLength(LOST_MARKS_PER_SCOPE);
    expect(docs).toContain('doc-0');
    expect(docs).not.toContain('doc-1');
    expect(answer.pruned).toBe(true);
    expect(pendingFor(g, stamps[1]).pruned).toBe(false);
    expect(pendingFor(g, stamps[1] - 1).pruned).toBe(true);
  });
});

describe('rh6: a fenced set that leaves', () => {
  it('is not deposed for a batch at or below unknownThrough, which may have landed', () => {
    const g = freshGuild();
    const before = saveMark().stamp;
    const set: WsSet = { landedSeq: 0, state: 'fenced', unknownThrough: 2 };
    const stamp = note(g, wsTicket(set, g, 2));
    setLeft(set);
    expect(pendingFor(g, before).lost).toEqual([{ stamp, deposed: false }]);
  });

  it('is deposed for a batch above unknownThrough', () => {
    const g = freshGuild();
    const before = saveMark().stamp;
    const set: WsSet = { landedSeq: 0, state: 'fenced', unknownThrough: 2 };
    const stamp = note(g, wsTicket(set, g, 3));
    setLeft(set);
    expect(pendingFor(g, before).lost).toEqual([{ stamp, deposed: true }]);
  });
});
