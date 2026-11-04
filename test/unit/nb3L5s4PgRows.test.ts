import { describe, expect, it } from 'vitest';
import { listPgUnits, readPgUnit, snapshotFromPgRows, type PgSession } from '../../src/bot/internalSetup/utils/dataMigration';

// NB3 mutation gate, chunk 4: a Postgres source's rows made into one snapshot, its units listed and read.

const G1 = '990000000000000001';
const G2 = '990000000000000002';
const doc = (module: string, filename: string, text = '{}', guild = G1) => ({ guild_id: guild, module, filename, doc: text });
const chunk = (module: string, filename: string, text: string, guild = G1) => ({ guild_id: guild, module, filename, chunk: text });
const grave = (module: string, filename: string, o: { text?: string; guild?: string; at?: string; reason?: string | null; kind?: string } = {}) => ({
  guild_id: o.guild ?? G1, module, filename, kind: o.kind ?? 'doc', doc: o.text ?? '{}', retired_at: o.at ?? '100', reason: o.reason === undefined ? 'left' : o.reason,
});
const items = (snap: ReturnType<typeof snapshotFromPgRows>) =>
  snap.items.map(i => ({ guildId: i.guildId, grave: i.grave, retiredAt: i.retiredAt, module: i.module, filename: i.filename, kind: i.kind, text: i.bytes.toString('utf8') }));
const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  return 'no refusal';
};

describe('NB3 L5 s4: graveyard entries and their reasons', () => {
  it('two graveyard entries stay two, each with its own reason, a NULL reason read as empty', () => {
    const snap = snapshotFromPgRows([], [], [
      grave('m', 'a.json', { guild: G1, at: '100', reason: 'kicked' }),
      grave('m', 'b.json', { guild: G2, at: '200', reason: null }),
    ]);
    expect(snap.graves).toEqual([
      { guildId: G1, retiredAt: 100, reason: 'kicked' },
      { guildId: G2, retiredAt: 200, reason: '' },
    ]);
    expect(items(snap).map(i => `${i.guildId}-${i.retiredAt}/${i.module}/${i.filename}`)).toEqual([`${G1}-100/m/a.json`, `${G2}-200/m/b.json`]);
    expect(snap.guilds).toEqual([]);
  });

  it('a graveyard row of kind append is copied as a stream', () => {
    const snap = snapshotFromPgRows([], [], [grave('m', 's.jsonl', { kind: 'append', text: '{"x":1}\n' })]);
    expect(items(snap)).toEqual([{ guildId: G1, grave: true, retiredAt: 100, module: 'm', filename: 's.jsonl', kind: 'append', text: '{"x":1}\n' }]);
  });
});

describe('NB3 L5 s4: append streams', () => {
  it('joins each stream from its own chunks and gives each guild its ownership', () => {
    const snap = snapshotFromPgRows([], [
      chunk('m', 'x.jsonl', 'a\n'),
      chunk('m', 'x.jsonl', 'b\n'),
      chunk('m', 'y.jsonl', 'c\n'),
      chunk('m', 'x.jsonl', 'd\n', G2),
    ], []);
    expect(items(snap)).toEqual([
      { guildId: G1, grave: false, retiredAt: undefined, module: 'm', filename: 'x.jsonl', kind: 'append', text: 'a\nb\n' },
      { guildId: G1, grave: false, retiredAt: undefined, module: 'm', filename: 'y.jsonl', kind: 'append', text: 'c\n' },
      { guildId: G2, grave: false, retiredAt: undefined, module: 'm', filename: 'x.jsonl', kind: 'append', text: 'd\n' },
    ]);
    expect(snap.guilds).toEqual([G1, G2]);
  });

  it('a guild with documents only gets its ownership', () => {
    expect(snapshotFromPgRows([doc('m', 'a.json')], [], []).guilds).toEqual([G1]);
  });

  it('refuses a stream whose name does not end in .jsonl, naming it', () => {
    expect(refusal(() => snapshotFromPgRows([], [chunk('m', 'log.txt', 'a\n')], [])))
      .toBe(`The stream m/log.txt of guild ${G1} does not end in .jsonl; nothing was written`);
  });

  it('refuses a document whose name ends in .jsonl, naming it', () => {
    expect(refusal(() => snapshotFromPgRows([doc('m', 'x.jsonl')], [], [])))
      .toBe(`The document m/x.jsonl of guild ${G1} ends in .jsonl, which marks a stream; nothing was written`);
  });
});

describe('NB3 L5 s4: keys that cannot be copied', () => {
  it('refuses a key with no file form, naming it and why', () => {
    expect(refusal(() => snapshotFromPgRows([doc('', '/abs.json')], [], [])))
      .toBe(`The key //abs.json of guild ${G1} has no file form ([Data] The guild key "/abs.json" starts with "/"; refused); nothing was written`);
  });

  it('refuses a key ending in .tmp, and copies a name that only starts with .tmp', () => {
    expect(refusal(() => snapshotFromPgRows([doc('m', 'a.tmp')], [], [])))
      .toBe(`The key m/a.tmp of guild ${G1} ends in .tmp; nothing was written`);
    expect(items(snapshotFromPgRows([doc('m', '.tmpnotes.json')], [], [])).map(i => i.filename)).toEqual(['.tmpnotes.json']);
  });

  it('copies a document named "stryker was here" at the guild root', () => {
    expect(items(snapshotFromPgRows([doc('', 'stryker was here', '1')], [], []))).toEqual([
      { guildId: G1, grave: false, retiredAt: undefined, module: '', filename: 'stryker was here', kind: 'doc', text: '1' },
    ]);
  });
});

