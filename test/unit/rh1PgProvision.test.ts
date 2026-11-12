import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import * as pg from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { fixedChooser } from '../helpers/fixedDatabase';

const { PostgresBackend } = pg;
type Backend = InstanceType<typeof PostgresBackend>;
type Row = Record<string, unknown>;
type Which = 'relations' | 'columns' | 'constraints' | 'rules';

const backends: Backend[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const backend of backends.splice(0)) await backend.stop();
});

const LOCK = /^SELECT pg_try_advisory_xact_lock\(hashtext\('smdb_data_bootstrap'\)\) AS locked$/;
const STORE_ID_READ = /^SELECT 1 FROM ONLY smdb_data\.meta WHERE key = 'store_id'$/;
const FOUND = /has_database_privilege/;
const VERSION = /^SELECT value::text FROM ONLY smdb_data\.meta WHERE key = 'schema_version'/;
const VERSION_INSERT = /^INSERT INTO smdb_data\.meta \(key, value\) VALUES \('schema_version', \$1\)/;
const STORE_ID_INSERT = /^INSERT INTO smdb_data\.meta \(key, value\) VALUES \('store_id', \$1\)/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CURRENT = [{ value: JSON.stringify({ v: pg.SCHEMA_VERSION }) }];

interface Script {
  lock?: (call: number) => Row[];
  found?: (call: number) => Row;
  version?: Row[];
  catalog?: (schema: string, which: Which) => Row[];
  storeId?: Row[];
  fail?: (sql: string) => unknown;
  onSend?: (sql: string) => void;
}

interface Sent { sql: string; values: unknown[] }

// Postgres refuses a statement whose bind message carries another number of parameters than its text uses.
function wireError(sql: string, values: unknown[]): Error | null {
  let wanted = 0;
  for (const match of sql.matchAll(/\$(\d+)/g)) wanted = Math.max(wanted, Number(match[1]));
  if (values.length === wanted) return null;
  return Object.assign(new Error(`bind message supplies ${values.length} parameters, but prepared statement "" requires ${wanted}`), { code: '08P01', severity: 'ERROR' });
}

function whichCatalog(sql: string): Which | null {
  if (/pg_get_partkeydef/.test(sql)) return 'relations';
  if (/format_type/.test(sql)) return 'columns';
  if (/pg_get_constraintdef/.test(sql)) return 'constraints';
  if (/pg_get_triggerdef/.test(sql)) return 'rules';
  return null;
}

