import { describe, expect, it } from 'vitest';
import { carriedWrites, carryWrites, NO_WRITES, WriteLedger, writesOf, type OpWrites } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';

// The ledger's refusal records and the writes an op's reply carries to the web UI's local chain.

const fileTicket = (seq: number, landed = 0): any => ({ kind: 'file', record: { landed }, seq, path: '/tmp/x.json' });

describe('refusals of one cause', () => {
  it('a second refusal under the same cause adds its module and its document', () => {
    const ledger = new WriteLedger('panel', null);
    ledger.noteRefusal('io', 'modA', 'docA');
    ledger.noteRefusal('io', 'modB', 'docB');
    expect(ledger.refusals()).toEqual([{ cause: 'io', modules: ['modA', 'modB'] }]);
    expect(ledger.refusedDocs().map(r => r.doc).sort()).toEqual(['docA', 'docB']);
  });
});

describe('a retried refusal', () => {
  it('marks only documents already refused under that cause; a later refusal of another document is not retried', () => {
    const ledger = new WriteLedger('panel', null);
    ledger.noteRefusal('io', 'm', 'docA');
    ledger.noteRetried('docB');
    ledger.noteRefusal('io', 'm', 'docB');
    const b = ledger.refusedDocs().find(r => r.doc === 'docB')!;
    expect(b.retried).toBe(false);
    expect(writesOf(ledger)).toMatchObject({ refused: true, unknowable: false });
  });

  it('a refusal at the stop is never retried: it stays refused', () => {
    const ledger = new WriteLedger('panel', null);
    ledger.noteRefusal('node-stopping', 'm', 'docA');
    ledger.noteRetried('docA');
    expect(ledger.refusedDocs()).toEqual([expect.objectContaining({ cause: 'node-stopping', doc: 'docA', retried: false })]);
    expect(writesOf(ledger)).toMatchObject({ refused: true, unknowable: false });
  });

  it('a refusal by a lost writer is never retried: it stays refused', () => {
    const ledger = new WriteLedger('panel', null);
    ledger.noteRefusal('writer-lost', 'm', 'docA');
    ledger.noteRetried('docA');
    expect(ledger.refusedDocs()).toEqual([expect.objectContaining({ cause: 'writer-lost', doc: 'docA', retried: false })]);
    expect(writesOf(ledger)).toMatchObject({ refused: true, unknowable: false });
  });

  it('a retried refusal with no rewrite answers unknowable, not refused', () => {
    const ledger = new WriteLedger('panel', null);
    ledger.noteRefusal('io', 'm', 'docA');
    ledger.noteRetried('docA');
    expect(writesOf(ledger)).toMatchObject({ refused: false, unknowable: true });
  });
});

describe('a refusal and a whole rewrite of its document', () => {
  it('a rewrite after the refusal answers unknowable, not refused', () => {
    const ledger = new WriteLedger('panel', null);
    ledger.noteRefusal('io', 'm', 'docA');
    ledger.noteTicket(fileTicket(1), 'm', 'docA');
    expect(writesOf(ledger)).toMatchObject({ refused: false, unknowable: true });
  });

  it('a rewrite before the refusal leaves it refused', () => {
    const ledger = new WriteLedger('panel', null);
    ledger.noteTicket(fileTicket(1), 'm', 'docA');
    ledger.noteRefusal('io', 'm', 'docA');
    expect(writesOf(ledger)).toMatchObject({ refused: true, unknowable: false });
  });
});

describe('the writes a reply carries', () => {
  const w1: OpWrites = { ...NO_WRITES, tickets: [fileTicket(1)] };
  const w2: OpWrites = { ...NO_WRITES, refused: true };

  it('no reply object (null) carries nothing and does not throw', () => {
    expect(carryWrites(null, w1)).toBeNull();
    expect(carryWrites(null, undefined)).toBeNull();
    expect(carriedWrites(null)).toBeUndefined();
    expect(carriedWrites(undefined)).toBeUndefined();
  });

  it('a text reply is returned as it is', () => {
    expect(carryWrites('done', w1)).toBe('done');
    expect(carriedWrites('done')).toBeUndefined();
  });

  it('an object reply carries the writes under a key no serialization sees', () => {
    const reply = carryWrites({ ok: true }, w1);
    expect(carriedWrites(reply)).toBe(w1);
    expect(JSON.stringify(reply)).toBe('{"ok":true}');
  });

  it('carrying no writes keeps the ones already carried', () => {
    const reply = carryWrites({ ok: true }, w1);
    carryWrites(reply, undefined);
    expect(carriedWrites(reply)).toBe(w1);
  });

  it('a reply can be given new writes later', () => {
    const reply = carryWrites({ ok: true }, w1);
    expect(() => carryWrites(reply, w2)).not.toThrow();
    expect(carriedWrites(reply)).toBe(w2);
  });
});
