import { describe, expect, it } from 'vitest';

import {
  compareShapes,
  encodingRefusal,
  freshPrivilegeRefusal,
  freshRefusal,
  gateRefusal,
  privilegeDifference,
  refusalLogLines,
  relationPrivileges,
  shapeRefusal,
  sortDifferences,
  substituteScratch,
  unversionedRefusal,
  type Catalog,
  type CatalogColumn,
  type CatalogRelation,
  type Difference,
  type FoundList,
  type FoundRelation,
} from '../../src/bot/internalSetup/utils/dataBackends/storeShape';
import { SCHEMA_VERSION } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';

// NB16 sheet section 8 item 1: the pure comparer, the sentences of section 3, their order, the modes and the texts.

const ROLE = 'smdb_bot';
const DB = 'smdb';
const SEQ = { increment: '1', min: '1', max: '9223372036854775807', cache: '1', cycle: false };

function rel(name: string, kind: CatalogRelation['kind'], extra: Partial<CatalogRelation> = {}): CatalogRelation {
  return {
    name, kind, persistence: 'p', isPartition: false, rls: false, forceRls: false,
    accessMethod: kind === 'r' || kind === 'm' ? 'heap' : null, partitionKey: null, bound: null, parent: null,
    inherits: [], indexDef: null, indexValid: null, indexTable: null, sequence: null, ...extra,
  };
}

function idx(name: string, table: string, def: string, kind: 'i' | 'I' = 'i'): CatalogRelation {
  return rel(name, kind, { indexDef: def, indexValid: true, indexTable: table });
}

function col(relName: string, name: string, type: string, notNull: boolean, extra: Partial<CatalogColumn> = {}): CatalogColumn {
  return {
    rel: relName, name, type, notNull, defaultExpr: null, identity: '', generated: '', generatedExpr: null,
    collation: type === 'text' ? '"default"' : null, storage: type === 'text' ? 'x' : 'p', notNullValidated: null, ...extra,
  };
}

function reference(schema = 'smdb_data'): Catalog {
  const q = (s: string) => `${schema}.${s}`;
  const relations: CatalogRelation[] = [
    rel('meta', 'r'),
    idx('meta_pkey', 'meta', `CREATE UNIQUE INDEX meta_pkey ON ${q('meta')} USING btree (key)`),
    rel('claim_seq', 'S', { sequence: { ...SEQ } }),
    rel('guild_append_seq', 'S', { sequence: { ...SEQ } }),
    rel('claim_clock', 'r'),
    idx('claim_clock_pkey', 'claim_clock', `CREATE UNIQUE INDEX claim_clock_pkey ON ${q('claim_clock')} USING btree (id)`),
    rel('guild_data', 'p', { partitionKey: 'HASH (guild_id)' }),
    idx('guild_data_pkey', 'guild_data', `CREATE UNIQUE INDEX guild_data_pkey ON ONLY ${q('guild_data')} USING btree (guild_id, module, filename)`, 'I'),
    rel('guild_data_p00', 'r', { isPartition: true, parent: q('guild_data'), bound: 'FOR VALUES WITH (modulus 32, remainder 0)' }),
    // The reader gives a partition's index the parent index it is attached to, as pg_inherits holds it.
    { ...idx('guild_data_p00_pkey', 'guild_data_p00', `CREATE UNIQUE INDEX guild_data_p00_pkey ON ${q('guild_data_p00')} USING btree (guild_id, module, filename)`), isPartition: true, parent: q('guild_data_pkey') },
    rel('guild_append', 'p', { partitionKey: 'HASH (guild_id)' }),
    idx('guild_append_pkey', 'guild_append', `CREATE UNIQUE INDEX guild_append_pkey ON ONLY ${q('guild_append')} USING btree (guild_id, seq)`, 'I'),
    rel('guild_data_graveyard', 'r'),
    idx('guild_data_graveyard_pkey', 'guild_data_graveyard', `CREATE UNIQUE INDEX guild_data_graveyard_pkey ON ${q('guild_data_graveyard')} USING btree (guild_id, retired_at)`),
    idx('guild_graveyard_ttl_idx', 'guild_data_graveyard', `CREATE INDEX guild_graveyard_ttl_idx ON ${q('guild_data_graveyard')} USING btree (retired_at)`),
    rel('shard_nodes', 'r'),
    idx('shard_nodes_pkey', 'shard_nodes', `CREATE UNIQUE INDEX shard_nodes_pkey ON ${q('shard_nodes')} USING btree (node_id)`),
  ];
  const columns: CatalogColumn[] = [
    col('meta', 'key', 'text', true),
    col('meta', 'value', 'text', true),
    col('meta', 'updated_at', 'timestamp with time zone', true, { defaultExpr: 'now()' }),
    col('claim_clock', 'id', 'integer', true),
    col('claim_clock', 'up_ms', 'bigint', true),
    col('claim_clock', 'last_gap_ms', 'bigint', true, { defaultExpr: '0' }),
    ...['guild_data', 'guild_data_p00'].flatMap(t => ['guild_id', 'module', 'filename', 'doc'].map(c => col(t, c, 'text', true))),
    col('guild_append', 'guild_id', 'text', true),
    col('guild_append', 'seq', 'bigint', true, { defaultExpr: `nextval('${q('guild_append_seq')}'::regclass)` }),
    col('guild_append', 'chunk', 'text', true),
    ...['guild_id', 'kind', 'doc', 'reason'].map(c => col('guild_data_graveyard', c, 'text', true)),
    col('guild_data_graveyard', 'retired_at', 'bigint', true),
    col('shard_nodes', 'node_id', 'text', true),
    col('shard_nodes', 'healthy_since', 'timestamp with time zone', false),
  ];
  const constraints = [
    { rel: 'meta', name: 'meta_pkey', type: 'p', def: 'PRIMARY KEY (key)', validated: true },
    { rel: 'claim_clock', name: 'claim_clock_pkey', type: 'p', def: 'PRIMARY KEY (id)', validated: true },
    { rel: 'claim_clock', name: 'claim_clock_id_check', type: 'c', def: 'CHECK ((id = 1))', validated: true },
    { rel: 'guild_data', name: 'guild_data_pkey', type: 'p', def: 'PRIMARY KEY (guild_id, module, filename)', validated: true },
    { rel: 'guild_data_p00', name: 'guild_data_p00_pkey', type: 'p', def: 'PRIMARY KEY (guild_id, module, filename)', validated: true },
    { rel: 'guild_append', name: 'guild_append_pkey', type: 'p', def: 'PRIMARY KEY (guild_id, seq)', validated: true },
    { rel: 'guild_data_graveyard', name: 'guild_data_graveyard_pkey', type: 'p', def: 'PRIMARY KEY (guild_id, retired_at)', validated: true },
    { rel: 'guild_data_graveyard', name: 'guild_data_graveyard_kind_check', type: 'c', def: "CHECK ((kind = ANY (ARRAY['doc'::text, 'append'::text])))", validated: true },
    { rel: 'shard_nodes', name: 'shard_nodes_pkey', type: 'p', def: 'PRIMARY KEY (node_id)', validated: true },
  ];
  return { relations, columns, constraints, rules: [] };
}

