import { afterEach, describe, expect, it } from 'vitest';

import { readOwnerMessageKey, recordOwnerMessageKey, _setOwnerChannelDeps } from '../../src/webui/utils/ownerChannel';
import { configureRowFlush, type RowBackend } from '../../src/bot/internalSetup/utils/sharedStore';

// NB23's record of a posted key in smdb_data.meta, read and written through the row backend the web UI uses. The
// backend here runs the statements on an in-memory meta table and answers as Postgres does: a statement whose text it
// cannot parse is a syntax error (42601), and a statement whose values do not match its placeholders is refused at
// bind (08P01); either fails the transaction and nothing of it is kept.

type MetaRow = { key: string; value: string; updated_at: number };
const DAY = 86_400_000;

const sqlError = (code: string, message: string) => Object.assign(new Error(message), { code });

function placeholderCount(text: string): number {
  let max = 0;
  for (const m of text.matchAll(/\$(\d+)/g)) max = Math.max(max, Number(m[1]));
  return max;
}

function predicate(conj: string): (row: MetaRow, now: number) => boolean {
  const tests = conj.split(' AND ').map(part => {
    const like = /^key LIKE '([^'%]*)%'$/.exec(part);
    if (like) return (row: MetaRow) => row.key.startsWith(like[1]);
    const age = /^updated_at < now\(\) - interval '(\d+) days'$/.exec(part);
    if (age) return (row: MetaRow, now: number) => row.updated_at < now - Number(age[1]) * DAY;
    throw sqlError('42601', `syntax error at or near "${part.slice(0, 12)}"`);
  });
  return (row, now) => tests.every(t => t(row, now));
}

const INSERT = /^INSERT INTO smdb_data\.meta \(key, value, updated_at\) VALUES \(\$1, \$2, now\(\)\) ON CONFLICT \(key\) DO UPDATE SET value = EXCLUDED\.value, updated_at = now\(\)$/;
const DELETE_NEWEST = /^DELETE FROM smdb_data\.meta WHERE key IN \(SELECT key FROM smdb_data\.meta WHERE (.*) ORDER BY updated_at DESC, key DESC OFFSET (\d+)\)$/;
const DELETE_WHERE = /^DELETE FROM smdb_data\.meta WHERE (.*)$/;

function run(table: MetaRow[], text: string, values: unknown[], now: number): MetaRow[] {
  const wanted = placeholderCount(text);
  if (values.length !== wanted) {
    throw sqlError('08P01', `bind message supplies ${values.length} parameters, but prepared statement "" requires ${wanted}`);
  }
  if (INSERT.test(text)) {
    const key = String(values[0]);
    return [...table.filter(r => r.key !== key), { key, value: String(values[1]), updated_at: now }];
  }
  const newest = DELETE_NEWEST.exec(text);
  if (newest) {
    const where = predicate(newest[1]);
    const gone = new Set(table.filter(r => where(r, now))
      .sort((a, b) => b.updated_at - a.updated_at || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0))
      .slice(Number(newest[2]))
      .map(r => r.key));
    return table.filter(r => !gone.has(r.key));
  }
  const plain = DELETE_WHERE.exec(text);
  if (plain) {
    const where = predicate(plain[1]);
    return table.filter(r => !where(r, now));
  }
  throw sqlError('42601', 'syntax error');
}

const db = {
  table: [] as MetaRow[],
  now: Date.parse('2026-11-16T00:00:00.000Z'),
  selectFails: undefined as unknown,
  selectRows: null as Array<{ value: unknown }> | null,
  outcome: null as unknown,
};

const backend: RowBackend = {
  async sharedSelect(_text, values) {
    if (db.selectFails !== undefined) throw db.selectFails;
    if (db.selectRows) return { rows: db.selectRows };
    const row = db.table.find(r => r.key === values[0]);
    return { rows: row ? [{ value: row.value }] : [] };
  },
  async sharedTx(spec) {
    if (db.outcome) return db.outcome as never;
    const statements = spec.statements(null);
    if (!Array.isArray(statements)) throw new Error('no statements');
    let copy = [...db.table];
    try {
      for (const st of statements) copy = run(copy, st.text, st.values, db.now);
    } catch (error) {
      const e = error as { code: string; message: string };
      return { kind: 'failed', step: 'statements', detail: e.message, code: e.code };
    }
    db.table = copy;
    return { kind: 'committed', results: [] };
  },
};

