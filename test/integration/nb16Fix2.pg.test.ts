import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { PostgresBackend, provisionStoreInTransaction, type ProvisionVerdict } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { freshPrivilegeRefusal, privilegeDifference, refusalLogLines, scratchRefusal, storeIdRefusal } from '../../src/bot/internalSetup/utils/dataBackends/storeShape';
import {
  BOT_ROLE, boot, botUrl, clientOn, ensureBotRole, grantBot, hasSmdbData, makeTemplate, newDatabase, shapeSchemas,
  startNb16Rig, stopNb16Rig, storeSnapshot, urlOf, type Nb16Rig,
} from '../helpers/nb16Rig';
import { fixedChooser } from '../helpers/fixedDatabase';

// NB16 code review round 2 fixes on postgres:16-alpine: default privileges that take INSERT from the bot's role
// (ruling 1), a store with no store_id row (ruling 2), a role whose default isolation is repeatable read (ruling 3),
// and, from round 3, a scratch copy that an event trigger rejects.

let rig: Nb16Rig;
let logs: MockInstance;
let errors: MockInstance;
const T = 120_000;

beforeAll(async () => {
  rig = await startNb16Rig();
  await ensureBotRole(rig);
  await makeTemplate(rig);
}, 300_000);
afterAll(async () => { await stopNb16Rig(rig); });
beforeEach(() => {
  logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

async function bootWith(url: string, markerStoreId: string | null): Promise<ProvisionVerdict | { state: 'timeout' }> {
  const backend = new PostgresBackend({ chooser: fixedChooser(url), markerStoreId: () => markerStoreId });
  backend.start();
  try {
    return await Promise.race([
      backend.provisionVerdict(),
      new Promise<{ state: 'timeout' }>(resolve => { setTimeout(() => resolve({ state: 'timeout' }), 60_000).unref(); }),
    ]);
  } finally {
    await backend.stop();
  }
}

describe('ruling 1: default privileges that take INSERT from the bot role', () => {
  it("a store of this bot's version the role holds every privilege on still serves, and its check leaves nothing behind", async () => {
    const db = 'nb16_fix2_r1_store';
    const pool = await newDatabase(rig, db, 'store');
    await grantBot(pool, db);
    await pool.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${BOT_ROLE} REVOKE INSERT ON TABLES FROM ${BOT_ROLE}`);
    const before = await storeSnapshot(pool);
    expect(await boot(botUrl(rig, db))).toEqual({ state: 'provisioned' });
    expect(await shapeSchemas(pool)).toEqual([]);
    expect(await storeSnapshot(pool)).toEqual(before);
  }, T);

  it('a fresh database is refused with the fresh privilege texts, with nothing committed', async () => {
    const db = 'nb16_fix2_r1_fresh';
    const pool = await newDatabase(rig, db, 'empty');
    await grantBot(pool, db, { store: false });
    await pool.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${BOT_ROLE} REVOKE INSERT ON TABLES FROM ${BOT_ROLE}`);
    const tables = ['claim_clock', 'guild_append', 'guild_data', 'guild_data_graveyard', 'guild_ownership', 'guild_requests', 'identify_slots', 'meta', 'reshard', 'shard_claims', 'shard_nodes'];
    const refusal = freshPrivilegeRefusal(BOT_ROLE, tables.map(target => privilegeDifference(BOT_ROLE, db, { scope: 'table', target, privilege: 'INSERT' })));
    expect(refusal.reason).toBe(`this bot's database role ${BOT_ROLE} lacked privileges on the schema it made in the database, so it was rolled back (default privileges or an event trigger take them from new tables): ${tables.slice(0, 5).map(t => `this bot's database role ${BOT_ROLE} lacks INSERT on smdb_data.${t}`).join('; ')}; and 6 more (the bot's log lists them)`);
    expect(refusal.fix).toBe(`Gates stay closed and nothing in the database was changed; as ${BOT_ROLE} or a superuser, run ALTER DEFAULT PRIVILEGES FOR ROLE ${BOT_ROLE} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${BOT_ROLE}; ALTER DEFAULT PRIVILEGES FOR ROLE ${BOT_ROLE} GRANT USAGE, UPDATE ON SEQUENCES TO ${BOT_ROLE} (SELECT * FROM pg_default_acl lists what is set), remove any event trigger that revokes privileges on new tables, and restart the bot`);
    expect(refusal.header).toBe(`schema-mismatch: this bot's database role ${BOT_ROLE} lacked 11 privilege(s) on the schema it made in the database, so it was rolled back before it was committed (default privileges set with ALTER DEFAULT PRIVILEGES, or an event trigger, take them from new tables); refusing to serve`);
    expect(await boot(botUrl(rig, db))).toEqual({ state: 'shape', reason: refusal.reason, fix: refusal.fix });
    const logged = errors.mock.calls.map(c => String(c[0])).filter(l => /^\[PostgresBackend\] schema[- ]/.test(l));
    expect(logged).toEqual(refusalLogLines(refusal));
    expect(await hasSmdbData(pool)).toBe(false);
    expect(await shapeSchemas(pool)).toEqual([]);
  }, T);
});

describe("ruling 2: a store of this bot's version with no store_id row", () => {
  it('with a store id in the marker: refused with nothing written; the printed INSERT then lets it serve', async () => {
    const db = 'nb16_fix2_r2_marker';
    const pool = await newDatabase(rig, db, 'store');
    await pool.query(`DELETE FROM smdb_data.meta WHERE key = 'store_id'`);
    const before = await storeSnapshot(pool);
    const refusal = storeIdRefusal('rec-0001');
    expect(await bootWith(urlOf(rig, db), 'rec-0001')).toEqual({ state: 'shape', reason: refusal.reason, fix: refusal.fix });
    expect(await storeSnapshot(pool)).toEqual(before);
    const statement = /INSERT INTO smdb_data\.meta \(key, value\) VALUES \('store_id', '[^)]*'\)/.exec(refusal.fix)![0];
    await pool.query(statement);
    expect(await bootWith(urlOf(rig, db), 'rec-0001')).toEqual({ state: 'provisioned' });
    const { rows } = await pool.query(`SELECT value FROM smdb_data.meta WHERE key = 'store_id'`);
    expect(JSON.parse(rows[0].value)).toBe('rec-0001');
  }, T);

  it('with no store id in the marker: a new store id is written and the store serves', async () => {
    const db = 'nb16_fix2_r2_none';
    const pool = await newDatabase(rig, db, 'store');
    await pool.query(`DELETE FROM smdb_data.meta WHERE key = 'store_id'`);
    expect(await bootWith(urlOf(rig, db), null)).toEqual({ state: 'provisioned' });
    const { rows } = await pool.query(`SELECT value FROM smdb_data.meta WHERE key = 'store_id'`);
    expect(rows).toHaveLength(1);
    expect(typeof JSON.parse(rows[0].value)).toBe('string');
  }, T);
});

describe('ruling 3: a role whose default isolation is repeatable read', () => {
  it('waits for a holder that provisions the store, then reads what it committed and serves', async () => {
    const db = 'nb16_fix2_r3';
    const pool = await newDatabase(rig, db, 'empty');
    await grantBot(pool, db, { store: false });
    await pool.query(`ALTER ROLE ${BOT_ROLE} IN DATABASE ${db} SET default_transaction_isolation = 'repeatable read'`);
    const probe = await clientOn(botUrl(rig, db));
    try {
      expect((await probe.query('SHOW default_transaction_isolation')).rows[0].default_transaction_isolation).toBe('repeatable read');
    } finally {
      await probe.end().catch(() => undefined);
    }
    const holder = await clientOn(urlOf(rig, db));
    const backend = new PostgresBackend({ chooser: fixedChooser(botUrl(rig, db)) });
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtext('smdb_data_bootstrap'))`);
      backend.start();
      const waiting = "[PostgresBackend] Waiting for the bootstrap lock, held by another bot process's schema check or a data migration";
      await vi.waitFor(() => { expect(logs.mock.calls.map(c => String(c[0]))).toContain(waiting); }, { timeout: 20_000, interval: 100 });
      await provisionStoreInTransaction(holder);
      await holder.query(`GRANT USAGE ON SCHEMA smdb_data TO ${BOT_ROLE}`);
      await holder.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA smdb_data TO ${BOT_ROLE}`);
      await holder.query(`GRANT USAGE, UPDATE ON ALL SEQUENCES IN SCHEMA smdb_data TO ${BOT_ROLE}`);
      await holder.query('COMMIT');
      expect(await backend.provisionVerdict()).toEqual({ state: 'provisioned' });
      expect((await pool.query(`SELECT count(*)::int AS n FROM smdb_data.meta WHERE key = 'store_id'`)).rows[0].n).toBe(1);
    } finally {
      await backend.stop();
      await holder.end().catch(() => undefined);
      await pool.query(`ALTER ROLE ${BOT_ROLE} IN DATABASE ${db} RESET default_transaction_isolation`);
    }
  }, T);
});