const clone = (c: Catalog): Catalog => JSON.parse(JSON.stringify(c)) as Catalog;
const relOf = (c: Catalog, name: string) => c.relations.find(r => r.name === name)!;
const colOf = (c: Catalog, table: string, name: string) => c.columns.find(x => x.rel === table && x.name === name)!;
const texts = (d: Difference[]) => d.map(x => x.text);
const diff = (found: Catalog, mode: 'provisioned' | 'unversioned' = 'provisioned') => compareShapes(found, reference(), mode);

function foundRel(name: string, kind: string, extra: Partial<FoundRelation> = {}): FoundRelation {
  const table = ['r', 'p', 'v', 'm', 'f'].includes(kind);
  const seq = kind === 'S';
  return {
    name, kind, isPartition: false,
    select: table ? true : null, insert: table ? true : null, update: table ? true : null, delete: table ? true : null,
    usage: seq ? true : null, updateSeq: seq ? true : null, ...extra,
  } as FoundRelation;
}

function foundList(relations: FoundRelation[], extra: Partial<FoundList> = {}): FoundList {
  return {
    role: ROLE, db: DB, dbCreate: true, schemaExists: true, schemaUsage: true, schemaCreate: true,
    relations, meta: null, ...extra,
  };
}

const allFound = () => foundList(reference().relations.map(r => foundRel(r.name, r.kind, { isPartition: r.isPartition })));

describe('two equal shapes', () => {
  it('give no difference', () => {
    expect(texts(diff(reference()).differences)).toEqual([]);
  });
});

