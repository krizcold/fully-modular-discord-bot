import { afterEach, describe, expect, it, vi } from 'vitest';

import { PostgresBackend, SCHEMA_VERSION } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { ddlErrorRetries, refusalLogLines, schemaDdlRefusal, scratchRefusal } from '../../src/bot/internalSetup/utils/dataBackends/storeShape';
import { fixedChooser } from '../helpers/fixedDatabase';

// NB16 code review round 3: an error building the scratch copy, by SQLSTATE class (NB16-R3-RUN-1), and a marker that
// exists but can't be read when a store lacks its store_id row (NB16-R3-RUN-2).

const backends: PostgresBackend[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const backend of backends.splice(0)) await backend.stop();
});

type Answer = (sql: string) => unknown;

function scripted(answer: Answer, markerStoreId?: () => string | null) {
  const backend = new PostgresBackend({ chooser: fixedChooser('postgres://nobody@127.0.0.1:9/none'), markerStoreId });
  backends.push(backend);
  const sent: string[] = [];
  const releases: unknown[] = [];
  const client = {
    query: async (statement: string | { text: string }) => {
      const sql = (typeof statement === 'string' ? statement : statement.text).trim();
      sent.push(sql);
      const res = answer(sql);
      if (res instanceof Error) throw res;
      return res ?? { rows: [], rowCount: 0 };
    },
    release: (arg?: unknown) => { releases.push(arg); },
  };
  (backend.getPool() as unknown as { connect: unknown }).connect = vi.fn(async () => client);
  return { backend, sent, releases };
}

const internals = (b: PostgresBackend) => b as unknown as { provision(): Promise<void>; provisioned: boolean; schemaMismatch: boolean; sleep(ms: number): Promise<void> };
const quiet = () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  return { warn: vi.spyOn(console, 'warn').mockImplementation(() => {}), error: vi.spyOn(console, 'error').mockImplementation(() => {}) };
};

const serverError = (code: string, message: string, severity = 'ERROR') => Object.assign(new Error(message), { severity, code });
const META = { kind: 'r', key_text: true, value_text: true, value_not_null: true, rls: false, unique_key: true, select: true };
const metaRel = { name: 'meta', kind: 'r', is_partition: false, select: true, insert: true, update: true, delete: true, usage: null, update_seq: null };
const STORE = { role: 'smdb_bot', db: 'smdb', db_create: true, schema_exists: true, schema_usage: true, schema_create: true, relations: [metaRel], meta: META };
const EMPTY = { role: 'smdb_bot', db: 'smdb', db_create: true, schema_exists: false, schema_usage: null, schema_create: null, relations: [], meta: null };
const SCRATCH_META = /^CREATE TABLE IF NOT EXISTS smdb_shape_[0-9a-f]{12}\.meta /;

const FRESH_META = /^CREATE TABLE IF NOT EXISTS smdb_data\.meta /;

function store(opts: { scratchError?: Error; freshError?: Error; storeIdRows?: unknown[]; found?: unknown } = {}): Answer {
  return sql => {
    if (opts.freshError && FRESH_META.test(sql)) return opts.freshError;
    if (/pg_try_advisory_xact_lock/.test(sql)) return { rows: [{ locked: true }], rowCount: 1 };
    if (sql === 'SHOW server_version_num') return { rows: [{ server_version_num: '160004' }], rowCount: 1 };
    if (sql === 'SHOW server_encoding') return { rows: [{ server_encoding: 'UTF8' }], rowCount: 1 };
    if (/has_database_privilege/.test(sql)) return { rows: [opts.found ?? STORE], rowCount: 1 };
    if (/key = 'schema_version'/.test(sql)) return { rows: [{ value: JSON.stringify({ v: SCHEMA_VERSION }) }], rowCount: 1 };
    if (/^SELECT 1 FROM ONLY smdb_data\.meta WHERE key = 'store_id'/.test(sql)) {
      const rows = opts.storeIdRows ?? [{ '?column?': 1 }];
      return { rows, rowCount: rows.length };
    }
    if (opts.scratchError && SCRATCH_META.test(sql)) return opts.scratchError;
    return undefined;
  };
}

