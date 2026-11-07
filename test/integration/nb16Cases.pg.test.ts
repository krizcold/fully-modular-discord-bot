import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { SCHEMA_VERSION, partitionDdl, provisionDdl, provisionStoreInTransaction } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import {
  BOT_ROLE, boot, botUrl, clientOn, closePool, ensureBotRole, grantBot, hasSmdbData, makeTemplate, newDatabase, poolOf,
  shapeSchemas, startNb16Rig, stopNb16Rig, storeSnapshot, urlOf, type Nb16Rig,
} from '../helpers/nb16Rig';

// NB16 sheet section 8 item 6: section 4's rows through a real PostgresBackend boot on postgres:16-alpine. Each row
// asserts the verdict, the reason, and that nothing changed: the catalog snapshot, every row of every table, the
// schemas and public's objects are equal before and after, and no smdb_shape_ schema is left.

let rig: Nb16Rig;
let errors: MockInstance;
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
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

const KEPT = 'Gates stay closed and nothing in the database was changed; ';
const DIFFERS = `the database's smdb_data differs from this bot's schema (version ${SCHEMA_VERSION}): `;
const SHAPE_FIX = `${KEPT}point DATA_BACKEND_URL at a database whose smdb_data matches this bot's schema in the web UI env editor, or correct the differences above in the database and restart the bot`;
const RESTORE = "; a table or partition reported missing may have held data that is not in this database: restore a backup (the manager's Database window) rather than creating it empty";
const UNREADABLE_FIX = `${KEPT}smdb_data.meta is this bot's version table: correct it to the shape the difference lines give (key text, value text NOT NULL, its primary key meta_pkey, row level security off) and restart the bot; do not rename smdb_data aside while its tables hold this bot's data, since the next boot would then make and serve a new, empty store and leave every row in the renamed schema`;
const LOGIN_TAIL = ', or point DATA_BACKEND_URL, in the web UI env editor, at a login that holds these privileges, then restart the bot';
const CONFIRM = "so this bot can't confirm what made them or that they are complete";
const FIRST_FIVE = 'smdb_data.claim_clock (table), smdb_data.claim_seq (sequence), smdb_data.guild_append (partitioned table), smdb_data.guild_append_p00 (table), smdb_data.guild_append_p01 (table) and 72 more';

type Verdict = { state: string; reason?: string; fix?: string; found?: string };

interface Run {
  verdict: Verdict;
  lines: string[];
  pool: Pool;
  db: string;
}

/**
 * A database made from the provisioned template or empty, changed by the row, booted once, and checked unchanged.
 * asBot: the boot connects as the bot's role (not a superuser), after the row's grants.
 */
async function row(name: string, from: 'store' | 'empty', change: (pool: Pool, db: string) => Promise<void>, asBot = false): Promise<Run> {
  const db = `nb16_${name}`;
  const pool = await newDatabase(rig, db, from);
  await change(pool, db);
  const before = await storeSnapshot(pool);
  const verdict = await boot(asBot ? botUrl(rig, db) : urlOf(rig, db)) as Verdict;
  expect(await storeSnapshot(pool)).toEqual(before);
  expect(await shapeSchemas(pool)).toEqual([]);
  const lines = errors.mock.calls.map(c => String(c[0])).filter(l => /^\[PostgresBackend\] schema[- ]/.test(l));
  return { verdict, lines, pool, db };
}

const differences = (run: Run) => run.lines.filter(l => l.startsWith('[PostgresBackend] schema difference: ')).map(l => l.slice('[PostgresBackend] schema difference: '.length));

/** Section 3's caps: the reason holds 5 sentences, the log 50 and a count of the rest. */
const listed = (sentences: string[]) => sentences.slice(0, 5).join('; ') + (sentences.length > 5 ? `; and ${sentences.length - 5} more (the bot's log lists them)` : '');
const logLines = (header: string, sentences: string[]) => [
  `[PostgresBackend] ${header}`,
  ...sentences.slice(0, 50).map(s => `[PostgresBackend] schema difference: ${s}`),
  ...(sentences.length > 50 ? [`[PostgresBackend] schema difference: and ${sentences.length - 50} more not listed`] : []),
];
const differsHeader = (n: number) => `schema-mismatch: smdb_data differs from this bot's schema (version ${SCHEMA_VERSION}) in ${n} place(s); refusing to serve`;
const RENAME_FIX = `${KEPT}point DATA_BACKEND_URL at a database without the schema smdb_data, or at one this bot provisioned, in the web UI env editor, or rename smdb_data aside in the database (ALTER SCHEMA smdb_data RENAME TO ...) and restart the bot`;
const partitionsOf = (table: string) => Array.from({ length: 32 }, (_, i) => `${table}_p${String(i).padStart(2, '0')}`);
const familyOf = (table: string) => [table, ...partitionsOf(table)];

async function sql(pool: Pool, ...statements: string[]): Promise<void> {
  for (const s of statements) await pool.query(s);
}

