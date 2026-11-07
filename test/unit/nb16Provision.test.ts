import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import * as pg from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import * as shape from '../../src/bot/internalSetup/utils/dataBackends/storeShape';
import { fixedChooser } from '../helpers/fixedDatabase';

const { PostgresBackend } = pg;

// NB16 sheet section 8 items 2 and 12: provision() against a scripted client. The client answers the lock, the server
// version, the encoding, the found list, the version read, the store id read and the catalog reads of both schemas from
// a script; every other statement answers no row.

const backends: InstanceType<typeof PostgresBackend>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const backend of backends.splice(0)) await backend.stop();
});

type Row = Record<string, unknown>;
type Which = 'relations' | 'columns' | 'constraints' | 'rules';

interface Script {
  encoding?: string;
  found?: Row | ((call: number) => Row);
  version?: Row[];
  catalog?: (schema: string, which: Which) => Row[];
  fail?: (sql: string, index: number) => Error | undefined;
  storeId?: Row[];
  versionNum?: string;
  markerStoreId?: () => string | null;
}

const LOCK = /^SELECT pg_try_advisory_xact_lock\(hashtext\('smdb_data_bootstrap'\)\) AS locked$/;
const STORE_ID = /^SELECT 1 FROM ONLY smdb_data\.meta WHERE key = 'store_id'$/;
const FOUND = /has_database_privilege/;
const VERSION = /^SELECT value::text FROM ONLY smdb_data\.meta WHERE key = 'schema_version'/;
const SCRATCH = /^CREATE SCHEMA IF NOT EXISTS smdb_shape_[0-9a-f]{12}$/;

function whichCatalog(sql: string): Which | null {
  if (/pg_get_partkeydef/.test(sql)) return 'relations';
  if (/format_type/.test(sql)) return 'columns';
  if (/pg_get_constraintdef/.test(sql)) return 'constraints';
  if (/pg_get_triggerdef/.test(sql)) return 'rules';
  return null;
}