type Case = [string, (c: Catalog) => void, string];
const cases: Case[] = [
  ['a missing relation', c => { c.relations = c.relations.filter(r => r.name !== 'guild_append_seq'); },
    'smdb_data.guild_append_seq (sequence) is missing'],
  ['an extra relation', c => { c.relations.push(rel('x', 'r')); },
    "smdb_data.x (table) is not part of this bot's schema"],
  ['another kind', c => { relOf(c, 'meta').kind = 'v'; relOf(c, 'meta').accessMethod = null; },
    "smdb_data.meta is a view, where this bot's schema has a table"],
  ['a dropped column', c => { c.columns = c.columns.filter(x => !(x.rel === 'claim_clock' && x.name === 'up_ms')); },
    'smdb_data.claim_clock has no column up_ms (bigint NOT NULL)'],
  ['a dropped nullable column', c => { c.columns = c.columns.filter(x => !(x.rel === 'shard_nodes' && x.name === 'healthy_since')); },
    'smdb_data.shard_nodes has no column healthy_since (timestamp with time zone)'],
  ['an extra column', c => { c.columns.push(col('claim_clock', 'x', 'integer', false)); },
    "smdb_data.claim_clock has column x (integer), which this bot's schema does not have"],
  ['a retyped column', c => { colOf(c, 'meta', 'value').type = 'jsonb'; colOf(c, 'meta', 'value').collation = null; },
    "smdb_data.meta column value is jsonb, where this bot's schema has text"],
  ['NOT NULL dropped', c => { colOf(c, 'guild_data_graveyard', 'reason').notNull = false; },
    "smdb_data.guild_data_graveyard column reason allows NULL, where this bot's schema has NOT NULL"],
  ['NOT NULL added', c => { colOf(c, 'shard_nodes', 'healthy_since').notNull = true; },
    "smdb_data.shard_nodes column healthy_since is NOT NULL, where this bot's schema allows NULL"],
  ['a default dropped', c => { colOf(c, 'meta', 'updated_at').defaultExpr = null; },
    "smdb_data.meta column updated_at has no default, where this bot's schema has default now()"],
  ['a default added', c => { colOf(c, 'shard_nodes', 'healthy_since').defaultExpr = 'now()'; },
    "smdb_data.shard_nodes column healthy_since has default now(), where this bot's schema has no default"],
  ['an identity column', c => { colOf(c, 'claim_clock', 'up_ms').identity = 'a'; },
    "smdb_data.claim_clock column up_ms is an identity column, where this bot's schema has a plain column"],
  ['a generated column', c => { Object.assign(colOf(c, 'guild_data_graveyard', 'reason'), { generated: 's', generatedExpr: "'x'::text" }); },
    "smdb_data.guild_data_graveyard column reason is a generated column ('x'::text), where this bot's schema has a plain column"],
  ['a collation', c => { colOf(c, 'guild_data', 'module').collation = '"C"'; },
    `smdb_data.guild_data column module uses collation "C", where this bot's schema uses "default"`],
  ['a column storage', c => { colOf(c, 'guild_data_graveyard', 'doc').storage = 'p'; },
    "smdb_data.guild_data_graveyard column doc has storage PLAIN, where this bot's schema has EXTENDED"],
  ['an access method', c => { relOf(c, 'claim_clock').accessMethod = 'heap2'; },
    "smdb_data.claim_clock uses access method heap2, where this bot's schema uses heap"],
  ['a constraint dropped', c => { c.constraints = c.constraints.filter(x => x.name !== 'claim_clock_id_check'); },
    "smdb_data.claim_clock lacks constraint claim_clock_id_check (CHECK ((id = 1)))"],
  ['a constraint added', c => { c.constraints.push({ rel: 'shard_nodes', name: 'extra', type: 'u', def: 'UNIQUE (healthy_since)', validated: true }); },
    "smdb_data.shard_nodes has constraint extra (UNIQUE (healthy_since)), which this bot's schema does not have"],
  ['a constraint changed', c => { c.constraints.find(x => x.name === 'claim_clock_id_check')!.def = 'CHECK ((id = 2))'; },
    "smdb_data.claim_clock constraint claim_clock_id_check is CHECK ((id = 2)), where this bot's schema has CHECK ((id = 1))"],
  ['a constraint not validated', c => { c.constraints.find(x => x.name === 'claim_clock_id_check')!.validated = false; },
    "smdb_data.claim_clock constraint claim_clock_id_check is CHECK ((id = 1)) NOT VALID, where this bot's schema has CHECK ((id = 1))"],
  ['an index definition', c => { relOf(c, 'guild_graveyard_ttl_idx').indexDef = 'CREATE INDEX guild_graveyard_ttl_idx ON smdb_data.guild_data_graveyard USING hash (retired_at)'; },
    "smdb_data.guild_graveyard_ttl_idx is CREATE INDEX guild_graveyard_ttl_idx ON smdb_data.guild_data_graveyard USING hash (retired_at), where this bot's schema has CREATE INDEX guild_graveyard_ttl_idx ON smdb_data.guild_data_graveyard USING btree (retired_at)"],
  ['an invalid index', c => { relOf(c, 'guild_graveyard_ttl_idx').indexValid = false; },
    'smdb_data.guild_graveyard_ttl_idx is not valid, so Postgres does not use it to enforce or search'],
  ['an UNLOGGED table', c => { relOf(c, 'claim_clock').persistence = 'u'; },
    "smdb_data.claim_clock is UNLOGGED, where this bot's schema has it logged"],
  ['an UNLOGGED table with its index', c => { relOf(c, 'claim_clock').persistence = 'u'; relOf(c, 'claim_clock_pkey').persistence = 'u'; },
    "smdb_data.claim_clock is UNLOGGED, where this bot's schema has it logged"],
  ['an UNLOGGED sequence', c => { relOf(c, 'claim_seq').persistence = 'u'; },
    "smdb_data.claim_seq is UNLOGGED, where this bot's schema has it logged"],
  ['a partitioned table made plain', c => { Object.assign(relOf(c, 'guild_append'), { kind: 'r', partitionKey: null, accessMethod: 'heap' }); },
    "smdb_data.guild_append is a table, where this bot's schema has a partitioned table"],
  ['a partition key', c => { relOf(c, 'guild_data').partitionKey = 'HASH (module)'; },
    "smdb_data.guild_data is partitioned by HASH (module), where this bot's schema has it partitioned by HASH (guild_id)"],
  ['a partition detached', c => { Object.assign(relOf(c, 'guild_data_p00'), { isPartition: false, parent: null, bound: null }); },
    "smdb_data.guild_data_p00 is not a partition, where this bot's schema has a partition of smdb_data.guild_data FOR VALUES WITH (modulus 32, remainder 0)"],
  ['a table attached as a partition', c => { Object.assign(relOf(c, 'guild_data_graveyard'), { isPartition: true, parent: 'smdb_data.guild_data', bound: 'FOR VALUES WITH (modulus 32, remainder 6)' }); },
    "smdb_data.guild_data_graveyard is a partition of smdb_data.guild_data FOR VALUES WITH (modulus 32, remainder 6), where this bot's schema has a table that is not a partition"],
  ['a partition with another bound', c => { relOf(c, 'guild_data_p00').bound = 'FOR VALUES WITH (modulus 32, remainder 6)'; },
    "smdb_data.guild_data_p00 is a partition of smdb_data.guild_data FOR VALUES WITH (modulus 32, remainder 6), where this bot's schema has a partition of smdb_data.guild_data FOR VALUES WITH (modulus 32, remainder 0)"],
  ['a partition of another parent', c => { relOf(c, 'guild_data_p00').parent = 'smdb_data.guild_append'; },
    "smdb_data.guild_data_p00 is a partition of smdb_data.guild_append FOR VALUES WITH (modulus 32, remainder 0), where this bot's schema has a partition of smdb_data.guild_data FOR VALUES WITH (modulus 32, remainder 0)"],
  ['an inheritance parent', c => { relOf(c, 'shard_nodes').inherits = ['public.p']; },
    "smdb_data.shard_nodes inherits from public.p, where this bot's schema has no parent"],
  ['row level security on', c => { relOf(c, 'guild_data').rls = true; },
    "smdb_data.guild_data has row level security on, where this bot's schema has it off"],
  ['row level security on and forced', c => { Object.assign(relOf(c, 'guild_data'), { rls: true, forceRls: true }); },
    "smdb_data.guild_data has row level security on and forced, where this bot's schema has it off"],
  ['row level security forced only', c => { relOf(c, 'claim_clock').forceRls = true; },
    "smdb_data.claim_clock has row level security forced but not enabled, where this bot's schema has it off"],
  ['an extra trigger', c => { c.rules.push({ rel: 'guild_data_p00', what: 'trigger', name: 't', def: 'CREATE TRIGGER t BEFORE INSERT ON smdb_data.guild_data_p00 FOR EACH ROW EXECUTE FUNCTION public.f()' }); },
    "smdb_data.guild_data_p00 has trigger t (CREATE TRIGGER t BEFORE INSERT ON smdb_data.guild_data_p00 FOR EACH ROW EXECUTE FUNCTION public.f()), which this bot's schema does not have"],
  ['an extra rule', c => { c.rules.push({ rel: 'guild_data_graveyard', what: 'rule', name: 'r', def: 'CREATE RULE r AS ON INSERT TO smdb_data.guild_data_graveyard DO INSTEAD NOTHING;' }); },
    "smdb_data.guild_data_graveyard has rule r (CREATE RULE r AS ON INSERT TO smdb_data.guild_data_graveyard DO INSTEAD NOTHING;), which this bot's schema does not have"],
  ['an extra policy', c => { c.rules.push({ rel: 'guild_data', what: 'policy', name: 'p', def: 'AS PERMISSIVE FOR ALL TO public USING (false)' }); },
    "smdb_data.guild_data has policy p (AS PERMISSIVE FOR ALL TO public USING (false)), which this bot's schema does not have"],
  ['a sequence cache', c => { relOf(c, 'claim_seq').sequence!.cache = '20'; },
    "sequence smdb_data.claim_seq has cache 20, where this bot's schema has 1"],
  ['a sequence increment', c => { relOf(c, 'claim_seq').sequence!.increment = '-1'; },
    "sequence smdb_data.claim_seq has increment -1, where this bot's schema has 1"],
  ['a sequence maximum', c => { relOf(c, 'claim_seq').sequence!.max = '100'; },
    "sequence smdb_data.claim_seq has maximum 100, where this bot's schema has 9223372036854775807"],
  ['a sequence minimum', c => { relOf(c, 'claim_seq').sequence!.min = '0'; },
    "sequence smdb_data.claim_seq has minimum 0, where this bot's schema has 1"],
  ['a sequence cycle', c => { relOf(c, 'claim_seq').sequence!.cycle = true; },
    "sequence smdb_data.claim_seq has cycle on, where this bot's schema has off"],
];