function useBackend(given: RowBackend | null): void {
  _setOwnerChannelDeps(null);
  configureRowFlush({ backend: () => given });
}

afterEach(() => {
  db.table = [];
  db.selectFails = undefined;
  db.selectRows = null;
  db.outcome = null;
  configureRowFlush({ backend: () => null });
});

describe('the record of a posted owner message key in the main database', () => {
  it('stores the key and deletes only owner message keys older than 90 days', async () => {
    useBackend(backend);
    db.table = [
      { key: 'owner_channel', value: '"900000000000001201"', updated_at: db.now - 200 * DAY },
      { key: 'owner-message:old', value: '"2026-08-01T00:00:00.000Z"', updated_at: db.now - 100 * DAY },
      { key: 'owner-message:recent', value: '"2026-11-15T00:00:00.000Z"', updated_at: db.now - DAY },
    ];
    const at = '2026-11-16T00:00:00.000Z';
    expect(await recordOwnerMessageKey('k-new', at)).toEqual({ kind: 'ok' });
    expect(db.table.map(r => r.key).sort()).toEqual(['owner-message:k-new', 'owner-message:recent', 'owner_channel']);
    expect(db.table.find(r => r.key === 'owner-message:k-new')!.value).toBe(JSON.stringify(at));
    expect(await readOwnerMessageKey('k-new', 1000)).toBe(at);
  });

  it('keeps the newest 1000 owner message keys and every other meta row', async () => {
    useBackend(backend);
    db.table = [{ key: 'owner_channel', value: '"900000000000001201"', updated_at: db.now - 10 * DAY }];
    for (let i = 0; i < 1000; i++) {
      db.table.push({ key: `owner-message:k${String(i).padStart(4, '0')}`, value: '"x"', updated_at: db.now - (i + 1) * 60_000 });
    }
    expect(await recordOwnerMessageKey('k-new', '2026-11-16T00:00:00.000Z')).toEqual({ kind: 'ok' });
    const keys = new Set(db.table.map(r => r.key));
    expect(keys.size).toBe(1001);
    expect(keys.has('owner_channel')).toBe(true);
    expect(keys.has('owner-message:k-new')).toBe(true);
    expect(keys.has('owner-message:k0999')).toBe(false);
    expect(keys.has('owner-message:k0998')).toBe(true);
  });

  it('answers not saved, naming why, when the process has no row backend', async () => {
    useBackend(null);
    expect(await recordOwnerMessageKey('k1', '2026-11-16T00:00:00.000Z')).toEqual({ kind: 'not-saved', cause: "this process has no connection to the bot's database" });
    await expect(readOwnerMessageKey('k1', 1000)).rejects.toThrow(/^this process has no connection to the bot's database$/);
  });

  it("answers can't confirm with the lost COMMIT named when the backend gives no detail", async () => {
    useBackend(backend);
    db.outcome = { kind: 'unknown' };
    expect(await recordOwnerMessageKey('k1', '2026-11-16T00:00:00.000Z')).toEqual({ kind: 'unknown', cause: 'the answer to COMMIT was lost' });
  });

  it('answers not saved for an outcome that committed nothing and is neither refused nor failed', async () => {
    useBackend(backend);
    db.outcome = { kind: 'landed' };
    expect(await recordOwnerMessageKey('k1', '2026-11-16T00:00:00.000Z')).toEqual({ kind: 'not-saved', cause: 'the database did not take the change' });
  });

  it('reads a stored value that is not a JSON string as the raw text', async () => {
    useBackend(backend);
    db.selectRows = [{ value: '5' }];
    expect(await readOwnerMessageKey('k1', 1000)).toBe('5');
    db.selectRows = [{ value: '{"at":1}' }];
    expect(await readOwnerMessageKey('k1', 1000)).toBe('{"at":1}');
  });

  it('reads no record when the schema is missing (3F000)', async () => {
    useBackend(backend);
    db.selectFails = sqlError('3F000', 'schema "smdb_data" does not exist');
    expect(await readOwnerMessageKey('k1', 1000)).toBeNull();
    db.selectFails = sqlError('42P01', 'relation "smdb_data.meta" does not exist');
    expect(await readOwnerMessageKey('k1', 1000)).toBeNull();
  });

  it('throws the cause of a read that failed with no error value', async () => {
    useBackend(backend);
    db.selectFails = null;
    await expect(readOwnerMessageKey('k1', 1000)).rejects.toThrow(/^null$/);
  });
});
