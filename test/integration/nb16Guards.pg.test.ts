import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { PostgresBackend, SCHEMA_VERSION, provisionStoreInTransaction } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { checkShape } from '../../src/bot/internalSetup/utils/dataBackends/storeShape';
import {
  BOT_ROLE, boot, botUrl, clientOn, emptySessions, ensureBotRole, grantBot, makeTemplate, newDatabase, shapeSchemas,
  startNb16Rig, stopNb16Rig, storeSnapshot, urlOf, type Nb16Rig,
} from '../helpers/nb16Rig';

// NB16 sheet section 8 items 8 to 13: version first, the stores that keep serving, two boots at once, the platform
// facts the design relies on, and the time one check takes.

let rig: Nb16Rig;
const T = 120_000;

beforeAll(async () => {
  rig = await startNb16Rig();
  await ensureBotRole(rig);
  await makeTemplate(rig);
}, 300_000);
afterAll(async () => { await stopNb16Rig(rig); });
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

const rowsOf = async (pool: Pool) => ({
  meta: (await pool.query(`SELECT key, value, updated_at FROM smdb_data.meta ORDER BY key`)).rows,
  clock: (await pool.query(`SELECT * FROM smdb_data.claim_clock`)).rows,
});

describe('item 8: the version is read first (row 6)', () => {
  it('a {"v":2} store with a changed graveyard is refused by version, with no scratch sent', async () => {
    const pool = await newDatabase(rig, 'nb16_i8', 'store');
    await pool.query(`UPDATE smdb_data.meta SET value = '{"v":2}' WHERE key = 'schema_version'`);
    await pool.query('ALTER TABLE smdb_data.guild_data_graveyard ALTER COLUMN reason DROP NOT NULL');
    const backend = new PostgresBackend({ url: urlOf(rig, 'nb16_i8') });
    const sent: string[] = [];
    const pg = backend.getPool();
    type Recorded = { query: (...a: unknown[]) => unknown };
    type Callback = (err: Error | undefined, client: Recorded | undefined, done: unknown) => void;
    const wrapped = new WeakSet<object>();
    const record = (client: Recorded) => {
      if (wrapped.has(client)) return client;
      wrapped.add(client);
      const query = client.query.bind(client);
      client.query = (...args: unknown[]) => {
        const first = args[0];
        sent.push(typeof first === 'string' ? first : String((first as { text?: string })?.text ?? ''));
        return query(...args);
      };
      return client;
    };
    // pool.query calls connect with a callback, provision() without one; both forms are kept.
    const connect = pg.connect.bind(pg) as unknown as (cb?: Callback) => Promise<Recorded> | void;
    (pg as unknown as { connect: unknown }).connect = (cb?: Callback) => (cb
      ? connect((err, client, done) => cb(err, client && record(client), done))
      : (connect() as Promise<Recorded>).then(record));
    backend.start();
    try {
      expect(await backend.provisionVerdict()).toEqual({ state: 'mismatch', found: '{"v":2}' });
    } finally {
      await backend.stop();
    }
    expect(sent.some(s => /smdb_shape_/.test(s))).toBe(false);
  }, T);
});