describe('decision 5: no version row, relations present', () => {
  it("row 8: section 3's example", async () => {
    const run = await row('r08', 'empty', p => sql(p,
      'CREATE SCHEMA smdb_data',
      `CREATE TABLE smdb_data.guild_data_graveyard (
        guild_id text NOT NULL, module text NOT NULL, filename text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('doc','append')), doc text NOT NULL, retired_at bigint NOT NULL, reason text, used_at bigint,
        PRIMARY KEY (guild_id, retired_at, module, filename))`,
      'CREATE INDEX IF NOT EXISTS guild_graveyard_ttl_idx ON smdb_data.guild_data_graveyard (retired_at)'));
    expect(run.verdict).toEqual({
      state: 'shape',
      reason: `the database's smdb_data holds objects but no schema_version, ${CONFIRM}: smdb_data.guild_data_graveyard (table); compared with this bot's schema: smdb_data.guild_data_graveyard column reason allows NULL, where this bot's schema has NOT NULL`,
      fix: `${KEPT}point DATA_BACKEND_URL at a database without the schema smdb_data, or at one this bot provisioned, in the web UI env editor, or rename smdb_data aside in the database (ALTER SCHEMA smdb_data RENAME TO ...) and restart the bot`,
    });
    expect(run.lines).toEqual([
      `[PostgresBackend] schema-mismatch: smdb_data holds 3 object(s) but no schema_version, ${CONFIRM} (a provisioning or restore that did not finish, or another program); refusing to serve`,
      "[PostgresBackend] schema difference: smdb_data.guild_data_graveyard column reason allows NULL, where this bot's schema has NOT NULL",
    ]);
  }, T);

  it('row 9: every table made by the DDL by hand, no version row', async () => {
    const run = await row('r09', 'empty', p => sql(p, ...provisionDdl('smdb_data'), ...partitionDdl('smdb_data', true)));
    expect(run.verdict.reason).toBe(`the database's smdb_data holds objects but no schema_version, ${CONFIRM}: ${FIRST_FIVE}; they match their counterparts in this bot's schema, but the bot does not take over a schema without a version`);
  }, T);

  it('row 10: meta only (a provisioning that did not finish)', async () => {
    const run = await row('r10', 'empty', p => sql(p, provisionDdl('smdb_data')[0], provisionDdl('smdb_data')[1]));
    expect(run.verdict.reason).toBe(`the database's smdb_data holds objects but no schema_version, ${CONFIRM}: smdb_data.meta (table); they match their counterparts in this bot's schema (156 of its 158 objects are not there), but the bot does not take over a schema without a version`);
  }, T);

  it('row 11: guild_data made as a plain table', async () => {
    const run = await row('r11', 'empty', p => sql(p, provisionDdl('smdb_data')[0],
      provisionDdl('smdb_data').find(s => s.includes('.guild_data ('))!.replace(' PARTITION BY HASH (guild_id)', '')));
    const sentences = [
      "smdb_data.guild_data is a table, where this bot's schema has a partitioned table",
      ...partitionsOf('guild_data').map(p => `smdb_data.${p} (table) is missing`),
      "smdb_data.guild_data_pkey is an index, where this bot's schema has a partitioned index",
      "smdb_data.guild_data_pkey is CREATE UNIQUE INDEX guild_data_pkey ON smdb_data.guild_data USING btree (guild_id, module, filename), where this bot's schema has CREATE UNIQUE INDEX guild_data_pkey ON ONLY smdb_data.guild_data USING btree (guild_id, module, filename)",
    ];
    expect(run.verdict).toEqual({
      state: 'shape',
      reason: `the database's smdb_data holds objects but no schema_version, ${CONFIRM}: smdb_data.guild_data (table); compared with this bot's schema: ${listed(sentences)}`,
      fix: RENAME_FIX,
    });
    expect(run.lines).toEqual(logLines(`schema-mismatch: smdb_data holds 2 object(s) but no schema_version, ${CONFIRM} (a provisioning or restore that did not finish, or another program); refusing to serve`, sentences));
  }, T);

  it('row 44: meta without a value column', async () => {
    const run = await row('r44', 'empty', p => sql(p, 'CREATE SCHEMA smdb_data',
      'CREATE TABLE smdb_data.meta (key text PRIMARY KEY, updated_at timestamptz NOT NULL DEFAULT now())'));
    expect(run.verdict).toEqual({
      state: 'shape',
      reason: `the database's smdb_data holds objects and its schema_version can't be read (smdb_data.meta has no text column value), ${CONFIRM}: smdb_data.meta (table); compared with this bot's schema: smdb_data.meta has no column value (text NOT NULL)`,
      fix: UNREADABLE_FIX,
    });
  }, T);

  it("row 45: meta with value jsonb holding this bot's version", async () => {
    const run = await row('r45', 'store', p => sql(p, 'ALTER TABLE smdb_data.meta ALTER COLUMN value TYPE jsonb USING value::jsonb'));
    expect(run.verdict).toEqual({
      state: 'shape',
      reason: `the database's smdb_data holds objects and its schema_version can't be read (smdb_data.meta has no text column value), ${CONFIRM}: ${FIRST_FIVE}; compared with this bot's schema: smdb_data.meta column value is jsonb, where this bot's schema has text`,
      fix: UNREADABLE_FIX,
    });
    expect(run.verdict.fix).not.toContain('RENAME');
    expect(run.verdict.reason).not.toContain('[object Object]');
  }, T);

  it("row 46: meta made as a view returning this bot's version", async () => {
    const run = await row('r46', 'empty', p => sql(p, 'CREATE SCHEMA smdb_data',
      `CREATE VIEW smdb_data.meta AS SELECT 'schema_version'::text AS key, '${JSON.stringify({ v: SCHEMA_VERSION })}'::text AS value, now() AS updated_at`));
    const cause = 'smdb_data.meta is a view, not a table';
    const sentences = [
      "smdb_data.meta is a view, where this bot's schema has a table",
      "smdb_data.meta column key allows NULL, where this bot's schema has NOT NULL",
      "smdb_data.meta column updated_at allows NULL, where this bot's schema has NOT NULL",
      "smdb_data.meta column value allows NULL, where this bot's schema has NOT NULL",
      "smdb_data.meta column updated_at has no default, where this bot's schema has default now()",
      'smdb_data.meta lacks constraint meta_pkey (PRIMARY KEY (key))',
      'smdb_data.meta_pkey (index) is missing',
    ];
    expect(run.verdict).toEqual({
      state: 'shape',
      reason: `the database's smdb_data holds objects and its schema_version can't be read (${cause}), ${CONFIRM}: smdb_data.meta (view); compared with this bot's schema: ${listed(sentences)}`,
      fix: UNREADABLE_FIX,
    });
    expect(run.lines).toEqual(logLines(`schema-mismatch: smdb_data holds 1 object(s) and its schema_version can't be read (${cause}), ${CONFIRM}; refusing to serve`, sentences));
  }, T);

  it('row 57: meta with row level security enabled and forced and a policy hiding the version', async () => {
    const run = await row('r57', 'store', p => sql(p,
      'ALTER TABLE smdb_data.meta ENABLE ROW LEVEL SECURITY', 'ALTER TABLE smdb_data.meta FORCE ROW LEVEL SECURITY',
      `CREATE POLICY p57 ON smdb_data.meta USING (key <> 'schema_version')`));
    const sentences = [
      "smdb_data.meta has row level security on and forced, where this bot's schema has it off",
      "smdb_data.meta has policy p57 (AS PERMISSIVE FOR ALL TO public USING ((key <> 'schema_version'::text))), which this bot's schema does not have",
    ];
    expect(run.verdict).toEqual({
      state: 'shape',
      reason: `the database's smdb_data holds objects and its schema_version can't be read (row level security on smdb_data.meta can hide rows), ${CONFIRM}: ${FIRST_FIVE}; compared with this bot's schema: ${listed(sentences)}`,
      fix: UNREADABLE_FIX,
    });
    expect(differences(run)).toEqual(sentences);
  }, T);

  it('row 58: meta without its primary key, holding two schema_version rows: the same refusal on every boot', async () => {
    const run = await row('r58', 'store', p => sql(p, 'ALTER TABLE smdb_data.meta DROP CONSTRAINT meta_pkey',
      `INSERT INTO smdb_data.meta (key, value) VALUES ('schema_version', '{"v":2}')`));
    const cause = 'smdb_data.meta has no unique index on key, so it can hold more than one schema_version';
    const sentences = ['smdb_data.meta lacks constraint meta_pkey (PRIMARY KEY (key))', 'smdb_data.meta_pkey (index) is missing'];
    expect(run.verdict).toEqual({
      state: 'shape',
      reason: `the database's smdb_data holds objects and its schema_version can't be read (${cause}), ${CONFIRM}: ${FIRST_FIVE}; compared with this bot's schema: ${listed(sentences)}`,
      fix: UNREADABLE_FIX,
    });
    expect(run.lines).toEqual(logLines(`schema-mismatch: smdb_data holds 157 object(s) and its schema_version can't be read (${cause}), ${CONFIRM}; refusing to serve`, sentences));
    expect(await boot(urlOf(rig, run.db))).toEqual(run.verdict);
  }, T);
});