function scripted(script: Script) {
  const backend = new PostgresBackend({ chooser: fixedChooser('postgres://nobody@127.0.0.1:9/none'), markerStoreId: script.markerStoreId });
  backends.push(backend);
  const sent: string[] = [];
  const params: Array<unknown[] | undefined> = [];
  let foundCalls = 0;
  const client = {
    query: async (statement: string | { text: string; values?: unknown[] }, values?: unknown[]) => {
      const sql = (typeof statement === 'string' ? statement : statement.text).trim();
      const args = typeof statement === 'string' ? values : statement.values;
      sent.push(sql);
      params.push(args);
      const failure = script.fail?.(sql, sent.length - 1);
      if (failure) throw failure;
      if (LOCK.test(sql)) return { rows: [{ locked: true }], rowCount: 1 };
      if (sql === 'SHOW server_version_num') return { rows: [{ server_version_num: script.versionNum ?? '160004' }], rowCount: 1 };
      if (STORE_ID.test(sql)) {
        const rows = script.storeId ?? [{ '?column?': 1 }];
        return { rows, rowCount: rows.length };
      }
      if (sql === 'SHOW server_encoding') return { rows: [{ server_encoding: script.encoding ?? 'UTF8' }], rowCount: 1 };
      if (FOUND.test(sql)) {
        foundCalls += 1;
        const row = typeof script.found === 'function' ? script.found(foundCalls) : script.found ?? foundRow();
        return { rows: [row], rowCount: 1 };
      }
      if (VERSION.test(sql)) {
        const rows = script.version ?? [];
        return { rows, rowCount: rows.length };
      }
      const which = whichCatalog(sql);
      if (which) {
        const rows = script.catalog?.(String(args?.[0]), which) ?? [];
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  const connect = vi.fn(async () => client);
  (backend.getPool() as unknown as { connect: unknown }).connect = connect;
  return { backend, sent, params };
}

const internals = (b: InstanceType<typeof PostgresBackend>) => b as unknown as { provision(): Promise<void>; provisioned: boolean; schemaMismatch: boolean };
function quiet() {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

function fr(name: string, kind: string, extra: Row = {}): Row {
  const table = ['r', 'p', 'v', 'm', 'f'].includes(kind);
  const seq = kind === 'S';
  return {
    name, kind, is_partition: false,
    select: table ? true : null, insert: table ? true : null, update: table ? true : null, delete: table ? true : null,
    usage: seq ? true : null, update_seq: seq ? true : null, ...extra,
  };
}

const GOOD_META = { kind: 'r', key_text: true, value_text: true, value_not_null: true, rls: false, unique_key: true, select: true };

function foundRow(extra: Row = {}): Row {
  return {
    role: 'smdb_bot', db: 'smdb', db_create: true, schema_exists: true, schema_usage: true, schema_create: true,
    relations: [fr('meta', 'r'), fr('meta_pkey', 'i')], meta: GOOD_META, ...extra,
  };
}

const EMPTY_FOUND = { role: 'smdb_bot', db: 'smdb', db_create: true, schema_exists: false, schema_usage: null, schema_create: null, relations: [], meta: null };

function relRow(name: string, kind: string, extra: Row = {}): Row {
  return {
    name, kind, persistence: 'p', is_partition: false, rls: false, force_rls: false,
    access_method: kind === 'r' ? 'heap' : null, partition_key: null, bound: null, parent: null, inherits: [],
    index_def: null, index_valid: null, index_table: null, seq_increment: null, seq_min: null, seq_max: null,
    seq_cache: null, seq_cycle: null, ...extra,
  };
}

function colRow(rel: string, name: string, type: string, notNull: boolean, extra: Row = {}): Row {
  return {
    rel, name, type, not_null: notNull, default_expr: null, identity: '', generated: '', generated_expr: null,
    collation: type === 'text' ? '"default"' : null, storage: type === 'text' ? 'x' : 'p', not_null_validated: null, ...extra,
  };
}

const CURRENT = [{ value: JSON.stringify({ v: pg.SCHEMA_VERSION }) }];

/** The frozen schema statements without its seed rows, as the fresh path and the scratch send them. */
const frozenSchema = () => [...FROZEN_V8_DDL, ...frozenPartitions(true)].filter(s => !s.startsWith('INSERT')).map(s => s.trim());

const SEQ_PARAMS = { seq_increment: '1', seq_min: '1', seq_max: '9223372036854775807', seq_cache: '1', seq_cycle: false };
const PLAIN_TABLES = ['meta', 'guild_ownership', 'shard_claims', 'claim_clock', 'shard_nodes', 'reshard', 'identify_slots', 'guild_data_graveyard', 'guild_requests'];
const PARTITIONED = ['guild_data', 'guild_append'];
const SEQUENCES = ['claim_seq', 'guild_append_seq'];
const partitionNames = (t: string) => Array.from({ length: 32 }, (_, i) => [`${t}_p${String(i).padStart(2, '0')}`, i] as const);

/** The relations the fresh path made, as a found list on real Postgres lists them, every privilege held. */
function madeFound(transform: (r: Row) => Row = r => r): Row {
  const relations = [
    ...PLAIN_TABLES.map(t => fr(t, 'r')),
    ...PARTITIONED.map(t => fr(t, 'p')),
    ...SEQUENCES.map(s => fr(s, 'S')),
    ...PARTITIONED.flatMap(t => partitionNames(t).map(([p]) => fr(p, 'r', { is_partition: true }))),
  ];
  return foundRow({ relations: relations.map(transform) });
}

/** Both schemas' relations: the reference the scratch gives and the store the fresh path made, alike. */
function madeCatalog(_schema: string, which: Which): Row[] {
  if (which !== 'relations') return [];
  return [
    ...PLAIN_TABLES.map(t => relRow(t, 'r')),
    ...PARTITIONED.map(t => relRow(t, 'p', { partition_key: 'HASH (guild_id)', access_method: null })),
    ...SEQUENCES.map(s => relRow(s, 'S', SEQ_PARAMS)),
    ...PARTITIONED.flatMap(t => partitionNames(t).map(([p, i]) => relRow(p, 'r', {
      is_partition: true, parent: `smdb_data.${t}`, bound: `FOR VALUES WITH (modulus 32, remainder ${i})`,
    }))),
  ];
}

describe('a provisioned store of the right shape', () => {
  it('sends BEGIN, READ COMMITTED, the lock, the server version, the SET LOCALs, the encoding, the found list, the version, the scratch, the store id read, the seed rows and COMMIT', async () => {
    quiet();
    const { backend, sent } = scripted({ version: CURRENT });
    await internals(backend).provision();
    expect(await backend.provisionVerdict()).toEqual({ state: 'provisioned' });
    expect(sent[0]).toBe('BEGIN');
    expect(sent[1]).toBe('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    expect(LOCK.test(sent[2])).toBe(true);
    expect(sent.slice(3, 8)).toEqual([
      'SHOW server_version_num',
      'SET LOCAL search_path = pg_catalog',
      'SET LOCAL quote_all_identifiers = off',
      'SET LOCAL default_table_access_method = heap',
      'SHOW server_encoding',
    ]);
    expect(FOUND.test(sent[8])).toBe(true);
    expect(VERSION.test(sent[9])).toBe(true);
    expect(sent[10]).toBe('SAVEPOINT shape');
    expect(SCRATCH.test(sent[11])).toBe(true);
    const scratch = sent[11].replace('CREATE SCHEMA IF NOT EXISTS ', '');
    const ddl = frozenSchema().slice(1).map(s => s.replaceAll('smdb_data', scratch));
    expect(sent.slice(12, 12 + ddl.length)).toEqual(ddl);
    expect(sent.filter(s => /^INSERT\b/.test(s) && s.includes(scratch))).toEqual([]);
    const reads = sent.slice(12 + ddl.length, 20 + ddl.length);
    expect(reads.map(whichCatalog)).toEqual(['relations', 'columns', 'constraints', 'rules', 'relations', 'columns', 'constraints', 'rules']);
    expect(sent.slice(20 + ddl.length).map(s => s.split('(')[0].trim())).toEqual([
      'ROLLBACK TO SAVEPOINT shape',
      'RELEASE SAVEPOINT shape',
      "SELECT 1 FROM ONLY smdb_data.meta WHERE key = 'store_id'",
      'INSERT INTO smdb_data.claim_clock',
      'INSERT INTO smdb_data.reshard',
      'COMMIT',
    ]);
    expect(sent.filter(s => /^CREATE\b/.test(s) && /smdb_data/.test(s))).toEqual([]);
    expect(backend.servesData()).toBe(true);
  });

  it('writes no store id into the store it found (DL-2)', async () => {
    quiet();
    const { backend, sent } = scripted({ version: CURRENT });
    await internals(backend).provision();
    expect(sent.filter(s => /^INSERT INTO smdb_data\.meta/.test(s))).toEqual([]);
  });
});

describe('no privilege function is given a name', () => {
  const named = (sent: string[]) => sent.filter(s => /has_table_privilege\('|has_sequence_privilege\('|has_schema_privilege\('/.test(s));

  it("row 8's store: no meta, so decision 5's mode, and nothing names meta or the sequence", async () => {
    const errors = quiet();
    const { backend, sent } = scripted({
      found: foundRow({ relations: [fr('guild_data_graveyard', 'r'), fr('guild_data_graveyard_pkey', 'i'), fr('guild_graveyard_ttl_idx', 'i')], meta: null }),
      catalog: (schema, which) => {
        if (which === 'relations') return schema === 'smdb_data'
          ? [relRow('guild_data_graveyard', 'r')]
          : [relRow('guild_data_graveyard', 'r'), relRow('guild_append_seq', 'S', { seq_increment: '1', seq_min: '1', seq_max: '9', seq_cache: '1', seq_cycle: false })];
        if (which === 'columns') return [colRow('guild_data_graveyard', 'reason', 'text', schema !== 'smdb_data')];
        return [];
      },
    });
    await internals(backend).provision();
    const verdict = await backend.provisionVerdict();
    expect(verdict.state).toBe('shape');
    expect((verdict as { reason: string }).reason.startsWith("the database's smdb_data holds objects but no schema_version")).toBe(true);
    expect(named(sent)).toEqual([]);
    expect(sent.filter(s => /smdb_data\.meta\b/.test(s))).toEqual([]);
    const lines = errors.mock.calls.map(c => String(c[0]));
    expect(lines.some(l => l.includes('meta'))).toBe(false);
    expect(lines.some(l => l.includes('guild_append_seq'))).toBe(false);
  });

  it("row 35's store: meta reads this bot's version, guild_append_seq is absent and named missing, with no privilege line", async () => {
    const errors = quiet();
    const { backend, sent } = scripted({
      version: CURRENT,
      catalog: (schema, which) => {
        if (which !== 'relations') return [];
        const base = [relRow('meta', 'r')];
        return schema === 'smdb_data' ? base : [...base, relRow('guild_append_seq', 'S', { seq_increment: '1', seq_min: '1', seq_max: '9', seq_cache: '1', seq_cycle: false })];
      },
    });
    await internals(backend).provision();
    const verdict = await backend.provisionVerdict() as { state: string; reason: string };
    expect(verdict.state).toBe('shape');
    expect(verdict.reason).toBe(`the database's smdb_data differs from this bot's schema (version ${pg.SCHEMA_VERSION}): smdb_data.guild_append_seq (sequence) is missing`);
    expect(named(sent)).toEqual([]);
    expect(errors.mock.calls.map(c => String(c[0])).filter(l => /lacks/.test(l))).toEqual([]);
  });
});

describe('the encoding', () => {
  it.each(['LATIN1', 'SQL_ASCII'])('%s is refused right after SHOW, before anything of smdb_data is read', async encoding => {
    quiet();
    const { backend, sent } = scripted({ encoding });
    await internals(backend).provision();
    expect(sent.slice(-2)).toEqual(['SHOW server_encoding', 'ROLLBACK']);
    expect(sent.some(s => FOUND.test(s) || VERSION.test(s) || /SAVEPOINT/.test(s))).toBe(false);
    const refusal = shape.encodingRefusal(encoding);
    expect(await backend.provisionVerdict()).toEqual({ state: 'shape', reason: refusal.reason, fix: refusal.fix });
    expect(backend.servesData()).toBe(false);
  });

  // MB2: a lost connection is no answer, so under NB5's spoil rule nothing more is sent on that client.
  it('a throw of SHOW sends nothing more, rethrows and latches nothing', async () => {
    quiet();
    const { backend, sent } = scripted({ fail: sql => (sql === 'SHOW server_encoding' ? Object.assign(new Error('gone'), { code: '08006' }) : undefined) });
    await expect(internals(backend).provision()).rejects.toThrow('gone');
    expect(sent[sent.length - 1]).toBe('SHOW server_encoding');
    expect(sent).not.toContain('ROLLBACK');
    expect(internals(backend).schemaMismatch).toBe(false);
  });
});

describe('the privilege gate', () => {
  const gated: Array<[string, Row]> = [
    ['CREATE on the database, a store with objects', foundRow({ db_create: false })],
    ['CREATE on the database, an empty found list', { ...EMPTY_FOUND, db_create: false }],
    ['USAGE on the schema', foundRow({ schema_usage: false })],
    ['SELECT on meta', foundRow({ relations: [fr('meta', 'r', { select: false }), fr('meta_pkey', 'i')], meta: { ...GOOD_META, select: false } })],
    ['CREATE on an empty schema', foundRow({ relations: [], meta: null, schema_create: false })],
  ];

  it.each(gated)('%s: ROLLBACK right after the found list, the gate header', async (_name, row) => {
    const errors = quiet();
    const { backend, sent } = scripted({ found: row, version: CURRENT });
    await internals(backend).provision();
    expect(FOUND.test(sent[sent.length - 2])).toBe(true);
    expect(sent[sent.length - 1]).toBe('ROLLBACK');
    expect(sent.some(s => VERSION.test(s) || /SAVEPOINT/.test(s))).toBe(false);
    const verdict = await backend.provisionVerdict() as { state: string; reason: string };
    expect(verdict.state).toBe('shape');
    expect(verdict.reason).toMatch(/^this bot's database role smdb_bot lacks privileges it needs on /);
    expect(errors.mock.calls.map(c => String(c[0])).filter(l => l.startsWith('[PostgresBackend] schema difference: ')).length).toBeGreaterThan(0);
  });

  it('lists every false privilege of the found list', async () => {
    const errors = quiet();
    const row = foundRow({
      schema_usage: false,
      relations: [fr('meta', 'r', { select: false, delete: false }), fr('claim_seq', 'S', { update_seq: false }), fr('guild_data', 'p', { insert: false }), fr('foreign_x', 'r', { insert: false })],
      meta: { ...GOOD_META, select: false },
    });
    const { backend } = scripted({ found: row });
    await internals(backend).provision();
    expect(errors.mock.calls.map(c => String(c[0])).filter(l => l.startsWith('[PostgresBackend] schema difference: '))).toEqual([
      "[PostgresBackend] schema difference: this bot's database role smdb_bot lacks USAGE on schema smdb_data",
      "[PostgresBackend] schema difference: this bot's database role smdb_bot lacks UPDATE on sequence smdb_data.claim_seq",
      "[PostgresBackend] schema difference: this bot's database role smdb_bot lacks INSERT on smdb_data.guild_data",
      "[PostgresBackend] schema difference: this bot's database role smdb_bot lacks SELECT on smdb_data.meta",
      "[PostgresBackend] schema difference: this bot's database role smdb_bot lacks DELETE on smdb_data.meta",
    ]);
  });
});

describe('an empty smdb_data (the schema, its privileges, no relation)', () => {
  it('takes the fresh path', async () => {
    quiet();
    const { backend, sent } = scripted({ found: foundRow({ relations: [], meta: null }), version: CURRENT });
    await internals(backend).provision();
    expect(await backend.provisionVerdict()).toEqual({ state: 'provisioned' });
    expect(sent).toContain('CREATE SCHEMA IF NOT EXISTS smdb_data');
    expect(sent[sent.length - 1]).toBe('COMMIT');
  });
});

describe('a provisioned store of the right shape whose role lacks a privilege', () => {
  it('INSERT false on guild_data: the right-shape privilege header', async () => {
    quiet();
    const { backend, sent } = scripted({
      version: CURRENT,
      found: foundRow({ relations: [fr('meta', 'r'), fr('guild_data', 'p', { insert: false })] }),
      catalog: (_schema, which) => (which === 'relations' ? [relRow('meta', 'r'), relRow('guild_data', 'p', { partition_key: 'HASH (guild_id)' })] : []),
    });
    await internals(backend).provision();
    const verdict = await backend.provisionVerdict() as { state: string; reason: string; fix: string };
    expect(verdict.reason).toBe(`this bot's database role smdb_bot lacks privileges on smdb_data, which matches this bot's schema (version ${pg.SCHEMA_VERSION}): this bot's database role smdb_bot lacks INSERT on smdb_data.guild_data`);
    expect(verdict.fix).not.toContain('RENAME');
    expect(sent[sent.length - 1]).toBe('ROLLBACK');
  });
});

describe('a provisioned store with a difference', () => {
  it('rolls back after the catalog reads and sends nothing that writes smdb_data', async () => {
    quiet();
    const { backend, sent } = scripted({
      version: CURRENT,
      catalog: (schema, which) => (which === 'relations' && schema === 'smdb_data' ? [relRow('meta', 'r'), relRow('x', 'r')] : which === 'relations' ? [relRow('meta', 'r')] : []),
    });
    await internals(backend).provision();
    expect(sent.slice(-3)).toEqual(['ROLLBACK TO SAVEPOINT shape', 'RELEASE SAVEPOINT shape', 'ROLLBACK']);
    expect(sent.filter(s => /^(INSERT|CREATE|UPDATE|DELETE|ALTER)\b/.test(s) && /smdb_data\./.test(s))).toEqual([]);
    expect(await backend.provisionVerdict()).toEqual({
      state: 'shape',
      reason: `the database's smdb_data differs from this bot's schema (version ${pg.SCHEMA_VERSION}): smdb_data.x (table) is not part of this bot's schema`,
      fix: "Gates stay closed and nothing in the database was changed; point DATA_BACKEND_URL at a database whose smdb_data matches this bot's schema in the web UI env editor, or correct the differences above in the database and restart the bot",
    });
    expect(backend.servesData()).toBe(false);
  });
});

describe('no version, objects found', () => {
  it("is refused in decision 5's mode with nothing on smdb_data sent", async () => {
    quiet();
    const { backend, sent } = scripted({ version: [] });
    await internals(backend).provision();
    const verdict = await backend.provisionVerdict() as { state: string; reason: string };
    expect(verdict.reason.startsWith("the database's smdb_data holds objects but no schema_version")).toBe(true);
    expect(sent[sent.length - 1]).toBe('ROLLBACK');
    expect(sent.filter(s => /^(INSERT|CREATE|UPDATE|DELETE|ALTER)\b/.test(s) && /smdb_data\./.test(s))).toEqual([]);
  });
});

describe("meta's gate", () => {
  const causes: Array<[string, Row, string]> = [
    ['a view', { kind: 'v' }, 'smdb_data.meta is a view, not a table'],
    ['without key', { key_text: false }, 'smdb_data.meta has no text column key'],
    ['without value', { value_text: false }, 'smdb_data.meta has no text column value'],
    ['value nullable', { value_not_null: false }, 'smdb_data.meta column value allows NULL'],
    ['row level security on', { rls: true }, 'row level security on smdb_data.meta can hide rows'],
    ['no unique index on key', { unique_key: false }, 'smdb_data.meta has no unique index on key, so it can hold more than one schema_version'],
  ];

  it.each(causes)('%s: no version read, the "can\'t be read" header naming the cause', async (_name, facts, cause) => {
    const errors = quiet();
    const { backend, sent } = scripted({ found: foundRow({ meta: { ...GOOD_META, ...facts } }), version: CURRENT });
    await internals(backend).provision();
    expect(sent.some(s => VERSION.test(s))).toBe(false);
    const verdict = await backend.provisionVerdict() as { state: string; reason: string; fix: string };
    expect(verdict.state).toBe('shape');
    expect(verdict.reason.startsWith(`the database's smdb_data holds objects and its schema_version can't be read (${cause}), so this bot can't confirm`)).toBe(true);
    expect(verdict.fix).not.toContain('RENAME');
    expect(errors.mock.calls.map(c => String(c[0]))[0]).toBe(`[PostgresBackend] schema-mismatch: smdb_data holds 2 object(s) and its schema_version can't be read (${cause}), so this bot can't confirm what made them or that they are complete; refusing to serve`);
  });

  it.each([
    ['two rows', [...CURRENT, { value: '{"v":2}' }], 'smdb_data.meta holds 2 schema_version rows'],
    ['a NULL value', [{ value: null }], 'smdb_data.meta holds a schema_version row with no value'],
  ])('the version read answering %s', async (_name, rows, cause) => {
    quiet();
    const { backend } = scripted({ version: rows as Row[] });
    await internals(backend).provision();
    const verdict = await backend.provisionVerdict() as { state: string; reason: string };
    expect(verdict.state).toBe('shape');
    expect(verdict.reason).toContain(`its schema_version can't be read (${cause})`);
  });

  it('a version present and different is the version mismatch, with no scratch', async () => {
    quiet();
    const { backend, sent } = scripted({ version: [{ value: '{"v":2}' }] });
    await internals(backend).provision();
    expect(await backend.provisionVerdict()).toEqual({ state: 'mismatch', found: '{"v":2}' });
    expect(sent.some(s => /SAVEPOINT|smdb_shape_/.test(s))).toBe(false);
    expect(sent[sent.length - 1]).toBe('ROLLBACK');
  });
});

describe('a fresh database', () => {
  it('makes the schema, compares it and re-reads the privileges before any row, between one BEGIN and one COMMIT', async () => {
    quiet();
    const { backend, sent } = scripted({ found: call => (call === 1 ? EMPTY_FOUND : madeFound()), version: CURRENT, catalog: madeCatalog });
    await internals(backend).provision();
    expect(await backend.provisionVerdict()).toEqual({ state: 'provisioned' });
    expect(sent.filter(s => s === 'BEGIN')).toHaveLength(1);
    expect(sent.filter(s => s === 'COMMIT')).toHaveLength(1);
    expect(sent.indexOf('BEGIN')).toBe(0);
    const at = sent.indexOf('SHOW server_encoding');
    expect(FOUND.test(sent[at + 1])).toBe(true);
    const own = frozenSchema();
    expect(sent.slice(at + 2, at + 2 + own.length)).toEqual(own);
    expect(sent[at + 2 + own.length]).toBe('SAVEPOINT shape');
    expect(SCRATCH.test(sent[at + 3 + own.length])).toBe(true);
    const tail = sent.slice(sent.indexOf('RELEASE SAVEPOINT shape'));
    expect(tail.length).toBe(8);
    expect(FOUND.test(tail[1])).toBe(true);
    expect(tail.slice(2, 4)).toEqual(FROZEN_V8_DDL.filter(s => s.startsWith('INSERT')).map(s => s.trim()));
    expect(tail[4]).toMatch(/^INSERT INTO smdb_data\.meta \(key, value\) VALUES \('schema_version', \$1\) ON CONFLICT \(key\) DO NOTHING$/);
    expect(VERSION.test(tail[5])).toBe(true);
    expect(tail[6]).toMatch(/^INSERT INTO smdb_data\.meta \(key, value\) VALUES \('store_id'/);
    expect(tail[7]).toBe('COMMIT');
  });

  it('R2-T2: the second found list lists the made tables with DELETE false: ROLLBACK, no row written, the fresh privilege texts', async () => {
    const errors = quiet();
    const noDelete = (r: Row) => (['r', 'p'].includes(String(r.kind)) ? { ...r, delete: false } : r);
    const { backend, sent } = scripted({
      found: call => (call === 1 ? EMPTY_FOUND : madeFound(noDelete)),
      version: CURRENT,
      catalog: madeCatalog,
    });
    await internals(backend).provision();
    const lines = ['claim_clock', 'guild_append', 'guild_data', 'guild_data_graveyard', 'guild_ownership', 'guild_requests', 'identify_slots', 'meta', 'reshard', 'shard_claims', 'shard_nodes']
      .map(t => `this bot's database role smdb_bot lacks DELETE on smdb_data.${t}`);
    expect(await backend.provisionVerdict()).toEqual({
      state: 'shape',
      reason: `this bot's database role smdb_bot lacked privileges on the schema it made in the database, so it was rolled back (default privileges or an event trigger take them from new tables): ${lines.slice(0, 5).join('; ')}; and 6 more (the bot's log lists them)`,
      fix: "Gates stay closed and nothing in the database was changed; as smdb_bot or a superuser, run ALTER DEFAULT PRIVILEGES FOR ROLE smdb_bot GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO smdb_bot; ALTER DEFAULT PRIVILEGES FOR ROLE smdb_bot GRANT USAGE, UPDATE ON SEQUENCES TO smdb_bot (SELECT * FROM pg_default_acl lists what is set), remove any event trigger that revokes privileges on new tables, and restart the bot",
    });
    expect(errors.mock.calls.map(c => String(c[0])).filter(l => l.startsWith('[PostgresBackend] schema'))).toEqual([
      "[PostgresBackend] schema-mismatch: this bot's database role smdb_bot lacked 11 privilege(s) on the schema it made in the database, so it was rolled back before it was committed (default privileges set with ALTER DEFAULT PRIVILEGES, or an event trigger, take them from new tables); refusing to serve",
      ...lines.map(l => `[PostgresBackend] schema difference: ${l}`),
    ]);
    expect(sent.slice(-3)).toEqual(['RELEASE SAVEPOINT shape', sent[sent.length - 2], 'ROLLBACK']);
    expect(FOUND.test(sent[sent.length - 2])).toBe(true);
    expect(sent.filter(s => /^INSERT\b/.test(s))).toEqual([]);
    expect(sent).not.toContain('COMMIT');
  });

  it('a difference in the new store: ROLLBACK, the fresh header, no second found list', async () => {
    quiet();
    const { backend, sent } = scripted({
      found: EMPTY_FOUND,
      version: CURRENT,
      catalog: (schema, which) => {
        if (which === 'relations') return [relRow('guild_data', 'p', { partition_key: 'HASH (guild_id)' })];
        return which === 'rules' && schema === 'smdb_data' ? [{ rel: 'guild_data', what: 'trigger', name: 't', def: 'CREATE TRIGGER t' }] : [];
      },
    });
    await internals(backend).provision();
    const verdict = await backend.provisionVerdict() as { state: string; reason: string };
    expect(verdict.reason).toBe("the schema this bot made in the database differed from this bot's schema and was rolled back (an event trigger or another program changes new tables): smdb_data.guild_data has trigger t (CREATE TRIGGER t), which this bot's schema does not have");
    expect(sent.filter(s => FOUND.test(s))).toHaveLength(1);
    expect(sent[sent.length - 1]).toBe('ROLLBACK');
    expect(sent).not.toContain('COMMIT');
  });

  it('a second found list with INSERT false on guild_data: ROLLBACK and the fresh privilege header', async () => {
    quiet();
    const { backend, sent } = scripted({
      found: call => (call === 1 ? EMPTY_FOUND : foundRow({ relations: [fr('meta', 'r'), fr('guild_data', 'p', { insert: false })] })),
      version: CURRENT,
      catalog: (_schema, which) => (which === 'relations' ? [relRow('meta', 'r'), relRow('guild_data', 'p', { partition_key: 'HASH (guild_id)' })] : []),
    });
    await internals(backend).provision();
    const verdict = await backend.provisionVerdict() as { state: string; reason: string };
    expect(verdict.reason).toBe("this bot's database role smdb_bot lacked privileges on the schema it made in the database, so it was rolled back (default privileges or an event trigger take them from new tables): this bot's database role smdb_bot lacks INSERT on smdb_data.guild_data");
    expect(sent[sent.length - 1]).toBe('ROLLBACK');
    expect(sent).not.toContain('COMMIT');
  });

  it('item 12: a throw at the 30th DDL statement rolls back, latches nothing, and the same backend provisions on its retry', async () => {
    quiet();
    let ddlSeen = 0;
    const { backend, sent } = scripted({
      found: EMPTY_FOUND,
      version: CURRENT,
      fail: sql => {
        if (!(/^CREATE (TABLE|INDEX|SEQUENCE|SCHEMA)/.test(sql) && /smdb_data/.test(sql))) return undefined;
        ddlSeen += 1;
        return ddlSeen === 30 ? Object.assign(new Error('connection lost'), { code: '08006' }) : undefined;
      },
    });
    await expect(internals(backend).provision()).rejects.toThrow('connection lost');
    expect(sent[sent.length - 1]).toMatch(/^CREATE /);
    expect(sent).not.toContain('ROLLBACK');
    expect(internals(backend).schemaMismatch).toBe(false);
    expect(internals(backend).provisioned).toBe(false);
    const firstAttempt = sent.length;
    await internals(backend).provision();
    expect(await backend.provisionVerdict()).toEqual({ state: 'provisioned' });
    const retry = sent.slice(firstAttempt);
    expect(retry[0]).toBe('BEGIN');
    expect(retry[1]).toBe('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    expect(LOCK.test(retry[2])).toBe(true);
    expect(retry.filter(s => s === 'BEGIN')).toHaveLength(1);
    expect(retry.filter(s => s === 'COMMIT')).toHaveLength(1);
    expect(retry).not.toContain('ROLLBACK');
  });
});

describe('checkShape on its own', () => {
  it('sends only its savepoints, the scratch and the catalog reads, and latches nothing', async () => {
    const sent: string[] = [];
    const client = {
      query: async (text: string) => {
        sent.push(text.trim());
        return { rows: [], rowCount: 0 };
      },
    };
    const result = await shape.checkShape(client, 'provisioned');
    expect(result.differences).toEqual([]);
    expect(sent.filter(s => /^(BEGIN|COMMIT|ROLLBACK)\b/.test(s) && !/SAVEPOINT/.test(s))).toEqual([]);
    expect(sent[0]).toBe('SAVEPOINT shape');
    expect(sent.slice(-2)).toEqual(['ROLLBACK TO SAVEPOINT shape', 'RELEASE SAVEPOINT shape']);
    expect(sent.filter(s => /\b(FROM|INTO|UPDATE|TABLE)\s+(ONLY\s+)?smdb_data\./.test(s))).toEqual([]);
  });
});

describe('a throw at any statement of the check', () => {
  const failures: Array<[string, RegExp]> = [
    ['the found list', FOUND],
    ['the version read', VERSION],
    ['the savepoint', /^SAVEPOINT shape$/],
    ['a catalog read', /pg_get_constraintdef/],
    ['the store id read', STORE_ID],
    ['the claim_clock insert', /^INSERT INTO smdb_data\.claim_clock/],
    ['the COMMIT', /^COMMIT$/],
  ];

  // MB2: 57014 is the server's answer, so the transaction is rolled back on the client; 08006 with no server answer
  // spoils the lease under NB5's rule, so nothing more is sent and the client is destroyed.
  it.each(failures.flatMap(([name, at]) => [['57014', name, at], ['08006', name, at]] as Array<[string, string, RegExp]>))('%s at %s: ROLLBACK when answered, rethrow, no latch', async (code, _name, at) => {
    quiet();
    const failure = () => Object.assign(new Error(`failed ${code}`), code === '57014' ? { code, severity: 'ERROR' } : { code });
    const { backend, sent } = scripted({ version: CURRENT, fail: sql => (at.test(sql) ? failure() : undefined) });
    await expect(internals(backend).provision()).rejects.toThrow(`failed ${code}`);
    if (code === '57014') expect(sent[sent.length - 1]).toBe('ROLLBACK');
    else {
      expect(sent[sent.length - 1]).toMatch(at);
      expect(sent).not.toContain('ROLLBACK');
    }
    expect(internals(backend).schemaMismatch).toBe(false);
    expect(internals(backend).provisioned).toBe(false);
  });
});

// The schema of SCHEMA_VERSION 8, frozen. A change here means the DDL changed.
const FROZEN_V8_DDL = [
  `CREATE SCHEMA IF NOT EXISTS smdb_data`,
  `CREATE TABLE IF NOT EXISTS smdb_data.meta (
    key        text PRIMARY KEY,
    value      text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS smdb_data.guild_ownership (
    guild_id     text PRIMARY KEY,
    node_id      text NOT NULL,
    shard_id     integer NOT NULL,
    claim        bigint NOT NULL,
    shard_count  integer NOT NULL,
    retired_at   timestamptz,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    last_flush   uuid
  )`,
  `CREATE INDEX IF NOT EXISTS guild_ownership_node_idx ON smdb_data.guild_ownership (node_id)`,
  `CREATE INDEX IF NOT EXISTS guild_ownership_claim_idx ON smdb_data.guild_ownership (claim)`,
  `CREATE INDEX IF NOT EXISTS guild_ownership_shard_idx ON smdb_data.guild_ownership (shard_count, shard_id)`,
  `CREATE SEQUENCE IF NOT EXISTS smdb_data.claim_seq`,
  `CREATE TABLE IF NOT EXISTS smdb_data.shard_claims (
    shard_count     integer     NOT NULL,
    shard_id        integer     NOT NULL,
    claim           bigint      NOT NULL,
    holder_process  text        NOT NULL,
    holder_node     text        NOT NULL,
    holder_name     text        NOT NULL,
    home_node       text        NOT NULL,
    released        boolean     NOT NULL DEFAULT false,
    reserved        boolean     NOT NULL DEFAULT false,
    taken_at        timestamptz NOT NULL DEFAULT now(),
    renewed_at      timestamptz NOT NULL DEFAULT now(),
    ttl_ms          bigint      NOT NULL,
    expires_up_ms   bigint      NOT NULL,
    extended        boolean     NOT NULL DEFAULT false,
    ready           boolean     NOT NULL DEFAULT false,
    PRIMARY KEY (shard_count, shard_id)
  )`,
  `CREATE TABLE IF NOT EXISTS smdb_data.claim_clock (
    id          integer     PRIMARY KEY CHECK (id = 1),
    up_ms       bigint      NOT NULL,
    ticked_at   timestamptz NOT NULL,
    last_gap_ms bigint      NOT NULL DEFAULT 0
  )`,
  `INSERT INTO smdb_data.claim_clock (id, up_ms, ticked_at) VALUES (1, 0, now()) ON CONFLICT (id) DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS smdb_data.shard_nodes (
    node_id          text PRIMARY KEY,
    node_name        text        NOT NULL,
    process_id       text        NOT NULL,
    capacity         integer     NOT NULL,
    takeover_seconds integer     NOT NULL,
    fit              boolean     NOT NULL,
    restartable      boolean     NOT NULL,
    returns          boolean     NOT NULL,
    started_at       timestamptz NOT NULL,
    healthy_since    timestamptz,
    seen_at          timestamptz NOT NULL,
    count_setting    integer,
    reshard_overlap  boolean     NOT NULL DEFAULT true,
    memory_room      boolean,
    memory_free_mb   integer,
    memory_use_mb    integer,
    memory_error     text,
    memory_at        timestamptz
  )`,
  `CREATE TABLE IF NOT EXISTS smdb_data.reshard (
    id          integer     PRIMARY KEY CHECK (id = 1),
    target      integer,
    target_by   text,
    target_at   timestamptz,
    attempt     uuid,
    from_count  integer,
    to_count    integer,
    method      text        CHECK (method IN ('overlap', 'stop-start')),
    state       text        CHECK (state IN ('standby', 'flipped', 'stopping', 'done', 'cancelled')),
    started_by  text,
    started_at  timestamptz,
    until_at    timestamptz,
    flipped_at  timestamptz,
    ended_at    timestamptz,
    reason      text,
    retry_after timestamptz,
    failures    integer     NOT NULL DEFAULT 0
  )`,
  `INSERT INTO smdb_data.reshard (id) VALUES (1) ON CONFLICT (id) DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS smdb_data.identify_slots (
    bucket     integer     PRIMARY KEY,
    last_at    timestamptz NOT NULL,
    process_id text        NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS smdb_data.guild_data (
    guild_id   text NOT NULL,
    module     text NOT NULL,
    filename   text NOT NULL,
    doc        text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (guild_id, module, filename)
  ) PARTITION BY HASH (guild_id)`,
  `CREATE SEQUENCE IF NOT EXISTS smdb_data.guild_append_seq`,
  `CREATE TABLE IF NOT EXISTS smdb_data.guild_append (
    guild_id   text NOT NULL,
    module     text NOT NULL,
    filename   text NOT NULL,
    seq        bigint NOT NULL DEFAULT nextval('smdb_data.guild_append_seq'),
    chunk      text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (guild_id, module, filename, seq)
  ) PARTITION BY HASH (guild_id)`,
  `CREATE TABLE IF NOT EXISTS smdb_data.guild_data_graveyard (
    guild_id   text NOT NULL,
    module     text NOT NULL,
    filename   text NOT NULL,
    kind       text NOT NULL CHECK (kind IN ('doc','append')),
    doc        text NOT NULL,
    retired_at bigint NOT NULL,
    reason     text NOT NULL,
    used_at    bigint,
    PRIMARY KEY (guild_id, retired_at, module, filename)
  )`,
  `CREATE INDEX IF NOT EXISTS guild_graveyard_ttl_idx ON smdb_data.guild_data_graveyard (retired_at)`,
  `CREATE TABLE IF NOT EXISTS smdb_data.guild_requests (
    id            uuid        PRIMARY KEY,
    guild_id      text        NOT NULL,
    shard_count   integer     NOT NULL,
    shard_id      integer     NOT NULL,
    for_process   text        NOT NULL,
    op            text        NOT NULL CHECK (op IN ('write','delete','delete-namespace','restore-graveyard')),
    body          text        NOT NULL,
    requested_by  text        NOT NULL,
    state         text        NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','applying','done','expired')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    claim_by      timestamptz NOT NULL,
    answer_by     timestamptz NOT NULL,
    claim_batch   uuid,
    applier_claim bigint,
    taken_at      timestamptz,
    reply         text,
    done_at       timestamptz
  )`,
  `CREATE INDEX IF NOT EXISTS guild_requests_pending_idx ON smdb_data.guild_requests (for_process, created_at) WHERE state = 'pending'`,
  `CREATE INDEX IF NOT EXISTS guild_requests_applying_idx ON smdb_data.guild_requests (claim_batch) WHERE state = 'applying'`,
];

function frozenPartitions(ifNotExists: boolean): string[] {
  const out: string[] = [];
  const create = ifNotExists ? 'CREATE TABLE IF NOT EXISTS' : 'CREATE TABLE';
  for (let i = 0; i < 32; i++) {
    const suffix = `p${String(i).padStart(2, '0')}`;
    out.push(`${create} smdb_data.guild_data_${suffix} PARTITION OF smdb_data.guild_data FOR VALUES WITH (MODULUS 32, REMAINDER ${i})`);
    out.push(`${create} smdb_data.guild_append_${suffix} PARTITION OF smdb_data.guild_append FOR VALUES WITH (MODULUS 32, REMAINDER ${i})`);
  }
  return out;
}

const BUMP = 'the DDL changed: bump SCHEMA_VERSION (the boot refuses a stored schema that differs) and update this copy';

describe('the schema of SCHEMA_VERSION 8 (guard)', () => {
  it("provision()'s 86 statements are today's, text for text", () => {
    expect(pg.SCHEMA_VERSION, BUMP).toBe(8);
    expect([...pg.provisionDdl('smdb_data'), ...pg.partitionDdl('smdb_data', true)], BUMP).toEqual([...FROZEN_V8_DDL, ...frozenPartitions(true)]);
  });

  it("provisionStoreInTransaction's statements are today's, text for text", async () => {
    const sent: string[] = [];
    await pg.provisionStoreInTransaction({ query: async (text: string) => { sent.push(text); return { rows: [] }; } });
    expect(sent.slice(0, -2), BUMP).toEqual(['CREATE SCHEMA smdb_data', ...FROZEN_V8_DDL.slice(1), ...frozenPartitions(false)]);
  });

  it('the DDL rendered for another schema names no smdb_data', () => {
    expect([...pg.provisionDdl('smdb_shape_x'), ...pg.partitionDdl('smdb_shape_x', true)].filter(s => s.includes('smdb_data'))).toEqual([]);
  });
});

const token: FenceToken = { nodeId: 'node-a', claim: 3, processId: 'process-a', shardId: 0, shardCount: 1 };
const RESTORE_ARGS = () => [() => null, process.hrtime.bigint() + 40_000_000_000n] as const;

describe('restoreGuild names the cause of the latch', () => {
  const latches: Array<[string, Script, string]> = [
    ['version', { version: [{ value: '{"v":1}' }] }, 'the database holds schema version {"v":1}'],
    ['shape', { version: [] }, "the database's smdb_data differs from this bot's schema"],
    ['privileges', { found: foundRow({ schema_usage: false }) }, "this bot's database role lacks privileges on smdb_data"],
    ['encoding', { encoding: 'LATIN1' }, "the database's server_encoding is LATIN1, not UTF8"],
    ['server', { versionNum: '120017' }, 'the database server is PostgreSQL 12.17, older than 13'],
    ['identity', { version: CURRENT, storeId: [], markerStoreId: () => 'store-1' }, "the database's smdb_data.meta holds no store_id"],
    ['scratch', {
      version: CURRENT,
      fail: sql => (/^CREATE TABLE IF NOT EXISTS smdb_shape_[0-9a-f]{12}\.meta /.test(sql)
        ? Object.assign(new Error('permission denied for tablespace fast'), { severity: 'ERROR', code: '42501' })
        : undefined),
    }, 'the bot could not build its copy of its schema to compare with'],
  ];

  it.each(latches)('%s', async (_name, script, cause) => {
    const errors = quiet();
    const { backend } = scripted(script);
    await internals(backend).provision();
    errors.mockClear();
    expect(await backend.restoreGuild('1', 5, token, ...RESTORE_ARGS())).toEqual({ ok: false, reason: 'schema-mismatch' });
    expect(errors.mock.calls.map(c => String(c[0]))).toEqual([`[PostgresBackend] Refused restore for guild 1: ${cause}`]);
  });
});
