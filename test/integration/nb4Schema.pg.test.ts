import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresBackend, SCHEMA_VERSION } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { fixedDatabase } from '../helpers/fixedDatabase';
import { startClaimRig, type ClaimRig } from '../helpers/pgClaimRig';

// NB4 decision 1: version 3 provisions the claims table, the claim clock with its one row, the machines table, the
// meta key and the index the claim floor reads. The column list is the golden fixture NM9 and NM6 are built against.

let rig: ClaimRig;
beforeAll(async () => { rig = await startClaimRig(); }, 180_000);
afterAll(async () => { await rig?.stop(); });

const columns = async (table: string) => (await rig.direct.query(
  `SELECT column_name, data_type, is_nullable, column_default IS NOT NULL AS has_default
     FROM information_schema.columns WHERE table_schema = 'smdb_data' AND table_name = $1 ORDER BY ordinal_position`, [table])).rows
  .map(r => `${r.column_name} ${r.data_type}${r.is_nullable === 'NO' ? ' not null' : ''}${r.has_default ? ' default' : ''}`);

describe('a fresh database', () => {
  it('is provisioned at the current schema version', async () => {
    expect((await rig.direct.query(`SELECT value FROM smdb_data.meta WHERE key = 'schema_version'`)).rows[0].value).toBe(JSON.stringify({ v: SCHEMA_VERSION }));
  });

  it('has the three tables with the columns and types of decision 1', async () => {
    expect(await columns('shard_claims')).toEqual([
      'shard_count integer not null', 'shard_id integer not null', 'claim bigint not null', 'holder_process text not null',
      'holder_node text not null', 'holder_name text not null', 'home_node text not null', 'released boolean not null default',
      'reserved boolean not null default', 'taken_at timestamp with time zone not null default',
      'renewed_at timestamp with time zone not null default', 'ttl_ms bigint not null', 'expires_up_ms bigint not null',
      'extended boolean not null default', 'ready boolean not null default',
    ]);
    expect(await columns('claim_clock')).toEqual([
      'id integer not null', 'up_ms bigint not null', 'ticked_at timestamp with time zone not null', 'last_gap_ms bigint not null default',
    ]);
    expect(await columns('shard_nodes')).toEqual([
      'node_id text not null', 'node_name text not null', 'process_id text not null', 'capacity integer not null',
      'takeover_seconds integer not null', 'fit boolean not null', 'restartable boolean not null', 'returns boolean not null',
      'started_at timestamp with time zone not null', 'healthy_since timestamp with time zone', 'seen_at timestamp with time zone not null',
      'count_setting integer', 'reshard_overlap boolean not null default', 'memory_room boolean', 'memory_free_mb integer',
      'memory_use_mb integer', 'memory_error text', 'memory_at timestamp with time zone',
    ]);
  });

  it('has the clock row at 0, the primary key of a claim row, and the index on guild_ownership (claim)', async () => {
    expect((await rig.direct.query(`SELECT id, up_ms::int AS up FROM smdb_data.claim_clock`)).rows).toEqual([{ id: 1, up: 0 }]);
    await expect(rig.direct.query(`INSERT INTO smdb_data.claim_clock (id, up_ms, ticked_at) VALUES (2, 0, now())`)).rejects.toMatchObject({ code: '23514' });
    const pk = await rig.direct.query(`SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = 'smdb_data.shard_claims'::regclass AND i.indisprimary ORDER BY a.attname`);
    expect(pk.rows.map(r => r.attname)).toEqual(['shard_count', 'shard_id']);
    const idx = await rig.direct.query(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'smdb_data' AND tablename = 'guild_ownership' AND indexname = 'guild_ownership_claim_idx'`);
    expect(idx.rows[0].indexdef).toMatch(/\(claim\)/);
  });
});

describe('a database at {"v":2}', () => {
  it('is refused as a schema mismatch with no row changed', async () => {
    await rig.direct.query('CREATE DATABASE smdb_v2');
    const url = rig.url.replace(/\/[^/]+$/, '/smdb_v2');
    const { Pool } = await import('pg');
    const v2 = new Pool({ connectionString: url, max: 2 });
    try {
      await v2.query('CREATE SCHEMA smdb_data');
      await v2.query(`CREATE TABLE smdb_data.meta (key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
      await v2.query(`INSERT INTO smdb_data.meta (key, value) VALUES ('schema_version', '{"v":2}'), ('store_id', '"s"')`);
      const before = (await v2.query(`SELECT key, value, updated_at FROM smdb_data.meta ORDER BY key`)).rows;
      const backend = new PostgresBackend(fixedDatabase(url));
      backend.start();
      try {
        expect(await backend.provisionVerdict()).toEqual({ state: 'mismatch', found: '{"v":2}' });
      } finally {
        await backend.stop();
      }
      expect((await v2.query(`SELECT key, value, updated_at FROM smdb_data.meta ORDER BY key`)).rows).toEqual(before);
      expect((await v2.query(`SELECT to_regclass('smdb_data.shard_claims') AS t`)).rows[0].t).toBeNull();
    } finally {
      await v2.end();
    }
  });
});
