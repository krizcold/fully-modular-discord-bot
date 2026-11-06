// NB16: the boot's check of smdb_data against a scratch copy of the schema made by the bot's own DDL, the role's
// privileges, and the refusal texts. Runs inside provision()'s transaction; never writes a row of smdb_data.

import { randomBytes } from 'crypto';
import { SCHEMA_VERSION, partitionDdl, provisionDdl, provisionSchemaDdl } from './postgresBackend';

export type ShapeMode = 'provisioned' | 'unversioned';
type Query = { query(text: string, params?: unknown[]): Promise<unknown> };

export type RelKind = 'r' | 'p' | 'i' | 'I' | 'S' | 'v' | 'm' | 'f' | 'c';

export interface CatalogRelation {
  name: string;
  kind: RelKind;
  persistence: string;
  isPartition: boolean;
  rls: boolean;
  forceRls: boolean;
  accessMethod: string | null;
  partitionKey: string | null;
  bound: string | null;
  parent: string | null;
  inherits: string[];
  indexDef: string | null;
  indexValid: boolean | null;
  indexTable: string | null;
  sequence: { increment: string; min: string; max: string; cache: string; cycle: boolean } | null;
}

export interface CatalogColumn {
  rel: string;
  name: string;
  type: string;
  notNull: boolean;
  defaultExpr: string | null;
  identity: string;
  generated: string;
  generatedExpr: string | null;
  collation: string | null;
  storage: string;
  notNullValidated: boolean | null;
}

export interface CatalogConstraint { rel: string; name: string; type: string; def: string; validated: boolean }
export interface CatalogRule { rel: string; what: 'trigger' | 'rule' | 'policy'; name: string; def: string }

export interface Catalog {
  relations: CatalogRelation[];
  columns: CatalogColumn[];
  constraints: CatalogConstraint[];
  rules: CatalogRule[];
}

export interface Privilege { scope: 'database' | 'schema' | 'table' | 'sequence'; target: string; privilege: string }

export interface Difference {
  text: string;
  key: Array<string | number>;
  missingTable?: boolean;
  privilege?: Privilege;
  role?: string;
  db?: string;
}

export interface FoundRelation {
  name: string;
  kind: string;
  isPartition: boolean;
  select: boolean | null;
  insert: boolean | null;
  update: boolean | null;
  delete: boolean | null;
  usage: boolean | null;
  updateSeq: boolean | null;
}

export interface MetaFacts {
  kind: string;
  keyText: boolean;
  valueText: boolean;
  valueNotNull: boolean;
  rls: boolean;
  uniqueKey: boolean;
  select: boolean | null;
}

export interface FoundList {
  role: string;
  db: string;
  dbCreate: boolean;
  schemaExists: boolean;
  schemaUsage: boolean | null;
  schemaCreate: boolean | null;
  relations: FoundRelation[];
  meta: MetaFacts | null;
}

export interface ShapeResult {
  differences: Difference[];
  /** Reference relations the store lacks that the unversioned mode counts instead of listing. */
  counted: number;
  /** Relations of the reference, indexes included. */
  total: number;
}

export interface ShapeCheck extends ShapeResult {
  reference: CatalogRelation[];
}

/** A refusal as the backend logs it (header after the [PostgresBackend] tag, one line per difference) and the boot shows it. */
export interface Refusal {
  header: string;
  lines: string[];
  reason: string;
  fix: string;
}

const KIND_NAMES: Record<string, string> = {
  r: 'table', p: 'partitioned table', i: 'index', I: 'partitioned index', S: 'sequence', v: 'view',
  m: 'materialized view', f: 'foreign table', c: 'composite type',
};
const RELKINDS = `('r','p','i','I','S','v','m','f','c')`;
const STORAGE_NAMES: Record<string, string> = { p: 'PLAIN', e: 'EXTERNAL', m: 'MAIN', x: 'EXTENDED' };
const TABLE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const;
const SEQUENCE_PRIVILEGES = ['USAGE', 'UPDATE'] as const;
const SCHEMA_PRIVILEGES = ['USAGE', 'CREATE'] as const;
const REASON_MAX = 5;
const LOG_MAX = 50;
const KEPT = 'Gates stay closed and nothing in the database was changed; ';
const LOGIN_TAIL = ', or point DATA_BACKEND_URL, in the web UI env editor, at a login that holds these privileges, then restart the bot';

