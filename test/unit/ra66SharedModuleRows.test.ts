import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'path';
import type { QueryResult } from 'pg';
import type { SharedStatement, SharedTxOutcome, SharedTxSpec } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { publishModule } from '../../src/bot/internalSetup/utils/sharedModules';
import { configureRowFlush, type RowBackend } from '../../src/bot/internalSetup/utils/sharedStore';

const virtual = vi.hoisted(() => ({ root: '', files: new Map<string, Buffer>() }));

// A folder of 1001 files made on disk takes seconds on Windows; this folder lives in memory.
vi.mock('fs', async importOriginal => {
  const real = await importOriginal<typeof import('fs')>();
  const inRoot = (p: unknown) => virtual.root !== '' && String(p) === virtual.root;
  const fileOf = (p: unknown) => (virtual.root !== '' && path.dirname(String(p)) === virtual.root ? virtual.files.get(path.basename(String(p))) : undefined);
  const wrapped = {
    ...real,
    readdirSync: ((p: any, o?: any) =>
      inRoot(p) ? [...virtual.files.keys()].map(name => ({ name, isDirectory: () => false })) : real.readdirSync(p, o)) as typeof real.readdirSync,
    readFileSync: ((p: any, o?: any) => fileOf(p) ?? real.readFileSync(p, o)) as typeof real.readFileSync,
    statSync: ((p: any, o?: any) => (fileOf(p) ? { mode: 0o100644 } : real.statSync(p, o))) as typeof real.statSync,
  };
  return { ...wrapped, default: wrapped };
});

afterEach(() => {
  configureRowFlush({ backend: () => null });
  virtual.root = '';
  virtual.files.clear();
});

const result = (rows: any[]): QueryResult => ({ rows, rowCount: rows.length, command: '', oid: 0, fields: [] });

function fakeBackend() {
  const sent: SharedStatement[] = [];
  const backend: RowBackend = {
    async sharedTx<S>(spec: SharedTxSpec<S>): Promise<SharedTxOutcome<S>> {
      const built = spec.statements(null);
      if (!Array.isArray(built)) throw new Error('unexpected build answer');
      const run = (list: SharedStatement<S>[]) => {
        for (const st of list) {
          sent.push(st as SharedStatement);
          const next = st.next?.(result(/RETURNING rev/.test(st.text) ? [{ rev: 1 }] : []));
          if (Array.isArray(next)) run(next);
        }
      };
      run(built);
      return { kind: 'committed', results: [] };
    },
  };
  configureRowFlush({ backend: () => backend });
  return sent;
}

describe('the file rows of a large module', () => {
  it('starts a new insert after 1000 rows and stores every file once', async () => {
    virtual.root = path.resolve('ra66-virtual-module');
    const rels: string[] = [];
    for (let i = 0; i < 1001; i += 1) {
      const rel = `f${String(i).padStart(4, '0')}.js`;
      rels.push(rel);
      virtual.files.set(rel, Buffer.from(String(i)));
    }
    const sent = fakeBackend();
    const answer = await publishModule('m', virtual.root, '{}', 'absent', { operation: 'install' });
    expect(answer.kind).toBe('committed');
    const inserts = sent.filter(s => s.text.startsWith('INSERT INTO smdb_data.shared_module_files'));
    expect(inserts.map(s => s.values.length / 4)).toEqual([1000, 1]);
    const rows = inserts.flatMap(s => Array.from({ length: s.values.length / 4 }, (_, i) => [String(s.values[4 * i + 1]), String(s.values[4 * i + 2])]));
    expect(rows).toEqual(rels.map((rel, i) => [rel, String(i)]));
    expect(inserts[1].text).toBe('INSERT INTO smdb_data.shared_module_files (module, rel, bytes, mode) VALUES ($1, $2, $3, $4)');
  });
});