describe('each sentence of section 3', () => {
  it.each(cases)('%s', (_name, change, sentence) => {
    const found = clone(reference());
    change(found);
    expect(texts(diff(found).differences)).toEqual([sentence]);
  });

  it('a trigger, rule or policy the store lacks or changed', () => {
    const ref = reference();
    ref.rules.push({ rel: 'meta', what: 'trigger', name: 't', def: 'CREATE TRIGGER t A' });
    const lacking = clone(ref);
    lacking.rules = [];
    expect(texts(compareShapes(lacking, ref, 'provisioned').differences)).toEqual(['smdb_data.meta lacks trigger t (CREATE TRIGGER t A)']);
    const changed = clone(ref);
    changed.rules[0].def = 'CREATE TRIGGER t B';
    expect(texts(compareShapes(changed, ref, 'provisioned').differences)).toEqual(["smdb_data.meta trigger t is CREATE TRIGGER t B, where this bot's schema has CREATE TRIGGER t A"]);
  });

  it.each([
    [{ scope: 'database', target: DB, privilege: 'CREATE' }, `this bot's database role ${ROLE} lacks CREATE on database ${DB}`],
    [{ scope: 'schema', target: 'smdb_data', privilege: 'USAGE' }, `this bot's database role ${ROLE} lacks USAGE on schema smdb_data`],
    [{ scope: 'schema', target: 'smdb_data', privilege: 'CREATE' }, `this bot's database role ${ROLE} lacks CREATE on schema smdb_data`],
    [{ scope: 'table', target: 'guild_data', privilege: 'INSERT' }, `this bot's database role ${ROLE} lacks INSERT on smdb_data.guild_data`],
    [{ scope: 'sequence', target: 'claim_seq', privilege: 'UPDATE' }, `this bot's database role ${ROLE} lacks UPDATE on sequence smdb_data.claim_seq`],
  ] as const)('the privilege sentence %j', (p, sentence) => {
    expect(privilegeDifference(ROLE, DB, p).text).toBe(sentence);
  });
});

describe('the order of the differences', () => {
  it('privileges first, then by relation name, aspect order and name', () => {
    const found = clone(reference());
    colOf(found, 'meta', 'value').notNull = false;
    colOf(found, 'meta', 'key').type = 'varchar(10)';
    colOf(found, 'meta', 'key').collation = '"default"';
    relOf(found, 'claim_clock').persistence = 'u';
    found.columns.push(col('claim_clock', 'a', 'integer', false));
    found.constraints = found.constraints.filter(x => x.name !== 'guild_data_graveyard_kind_check');
    const shapes = compareShapes(found, reference(), 'provisioned').differences;
    const privileges = [
      privilegeDifference(ROLE, DB, { scope: 'table', target: 'meta', privilege: 'DELETE' }),
      privilegeDifference(ROLE, DB, { scope: 'table', target: 'guild_data', privilege: 'UPDATE' }),
      privilegeDifference(ROLE, DB, { scope: 'table', target: 'guild_data', privilege: 'SELECT' }),
      privilegeDifference(ROLE, DB, { scope: 'schema', target: 'smdb_data', privilege: 'USAGE' }),
      privilegeDifference(ROLE, DB, { scope: 'database', target: DB, privilege: 'CREATE' }),
    ];
    expect(texts(sortDifferences([...shapes.slice().reverse(), ...privileges]))).toEqual([
      `this bot's database role ${ROLE} lacks CREATE on database ${DB}`,
      `this bot's database role ${ROLE} lacks USAGE on schema smdb_data`,
      `this bot's database role ${ROLE} lacks SELECT on smdb_data.guild_data`,
      `this bot's database role ${ROLE} lacks UPDATE on smdb_data.guild_data`,
      `this bot's database role ${ROLE} lacks DELETE on smdb_data.meta`,
      "smdb_data.claim_clock is UNLOGGED, where this bot's schema has it logged",
      "smdb_data.claim_clock has column a (integer), which this bot's schema does not have",
      "smdb_data.guild_data_graveyard lacks constraint guild_data_graveyard_kind_check (CHECK ((kind = ANY (ARRAY['doc'::text, 'append'::text]))))",
      "smdb_data.meta column key is varchar(10), where this bot's schema has text",
      "smdb_data.meta column value allows NULL, where this bot's schema has NOT NULL",
    ]);
  });
});