const kindName = (kind: string) => KIND_NAMES[kind] ?? `relation of kind ${kind}`;
const article = (word: string) => (/^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`);

// ============================================================================
// THE FOUND LIST (decision 7 step 2)
// ============================================================================

const FOUND_LIST = `SELECT quote_ident(current_user) AS role, quote_ident(current_database()) AS db,
       has_database_privilege(current_database(), 'CREATE') AS db_create,
       n.oid IS NOT NULL AS schema_exists,
       CASE WHEN n.oid IS NOT NULL THEN has_schema_privilege(n.oid, 'USAGE') END AS schema_usage,
       CASE WHEN n.oid IS NOT NULL THEN has_schema_privilege(n.oid, 'CREATE') END AS schema_create,
       COALESCE((SELECT json_agg(json_build_object(
           'name', c.relname, 'kind', c.relkind::text, 'is_partition', c.relispartition,
           'select', CASE WHEN c.relkind IN ('r','p','v','m','f') THEN has_table_privilege(c.oid, 'SELECT') END,
           'insert', CASE WHEN c.relkind IN ('r','p','v','m','f') THEN has_table_privilege(c.oid, 'INSERT') END,
           'update', CASE WHEN c.relkind IN ('r','p','v','m','f') THEN has_table_privilege(c.oid, 'UPDATE') END,
           'delete', CASE WHEN c.relkind IN ('r','p','v','m','f') THEN has_table_privilege(c.oid, 'DELETE') END,
           'usage', CASE WHEN c.relkind = 'S' THEN has_sequence_privilege(c.oid, 'USAGE') END,
           'update_seq', CASE WHEN c.relkind = 'S' THEN has_sequence_privilege(c.oid, 'UPDATE') END) ORDER BY c.relname)
         FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind IN ${RELKINDS}), '[]'::json) AS relations,
       (SELECT json_build_object(
           'kind', m.relkind::text,
           'key_text', EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = m.oid AND a.attname = 'key' AND a.attnum > 0
                                 AND NOT a.attisdropped AND a.atttypid = 'pg_catalog.text'::pg_catalog.regtype),
           'value_text', EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = m.oid AND a.attname = 'value' AND a.attnum > 0
                                 AND NOT a.attisdropped AND a.atttypid = 'pg_catalog.text'::pg_catalog.regtype),
           'value_not_null', EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = m.oid AND a.attname = 'value' AND a.attnum > 0
                                 AND NOT a.attisdropped AND a.attnotnull),
           'rls', m.relrowsecurity,
           'unique_key', EXISTS (SELECT 1 FROM pg_index x JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = x.indkey[0]
                                 WHERE x.indrelid = m.oid AND x.indisunique AND x.indisvalid AND x.indnatts = 1
                                   AND x.indpred IS NULL AND x.indexprs IS NULL AND a.attname = 'key'),
           'select', CASE WHEN m.relkind IN ('r','p','v','m','f') THEN has_table_privilege(m.oid, 'SELECT') END)
         FROM pg_class m WHERE m.relnamespace = n.oid AND m.relname = 'meta' AND m.relkind IN ${RELKINDS}) AS meta
  FROM (SELECT 1) AS one LEFT JOIN pg_namespace n ON n.nspname = 'smdb_data'`;

type Rows = { rows: Array<Record<string, unknown>> };

const bool = (v: unknown): boolean | null => (v === null || v === undefined ? null : v === true);

/** Decision 7 step 2: what smdb_data holds and the role's privileges, by OID, from the catalogs only. */
export async function readFoundList(client: Query): Promise<FoundList> {
  const res = await client.query(FOUND_LIST) as Rows;
  const row = res.rows[0] ?? {};
  const relations = (Array.isArray(row.relations) ? row.relations : []) as Array<Record<string, unknown>>;
  const meta = row.meta as Record<string, unknown> | null | undefined;
  return {
    role: String(row.role ?? ''),
    db: String(row.db ?? ''),
    dbCreate: row.db_create === true,
    schemaExists: row.schema_exists === true,
    schemaUsage: bool(row.schema_usage),
    schemaCreate: bool(row.schema_create),
    relations: relations.map(r => ({
      name: String(r.name), kind: String(r.kind), isPartition: r.is_partition === true,
      select: bool(r.select), insert: bool(r.insert), update: bool(r.update), delete: bool(r.delete),
      usage: bool(r.usage), updateSeq: bool(r.update_seq),
    })),
    meta: meta ? {
      kind: String(meta.kind), keyText: meta.key_text === true, valueText: meta.value_text === true,
      valueNotNull: meta.value_not_null === true, rls: meta.rls === true, uniqueKey: meta.unique_key === true,
      select: bool(meta.select),
    } : null,
  };
}

/** Decision 7 step 4: the first condition a meta fails, or null when its version can be read. */
export function metaGateCause(meta: MetaFacts): string | null {
  if (meta.kind !== 'r') return `smdb_data.meta is ${article(kindName(meta.kind))}, not a table`;
  if (!meta.keyText) return 'smdb_data.meta has no text column key';
  if (!meta.valueText) return 'smdb_data.meta has no text column value';
  if (!meta.valueNotNull) return 'smdb_data.meta column value allows NULL';
  if (meta.rls) return 'row level security on smdb_data.meta can hide rows';
  if (!meta.uniqueKey) return 'smdb_data.meta has no unique index on key, so it can hold more than one schema_version';
  return null;
}

// ============================================================================
// PRIVILEGES (decisions 2 and 15)
// ============================================================================

const PRIVILEGE_ORDER = ['CREATE', 'USAGE', 'SELECT', 'INSERT', 'UPDATE', 'DELETE'];
function privilegeRank(p: Privilege): number {
  if (p.scope === 'schema') return SCHEMA_PRIVILEGES.indexOf(p.privilege as 'USAGE');
  if (p.scope === 'sequence') return SEQUENCE_PRIVILEGES.indexOf(p.privilege as 'USAGE');
  if (p.scope === 'table') return TABLE_PRIVILEGES.indexOf(p.privilege as 'SELECT');
  return PRIVILEGE_ORDER.indexOf(p.privilege);
}

export function privilegeDifference(role: string, db: string, p: Privilege): Difference {
  const on = p.scope === 'database' ? `database ${p.target}`
    : p.scope === 'schema' ? `schema ${p.target}`
      : p.scope === 'sequence' ? `sequence smdb_data.${p.target}` : `smdb_data.${p.target}`;
  const group = p.scope === 'database' ? 0 : p.scope === 'schema' ? 1 : 2;
  return {
    text: `this bot's database role ${role} lacks ${p.privilege} on ${on}`,
    key: [0, group, p.scope === 'database' || p.scope === 'schema' ? '' : p.target, privilegeRank(p)],
    privilege: p,
    role,
    db,
  };
}

function lackedOn(found: FoundRelation, kind: string): Privilege[] {
  const out: Privilege[] = [];
  if (kind === 'S') {
    if (found.usage === false) out.push({ scope: 'sequence', target: found.name, privilege: 'USAGE' });
    if (found.updateSeq === false) out.push({ scope: 'sequence', target: found.name, privilege: 'UPDATE' });
    return out;
  }
  const held: Record<string, boolean | null> = { SELECT: found.select, INSERT: found.insert, UPDATE: found.update, DELETE: found.delete };
  for (const p of TABLE_PRIVILEGES) if (held[p] === false) out.push({ scope: 'table', target: found.name, privilege: p });
  return out;
}

/** The table and sequence privileges the role lacks on the reference's tables (not partitions) and sequences the store holds. */
export function relationPrivileges(found: FoundList, reference: Array<Pick<CatalogRelation, 'name' | 'kind' | 'isPartition'>>): Difference[] {
  const byName = new Map(found.relations.map(r => [r.name, r]));
  const out: Difference[] = [];
  for (const ref of reference) {
    if (ref.isPartition || !['r', 'p', 'S'].includes(ref.kind)) continue;
    const held = byName.get(ref.name);
    if (!held) continue;
    for (const p of lackedOn(held, ref.kind)) out.push(privilegeDifference(found.role, found.db, p));
  }
  return sortDifferences(out);
}