const writes = (sent: string[]) => sent.filter(s => /^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(s) && /smdb_data\./.test(s));
const ends = (sent: string[]) => sent.filter(s => /^(COMMIT|ROLLBACK)$/.test(s));

describe('NB16-R3-RUN-1: which errors building the scratch the boot retries', () => {
  it.each([
    ['a socket error with no SQLSTATE', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })],
    ['the client-side timeout', new Error('Query read timeout')],
    ['class 08', serverError('08006', 'connection failure')],
    ['class 40', serverError('40P01', 'deadlock detected')],
    ['class 53', serverError('53100', 'could not extend file: No space left on device')],
    ['class 57', serverError('57014', 'canceling statement due to statement timeout')],
    ['class 58', serverError('58030', 'could not write to file')],
    ['a FATAL server error', serverError('42501', 'permission denied', 'FATAL')],
  ])('retries %s', (_name, error) => {
    expect(ddlErrorRetries(error)).toBe(true);
  });

  it.each([
    ['42501', serverError('42501', 'permission denied for tablespace fast')],
    ['0A000', serverError('0A000', 'feature not supported')],
    ['P0001', serverError('P0001', 'new tables are not allowed')],
    ['XX000', serverError('XX000', 'cache lookup failed')],
  ])('refuses %s', (_code, error) => {
    expect(ddlErrorRetries(error)).toBe(false);
  });
});

describe("NB16-R3-RUN-1: a store of this bot's version whose scratch can not be built", () => {
  it('a privilege error refuses with the SQLSTATE, the message and the privilege fix, with nothing written', async () => {
    const { error } = quiet();
    const { backend, sent, releases } = scripted(store({ scratchError: serverError('42501', 'permission denied for tablespace fast') }));
    await internals(backend).provision();
    const refusal = scratchRefusal('42501', 'permission denied for tablespace fast', 'smdb_bot', 'smdb');
    expect(refusal.reason).toBe('the bot could not build its copy of its schema to compare with (SQLSTATE 42501: permission denied for tablespace fast), so smdb_data was not compared; smdb_data was not changed');
    expect(refusal.fix).toBe("Gates stay closed and nothing in the database was changed; the server refused this bot's database role smdb_bot a privilege (the message above names it): grant that privilege to smdb_bot, or correct the event trigger that raises the error (listed by SELECT evtname FROM pg_event_trigger), or point DATA_BACKEND_URL, in the web UI env editor, at a login that holds these privileges, then restart the bot");
    expect(refusal.header).toBe(`schema-mismatch: ${refusal.reason}; refusing to serve`);
    expect(await backend.provisionVerdict()).toEqual({ state: 'shape', reason: refusal.reason, fix: refusal.fix });
    expect(error.mock.calls.map(c => String(c[0]))).toEqual(refusalLogLines(refusal));
    expect(writes(sent)).toEqual([]);
    expect(ends(sent)).toEqual(['ROLLBACK']);
    expect(sent[sent.length - 1]).toBe('ROLLBACK');
    expect(releases).toEqual([undefined]);
    expect(backend.servesData()).toBe(false);
  });

  it('a privilege error on a schema gets the same privilege fix, never GRANT CREATE ON DATABASE', async () => {
    quiet();
    const { backend } = scripted(store({ scratchError: serverError('42501', 'permission denied for schema public') }));
    await internals(backend).provision();
    const refusal = scratchRefusal('42501', 'permission denied for schema public', 'smdb_bot', 'smdb');
    expect(refusal.fix).toBe("Gates stay closed and nothing in the database was changed; the server refused this bot's database role smdb_bot a privilege (the message above names it): grant that privilege to smdb_bot, or correct the event trigger that raises the error (listed by SELECT evtname FROM pg_event_trigger), or point DATA_BACKEND_URL, in the web UI env editor, at a login that holds these privileges, then restart the bot");
    expect(refusal.fix).not.toContain('GRANT CREATE ON DATABASE');
    expect(await backend.provisionVerdict()).toEqual({ state: 'shape', reason: refusal.reason, fix: refusal.fix });
  });

  it('any other error names the cause in the database', async () => {
    quiet();
    const { backend, sent } = scripted(store({ scratchError: serverError('P0001', 'new tables are not allowed') }));
    await internals(backend).provision();
    const refusal = scratchRefusal('P0001', 'new tables are not allowed', 'smdb_bot', 'smdb');
    expect(refusal.fix).toBe("Gates stay closed and nothing in the database was changed; correct the cause the server's message names in database smdb (an event trigger that rejects new tables is listed by SELECT evtname FROM pg_event_trigger) and restart the bot");
    expect(await backend.provisionVerdict()).toEqual({ state: 'shape', reason: refusal.reason, fix: refusal.fix });
    expect(ends(sent)).toEqual(['ROLLBACK']);
  });

  it('a fresh database whose scratch fails is refused the same way, with nothing committed', async () => {
    quiet();
    const { backend, sent } = scripted(store({ found: EMPTY, scratchError: serverError('42501', 'permission denied for tablespace fast') }));
    await internals(backend).provision();
    const refusal = scratchRefusal('42501', 'permission denied for tablespace fast', 'smdb_bot', 'smdb');
    expect(await backend.provisionVerdict()).toEqual({ state: 'shape', reason: refusal.reason, fix: refusal.fix });
    expect(sent.filter(s => /^INSERT/.test(s))).toEqual([]);
    expect(ends(sent)).toEqual(['ROLLBACK']);
  });

  // MB2: under NB5's spoil rule an error that is no answer sends nothing more on the client, which is destroyed.
  it.each([
    ['a statement timeout (57014)', serverError('57014', 'canceling statement due to statement timeout'), ['ROLLBACK']],
    ['an error with no SQLSTATE', new Error('Connection terminated unexpectedly'), []],
  ] as Array<[string, Error, string[]]>)('%s fails the attempt for bootstrapLoop to retry, with no latch', async (_name, failure, closing) => {
    quiet();
    const { backend, sent, releases } = scripted(store({ scratchError: failure }));
    await expect(internals(backend).provision()).rejects.toBe(failure);
    expect(internals(backend).schemaMismatch).toBe(false);
    expect(internals(backend).provisioned).toBe(false);
    expect(ends(sent)).toEqual(closing);
    if (closing.length === 0) expect(sent[sent.length - 1]).toMatch(SCRATCH_META);
    expect(releases).toEqual([true]);
  });
});

