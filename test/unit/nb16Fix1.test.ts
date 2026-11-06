import { afterEach, describe, expect, it, vi } from 'vitest';

import { PostgresBackend, SCHEMA_VERSION } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import {
  compareShapes, freshRefusal, freshVersionRefusal, serverRelease, serverVersionRefusal, storeIdRefusal,
  type Catalog, type CatalogRelation,
} from '../../src/bot/internalSetup/utils/dataBackends/storeShape';

const CURRENT = JSON.stringify({ v: SCHEMA_VERSION });

// NB16 round 1 fixes: the server version refusal (NB16-RUN-1), the fresh path's unreadable reread (NB16-DL-1), no
// store id on a store that is not fresh (NB16-DL-2), the polled transaction lock (NB16-RUN-2), the client-side bound
// and the destroyed client (NB16-RUN-3), no ready line after a stop (NB16-RUN-4), and an index's attachment (row 29).

const backends: PostgresBackend[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const backend of backends.splice(0)) await backend.stop();
});

type Row = Record<string, unknown>;
type Which = 'relations' | 'columns' | 'constraints' | 'rules';
type Statement = { text: string; values?: unknown[]; query_timeout?: number };

interface Script {
  versionNum?: string;
  locked?: (poll: number) => boolean;
  found?: (call: number) => Row;
  version?: Row[];
  storeId?: Row[];
  catalog?: (schema: string, which: Which) => Row[];
  fail?: (sql: string) => Error | undefined;
  onCommit?: () => Promise<void>;
  markerStoreId?: () => string | null;
}

const META = { kind: 'r', key_text: true, value_text: true, value_not_null: true, rls: false, unique_key: true, select: true };
const metaRel = { name: 'meta', kind: 'r', is_partition: false, select: true, insert: true, update: true, delete: true, usage: null, update_seq: null };
const STORE = { role: 'smdb_bot', db: 'smdb', db_create: true, schema_exists: true, schema_usage: true, schema_create: true, relations: [metaRel], meta: META };
const EMPTY = { role: 'smdb_bot', db: 'smdb', db_create: true, schema_exists: false, schema_usage: null, schema_create: null, relations: [], meta: null };
const MADE = { ...EMPTY, schema_exists: true, schema_usage: true, schema_create: true };

function whichCatalog(sql: string): Which | null {
  if (/pg_get_partkeydef/.test(sql)) return 'relations';
  if (/format_type/.test(sql)) return 'columns';
  if (/pg_get_constraintdef/.test(sql)) return 'constraints';
  if (/pg_get_triggerdef/.test(sql)) return 'rules';
  return null;
}

