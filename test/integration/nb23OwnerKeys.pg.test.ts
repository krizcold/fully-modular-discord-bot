import { Pool } from 'pg';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { provisionDdl } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { OWNER_KEY_READ_SQL, ownerKeyStatements } from '../../src/webui/utils/ownerChannel';
import { freshDatabaseUrl, startPostgres } from '../helpers/postgres';

// NB23 (sheets/NB6.md:743-744): the notify-owner key record's statements against a real smdb_data.meta: a key is
// recorded as 'owner-message:<key>' with its time, read back by OWNER_KEY_READ_SQL, and the same transaction deletes
// keys older than 90 days and all but the newest 1000, leaving every other meta row alone.

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => { container = await startPostgres(); }, 180_000);
afterAll(async () => {
  await pool?.end();
  await container?.stop();
});
beforeEach(async () => {
  await pool?.end();
  pool = new Pool({ connectionString: await freshDatabaseUrl(container, 'nb23keys'), max: 2 });
  for (const statement of provisionDdl('smdb_data')) await pool.query(statement);
  await pool.query(`INSERT INTO smdb_data.meta (key, value) VALUES ('store_id', '"s-1"') ON CONFLICT (key) DO NOTHING`);
  await pool.query(`INSERT INTO smdb_data.meta (key, value) VALUES ('owner_channel', '"500000000000000001"') ON CONFLICT (key) DO NOTHING`);
});

async function record(key: string, at: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const st of ownerKeyStatements(key, at)) await client.query(st.text, st.values);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

const read = async (key: string) => (await pool.query(OWNER_KEY_READ_SQL, [`owner-message:${key}`])).rows;
const keyCount = async () => Number((await pool.query(`SELECT count(*) FROM smdb_data.meta WHERE key LIKE 'owner-message:%'`)).rows[0].count);

describe('the key record in smdb_data.meta', () => {
  it('records a key with its time and reads it back; a second record of it keeps one row', async () => {
    await record('backup-1', '2026-11-10T08:00:00.000Z');
    expect(await read('backup-1')).toEqual([{ value: JSON.stringify('2026-11-10T08:00:00.000Z') }]);
    await record('backup-1', '2026-11-10T09:00:00.000Z');
    expect(await keyCount()).toBe(1);
    expect(await read('other')).toEqual([]);
  });

  it('a key with LIKE characters is stored as given', async () => {
    await record('50%_off', '2026-11-10T08:00:00.000Z');
    expect(await read('50%_off')).toHaveLength(1);
  });

  it('deletes keys older than 90 days at the next record, and no other meta row', async () => {
    await record('old', '2026-07-01T00:00:00.000Z');
    await pool.query(`UPDATE smdb_data.meta SET updated_at = now() - interval '91 days' WHERE key = 'owner-message:old'`);
    await record('new', '2026-11-10T08:00:00.000Z');
    expect(await read('old')).toEqual([]);
    expect(await read('new')).toHaveLength(1);
    const others = (await pool.query(`SELECT key FROM smdb_data.meta WHERE key NOT LIKE 'owner-message:%' ORDER BY key`)).rows.map(r => r.key);
    expect(others).toEqual(['owner_channel', 'store_id']);
  });

  it('keeps the newest 1000 keys', async () => {
    await pool.query(`INSERT INTO smdb_data.meta (key, value, updated_at)
      SELECT 'owner-message:bulk-' || g, '"2026-11-01T00:00:00.000Z"', now() - (g || ' minutes')::interval FROM generate_series(1, 1000) g`);
    await record('latest', '2026-11-10T08:00:00.000Z');
    expect(await keyCount()).toBe(1000);
    expect(await read('latest')).toHaveLength(1);
    expect(await read('bulk-1000')).toEqual([]);
    expect(await read('bulk-1')).toHaveLength(1);
    expect((await pool.query(`SELECT 1 FROM smdb_data.meta WHERE key = 'store_id'`)).rowCount).toBe(1);
  });
});