describe('item 9: guards, stores that keep serving', () => {
  it('row 3: provisioned, stopped and booted again; the check is timed (item 13)', async () => {
    const pool = await newDatabase(rig, 'nb16_r03', 'empty');
    expect(await boot(urlOf(rig, 'nb16_r03'))).toEqual({ state: 'provisioned' });
    const before = await rowsOf(pool);
    const started = performance.now();
    expect(await boot(urlOf(rig, 'nb16_r03'))).toEqual({ state: 'provisioned' });
    const ms = performance.now() - started;
    process.stdout.write(`[NB16] the boot of a provisioned store took ${Math.round(ms)} ms\n`);
    expect(ms).toBeLessThan(10_000);
    expect(await rowsOf(pool)).toEqual(before);
    expect(await shapeSchemas(pool)).toEqual([]);
  }, T);

  it('row 4: a store provisionStoreInTransaction made, committed with a guild row', async () => {
    const pool = await newDatabase(rig, 'nb16_r04', 'empty');
    const client = await clientOn(urlOf(rig, 'nb16_r04'));
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('smdb_data_bootstrap'))`);
      await provisionStoreInTransaction(client);
      await client.query(`INSERT INTO smdb_data.guild_data (guild_id, module, filename, doc) VALUES ('1', 'm', 'a.json', '{}')`);
      await client.query('COMMIT');
    } finally {
      await client.end();
    }
    expect(await boot(urlOf(rig, 'nb16_r04'))).toEqual({ state: 'provisioned' });
    expect((await pool.query(`SELECT doc FROM smdb_data.guild_data`)).rows).toEqual([{ doc: '{}' }]);
  }, T);

  it('row 5: a store dumped with pg_dump and loaded with pg_restore into a new database', async () => {
    const pool = await newDatabase(rig, 'nb16_r05', 'store');
    await pool.query(`INSERT INTO smdb_data.guild_data (guild_id, module, filename, doc) VALUES ('1', 'm', 'a.json', '{}')`);
    await emptySessions(rig, 'nb16_r05');
    const user = rig.container.getUsername();
    const run = async (cmd: string[]) => {
      const res = await rig.container.exec(cmd);
      expect(res.exitCode, `${cmd.join(' ')}: ${res.output}`).toBe(0);
    };
    await run(['pg_dump', '-U', user, '-Fc', '-f', '/tmp/nb16_r05.dump', 'nb16_r05']);
    await run(['createdb', '-U', user, 'nb16_r05_copy']);
    await run(['pg_restore', '-U', user, '-d', 'nb16_r05_copy', '/tmp/nb16_r05.dump']);
    expect(await boot(urlOf(rig, 'nb16_r05_copy'))).toEqual({ state: 'provisioned' });
  }, T);

  it('row 38: the column order differs', async () => {
    const pool = await newDatabase(rig, 'nb16_r38', 'store');
    await pool.query('ALTER TABLE smdb_data.shard_nodes DROP COLUMN healthy_since');
    await pool.query('ALTER TABLE smdb_data.shard_nodes ADD COLUMN healthy_since timestamptz');
    expect(await boot(urlOf(rig, 'nb16_r38'))).toEqual({ state: 'provisioned' });
  }, T);

  it('row 39: owner, fillfactor and comments differ, and another role holds grants', async () => {
    const pool = await newDatabase(rig, 'nb16_r39', 'store');
    await pool.query(`ALTER TABLE smdb_data.shard_nodes OWNER TO ${BOT_ROLE}`);
    await pool.query('ALTER TABLE smdb_data.guild_ownership SET (fillfactor = 70)');
    await pool.query(`COMMENT ON TABLE smdb_data.meta IS 'nb16'`);
    await pool.query(`GRANT SELECT ON smdb_data.guild_ownership TO ${BOT_ROLE}`);
    expect(await boot(urlOf(rig, 'nb16_r39'))).toEqual({ state: 'provisioned' });
  }, T);

  it("row 40: the role's search_path set to smdb_data, public", async () => {
    const pool = await newDatabase(rig, 'nb16_r40', 'store');
    await grantBot(pool, 'nb16_r40');
    await pool.query(`ALTER ROLE ${BOT_ROLE} IN DATABASE nb16_r40 SET search_path = smdb_data, public`);
    expect(await boot(botUrl(rig, 'nb16_r40'))).toEqual({ state: 'provisioned' });
  }, T);

  it('row 43: meta without shard_count and with other rows', async () => {
    const pool = await newDatabase(rig, 'nb16_r43', 'store');
    await pool.query(`DELETE FROM smdb_data.meta WHERE key = 'shard_count'`);
    await pool.query(`INSERT INTO smdb_data.meta (key, value) VALUES ('other', 'x')`);
    expect(await boot(urlOf(rig, 'nb16_r43'))).toEqual({ state: 'provisioned' });
  }, T);

  it('row 2: an empty smdb_data owned by another role is provisioned by the bot role, which owns every table', async () => {
    const pool = await newDatabase(rig, 'nb16_r02', 'empty');
    await pool.query('CREATE SCHEMA smdb_data');
    await pool.query(`GRANT USAGE, CREATE ON SCHEMA smdb_data TO ${BOT_ROLE}`);
    await grantBot(pool, 'nb16_r02', { store: false });
    expect(await boot(botUrl(rig, 'nb16_r02'))).toEqual({ state: 'provisioned' });
    const others = await pool.query(
      `SELECT count(*)::int AS n FROM pg_class WHERE relnamespace = 'smdb_data'::regnamespace AND relkind IN ('r', 'p') AND pg_get_userbyid(relowner) <> $1`, [BOT_ROLE]);
    expect(others.rows[0].n).toBe(0);
  }, T);
});

describe('the check sends no row into the scratch (NB16-R2-1, R2-T1, NB16-R2-RUN-1)', () => {
  it("a provisioned store passes, unchanged, when the role's default privileges take INSERT from its new tables", async () => {
    const db = 'nb16_g_noinsert';
    const pool = await newDatabase(rig, db, 'store');
    await grantBot(pool, db);
    await pool.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${BOT_ROLE} REVOKE INSERT ON TABLES FROM ${BOT_ROLE}`);
    const acl = await pool.query(`SELECT count(*)::int AS n FROM pg_default_acl WHERE defaclrole = $1::regrole`, [BOT_ROLE]);
    expect(acl.rows[0].n).toBe(1);
    const before = await storeSnapshot(pool);
    expect(await boot(botUrl(rig, db))).toEqual({ state: 'provisioned' });
    expect(await storeSnapshot(pool)).toEqual(before);
    expect(await shapeSchemas(pool)).toEqual([]);
  }, T);
});

