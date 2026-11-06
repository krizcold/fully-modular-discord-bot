import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client, Pool } from 'pg';
import { PostgresBackend, type ProvisionVerdict } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { startPostgres } from './postgres';

// NB16's real-Postgres rig: one container, a template database the bot's own boot provisioned, a new database per
// case, and the catalog snapshot of sheet section 8 items 5 and 6 (G8, G12), read by this file's own queries and never
// by storeShape.ts's reader.

export const TEMPLATE = 'nb16_tpl';
export const BOT_ROLE = 'nb16_bot';
export const BOT_PASSWORD = 'pw';

export interface Nb16Rig {
  container: StartedPostgreSqlContainer;
  admin: Pool;
  pools: Map<string, Pool>;
}

export async function startNb16Rig(): Promise<Nb16Rig> {
  const container = await startPostgres();
  const rig: Nb16Rig = { container, admin: new Pool({ connectionString: urlOf({ container } as Nb16Rig, container.getDatabase()), max: 4 }), pools: new Map() };
  rig.admin.on('error', () => undefined);
  return rig;
}

export async function stopNb16Rig(rig: Nb16Rig | undefined): Promise<void> {
  if (!rig) return;
  for (const pool of rig.pools.values()) await pool.end().catch(() => undefined);
  await rig.admin.end().catch(() => undefined);
  await rig.container.stop();
}

export function urlOf(rig: Pick<Nb16Rig, 'container'>, db: string, role?: { user: string; password: string }): string {
  const c = rig.container;
  const user = encodeURIComponent(role?.user ?? c.getUsername());
  const password = encodeURIComponent(role?.password ?? c.getPassword());
  return `postgres://${user}:${password}@${c.getHost()}:${c.getPort()}/${db}`;
}

/** The superuser's pool on one database. */
export function poolOf(rig: Nb16Rig, db: string): Pool {
  let pool = rig.pools.get(db);
  if (!pool) {
    pool = new Pool({ connectionString: urlOf(rig, db), max: 3 });
    pool.on('error', () => undefined);
    rig.pools.set(db, pool);
  }
  return pool;
}

export async function closePool(rig: Nb16Rig, db: string): Promise<void> {
  const pool = rig.pools.get(db);
  rig.pools.delete(db);
  await pool?.end().catch(() => undefined);
}

/** Ends every session on a database but the caller's, so it can serve as a template or be dropped. */
export async function emptySessions(rig: Nb16Rig, db: string): Promise<void> {
  await closePool(rig, db);
  await rig.admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [db]);
}

/** Boots a PostgresBackend on url until it answers a verdict (or 60 s pass), then stops it. */
export async function boot(url: string, boundMs = 60_000): Promise<ProvisionVerdict | { state: 'timeout' }> {
  const backend = new PostgresBackend({ url });
  backend.start();
  try {
    return await Promise.race([
      backend.provisionVerdict(),
      new Promise<{ state: 'timeout' }>(resolve => { setTimeout(() => resolve({ state: 'timeout' }), boundMs).unref(); }),
    ]);
  } finally {
    await backend.stop();
  }
}

/** The template: a store the bot's own boot provisioned at this bot's SCHEMA_VERSION. */
export async function makeTemplate(rig: Nb16Rig): Promise<void> {
  await rig.admin.query(`CREATE DATABASE ${TEMPLATE}`);
  const verdict = await boot(urlOf(rig, TEMPLATE));
  if (verdict.state !== 'provisioned') throw new Error(`the template was not provisioned: ${JSON.stringify(verdict)}`);
  await emptySessions(rig, TEMPLATE);
}

/** A new database: a copy of the provisioned template, or empty. */
export async function newDatabase(rig: Nb16Rig, name: string, from: 'store' | 'empty'): Promise<Pool> {
  await emptySessions(rig, name);
  await rig.admin.query(`DROP DATABASE IF EXISTS ${name}`);
  if (from === 'store') await emptySessions(rig, TEMPLATE);
  await rig.admin.query(from === 'store' ? `CREATE DATABASE ${name} TEMPLATE ${TEMPLATE}` : `CREATE DATABASE ${name}`);
  return poolOf(rig, name);
}