function scripted(script: Script) {
  const backend = new PostgresBackend({ url: 'postgres://nobody@127.0.0.1:9/none', markerStoreId: script.markerStoreId });
  backends.push(backend);
  const sent: string[] = [];
  const timeouts: Array<number | undefined> = [];
  const releases: unknown[] = [];
  let polls = 0;
  let foundCalls = 0;
  const client = {
    query: async (statement: string | Statement) => {
      const s = typeof statement === 'string' ? { text: statement } : statement;
      const sql = s.text.trim();
      sent.push(sql);
      timeouts.push(s.query_timeout);
      const failure = script.fail?.(sql);
      if (failure) throw failure;
      if (/pg_try_advisory_xact_lock/.test(sql)) return { rows: [{ locked: script.locked ? script.locked(++polls) : true }], rowCount: 1 };
      if (sql === 'SHOW server_version_num') return { rows: [{ server_version_num: script.versionNum ?? '160004' }], rowCount: 1 };
      if (sql === 'SHOW server_encoding') return { rows: [{ server_encoding: 'UTF8' }], rowCount: 1 };
      if (/has_database_privilege/.test(sql)) return { rows: [script.found ? script.found(++foundCalls) : STORE], rowCount: 1 };
      if (/key = 'schema_version'/.test(sql)) return { rows: script.version ?? [], rowCount: (script.version ?? []).length };
      if (/^SELECT 1 FROM ONLY smdb_data\.meta WHERE key = 'store_id'/.test(sql)) {
        const rows = script.storeId ?? [{ '?column?': 1 }];
        return { rows, rowCount: rows.length };
      }
      if (sql === 'COMMIT' && script.onCommit) await script.onCommit();
      const which = whichCatalog(sql);
      if (which) return { rows: script.catalog?.(String(s.values?.[0]), which) ?? [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
    release: (arg?: unknown) => { releases.push(arg); },
  };
  (backend.getPool() as unknown as { connect: unknown }).connect = vi.fn(async () => client);
  return { backend, sent, timeouts, releases };
}

const internals = (b: PostgresBackend) => b as unknown as { provision(): Promise<void>; provisioned: boolean; sleep(ms: number): Promise<void> };
function quiet() {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  return vi.spyOn(console, 'log').mockImplementation(() => {});
}
const writes = (sent: string[]) => sent.filter(s => /^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(s) && /smdb_data\./.test(s));

describe('NB16-RUN-1: a server older than PostgreSQL 13', () => {
  it('names the release a server_version_num gives', () => {
    expect(serverRelease(120017)).toBe('12.17');
    expect(serverRelease(130000)).toBe('13.0');
    expect(serverRelease(90624)).toBe('9.6.24');
  });

  it('is refused before any SET LOCAL or read of smdb_data, with the version and the minimum named', async () => {
    quiet();
    const { backend, sent } = scripted({ versionNum: '120017' });
    await internals(backend).provision();
    const refusal = serverVersionRefusal('12.17');
    expect(await backend.provisionVerdict()).toEqual({ state: 'shape', reason: refusal.reason, fix: refusal.fix });
    expect(refusal.reason).toBe("the database server is PostgreSQL 12.17, and this bot needs PostgreSQL 13 or later; smdb_data was not read");
    expect(refusal.fix).toBe('Gates stay closed and nothing in the database was changed; upgrade the server to PostgreSQL 13 or later, or point DATA_BACKEND_URL, in the web UI env editor, at a database on such a server, then restart the bot');
    expect(sent.map(s => s.split('(')[0].trim())).toEqual([
      'BEGIN', 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED', 'SELECT pg_try_advisory_xact_lock', 'SHOW server_version_num', 'ROLLBACK',
    ]);
    expect(backend.servesData()).toBe(false);
  });

  it('PostgreSQL 13.0 goes on to the check', async () => {
    quiet();
    const { backend, sent } = scripted({ versionNum: '130000', version: [{ value: CURRENT }] });
    await internals(backend).provision();
    expect(sent).toContain('SET LOCAL search_path = pg_catalog');
    expect(await backend.provisionVerdict()).toEqual({ state: 'provisioned' });
  });
});

describe('NB16-DL-1: the fresh path when its version row can not be read back', () => {
  const fresh = (version: Row[], catalog?: Script['catalog']) => scripted({ found: n => (n === 1 ? EMPTY : MADE), version, catalog });

  it('a missing row with the comparison finding nothing is refused as the fresh schema, rolled back, never as another version', async () => {
    quiet();
    const { backend, sent } = fresh([]);
    await internals(backend).provision();
    const refusal = freshVersionRefusal('smdb_data.meta holds no schema_version row');
    expect(await backend.provisionVerdict()).toEqual({ state: 'shape', reason: refusal.reason, fix: refusal.fix });
    expect(refusal.reason).toBe('the schema_version row this bot wrote into the schema it made in the database could not be read back (smdb_data.meta holds no schema_version row), so the schema was rolled back (an event trigger, a rule or another program changes new tables)');
    expect(sent).toContain('SAVEPOINT shape');
    expect(sent.filter(s => /'store_id'/.test(s))).toEqual([]);
    expect(sent.filter(s => /^(COMMIT|ROLLBACK)$/.test(s))).toEqual(['ROLLBACK']);
  });

  it('an unreadable reread names its cause', async () => {
    quiet();
    const { backend } = fresh([{ value: CURRENT }, { value: CURRENT }]);
    await internals(backend).provision();
    const refusal = freshVersionRefusal('smdb_data.meta holds 2 schema_version rows');
    expect(await backend.provisionVerdict()).toEqual({ state: 'shape', reason: refusal.reason, fix: refusal.fix });
  });

  it('a rule that swallowed the insert is named by the comparison', async () => {
    quiet();
    const rel = (name: string) => ({
      name, kind: 'r', persistence: 'p', is_partition: false, rls: false, force_rls: false, access_method: 'heap', partition_key: null,
      bound: null, parent: null, inherits: [], index_def: null, index_valid: null, index_table: null, seq_increment: null,
    });
    const rule = { rel: 'meta', what: 'rule', name: 'swallow', def: 'CREATE RULE swallow AS ON INSERT TO smdb_data.meta DO INSTEAD NOTHING;' };
    const { backend } = fresh([], (schema, which) => {
      if (which === 'relations') return [rel('meta')];
      if (which === 'rules' && schema === 'smdb_data') return [rule];
      return [];
    });
    await internals(backend).provision();
    const refusal = freshRefusal([{ text: `smdb_data.meta has rule swallow (${rule.def}), which this bot's schema does not have`, key: [1, 'meta', 41, 'swallow'] }]);
    expect(await backend.provisionVerdict()).toEqual({ state: 'shape', reason: refusal.reason, fix: refusal.fix });
  });

  it('another version found at the reread answers the fresh refusal, never the version latch', async () => {
    quiet();
    const { backend, sent } = fresh([{ value: '{"v":1}' }]);
    await internals(backend).provision();
    const refusal = freshVersionRefusal(`smdb_data.meta's schema_version reads {"v":1}`);
    expect(await backend.provisionVerdict()).toEqual({ state: 'shape', reason: refusal.reason, fix: refusal.fix });
    expect(sent.filter(s => /^(COMMIT|ROLLBACK)$/.test(s))).toEqual(['ROLLBACK']);
  });
});

describe('NB16-DL-2: a store that is not fresh gets no new store id while the marker records one', () => {
  it('a store of the right shape with no store_id row, its id in the marker, is refused, rolled back, with nothing written', async () => {
    quiet();
    const { backend, sent } = scripted({ version: [{ value: CURRENT }], storeId: [], markerStoreId: () => 'store-1' });
    await internals(backend).provision();
    const refusal = storeIdRefusal('store-1');
    expect(await backend.provisionVerdict()).toEqual({ state: 'shape', reason: refusal.reason, fix: refusal.fix });
    expect(refusal.reason).toBe(`the database's smdb_data matches this bot's schema (version ${SCHEMA_VERSION}) but smdb_data.meta holds no store_id row, and this machine's /data/.backend.json records store store-1, so this bot can't confirm that this database holds that store`);
    expect(writes(sent)).toEqual([]);
    expect(sent.filter(s => /^(COMMIT|ROLLBACK)$/.test(s))).toEqual(['ROLLBACK']);
  });

  it('a store with its store_id row gets the claim_clock row and no store id insert', async () => {
    quiet();
    const { backend, sent } = scripted({ version: [{ value: CURRENT }] });
    await internals(backend).provision();
    expect(await backend.provisionVerdict()).toEqual({ state: 'provisioned' });
    expect(writes(sent).map(s => s.split('(')[0].trim())).toEqual(['INSERT INTO smdb_data.claim_clock']);
    expect(sent[sent.length - 1]).toBe('COMMIT');
  });
});

describe('NB16-RUN-2: the bootstrap lock is a polled transaction lock', () => {
  it('waits for the lock with one log line, then checks; no session lock or unlock is sent', async () => {
    const log = quiet();
    const { backend, sent } = scripted({ version: [{ value: CURRENT }], locked: poll => poll >= 3 });
    const sleeps: number[] = [];
    internals(backend).sleep = async (ms: number) => { sleeps.push(ms); };
    await internals(backend).provision();
    expect(await backend.provisionVerdict()).toEqual({ state: 'provisioned' });
    expect(sent.slice(0, 2)).toEqual(['BEGIN', 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED']);
    expect(sent.slice(2, 5)).toEqual(Array(3).fill(`SELECT pg_try_advisory_xact_lock(hashtext('smdb_data_bootstrap')) AS locked`));
    expect(sleeps).toEqual([1000, 1000]);
    expect(log.mock.calls.map(c => String(c[0]))).toEqual(["[PostgresBackend] Waiting for the bootstrap lock, held by another bot process's schema check or a data migration"]);
    expect(sent.filter(s => /pg_advisory_lock\(|pg_advisory_unlock\(/.test(s))).toEqual([]);
  });

  it('a stop while waiting rolls back and provisions nothing', async () => {
    quiet();
    const { backend, sent } = scripted({ locked: () => false });
    internals(backend).sleep = async () => { await backend.stop(); };
    await internals(backend).provision();
    expect(internals(backend).provisioned).toBe(false);
    expect(sent.filter(s => !/pg_try_advisory_xact_lock/.test(s))).toEqual(['BEGIN', 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED', 'ROLLBACK']);
  });

  it('a lock held past the bound fails the attempt (rolled back) for bootstrapLoop to retry', async () => {
    quiet();
    const { backend, sent, releases } = scripted({ locked: () => false });
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    internals(backend).sleep = async () => { now += 60_000; };
    await expect(internals(backend).provision()).rejects.toThrow("the bootstrap lock stayed held for 300 s by another bot process's schema check or a data migration");
    expect(sent[sent.length - 1]).toBe('ROLLBACK');
    expect(releases).toEqual([true]);
  });
});

describe('NB16-RUN-3: every boot statement carries a client-side bound', () => {
  it('each statement is sent with query_timeout 35000, and the client goes back to the pool', async () => {
    quiet();
    const { backend, timeouts, releases } = scripted({ version: [{ value: CURRENT }] });
    await internals(backend).provision();
    expect(timeouts.length).toBeGreaterThan(10);
    expect(timeouts.every(t => t === 35_000)).toBe(true);
    expect(releases).toEqual([undefined]);
  });

  it('a statement that fails rolls back and destroys the client', async () => {
    quiet();
    const { backend, sent, releases } = scripted({
      version: [{ value: CURRENT }],
      fail: sql => (sql === 'SHOW server_encoding' ? new Error('Query read timeout') : undefined),
    });
    await expect(internals(backend).provision()).rejects.toThrow('Query read timeout');
    expect(sent[sent.length - 1]).toBe('ROLLBACK');
    expect(releases).toEqual([true]);
  });
});

describe('NB16-RUN-4: a stop during the check', () => {
  it('logs no ready line and does not become ready after the commit', async () => {
    const log = quiet();
    let stopping: Promise<void> | undefined;
    const { backend } = scripted({ version: [{ value: CURRENT }], onCommit: async () => { stopping = backend.stop(); } });
    (backend.getPool() as unknown as { query: unknown }).query = async () => ({ rows: [{ in_recovery: false }], rowCount: 1 });
    backend.start();
    await vi.waitFor(() => { expect(stopping).toBeDefined(); });
    await stopping;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(log.mock.calls.map(c => String(c[0]))).not.toContain('[PostgresBackend] Connected and provisioned; backend ready');
    expect(backend.connectionState().state).toBe('connecting');
    expect(backend.servesData()).toBe(false);
  });
});

describe('row 29: an index is not compared for its attachment', () => {
  const relation = (name: string, kind: CatalogRelation['kind'], extra: Partial<CatalogRelation> = {}): CatalogRelation => ({
    name, kind, persistence: 'p', isPartition: false, rls: false, forceRls: false, accessMethod: kind === 'r' ? 'heap' : null,
    partitionKey: null, bound: null, parent: null, inherits: [], indexDef: null, indexValid: null, indexTable: null, sequence: null, ...extra,
  });
  const catalog = (relations: CatalogRelation[]): Catalog => ({ relations, columns: [], constraints: [], rules: [] });
  const bound = 'FOR VALUES WITH (modulus 32, remainder 5)';
  const indexDef = 'CREATE UNIQUE INDEX guild_data_p05_pkey ON smdb_data.guild_data_p05 USING btree (guild_id, module, filename)';

  it('a detached partition gives one sentence, not a second one for its index', () => {
    const reference = catalog([
      relation('guild_data_p05', 'r', { isPartition: true, parent: 'smdb_data.guild_data', bound }),
      relation('guild_data_p05_pkey', 'i', { isPartition: true, parent: 'smdb_data.guild_data_pkey', indexDef, indexValid: true, indexTable: 'guild_data_p05' }),
    ]);
    const found = catalog([
      relation('guild_data_p05', 'r'),
      relation('guild_data_p05_pkey', 'i', { indexDef, indexValid: true, indexTable: 'guild_data_p05' }),
    ]);
    expect(compareShapes(found, reference, 'provisioned').differences.map(d => d.text)).toEqual([
      `smdb_data.guild_data_p05 is not a partition, where this bot's schema has a partition of smdb_data.guild_data ${bound}`,
    ]);
  });
});