describe("decision 4: a provisioned store that differs", () => {
  const exact = async (name: string, change: (p: Pool) => Promise<void>, sentences: string[], fix = SHAPE_FIX) => {
    const run = await row(name, 'store', change);
    expect(run.verdict).toEqual({ state: 'shape', reason: DIFFERS + sentences.join('; '), fix });
    return run;
  };

  /** The verdict, the log's header and every difference line, in decision 9's order. */
  const full = async (name: string, change: (p: Pool) => Promise<void>, sentences: string[], fix = SHAPE_FIX) => {
    const run = await row(name, 'store', change);
    expect(run.verdict).toEqual({ state: 'shape', reason: DIFFERS + listed(sentences), fix });
    expect(run.lines).toEqual(logLines(differsHeader(sentences.length), sentences));
    return run;
  };

  // ALTER COLUMN SET DEFAULT reaches every partition, and each partition carries the default in the reference too.
  it('row 17: guild_append.seq defaulting to a sequence in another schema', async () => {
    await full('r17', p => sql(p, 'CREATE SEQUENCE public.s17',
      `ALTER TABLE smdb_data.guild_append ALTER COLUMN seq SET DEFAULT nextval('public.s17'::regclass)`),
    familyOf('guild_append').map(t => `smdb_data.${t} column seq has default nextval('public.s17'::regclass), where this bot's schema has default nextval('smdb_data.guild_append_seq'::regclass)`));
  }, T);

  // PostgreSQL 16 refuses an identity column on a partitioned table, so the row runs on shard_claims.claim.
  it('row 18: an identity column', async () => {
    await full('r18', p => sql(p, 'ALTER TABLE smdb_data.shard_claims ALTER COLUMN claim ADD GENERATED BY DEFAULT AS IDENTITY'), [
      "smdb_data.shard_claims column claim is an identity column, where this bot's schema has a plain column",
      "smdb_data.shard_claims_claim_seq (sequence) is not part of this bot's schema",
    ]);
  }, T);

  it('row 19: module of guild_data with COLLATE "C"', async () => {
    await full('r19', p => sql(p, 'ALTER TABLE smdb_data.guild_data ALTER COLUMN module TYPE text COLLATE "C"'),
      familyOf('guild_data').map(t => `smdb_data.${t} column module uses collation "C", where this bot's schema uses "default"`));
  }, T);

  it('row 49 (G9): guild_data_graveyard.doc set to PLAIN storage', async () => {
    await full('r49', p => sql(p, 'ALTER TABLE smdb_data.guild_data_graveyard ALTER COLUMN doc SET STORAGE PLAIN'),
      ["smdb_data.guild_data_graveyard column doc has storage PLAIN, where this bot's schema has EXTENDED"]);
  }, T);

  it('row 51 (G9): claim_clock on a copy of heap as its access method', async () => {
    await full('r51', p => sql(p, 'CREATE ACCESS METHOD heap2 TYPE TABLE HANDLER heap_tableam_handler',
      'ALTER TABLE smdb_data.claim_clock SET ACCESS METHOD heap2'),
    ["smdb_data.claim_clock uses access method heap2, where this bot's schema uses heap"]);
  }, T);

  // Dropping meta's primary key trips the meta gate (row 58's cause), so the store is compared in decision 5's mode.
  it('row 20: the primary key of meta dropped', async () => {
    const run = await row('r20_meta', 'store', p => sql(p, 'ALTER TABLE smdb_data.meta DROP CONSTRAINT meta_pkey'));
    const cause = 'smdb_data.meta has no unique index on key, so it can hold more than one schema_version';
    const sentences = ['smdb_data.meta lacks constraint meta_pkey (PRIMARY KEY (key))', 'smdb_data.meta_pkey (index) is missing'];
    expect(run.verdict).toEqual({
      state: 'shape',
      reason: `the database's smdb_data holds objects and its schema_version can't be read (${cause}), ${CONFIRM}: ${FIRST_FIVE}; compared with this bot's schema: ${listed(sentences)}`,
      fix: UNREADABLE_FIX,
    });
    expect(run.lines).toEqual(logLines(`schema-mismatch: smdb_data holds 157 object(s) and its schema_version can't be read (${cause}), ${CONFIRM}; refusing to serve`, sentences));
  }, T);

  it.each([
    ['guild_ownership', 'PRIMARY KEY (guild_id)'],
    ['shard_claims', 'PRIMARY KEY (shard_count, shard_id)'],
    ['claim_clock', 'PRIMARY KEY (id)'],
    ['shard_nodes', 'PRIMARY KEY (node_id)'],
    ['guild_data_graveyard', 'PRIMARY KEY (guild_id, retired_at, module, filename)'],
    ['guild_requests', 'PRIMARY KEY (id)'],
  ])('row 20: the primary key of %s dropped', async (table, def) => {
    await exact(`r20_${table}`, p => sql(p, `ALTER TABLE smdb_data.${table} DROP CONSTRAINT ${table}_pkey`),
      [`smdb_data.${table} lacks constraint ${table}_pkey (${def})`, `smdb_data.${table}_pkey (index) is missing`]);
  }, T);

  // 66 differences: the log lists 50 and counts the other 16.
  it.each([
    ['guild_data', 'PRIMARY KEY (guild_id, module, filename)'],
    ['guild_append', 'PRIMARY KEY (guild_id, module, filename, seq)'],
  ])('row 20: the primary key of the partitioned %s dropped', async (table, def) => {
    await full(`r20_${table}`, p => sql(p, `ALTER TABLE smdb_data.${table} DROP CONSTRAINT ${table}_pkey`), [
      `smdb_data.${table} lacks constraint ${table}_pkey (${def})`,
      ...partitionsOf(table).flatMap(p => [`smdb_data.${p} lacks constraint ${p}_pkey (${def})`, `smdb_data.${p}_pkey (index) is missing`]),
      `smdb_data.${table}_pkey (partitioned index) is missing`,
    ]);
  }, T);

  it('row 21: the CHECK on kind dropped', async () => {
    await exact('r21a', p => sql(p, 'ALTER TABLE smdb_data.guild_data_graveyard DROP CONSTRAINT guild_data_graveyard_kind_check'),
      ["smdb_data.guild_data_graveyard lacks constraint guild_data_graveyard_kind_check (CHECK ((kind = ANY (ARRAY['doc'::text, 'append'::text]))))"]);
  }, T);

  it('row 21: the CHECK id = 1 dropped', async () => {
    await exact('r21b', p => sql(p, 'ALTER TABLE smdb_data.claim_clock DROP CONSTRAINT claim_clock_id_check'),
      ['smdb_data.claim_clock lacks constraint claim_clock_id_check (CHECK ((id = 1)))']);
  }, T);

  it('row 22: an extra CHECK', async () => {
    await exact('r22a', p => sql(p, 'ALTER TABLE smdb_data.shard_nodes ADD CONSTRAINT x22 CHECK (capacity > 0)'),
      ["smdb_data.shard_nodes has constraint x22 (CHECK ((capacity > 0))), which this bot's schema does not have"]);
  }, T);

  it('row 22: an extra UNIQUE', async () => {
    await exact('r22b', p => sql(p, 'ALTER TABLE smdb_data.shard_nodes ADD CONSTRAINT u22 UNIQUE (node_name)'),
      ["smdb_data.shard_nodes has constraint u22 (UNIQUE (node_name)), which this bot's schema does not have", "smdb_data.u22 (index) is not part of this bot's schema"]);
  }, T);

  it('row 22: an extra FOREIGN KEY', async () => {
    await exact('r22c', p => sql(p, 'ALTER TABLE smdb_data.guild_ownership ADD CONSTRAINT f22 FOREIGN KEY (node_id) REFERENCES smdb_data.shard_nodes (node_id)'),
      ["smdb_data.guild_ownership has constraint f22 (FOREIGN KEY (node_id) REFERENCES smdb_data.shard_nodes(node_id)), which this bot's schema does not have"]);
  }, T);

  it('row 23: a CHECK added NOT VALID', async () => {
    await exact('r23', p => sql(p, 'ALTER TABLE smdb_data.shard_nodes ADD CONSTRAINT n23 CHECK (capacity > 0) NOT VALID'),
      ["smdb_data.shard_nodes has constraint n23 (CHECK ((capacity > 0)) NOT VALID), which this bot's schema does not have"]);
  }, T);

  it.each(['guild_ownership_node_idx', 'guild_ownership_claim_idx', 'guild_graveyard_ttl_idx', 'guild_requests_pending_idx', 'guild_requests_applying_idx'])('row 24: %s dropped', async index => {
    await exact(`r24_${index}`, p => sql(p, `DROP INDEX smdb_data.${index}`), [`smdb_data.${index} (index) is missing`]);
  }, T);

  it('row 25: an extra index on a table', async () => {
    await exact('r25a', p => sql(p, 'CREATE INDEX x25 ON smdb_data.guild_ownership (shard_id)'), ["smdb_data.x25 (index) is not part of this bot's schema"]);
  }, T);

  it('row 25: an extra index on a partition', async () => {
    await exact('r25b', p => sql(p, 'CREATE INDEX x25p ON smdb_data.guild_data_p03 (module)'), ["smdb_data.x25p (index) is not part of this bot's schema"]);
  }, T);

  it('row 26: an index renamed', async () => {
    await exact('r26', p => sql(p, 'ALTER INDEX smdb_data.guild_graveyard_ttl_idx RENAME TO x26'),
      ['smdb_data.guild_graveyard_ttl_idx (index) is missing', "smdb_data.x26 (index) is not part of this bot's schema"]);
  }, T);

  it('row 27: guild_ownership_node_idx left invalid under its own name', async () => {
    await exact('r27', async (p) => {
      await p.query('DROP INDEX smdb_data.guild_ownership_node_idx');
      const holder = await clientOn(urlOf(rig, 'nb16_r27'));
      const builder = await clientOn(urlOf(rig, 'nb16_r27'));
      try {
        await holder.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await holder.query('SELECT 1');
        await builder.query(`SET statement_timeout = '1s'`);
        await expect(builder.query('CREATE INDEX CONCURRENTLY guild_ownership_node_idx ON smdb_data.guild_ownership (node_id)')).rejects.toMatchObject({ code: '57014' });
        await holder.query('ROLLBACK');
      } finally {
        await holder.end();
        await builder.end();
      }
    }, ['smdb_data.guild_ownership_node_idx is not valid, so Postgres does not use it to enforce or search']);
  }, T);

  it('row 28: a partition detached and dropped', async () => {
    await exact('r28', p => sql(p, 'ALTER TABLE smdb_data.guild_data DETACH PARTITION smdb_data.guild_data_p07', 'DROP TABLE smdb_data.guild_data_p07'),
      ['smdb_data.guild_data_p07 (table) is missing', 'smdb_data.guild_data_p07_pkey (index) is missing'], SHAPE_FIX + RESTORE);
  }, T);

  it('row 29: guild_data_p05 detached and a public table attached for remainder 5', async () => {
    await exact('r29', p => sql(p,
      'ALTER TABLE smdb_data.guild_data DETACH PARTITION smdb_data.guild_data_p05',
      'CREATE TABLE public.gd5 (LIKE smdb_data.guild_data INCLUDING DEFAULTS)',
      'ALTER TABLE smdb_data.guild_data ATTACH PARTITION public.gd5 FOR VALUES WITH (MODULUS 32, REMAINDER 5)'),
    ["smdb_data.guild_data_p05 is not a partition, where this bot's schema has a partition of smdb_data.guild_data FOR VALUES WITH (modulus 32, remainder 5)"]);
  }, T);

  it('row 30: claim_clock set UNLOGGED', async () => {
    await exact('r30a', p => sql(p, 'ALTER TABLE smdb_data.claim_clock SET UNLOGGED'), ["smdb_data.claim_clock is UNLOGGED, where this bot's schema has it logged"]);
  }, T);

  it('row 30: claim_seq set UNLOGGED', async () => {
    await exact('r30b', p => sql(p, 'ALTER SEQUENCE smdb_data.claim_seq SET UNLOGGED'), ["smdb_data.claim_seq is UNLOGGED, where this bot's schema has it logged"]);
  }, T);

  it('row 31: a BEFORE INSERT trigger returning NULL on guild_data_p05', async () => {
    await exact('r31', p => sql(p,
      `CREATE FUNCTION public.f31() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`,
      'CREATE TRIGGER t31 BEFORE INSERT ON smdb_data.guild_data_p05 FOR EACH ROW EXECUTE FUNCTION public.f31()'),
    ["smdb_data.guild_data_p05 has trigger t31 (CREATE TRIGGER t31 BEFORE INSERT ON smdb_data.guild_data_p05 FOR EACH ROW EXECUTE FUNCTION public.f31()), which this bot's schema does not have"]);
  }, T);

  it('row 32: a rule on guild_data_graveyard', async () => {
    await full('r32', p => sql(p, 'CREATE RULE r32 AS ON INSERT TO smdb_data.guild_data_graveyard DO INSTEAD NOTHING'),
      ["smdb_data.guild_data_graveyard has rule r32 (CREATE RULE r32 AS\n    ON INSERT TO smdb_data.guild_data_graveyard DO INSTEAD NOTHING;), which this bot's schema does not have"]);
  }, T);

  it('row 33: row level security on guild_data', async () => {
    await exact('r33a', p => sql(p, 'ALTER TABLE smdb_data.guild_data ENABLE ROW LEVEL SECURITY'),
      ["smdb_data.guild_data has row level security on, where this bot's schema has it off"]);
  }, T);

  it('row 33: row level security on and forced on guild_data, with a policy', async () => {
    await exact('r33b', p => sql(p, 'ALTER TABLE smdb_data.guild_data ENABLE ROW LEVEL SECURITY', 'ALTER TABLE smdb_data.guild_data FORCE ROW LEVEL SECURITY',
      'CREATE POLICY p33 ON smdb_data.guild_data USING (true)'),
    ["smdb_data.guild_data has row level security on and forced, where this bot's schema has it off",
      "smdb_data.guild_data has policy p33 (AS PERMISSIVE FOR ALL TO public USING (true)), which this bot's schema does not have"]);
  }, T);

  it('row 33: FORCE ROW LEVEL SECURITY alone on claim_clock', async () => {
    await exact('r33c', p => sql(p, 'ALTER TABLE smdb_data.claim_clock FORCE ROW LEVEL SECURITY'),
      ["smdb_data.claim_clock has row level security forced but not enabled, where this bot's schema has it off"]);
  }, T);

  it.each([
    ['CACHE 20', 'cache 20', '1'],
    ['INCREMENT BY -1', 'increment -1', '1'],
    ['CYCLE', 'cycle on', 'off'],
    ['MAXVALUE 100', 'maximum 100', '9223372036854775807'],
  ])('row 34: claim_seq %s', async (clause, found, ref) => {
    await exact(`r34_${clause.split(' ')[0].toLowerCase()}`, p => sql(p, `ALTER SEQUENCE smdb_data.claim_seq ${clause}`),
      [`sequence smdb_data.claim_seq has ${found}, where this bot's schema has ${ref}`]);
  }, T);

  it('row 35: guild_append_seq dropped', async () => {
    await full('r35', p => sql(p, 'DROP SEQUENCE smdb_data.guild_append_seq CASCADE'), [
      ...familyOf('guild_append').map(t => `smdb_data.${t} column seq has no default, where this bot's schema has default nextval('smdb_data.guild_append_seq'::regclass)`),
      'smdb_data.guild_append_seq (sequence) is missing',
    ]);
  }, T);

  it.each([
    ['table', 'CREATE TABLE smdb_data.x36 (a integer)', "smdb_data.x36 (table) is not part of this bot's schema"],
    ['view', 'CREATE VIEW smdb_data.x36 AS SELECT 1 AS a', "smdb_data.x36 (view) is not part of this bot's schema"],
    ['sequence', 'CREATE SEQUENCE smdb_data.x36', "smdb_data.x36 (sequence) is not part of this bot's schema"],
  ])('row 36: an extra %s', async (kind, statement, sentence) => {
    await exact(`r36_${kind}`, p => sql(p, statement), [sentence]);
  }, T);

  it('row 37: guild_data dropped is refused, never recreated, and the fix names a restore', async () => {
    const run = await full('r37a', p => sql(p, 'DROP TABLE smdb_data.guild_data'), [
      'smdb_data.guild_data (partitioned table) is missing',
      ...partitionsOf('guild_data').flatMap(p => [`smdb_data.${p} (table) is missing`, `smdb_data.${p}_pkey (index) is missing`]),
      'smdb_data.guild_data_pkey (partitioned index) is missing',
    ], SHAPE_FIX + RESTORE);
    expect((await run.pool.query(`SELECT to_regclass('smdb_data.guild_data') AS t`)).rows[0].t).toBeNull();
  }, T);

  it('row 37: shard_claims dropped', async () => {
    await exact('r37b', p => sql(p, 'DROP TABLE smdb_data.shard_claims'),
      ['smdb_data.shard_claims (table) is missing', 'smdb_data.shard_claims_pkey (index) is missing'], SHAPE_FIX + RESTORE);
  }, T);

  it('row 37: guild_requests dropped', async () => {
    await exact('r37c', p => sql(p, 'DROP TABLE smdb_data.guild_requests'),
      ['smdb_data.guild_requests (table) is missing', 'smdb_data.guild_requests_applying_idx (index) is missing',
        'smdb_data.guild_requests_pending_idx (index) is missing', 'smdb_data.guild_requests_pkey (index) is missing'], SHAPE_FIX + RESTORE);
  }, T);

  it('row 59: shard_nodes inherits from public.p', async () => {
    await exact('r59', p => sql(p, 'CREATE TABLE public.p (node_id text)', 'ALTER TABLE smdb_data.shard_nodes INHERIT public.p'),
      ["smdb_data.shard_nodes inherits from public.p, where this bot's schema has no parent"]);
  }, T);

  it('row 60: reason replaced by a generated column', async () => {
    await exact('r60', p => sql(p, 'ALTER TABLE smdb_data.guild_data_graveyard DROP COLUMN reason',
      `ALTER TABLE smdb_data.guild_data_graveyard ADD COLUMN reason text NOT NULL GENERATED ALWAYS AS ('x') STORED`),
    ["smdb_data.guild_data_graveyard column reason is a generated column ('x'::text), where this bot's schema has a plain column"]);
  }, T);

  it('row 62: a policy on guild_data with row level security off', async () => {
    await exact('r62', p => sql(p, 'CREATE POLICY p62 ON smdb_data.guild_data USING (true)'),
      ["smdb_data.guild_data has policy p62 (AS PERMISSIVE FOR ALL TO public USING (true)), which this bot's schema does not have"]);
  }, T);
});

