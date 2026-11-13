import { describe, expect, it } from 'vitest';

import { WriteLedger, writesOf, type LedgerTicket } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';

type FileRecord = { landed: number; failed?: Array<{ from: number; through: number; errno: string | null; cut: boolean; what: string }> };

const fileRecord = (): FileRecord => ({ landed: 0 });
const fileTicket = (path: string, seq: number, record: FileRecord): LedgerTicket => ({ kind: 'file', path, seq, record } as unknown as LedgerTicket);
const wsSet = () => ({ landedSeq: 0 });
const wsTicket = (guildId: string, seq: number, set: { landedSeq: number }): LedgerTicket => ({ kind: 'ws', guildId, seq, set, manager: {} } as unknown as LedgerTicket);
const rowOp = (state: string) => ({ state });
const rowTicket = (key: string, seq: number, op: { state: string }): LedgerTicket => ({ kind: 'row', key, seq, op } as unknown as LedgerTicket);

const held = (ledger: WriteLedger) => ledger.tickets().map(entry => entry.ticket);

describe('rj4: a landed entry gives way only to a later write of its own path, row or guild', () => {
  it('keeps a landed file entry when another path is written, and drops it when its own path is written again', () => {
    const ledger = new WriteLedger('panel', null);
    const first = fileRecord();
    const a = fileTicket('/d/g/m/a.json', 1, first);
    ledger.noteTicket(a, 'mod');
    first.landed = 1;
    const b = fileTicket('/d/g/m/b.json', 1, fileRecord());
    ledger.noteTicket(b, 'mod');
    expect(held(ledger)).toEqual([a, b]);
    expect(ledger.landedDropped).toBe(false);
    const again = fileTicket('/d/g/m/a.json', 1, fileRecord());
    ledger.noteTicket(again, 'mod');
    expect(held(ledger)).toEqual([b, again]);
    expect(ledger.landedDropped).toBe(true);
  });

  it('keeps a landed row entry when another row key is written', () => {
    const ledger = new WriteLedger('panel', null);
    const a = rowTicket('g|m/a.json', 1, rowOp('landed'));
    const b = rowTicket('g|m/b.json', 1, rowOp('queued'));
    ledger.noteTicket(a, 'mod');
    ledger.noteTicket(b, 'mod');
    expect(held(ledger)).toEqual([a, b]);
    expect(ledger.landedDropped).toBe(false);
  });

  it('keeps a landed working-set entry when another guild\'s set is written', () => {
    const ledger = new WriteLedger('panel', null);
    const set = wsSet();
    const a = wsTicket('100', 1, set);
    ledger.noteTicket(a, 'mod');
    set.landedSeq = 1;
    const b = wsTicket('200', 1, wsSet());
    ledger.noteTicket(b, 'mod');
    expect(held(ledger)).toEqual([a, b]);
    expect(ledger.landedDropped).toBe(false);
  });
});

describe('rj4: the earlier tickets of one entry', () => {
  it('forgets an earlier ticket once it landed, even when a failed range later covers it', () => {
    const ledger = new WriteLedger('panel', null);
    const record = fileRecord();
    const t1 = fileTicket('/d/g/m/a.json', 1, record);
    const t2 = fileTicket('/d/g/m/a.json', 2, record);
    const t3 = fileTicket('/d/g/m/a.json', 3, record);
    ledger.noteTicket(t1, 'mod');
    ledger.noteTicket(t2, 'mod');
    expect(held(ledger)).toEqual([t2, t1]);
    record.landed = 1;
    ledger.noteTicket(t3, 'mod');
    record.failed = [{ from: 1, through: 1, errno: 'EIO', cut: false, what: 'sync' }];
    expect(held(ledger)).toEqual([t3, t2]);
  });

  it('lists a row op once: its later write stands for the earlier one', () => {
    const ledger = new WriteLedger('panel', null);
    const op = rowOp('queued');
    const r1 = rowTicket('g|m/a.json', 1, op);
    const r2 = rowTicket('g|m/a.json', 2, op);
    ledger.noteTicket(r1, 'mod');
    ledger.noteTicket(r2, 'mod');
    expect(held(ledger)).toEqual([r2]);
  });

  it('lists a row op once when its earlier write is recorded after the later one', () => {
    const ledger = new WriteLedger('panel', null);
    const op = rowOp('queued');
    const r1 = rowTicket('g|m/a.json', 1, op);
    const r2 = rowTicket('g|m/a.json', 2, op);
    ledger.noteTicket(r2, 'mod');
    ledger.noteTicket(r1, 'mod');
    expect(held(ledger)).toEqual([r2]);
  });

  it('lists a file ticket recorded twice once', () => {
    const ledger = new WriteLedger('panel', null);
    const t1 = fileTicket('/d/g/m/a.json', 1, fileRecord());
    ledger.noteTicket(t1, 'mod');
    ledger.noteTicket(t1, 'mod');
    expect(held(ledger)).toEqual([t1]);
  });

  it('lists a working-set ticket recorded twice once', () => {
    const ledger = new WriteLedger('panel', null);
    const t1 = wsTicket('100', 1, wsSet());
    ledger.noteTicket(t1, 'mod');
    ledger.noteTicket(t1, 'mod');
    expect(held(ledger)).toEqual([t1]);
  });

  it('lists each lower unlanded ticket recorded late once, beside the later one', () => {
    const ledger = new WriteLedger('panel', null);
    const record = fileRecord();
    const t1 = fileTicket('/d/g/m/a.jsonl', 1, record);
    const t2 = fileTicket('/d/g/m/a.jsonl', 2, record);
    const t3 = fileTicket('/d/g/m/a.jsonl', 3, record);
    ledger.noteTicket(t3, 'mod');
    ledger.noteTicket(t1, 'mod');
    ledger.noteTicket(t1, 'mod');
    ledger.noteTicket(t2, 'mod');
    ledger.noteTicket(t2, 'mod');
    expect(held(ledger)).toEqual([t3, t1, t2]);
  });
});

describe('rj4: what a ledger answers', () => {
  it('lists an entry\'s modules sorted by name', () => {
    const ledger = new WriteLedger('panel', null);
    const t1 = fileTicket('/d/g/m/a.json', 1, fileRecord());
    ledger.noteTicket(t1, 'zeta');
    ledger.noteTicket(t1, 'alpha');
    ledger.noteTicket(t1, 'mid');
    expect(ledger.tickets()).toEqual([{ ticket: t1, modules: ['alpha', 'mid', 'zeta'] }]);
  });

  it('never marks an unstorable refusal as retried: its op answers refused', () => {
    const ledger = new WriteLedger('panel', null);
    ledger.noteRefusal('unstorable', 'mod', 'g|m/a.json', 'circular');
    ledger.noteRefusal('io', 'mod', 'g|m/a.json');
    ledger.noteRetried('g|m/a.json');
    const docs = ledger.refusedDocs();
    expect(docs.find(d => d.cause === 'unstorable')).toMatchObject({ doc: 'g|m/a.json', retried: false, reason: 'circular' });
    expect(docs.find(d => d.cause === 'io')).toMatchObject({ doc: 'g|m/a.json', retried: true });
    const only = new WriteLedger('panel', null);
    only.noteRefusal('unstorable', 'mod', 'g|m/b.json', 'circular');
    only.noteRetried('g|m/b.json');
    expect(writesOf(only)).toMatchObject({ refused: true, unknowable: false });
  });
});