describe('the scratch name', () => {
  it('a reference default naming the scratch equals the found one naming smdb_data', () => {
    const ref = substituteScratch(reference('smdb_shape_0123456789ab'), 'smdb_shape_0123456789ab');
    expect(colOf(ref, 'guild_append', 'seq').defaultExpr).toBe("nextval('smdb_data.guild_append_seq'::regclass)");
    expect(texts(compareShapes(reference(), ref, 'provisioned').differences)).toEqual([]);
  });

  it('a found default naming another schema differs', () => {
    const ref = substituteScratch(reference('smdb_shape_0123456789ab'), 'smdb_shape_0123456789ab');
    const found = reference();
    colOf(found, 'guild_append', 'seq').defaultExpr = "nextval('public.guild_append_seq'::regclass)";
    expect(texts(compareShapes(found, ref, 'provisioned').differences)).toEqual([
      "smdb_data.guild_append column seq has default nextval('public.guild_append_seq'::regclass), where this bot's schema has default nextval('smdb_data.guild_append_seq'::regclass)",
    ]);
  });
});

describe('NOT NULL constraints', () => {
  it('a contype n row on one side only gives no difference', () => {
    const found = reference();
    colOf(found, 'meta', 'value').notNullValidated = true;
    expect(texts(diff(found).differences)).toEqual([]);
  });

  it('one not validated where the reference has it validated gives the NOT VALID sentence', () => {
    const ref = reference();
    colOf(ref, 'meta', 'value').notNullValidated = true;
    const found = clone(ref);
    colOf(found, 'meta', 'value').notNullValidated = false;
    expect(texts(compareShapes(found, ref, 'provisioned').differences)).toEqual([
      "smdb_data.meta column value has NOT NULL NOT VALID, where this bot's schema has it validated",
    ]);
  });
});

function only(names: string[]): Catalog {
  const ref = reference();
  return {
    relations: ref.relations.filter(r => names.includes(r.name)),
    columns: ref.columns.filter(c => names.includes(c.rel)),
    constraints: ref.constraints.filter(c => names.includes(c.rel)),
    rules: [],
  };
}

describe('the modes', () => {
  it('provisioned: every missing reference relation is listed', () => {
    const found = only(['meta', 'meta_pkey']);
    const result = compareShapes(found, reference(), 'provisioned');
    expect(result.differences).toHaveLength(15);
    expect(result.counted).toBe(0);
  });

  it('unversioned: a store of meta and meta_pkey lists nothing and counts the rest', () => {
    const result = compareShapes(only(['meta', 'meta_pkey']), reference(), 'unversioned');
    expect(texts(result.differences)).toEqual([]);
    expect(result.counted).toBe(15);
    expect(result.total).toBe(17);
  });

  it('unversioned: a meta without meta_pkey lists the constraint and the index', () => {
    const found = only(['meta']);
    found.constraints = [];
    expect(texts(compareShapes(found, reference(), 'unversioned').differences)).toEqual([
      'smdb_data.meta lacks constraint meta_pkey (PRIMARY KEY (key))',
      'smdb_data.meta_pkey (index) is missing',
    ]);
  });

  it('unversioned: a view meta without meta_pkey lists the constraint and the index too', () => {
    const found = only(['meta']);
    found.constraints = [];
    Object.assign(found.relations[0], { kind: 'v', accessMethod: null });
    expect(texts(compareShapes(found, reference(), 'unversioned').differences)).toEqual([
      "smdb_data.meta is a view, where this bot's schema has a table",
      'smdb_data.meta lacks constraint meta_pkey (PRIMARY KEY (key))',
      'smdb_data.meta_pkey (index) is missing',
    ]);
  });

  it('unversioned: a held partitioned table lists its missing partitions and counts their indexes (row 11)', () => {
    const found = only(['guild_data', 'guild_data_pkey']);
    const result = compareShapes(found, reference(), 'unversioned');
    expect(texts(result.differences)).toEqual(['smdb_data.guild_data_p00 (table) is missing']);
    expect(result.counted).toBe(14);
  });
});

function graveyardExample() {
  const found = only(['guild_data_graveyard', 'guild_data_graveyard_pkey', 'guild_graveyard_ttl_idx']);
  colOf(found, 'guild_data_graveyard', 'reason').notNull = false;
  const list = foundList([
    foundRel('guild_data_graveyard', 'r'), foundRel('guild_data_graveyard_pkey', 'i'), foundRel('guild_graveyard_ttl_idx', 'i'),
  ]);
  return { found, list };
}