describe('privileges (decision 15), as the bot role, not a superuser', () => {
  it.each([
    ['INSERT on guild_data', 'REVOKE INSERT ON smdb_data.guild_data FROM nb16_bot', `this bot's database role ${BOT_ROLE} lacks INSERT on smdb_data.guild_data`, `GRANT INSERT ON smdb_data.guild_data TO ${BOT_ROLE}`],
    ['USAGE on guild_append_seq', 'REVOKE USAGE ON SEQUENCE smdb_data.guild_append_seq FROM nb16_bot', `this bot's database role ${BOT_ROLE} lacks USAGE on sequence smdb_data.guild_append_seq`, `GRANT USAGE ON SEQUENCE smdb_data.guild_append_seq TO ${BOT_ROLE}`],
    ['UPDATE on claim_seq', 'REVOKE UPDATE ON SEQUENCE smdb_data.claim_seq FROM nb16_bot', `this bot's database role ${BOT_ROLE} lacks UPDATE on sequence smdb_data.claim_seq`, `GRANT UPDATE ON SEQUENCE smdb_data.claim_seq TO ${BOT_ROLE}`],
  ])('row 52: the role lacks %s', async (name, revoke, line, grant) => {
    const run = await row(`r52_${name.split(' ')[0].toLowerCase()}_${name.split(' ').pop()}`, 'store', async (p, db) => { await grantBot(p, db); await p.query(revoke); }, true);
    expect(run.verdict).toEqual({
      state: 'shape',
      reason: `this bot's database role ${BOT_ROLE} lacks privileges on smdb_data, which matches this bot's schema (version ${SCHEMA_VERSION}): ${line}`,
      fix: `${KEPT}as the owner of smdb_data's tables and sequences or a superuser, run ${grant}${LOGIN_TAIL}`,
    });
    expect(run.verdict.fix).not.toContain('RENAME');
  }, T);

  it('row 63: no USAGE on smdb_data, a store with guild rows', async () => {
    const run = await row('r63', 'store', async (p, db) => {
      await p.query(`INSERT INTO smdb_data.guild_data (guild_id, module, filename, doc) VALUES ('1', 'm', 'a.json', '{}')`);
      await grantBot(p, db);
      await p.query(`REVOKE USAGE ON SCHEMA smdb_data FROM ${BOT_ROLE}`);
    }, true);
    expect(run.verdict).toEqual({
      state: 'shape',
      reason: `this bot's database role ${BOT_ROLE} lacks privileges it needs on smdb_data, so the schema itself was not compared: this bot's database role ${BOT_ROLE} lacks USAGE on schema smdb_data`,
      fix: `${KEPT}as the owner of smdb_data or a superuser, run GRANT USAGE ON SCHEMA smdb_data TO ${BOT_ROLE}${LOGIN_TAIL}`,
    });
    expect(run.lines[0]).toContain("since without them the bot can't read its schema_version");
  }, T);

  it('row 64: USAGE but no SELECT on meta', async () => {
    const run = await row('r64', 'store', async (p, db) => { await grantBot(p, db); await p.query(`REVOKE SELECT ON smdb_data.meta FROM ${BOT_ROLE}`); }, true);
    expect(run.verdict.reason).toBe(`this bot's database role ${BOT_ROLE} lacks privileges it needs on smdb_data, so the schema itself was not compared: this bot's database role ${BOT_ROLE} lacks SELECT on smdb_data.meta`);
  }, T);

  it("row 65: an empty smdb_data owned by another role: section 3's texts, exactly", async () => {
    const run = await row('r65', 'empty', async (p, db) => {
      await p.query('CREATE SCHEMA smdb_data');
      await p.query(`GRANT USAGE ON SCHEMA smdb_data TO ${BOT_ROLE}`);
      await grantBot(p, db, { store: false });
    }, true);
    expect(run.lines).toEqual([
      `[PostgresBackend] schema-mismatch: this bot's database role ${BOT_ROLE} lacks 1 privilege(s) it needs on smdb_data; the schema itself was not compared, since without them the bot can't make its tables in smdb_data; refusing to serve`,
      `[PostgresBackend] schema difference: this bot's database role ${BOT_ROLE} lacks CREATE on schema smdb_data`,
    ]);
    expect(run.verdict.fix).toBe(`${KEPT}as the owner of smdb_data or a superuser, run GRANT CREATE ON SCHEMA smdb_data TO ${BOT_ROLE}${LOGIN_TAIL}`);
  }, T);

  it('row 66: no CREATE on the database, a provisioned store with guild rows', async () => {
    const run = await row('r66a', 'store', async (p, db) => {
      await p.query(`INSERT INTO smdb_data.guild_data (guild_id, module, filename, doc) VALUES ('1', 'm', 'a.json', '{}')`);
      await grantBot(p, db, { databaseCreate: false });
    }, true);
    expect(run.lines).toEqual([
      `[PostgresBackend] schema-mismatch: this bot's database role ${BOT_ROLE} lacks 1 privilege(s) it needs on database nb16_r66a; the schema itself was not compared, since without them the bot can't make a schema in database nb16_r66a (smdb_data, or the copy of its schema it compares with at every boot); refusing to serve`,
      `[PostgresBackend] schema difference: this bot's database role ${BOT_ROLE} lacks CREATE on database nb16_r66a`,
    ]);
    expect(run.verdict.fix).toBe(`${KEPT}as the owner of database nb16_r66a or a superuser, run GRANT CREATE ON DATABASE nb16_r66a TO ${BOT_ROLE}${LOGIN_TAIL}`);
  }, T);

  it('row 66: no CREATE on a fresh database', async () => {
    const run = await row('r66b', 'empty', async () => undefined, true);
    expect(run.lines).toEqual([
      `[PostgresBackend] schema-mismatch: this bot's database role ${BOT_ROLE} lacks 1 privilege(s) it needs on database nb16_r66b; no smdb_data exists and none was made, since without them the bot can't make a schema in database nb16_r66b (smdb_data, or the copy of its schema it compares with at every boot); refusing to serve`,
      `[PostgresBackend] schema difference: this bot's database role ${BOT_ROLE} lacks CREATE on database nb16_r66b`,
    ]);
    expect(run.verdict.fix).toBe(`${KEPT}as the owner of database nb16_r66b or a superuser, run GRANT CREATE ON DATABASE nb16_r66b TO ${BOT_ROLE}${LOGIN_TAIL}`);
    expect(await hasSmdbData(run.pool)).toBe(false);
  }, T);

  it.each(['INSERT', 'DELETE'])("row 67 (decision 7 step 8): default privileges that revoke %s from the bot on its new tables, on a fresh database", async privilege => {
    const run = await row(`r67_${privilege.toLowerCase()}`, 'empty', async (p, db) => {
      await grantBot(p, db, { store: false });
      await p.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${BOT_ROLE} REVOKE ${privilege} ON TABLES FROM ${BOT_ROLE}`);
    }, true);
    const lines = ['claim_clock', 'guild_append', 'guild_data', 'guild_data_graveyard', 'guild_ownership', 'guild_requests', 'identify_slots', 'meta', 'reshard', 'shard_claims', 'shard_nodes']
      .map(t => `this bot's database role ${BOT_ROLE} lacks ${privilege} on smdb_data.${t}`);
    expect(run.verdict).toEqual({
      state: 'shape',
      reason: `this bot's database role ${BOT_ROLE} lacked privileges on the schema it made in the database, so it was rolled back (default privileges or an event trigger take them from new tables): ${listed(lines)}`,
      fix: `${KEPT}as ${BOT_ROLE} or a superuser, run ALTER DEFAULT PRIVILEGES FOR ROLE ${BOT_ROLE} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${BOT_ROLE}; ALTER DEFAULT PRIVILEGES FOR ROLE ${BOT_ROLE} GRANT USAGE, UPDATE ON SEQUENCES TO ${BOT_ROLE} (SELECT * FROM pg_default_acl lists what is set), remove any event trigger that revokes privileges on new tables, and restart the bot`,
    });
    expect(run.verdict.reason).toContain('; and 6 more (the bot\'s log lists them)');
    expect(run.lines).toEqual(logLines(`schema-mismatch: this bot's database role ${BOT_ROLE} lacked 11 privilege(s) on the schema it made in the database, so it was rolled back before it was committed (default privileges set with ALTER DEFAULT PRIVILEGES, or an event trigger, take them from new tables); refusing to serve`, lines));
    expect(await hasSmdbData(run.pool)).toBe(false);
  }, T);

  it('row 68 (G3): a role with quote_all_identifiers on passes a matching store', async () => {
    const role = 'nb16_quoted';
    await rig.admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'pw'`);
    await rig.admin.query(`ALTER ROLE ${role} SET quote_all_identifiers = on`);
    const db = 'nb16_r68';
    const pool = await newDatabase(rig, db, 'store');
    try {
      await pool.query(`GRANT CREATE ON DATABASE ${db} TO ${role}`);
      await pool.query(`GRANT USAGE ON SCHEMA smdb_data TO ${role}`);
      await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA smdb_data TO ${role}`);
      await pool.query(`GRANT USAGE, UPDATE ON ALL SEQUENCES IN SCHEMA smdb_data TO ${role}`);
      const url = urlOf(rig, db, { user: role, password: 'pw' });
      const probe = await clientOn(url);
      try {
        expect((await probe.query('SHOW quote_all_identifiers')).rows[0].quote_all_identifiers).toBe('on');
      } finally {
        await probe.end();
      }
      expect(await boot(url)).toEqual({ state: 'provisioned' });
      expect(errors.mock.calls.map(c => String(c[0])).filter(l => l.includes('schema difference'))).toEqual([]);
      expect(await shapeSchemas(pool)).toEqual([]);
    } finally {
      await pool.query(`DROP OWNED BY ${role}`);
      await closePool(rig, db);
      await rig.admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1`, [role]);
      await rig.admin.query(`DROP OWNED BY ${role}`);
      await rig.admin.query(`DROP ROLE ${role}`);
    }
  }, T);
});

describe('a fresh database whose new tables an event trigger changes (row 55)', () => {
  it('is refused with the fresh header; nothing committed, no smdb_data left', async () => {
    const run = await row('r55', 'empty', p => sql(p,
      `CREATE FUNCTION public.nb16_flip_doc() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.doc := '{}'; RETURN NEW; END $$`,
      `CREATE FUNCTION public.nb16_arm() RETURNS event_trigger LANGUAGE plpgsql AS $$
        DECLARE obj record;
        BEGIN
          FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
            IF obj.object_type = 'table' AND obj.object_identity = 'smdb_data.guild_data' THEN
              EXECUTE 'CREATE TRIGGER nb16_flip BEFORE INSERT ON smdb_data.guild_data FOR EACH ROW EXECUTE FUNCTION public.nb16_flip_doc()';
            END IF;
          END LOOP;
        END $$`,
      `CREATE EVENT TRIGGER nb16_arm ON ddl_command_end WHEN TAG IN ('CREATE TABLE') EXECUTE FUNCTION public.nb16_arm()`));
    try {
      // The server decides whether each partition's clone of the trigger is internal; read its answer by making the
      // same schema under the same event trigger and rolling it back.
      const probe = await clientOn(urlOf(rig, run.db));
      let triggers: Array<{ rel: string; def: string }>;
      try {
        await probe.query('BEGIN');
        await probe.query('SET LOCAL search_path = pg_catalog');
        for (const s of [...provisionDdl('smdb_data'), ...partitionDdl('smdb_data', true)]) await probe.query(s);
        triggers = (await probe.query(
          `SELECT c.relname AS rel, pg_get_triggerdef(g.oid) AS def FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
            WHERE c.relnamespace = 'smdb_data'::regnamespace AND g.tgname = 'nb16_flip' AND NOT g.tgisinternal`)).rows;
        await probe.query('ROLLBACK');
      } finally {
        await probe.end();
      }
      expect(triggers.map(t => t.rel)).toContain('guild_data');
      expect(triggers.every(t => t.rel === 'guild_data' || /^guild_data_p\d\d$/.test(t.rel))).toBe(true);
      const sentences = triggers.sort((a, b) => (a.rel < b.rel ? -1 : 1))
        .map(t => `smdb_data.${t.rel} has trigger nb16_flip (${t.def}), which this bot's schema does not have`);
      expect(sentences[0]).toBe("smdb_data.guild_data has trigger nb16_flip (CREATE TRIGGER nb16_flip BEFORE INSERT ON smdb_data.guild_data FOR EACH ROW EXECUTE FUNCTION public.nb16_flip_doc()), which this bot's schema does not have");
      expect(run.verdict).toEqual({
        state: 'shape',
        reason: `the schema this bot made in the database differed from this bot's schema and was rolled back (an event trigger or another program changes new tables): ${listed(sentences)}`,
        fix: `${KEPT}remove what changes new tables in that database (its event triggers are listed by SELECT evtname FROM pg_event_trigger) and restart the bot`,
      });
      expect(run.lines).toEqual(logLines("schema-mismatch: the schema this bot made in the database differed from this bot's schema before it was committed, so it was rolled back (an event trigger or another program changes tables as they are made); refusing to serve", sentences));
      expect(await hasSmdbData(run.pool)).toBe(false);
    } finally {
      await run.pool.query('DROP EVENT TRIGGER IF EXISTS nb16_arm');
    }
  }, T);
});