describe("the boot reads what the lock holder committed (NB16-R2-3, NB16-R2-RUN-3)", () => {
  it("a role whose default_transaction_isolation is repeatable read serves the store a migration replaced while it waited", async () => {
    const db = 'nb16_g_iso';
    const pool = await newDatabase(rig, db, 'store');
    await grantBot(pool, db);
    await pool.query(`ALTER ROLE ${BOT_ROLE} IN DATABASE ${db} SET default_transaction_isolation = 'repeatable read'`);
    const holder = await clientOn(urlOf(rig, db));
    const backend = new PostgresBackend({ url: botUrl(rig, db) });
    try {
      const probe = await clientOn(botUrl(rig, db));
      try {
        expect((await probe.query('SHOW default_transaction_isolation')).rows[0].default_transaction_isolation).toBe('repeatable read');
      } finally {
        await probe.end();
      }
      const oldId = (await pool.query(`SELECT value FROM smdb_data.meta WHERE key = 'store_id'`)).rows[0].value;
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtext('smdb_data_bootstrap'))`);
      backend.start();
      await vi.waitFor(async () => {
        const polling = await pool.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = $1 AND datname = $2 AND query LIKE '%pg_try_advisory_xact_lock%'`, [BOT_ROLE, db]);
        expect(polling.rows[0].n).toBeGreaterThan(0);
      }, { timeout: 20_000, interval: 100 });
      await holder.query('ALTER SCHEMA smdb_data RENAME TO smdb_old');
      const newId = await provisionStoreInTransaction(holder);
      await holder.query(`GRANT USAGE ON SCHEMA smdb_data TO ${BOT_ROLE}`);
      await holder.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA smdb_data TO ${BOT_ROLE}`);
      await holder.query(`GRANT USAGE, UPDATE ON ALL SEQUENCES IN SCHEMA smdb_data TO ${BOT_ROLE}`);
      await holder.query('COMMIT');
      expect(await backend.provisionVerdict()).toEqual({ state: 'provisioned' });
      expect((await pool.query(`SELECT key, value FROM smdb_data.meta WHERE key IN ('schema_version', 'store_id') ORDER BY key`)).rows).toEqual([
        { key: 'schema_version', value: JSON.stringify({ v: SCHEMA_VERSION }) },
        { key: 'store_id', value: JSON.stringify(newId) },
      ]);
      expect((await pool.query(`SELECT value FROM smdb_old.meta WHERE key = 'store_id'`)).rows).toEqual([{ value: oldId }]);
      expect(await shapeSchemas(pool)).toEqual([]);
    } finally {
      await backend.stop();
      await holder.end().catch(() => undefined);
      await pool.query(`ALTER ROLE ${BOT_ROLE} IN DATABASE ${db} RESET default_transaction_isolation`);
    }
  }, T);
});

describe('item 10: two backends started together on a fresh database (row 41)', () => {
  it('both reach provisioned, meta holds one store id, and no scratch schema is left', async () => {
    const pool = await newDatabase(rig, 'nb16_r41', 'empty');
    const url = urlOf(rig, 'nb16_r41');
    expect(await Promise.all([boot(url), boot(url)])).toEqual([{ state: 'provisioned' }, { state: 'provisioned' }]);
    expect((await pool.query(`SELECT count(*)::int AS n FROM smdb_data.meta WHERE key = 'store_id'`)).rows[0].n).toBe(1);
    expect(await shapeSchemas(pool)).toEqual([]);
  }, T);
});

describe('item 11: characterizations', () => {
  it('a role with no CREATE on the database fails CREATE SCHEMA IF NOT EXISTS on an existing schema with 42501', async () => {
    const pool = await newDatabase(rig, 'nb16_c1', 'store');
    await grantBot(pool, 'nb16_c1', { databaseCreate: false });
    const asBot = await clientOn(botUrl(rig, 'nb16_c1'));
    try {
      await expect(asBot.query('CREATE SCHEMA IF NOT EXISTS smdb_data')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await asBot.end();
    }
  }, T);

  it('a transaction that made a schema and whose session was terminated leaves no schema', async () => {
    const pool = await newDatabase(rig, 'nb16_c2', 'empty');
    const doomed = await clientOn(urlOf(rig, 'nb16_c2'));
    await doomed.query('BEGIN');
    await doomed.query('CREATE SCHEMA nb16_doomed');
    const pid = (await doomed.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await pool.query('SELECT pg_terminate_backend($1)', [pid]);
    await doomed.end().catch(() => undefined);
    expect((await pool.query(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'nb16_doomed'`)).rows[0].n).toBe(0);
  }, T);

  it('with search_path = pg_catalog, the seq default and an index definition print schema-qualified names', async () => {
    await newDatabase(rig, 'nb16_c3', 'store');
    const c = await clientOn(urlOf(rig, 'nb16_c3'));
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL search_path = pg_catalog');
      const def = await c.query(`SELECT pg_get_expr(d.adbin, d.adrelid) AS def FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
        WHERE d.adrelid = 'smdb_data.guild_append'::regclass AND a.attname = 'seq'`);
      expect(def.rows[0].def).toBe("nextval('smdb_data.guild_append_seq'::regclass)");
      const idx = await c.query(`SELECT pg_get_indexdef('smdb_data.guild_ownership_node_idx'::regclass) AS def`);
      expect(idx.rows[0].def).toBe('CREATE INDEX guild_ownership_node_idx ON smdb_data.guild_ownership USING btree (node_id)');
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  }, T);

  it('the version read holds only ACCESS SHARE on meta while another session updates guild_data', async () => {
    const pool = await newDatabase(rig, 'nb16_c4', 'store');
    await pool.query(`INSERT INTO smdb_data.guild_data (guild_id, module, filename, doc) VALUES ('1', 'm', 'a.json', '{}')`);
    const reader = await clientOn(urlOf(rig, 'nb16_c4'));
    const writer = await clientOn(urlOf(rig, 'nb16_c4'));
    try {
      await reader.query('BEGIN');
      expect((await reader.query(`SELECT value::text FROM ONLY smdb_data.meta WHERE key = 'schema_version'`)).rows).toEqual([{ value: JSON.stringify({ v: SCHEMA_VERSION }) }]);
      const pid = (await reader.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const locks = await pool.query(
        `SELECT DISTINCT l.mode FROM pg_locks l WHERE l.pid = $1 AND l.relation = 'smdb_data.meta'::regclass`, [pid]);
      expect(locks.rows.map(r => r.mode)).toEqual(['AccessShareLock']);
      await writer.query(`UPDATE smdb_data.guild_data SET doc = '{"a":1}' WHERE guild_id = '1'`);
      await reader.query('ROLLBACK');
    } finally {
      await reader.end();
      await writer.end();
    }
  }, T);

  it('the full check completes with no difference while another session holds an open UPDATE of guild_data', async () => {
    const pool = await newDatabase(rig, 'nb16_c5', 'store');
    await pool.query(`INSERT INTO smdb_data.guild_data (guild_id, module, filename, doc) VALUES ('1', 'm', 'a.json', '{}')`);
    const checker = await clientOn(urlOf(rig, 'nb16_c5'));
    const writer = await clientOn(urlOf(rig, 'nb16_c5'));
    try {
      await writer.query('BEGIN');
      await writer.query(`UPDATE smdb_data.guild_data SET doc = '{"b":1}' WHERE guild_id = '1'`);
      await checker.query('BEGIN');
      await checker.query('SET LOCAL search_path = pg_catalog');
      await checker.query('SET LOCAL quote_all_identifiers = off');
      await checker.query(`SET LOCAL statement_timeout = '10s'`);
      const result = await checkShape(checker, 'provisioned');
      await checker.query('ROLLBACK');
      expect(result.differences).toEqual([]);
      await writer.query('COMMIT');
      expect((await pool.query(`SELECT doc FROM smdb_data.guild_data WHERE guild_id = '1'`)).rows).toEqual([{ doc: '{"b":1}' }]);
    } finally {
      await checker.end();
      await writer.end();
    }
  }, T);
});