describe('decision 5 texts', () => {
  it("section 3's example: the header, the line and the reason are exact", () => {
    const { found, list } = graveyardExample();
    const result = compareShapes(found, reference(), 'unversioned');
    const refusal = unversionedRefusal(list, result);
    expect(refusalLogLines(refusal)).toEqual([
      "[PostgresBackend] schema-mismatch: smdb_data holds 3 object(s) but no schema_version, so this bot can't confirm what made them or that they are complete (a provisioning or restore that did not finish, or another program); refusing to serve",
      "[PostgresBackend] schema difference: smdb_data.guild_data_graveyard column reason allows NULL, where this bot's schema has NOT NULL",
    ]);
    expect(refusal.reason).toBe("the database's smdb_data holds objects but no schema_version, so this bot can't confirm what made them or that they are complete: smdb_data.guild_data_graveyard (table); compared with this bot's schema: smdb_data.guild_data_graveyard column reason allows NULL, where this bot's schema has NOT NULL");
  });

  it('the absent version fix names the rename; the unreadable one names meta and no RENAME', () => {
    const { found, list } = graveyardExample();
    const result = compareShapes(found, reference(), 'unversioned');
    const absent = unversionedRefusal(list, result);
    const unreadable = unversionedRefusal(list, result, 'smdb_data.meta has no text column value');
    expect(absent.fix).toBe('Gates stay closed and nothing in the database was changed; point DATA_BACKEND_URL at a database without the schema smdb_data, or at one this bot provisioned, in the web UI env editor, or rename smdb_data aside in the database (ALTER SCHEMA smdb_data RENAME TO ...) and restart the bot');
    expect(unreadable.fix).toBe("Gates stay closed and nothing in the database was changed; smdb_data.meta is this bot's version table: correct it to the shape the difference lines give (key text, value text NOT NULL, its primary key meta_pkey, row level security off) and restart the bot; do not rename smdb_data aside while its tables hold this bot's data, since the next boot would then make and serve a new, empty store and leave every row in the renamed schema");
    expect(unreadable.fix).not.toContain('RENAME');
    expect(unreadable.header).toBe("schema-mismatch: smdb_data holds 3 object(s) and its schema_version can't be read (smdb_data.meta has no text column value), so this bot can't confirm what made them or that they are complete; refusing to serve");
    expect(unreadable.reason.startsWith("the database's smdb_data holds objects and its schema_version can't be read (smdb_data.meta has no text column value), so this bot can't confirm what made them or that they are complete: smdb_data.guild_data_graveyard (table); compared with")).toBe(true);
  });

  it("row 10's shapes: they match, with the count of the objects not there", () => {
    const result = compareShapes(only(['meta', 'meta_pkey']), reference(), 'unversioned');
    const refusal = unversionedRefusal(foundList([foundRel('meta', 'r'), foundRel('meta_pkey', 'i')]), result);
    expect(refusal.reason).toBe("the database's smdb_data holds objects but no schema_version, so this bot can't confirm what made them or that they are complete: smdb_data.meta (table); they match their counterparts in this bot's schema (15 of its 17 objects are not there), but the bot does not take over a schema without a version");
    expect(refusal.header).toContain('smdb_data holds 2 object(s) but no schema_version');
    expect(refusalLogLines(refusal)).toHaveLength(1);
  });

  it("row 9's shapes: they match, with no parenthesis", () => {
    const ref = reference();
    const result = compareShapes(ref, ref, 'unversioned');
    const refusal = unversionedRefusal(foundList(ref.relations.map(r => foundRel(r.name, r.kind))), result);
    expect(refusal.reason).toBe("the database's smdb_data holds objects but no schema_version, so this bot can't confirm what made them or that they are complete: smdb_data.claim_clock (table), smdb_data.claim_seq (sequence), smdb_data.guild_append (partitioned table), smdb_data.guild_append_seq (sequence), smdb_data.guild_data (partitioned table) and 4 more; they match their counterparts in this bot's schema, but the bot does not take over a schema without a version");
  });
});

function manyDifferences(n: number): Difference[] {
  const found = clone(reference());
  for (let i = 0; i < n; i++) found.relations.push(rel(`x${String(i).padStart(2, '0')}`, 'r'));
  return compareShapes(found, reference(), 'provisioned').differences;
}

describe('the reason and the log caps', () => {
  it('7 differences give 5 in the reason and the count of the rest', () => {
    const refusal = shapeRefusal(manyDifferences(7));
    expect(refusal.reason).toBe(`the database's smdb_data differs from this bot's schema (version ${SCHEMA_VERSION}): smdb_data.x00 (table) is not part of this bot's schema; smdb_data.x01 (table) is not part of this bot's schema; smdb_data.x02 (table) is not part of this bot's schema; smdb_data.x03 (table) is not part of this bot's schema; smdb_data.x04 (table) is not part of this bot's schema; and 2 more (the bot's log lists them)`);
    expect(refusal.header).toBe(`schema-mismatch: smdb_data differs from this bot's schema (version ${SCHEMA_VERSION}) in 7 place(s); refusing to serve`);
  });

  it('60 differences give 50 log lines and the count of the rest', () => {
    const lines = refusalLogLines(shapeRefusal(manyDifferences(60)));
    expect(lines).toHaveLength(52);
    expect(lines.filter(l => l.startsWith('[PostgresBackend] schema difference: smdb_data.x'))).toHaveLength(50);
    expect(lines[51]).toBe('[PostgresBackend] schema difference: and 10 more not listed');
  });

  it('the no-version reason lists at most 5 names, leaving indexes out', () => {
    const list = foundList(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(n => foundRel(n, 'r')).concat([foundRel('a_idx', 'i')]));
    const result = compareShapes({ relations: [], columns: [], constraints: [], rules: [] }, { relations: [], columns: [], constraints: [], rules: [] }, 'unversioned');
    const refusal = unversionedRefusal(list, result);
    expect(refusal.reason).toContain(': smdb_data.a (table), smdb_data.b (table), smdb_data.c (table), smdb_data.d (table), smdb_data.e (table) and 2 more;');
    expect(refusal.header).toContain('holds 8 object(s)');
  });
});