describe('NB16-R4-RUN-1: an error making the schema of a fresh smdb_data', () => {
  it('a privilege error rolls back and refuses with the fresh text and the privilege fix', async () => {
    const { error } = quiet();
    const { backend, sent, releases } = scripted(store({ found: EMPTY, freshError: serverError('42501', 'permission denied for tablespace fast') }));
    await internals(backend).provision();
    const refusal = schemaDdlRefusal('42501', 'permission denied for tablespace fast', 'smdb_bot', 'smdb');
    expect(refusal.reason).toBe('the bot could not make its schema in the database (SQLSTATE 42501: permission denied for tablespace fast); nothing was committed');
    expect(refusal.fix).toBe("Gates stay closed and nothing in the database was changed; the server refused this bot's database role smdb_bot a privilege (the message above names it): grant that privilege to smdb_bot, or correct the event trigger that raises the error (listed by SELECT evtname FROM pg_event_trigger), or point DATA_BACKEND_URL, in the web UI env editor, at a login that holds these privileges, then restart the bot");
    expect(refusal.header).toBe(`schema-mismatch: ${refusal.reason}; refusing to serve`);
    expect(await backend.provisionVerdict()).toEqual({ state: 'shape', reason: refusal.reason, fix: refusal.fix });
    expect(error.mock.calls.map(c => String(c[0]))).toEqual(refusalLogLines(refusal));
    expect(sent.some(s => /smdb_shape_/.test(s))).toBe(false);
    expect(sent.filter(s => /^INSERT/.test(s))).toEqual([]);
    expect(ends(sent)).toEqual(['ROLLBACK']);
    expect(sent[sent.length - 1]).toBe('ROLLBACK');
    expect(releases).toEqual([undefined]);
    expect(internals(backend).provisioned).toBe(false);
    expect(backend.servesData()).toBe(false);
  });

  it('an event trigger error (P0001) refuses naming the cause in the database', async () => {
    quiet();
    const { backend, sent } = scripted(store({ found: EMPTY, freshError: serverError('P0001', 'new tables are not allowed') }));
    await internals(backend).provision();
    const refusal = schemaDdlRefusal('P0001', 'new tables are not allowed', 'smdb_bot', 'smdb');
    expect(refusal.reason).toBe('the bot could not make its schema in the database (SQLSTATE P0001: new tables are not allowed); nothing was committed');
    expect(refusal.fix).toBe("Gates stay closed and nothing in the database was changed; correct the cause the server's message names in database smdb (an event trigger that rejects new tables is listed by SELECT evtname FROM pg_event_trigger) and restart the bot");
    expect(await backend.provisionVerdict()).toEqual({ state: 'shape', reason: refusal.reason, fix: refusal.fix });
    expect(sent.filter(s => /^INSERT/.test(s))).toEqual([]);
    expect(ends(sent)).toEqual(['ROLLBACK']);
  });

  // MB2: under NB5's spoil rule an error that is no answer sends nothing more on the client, which is destroyed.
  it.each([
    ['a statement timeout (57014)', serverError('57014', 'canceling statement due to statement timeout'), ['ROLLBACK']],
    ['a deadlock (40P01)', serverError('40P01', 'deadlock detected'), ['ROLLBACK']],
    ['a FATAL server error', serverError('42501', 'permission denied', 'FATAL'), []],
    ['an error with no SQLSTATE', new Error('Connection terminated unexpectedly'), []],
  ] as Array<[string, Error, string[]]>)('%s fails the attempt for bootstrapLoop to retry, with no latch', async (_name, failure, closing) => {
    quiet();
    const { backend, sent, releases } = scripted(store({ found: EMPTY, freshError: failure }));
    await expect(internals(backend).provision()).rejects.toBe(failure);
    expect(internals(backend).schemaMismatch).toBe(false);
    expect(internals(backend).provisioned).toBe(false);
    expect(ends(sent)).toEqual(closing);
    if (closing.length === 0) expect(sent[sent.length - 1]).toMatch(FRESH_META);
    expect(releases).toEqual([true]);
  });
});