describe("a fresh database whose role's default access method is a copy of heap (row 56, G9)", () => {
  it('is provisioned with heap tables, and the next boot passes it', async () => {
    const db = 'nb16_r56';
    const user = rig.container.getUsername();
    const pool = await newDatabase(rig, db, 'empty');
    await sql(pool, 'CREATE ACCESS METHOD heap2 TYPE TABLE HANDLER heap_tableam_handler');
    await rig.admin.query(`ALTER ROLE "${user}" IN DATABASE ${db} SET default_table_access_method = heap2`);
    try {
      const probe = await clientOn(urlOf(rig, db));
      try {
        expect((await probe.query('SHOW default_table_access_method')).rows[0].default_table_access_method).toBe('heap2');
      } finally {
        await probe.end();
      }
      expect(await boot(urlOf(rig, db))).toEqual({ state: 'provisioned' });
      const tables = await pool.query(
        `SELECT count(*)::int AS n, count(*) FILTER (WHERE c.relam <> (SELECT oid FROM pg_am WHERE amname = 'heap'))::int AS other
           FROM pg_class c WHERE c.relnamespace = 'smdb_data'::regnamespace AND c.relkind = 'r'`);
      expect(tables.rows[0]).toEqual({ n: 73, other: 0 });
      expect(await boot(urlOf(rig, db))).toEqual({ state: 'provisioned' });
      expect(await shapeSchemas(pool)).toEqual([]);
    } finally {
      await rig.admin.query(`ALTER ROLE "${user}" IN DATABASE ${db} RESET default_table_access_method`);
    }
  }, T);
});

