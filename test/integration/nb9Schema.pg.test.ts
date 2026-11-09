import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { PostgresBackend, SCHEMA_VERSION } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { checkShape } from '../../src/bot/internalSetup/utils/dataBackends/storeShape';
import { fixedDatabase } from '../helpers/fixedDatabase';
import { startClaimRig, type ClaimRig } from '../helpers/pgClaimRig';

// NB9 test 13 (C9): the store at version 9 holds the reshard row and identify_slots; a store at 8 is refused.

let rig: ClaimRig;
beforeAll(async () => { rig = await startClaimRig(); }, 180_000);
afterAll(async () => { await rig?.stop(); });
afterEach(() => { vi.restoreAllMocks(); });

const columns = async (table: string) => (await rig.direct.query(
  `SELECT column_name, data_type, is_nullable, column_default IS NOT NULL AS has_default
     FROM information_schema.columns WHERE table_schema = 'smdb_data' AND table_name = $1 ORDER BY ordinal_position`, [table])).rows
  .map(r => `${r.column_name} ${r.data_type}${r.is_nullable === 'NO' ? ' not null' : ''}${r.has_default ? ' default' : ''}`);

describe('a store provisioned at version 9', () => {
  it('holds reshard row 1 with failures 0 and every other column NULL, the columns of C9 and identify_slots', async () => {
    expect(SCHEMA_VERSION).toBe(10);
    expect((await rig.direct.query(`SELECT value FROM smdb_data.meta WHERE key = 'schema_version'`)).rows[0].value).toBe('{"v":10}');
    expect((await rig.direct.query(`SELECT * FROM smdb_data.reshard`)).rows).toEqual([{
      id: 1, target: null, target_by: null, target_at: null, attempt: null, from_count: null, to_count: null, method: null,
      state: null, started_by: null, started_at: null, until_at: null, flipped_at: null, ended_at: null, reason: null,
      retry_after: null, failures: 0,
    }]);
    expect(await columns('reshard')).toEqual([
      'id integer not null', 'target integer', 'target_by text', 'target_at timestamp with time zone', 'attempt uuid',
      'from_count integer', 'to_count integer', 'method text', 'state text', 'started_by text',
      'started_at timestamp with time zone', 'until_at timestamp with time zone', 'flipped_at timestamp with time zone',
      'ended_at timestamp with time zone', 'reason text', 'retry_after timestamp with time zone', 'failures integer not null default',
    ]);
    expect(await columns('identify_slots')).toEqual([
      'bucket integer not null', 'last_at timestamp with time zone not null', 'process_id text not null',
    ]);
    expect((await columns('shard_claims')).at(-1)).toBe('ready boolean not null default');
    expect((await columns('shard_nodes')).slice(-7)).toEqual([
      'count_setting integer', 'reshard_overlap boolean not null default', 'memory_room boolean', 'memory_free_mb integer',
      'memory_use_mb integer', 'memory_error text', 'memory_at timestamp with time zone',
    ]);
    await expect(rig.direct.query(`INSERT INTO smdb_data.reshard (id) VALUES (2)`)).rejects.toMatchObject({ code: '23514' });
    await expect(rig.direct.query(`UPDATE smdb_data.reshard SET method = 'other' WHERE id = 1`)).rejects.toMatchObject({ code: '23514' });
    await expect(rig.direct.query(`UPDATE smdb_data.reshard SET state = 'other' WHERE id = 1`)).rejects.toMatchObject({ code: '23514' });
  });

  it("passes NB16's shape check with no difference", async () => {
    const client = await rig.direct.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path = pg_catalog');
      await client.query('SET LOCAL quote_all_identifiers = off');
      const result = await checkShape(client, 'provisioned');
      await client.query('ROLLBACK');
      expect(result.differences).toEqual([]);
    } finally {
      client.release();
    }
  });
});

describe('a store at version 8', () => {
  it('is refused with the schema mismatch line', async () => {
    await rig.direct.query('CREATE DATABASE nb9_v7');
    const url = rig.url.replace(/\/[^/]+$/, '/nb9_v7');
    const first = new PostgresBackend(fixedDatabase(url));
    first.start();
    try {
      expect(await first.provisionVerdict()).toEqual({ state: 'provisioned' });
    } finally {
      await first.stop();
    }
    const v7 = new Pool({ connectionString: url, max: 1 });
    try {
      await v7.query(`UPDATE smdb_data.meta SET value = '{"v":8}' WHERE key = 'schema_version'`);
    } finally {
      await v7.end();
    }
    const lines: string[] = [];
    const capture = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    vi.spyOn(console, 'error').mockImplementation(capture);
    vi.spyOn(console, 'warn').mockImplementation(capture);
    vi.spyOn(console, 'log').mockImplementation(capture);
    const second = new PostgresBackend(fixedDatabase(url));
    second.start();
    try {
      expect(await second.provisionVerdict()).toEqual({ state: 'mismatch', found: '{"v":8}' });
      const until = Date.now() + 30_000;
      while (!lines.some(l => l.includes('schema-mismatch')) && Date.now() < until) await new Promise(resolve => { setTimeout(resolve, 100); });
      expect(lines).toContain('[PostgresBackend] schema-mismatch: smdb_data.meta schema_version is {"v":8}, expected {"v":10}; refusing to serve');
      expect(second.servesData()).toBe(false);
    } finally {
      await second.stop();
    }
  }, 90_000);
});
