import { describe, expect, it } from 'vitest';
import { ddlErrorRetries, readCatalog } from '../../src/bot/internalSetup/utils/dataBackends/storeShape';

type Row = Record<string, unknown>;

function client(relations: Row[], columns: Row[] = [], constraints: Row[] = [], rules: Row[] = []) {
  const answers = [relations, columns, constraints, rules];
  let call = 0;
  return { query: async () => ({ rows: answers[call++] ?? [] }) };
}

const rel = (extra: Row): Row => ({ name: 't', kind: 'r', ...extra });

describe('ri2 readCatalog relations', () => {
  it('ri2: a missing text field reads as null and a present one as its text', async () => {
    const cat = await readCatalog(client([rel({ access_method: 'heap' }), rel({ name: 'u' })]), 's');
    expect(cat.relations[0].accessMethod).toBe('heap');
    expect(cat.relations[1].accessMethod).toBeNull();
    expect(cat.relations[1].partitionKey).toBeNull();
    expect(cat.relations[0].bound).toBeNull();
  });

  it('ri2: persistence is the catalog letter, and p when the catalog gave none', async () => {
    const cat = await readCatalog(client([rel({ persistence: 'u' }), rel({ name: 'v' }), rel({ name: 'w', persistence: null })]), 's');
    expect(cat.relations.map(r => r.persistence)).toEqual(['u', 'p', 'p']);
  });

  it('ri2: row security flags are true only for a true catalog value', async () => {
    const cat = await readCatalog(client([
      rel({ rls: true, force_rls: true }),
      rel({ name: 'b', rls: false, force_rls: false }),
      rel({ name: 'c' }),
      rel({ name: 'd', rls: 't', force_rls: 't' }),
    ]), 's');
    expect(cat.relations.map(r => [r.rls, r.forceRls])).toEqual([[true, true], [false, false], [false, false], [false, false]]);
  });

  it('ri2: inherits is empty when the catalog gave no array', async () => {
    const cat = await readCatalog(client([rel({}), rel({ name: 'b', inherits: null }), rel({ name: 'c', inherits: ['p1', 'p2'] })]), 's');
    expect(cat.relations.map(r => r.inherits)).toEqual([[], [], ['p1', 'p2']]);
  });

  it('ri2: a sequence is read only when the catalog gave an increment', async () => {
    const cat = await readCatalog(client([
      rel({ name: 'a', kind: 'S', seq_increment: '1', seq_min: '1', seq_max: '9', seq_cache: '1', seq_cycle: true }),
      rel({ name: 'b', kind: 'S', seq_increment: '2', seq_min: '0', seq_max: '5', seq_cache: '3', seq_cycle: false }),
      rel({ name: 'c', kind: 'S', seq_increment: '1', seq_min: '1', seq_max: '9', seq_cache: '1' }),
      rel({ name: 'd', kind: 'S', seq_increment: '1', seq_min: '1', seq_max: '9', seq_cache: '1', seq_cycle: 't' }),
      rel({ name: 'e', seq_increment: null }),
      rel({ name: 'f' }),
    ]), 's');
    expect(cat.relations.map(r => r.sequence)).toEqual([
      { increment: '1', min: '1', max: '9', cache: '1', cycle: true },
      { increment: '2', min: '0', max: '5', cache: '3', cycle: false },
      { increment: '1', min: '1', max: '9', cache: '1', cycle: false },
      { increment: '1', min: '1', max: '9', cache: '1', cycle: false },
      null,
      null,
    ]);
  });
});

describe('ri2 readCatalog columns and constraints', () => {
  it('ri2: identity, generated and storage keep their letter and read empty when absent', async () => {
    const cat = await readCatalog(client([], [
      { rel: 't', name: 'a', type: 'int', identity: 'a', generated: 's', storage: 'x' },
      { rel: 't', name: 'b', type: 'int', identity: null, generated: null, storage: null },
      { rel: 't', name: 'c', type: 'int' },
    ]), 's');
    expect(cat.columns.map(c => [c.identity, c.generated, c.storage])).toEqual([['a', 's', 'x'], ['', '', ''], ['', '', '']]);
  });

  it('ri2: a constraint is unvalidated only when the catalog says false', async () => {
    const cat = await readCatalog(client([], [], [
      { rel: 't', name: 'a', type: 'c', def: 'CHECK (x)', validated: true },
      { rel: 't', name: 'b', type: 'c', def: 'CHECK (x)', validated: false },
      { rel: 't', name: 'c', type: 'c', def: 'CHECK (x)' },
    ]), 's');
    expect(cat.constraints.map(k => k.validated)).toEqual([true, false, true]);
  });
});

describe('ri2 ddlErrorRetries', () => {
  it('ri2: a thrown function carrying a server code is not a server error, so it retries', () => {
    const f = Object.assign(() => undefined, { severity: 'ERROR', code: '42P07' });
    expect(ddlErrorRetries(f)).toBe(true);
    expect(ddlErrorRetries({ severity: 'ERROR', code: '42P07' })).toBe(false);
  });

  it('ri2: a code that is not exactly five characters retries', () => {
    expect(ddlErrorRetries({ severity: 'ERROR', code: 'X42P07' })).toBe(true);
    expect(ddlErrorRetries({ severity: 'ERROR', code: '42P07X' })).toBe(true);
    expect(ddlErrorRetries({ severity: 'ERROR', code: '42P07' })).toBe(false);
  });
});