describe('the encoding (row 71, decision 16)', () => {
  const header = "[PostgresBackend] schema-mismatch: the database's server_encoding is LATIN1, and this bot needs a UTF8 database; smdb_data was not read; refusing to serve";
  const verdict = {
    state: 'shape',
    reason: "the database's server_encoding is LATIN1, and this bot needs a UTF8 database; smdb_data was not read",
    fix: `${KEPT}point DATA_BACKEND_URL, in the web UI env editor, at a database whose encoding is UTF8 (CREATE DATABASE <name> TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' makes one on any server), then restart the bot`,
  };

  async function latin(name: string): Promise<Pool> {
    await rig.admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await rig.admin.query(`CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'LATIN1' LC_COLLATE 'C' LC_CTYPE 'C'`);
    return poolOf(rig, name);
  }

  it('a fresh LATIN1 database is refused and gets no smdb_data', async () => {
    const pool = await latin('nb16_r71a');
    const before = await storeSnapshot(pool);
    expect(await boot(urlOf(rig, 'nb16_r71a'))).toEqual(verdict);
    expect(await storeSnapshot(pool)).toEqual(before);
    expect(await hasSmdbData(pool)).toBe(false);
    expect(errors.mock.calls.map(c => String(c[0])).filter(l => l.startsWith('[PostgresBackend] schema'))).toEqual([header]);
  }, T);

  it('a LATIN1 database holding a store provisionStoreInTransaction made is refused unchanged', async () => {
    const pool = await latin('nb16_r71b');
    const client = await clientOn(urlOf(rig, 'nb16_r71b'));
    try {
      await client.query('BEGIN');
      await provisionStoreInTransaction(client);
      await client.query('COMMIT');
    } finally {
      await client.end();
    }
    const before = await storeSnapshot(pool);
    expect(await boot(urlOf(rig, 'nb16_r71b'))).toEqual(verdict);
    expect(await storeSnapshot(pool)).toEqual(before);
    expect(await shapeSchemas(pool)).toEqual([]);
  }, T);
});

