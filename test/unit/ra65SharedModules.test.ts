import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import type { QueryResult } from 'pg';
import type { SharedStatement, SharedTxOutcome, SharedTxSpec } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { fetchModule, moduleRelRefusal, moduleShaOf, publishModule, readModuleFolder, INSTALLED_KEY } from '../../src/bot/internalSetup/utils/sharedModules';
import { CHECKED_SQL, configureRowFlush, UPSERT_SQL, APPEND_SQL, updatedBy, shaOf, type RowBackend } from '../../src/bot/internalSetup/utils/sharedStore';
import { FLUSH_STATEMENT_BYTES, SEGMENT_MAX_BYTES } from '../../src/bot/internalSetup/utils/storableData';

const NO_DATABASE = "this process has no connection to the bot's database";
const dirs: string[] = [];

afterEach(() => {
  configureRowFlush({ backend: () => null });
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function folder(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra65-'));
  dirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return dir;
}

const result = (rows: any[]): QueryResult => ({ rows, rowCount: rows.length, command: '', oid: 0, fields: [] });

/** A sharedTx that sends each statement and then the ones its answer gives, and commits unless one stops. */
function fakeBackend(answer: (st: SharedStatement) => any[]) {
  const sent: SharedStatement[] = [];
  const backend: RowBackend = {
    async sharedTx<S>(spec: SharedTxSpec<S>): Promise<SharedTxOutcome<S>> {
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
      return stop ? { kind: 'stopped', value: stop.stop } : { kind: 'committed', results: [] };
    },
  };
  configureRowFlush({ backend: () => backend });
  return sent;
}

const revAnswer = (st: SharedStatement): any[] => (st.text === CHECKED_SQL ? [] : /RETURNING rev/.test(st.text) ? [{ rev: 7 }] : []);

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

describe('without a database', () => {
  it('a publish and a fetch name the missing connection as their cause', async () => {
    configureRowFlush({ backend: () => null });
    const dir = folder({ 'index.js': '1' });
    expect(await publishModule('m', dir, '{}', 'absent', { operation: 'install' })).toEqual({ kind: 'failed', cause: NO_DATABASE });
    expect(await fetchModule('m', path.join(dir, 'out'))).toEqual({ ok: false, cause: NO_DATABASE });
  });
});

describe('the file rows insert', () => {
  it('binds each file to its own four parameters, rows joined by commas', async () => {
    const sent = fakeBackend(revAnswer);
    const files = { 'a.js': 'A', 'b.js': 'BB', 'c.js': 'CCC' };
    const dir = folder(files);
    const answer = await publishModule('m', dir, '{}', 'absent', { operation: 'install' });
    expect(answer.kind).toBe('committed');
    const inserts = sent.filter(s => s.text.startsWith('INSERT INTO smdb_data.shared_module_files'));
    expect(inserts).toHaveLength(1);
    const insert = inserts[0];
    expect(insert.text).toBe(
      'INSERT INTO smdb_data.shared_module_files (module, rel, bytes, mode) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8), ($9, $10, $11, $12)',
    );
    const tuples = [...insert.text.matchAll(/\(\$(\d+), \$(\d+), \$(\d+), \$(\d+)\)/g)].map(m => m.slice(1).map(n => insert.values[Number(n) - 1]));
    expect(tuples.map(([module, rel, bytes]) => [module, rel, String(bytes)])).toEqual([['m', 'a.js', 'A'], ['m', 'b.js', 'BB'], ['m', 'c.js', 'CCC']]);
  });
});

describe('the order of a module folder and its sha', () => {
  it('readModuleFolder lists files by their path code units, not the walk order', () => {
    const files: Record<string, string> = {};
    for (const c of 'abcdefgh') {
      files[`${c}/z.js`] = c;
      files[`${c}.js`] = c;
    }
    const rels = readModuleFolder(folder(files)).map(f => f.rel);
    expect(rels).toEqual(Object.keys(files).sort());
    expect(rels.slice(0, 2)).toEqual(['a.js', 'a/z.js']);
  });

  it('moduleShaOf hashes the list sorted by rel whatever order it is given', () => {
    const sorted = [{ rel: 'a.js', sha: '1' }, { rel: 'b.js', sha: '2' }, { rel: 'c.js', sha: '3' }];
    const expected = sha256(sorted.map(f => `${f.rel}\0${f.sha}\n`).join(''));
    expect(moduleShaOf(sorted)).toBe(expected);
    expect(moduleShaOf([...sorted].reverse())).toBe(expected);
    expect(moduleShaOf([sorted[1], sorted[2], sorted[0]])).toBe(expected);
  });

  it('moduleShaOf keeps entries of one rel in the order given', () => {
    const list = [{ rel: 'x', sha: '2' }, { rel: 'x', sha: '1' }];
    expect(moduleShaOf(list)).toBe(sha256('x\x002\nx\x001\n'));
  });
});

describe('moduleRelRefusal', () => {
  it('accepts a part ending in .tmp and refuses a device name as written', () => {
    expect(moduleRelRefusal('lib/x.tmp')).toBeNull();
    expect(moduleRelRefusal('con')).toBe('the part "con" is the Windows device name CON');
  });

  it('names a refused .tmp part as the folder holds it', () => {
    expect(moduleRelRefusal('lib/con.tmp')).toBe('the part "con.tmp" is the Windows device name CON');
  });

  it('measures a .tmp part at its own length', () => {
    const fits = `${'a'.repeat(SEGMENT_MAX_BYTES - 4)}.tmp`;
    expect(moduleRelRefusal(fits)).toBeNull();
    const over = `${'a'.repeat(SEGMENT_MAX_BYTES - 3)}.tmp`;
    expect(moduleRelRefusal(over)).toBe(`the part "${'a'.repeat(40)}..." is ${SEGMENT_MAX_BYTES + 1} bytes; one part of a key holds at most ${SEGMENT_MAX_BYTES}`);
  });
});

describe('the base check of installed.json', () => {
  it('a row with no writer refuses with an empty machine and the row time', async () => {
    const at = new Date('2026-11-01T10:00:00.000Z');
    fakeBackend(st => (st.text === CHECKED_SQL ? [{ sha: 'other', updated_by: null, updated_at: at.toISOString() }] : revAnswer(st)));
    const answer = await publishModule('m', folder({ 'index.js': '1' }), '{}', 'base', { operation: 'update' });
    expect(answer).toEqual({ kind: 'refused', cause: 'changed-elsewhere', by: '', at });
  });
});

describe('installed.json written in pieces', () => {
  it('keeps the first statement within the bound and stores every byte', async () => {
    const sent = fakeBackend(revAnswer);
    const body = Buffer.alloc(FLUSH_STATEMENT_BYTES + 1000, 0x61);
    const answer = await publishModule('m', folder({ 'index.js': '1' }), body, 'absent', { operation: 'install' });
    expect(answer.kind).toBe('committed');
    const upsert = sent.find(s => s.text === UPSERT_SQL && s.values[0] === INSTALLED_KEY)!;
    const [key, first, sha, by] = upsert.values as [string, Buffer, string, string];
    expect(sha).toBe(shaOf(body));
    expect(by).toBe(updatedBy());
    expect(first.length).toBe(FLUSH_STATEMENT_BYTES - Buffer.byteLength(key) - Buffer.byteLength(sha) - Buffer.byteLength(by));
    const appends = sent.filter(s => s.text === APPEND_SQL && s.values[0] === INSTALLED_KEY).map(s => s.values[1] as Buffer);
    expect(Buffer.concat([first, ...appends]).equals(body)).toBe(true);
  });
});