describe('NB16-R3-RUN-2: a marker that exists but can not be read', () => {
  const unreadable = () => { throw new Error("this machine's marker /data/.backend.json cannot be parsed, so the store id it records is unknown; no store id was written and nothing was refused"); };

  it('fails the attempt: no store id written, nothing refused, rolled back', async () => {
    quiet();
    const { backend, sent } = scripted(store({ storeIdRows: [] }), unreadable);
    await expect(internals(backend).provision()).rejects.toThrow("this machine's marker /data/.backend.json cannot be parsed");
    expect(writes(sent)).toEqual([]);
    expect(ends(sent)).toEqual(['ROLLBACK']);
    expect(internals(backend).schemaMismatch).toBe(false);
  });

  it('bootstrapLoop logs the marker and retries; once the marker reads with no id, a new one is written', async () => {
    const { warn } = quiet();
    let calls = 0;
    const marker = () => {
      calls += 1;
      if (calls === 1) unreadable();
      return null;
    };
    const { backend, sent } = scripted(store({ storeIdRows: [] }), marker);
    (backend.getPool() as unknown as { query: unknown }).query = async () => ({ rows: [{ in_recovery: false }], rowCount: 1 });
    internals(backend).sleep = async () => {};
    backend.start();
    expect(await backend.provisionVerdict()).toEqual({ state: 'provisioned' });
    const failed = warn.mock.calls.filter(c => String(c[0]).startsWith('[PostgresBackend] Bootstrap attempt'));
    expect(failed).toHaveLength(1);
    expect(String(failed[0][0])).toBe('[PostgresBackend] Bootstrap attempt 1 failed (retrying):');
    expect(String((failed[0][1] as Error).message)).toContain("this machine's marker /data/.backend.json cannot be parsed");
    expect(sent.filter(s => /'store_id'/.test(s) && /^INSERT/.test(s))).toHaveLength(1);
    expect(ends(sent)).toEqual(['ROLLBACK', 'COMMIT']);
  });
});