/** The bot's own tables (not partitions) and sequences with their kinds, read from its DDL: no scratch needed. */
function ddlRelations(): Array<Pick<CatalogRelation, 'name' | 'kind' | 'isPartition'>> {
  const out: Array<Pick<CatalogRelation, 'name' | 'kind' | 'isPartition'>> = [];
  for (const stmt of provisionDdl('smdb_data')) {
    const table = /^CREATE TABLE IF NOT EXISTS smdb_data\.(\w+) \(/.exec(stmt);
    if (table) out.push({ name: table[1], kind: /\) PARTITION BY /.test(stmt) ? 'p' : 'r', isPartition: false });
    const seq = /^CREATE SEQUENCE IF NOT EXISTS smdb_data\.(\w+)/.exec(stmt);
    if (seq) out.push({ name: seq[1], kind: 'S', isPartition: false });
  }
  return out;
}

/** Decision 7 step 3: the privileges the gate refuses on, every lacking one listed; null when the gate passes. */
export function gatePrivileges(found: FoundList): Difference[] | null {
  const metaUnreadable = found.meta?.kind === 'r' && found.meta.select === false;
  const emptyUncreatable = found.schemaExists && found.relations.length === 0 && found.schemaCreate === false;
  const gated = !found.dbCreate || (found.schemaExists && found.schemaUsage === false) || metaUnreadable || emptyUncreatable;
  if (!gated) return null;
  const out: Difference[] = [];
  if (!found.dbCreate) out.push(privilegeDifference(found.role, found.db, { scope: 'database', target: found.db, privilege: 'CREATE' }));
  if (found.schemaExists && found.schemaUsage === false) out.push(privilegeDifference(found.role, found.db, { scope: 'schema', target: 'smdb_data', privilege: 'USAGE' }));
  if (emptyUncreatable) out.push(privilegeDifference(found.role, found.db, { scope: 'schema', target: 'smdb_data', privilege: 'CREATE' }));
  const kinds = new Map(found.relations.map(r => [r.name, r.kind]));
  const own = ddlRelations().filter(r => kinds.get(r.name) === r.kind);
  out.push(...relationPrivileges(found, own));
  return sortDifferences(out);
}

// ============================================================================
// THE CATALOG READER AND THE SCRATCH (decisions 1 and 3)
// ============================================================================

const READ_RELATIONS = `SELECT c.relname AS name, c.relkind::text AS kind, c.relpersistence::text AS persistence,
       c.relispartition AS is_partition, c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls,
       am.amname::text AS access_method,
       CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END AS partition_key,
       CASE WHEN c.relispartition THEN pg_get_expr(c.relpartbound, c.oid) END AS bound,
       CASE WHEN c.relispartition THEN (SELECT i.inhparent::regclass::text FROM pg_inherits i WHERE i.inhrelid = c.oid LIMIT 1) END AS parent,
       ARRAY(SELECT i.inhparent::regclass::text FROM pg_inherits i WHERE i.inhrelid = c.oid AND NOT c.relispartition ORDER BY i.inhseqno) AS inherits,
       CASE WHEN c.relkind IN ('i','I') THEN pg_get_indexdef(c.oid) END AS index_def,
       x.indisvalid AS index_valid, t.relname AS index_table,
       s.seqincrement::text AS seq_increment, s.seqmin::text AS seq_min, s.seqmax::text AS seq_max,
       s.seqcache::text AS seq_cache, s.seqcycle AS seq_cycle
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_am am ON am.oid = c.relam AND c.relkind IN ('r','p','m')
  LEFT JOIN pg_index x ON x.indexrelid = c.oid
  LEFT JOIN pg_class t ON t.oid = x.indrelid
  LEFT JOIN pg_sequence s ON s.seqrelid = c.oid
 WHERE n.nspname = $1 AND c.relkind IN ${RELKINDS}
 ORDER BY c.relname`;

const READ_COLUMNS = `SELECT c.relname AS rel, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
       CASE WHEN a.attgenerated = '' THEN pg_get_expr(d.adbin, d.adrelid) END AS default_expr,
       a.attidentity::text AS identity, a.attgenerated::text AS generated,
       CASE WHEN a.attgenerated <> '' THEN pg_get_expr(d.adbin, d.adrelid) END AS generated_expr,
       CASE WHEN a.attcollation <> 0 THEN a.attcollation::regcollation::text END AS collation,
       a.attstorage::text AS storage,
       (SELECT k.convalidated FROM pg_constraint k WHERE k.conrelid = a.attrelid AND k.contype = 'n' AND k.conkey[1] = a.attnum LIMIT 1) AS not_null_validated
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
 WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f','c') AND a.attnum > 0 AND NOT a.attisdropped
 ORDER BY c.relname, a.attname`;

const READ_CONSTRAINTS = `SELECT c.relname AS rel, k.conname AS name, k.contype::text AS type, pg_get_constraintdef(k.oid) AS def,
       k.convalidated AS validated
  FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = $1 AND k.contype <> 'n'
 ORDER BY c.relname, k.conname`;

const READ_RULES = `SELECT c.relname AS rel, 'trigger' AS what, g.tgname AS name, pg_get_triggerdef(g.oid) AS def
  FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = $1 AND NOT g.tgisinternal
UNION ALL
SELECT c.relname, 'rule', r.rulename, pg_get_ruledef(r.oid)
  FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = $1 AND r.rulename <> '_RETURN'
UNION ALL
SELECT c.relname, 'policy', p.polname,
       concat_ws(' ', CASE WHEN p.polpermissive THEN 'AS PERMISSIVE' ELSE 'AS RESTRICTIVE' END,
         'FOR ' || CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' ELSE 'ALL' END,
         'TO ' || array_to_string(ARRAY(SELECT CASE WHEN o = 0 THEN 'public' ELSE quote_ident(pg_get_userbyid(o)) END FROM unnest(p.polroles) AS o), ', '),
         'USING (' || pg_get_expr(p.polqual, p.polrelid) || ')',
         'WITH CHECK (' || pg_get_expr(p.polwithcheck, p.polrelid) || ')')
  FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = $1
 ORDER BY 1, 2, 3`;

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** The catalog of one schema, as decision 2 compares it. */
export async function readCatalog(client: Query, schema: string): Promise<Catalog> {
  const relations = (await client.query(READ_RELATIONS, [schema]) as Rows).rows;
  const columns = (await client.query(READ_COLUMNS, [schema]) as Rows).rows;
  const constraints = (await client.query(READ_CONSTRAINTS, [schema]) as Rows).rows;
  const rules = (await client.query(READ_RULES, [schema]) as Rows).rows;
  return {
    relations: relations.map(r => ({
      name: String(r.name), kind: String(r.kind) as RelKind, persistence: String(r.persistence ?? 'p'),
      isPartition: r.is_partition === true, rls: r.rls === true, forceRls: r.force_rls === true,
      accessMethod: str(r.access_method), partitionKey: str(r.partition_key), bound: str(r.bound), parent: str(r.parent),
      inherits: Array.isArray(r.inherits) ? r.inherits.map(String) : [],
      indexDef: str(r.index_def), indexValid: bool(r.index_valid), indexTable: str(r.index_table),
      sequence: r.seq_increment === null || r.seq_increment === undefined ? null : {
        increment: String(r.seq_increment), min: String(r.seq_min), max: String(r.seq_max), cache: String(r.seq_cache),
        cycle: r.seq_cycle === true,
      },
    })),
    columns: columns.map(c => ({
      rel: String(c.rel), name: String(c.name), type: String(c.type), notNull: c.not_null === true,
      defaultExpr: str(c.default_expr), identity: String(c.identity ?? ''), generated: String(c.generated ?? ''),
      generatedExpr: str(c.generated_expr), collation: str(c.collation), storage: String(c.storage ?? ''),
      notNullValidated: bool(c.not_null_validated),
    })),
    constraints: constraints.map(k => ({
      rel: String(k.rel), name: String(k.name), type: String(k.type), def: String(k.def), validated: k.validated !== false,
    })),
    rules: rules.map(g => ({ rel: String(g.rel), what: String(g.what) as CatalogRule['what'], name: String(g.name), def: String(g.def) })),
  };
}

