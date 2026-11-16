import { afterEach, describe, expect, it, vi } from 'vitest';

import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { fixedChooser } from '../helpers/fixedDatabase';

// NB35 (2): provision(), the boot's own check, against a scripted client. While this machine's marker records a store
// id, a database with no smdb_data schema (or one whose smdb_data holds no relation) is refused after the reads and
// before any DDL: nothing is created or inserted, the transaction rolls back, and the refusal names the recorded store
// id and says the configured database holds no store.

const backends: PostgresBackend[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const backend of backends.splice(0)) await backend.stop();
});

const LOCK = /^SELECT pg_try_advisory_xact_lock\(hashtext\('smdb_data_bootstrap'\)\) AS locked$/;
const FOUND = /has_database_privilege/;
const NO_SCHEMA = { role: 'smdb_bot', db: 'smdb', db_create: true, schema_exists: false, schema_usage: null, schema_create: null, relations: [], meta: null };
const EMPTY_SCHEMA = { ...NO_SCHEMA, schema_exists: true, schema_usage: true, schema_create: true };
const KEPT = 'Gates stay closed and nothing in the database was changed; ';

function scripted(found: Record<string, unknown>, markerStoreId: () => string | null) {
  const backend = new PostgresBackend({ chooser: fixedChooser('postgres://nobody@127.0.0.1:9/none'), markerStoreId });
  backends.push(backend);
  const sent: string[] = [];
  const client = {
    query: async (statement: string | { text: string }) => {
      const sql = (typeof statement === 'string' ? statement : statement.text).trim();
      sent.push(sql);
      if (LOCK.test(sql)) return { rows: [{ locked: true }], rowCount: 1 };
      if (sql === 'SHOW server_version_num') return { rows: [{ server_version_num: '160004' }], rowCount: 1 };
      if (sql === 'SHOW server_encoding') return { rows: [{ server_encoding: 'UTF8' }], rowCount: 1 };
      if (FOUND.test(sql)) return { rows: [found], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  (backend.getPool() as unknown as { connect: unknown }).connect = vi.fn(async () => client);
  return { backend, sent };
}

const provision = (b: PostgresBackend) => (b as unknown as { provision(): Promise<void> }).provision();

function quiet() {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

describe('NB35 (2): a marker that records a store id, and a database that holds no store', () => {
  it('no smdb_data schema: refused before any DDL, nothing written, the refusal names the recorded store', async () => {
    const errors = quiet();
    const { backend, sent } = scripted(NO_SCHEMA, () => 'store-a');
    await provision(backend);
    const reason = "this machine's /data/.backend.json records store store-a, but the configured database smdb holds no store (it has no smdb_data schema), so this bot made no store there";
    expect(await backend.provisionVerdict()).toEqual({
      state: 'shape',
      reason,
      fix: `${KEPT}point DATA_BACKEND_URL, in the web UI env editor, at the database that holds store store-a, or restore that store's backup into this database, then restart the bot; or, to start a new, empty store in this database, set storeId to null in /data/.backend.json and restart the bot (the old store's data is not in this database)`,
    });
    expect(sent.filter(s => /^(CREATE|INSERT|ALTER|UPDATE|DELETE)/.test(s))).toEqual([]);
    expect(sent.filter(s => /^(COMMIT|ROLLBACK)$/.test(s))).toEqual(['ROLLBACK']);
    expect(backend.servesData()).toBe(false);
    expect(errors.mock.calls.map(c => String(c[0]))).toContain(`[PostgresBackend] schema-mismatch: ${reason}; refusing to serve`);
  });

  it('an smdb_data schema with no relation: refused the same way, naming the empty schema', async () => {
    quiet();
    const { backend, sent } = scripted(EMPTY_SCHEMA, () => 'store-a');
    await provision(backend);
    const verdict = await backend.provisionVerdict();
    expect(verdict).toMatchObject({ state: 'shape' });
    expect((verdict as { reason: string }).reason).toBe("this machine's /data/.backend.json records store store-a, but the configured database smdb holds no store (its smdb_data schema holds no table), so this bot made no store there");
    expect(sent.filter(s => /^(CREATE|INSERT|ALTER|UPDATE|DELETE)/.test(s))).toEqual([]);
    expect(sent.filter(s => /^(COMMIT|ROLLBACK)$/.test(s))).toEqual(['ROLLBACK']);
  });
});