describe('the fix line of a provisioned store', () => {
  const base = "Gates stay closed and nothing in the database was changed; point DATA_BACKEND_URL at a database whose smdb_data matches this bot's schema in the web UI env editor, or correct the differences above in the database and restart the bot";
  const restore = "; a table or partition reported missing may have held data that is not in this database: restore a backup (the manager's Database window) rather than creating it empty";

  it('ends with the restore clause when a table or partition is missing', () => {
    const found = clone(reference());
    found.relations = found.relations.filter(r => r.name !== 'guild_data_p00');
    expect(shapeRefusal(diff(found).differences).fix).toBe(base + restore);
  });

  it('has no restore clause when only an index is missing', () => {
    const found = clone(reference());
    found.relations = found.relations.filter(r => r.name !== 'guild_graveyard_ttl_idx');
    expect(shapeRefusal(diff(found).differences).fix).toBe(base);
  });

  it('a shape difference with privilege lines: the shape header, the privileges first, the GRANT clause', () => {
    const found = clone(reference());
    found.relations = found.relations.filter(r => r.name !== 'guild_data_p00');
    const list = allFound();
    list.relations.find(r => r.name === 'guild_data')!.insert = false;
    const privileges = relationPrivileges(list, reference().relations);
    const refusal = shapeRefusal(sortDifferences([...diff(found).differences, ...privileges]));
    expect(refusal.header).toBe(`schema-mismatch: smdb_data differs from this bot's schema (version ${SCHEMA_VERSION}) in 2 place(s); refusing to serve`);
    expect(refusal.lines[0]).toBe(`this bot's database role ${ROLE} lacks INSERT on smdb_data.guild_data`);
    expect(refusal.fix).toBe(`${base}; and, as the owner of smdb_data's tables and sequences or a superuser, run GRANT INSERT ON smdb_data.guild_data TO ${ROLE}${restore}`);
    expect(refusal.fix).not.toMatch(/\bsee\b|\bbelow\b/);
  });

  it('a missing reference relation gets an "is missing" sentence and no privilege line', () => {
    const list = allFound();
    list.relations = list.relations.filter(r => r.name !== 'claim_seq');
    expect(relationPrivileges(list, reference().relations)).toEqual([]);
  });
});

describe('the privilege texts', () => {
  const tail = ', or point DATA_BACKEND_URL, in the web UI env editor, at a login that holds these privileges, then restart the bot';

  it('the right-shape header, reason and fix', () => {
    const list = allFound();
    list.relations.find(r => r.name === 'guild_data')!.insert = false;
    const refusal = shapeRefusal(relationPrivileges(list, reference().relations));
    expect(refusal.header).toBe(`schema-mismatch: this bot's database role ${ROLE} lacks 1 privilege(s) on smdb_data; smdb_data matches this bot's schema (version ${SCHEMA_VERSION}); refusing to serve`);
    expect(refusal.reason).toBe(`this bot's database role ${ROLE} lacks privileges on smdb_data, which matches this bot's schema (version ${SCHEMA_VERSION}): this bot's database role ${ROLE} lacks INSERT on smdb_data.guild_data`);
    expect(refusal.fix).toBe(`Gates stay closed and nothing in the database was changed; as the owner of smdb_data's tables and sequences or a superuser, run GRANT INSERT ON smdb_data.guild_data TO ${ROLE}${tail}`);
    for (const t of [refusal.header, refusal.reason, refusal.fix]) {
      expect(t).not.toContain('RENAME');
      expect(t).not.toContain('differs from this bot\'s schema');
    }
  });

  it('the gate: CREATE on the database alone (row 66, both halves)', () => {
    const fresh = gateRefusal(foundList([], { dbCreate: false, schemaExists: false, schemaUsage: null, schemaCreate: null }));
    expect(fresh!.header).toBe(`schema-mismatch: this bot's database role ${ROLE} lacks 1 privilege(s) it needs on database ${DB}; no smdb_data exists and none was made, since without them the bot can't make a schema in database ${DB} (smdb_data, or the copy of its schema it compares with at every boot); refusing to serve`);
    expect(fresh!.lines).toEqual([`this bot's database role ${ROLE} lacks CREATE on database ${DB}`]);
    expect(fresh!.fix).toBe(`Gates stay closed and nothing in the database was changed; as the owner of database ${DB} or a superuser, run GRANT CREATE ON DATABASE ${DB} TO ${ROLE}${tail}`);
    expect(fresh!.header).not.toContain('read its schema_version');
    const store = gateRefusal({ ...allFound(), dbCreate: false });
    expect(store!.header).toBe(`schema-mismatch: this bot's database role ${ROLE} lacks 1 privilege(s) it needs on database ${DB}; the schema itself was not compared, since without them the bot can't make a schema in database ${DB} (smdb_data, or the copy of its schema it compares with at every boot); refusing to serve`);
    expect(store!.lines).toEqual(fresh!.lines);
    expect(store!.fix).toBe(fresh!.fix);
    expect(store!.reason).toBe(`this bot's database role ${ROLE} lacks privileges it needs on database ${DB}, so the schema itself was not compared: this bot's database role ${ROLE} lacks CREATE on database ${DB}`);
  });

  it("the gate: CREATE on an empty schema alone (row 65's texts)", () => {
    const refusal = gateRefusal(foundList([], { schemaCreate: false }));
    expect(refusalLogLines(refusal!)).toEqual([
      `[PostgresBackend] schema-mismatch: this bot's database role ${ROLE} lacks 1 privilege(s) it needs on smdb_data; the schema itself was not compared, since without them the bot can't make its tables in smdb_data; refusing to serve`,
      `[PostgresBackend] schema difference: this bot's database role ${ROLE} lacks CREATE on schema smdb_data`,
    ]);
    expect(refusal!.fix).toBe(`Gates stay closed and nothing in the database was changed; as the owner of smdb_data or a superuser, run GRANT CREATE ON SCHEMA smdb_data TO ${ROLE}${tail}`);
  });

  it('the gate: USAGE on the schema, INSERT on guild_data and UPDATE on claim_seq', () => {
    const list = { ...allFound(), schemaUsage: false };
    list.relations.find(r => r.name === 'guild_data')!.insert = false;
    list.relations.find(r => r.name === 'claim_seq')!.updateSeq = false;
    const refusal = gateRefusal(list)!;
    expect(refusal.header).toBe(`schema-mismatch: this bot's database role ${ROLE} lacks 3 privilege(s) it needs on smdb_data; the schema itself was not compared, since without them the bot can't read its schema_version; refusing to serve`);
    expect(refusal.fix).toBe(`Gates stay closed and nothing in the database was changed; as the owner of smdb_data or a superuser, run GRANT USAGE ON SCHEMA smdb_data TO ${ROLE}; as the owner of smdb_data's tables and sequences or a superuser, run GRANT INSERT ON smdb_data.guild_data TO ${ROLE}; GRANT UPDATE ON SEQUENCE smdb_data.claim_seq TO ${ROLE}${tail}`);
    expect(refusal.lines).toEqual([
      `this bot's database role ${ROLE} lacks USAGE on schema smdb_data`,
      `this bot's database role ${ROLE} lacks UPDATE on sequence smdb_data.claim_seq`,
      `this bot's database role ${ROLE} lacks INSERT on smdb_data.guild_data`,
    ]);
  });

  it('the gate: CREATE on the database and SELECT on meta give both reasons and both scopes', () => {
    const list = { ...allFound(), dbCreate: false };
    list.relations.find(r => r.name === 'meta')!.select = false;
    list.meta = { kind: 'r', keyText: true, valueText: true, valueNotNull: true, rls: false, uniqueKey: true, select: false };
    const refusal = gateRefusal(list)!;
    expect(refusal.header).toBe(`schema-mismatch: this bot's database role ${ROLE} lacks 2 privilege(s) it needs on database ${DB} and smdb_data; the schema itself was not compared, since without them the bot can't make a schema in database ${DB} (smdb_data, or the copy of its schema it compares with at every boot) or read its schema_version; refusing to serve`);
  });

  it('the gate passes when nothing it checks is missing', () => {
    expect(gateRefusal(allFound())).toBeNull();
  });

  it('a role name that needs quotes is quoted as an identifier', () => {
    expect(privilegeDifference('"Bot Role"', DB, { scope: 'table', target: 'meta', privilege: 'SELECT' }).text).toBe(`this bot's database role "Bot Role" lacks SELECT on smdb_data.meta`);
  });
});