/** The bot's role (not a superuser) with CREATE on the database and every privilege of decision 2 on the store. */
export async function grantBot(pool: Pool, db: string, opts: { databaseCreate?: boolean; store?: boolean } = {}): Promise<void> {
  if (opts.databaseCreate !== false) await pool.query(`GRANT CREATE ON DATABASE ${db} TO ${BOT_ROLE}`);
  if (opts.store === false) return;
  await pool.query(`GRANT USAGE ON SCHEMA smdb_data TO ${BOT_ROLE}`);
  await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA smdb_data TO ${BOT_ROLE}`);
  await pool.query(`GRANT USAGE, UPDATE ON ALL SEQUENCES IN SCHEMA smdb_data TO ${BOT_ROLE}`);
}

export async function ensureBotRole(rig: Nb16Rig): Promise<void> {
  const { rows } = await rig.admin.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [BOT_ROLE]);
  if (!rows.length) await rig.admin.query(`CREATE ROLE ${BOT_ROLE} LOGIN PASSWORD '${BOT_PASSWORD}'`);
}

export const botUrl = (rig: Nb16Rig, db: string) => urlOf(rig, db, { user: BOT_ROLE, password: BOT_PASSWORD });

type Queryable = { query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> };

const SERVER_KEPT = ['relpages', 'reltuples', 'relallvisible', 'relfrozenxid', 'relminmxid'];

/**
 * G8 and G12: every column of the catalog rows that belong to smdb_data's relations, OIDs and expression trees
 * included, but the pg_class columns the server maintains by itself.
 */
export async function catalogSnapshot(q: Queryable): Promise<Record<string, unknown[]>> {
  const ns = `(SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = 'smdb_data')`;
  const rels = `(SELECT oid FROM pg_catalog.pg_class WHERE relnamespace = ${ns})`;
  const reads: Record<string, string> = {
    namespace: `SELECT to_jsonb(n)::text AS r FROM pg_catalog.pg_namespace n WHERE n.oid = ${ns}`,
    class: `SELECT (to_jsonb(c) - ARRAY[${SERVER_KEPT.map(k => `'${k}'`).join(', ')}])::text AS r FROM pg_catalog.pg_class c WHERE c.relnamespace = ${ns} ORDER BY c.oid`,
    attribute: `SELECT a::text AS r FROM pg_catalog.pg_attribute a WHERE a.attrelid IN ${rels} ORDER BY a.attrelid, a.attnum`,
    constraint: `SELECT to_jsonb(k)::text AS r FROM pg_catalog.pg_constraint k WHERE k.conrelid IN ${rels} OR k.connamespace = ${ns} ORDER BY k.oid`,
    index: `SELECT i::text AS r FROM pg_catalog.pg_index i WHERE i.indexrelid IN ${rels} OR i.indrelid IN ${rels} ORDER BY i.indexrelid`,
    trigger: `SELECT to_jsonb(t)::text AS r FROM pg_catalog.pg_trigger t WHERE t.tgrelid IN ${rels} ORDER BY t.oid`,
    rewrite: `SELECT to_jsonb(w)::text AS r FROM pg_catalog.pg_rewrite w WHERE w.ev_class IN ${rels} ORDER BY w.oid`,
    policy: `SELECT to_jsonb(p)::text AS r FROM pg_catalog.pg_policy p WHERE p.polrelid IN ${rels} ORDER BY p.oid`,
    sequence: `SELECT to_jsonb(s)::text AS r FROM pg_catalog.pg_sequence s WHERE s.seqrelid IN ${rels} ORDER BY s.seqrelid`,
    attrdef: `SELECT to_jsonb(d)::text AS r FROM pg_catalog.pg_attrdef d WHERE d.adrelid IN ${rels} ORDER BY d.oid`,
    inherits: `SELECT to_jsonb(h)::text AS r FROM pg_catalog.pg_inherits h WHERE h.inhrelid IN ${rels} OR h.inhparent IN ${rels} ORDER BY h.inhrelid, h.inhseqno`,
  };
  const out: Record<string, unknown[]> = {};
  for (const [name, sql] of Object.entries(reads)) out[name] = (await q.query(sql)).rows.map(r => r.r);
  return out;
}

// G12 leaves out a sequence value only nextval moves; claim_seq is also moved by setval.
const NEXTVAL_ONLY = ['guild_append_seq'];

/** Invariant 2: last_value and is_called of every sequence of smdb_data but those only nextval moves. */
export async function sequenceValues(q: Queryable): Promise<Record<string, unknown>> {
  const names = (await q.query(
    `SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'smdb_data' AND c.relkind = 'S' ORDER BY c.relname`)).rows.map(r => String(r.relname));
  const out: Record<string, unknown> = {};
  for (const s of names.filter(name => !NEXTVAL_ONLY.includes(name))) {
    out[s] = (await q.query(`SELECT last_value::text AS last_value, is_called FROM smdb_data."${s}"`)).rows[0];
  }
  return out;
}

/** Item 6's "nothing changed": the catalog snapshot, every row of every table, sequence values, the schemas and public's objects. */
export async function storeSnapshot(q: Queryable): Promise<Record<string, unknown>> {
  const tables = (await q.query(
    `SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'smdb_data' AND c.relkind IN ('r', 'p') ORDER BY c.relname`)).rows.map(r => String(r.relname));
  const rows: Record<string, unknown[]> = {};
  for (const t of tables) rows[t] = (await q.query(`SELECT to_jsonb(x)::text AS r FROM ONLY smdb_data."${t}" x ORDER BY 1`)).rows.map(r => r.r);
  return {
    catalog: await catalogSnapshot(q),
    rows,
    sequences: await sequenceValues(q),
    schemas: (await q.query(`SELECT nspname FROM pg_catalog.pg_namespace ORDER BY 1`)).rows.map(r => r.nspname),
    publicObjects: (await q.query(
      `SELECT (to_jsonb(c) - ARRAY[${SERVER_KEPT.map(k => `'${k}'`).join(', ')}])::text AS r FROM pg_catalog.pg_class c
        WHERE c.relnamespace = 'public'::regnamespace ORDER BY c.oid`)).rows.map(r => r.r),
  };
}

export async function shapeSchemas(q: Queryable): Promise<string[]> {
  return (await q.query(`SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname LIKE 'smdb\\_shape\\_%' ORDER BY 1`)).rows.map(r => String(r.nspname));
}

export async function hasSmdbData(q: Queryable): Promise<boolean> {
  return (await q.query(`SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'smdb_data'`)).rows.length > 0;
}

/** A client of its own on one database, for statements that need one session (a transaction, a role's settings). */
export async function clientOn(url: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  client.on('error', () => undefined);
  await client.connect();
  return client;
}
