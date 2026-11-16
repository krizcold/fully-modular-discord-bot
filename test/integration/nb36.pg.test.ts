import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresBackend, SCHEMA_VERSION } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { fixedDatabase } from '../helpers/fixedDatabase';
import { provisionEmptyStore } from '../../src/bot/internalSetup/utils/storeProvision';
import { startClaimRig, type ClaimRig } from '../helpers/pgClaimRig';

// NB36 on real Postgres: `smdb data provision`'s store against the one the bot's own boot provisioned (the rig's
// database), a second run, and a database that already holds the schema smdb_data.

let rig: ClaimRig;

beforeAll(async () => {
  rig = await startClaimRig();
}, 180_000);

afterAll(async () => {
  await rig?.stop();
});

async function freshDatabase(name: string): Promise<string> {
  await rig.direct.query(`CREATE DATABASE ${name}`);
  return rig.url.replace(/\/[^/]*$/, `/${name}`);
}

async function onDatabase<T>(url: string, work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** Every relation, column, constraint and index of smdb_data, by name and definition. */
async function layout(client: Pick<Client, 'query'>): Promise<string[]> {
  const rels = await client.query(`SELECT c.relname || ':' || c.relkind::text AS r FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'smdb_data'`);
  const cols = await client.query(`SELECT table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '') AS r FROM information_schema.columns WHERE table_schema = 'smdb_data'`);
  const cons = await client.query(`SELECT conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid) AS r FROM pg_constraint WHERE connamespace = 'smdb_data'::regnamespace`);
  const idx = await client.query(`SELECT indexname || ':' || indexdef AS r FROM pg_indexes WHERE schemaname = 'smdb_data'`);
  return [...rels.rows, ...cols.rows, ...cons.rows, ...idx.rows].map(row => String(row.r)).sort();
}

/** Rows of pg_inherits under smdb_data: table partitions and their index partitions. */
async function partitionCount(client: Pick<Client, 'query'>): Promise<number> {
  return (await client.query(`SELECT count(*)::int AS n FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'smdb_data'`)).rows[0].n;
}

async function metaRows(client: Pick<Client, 'query'>): Promise<Array<{ key: string; value: string }>> {
  return (await client.query(`SELECT key, value::text AS value FROM smdb_data.meta ORDER BY key`)).rows;
}

describe('smdb data provision on real Postgres', () => {
  it('gives an empty database the layout the boot provisions, at the current version, with a store id and the seed rows', async () => {
    const url = await freshDatabase('nb36fresh');
    const outcome = await provisionEmptyStore(url);
    expect(outcome.state).toBe('created');
    const created = outcome as { storeId: string; version: number };
    expect(created.version).toBe(SCHEMA_VERSION);
    const facts = await onDatabase(url, async client => ({
      layout: await layout(client),
      meta: await metaRows(client),
      clock: (await client.query(`SELECT count(*)::int AS n FROM smdb_data.claim_clock`)).rows[0].n,
      reshard: (await client.query(`SELECT count(*)::int AS n FROM smdb_data.reshard`)).rows[0].n,
      partitions: await partitionCount(client),
    }));
    const booted = await layout(rig.direct);
    expect(facts.layout).toEqual(booted);
    expect(facts.meta).toEqual([
      { key: 'schema_version', value: JSON.stringify({ v: SCHEMA_VERSION }) },
      { key: 'store_id', value: JSON.stringify(created.storeId) },
    ]);
    expect(created.storeId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(facts.clock).toBe(1);
    expect(facts.reshard).toBe(1);
    expect(facts.partitions).toBe(await partitionCount(rig.direct));
    expect(facts.partitions).toBeGreaterThan(0);
  });

  it('a second run is refused and changes nothing', async () => {
    const url = await freshDatabase('nb36twice');
    expect((await provisionEmptyStore(url)).state).toBe('created');
    const before = await onDatabase(url, async client => ({ layout: await layout(client), meta: await metaRows(client) }));
    const outcome = await provisionEmptyStore(url);
    const after = await onDatabase(url, async client => ({ layout: await layout(client), meta: await metaRows(client) }));
    expect(outcome).toEqual({
      state: 'refused',
      line: expect.stringMatching(/^data provision refused: the database [^ ]+\/nb36twice already holds the schema smdb_data; nothing was created$/),
    });
    expect(after).toEqual(before);
  });

  it('a database holding smdb_data, even an empty schema, is refused and left as it was', async () => {
    const url = await freshDatabase('nb36held');
    await onDatabase(url, client => client.query('CREATE SCHEMA smdb_data'));
    const outcome = await provisionEmptyStore(url);
    expect(outcome.state).toBe('refused');
    expect((outcome as { line: string }).line).toMatch(/\/nb36held already holds the schema smdb_data; nothing was created$/);
    const relations = await onDatabase(url, async client => (await client.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'smdb_data'`)).rows[0].n);
    expect(relations).toBe(0);
  });

  it('refuses a database that does not exist, with the reason', async () => {
    const url = rig.url.replace(/\/[^/]*$/, '/nb36missing');
    const outcome = await provisionEmptyStore(url);
    expect(outcome.state).toBe('refused');
    expect((outcome as { line: string }).line).toMatch(/^data provision refused: the database [^ ]+\/nb36missing could not be opened \(SQLSTATE 3D000: .+\); nothing was created$/);
  });

  it("the bot's backend serves the store it made, keeping its store id", async () => {
    const url = await freshDatabase('nb36boot');
    const outcome = await provisionEmptyStore(url);
    expect(outcome.state).toBe('created');
    const before = await onDatabase(url, metaRows);
    const backend = new PostgresBackend(fixedDatabase(url));
    backend.start();
    let verdict: unknown;
    try {
      verdict = await backend.provisionVerdict();
    } finally {
      await backend.stop();
    }
    const after = await onDatabase(url, metaRows);
    expect(verdict).toEqual({ state: 'provisioned' });
    expect(after.find(row => row.key === 'store_id')).toEqual({ key: 'store_id', value: JSON.stringify((outcome as { storeId: string }).storeId) });
    expect(after.find(row => row.key === 'store_id')).toEqual(before.find(row => row.key === 'store_id'));
  });

  it('waits behind a session holding the bootstrap lock that makes smdb_data, then refuses and changes nothing', async () => {
    const url = await freshDatabase('nb36race');
    const holder = new Client({ connectionString: url });
    await holder.connect();
    let outcome: Awaited<ReturnType<typeof provisionEmptyStore>> | undefined;
    let waited = false;
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtext('smdb_data_bootstrap'))`);
      await holder.query('CREATE SCHEMA smdb_data');
      await holder.query('CREATE TABLE smdb_data.kept (id int)');
      const running = provisionEmptyStore(url);
      for (let i = 0; i < 100 && !waited; i++) {
        const rows = (await rig.direct.query(`SELECT 1 FROM pg_stat_activity WHERE application_name = 'smdb-provision' AND datname = 'nb36race' AND wait_event_type = 'Lock'`)).rows;
        waited = rows.length > 0;
        if (!waited) await new Promise(resolve => setTimeout(resolve, 50));
      }
      await holder.query('COMMIT');
      outcome = await running;
    } finally {
      await holder.end();
    }
    const relations = await onDatabase(url, async client => (await client.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'smdb_data' ORDER BY 1`)).rows.map(r => r.relname));
    expect(waited).toBe(true);
    expect(outcome).toEqual({
      state: 'refused',
      line: expect.stringMatching(/^data provision refused: the database [^ ]+\/nb36race already holds the schema smdb_data; nothing was created$/),
    });
    expect(relations).toEqual(['kept']);
  });
});