function scripted(script: Script, chooserUrl = 'postgres://nobody@127.0.0.1:9/none') {
  const backend = new PostgresBackend({ chooser: fixedChooser(chooserUrl) });
  backends.push(backend);
  const sent: Sent[] = [];
  let lockCalls = 0;
  let foundCalls = 0;
  let storedVersion: string | undefined;
  const client = {
    query: async (statement: string | { text: string; values?: unknown[] }, more?: unknown[]) => {
      const sql = (typeof statement === 'string' ? statement : statement.text).trim();
      const values = (typeof statement === 'string' ? more : statement.values) ?? [];
      sent.push({ sql, values });
      script.onSend?.(sql);
      const failure = script.fail?.(sql);
      if (failure) throw failure;
      const refused = wireError(sql, values);
      if (refused) throw refused;
      if (LOCK.test(sql)) {
        lockCalls += 1;
        const rows = script.lock ? script.lock(lockCalls) : [{ locked: true }];
        return { rows, rowCount: rows.length };
      }
      if (sql === 'SHOW server_version_num') return { rows: [{ server_version_num: '160004' }], rowCount: 1 };
      if (sql === 'SHOW server_encoding') return { rows: [{ server_encoding: 'UTF8' }], rowCount: 1 };
      if (STORE_ID_READ.test(sql)) {
        const rows = script.storeId ?? [{ '?column?': 1 }];
        return { rows, rowCount: rows.length };
      }
      if (FOUND.test(sql)) {
        foundCalls += 1;
        return { rows: [script.found ? script.found(foundCalls) : foundRow()], rowCount: 1 };
      }
      if (VERSION_INSERT.test(sql)) {
        if (storedVersion === undefined) storedVersion = String(values[0]);
        return { rows: [], rowCount: 1 };
      }
      if (VERSION.test(sql)) {
        const rows = storedVersion !== undefined ? [{ value: storedVersion }] : script.version ?? [];
        return { rows, rowCount: rows.length };
      }
      const which = whichCatalog(sql);
      if (which) {
        const rows = script.catalog?.(String(values[0]), which) ?? [];
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  (backend.getPool() as unknown as { connect: unknown }).connect = vi.fn(async () => client);
  return { backend, sent };
}

const internals = (b: Backend) => b as unknown as { provision(): Promise<void>; sleep(ms: number): Promise<void> };

function quiet() {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  return { log, error };
}

const lines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(c => String(c[0]));

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

const SEQ_PARAMS = { seq_increment: '1', seq_min: '1', seq_max: '9223372036854775807', seq_cache: '1', seq_cycle: false };
const PLAIN_TABLES = ['meta', 'guild_ownership', 'shard_claims', 'claim_clock', 'shard_nodes', 'reshard', 'identify_slots', 'guild_data_graveyard', 'guild_requests', 'shared_docs', 'shared_lines', 'shared_modules', 'shared_module_files', 'shared_module_status', 'shared_ops'];
const PARTITIONED = ['guild_data', 'guild_append'];
const SEQUENCES = ['claim_seq', 'guild_append_seq', 'shared_rev_seq'];
const partitionNames = (t: string) => Array.from({ length: 32 }, (_, i) => [`${t}_p${String(i).padStart(2, '0')}`, i] as const);

function madeFound(extra: Row = {}): Row {
  const relations = [
    ...PLAIN_TABLES.map(t => fr(t, 'r')),
    ...PARTITIONED.map(t => fr(t, 'p')),
    ...SEQUENCES.map(s => fr(s, 'S')),
    ...PARTITIONED.flatMap(t => partitionNames(t).map(([p]) => fr(p, 'r', { is_partition: true }))),
  ];
  return foundRow({ relations, ...extra });
}

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

const freshScript = (extra: Partial<Script> = {}): Script => ({
  found: call => (call === 1 ? EMPTY_FOUND : madeFound()),
  catalog: madeCatalog,
  ...extra,
});

const token: FenceToken = { nodeId: 'node-a', claim: 7, processId: 'p-a', shardId: 0, shardCount: 1 };

describe('rh1: a fresh store gets its version row and its store id as stored bytes', () => {
  it('writes {"v":SCHEMA_VERSION} as the schema_version and a JSON-quoted UUID as the store id, then serves', async () => {
    quiet();
    const { backend, sent } = scripted(freshScript());
    await internals(backend).provision();
    expect(await backend.provisionVerdict()).toEqual({ state: 'provisioned' });
    const version = sent.filter(s => VERSION_INSERT.test(s.sql));
    expect(version.map(s => s.values)).toEqual([[`{"v":${pg.SCHEMA_VERSION}}`]]);
    const storeId = sent.filter(s => STORE_ID_INSERT.test(s.sql));
    expect(storeId).toHaveLength(1);
    expect(storeId[0].values).toHaveLength(1);
    expect(JSON.parse(String(storeId[0].values[0]))).toMatch(UUID);
    expect(sent[sent.length - 1].sql).toBe('COMMIT');
    expect(backend.servesData()).toBe(true);
  });
});

describe('rh1: a store of the right shape that lacks its store_id row and whose machine records none', () => {
  it('gets one new store id, a JSON-quoted UUID, and serves', async () => {
    quiet();
    const { backend, sent } = scripted({ version: CURRENT, storeId: [] });
    await internals(backend).provision();
    expect(await backend.provisionVerdict()).toEqual({ state: 'provisioned' });
    const storeId = sent.filter(s => STORE_ID_INSERT.test(s.sql));
    expect(storeId).toHaveLength(1);
    expect(storeId[0].values).toHaveLength(1);
    expect(JSON.parse(String(storeId[0].values[0]))).toMatch(UUID);
    expect(sent[sent.length - 1].sql).toBe('COMMIT');
  });
});

describe('rh1: a fresh store whose role lost USAGE on smdb_data after the schema was made', () => {
  it('is rolled back and refused, naming USAGE on schema smdb_data', async () => {
    const { error } = quiet();
    const { backend, sent } = scripted(freshScript({ found: call => (call === 1 ? EMPTY_FOUND : madeFound({ schema_usage: false })) }));
    await internals(backend).provision();
    const verdict = await backend.provisionVerdict() as { state: string; reason: string };
    expect(verdict.state).toBe('shape');
    expect(verdict.reason).toContain("this bot's database role smdb_bot lacks USAGE on schema smdb_data");
    expect(lines(error)).toContain("[PostgresBackend] schema difference: this bot's database role smdb_bot lacks USAGE on schema smdb_data");
    expect(sent.some(s => VERSION_INSERT.test(s.sql) || STORE_ID_INSERT.test(s.sql))).toBe(false);
    expect(sent[sent.length - 1].sql).toBe('ROLLBACK');
    expect(backend.servesData()).toBe(false);
  });
});

describe('rh1: a server error with no message from the schema DDL', () => {
  const ddlFailure = (sql: string) => (sql === 'CREATE SCHEMA IF NOT EXISTS smdb_data' ? { code: '42501', severity: 'ERROR' } : undefined);

  it('is refused with an empty server message in the reason', async () => {
    quiet();
    const { backend } = scripted(freshScript({ fail: ddlFailure }));
    await internals(backend).provision();
    const verdict = await backend.provisionVerdict() as { state: string; reason: string };
    expect(verdict.state).toBe('shape');
    expect(verdict.reason).toBe('the bot could not make its schema in the database (SQLSTATE 42501: ); nothing was committed');
  });

  it('puts the backend in outage from the moment of the refusal', async () => {
    quiet();
    const { backend } = scripted(freshScript({ fail: ddlFailure }));
    const before = Date.now();
    await internals(backend).provision();
    const state = backend.connectionState();
    expect(state.state).toBe('outage');
    expect(typeof state.outageSinceMs).toBe('number');
    expect(state.outageSinceMs as number).toBeGreaterThanOrEqual(before);
    expect(state.outageSinceMs as number).toBeLessThanOrEqual(Date.now());
  });

  it('a later restore is refused naming that the bot could not make its schema', async () => {
    const { error } = quiet();
    const { backend } = scripted(freshScript({ fail: ddlFailure }));
    await internals(backend).provision();
    const outcome = await backend.restoreGuild('g1', null, token, () => null, 0n);
    expect(outcome).toEqual({ ok: false, reason: 'schema-mismatch' });
    expect(lines(error)).toContain('[PostgresBackend] Refused restore for guild g1: the bot could not make its schema in the database');
  });
});

describe('rh1: a hold that began before the refusal latched', () => {
  it('keeps the outage start of the hold', async () => {
    quiet();
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let holdStart = 0;
    let backendRef: Backend | undefined;
    let held = false;
    const { backend } = scripted(freshScript({
      fail: sql => (sql === 'CREATE SCHEMA IF NOT EXISTS smdb_data' ? { code: '42501', severity: 'ERROR', message: 'permission denied' } : undefined),
      onSend: sql => {
        if (sql !== 'ROLLBACK' || held || !backendRef) return;
        held = true;
        holdStart = now;
        backendRef.noteLapse();
        now += 5000;
      },
    }));
    backendRef = backend;
    await internals(backend).provision();
    expect(held).toBe(true);
    const state = backend.connectionState();
    expect(state.state).toBe('outage');
    expect(state.outageSinceMs).toBe(holdStart);
  });
});

describe('rh1: the bootstrap lock', () => {
  it('a lock read that answers no row is taken as not locked: the bot waits, asks again and provisions', async () => {
    const { log } = quiet();
    const { backend, sent } = scripted({ version: CURRENT, lock: call => (call === 1 ? [] : [{ locked: true }]) });
    internals(backend).sleep = async () => {};
    await expect(internals(backend).provision()).resolves.toBeUndefined();
    expect(sent.filter(s => LOCK.test(s.sql))).toHaveLength(2);
    expect(lines(log).filter(l => l.startsWith('[PostgresBackend] Waiting for the bootstrap lock'))).toHaveLength(1);
    expect(await backend.provisionVerdict()).toEqual({ state: 'provisioned' });
  });

  it('a backend stopped while the lock is held elsewhere rolls back at once, with no wait and no wait line', async () => {
    const { log } = quiet();
    let backendRef: Backend | undefined;
    const { backend, sent } = scripted({
      version: CURRENT,
      lock: () => {
        void backendRef?.stop();
        return [{ locked: false }];
      },
    });
    backendRef = backend;
    const sleep = vi.fn(async () => {});
    internals(backend).sleep = sleep;
    await internals(backend).provision();
    const at = sent.findIndex(s => LOCK.test(s.sql));
    expect(sent.slice(at).map(s => s.sql)).toEqual([sent[at].sql, 'ROLLBACK']);
    expect(sleep).not.toHaveBeenCalled();
    expect(lines(log).filter(l => l.startsWith('[PostgresBackend] Waiting for the bootstrap lock'))).toEqual([]);
    expect(backend.servesData()).toBe(false);
  });

  it('a backend stopped during the wait rolls back without asking for the lock again', async () => {
    quiet();
    const { backend, sent } = scripted({ version: CURRENT, lock: () => [{ locked: false }] });
    internals(backend).sleep = async () => { void backend.stop(); };
    await internals(backend).provision();
    expect(sent.filter(s => LOCK.test(s.sql))).toHaveLength(1);
    expect(sent[sent.length - 1].sql).toBe('ROLLBACK');
    expect(sent.some(s => s.sql === 'SHOW server_version_num')).toBe(false);
  });
});