/** Decision 3: in the reference's text, the scratch schema's name followed by a dot becomes smdb_data. */
export function substituteScratch(catalog: Catalog, scratch: string): Catalog {
  const from = `${scratch}.`;
  const fix = <T>(v: T): T => {
    if (typeof v === 'string') return v.split(from).join('smdb_data.') as unknown as T;
    if (Array.isArray(v)) return v.map(fix) as unknown as T;
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = fix(x);
      return out as T;
    }
    return v;
  };
  return fix(catalog);
}

const RETRY_CLASSES = new Set(['08', '40', '53', '57', '58']);

/**
 * Whether an error from the bot's schema DDL (the scratch copy or a fresh smdb_data) is the boot's to retry: no server
 * error (a socket error or the client-side timeout), a server error that ended the session, or one of the classes of a
 * passing state of the connection or the server (08, 40, 53, 57, 58). Any other server error repeats at every boot.
 */
export function ddlErrorRetries(error: unknown): boolean {
  const e = error && typeof error === 'object' ? error as { severity?: unknown; code?: unknown } : null;
  if (!e || typeof e.severity !== 'string' || typeof e.code !== 'string' || !/^[0-9A-Z]{5}$/.test(e.code)) return true;
  if (e.severity === 'FATAL' || e.severity === 'PANIC') return true;
  return RETRY_CLASSES.has(e.code.slice(0, 2));
}

/** A server error, outside the retried classes, while the scratch was being built. */
export class ScratchBuildFailed extends Error {
  constructor(readonly code: string, readonly serverMessage: string) {
    super(`the bot could not build its copy of its schema to compare with (SQLSTATE ${code}: ${serverMessage})`);
  }
}

/**
 * Decision 7's boundary: inside the caller's open transaction (after its SET LOCALs), makes the scratch schema from the
 * bot's DDL, reads both catalogs, rolls the scratch back and compares. Sends no BEGIN, COMMIT or ROLLBACK.
 */
export async function checkShape(client: Query, mode: ShapeMode): Promise<ShapeCheck> {
  const scratch = `smdb_shape_${randomBytes(6).toString('hex')}`;
  await client.query('SAVEPOINT shape');
  try {
    for (const stmt of provisionSchemaDdl(scratch)) await client.query(stmt);
    for (const stmt of partitionDdl(scratch, true)) await client.query(stmt);
  } catch (error) {
    if (ddlErrorRetries(error)) throw error;
    const e = error as { code: string; message?: unknown };
    throw new ScratchBuildFailed(e.code, String(e.message ?? ''));
  }
  const reference = substituteScratch(await readCatalog(client, scratch), scratch);
  const found = await readCatalog(client, 'smdb_data');
  await client.query('ROLLBACK TO SAVEPOINT shape');
  await client.query('RELEASE SAVEPOINT shape');
  return { ...compareShapes(found, reference, mode), reference: reference.relations };
}

// ============================================================================
// THE COMPARER (decision 2)
// ============================================================================

const ASPECT = {
  relation: 0, persistence: 1, accessMethod: 2, partitionKey: 3, partition: 4, inherits: 5, rls: 6,
  column: 10, type: 11, notNull: 12, notNullValid: 13, default: 14, nature: 15, collation: 16, storage: 17,
  constraint: 20, indexDef: 30, indexValid: 31, trigger: 40, rule: 41, policy: 42, sequence: 50,
} as const;

const SEQ_PARAMS = [['increment', 'increment'], ['min', 'minimum'], ['max', 'maximum'], ['cache', 'cache'], ['cycle', 'cycle']] as const;

function shapeDiff(rel: string, aspect: number, sub: string, text: string, missingTable = false): Difference {
  return { text, key: [1, rel, aspect, sub], ...(missingTable ? { missingTable } : {}) };
}

function compareKeys(a: Array<string | number>, b: Array<string | number>): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

/** Decision 9's order: privileges (database, schema, relations by name, privilege), then relation, aspect and name. */
export function sortDifferences(differences: Difference[]): Difference[] {
  return differences.slice().sort((a, b) => compareKeys(a.key, b.key));
}

const isIndex = (r: CatalogRelation) => r.kind === 'i' || r.kind === 'I';
const partitionText = (r: CatalogRelation) => (r.isPartition ? `a partition of ${r.parent} ${r.bound}` : 'not a partition');
const partitionedText = (r: CatalogRelation) => (r.partitionKey ? `partitioned by ${r.partitionKey}` : 'not partitioned');
function rlsText(r: CatalogRelation): string {
  if (r.rls && r.forceRls) return 'on and forced';
  if (r.rls) return 'on';
  if (r.forceRls) return 'forced but not enabled';
  return 'off';
}
function natureText(c: CatalogColumn): string {
  if (c.generated) return `a generated column (${c.generatedExpr})`;
  if (c.identity) return 'an identity column';
  return 'a plain column';
}
const defaultText = (c: CatalogColumn) => (c.defaultExpr === null ? 'no default' : `default ${c.defaultExpr}`);
const storageText = (s: string) => STORAGE_NAMES[s] ?? s;
const persistenceText = (p: string) => (p === 'u' ? 'UNLOGGED' : p === 't' ? 'TEMPORARY' : 'logged');

