import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { showEntry } from '../../src/utils/databaseAddress';
import { copyStore, entryOf, provision, setGeneration, sleep, startBot, waitFor, type BotRun } from '../helpers/nb5Pg';
import { startPostgres } from '../helpers/postgres';

// NB5F section 4 [pg] P1 to P3 (decision 3): the move's check of its target on a real database, on nb5Retarget's rig.
// A and W hold one store; the bot runs on A with G hydrated and a write held, W is raised to generation 2 and the watch
// latches A. W is then a copy whose tables differ, a copy whose role lacks a privilege, or a database with no smdb_data:
// each refuses the move with its reason, once, and the check leaves no session and no scratch schema behind.

const ADMIN = 'nb5f-admin';
const STORE = 'store-nb5f';
const G = '880000000000000601';
const P = { nodeId: 'node-a', claim: 40, processId: 'p-a', shardId: 0, shardCount: 1 };
const TABLES = ['meta', 'guild_ownership', 'shard_claims', 'guild_data', 'guild_append', 'guild_data_graveyard'];
const ROLE = 'nb5f_bot';
const ROLE_PASSWORD = 'nb5f-pw';
let a: StartedPostgreSqlContainer;
let w: StartedPostgreSqlContainer;
let directA: Pool;
let directW: Pool;
let entryA: string;
let entryW: string;
let run: BotRun | null = null;

beforeAll(async () => {
  [a, w] = await Promise.all([startPostgres(), startPostgres()]);
  entryA = entryOf(a);
  entryW = entryOf(w);
  directA = new Pool({ connectionString: entryA, application_name: ADMIN, max: 4 });
  directW = new Pool({ connectionString: entryW, application_name: ADMIN, max: 4 });
}, 240_000);
afterAll(async () => {
  await directA?.end();
  await directW?.end();
  await Promise.all([a?.stop(), w?.stop()]);
});
beforeEach(async () => {
  for (const pool of [directA, directW]) {
    await pool.query('DROP SCHEMA IF EXISTS smdb_data CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS smdb_manager CASCADE');
  }
  await provision(entryA, directA, STORE);
  await provision(entryW, directW, STORE);
  await setGeneration(directA, 'node-a', 1);
  await directA.query(`INSERT INTO smdb_data.shard_claims (shard_count, shard_id, claim, holder_process, holder_node, holder_name, home_node, ttl_ms, expires_up_ms)
    VALUES (1, 0, 40, 'p-a', 'node-a', 'node-a', 'node-a', 30000, 30000)`);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => {
  await run?.stop();
  run = null;
  vi.restoreAllMocks();
});

/** W's rows of the six tables, each table in a stable order. */
async function rowsOf(pool: Pool): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const table of TABLES) {
    const { rows } = await pool.query(`SELECT * FROM smdb_data.${table}`);
    out[table] = rows.map(r => JSON.stringify(r)).sort();
  }
  return out;
}

/** G saved on A and copied to W; `prepareW` then changes W; W raised to 2; a write to G held on A; the list given W. */
async function seedMove(r: BotRun, prepareW: () => Promise<void>, listW = entryW): Promise<void> {
  expect(await r.ws.hydrate(G, P)).toBe('ready');
  r.ws.save(G, 'm', 'd1.json', '"saved"');
  await r.ws.flushAllDirty();
  await copyStore(directA, directW);
  await prepareW();
  await setGeneration(directW, 'node-w', 2);
  r.ws.save(G, 'm', 'd2.json', '"held"');
  r.list = [entryA, listW];
  r.chooser.confirmNow();
}

const refusals = (target: string) => vi.mocked(console.error).mock.calls.map(c => String(c[0])).filter(line => line.startsWith(`[Database] Not moving to ${target}: `));

/** The watch stopped, then 5 s later: no check session on W and no scratch schema there. */
async function expectNothingLeft(r: BotRun): Promise<void> {
  r.chooser.stop();
  await sleep(5_000);
  const sessions = await directW.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'smdb-move-check'`);
  expect(sessions.rows[0].n).toBe(0);
  const scratch = await directW.query(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname LIKE 'smdb\\_shape\\_%'`);
  expect(scratch.rows[0].n).toBe(0);
}

