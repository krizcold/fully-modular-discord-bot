import { describe, expect, it } from 'vitest';
import { operatorRefusalText, verdictOf } from '../../src/bot/internalSetup/utils/dataBackends/replyGate';
import { WriteLedger, openLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';

// NB12 (wip-redesign/sheets/NB12.md): the operator's answer to an action led by a write the bot cannot store names
// every refused document with its reason, and an unstorable refusal keeps the reason it was refused with.

const TAIL = "That write was not saved, and trying again gives the same result; the module's author can change what it stores.";

describe("operatorRefusalText: the operator's answer", () => {
  it('leads with the unstorable write even when another refusal is listed before it', () => {
    const text = operatorRefusalText({
      refused: [{ doc: 'm/a.json', answer: 'frozen' }, { doc: 'm/b.json', answer: 'unstorable', reason: 'it holds U+0000' }],
      accepted: 'none',
    });
    expect(text).toBe(`The module's write of m/b.json was refused: it holds U+0000. ${TAIL} The write of m/a.json was also refused: frozen.`);
  });

  it('says the bot cannot store it when the leading refusal carries no reason', () => {
    expect(operatorRefusalText({ refused: [{ doc: 'm/b.json', answer: 'unstorable' }] }))
      .toBe(`The module's write of m/b.json was refused: the bot cannot store it. ${TAIL}`);
  });

  it('says the same for a further unstorable refusal with no reason, and explains a rewritten one', () => {
    const text = operatorRefusalText({
      refused: [
        { doc: 'm/a.json', answer: 'unstorable', reason: 'too big' },
        { doc: 'm/b.json', answer: 'unstorable' },
        { doc: 'm/c.json', answer: 'unavailable' },
      ],
      accepted: 'saved',
    });
    expect(text).toBe([
      `The module's write of m/a.json was refused: too big. ${TAIL}`,
      'The write of m/b.json was also refused: the bot cannot store it.',
      'The write of m/c.json was also refused: the action rewrote it later, so the bot cannot confirm it was saved.',
      "The action's accepted writes were saved.",
    ].join(' '));
  });
});

describe('verdictOf over a ledger with an unstorable refusal', () => {
  it('lists the refused documents in the order they were refused, each reason only where one was given', async () => {
    const ledger = openLedger('console');
    ledger.noteRefusal('frozen', 'mod', 'm/a.json');
    ledger.noteRefusal('unstorable', 'mod', 'm/b.json');
    ledger.noteRefusal('frozen', 'mod', 'm/c.json');
    ledger.noteRefusal('unstorable', 'mod', 'm/d.json', 'it holds U+0000');
    const verdict = await verdictOf([ledger]);
    expect(verdict).toStrictEqual({
      ok: false,
      answer: 'unstorable',
      partial: false,
      refused: [
        { doc: 'm/a.json', answer: 'frozen' },
        { doc: 'm/b.json', answer: 'unstorable' },
        { doc: 'm/c.json', answer: 'frozen' },
        { doc: 'm/d.json', answer: 'unstorable', reason: 'it holds U+0000' },
      ],
      accepted: 'none',
    });
    ledger.seal();
  });
});

describe('WriteLedger.refusedDocs: a reason belongs to an unstorable refusal only', () => {
  it('a reason given with another cause is not reported for a later unstorable refusal of the document', () => {
    const ledger = new WriteLedger('console', null);
    ledger.noteRefusal('frozen', 'mod', 'm/a.json', 'not this one');
    ledger.noteRefusal('unstorable', 'mod', 'm/a.json');
    const docs = ledger.refusedDocs();
    expect(docs.map(d => ({ cause: d.cause, doc: d.doc, ...('reason' in d ? { reason: d.reason } : {}) }))).toStrictEqual([
      { cause: 'frozen', doc: 'm/a.json' },
      { cause: 'unstorable', doc: 'm/a.json' },
    ]);
  });

  it("an unstorable refusal's reason is not reported on another cause's refusal of the document", () => {
    const ledger = new WriteLedger('console', null);
    ledger.noteRefusal('unstorable', 'mod', 'm/a.json', 'it holds U+0000');
    ledger.noteRefusal('frozen', 'mod', 'm/a.json');
    const docs = ledger.refusedDocs();
    expect(docs.map(d => ({ cause: d.cause, doc: d.doc, ...('reason' in d ? { reason: d.reason } : {}) }))).toStrictEqual([
      { cause: 'unstorable', doc: 'm/a.json', reason: 'it holds U+0000' },
      { cause: 'frozen', doc: 'm/a.json' },
    ]);
  });
});
