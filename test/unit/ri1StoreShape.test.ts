import { describe, expect, it } from 'vitest';

import {
  compareShapes,
  gateRefusal,
  privilegeDifference,
  readCatalog,
  readFoundList,
  sortDifferences,
  type Catalog,
  type CatalogColumn,
  type CatalogRelation,
  type FoundList,
  type FoundRelation,
  type Privilege,
} from '../../src/bot/internalSetup/utils/dataBackends/storeShape';

const rel = (name: string, kind: CatalogRelation['kind'] = 'r'): CatalogRelation => ({
  name, kind, persistence: 'p', isPartition: false, rls: false, forceRls: false, accessMethod: 'heap',
  partitionKey: null, bound: null, parent: null, inherits: [], indexDef: null, indexValid: null, indexTable: null,
  sequence: null,
});

const col = (relName: string, name: string, storage: string): CatalogColumn => ({
  rel: relName, name, type: 'text', notNull: true, defaultExpr: null, identity: '', generated: '', generatedExpr: null,
  collation: '"default"', storage, notNullValidated: null,
});

const catalog = (columns: CatalogColumn[]): Catalog => ({ relations: [rel('meta')], columns, constraints: [], rules: [] });

const held = (name: string, kind: string, over: Partial<FoundRelation> = {}): FoundRelation => ({
  name, kind, isPartition: false, select: null, insert: null, update: null, delete: null, usage: null, updateSeq: null,
  ...over,
});

const found = (over: Partial<FoundList>): FoundList => ({
  role: 'bot', db: 'botdb', dbCreate: true, schemaExists: true, schemaUsage: true, schemaCreate: true,
  relations: [], meta: null, ...over,
});

const order = (ps: Privilege[]) =>
  sortDifferences(ps.map(p => privilegeDifference('bot', 'botdb', p))).map(d => `${d.privilege!.scope} ${d.privilege!.target} ${d.privilege!.privilege}`);

describe('ri1: storage names in the difference text', () => {
  it('names EXTERNAL and MAIN storage', () => {
    const result = compareShapes(
      catalog([col('meta', 'key', 'e'), col('meta', 'value', 'm')]),
      catalog([col('meta', 'key', 'x'), col('meta', 'value', 'p')]),
      'provisioned',
    );
    expect(result.differences.map(d => d.text)).toEqual([
      "smdb_data.meta column key has storage EXTERNAL, where this bot's schema has EXTENDED",
      "smdb_data.meta column value has storage MAIN, where this bot's schema has PLAIN",
    ]);
  });
});

describe('ri1: the found list read from the catalog row', () => {
  const client = (row: Record<string, unknown>) => ({ query: async () => ({ rows: [row] }) });

  it('reads a row with no role, db or schema as empty names and no schema', async () => {
    const list = await readFoundList(client({}));
    expect(list.role).toBe('');
    expect(list.db).toBe('');
    expect(list.schemaExists).toBe(false);
    expect(list.relations).toEqual([]);
  });

  it('reads schema_exists false as no schema', async () => {
    const list = await readFoundList(client({ role: 'bot', db: 'botdb', db_create: true, schema_exists: false }));
    expect(list.schemaExists).toBe(false);
  });

  it('marks a relation a partition only when the catalog says true', async () => {
    const list = await readFoundList(client({
      role: 'bot', db: 'botdb', db_create: true, schema_exists: true,
      relations: [
        { name: 'a', kind: 'r', is_partition: true },
        { name: 'b', kind: 'r', is_partition: false },
        { name: 'c', kind: 'r' },
      ],
    }));
    expect(list.relations.map(r => [r.name, r.isPartition])).toEqual([['a', true], ['b', false], ['c', false]]);
  });
});