describe("NB5F P1 to P3: the move's check refuses W", () => {
  it('P1: a copy whose tables differ is refused with the difference, once; the latch and the held write stay and W is unchanged', async () => {
    const r = run = await startBot([entryA], STORE);
    await seedMove(r, async () => {
      await directW.query('ALTER TABLE smdb_data.guild_data_graveyard ALTER COLUMN reason DROP NOT NULL');
    });
    const before = await rowsOf(directW);
    await waitFor(() => r.backend.latchReason() !== null);
    await sleep(15_000);
    const target = showEntry(entryW);
    expect(refusals(target)).toEqual([
      `[Database] Not moving to ${target}: the database's smdb_data differs from this bot's schema (version 6): smdb_data.guild_data_graveyard column reason allows NULL, where this bot's schema has NOT NULL; this process keeps its unsaved changes and stays stopped`,
    ]);
    expect(vi.mocked(console.error).mock.calls.map(c => String(c[0])).filter(line => line.includes('schema difference: smdb_data.guild_data_graveyard column reason allows NULL'))).toHaveLength(1);
    expect(r.moved).toEqual([]);
    expect(r.backend.latchReason()).not.toBeNull();
    expect(r.ws.resaveGuilds()).toEqual([G]);
    expect(await rowsOf(directW)).toEqual(before);
    await expectNothingLeft(r);
  }, 240_000);

  it('P2: a copy whose role lacks INSERT on guild_data is refused naming that privilege; nothing is written', async () => {
    const r = run = await startBot([entryA], STORE);
    const roleEntry = entryOf(w, { user: ROLE, password: ROLE_PASSWORD });
    await seedMove(r, async () => {
      await directW.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN CREATE ROLE ${ROLE} LOGIN PASSWORD '${ROLE_PASSWORD}'; END IF; END $$`);
      await directW.query(`GRANT CREATE ON DATABASE "${w.getDatabase()}" TO ${ROLE}`);
      await directW.query(`GRANT USAGE ON SCHEMA smdb_data TO ${ROLE}`);
      await directW.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA smdb_data TO ${ROLE}`);
      await directW.query(`REVOKE INSERT ON smdb_data.guild_data FROM ${ROLE}`);
      await directW.query(`GRANT USAGE, UPDATE ON ALL SEQUENCES IN SCHEMA smdb_data TO ${ROLE}`);
    }, roleEntry);
    const before = await rowsOf(directW);
    await waitFor(() => r.backend.latchReason() !== null);
    const target = showEntry(roleEntry);
    await waitFor(() => refusals(target).length > 0, 30_000);
    await sleep(10_000);
    expect(refusals(target)).toEqual([
      `[Database] Not moving to ${target}: this bot's database role ${ROLE} lacks privileges on smdb_data, which matches this bot's schema (version 6): this bot's database role ${ROLE} lacks INSERT on smdb_data.guild_data; this process keeps its unsaved changes and stays stopped`,
    ]);
    expect(r.moved).toEqual([]);
    expect(await rowsOf(directW)).toEqual(before);
    await expectNothingLeft(r);
  }, 240_000);

  it('P3: W with no smdb_data is refused as holding no copy of the store, and no smdb_data is made there', async () => {
    const r = run = await startBot([entryA], STORE);
    await seedMove(r, async () => {
      await directW.query('DROP SCHEMA smdb_data CASCADE');
    });
    await waitFor(() => r.backend.latchReason() !== null);
    const target = showEntry(entryW);
    await waitFor(() => refusals(target).length > 0, 30_000);
    await sleep(10_000);
    expect(refusals(target)).toEqual([
      `[Database] Not moving to ${target}: the database holds no tables in smdb_data, so it holds no copy of this bot's store; a move does not provision a database; this process keeps its unsaved changes and stays stopped`,
    ]);
    expect(r.moved).toEqual([]);
    const schema = await directW.query(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'smdb_data'`);
    expect(schema.rows[0].n).toBe(0);
    await expectNothingLeft(r);
  }, 240_000);
});
