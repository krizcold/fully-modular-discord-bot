import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ sent: [] as string[], sessions: 0 }));

vi.mock('../../src/bot/internalSetup/utils/pgClient', async importOriginal => ({
  ...(await importOriginal<object>()),
  shortLivedClient: () => {
    h.sessions += 1;
    return {
      connect: async () => {},
      end: async () => {},
      query: async (config: { text: string }) => {
        const sql = config.text.trim();
        h.sent.push(sql);
        if (sql === 'SHOW server_version_num') return { rows: [{ server_version_num: '160004' }], rowCount: 1 };
        if (sql === 'SHOW server_encoding') return { rows: [{ server_encoding: 'UTF8' }], rowCount: 1 };
        if (/has_database_privilege/.test(sql)) return { rows: [FOUND], rowCount: 1 };
        if (/^SELECT value::text FROM ONLY smdb_data\.meta WHERE key = 'schema_version'/.test(sql)) {
          return { rows: [{ value: JSON.stringify({ v: SCHEMA_VERSION }) }], rowCount: 1 };
        }
        if (/^SELECT value FROM ONLY smdb_data\.meta WHERE key = 'store_id'/.test(sql)) return { rows: [{ value: '"store-a"' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    };
  },
}));

import { PostgresBackend, SCHEMA_VERSION } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import type { DatabaseChooser } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';

const GOOD_META = { kind: 'r', key_text: true, value_text: true, value_not_null: true, rls: false, unique_key: true, select: true };
const FOUND = {
  role: 'smdb_bot', db: 'smdb', db_create: true, schema_exists: true, schema_usage: true, schema_create: true,
  relations: [
    { name: 'meta', kind: 'r', is_partition: false, select: true, insert: true, update: true, delete: true, usage: null, update_seq: null },
    { name: 'meta_pkey', kind: 'i', is_partition: false, select: null, insert: null, update: null, delete: null, usage: null, update_seq: null },
  ],
  meta: GOOD_META,
};

const FROM = 'postgres://nobody@127.0.0.1:9/from';
const TO = 'postgres://nobody@127.0.0.1:9/to';
const backends: PostgresBackend[] = [];

afterEach(async () => {
  for (const backend of backends.splice(0)) await backend.stop();
  vi.restoreAllMocks();
});

function chooser(): DatabaseChooser {
  return {
    chosen: () => FROM,
    awaitChoice: async () => FROM,
    lastPassLogin: () => 'unreachable',
    holdStarted() {},
    confirmNow() {},
    stop() {},
  };
}

describe('a move with no steps set by the shard layer', () => {
  it('moves to a target whose check passes and lifts the latch', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.sent = [];
    const backend = new PostgresBackend({ chooser: chooser() });
    backends.push(backend);
    backend.latch({ kind: 'replaced', machine: 'machine-b', generation: 2 });
    expect(backend.latchReason()).not.toBeNull();
    const moved = await backend.useDatabase(TO);
    expect(h.sent).toContain('ROLLBACK');
    expect(moved).toBe(true);
    expect(backend.latchReason()).toBeNull();
    expect(backend.chosenEntry()).toBe(TO);
    expect(backend.isMoving()).toBe(false);
  });
});