describe('ri1: the order of privilege lines', () => {
  it('orders privileges on a database CREATE, USAGE, SELECT, INSERT, UPDATE, DELETE', () => {
    const names = ['DELETE', 'UPDATE', 'INSERT', 'SELECT', 'USAGE', 'CREATE'];
    expect(order(names.map(privilege => ({ scope: 'database', target: 'botdb', privilege }))))
      .toEqual(names.slice().reverse().map(p => `database botdb ${p}`));
  });

  it('lists schema USAGE before schema CREATE in the gate refusal', () => {
    const refusal = gateRefusal(found({ schemaUsage: false, schemaCreate: false, relations: [] }));
    expect(refusal?.lines).toEqual([
      "this bot's database role bot lacks USAGE on schema smdb_data",
      "this bot's database role bot lacks CREATE on schema smdb_data",
    ]);
  });

  it('lists table privileges SELECT, INSERT, UPDATE, DELETE in the gate refusal', () => {
    const refusal = gateRefusal(found({
      dbCreate: false,
      relations: [held('meta', 'r', { select: false, insert: false, update: false, delete: false })],
    }));
    expect(refusal?.lines).toEqual([
      "this bot's database role bot lacks CREATE on database botdb",
      "this bot's database role bot lacks SELECT on smdb_data.meta",
      "this bot's database role bot lacks INSERT on smdb_data.meta",
      "this bot's database role bot lacks UPDATE on smdb_data.meta",
      "this bot's database role bot lacks DELETE on smdb_data.meta",
    ]);
  });

  it('puts a sequence privilege it does not rank before USAGE', () => {
    expect(order([
      { scope: 'sequence', target: 's', privilege: 'USAGE' },
      { scope: 'sequence', target: 's', privilege: 'SELECT' },
    ])).toEqual(['sequence s SELECT', 'sequence s USAGE']);
  });

  it('keeps table privileges it does not rank in the order given', () => {
    expect(order([
      { scope: 'table', target: 't', privilege: 'USAGE' },
      { scope: 'table', target: 't', privilege: 'TRUNCATE' },
    ])).toEqual(['table t USAGE', 'table t TRUNCATE']);
  });

  it('orders database privileges by privilege, whatever the database is named', () => {
    expect(order([
      { scope: 'database', target: 'aa', privilege: 'USAGE' },
      { scope: 'database', target: 'zz', privilege: 'CREATE' },
    ])).toEqual(['database zz CREATE', 'database aa USAGE']);
  });

  it('orders schema privileges by privilege, whatever the schema is named', () => {
    expect(order([
      { scope: 'schema', target: 'aa', privilege: 'CREATE' },
      { scope: 'schema', target: 'zz', privilege: 'USAGE' },
    ])).toEqual(['schema zz USAGE', 'schema aa CREATE']);
  });

  it('lists a schema privilege before any relation privilege', () => {
    expect(order([
      { scope: 'table', target: '', privilege: 'SELECT' },
      { scope: 'schema', target: 'smdb_data', privilege: 'USAGE' },
    ])).toEqual(['schema smdb_data USAGE', 'table  SELECT']);
  });
});

describe('ri1: what the gate refuses on', () => {
  it('names a lacked sequence USAGE and grants it', () => {
    const refusal = gateRefusal(found({ dbCreate: false, relations: [held('claim_seq', 'S', { usage: false, updateSeq: true })] }));
    expect(refusal?.lines).toEqual([
      "this bot's database role bot lacks CREATE on database botdb",
      "this bot's database role bot lacks USAGE on sequence smdb_data.claim_seq",
    ]);
    expect(refusal?.fix).toContain('run GRANT USAGE ON SEQUENCE smdb_data.claim_seq TO bot');
  });

  it('passes a schema that holds relations although the role cannot create in it', () => {
    const list = found({
      schemaCreate: false,
      relations: [held('meta', 'r', { select: true, insert: true, update: true, delete: true })],
      meta: { kind: 'r', keyText: true, valueText: true, valueNotNull: true, rls: false, uniqueKey: true, select: true },
    });
    expect(gateRefusal(list)).toBeNull();
  });

  it('checks privileges only on relations of the kind the bot made', () => {
    const refusal = gateRefusal(found({
      dbCreate: false,
      relations: [held('guild_data', 'r', { select: false, insert: false, update: false, delete: false })],
    }));
    expect(refusal?.lines).toEqual(["this bot's database role bot lacks CREATE on database botdb"]);
  });
});

describe('ri1: the catalog reader', () => {
  it('keeps a text the catalog gives and reads a NULL or absent one as null', async () => {
    const answers: Array<Array<Record<string, unknown>>> = [
      [{ name: 'meta', kind: 'r', persistence: 'p', is_partition: false, access_method: 'heap', partition_key: null }],
      [], [], [],
    ];
    let call = 0;
    const cat = await readCatalog({ query: async () => ({ rows: answers[call++] }) }, 'smdb_data');
    const r = cat.relations[0];
    expect(r.accessMethod).toBe('heap');
    expect(r.partitionKey).toBeNull();
    expect(r.bound).toBeNull();
    expect(r.indexDef).toBeNull();
  });
});