describe('NB3 L5 s4: .graveyard.json', () => {
  it('a live guild keeps a document named .graveyard.json at its root', () => {
    expect(items(snapshotFromPgRows([doc('', '.graveyard.json', '{"k":1}')], [], []))).toEqual([
      { guildId: G1, grave: false, retiredAt: undefined, module: '', filename: '.graveyard.json', kind: 'doc', text: '{"k":1}' },
    ]);
  });

  it('a graveyard entry refuses a root document named .graveyard.json, saying it would take the note\'s place', () => {
    expect(refusal(() => snapshotFromPgRows([], [], [grave('', '.graveyard.json')])))
      .toBe(`A document named .graveyard.json at the root of graveyard entry ${G1}-100 would take the place of its note; nothing was written`);
  });

  it('a graveyard entry keeps .graveyard.json inside a module and its other documents', () => {
    const snap = snapshotFromPgRows([], [], [grave('m', '.graveyard.json', { text: '1' }), grave('m', 'g.json', { text: '2' })]);
    expect(items(snap).map(i => `${i.module}/${i.filename}=${i.text}`)).toEqual(['m/.graveyard.json=1', 'm/g.json=2']);
    expect(snap.graves).toEqual([{ guildId: G1, retiredAt: 100, reason: 'left' }]);
  });

  it('a graveyard entry keeps a root document with another name', () => {
    const snap = snapshotFromPgRows([], [], [grave('', 'notes.json', { text: '3' })]);
    expect(items(snap)).toEqual([{ guildId: G1, grave: true, retiredAt: 100, module: '', filename: 'notes.json', kind: 'doc', text: '3' }]);
  });
});

describe('NB3 L5 s4: keys that are not in canonical form', () => {
  it('copies a lone key in another form under its canonical form, with no shadow', () => {
    const snap = snapshotFromPgRows([doc('', 'm/a.json', '{"a":1}')], [], []);
    expect(items(snap)).toEqual([{ guildId: G1, grave: false, retiredAt: undefined, module: 'm', filename: 'a.json', kind: 'doc', text: '{"a":1}' }]);
    expect(snap.shadow).toEqual([]);
  });

  it('refuses two keys in other forms that name one document, listing both', () => {
    expect(refusal(() => snapshotFromPgRows([doc('', 'm/a.json'), doc('m', './a.json')], [], [])))
      .toBe(`The keys ('', 'm/a.json'), ('m', './a.json') of guild ${G1} all name m/a.json; nothing was written`);
  });

  it('the canonical row wins over an earlier row in another form, which goes to the shadow', () => {
    const snap = snapshotFromPgRows([doc('', 'm/a.json', '{"old":1}'), doc('m', 'a.json', '{"new":1}')], [], []);
    expect(items(snap)).toEqual([{ guildId: G1, grave: false, retiredAt: undefined, module: 'm', filename: 'a.json', kind: 'doc', text: '{"new":1}' }]);
    expect(snap.shadow.map(s => ({ ...s, bytes: s.bytes.toString('utf8') }))).toEqual([{ guildId: G1, module: '', filename: 'm/a.json', bytes: '{"old":1}' }]);
  });

  it('a graveyard entry\'s shadow row carries the entry\'s retired_at', () => {
    const snap = snapshotFromPgRows([], [], [grave('', 'm/a.json', { text: 'old' }), grave('m', 'a.json', { text: 'new' })]);
    expect(snap.shadow.map(s => ({ ...s, bytes: s.bytes.toString('utf8') }))).toEqual([{ guildId: G1, retiredAt: 100, module: '', filename: 'm/a.json', bytes: 'old' }]);
  });
});

describe('NB3 L5 s4: listing and reading the units of a Postgres source', () => {
  it('leaves out a graveyard entry whose retired_at text is not plain digits', async () => {
    const results = [{ rows: [] }, { rows: [{ guild_id: G1, retired_at: '17.0' }, { guild_id: G1, retired_at: '18' }] }];
    const session: PgSession = { query: async () => results.shift()!, end: async () => undefined };
    const leftOut: string[] = [];
    const units = await listPgUnits(session, leftOut);
    expect(units).toEqual([{ guildId: G1, retiredAt: 18, retiredText: '18' }]);
    expect(leftOut).toEqual([`graveyard entry ${G1}-17.0 in the database (its retired_at cannot name a folder exactly)`]);
  });

  it('reads a graveyard entry listed without its text by its retired_at', async () => {
    const seen: unknown[][] = [];
    const session: PgSession = {
      query: async (_sql: string, params: unknown[] = []) => {
        seen.push(params);
        return { rows: params[0] === G1 && params[1] === '17' ? [grave('m', 'g.json', { at: '17' })] : [] };
      },
      end: async () => undefined,
    };
    const snap = await readPgUnit(session, { guildId: G1, retiredAt: 17 });
    expect(seen).toEqual([[G1, '17']]);
    expect(snap.graves).toEqual([{ guildId: G1, retiredAt: 17, reason: 'left' }]);
  });

  it('reads a guild with one document and one stream, each by the guild id', async () => {
    const session: PgSession = {
      query: async (sql: string, params: unknown[] = []) => {
        if (params[0] !== G1) return { rows: [] };
        if (sql.includes('guild_append')) return { rows: [chunk('m', 'x.jsonl', 'a\n')] };
        return { rows: [doc('m', 'a.json', '{"a":1}')] };
      },
      end: async () => undefined,
    };
    const snap = await readPgUnit(session, { guildId: G1 });
    expect(items(snap).map(i => `${i.kind}:${i.module}/${i.filename}=${i.text}`)).toEqual(['doc:m/a.json={"a":1}', 'append:m/x.jsonl=a\n']);
    expect(snap.guilds).toEqual([G1]);
  });
});
