import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath } from '../../src/utils/dataRoot';
import * as dm from '../../src/bot/internalSetup/utils/dataManager';
import { openLedger, runInLedger } from '../../src/bot/internalSetup/utils/dataBackends/writeLedger';
import { textRefusal } from '../../src/bot/internalSetup/utils/storableData';
import { setBackendKind } from '../helpers/backendKind';

// NB12 item 2 and item 4 (wip-redesign/sheets/NB12.md): a raw write under a numeric guild folder meets the guild rules
// and nothing else does; a refused raw write is logged and recorded under its path; a guild key the facade cannot
// form is refused with its reason in the operator's words.

let guilds = 9_730_000_000;
const freshGuild = () => String(++guilds);
let errors: string[];
const BAD = 'a\u0000b';
const badReason = () => textRefusal(BAD, 'text')!;

beforeEach(() => {
  setBackendKind('file');
  errors = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await dm.flushAll();
});

describe('which raw paths meet the guild rules', () => {
  it('a file straight under a guild folder does', () => {
    const abs = dataPath(freshGuild(), 'x.json');
    expect(dm.rawWriteRefusal(abs, BAD)).toEqual({ accepted: false, cause: 'unstorable', reason: badReason() });
  });

  it('a file whose name ends in two dots under a guild folder does', () => {
    const abs = dataPath(freshGuild(), 'm', 'notes..');
    expect(dm.rawWriteRefusal(abs, BAD)).toMatchObject({ accepted: false, cause: 'unstorable' });
  });

  it.each([
    ['a folder whose name is not a number', ['abc', 'x.json']],
    ['a folder named digits then letters', ['123abc', 'x.json']],
    ['a folder named letters then digits', ['abc123', 'x.json']],
    ['a file named like a guild at the data root', ['4567']],
  ])('%s does not', (_name, rel) => {
    expect(dm.rawWriteRefusal(dataPath(...rel), BAD)).toBeNull();
    expect(errors).toEqual([]);
  });
});

describe('a refused raw write', () => {
  it('logs the path and the reason and records the refusal under the path', () => {
    const abs = dataPath(freshGuild(), 'm', 'x.json');
    const ledger = openLedger('console');
    const answer = runInLedger(ledger, 'm', () => dm.rawWriteRefusal(abs, BAD));
    expect(answer).toEqual({ accepted: false, cause: 'unstorable', reason: badReason() });
    expect(errors).toEqual([`[Data] Refused a write of file:${abs}: ${badReason()}; nothing was saved`]);
    expect(ledger.refusedDocs()).toEqual([expect.objectContaining({ cause: 'unstorable', doc: `file:${abs}`, reason: badReason() })]);
  });
});

describe('a guild key the facade cannot form', () => {
  it.each([
    ['a\\b.json', 'the guild key "a\\b.json" holds a backslash'],
    ['x; refused\\y.json', 'the guild key "x; refused\\y.json" holds a backslash'],
    ['/a.json', 'the guild key "/a.json" starts with "/"'],
  ])('%j is refused with the reason %j', (filename, reason) => {
    const answer = dm.saveDataTracked(filename, { guildId: freshGuild() }, { a: 1 });
    expect(answer).toEqual({ outcome: 'refused', cause: 'unstorable', reason });
    expect(errors).toHaveLength(1);
    expect(errors[0].endsWith(`: ${reason}; nothing was saved`)).toBe(true);
  });
});
