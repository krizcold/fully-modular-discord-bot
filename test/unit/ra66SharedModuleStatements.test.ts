import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { QueryResult } from 'pg';
import type { SharedStatement, SharedTxOutcome, SharedTxSpec } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { INSTALLED_KEY, publishModule, readModuleFolder, unpublishModule } from '../../src/bot/internalSetup/utils/sharedModules';
import { APPEND_SQL, configureRowFlush, NOTIFY_SQL, OPS_SQL, shaOf, UPSERT_SQL, updatedBy, type RowBackend } from '../../src/bot/internalSetup/utils/sharedStore';
import { FLUSH_STATEMENT_BYTES as F } from '../../src/bot/internalSetup/utils/storableData';

const INSERT_PREFIX = 'INSERT INTO smdb_data.shared_module_files';
const FILES_APPEND_SQL = 'UPDATE smdb_data.shared_module_files SET bytes = bytes || $3 WHERE module = $1 AND rel = $2';
const dirs: string[] = [];

afterEach(() => {
  configureRowFlush({ backend: () => null });
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function folder(files: Record<string, string | Buffer>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra66-'));
  dirs.push(dir);
  for (const [rel, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), body);
  return dir;
}

const result = (rows: any[]): QueryResult => ({ rows, rowCount: rows.length, command: '', oid: 0, fields: [] });

const revRows = (st: SharedStatement): any[] => (/RETURNING rev/.test(st.text) ? [{ rev: 7 }] : []);

type First = (sent: SharedStatement[]) => SharedTxOutcome<any> | null;

/** sharedTx sends each statement and then those its answer gives; first, when set, replaces the first call's outcome. */
function fakeBackend(answer: (st: SharedStatement) => any[] = revRows, first?: First, later?: (spec: SharedTxSpec<any>) => Promise<SharedTxOutcome<any>>) {
  const sent: SharedStatement[] = [];
  let calls = 0;
  const backend: RowBackend = {
    async sharedTx<S>(spec: SharedTxSpec<S>): Promise<SharedTxOutcome<S>> {
      calls += 1;
      if (calls > 1 && later) return later(spec) as Promise<SharedTxOutcome<S>>;
      const built = spec.statements(null);
      if (built === 'landed') return { kind: 'landed' };
      if (!Array.isArray(built)) return { kind: 'stopped', value: built.stop };
      const run = (list: SharedStatement<S>[]): { stop: S } | undefined => {
        for (const st of list) {
          sent.push(st as SharedStatement);
          const next = st.next?.(result(answer(st as SharedStatement)));
          if (!next) continue;
          if (!Array.isArray(next)) return next;
          const stop = run(next);
          if (stop) return stop;
        }
        return undefined;
      };
      const stop = run(built);
      if (stop) return { kind: 'stopped', value: stop.stop };
      return (first?.(sent) as SharedTxOutcome<S> | null) ?? { kind: 'committed', results: [] };
    },
  };
  configureRowFlush({ backend: () => backend });
  return sent;
}

const sizeOf = (v: unknown): number => (Buffer.isBuffer(v) ? v.length : typeof v === 'string' ? Buffer.byteLength(v) : String(v).length);
const valueBytes = (st: SharedStatement): number => st.values.reduce((n: number, v) => n + sizeOf(v), 0);

const fileInserts = (sent: SharedStatement[]) => sent.filter(s => s.text.startsWith(INSERT_PREFIX));
const insertRels = (st: SharedStatement): string[] => st.values.filter((_, i) => i % 4 === 1).map(String);
const docAppends = (sent: SharedStatement[]) => sent.filter(s => s.text === APPEND_SQL);
const fileAppends = (sent: SharedStatement[]) => sent.filter(s => s.text === FILES_APPEND_SQL);
const notices = (sent: SharedStatement[]) => sent.filter(s => s.text === NOTIFY_SQL).map(s => JSON.parse(String(s.values[0])));

const modeLen = (dir: string, rel: string): number => String(readModuleFolder(dir).find(f => f.rel === rel)!.mode).length;

describe('installed.json written in pieces', () => {
  it('splits a body of two bounds into a first piece and appends of at most a bound each, every byte stored', async () => {
    const sent = fakeBackend();
    const body = Buffer.alloc(2 * F + 1000);
    for (let i = 0; i < body.length; i += 1) body[i] = i % 251;
    const answer = await publishModule('m', folder({ 'index.js': '1' }), body, 'absent', { operation: 'install' });
    expect(answer.kind).toBe('committed');
    const upsert = sent.find(s => s.text === UPSERT_SQL)!;
    const [key, first, sha, by] = upsert.values as [string, Buffer, string, string];
    expect(key).toBe(INSTALLED_KEY);
    expect(by).toBe(updatedBy());
    expect(sha).toBe(shaOf(body));
    expect(first.length).toBe(F - Buffer.byteLength(key) - Buffer.byteLength(sha) - Buffer.byteLength(by));
    const appends = docAppends(sent);
    expect(appends.map(a => a.values[0])).toEqual([INSTALLED_KEY, INSTALLED_KEY]);
    const pieces = appends.map(a => a.values[1] as Buffer);
    expect(pieces.map(p => p.length)).toEqual([F - Buffer.byteLength(key), body.length - first.length - (F - Buffer.byteLength(key))]);
    expect(Buffer.concat([first, ...pieces]).equals(body)).toBe(true);
    for (const st of [upsert, ...appends]) expect(valueBytes(st)).toBeLessThanOrEqual(F);
  });

  it('sends no append for a body that fits the first statement', async () => {
    const sent = fakeBackend();
    const answer = await unpublishModule('m', '{"a":1}', 'absent');
    expect(answer.kind).toBe('committed');
    const upsert = sent.find(s => s.text === UPSERT_SQL)!;
    expect(String(upsert.values[1])).toBe('{"a":1}');
    expect(docAppends(sent)).toEqual([]);
  });

  it('announces installed.json with the rev its upsert returned', async () => {
    const sent = fakeBackend();
    const answer = await publishModule('m', folder({ 'index.js': '1' }), '{}', 'absent', { operation: 'install' });
    expect(answer.kind).toBe('committed');
    expect(notices(sent).find(n => n.k === 'doc')).toMatchObject({ key: INSTALLED_KEY, rev: 7 });
  });

  it('commits and announces rev 0 when the upsert returns no row', async () => {
    const sent = fakeBackend(st => (st.text === UPSERT_SQL ? [] : revRows(st)));
    const answer = await publishModule('m', folder({ 'index.js': '1' }), '{}', 'absent', { operation: 'install' });
    expect(answer.kind).toBe('committed');
    expect(notices(sent).find(n => n.k === 'doc')).toMatchObject({ key: INSTALLED_KEY, rev: 0 });
  });
});

describe('the file rows of a publish', () => {
  it('sends no file insert for an empty folder', async () => {
    const sent = fakeBackend();
    const answer = await publishModule('m', folder({}), '{}', 'absent', { operation: 'install' });
    expect(answer.kind).toBe('committed');
    expect(fileInserts(sent)).toEqual([]);
  });

  it('puts small files in one insert of one row each', async () => {
    const sent = fakeBackend();
    const answer = await publishModule('m', folder({ 'a.js': 'A', 'b.js': 'BB', 'c.js': 'CCC' }), '{}', 'absent', { operation: 'install' });
    expect(answer.kind).toBe('committed');
    const inserts = fileInserts(sent);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].text).toBe(`${INSERT_PREFIX} (module, rel, bytes, mode) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8), ($9, $10, $11, $12)`);
    expect(insertRels(inserts[0])).toEqual(['a.js', 'b.js', 'c.js']);
  });

  it('keeps two files in one insert when their values fill the bound exactly', async () => {
    const name = 'n'.repeat(F / 2 - 100);
    const dir = folder({ 'a.js': 'a'.repeat(10), 'b.js': 'b' });
    const ma = modeLen(dir, 'a.js');
    const mb = modeLen(dir, 'b.js');
    const lb = F - 2 * name.length - 8 - ma - mb - 10;
    fs.writeFileSync(path.join(dir, 'b.js'), 'b'.repeat(lb));
    const sent = fakeBackend();
    const answer = await publishModule(name, dir, '{}', 'absent', { operation: 'install' });
    expect(answer.kind).toBe('committed');
    const inserts = fileInserts(sent);
    expect(inserts.map(insertRels)).toEqual([['a.js', 'b.js']]);
    expect(valueBytes(inserts[0])).toBe(F);
  });

  it('splits two files into two inserts when their values pass the bound by a byte', async () => {
    const name = 'n'.repeat(F / 2 - 100);
    const dir = folder({ 'a.js': 'a'.repeat(10), 'b.js': 'b' });
    const ma = modeLen(dir, 'a.js');
    const mb = modeLen(dir, 'b.js');
    const lb = F - 2 * name.length - 8 - ma - mb - 10 + 1;
    fs.writeFileSync(path.join(dir, 'b.js'), 'b'.repeat(lb));
    const sent = fakeBackend();
    const answer = await publishModule(name, dir, '{}', 'absent', { operation: 'install' });
    expect(answer.kind).toBe('committed');
    const inserts = fileInserts(sent);
    expect(inserts.map(insertRels)).toEqual([['a.js'], ['b.js']]);
    for (const st of inserts) expect(valueBytes(st)).toBeLessThanOrEqual(F);
  });

  it('stores a file whose values fill the bound exactly with an empty body as one row', async () => {
    const dir = folder({ 'a.js': '' });
    const name = 'n'.repeat(F - 4 - modeLen(dir, 'a.js'));
    const sent = fakeBackend();
    const answer = await publishModule(name, dir, '{}', 'absent', { operation: 'install' });
    expect(answer.kind).toBe('committed');
    const inserts = fileInserts(sent);
    expect(inserts.map(insertRels)).toEqual([['a.js']]);
    expect((inserts[0].values[2] as Buffer).length).toBe(0);
    expect(fileAppends(sent)).toEqual([]);
  });

  it('refuses a file whose path and module name leave no byte of room', async () => {
    const dir = folder({ 'a.js': 'x' });
    const name = 'n'.repeat(F - 4 - modeLen(dir, 'a.js'));
    const sent = fakeBackend();
    const answer = await publishModule(name, dir, '{}', 'absent', { operation: 'install' });
    expect(answer).toEqual({ kind: 'failed', cause: `the path of a.js in ${name} leaves no room for its bytes in a statement` });
    expect(fileInserts(sent)).toEqual([]);
  });

  it('writes a large file as an insert and appends that end at its last byte, after the rows before it', async () => {
    const name = 'n'.repeat(F - 100);
    const dir = folder({ 'a.js': 'A', 'b.js': '' });
    const m = modeLen(dir, 'b.js');
    const first = F - (name.length + 4 + m);
    const piece = F - name.length - 4;
    const big = Buffer.alloc(first + piece);
    for (let i = 0; i < big.length; i += 1) big[i] = 65 + (i % 26);
    fs.writeFileSync(path.join(dir, 'b.js'), big);
    const sent = fakeBackend();
    const answer = await publishModule(name, dir, '{}', 'absent', { operation: 'install' });
    expect(answer.kind).toBe('committed');
    const fileRows = sent.filter(s => s.text.startsWith(INSERT_PREFIX) || s.text === FILES_APPEND_SQL);
    expect(fileRows.map(s => (s.text === FILES_APPEND_SQL ? `append ${s.values[1]}` : `insert ${insertRels(s).join(',')}`))).toEqual(['insert a.js', 'insert b.js', 'append b.js']);
    const appends = fileAppends(sent).map(s => s.values[2] as Buffer);
    expect(appends.map(p => p.length)).toEqual([piece]);
    expect(Buffer.concat([fileRows[1].values[2] as Buffer, ...appends]).equals(big)).toBe(true);
  });
});

describe('a lost COMMIT answer settled by a landing check of its own', () => {
  it('stays unknown when the check transaction read its rows but did not end as stopped', async () => {
    fakeBackend(revRows, () => ({ kind: 'unknown', detail: 'connection reset' }), async spec => {
      expect(spec.check!.at(-1)!.text).toBe(OPS_SQL);
      spec.statements([result([]), result([{ id: 'x' }])]);
      return { kind: 'failed', step: 'statements', detail: 'rollback lost' };
    });
    const answer = await publishModule('m', folder({ 'index.js': '1' }), '{}', 'absent', { operation: 'install' });
    expect(answer).toEqual({ kind: 'unknown', cause: 'connection reset' });
  });
});