function compareRelation(f: CatalogRelation, r: CatalogRelation, out: Difference[]): void {
  const n = `smdb_data.${f.name}`;
  if (f.kind !== r.kind) out.push(shapeDiff(f.name, ASPECT.relation, '', `${n} is ${article(kindName(f.kind))}, where this bot's schema has ${article(kindName(r.kind))}`));
  // An index is logged or UNLOGGED, and attached as a partition, with its table, which carries the sentence.
  if (f.persistence !== r.persistence && !isIndex(f)) out.push(shapeDiff(f.name, ASPECT.persistence, '', `${n} is ${persistenceText(f.persistence)}, where this bot's schema has it ${persistenceText(r.persistence)}`));
  if (f.accessMethod !== r.accessMethod && f.kind === r.kind) {
    out.push(shapeDiff(f.name, ASPECT.accessMethod, '', `${n} uses access method ${f.accessMethod ?? 'none'}, where this bot's schema uses ${r.accessMethod ?? 'none'}`));
  }
  if (f.partitionKey !== r.partitionKey && f.kind === r.kind) {
    out.push(shapeDiff(f.name, ASPECT.partitionKey, '', `${n} is ${partitionedText(f)}, where this bot's schema has it ${partitionedText(r)}`));
  }
  if (!isIndex(f) && !isIndex(r) && (f.isPartition !== r.isPartition || f.parent !== r.parent || f.bound !== r.bound)) {
    const refText = r.isPartition ? partitionText(r) : 'a table that is not a partition';
    out.push(shapeDiff(f.name, ASPECT.partition, '', `${n} is ${partitionText(f)}, where this bot's schema has ${refText}`));
  }
  if (f.inherits.join(', ') !== r.inherits.join(', ')) {
    out.push(shapeDiff(f.name, ASPECT.inherits, '', `${n} inherits from ${f.inherits.join(', ') || 'no table'}, where this bot's schema has ${r.inherits.join(', ') || 'no parent'}`));
  }
  if (f.rls !== r.rls || f.forceRls !== r.forceRls) {
    out.push(shapeDiff(f.name, ASPECT.rls, '', `${n} has row level security ${rlsText(f)}, where this bot's schema has it ${rlsText(r)}`));
  }
  if (f.indexDef !== r.indexDef && (f.indexDef !== null || r.indexDef !== null)) {
    out.push(shapeDiff(f.name, ASPECT.indexDef, '', `${n} is ${f.indexDef ?? article(kindName(f.kind))}, where this bot's schema has ${r.indexDef ?? article(kindName(r.kind))}`));
  }
  if (f.indexValid === false && r.indexValid === true) {
    out.push(shapeDiff(f.name, ASPECT.indexValid, '', `${n} is not valid, so Postgres does not use it to enforce or search`));
  }
  if (f.sequence && r.sequence) {
    for (const [field, label] of SEQ_PARAMS) {
      const x = f.sequence[field];
      const y = r.sequence[field];
      if (x === y) continue;
      const show = (v: string | boolean) => (typeof v === 'boolean' ? (v ? 'on' : 'off') : v);
      out.push(shapeDiff(f.name, ASPECT.sequence, String(SEQ_PARAMS.findIndex(p => p[0] === field)), `sequence ${n} has ${label} ${show(x)}, where this bot's schema has ${show(y)}`));
    }
  }
}

function compareColumns(table: string, found: CatalogColumn[], reference: CatalogColumn[], out: Difference[]): void {
  const n = `smdb_data.${table}`;
  const refByName = new Map(reference.map(c => [c.name, c]));
  const foundByName = new Map(found.map(c => [c.name, c]));
  for (const r of reference) {
    if (!foundByName.has(r.name)) out.push(shapeDiff(table, ASPECT.column, r.name, `${n} has no column ${r.name} (${r.type}${r.notNull ? ' NOT NULL' : ''})`));
  }
  for (const f of found) {
    const r = refByName.get(f.name);
    const col = `${n} column ${f.name}`;
    if (!r) {
      out.push(shapeDiff(table, ASPECT.column, f.name, `${n} has column ${f.name} (${f.type}), which this bot's schema does not have`));
      continue;
    }
    if (f.type !== r.type) out.push(shapeDiff(table, ASPECT.type, f.name, `${col} is ${f.type}, where this bot's schema has ${r.type}`));
    if (f.notNull !== r.notNull) {
      out.push(shapeDiff(table, ASPECT.notNull, f.name, f.notNull
        ? `${col} is NOT NULL, where this bot's schema allows NULL`
        : `${col} allows NULL, where this bot's schema has NOT NULL`));
    }
    if (f.notNullValidated === false && r.notNullValidated === true) {
      out.push(shapeDiff(table, ASPECT.notNullValid, f.name, `${col} has NOT NULL NOT VALID, where this bot's schema has it validated`));
    }
    if (f.defaultExpr !== r.defaultExpr) out.push(shapeDiff(table, ASPECT.default, f.name, `${col} has ${defaultText(f)}, where this bot's schema has ${defaultText(r)}`));
    if (f.identity !== r.identity || f.generated !== r.generated || f.generatedExpr !== r.generatedExpr) {
      let x = natureText(f);
      let y = natureText(r);
      if (x === y) {
        x = `${x} (${f.identity === 'a' ? 'GENERATED ALWAYS' : 'GENERATED BY DEFAULT'})`;
        y = `${y} (${r.identity === 'a' ? 'GENERATED ALWAYS' : 'GENERATED BY DEFAULT'})`;
      }
      out.push(shapeDiff(table, ASPECT.nature, f.name, `${col} is ${x}, where this bot's schema has ${y}`));
    }
    if (f.collation !== r.collation && f.type === r.type) out.push(shapeDiff(table, ASPECT.collation, f.name, `${col} uses collation ${f.collation ?? 'none'}, where this bot's schema uses ${r.collation ?? 'none'}`));
    if (f.storage !== r.storage) out.push(shapeDiff(table, ASPECT.storage, f.name, `${col} has storage ${storageText(f.storage)}, where this bot's schema has ${storageText(r.storage)}`));
  }
}

