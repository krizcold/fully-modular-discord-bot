import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client, type Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { GENERATION_DDL, entryOf, probe, provision, setGeneration, sleep } from '../helpers/nb5Pg';
import { poolFor, startPostgres } from '../helpers/postgres';

// NB5 section 8 [pg] test 1 (decision 4): the probe against a real server, and decision 23's owner_channel row. The
// streaming standby's read of that row is in nb5Standby.pg.test.ts, which has the standby.

let container: StartedPostgreSqlContainer;
let direct: Pool;
let entry: string;
const C = '500000000000000001';

beforeAll(async () => {
  container = await startPostgres();
  direct = poolFor(container);
  entry = entryOf(container);
}, 180_000);
afterAll(async () => {
  await direct?.end();
  await container?.stop();
});
beforeEach(async () => {
  await direct.query('DROP SCHEMA IF EXISTS smdb_manager CASCADE');
});

const one = async (e = entry) => (await probe(e))[0] as any;

describe('the generation row', () => {
  it('a database with no smdb_manager schema answers generation 0', async () => {
    expect(await one()).toMatchObject({ kind: 'answered', generation: 0, machine: null, since: null, inRecovery: false, readOnly: false });
  });

  it('with the table and one row answers its machine, generation and since', async () => {
    await setGeneration(direct, 'node-a', 3, '2026-11-01T10:00:00Z');
    const answer = await one();
    expect(answer).toMatchObject({ kind: 'answered', generation: 3, machine: 'node-a' });
    expect(new Date(answer.since).toISOString()).toBe('2026-11-01T10:00:00.000Z');
  });

  it('two rows, or generation 0, answer failed (unreadable)', async () => {
    await direct.query(GENERATION_DDL);
    await direct.query('ALTER TABLE smdb_manager.generation DROP CONSTRAINT generation_pkey');
    await direct.query("ALTER TABLE smdb_manager.generation DROP CONSTRAINT IF EXISTS generation_generation_check");
    await direct.query("INSERT INTO smdb_manager.generation (one_row, machine, generation) VALUES (true, 'a', 1), (true, 'b', 2)");
    expect(await one()).toMatchObject({ kind: 'failed', cause: 'an unreadable generation (more than one row)' });
    await direct.query('DELETE FROM smdb_manager.generation');
    await direct.query("INSERT INTO smdb_manager.generation (machine, generation) VALUES ('a', 0)");
    expect(await one()).toMatchObject({ kind: 'failed', cause: 'an unreadable generation (0)' });
  });

  it('a role without SELECT on the table answers failed, never 0', async () => {
    await setGeneration(direct, 'node-a', 2);
    await direct.query('DROP ROLE IF EXISTS nb5_noread');
    await direct.query("CREATE ROLE nb5_noread LOGIN PASSWORD 'noread-pw'");
    await direct.query('REVOKE SELECT ON smdb_manager.generation FROM PUBLIC');
    const answer = await one(entryOf(container, { user: 'nb5_noread', password: 'noread-pw' }));
    expect(answer.kind).toBe('failed');
    expect(answer.cause).toBe('an unreadable generation (SQLSTATE 42501)');
  });

  it('the golden fixture of the row: columns and types the manager writes', async () => {
    await direct.query(GENERATION_DDL);
    const columns = (await direct.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'smdb_manager' AND table_name = 'generation' ORDER BY ordinal_position`)).rows
      .map(r => `${r.column_name} ${r.data_type}${r.is_nullable === 'NO' ? ' not null' : ''}`);
    expect(columns).toEqual(['one_row boolean not null', 'machine text not null', 'generation bigint not null', 'since timestamp with time zone not null']);
  });
});

describe('writable, login and store', () => {
  it('default_transaction_read_only on, after a reload, answers not writable (read-only)', async () => {
    await direct.query('ALTER SYSTEM SET default_transaction_read_only = on');
    await direct.query('SELECT pg_reload_conf()');
    await sleep(500);
    try {
      expect(await one()).toMatchObject({ kind: 'answered', readOnly: true, inRecovery: false });
    } finally {
      const reset = new Client({ connectionString: entry });
      await reset.connect();
      await reset.query('SET default_transaction_read_only = off');
      await reset.query('ALTER SYSTEM RESET default_transaction_read_only');
      await reset.query('SELECT pg_reload_conf()');
      await reset.end();
      await sleep(500);
    }
  });

  it('a role with NOLOGIN answers refused (28000); a wrong password answers failed (28P01), not refused', async () => {
    await direct.query('DROP ROLE IF EXISTS nb5_nologin');
    await direct.query("CREATE ROLE nb5_nologin NOLOGIN PASSWORD 'nologin-pw'");
    expect((await one(entryOf(container, { user: 'nb5_nologin', password: 'nologin-pw' }))).kind).toBe('refused');
    expect(await one(entryOf(container, { password: 'not-the-password' }))).toMatchObject({ kind: 'failed', cause: 'a wrong password (28P01)' });
  });

  it('no smdb_data schema answers store id null; a provisioned one its store id', async () => {
    await direct.query('DROP SCHEMA IF EXISTS smdb_data CASCADE');
    expect(await one()).toMatchObject({ kind: 'answered', storeId: null, ownerChannel: { kind: 'none' } });
    await provision(entry, direct, 'store-nb5');
    expect(await one()).toMatchObject({ kind: 'answered', storeId: 'store-nb5' });
  });

  it('owner_channel: a row answers its id, no row none, a value not a JSON string of digits unreadable, the store id still read', async () => {
    await provision(entry, direct, 'store-nb5');
    await direct.query("DELETE FROM smdb_data.meta WHERE key = 'owner_channel'");
    expect(await one()).toMatchObject({ storeId: 'store-nb5', ownerChannel: { kind: 'none' } });
    await direct.query("INSERT INTO smdb_data.meta (key, value) VALUES ('owner_channel', $1)", [JSON.stringify(C)]);
    expect(await one()).toMatchObject({ storeId: 'store-nb5', ownerChannel: { kind: 'id', id: C } });
    await direct.query("UPDATE smdb_data.meta SET value = '12345' WHERE key = 'owner_channel'");
    expect(await one()).toMatchObject({ kind: 'answered', storeId: 'store-nb5', ownerChannel: { kind: 'unreadable' } });
  });
});

describe('round 8, characterization (NB5-R8-OWNER-CHANNEL-LATE-WRITE)', () => {
  it("a session with decision 23's startup options left idle 6 s after connect is ended by the server; an upsert sent then is not applied", async () => {
    await provision(entry, direct, 'store-nb5');
    await direct.query("DELETE FROM smdb_data.meta WHERE key = 'owner_channel'");
    const session = new Client({ connectionString: entry, options: '-c statement_timeout=5000 -c idle_session_timeout=5000' });
    let ended = false;
    session.on('error', () => { ended = true; });
    session.on('end', () => { ended = true; });
    await session.connect();
    await sleep(6_000);
    expect(ended).toBe(true);
    await expect(session.query("INSERT INTO smdb_data.meta (key, value) VALUES ('owner_channel', $1)", [JSON.stringify(C)])).rejects.toBeTruthy();
    const second = await direct.query("SELECT value FROM smdb_data.meta WHERE key = 'owner_channel'");
    expect(second.rows).toEqual([]);
    await session.end().catch(() => undefined);
  }, 20_000);
});