describe('round 3: an event trigger that rejects the tables of the scratch copy', () => {
  it("refuses a store of this bot's version once, naming the SQLSTATE and the message, with nothing changed", async () => {
    const db = 'nb16_fix3_scratch';
    const pool = await newDatabase(rig, db, 'store');
    await grantBot(pool, db);
    await pool.query(`CREATE FUNCTION public.no_scratch() RETURNS event_trigger LANGUAGE plpgsql AS $$
      DECLARE r record;
      BEGIN
        FOR r IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
          IF r.command_tag = 'CREATE TABLE' AND r.schema_name LIKE 'smdb_shape_%' THEN
            RAISE EXCEPTION 'no new tables here';
          END IF;
        END LOOP;
      END $$`);
    await pool.query(`CREATE EVENT TRIGGER no_scratch ON ddl_command_end EXECUTE FUNCTION public.no_scratch()`);
    const before = await storeSnapshot(pool);
    const refusal = scratchRefusal('P0001', 'no new tables here', BOT_ROLE, db);
    expect(await boot(botUrl(rig, db))).toEqual({ state: 'shape', reason: refusal.reason, fix: refusal.fix });
    expect(errors.mock.calls.map(c => String(c[0])).filter(l => /^\[PostgresBackend\] schema[- ]/.test(l))).toEqual(refusalLogLines(refusal));
    expect(vi.mocked(console.warn).mock.calls.map(c => String(c[0])).filter(l => /Bootstrap attempt/.test(l))).toEqual([]);
    expect(await storeSnapshot(pool)).toEqual(before);
    expect(await shapeSchemas(pool)).toEqual([]);
  }, T);
});