function compareConstraints(table: string, found: CatalogConstraint[], reference: CatalogConstraint[], out: Difference[]): void {
  const n = `smdb_data.${table}`;
  const refByName = new Map(reference.map(c => [c.name, c]));
  const foundByName = new Map(found.map(c => [c.name, c]));
  const withValid = (c: CatalogConstraint) => (c.validated || / NOT VALID$/.test(c.def) ? c.def : `${c.def} NOT VALID`);
  for (const r of reference) {
    if (!foundByName.has(r.name)) out.push(shapeDiff(table, ASPECT.constraint, r.name, `${n} lacks constraint ${r.name} (${r.def})`));
  }
  for (const f of found) {
    const r = refByName.get(f.name);
    if (!r) out.push(shapeDiff(table, ASPECT.constraint, f.name, `${n} has constraint ${f.name} (${withValid(f)}), which this bot's schema does not have`));
    else if (f.def !== r.def || f.type !== r.type || f.validated !== r.validated) {
      out.push(shapeDiff(table, ASPECT.constraint, f.name, `${n} constraint ${f.name} is ${withValid(f)}, where this bot's schema has ${r.def}`));
    }
  }
}

function compareRules(table: string, found: CatalogRule[], reference: CatalogRule[], out: Difference[]): void {
  const n = `smdb_data.${table}`;
  const key = (g: CatalogRule) => `${g.what} ${g.name}`;
  const refByKey = new Map(reference.map(g => [key(g), g]));
  const foundByKey = new Map(found.map(g => [key(g), g]));
  const aspect = (g: CatalogRule) => ASPECT[g.what];
  for (const r of reference) {
    if (!foundByKey.has(key(r))) out.push(shapeDiff(table, aspect(r), r.name, `${n} lacks ${r.what} ${r.name} (${r.def})`));
  }
  for (const f of found) {
    const r = refByKey.get(key(f));
    if (!r) out.push(shapeDiff(table, aspect(f), f.name, `${n} has ${f.what} ${f.name} (${f.def}), which this bot's schema does not have`));
    else if (f.def !== r.def) out.push(shapeDiff(table, aspect(f), f.name, `${n} ${f.what} ${f.name} is ${f.def}, where this bot's schema has ${r.def}`));
  }
}

function groupBy<T extends { rel: string }>(items: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const list = out.get(item.rel);
    if (list) list.push(item);
    else out.set(item.rel, [item]);
  }
  return out;
}

/** Compares the store's catalog with the reference's (already named smdb_data) in decision 4's or decision 5's mode. */
export function compareShapes(found: Catalog, reference: Catalog, mode: ShapeMode): ShapeResult {
  const out: Difference[] = [];
  const foundRels = new Map(found.relations.map(r => [r.name, r]));
  const refRels = new Map(reference.relations.map(r => [r.name, r]));
  let counted = 0;
  for (const r of reference.relations) {
    if (foundRels.has(r.name)) continue;
    const parentName = r.parent?.startsWith('smdb_data.') ? r.parent.slice('smdb_data.'.length) : null;
    // An index belongs by its table alone: a partition index of a held index sits on a partition the store lacks.
    const belongs = r.indexTable !== null
      ? foundRels.has(r.indexTable)
      : r.isPartition && parentName !== null && foundRels.has(parentName);
    if (mode === 'unversioned' && !belongs) {
      counted += 1;
      continue;
    }
    out.push(shapeDiff(r.name, ASPECT.relation, '', `smdb_data.${r.name} (${kindName(r.kind)}) is missing`, r.kind === 'r' || r.kind === 'p'));
  }
  const fCols = groupBy(found.columns);
  const rCols = groupBy(reference.columns);
  const fCons = groupBy(found.constraints);
  const rCons = groupBy(reference.constraints);
  const fRules = groupBy(found.rules);
  const rRules = groupBy(reference.rules);
  for (const f of found.relations) {
    const r = refRels.get(f.name);
    if (!r) {
      out.push(shapeDiff(f.name, ASPECT.relation, '', `smdb_data.${f.name} (${kindName(f.kind)}) is not part of this bot's schema`));
      continue;
    }
    compareRelation(f, r, out);
    compareColumns(f.name, fCols.get(f.name) ?? [], rCols.get(f.name) ?? [], out);
    compareConstraints(f.name, fCons.get(f.name) ?? [], rCons.get(f.name) ?? [], out);
    compareRules(f.name, fRules.get(f.name) ?? [], rRules.get(f.name) ?? [], out);
  }
  return { differences: sortDifferences(out), counted, total: reference.relations.length };
}

// ============================================================================
// THE TEXTS (section 3)
// ============================================================================

function listed(lines: string[]): string {
  const shown = lines.slice(0, REASON_MAX).join('; ');
  return lines.length > REASON_MAX ? `${shown}; and ${lines.length - REASON_MAX} more (the bot's log lists them)` : shown;
}

function joinOr(clauses: string[]): string {
  if (clauses.length <= 1) return clauses.join('');
  return `${clauses.slice(0, -1).join(', ')} or ${clauses[clauses.length - 1]}`;
}

/** The GRANT groups for the privileges listed and nothing else: database, schema, then tables and sequences. */
function grantGroups(privileges: Difference[], relationsOnly = false): string[] {
  const ps = privileges.map(d => d.privilege).filter((p): p is Privilege => !!p);
  const role = privileges[0]?.role ?? '';
  const db = privileges[0]?.db ?? '';
  const groups: string[] = [];
  if (!relationsOnly && ps.some(p => p.scope === 'database')) {
    groups.push(`as the owner of database ${db} or a superuser, run GRANT CREATE ON DATABASE ${db} TO ${role}`);
  }
  const schema = SCHEMA_PRIVILEGES.filter(s => ps.some(p => p.scope === 'schema' && p.privilege === s));
  if (!relationsOnly && schema.length) groups.push(`as the owner of smdb_data or a superuser, run GRANT ${schema.join(', ')} ON SCHEMA smdb_data TO ${role}`);
  const statements: string[] = [];
  for (const scope of ['table', 'sequence'] as const) {
    const targets = [...new Set(ps.filter(p => p.scope === scope).map(p => p.target))].sort();
    for (const target of targets) {
      const order = scope === 'table' ? TABLE_PRIVILEGES : SEQUENCE_PRIVILEGES;
      const held = (order as readonly string[]).filter(o => ps.some(p => p.scope === scope && p.target === target && p.privilege === o));
      statements.push(`GRANT ${held.join(', ')} ON ${scope === 'sequence' ? 'SEQUENCE ' : ''}smdb_data.${target} TO ${role}`);
    }
  }
  if (statements.length) groups.push(`as the owner of smdb_data's tables and sequences or a superuser, run ${statements.join('; ')}`);
  return groups;
}

