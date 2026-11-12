import { describe, expect, it } from 'vitest';

import {
  ScratchBuildFailed,
  checkShape,
  compareShapes,
  ddlErrorRetries,
  sortDifferences,
  type Catalog,
  type CatalogRelation,
  type Difference,
} from '../../src/bot/internalSetup/utils/dataBackends/storeShape';

const rel = (over: Partial<CatalogRelation> & { name: string }): CatalogRelation => ({
  kind: 'r', persistence: 'p', isPartition: false, rls: false, forceRls: false, accessMethod: 'heap',
  partitionKey: null, bound: null, parent: null, inherits: [], indexDef: null, indexValid: null, indexTable: null,
  sequence: null, ...over,
});

const catalog = (...relations: CatalogRelation[]): Catalog => ({ relations, columns: [], constraints: [], rules: [] });

const texts = (found: CatalogRelation, reference: CatalogRelation): string[] =>
  compareShapes(catalog(found), catalog(reference), 'provisioned').differences.map(d => d.text);

describe('ri3: which DDL errors the boot retries', () => {
  it('retries a PANIC from the server, whatever its SQLSTATE class', () => {
    expect(ddlErrorRetries({ severity: 'PANIC', code: '42P07', message: 'x' })).toBe(true);
    expect(ddlErrorRetries({ severity: 'ERROR', code: '42P07', message: 'x' })).toBe(false);
  });
});

describe('ri3: a scratch that can not be built', () => {
  it('names the SQLSTATE and the server message in its text', () => {
    const e = new ScratchBuildFailed('42P07', 'relation exists');
    expect(e.message).toBe('the bot could not build its copy of its schema to compare with (SQLSTATE 42P07: relation exists)');
  });

  it('carries an empty server message when the server sent none', async () => {
    const client = {
      query: async (text: string) => {
        if (text.startsWith('SAVEPOINT')) return { rows: [] };
        throw { severity: 'ERROR', code: '42P07' };
      },
    };
    let caught: unknown;
    try {
      await checkShape(client, 'provisioned');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ScratchBuildFailed);
    expect((caught as ScratchBuildFailed).serverMessage).toBe('');
    expect((caught as ScratchBuildFailed).message).toBe('the bot could not build its copy of its schema to compare with (SQLSTATE 42P07: )');
  });
});

describe('ri3: the order of differences', () => {
  const diff = (text: string, key: Array<string | number>): Difference => ({ text, key });

  it('puts a key before a longer key it starts, from either input order', () => {
    const short = diff('short', [1, 'a']);
    const long = diff('long', [1, 'a', 0]);
    expect(sortDifferences([short, long]).map(d => d.text)).toEqual(['short', 'long']);
    expect(sortDifferences([long, short]).map(d => d.text)).toEqual(['short', 'long']);
  });

  it('leaves the list it was given in its order', () => {
    const a = diff('a', [1, 'b', 0, '']);
    const b = diff('b', [1, 'a', 0, '']);
    const input = [a, b];
    expect(sortDifferences(input).map(d => d.text)).toEqual(['b', 'a']);
    expect(input.map(d => d.text)).toEqual(['a', 'b']);
  });
});

describe('ri3: the comparer texts for one relation', () => {
  it('reports no persistence difference on a partitioned index, whose table carries it', () => {
    const f = rel({ name: 'kv_pkey', kind: 'I', persistence: 'u', accessMethod: null, indexDef: 'X', indexTable: 'kv' });
    const r = rel({ name: 'kv_pkey', kind: 'I', persistence: 'p', accessMethod: null, indexDef: 'X', indexTable: 'kv' });
    expect(texts(f, r)).toEqual([]);
  });

  it('names a table that is not partitioned', () => {
    expect(texts(rel({ name: 'kv', kind: 'p' }), rel({ name: 'kv', kind: 'p', partitionKey: 'RANGE (seq)' }))).toEqual([
      "smdb_data.kv is not partitioned, where this bot's schema has it partitioned by RANGE (seq)",
    ]);
  });

  it('names a TEMPORARY table', () => {
    expect(texts(rel({ name: 'kv', persistence: 't' }), rel({ name: 'kv' }))).toEqual([
      "smdb_data.kv is TEMPORARY, where this bot's schema has it logged",
    ]);
  });

  it('names a missing access method as none, on either side', () => {
    expect(texts(rel({ name: 'kv', accessMethod: null }), rel({ name: 'kv' }))).toEqual([
      "smdb_data.kv uses access method none, where this bot's schema uses heap",
    ]);
    expect(texts(rel({ name: 'kv' }), rel({ name: 'kv', accessMethod: null }))).toEqual([
      "smdb_data.kv uses access method heap, where this bot's schema uses none",
    ]);
  });

  it('reports no partition difference when the store holds an index where the schema has a table', () => {
    const f = rel({ name: 'kv', kind: 'i', accessMethod: null, isPartition: true, parent: 'smdb_data.p', bound: 'B' });
    expect(texts(f, rel({ name: 'kv' }))).toEqual([
      "smdb_data.kv is an index, where this bot's schema has a table",
    ]);
  });

  it('reports a partition the schema has as a plain table even when parent and bound read the same', () => {
    expect(texts(rel({ name: 'kv', isPartition: true }), rel({ name: 'kv' }))).toEqual([
      "smdb_data.kv is a partition of null null, where this bot's schema has a table that is not a partition",
    ]);
  });

  it('tells two parents from one parent whose name runs them together', () => {
    expect(texts(rel({ name: 'kv', inherits: ['a', 'b'] }), rel({ name: 'kv', inherits: ['ab'] }))).toEqual([
      "smdb_data.kv inherits from a, b, where this bot's schema has ab",
    ]);
    expect(texts(rel({ name: 'kv', inherits: ['ab'] }), rel({ name: 'kv', inherits: ['a', 'b'] }))).toEqual([
      "smdb_data.kv inherits from ab, where this bot's schema has a, b",
    ]);
  });

  it('names a table that inherits from no table', () => {
    expect(texts(rel({ name: 'kv' }), rel({ name: 'kv', inherits: ['a'] }))).toEqual([
      "smdb_data.kv inherits from no table, where this bot's schema has a",
    ]);
  });

  it('reports an index definition the store lacks', () => {
    const r = rel({ name: 'kv_idx', kind: 'i', accessMethod: null, indexDef: 'CREATE INDEX kv_idx ON smdb_data.kv USING btree (k)' });
    expect(texts(rel({ name: 'kv_idx', accessMethod: null }), r)).toEqual([
      "smdb_data.kv_idx is a table, where this bot's schema has an index",
      "smdb_data.kv_idx is a table, where this bot's schema has CREATE INDEX kv_idx ON smdb_data.kv USING btree (k)",
    ]);
  });

  it('reports an index definition the schema lacks', () => {
    const f = rel({ name: 'kv_idx', kind: 'i', accessMethod: null, indexDef: 'CREATE INDEX kv_idx ON smdb_data.kv USING btree (k)' });
    expect(texts(f, rel({ name: 'kv_idx', accessMethod: null }))).toEqual([
      "smdb_data.kv_idx is an index, where this bot's schema has a table",
      "smdb_data.kv_idx is CREATE INDEX kv_idx ON smdb_data.kv USING btree (k), where this bot's schema has a table",
    ]);
  });
});