describe("item 7: the BUILD.md row's own case through the full boot path", () => {
  it('refuses with the exact texts, writes no marker, and serves after the schema is renamed aside', async () => {
    const fs = await import('fs');
    const { MARKER, wipeRoot } = await import('../helpers/migrationRig');
    const { setBackendKind } = await import('../helpers/backendKind');
    const db = 'nb16_i7';
    const pool = await newDatabase(rig, db, 'empty');
    await sql(pool,
      'CREATE SCHEMA smdb_data',
      `CREATE TABLE smdb_data.guild_data_graveyard (
        guild_id text NOT NULL, module text NOT NULL, filename text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('doc','append')), doc text NOT NULL, retired_at bigint NOT NULL, reason text, used_at bigint,
        PRIMARY KEY (guild_id, retired_at, module, filename))`,
      'CREATE INDEX IF NOT EXISTS guild_graveyard_ttl_idx ON smdb_data.guild_data_graveyard (retired_at)');
    wipeRoot();
    fs.writeFileSync(MARKER, JSON.stringify({ live: 'postgres', storeId: null, flippedAt: 1 }, null, 2));
    const marker = fs.readFileSync(MARKER, 'utf8');
    setBackendKind('postgres');
    process.env.DATA_BACKEND_URL = urlOf(rig, db);
    try {
      const { initDataBackendLayer, getDataBootStatus } = await import('../../src/bot/internalSetup/utils/dataBackends/boot');
      const until = async (state: string) => {
        const deadline = Date.now() + 60_000;
        while (getDataBootStatus().state !== state && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
        return getDataBootStatus();
      };
      initDataBackendLayer();
      const reason = `the database's smdb_data holds objects but no schema_version, ${CONFIRM}: smdb_data.guild_data_graveyard (table); compared with this bot's schema: smdb_data.guild_data_graveyard column reason allows NULL, where this bot's schema has NOT NULL`;
      expect(await until('refused')).toMatchObject({ state: 'refused', refusalReason: reason });
      const lines = errors.mock.calls.map(c => String(c[0]));
      expect(lines).toEqual(expect.arrayContaining([
        `[PostgresBackend] schema-mismatch: smdb_data holds 3 object(s) but no schema_version, ${CONFIRM} (a provisioning or restore that did not finish, or another program); refusing to serve`,
        "[PostgresBackend] schema difference: smdb_data.guild_data_graveyard column reason allows NULL, where this bot's schema has NOT NULL",
        `[Data] REFUSING to serve: ${reason}`,
        `[Data] ${KEPT}point DATA_BACKEND_URL at a database without the schema smdb_data, or at one this bot provisioned, in the web UI env editor, or rename smdb_data aside in the database (ALTER SCHEMA smdb_data RENAME TO ...) and restart the bot`,
      ]));
      expect(fs.readFileSync(MARKER, 'utf8')).toBe(marker);
      await pool.query('ALTER SCHEMA smdb_data RENAME TO smdb_aside');
      const aside = async () => (await pool.query(
        `SELECT (to_jsonb(c) - ARRAY['relpages', 'reltuples', 'relallvisible', 'relfrozenxid', 'relminmxid'])::text AS r
           FROM pg_class c WHERE c.relnamespace = 'smdb_aside'::regnamespace ORDER BY c.oid`)).rows;
      const asideBefore = await aside();
      initDataBackendLayer();
      expect((await until('serving')).state).toBe('serving');
      expect(await aside()).toEqual(asideBefore);
      expect(await hasSmdbData(pool)).toBe(true);
    } finally {
      setBackendKind(null);
      delete process.env.DATA_BACKEND_URL;
    }
  }, T);
});