const isPrivilege = (d: Difference) => !!d.privilege;

/** Decision 4's mode: a shape difference (with any privilege lines first), or privileges alone on a store of the right shape. */
export function shapeRefusal(differences: Difference[]): Refusal {
  const sorted = sortDifferences(differences);
  const lines = sorted.map(d => d.text);
  const privileges = sorted.filter(isPrivilege);
  if (privileges.length === sorted.length && privileges.length > 0) {
    const role = privileges[0].role ?? '';
    return {
      header: `schema-mismatch: this bot's database role ${role} lacks ${privileges.length} privilege(s) on smdb_data; smdb_data matches this bot's schema (version ${SCHEMA_VERSION}); refusing to serve`,
      lines,
      reason: `this bot's database role ${role} lacks privileges on smdb_data, which matches this bot's schema (version ${SCHEMA_VERSION}): ${listed(lines)}`,
      fix: `${KEPT}${grantGroups(privileges).join('; ')}${LOGIN_TAIL}`,
    };
  }
  let fix = `${KEPT}point DATA_BACKEND_URL at a database whose smdb_data matches this bot's schema in the web UI env editor, or correct the differences above in the database and restart the bot`;
  if (privileges.length) fix += `; and, ${grantGroups(privileges, true).join('; ')}`;
  if (sorted.some(d => d.missingTable)) {
    fix += "; a table or partition reported missing may have held data that is not in this database: restore a backup (the manager's Database window) rather than creating it empty";
  }
  return {
    header: `schema-mismatch: smdb_data differs from this bot's schema (version ${SCHEMA_VERSION}) in ${sorted.length} place(s); refusing to serve`,
    lines,
    reason: `the database's smdb_data differs from this bot's schema (version ${SCHEMA_VERSION}): ${listed(lines)}`,
    fix,
  };
}

/** Decision 5: a smdb_data that holds relations with no schema_version (cause absent) or one that can't be read (cause given). */
export function unversionedRefusal(found: FoundList, result: ShapeResult, cause?: string): Refusal {
  const lines = sortDifferences(result.differences).map(d => d.text);
  const n = found.relations.length;
  const names = found.relations.filter(r => r.kind !== 'i' && r.kind !== 'I').map(r => r.name).sort();
  const shown = names.slice(0, REASON_MAX).map(name => `smdb_data.${name} (${kindName(found.relations.find(r => r.name === name)!.kind)})`).join(', ');
  const more = names.length > REASON_MAX ? ` and ${names.length - REASON_MAX} more` : '';
  const tail = lines.length
    ? `; compared with this bot's schema: ${listed(lines)}`
    : `; they match their counterparts in this bot's schema${result.counted ? ` (${result.counted} of its ${result.total} objects are not there)` : ''}, but the bot does not take over a schema without a version`;
  const confirm = "so this bot can't confirm what made them or that they are complete";
  if (cause === undefined) {
    return {
      header: `schema-mismatch: smdb_data holds ${n} object(s) but no schema_version, ${confirm} (a provisioning or restore that did not finish, or another program); refusing to serve`,
      lines,
      reason: `the database's smdb_data holds objects but no schema_version, ${confirm}: ${shown}${more}${tail}`,
      fix: `${KEPT}point DATA_BACKEND_URL at a database without the schema smdb_data, or at one this bot provisioned, in the web UI env editor, or rename smdb_data aside in the database (ALTER SCHEMA smdb_data RENAME TO ...) and restart the bot`,
    };
  }
  return {
    header: `schema-mismatch: smdb_data holds ${n} object(s) and its schema_version can't be read (${cause}), ${confirm}; refusing to serve`,
    lines,
    reason: `the database's smdb_data holds objects and its schema_version can't be read (${cause}), ${confirm}: ${shown}${more}${tail}`,
    fix: `${KEPT}smdb_data.meta is this bot's version table: correct it to the shape the difference lines give (key text, value text NOT NULL, its primary key meta_pkey, row level security off) and restart the bot; do not rename smdb_data aside while its tables hold this bot's data, since the next boot would then make and serve a new, empty store and leave every row in the renamed schema`,
  };
}

/** Decision 7 step 3: the gate's refusal; null when the gate passes. */
export function gateRefusal(found: FoundList): Refusal | null {
  const privileges = gatePrivileges(found);
  if (!privileges) return null;
  const ps = privileges.map(d => d.privilege!);
  const onDatabase = ps.some(p => p.scope === 'database');
  const onSchema = ps.some(p => p.scope !== 'database');
  const scope = onDatabase && onSchema ? `database ${found.db} and smdb_data` : onDatabase ? `database ${found.db}` : 'smdb_data';
  const notCompared = found.schemaExists ? 'the schema itself was not compared' : 'no smdb_data exists and none was made';
  const reasons: string[] = [];
  if (onDatabase) reasons.push(`make a schema in database ${found.db} (smdb_data, or the copy of its schema it compares with at every boot)`);
  if (ps.some(p => (p.scope === 'schema' && p.privilege === 'USAGE') || (p.scope === 'table' && p.target === 'meta' && p.privilege === 'SELECT'))) {
    reasons.push('read its schema_version');
  }
  if (ps.some(p => p.scope === 'schema' && p.privilege === 'CREATE')) reasons.push('make its tables in smdb_data');
  const lines = privileges.map(d => d.text);
  return {
    header: `schema-mismatch: this bot's database role ${found.role} lacks ${privileges.length} privilege(s) it needs on ${scope}; ${notCompared}, since without them the bot can't ${joinOr(reasons)}; refusing to serve`,
    lines,
    reason: `this bot's database role ${found.role} lacks privileges it needs on ${scope}, so ${notCompared}: ${listed(lines)}`,
    fix: `${KEPT}${grantGroups(privileges).join('; ')}${LOGIN_TAIL}`,
  };
}

/** Decision 7 step 8: the schema this boot made differed from the scratch before its COMMIT. */
export function freshRefusal(differences: Difference[]): Refusal {
  const lines = sortDifferences(differences).map(d => d.text);
  return {
    header: "schema-mismatch: the schema this bot made in the database differed from this bot's schema before it was committed, so it was rolled back (an event trigger or another program changes tables as they are made); refusing to serve",
    lines,
    reason: `the schema this bot made in the database differed from this bot's schema and was rolled back (an event trigger or another program changes new tables): ${listed(lines)}`,
    fix: `${KEPT}remove what changes new tables in that database (its event triggers are listed by SELECT evtname FROM pg_event_trigger) and restart the bot`,
  };
}