describe('the fresh texts', () => {
  it('a fresh store that differed', () => {
    const found = clone(reference());
    found.rules.push({ rel: 'guild_data', what: 'trigger', name: 't', def: 'CREATE TRIGGER t' });
    const refusal = freshRefusal(diff(found).differences);
    expect(refusal.header).toBe('schema-mismatch: the schema this bot made in the database differed from this bot\'s schema before it was committed, so it was rolled back (an event trigger or another program changes tables as they are made); refusing to serve');
    expect(refusal.reason).toBe("the schema this bot made in the database differed from this bot's schema and was rolled back (an event trigger or another program changes new tables): smdb_data.guild_data has trigger t (CREATE TRIGGER t), which this bot's schema does not have");
    expect(refusal.fix).toBe('Gates stay closed and nothing in the database was changed; remove what changes new tables in that database (its event triggers are listed by SELECT evtname FROM pg_event_trigger) and restart the bot');
    for (const t of [refusal.header, refusal.reason, refusal.fix]) expect(t).not.toContain('RENAME');
  });

  it('a fresh store that lacked privileges', () => {
    const list = allFound();
    list.relations.find(r => r.name === 'guild_data')!.insert = false;
    const refusal = freshPrivilegeRefusal(ROLE, relationPrivileges(list, reference().relations));
    expect(refusal.header).toBe(`schema-mismatch: this bot's database role ${ROLE} lacked 1 privilege(s) on the schema it made in the database, so it was rolled back before it was committed (default privileges set with ALTER DEFAULT PRIVILEGES, or an event trigger, take them from new tables); refusing to serve`);
    expect(refusal.reason).toBe(`this bot's database role ${ROLE} lacked privileges on the schema it made in the database, so it was rolled back (default privileges or an event trigger take them from new tables): this bot's database role ${ROLE} lacks INSERT on smdb_data.guild_data`);
    expect(refusal.fix).toBe(`Gates stay closed and nothing in the database was changed; as ${ROLE} or a superuser, run ALTER DEFAULT PRIVILEGES FOR ROLE ${ROLE} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ROLE}; ALTER DEFAULT PRIVILEGES FOR ROLE ${ROLE} GRANT USAGE, UPDATE ON SEQUENCES TO ${ROLE} (SELECT * FROM pg_default_acl lists what is set), remove any event trigger that revokes privileges on new tables, and restart the bot`);
    for (const t of [refusal.header, refusal.reason, refusal.fix]) expect(t).not.toContain('RENAME');
  });
});

describe('the encoding texts', () => {
  it.each(['LATIN1', 'SQL_ASCII'])('%s', encoding => {
    const refusal = encodingRefusal(encoding);
    expect(refusal.reason).toBe(`the database's server_encoding is ${encoding}, and this bot needs a UTF8 database; smdb_data was not read`);
    expect(refusalLogLines(refusal)).toEqual([
      `[PostgresBackend] schema-mismatch: the database's server_encoding is ${encoding}, and this bot needs a UTF8 database; smdb_data was not read; refusing to serve`,
    ]);
    expect(refusal.fix).toBe("Gates stay closed and nothing in the database was changed; point DATA_BACKEND_URL, in the web UI env editor, at a database whose encoding is UTF8 (CREATE DATABASE <name> TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' makes one on any server), then restart the bot");
    for (const t of [refusal.header, refusal.reason, refusal.fix]) expect(t).not.toContain('RENAME');
  });
});