/** Decision 7 step 8: the role lacked privileges on the schema this boot made. */
export function freshPrivilegeRefusal(role: string, privileges: Difference[]): Refusal {
  const lines = sortDifferences(privileges).map(d => d.text);
  return {
    header: `schema-mismatch: this bot's database role ${role} lacked ${lines.length} privilege(s) on the schema it made in the database, so it was rolled back before it was committed (default privileges set with ALTER DEFAULT PRIVILEGES, or an event trigger, take them from new tables); refusing to serve`,
    lines,
    reason: `this bot's database role ${role} lacked privileges on the schema it made in the database, so it was rolled back (default privileges or an event trigger take them from new tables): ${listed(lines)}`,
    fix: `${KEPT}as ${role} or a superuser, run ALTER DEFAULT PRIVILEGES FOR ROLE ${role} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}; ALTER DEFAULT PRIVILEGES FOR ROLE ${role} GRANT USAGE, UPDATE ON SEQUENCES TO ${role} (SELECT * FROM pg_default_acl lists what is set), remove any event trigger that revokes privileges on new tables, and restart the bot`,
  };
}

/** Decision 16: a database whose server_encoding is not UTF8. */
export function encodingRefusal(encoding: string): Refusal {
  const reason = `the database's server_encoding is ${encoding}, and this bot needs a UTF8 database; smdb_data was not read`;
  return {
    header: `schema-mismatch: ${reason}; refusing to serve`,
    lines: [],
    reason,
    fix: `${KEPT}point DATA_BACKEND_URL, in the web UI env editor, at a database whose encoding is UTF8 (CREATE DATABASE <name> TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' makes one on any server), then restart the bot`,
  };
}

/** The release a server_version_num names: 120017 is 12.17, 90624 is 9.6.24. */
export function serverRelease(versionNum: number): string {
  const major = Math.floor(versionNum / 10000);
  if (versionNum >= 100000) return `${major}.${versionNum % 10000}`;
  return `${major}.${Math.floor(versionNum / 100) % 100}.${versionNum % 100}`;
}

/** A server older than PostgreSQL 13, whose catalogs the check can't read. */
export function serverVersionRefusal(release: string): Refusal {
  const reason = `the database server is PostgreSQL ${release}, and this bot needs PostgreSQL 13 or later; smdb_data was not read`;
  return {
    header: `schema-mismatch: ${reason}; refusing to serve`,
    lines: [],
    reason,
    fix: `${KEPT}upgrade the server to PostgreSQL 13 or later, or point DATA_BACKEND_URL, in the web UI env editor, at a database on such a server, then restart the bot`,
  };
}

/** Decision 7 step 8: the version row this boot wrote into the schema it made could not be read back before the COMMIT. */
export function freshVersionRefusal(cause: string): Refusal {
  return {
    header: `schema-mismatch: the schema_version row this bot wrote into the schema it made in the database could not be read back (${cause}), so the schema was rolled back before it was committed (an event trigger, a rule or another program changes new tables); refusing to serve`,
    lines: [],
    reason: `the schema_version row this bot wrote into the schema it made in the database could not be read back (${cause}), so the schema was rolled back (an event trigger, a rule or another program changes new tables)`,
    fix: `${KEPT}remove what changes new tables in that database (its event triggers are listed by SELECT evtname FROM pg_event_trigger) and restart the bot`,
  };
}

/**
 * A store of the right shape and version whose meta has no store_id row, while this machine's marker records the store
 * id of the deployment's store: the identity check could not tell it apart from another database.
 */
export function storeIdRefusal(markerStoreId: string): Refusal {
  const reason = `the database's smdb_data matches this bot's schema (version ${SCHEMA_VERSION}) but smdb_data.meta holds no store_id row, and this machine's /data/.backend.json records store ${markerStoreId}, so this bot can't confirm that this database holds that store`;
  const literal = JSON.stringify(markerStoreId).replace(/'/g, "''");
  return {
    header: `schema-mismatch: ${reason}; refusing to serve`,
    lines: [],
    reason,
    fix: `${KEPT}if this is the database this deployment was set up with, add its store id (INSERT INTO smdb_data.meta (key, value) VALUES ('store_id', '${literal}')) and restart the bot; otherwise point DATA_BACKEND_URL, in the web UI env editor, at this deployment's database and restart the bot; do not rename smdb_data aside while its tables hold this bot's data, since the next boot would then make and serve a new, empty store`,
  };
}

/** The fix for a server error from the bot's schema DDL; the server's message names the cause, so the fix does not guess it. */
function ddlFix(code: string, role: string, db: string): string {
  if (code === '42501') {
    return `${KEPT}the server refused this bot's database role ${role} a privilege (the message above names it): grant that privilege to ${role}, or correct the event trigger that raises the error (listed by SELECT evtname FROM pg_event_trigger)${LOGIN_TAIL}`;
  }
  return `${KEPT}correct the cause the server's message names in database ${db} (an event trigger that rejects new tables is listed by SELECT evtname FROM pg_event_trigger) and restart the bot`;
}

/** The scratch could not be built for a cause that repeats at every boot (ScratchBuildFailed). */
export function scratchRefusal(code: string, message: string, role: string, db: string): Refusal {
  const reason = `the bot could not build its copy of its schema to compare with (SQLSTATE ${code}: ${message}), so smdb_data was not compared; smdb_data was not changed`;
  const fix = ddlFix(code, role, db);
  return { header: `schema-mismatch: ${reason}; refusing to serve`, lines: [], reason, fix };
}

/** The schema of an empty smdb_data could not be made for a cause that repeats at every boot. */
export function schemaDdlRefusal(code: string, message: string, role: string, db: string): Refusal {
  const reason = `the bot could not make its schema in the database (SQLSTATE ${code}: ${message}); nothing was committed`;
  const fix = ddlFix(code, role, db);
  return { header: `schema-mismatch: ${reason}; refusing to serve`, lines: [], reason, fix };
}

/** The backend's log lines for a refusal: the header, at most 50 differences, and the count of the rest. */
export function refusalLogLines(refusal: Refusal): string[] {
  const out = [`[PostgresBackend] ${refusal.header}`];
  for (const line of refusal.lines.slice(0, LOG_MAX)) out.push(`[PostgresBackend] schema difference: ${line}`);
  if (refusal.lines.length > LOG_MAX) out.push(`[PostgresBackend] schema difference: and ${refusal.lines.length - LOG_MAX} more not listed`);
  return out;
}
