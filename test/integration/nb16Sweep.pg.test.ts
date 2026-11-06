import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkShape } from '../../src/bot/internalSetup/utils/dataBackends/storeShape';
import { catalogSnapshot, clientOn, makeTemplate, newDatabase, sequenceValues, startNb16Rig, stopNb16Rig, urlOf, type Nb16Rig } from '../helpers/nb16Rig';

// NB16 sheet section 8 item 5: every column of every table of the bot's schema, read from the catalog at test time
// (so a table a later DDL adds is swept with no edit). Each change runs in a transaction that is rolled back, is
// checked through checkShape (never provision(), whose own BEGIN and ROLLBACK would end the sweep's transaction), and
// is followed by the catalog snapshot, which must equal the one taken before the sweep. Every change runs even when an
// earlier one failed, so one run reports every failure and every extra still to record.

let rig: Nb16Rig;
let client: Client;
const DB = 'nb16_sweep';

beforeAll(async () => {
  rig = await startNb16Rig();
  await makeTemplate(rig);
  await newDatabase(rig, DB, 'store');
  client = await clientOn(urlOf(rig, DB));
}, 300_000);
afterAll(async () => {
  await client?.end();
  await stopNb16Rig(rig);
});

type Change = 'drop' | 'retype' | 'notnull' | 'default' | 'extra';

interface RefColumn { rel: string; name: string; type: string; notNull: boolean; def: string | null }
interface RefShape {
  tables: string[];
  partitions: Map<string, string[]>;
  columns: RefColumn[];
  pk: Map<string, { name: string; def: string; index: string; indexKind: string }>;
  constraints: Array<{ rel: string; name: string; def: string }>;
  indexes: Array<{ name: string; kind: string; table: string }>;
}

// Row 14's retypes, keyed by the column's type; doc takes jsonb.
const RETYPE: Record<string, { sql: string; shown: string }> = {
  text: { sql: 'varchar(255)', shown: 'character varying(255)' },
  integer: { sql: 'bigint', shown: 'bigint' },
  bigint: { sql: 'numeric', shown: 'numeric' },
  boolean: { sql: 'text', shown: 'text' },
  'timestamp with time zone': { sql: 'timestamp', shown: 'timestamp without time zone' },
  uuid: { sql: 'text', shown: 'text' },
};
const DOC_RETYPE = { sql: 'jsonb', shown: 'jsonb' };
const DEFAULT_FOR: Record<string, string> = { text: `'x'`, integer: '7', bigint: '7', boolean: 'true', 'timestamp with time zone': 'now()', uuid: 'gen_random_uuid()' };

// Changes Postgres refuses, with the SQLSTATE it answers.
const SKIP: Record<string, string> = {
  'guild_data.guild_id drop': '42P16',
  'guild_data.guild_id retype': '42P16',
  'guild_append.guild_id drop': '42P16',
  'guild_append.guild_id retype': '42P16',
};

// Decision 9 orders by relation name, then decision 2's aspects, then column or constraint name.
const ASPECT = { relation: 0, column: 10, type: 11, notNull: 12, default: 14, storage: 17, constraint: 20, indexDef: 30 } as const;
interface Expected { rel: string; aspect: number; sub: string; text: string }

function inOrder(list: Expected[]): string[] {
  const cmp = (x: string, y: string) => (x === y ? 0 : x < y ? -1 : 1);
  return list.slice().sort((a, b) => cmp(a.rel, b.rel) || a.aspect - b.aspect || cmp(a.sub, b.sub)).map(e => e.text);
}

/**
 * The extras each change brings beside its own sentences, frozen: the primary key of the table and of each partition
 * (pk), other constraints and indexes by name, the storage a retype gives the column on the table and each partition
 * (found, then the reference's), and sentences written out where the server prints them. Dropped columns were recorded
 * from the DDL; the storage of claim_clock.up_ms from the gatekeeper's run of 2026-11-05 on postgres:16-alpine, and the
 * other retypes by the same rule (ALTER COLUMN TYPE gives the column the new type's storage: numeric MAIN, text
 * EXTENDED, bigint and boolean PLAIN; uuid columns retyped to text by the same rule). The guild_requests and last_flush
 * entries were written from schema 5's DDL by those rules and are confirmed by the next run. A (table, column, change)
 * that brings extras and is not here is listed at the end as "record the extras".
 */
interface Extras { pk?: boolean; constraints?: string[]; indexes?: string[]; storage?: [string, string]; sentences?: Expected[] }
const TO_NUMERIC: Extras = { storage: ['MAIN', 'PLAIN'] };
const TO_TEXT: Extras = { storage: ['EXTENDED', 'PLAIN'] };
const EXTRAS: Record<string, Extras> = {
  'meta.key drop': { pk: true },
  'guild_ownership.guild_id drop': { pk: true },
  'guild_ownership.node_id drop': { indexes: ['guild_ownership_node_idx'] },
  'guild_ownership.claim drop': { indexes: ['guild_ownership_claim_idx'] },
  'shard_claims.shard_count drop': { pk: true },
  'shard_claims.shard_id drop': { pk: true },
  'claim_clock.id drop': { pk: true, constraints: ['claim_clock_id_check'] },
  'shard_nodes.node_id drop': { pk: true },
  'guild_data.module drop': { pk: true },
  'guild_data.filename drop': { pk: true },
  'guild_append.module drop': { pk: true },
  'guild_append.filename drop': { pk: true },
  'guild_append.seq drop': { pk: true },
  'guild_data_graveyard.guild_id drop': { pk: true },
  'guild_data_graveyard.module drop': { pk: true },
  'guild_data_graveyard.filename drop': { pk: true },
  'guild_data_graveyard.retired_at drop': { pk: true, indexes: ['guild_graveyard_ttl_idx'] },
  'guild_data_graveyard.kind drop': { constraints: ['guild_data_graveyard_kind_check'] },
  'claim_clock.up_ms retype': TO_NUMERIC,
  'claim_clock.last_gap_ms retype': TO_NUMERIC,
  'guild_append.seq retype': TO_NUMERIC,
  'guild_data_graveyard.retired_at retype': TO_NUMERIC,
  'guild_ownership.claim retype': TO_NUMERIC,
  'shard_claims.claim retype': TO_NUMERIC,
  'shard_claims.ttl_ms retype': TO_NUMERIC,
  'shard_claims.expires_up_ms retype': TO_NUMERIC,
  'shard_claims.released retype': TO_TEXT,
  'shard_claims.reserved retype': TO_TEXT,
  'shard_claims.extended retype': TO_TEXT,
  'shard_nodes.fit retype': TO_TEXT,
  'shard_nodes.restartable retype': TO_TEXT,
  'shard_nodes.returns retype': TO_TEXT,
  'guild_requests.id drop': { pk: true },
  'guild_requests.for_process drop': { indexes: ['guild_requests_pending_idx'] },
  'guild_requests.created_at drop': { indexes: ['guild_requests_pending_idx'] },
  'guild_requests.op drop': { constraints: ['guild_requests_op_check'] },
  'guild_requests.state drop': { constraints: ['guild_requests_state_check'], indexes: ['guild_requests_applying_idx', 'guild_requests_pending_idx'] },
  'guild_requests.claim_batch drop': { indexes: ['guild_requests_applying_idx'] },
  'guild_requests.id retype': TO_TEXT,
  'guild_requests.claim_batch retype': TO_TEXT,
  'guild_requests.applier_claim retype': TO_NUMERIC,
  'guild_ownership.last_flush retype': TO_TEXT,
  // The CHECK and the partial indexes' predicates are parsed again against a varchar column, cast to text.
  'guild_requests.op retype': {
    sentences: [{
      rel: 'guild_requests', aspect: ASPECT.constraint, sub: 'guild_requests_op_check',
      text: "smdb_data.guild_requests constraint guild_requests_op_check is CHECK (((op)::text = ANY (ARRAY['write'::text, 'delete'::text, 'delete-namespace'::text, 'restore-graveyard'::text]))), where this bot's schema has CHECK ((op = ANY (ARRAY['write'::text, 'delete'::text, 'delete-namespace'::text, 'restore-graveyard'::text])))",
    }],
  },
  'guild_requests.state retype': {
    sentences: [
      {
        rel: 'guild_requests', aspect: ASPECT.constraint, sub: 'guild_requests_state_check',
        text: "smdb_data.guild_requests constraint guild_requests_state_check is CHECK (((state)::text = ANY (ARRAY['pending'::text, 'applying'::text, 'done'::text, 'expired'::text]))), where this bot's schema has CHECK ((state = ANY (ARRAY['pending'::text, 'applying'::text, 'done'::text, 'expired'::text])))",
      },
      {
        rel: 'guild_requests_applying_idx', aspect: ASPECT.indexDef, sub: '',
        text: "smdb_data.guild_requests_applying_idx is CREATE INDEX guild_requests_applying_idx ON smdb_data.guild_requests USING btree (claim_batch) WHERE ((state)::text = 'applying'::text), where this bot's schema has CREATE INDEX guild_requests_applying_idx ON smdb_data.guild_requests USING btree (claim_batch) WHERE (state = 'applying'::text)",
      },
      {
        rel: 'guild_requests_pending_idx', aspect: ASPECT.indexDef, sub: '',
        text: "smdb_data.guild_requests_pending_idx is CREATE INDEX guild_requests_pending_idx ON smdb_data.guild_requests USING btree (for_process, created_at) WHERE ((state)::text = 'pending'::text), where this bot's schema has CREATE INDEX guild_requests_pending_idx ON smdb_data.guild_requests USING btree (for_process, created_at) WHERE (state = 'pending'::text)",
      },
    ],
  },
  // The CHECK is parsed again against a varchar kind, which the = operator casts to text.
  'guild_data_graveyard.kind retype': {
    sentences: [{
      rel: 'guild_data_graveyard', aspect: ASPECT.constraint, sub: 'guild_data_graveyard_kind_check',
      text: "smdb_data.guild_data_graveyard constraint guild_data_graveyard_kind_check is CHECK (((kind)::text = ANY (ARRAY['doc'::text, 'append'::text]))), where this bot's schema has CHECK ((kind = ANY (ARRAY['doc'::text, 'append'::text])))",
    }],
  },
};

async function readReference(c: Client): Promise<RefShape> {
  await c.query('BEGIN');
  try {
    await c.query('SET LOCAL search_path = pg_catalog');
    await c.query('SET LOCAL quote_all_identifiers = off');
    const rels = (await c.query(
      `SELECT c.relname, c.relkind::text AS kind, c.relispartition, p.relname AS parent
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_inherits i ON i.inhrelid = c.oid LEFT JOIN pg_class p ON p.oid = i.inhparent
        WHERE n.nspname = 'smdb_data' AND c.relkind IN ('r', 'p') ORDER BY c.relname`)).rows;
    const tables = rels.filter(r => !r.relispartition).map(r => String(r.relname));
    const partitions = new Map<string, string[]>(tables.map(t => [t, rels.filter(r => r.relispartition && r.parent === t).map(r => String(r.relname))]));
    const columns = (await c.query(
      `SELECT c.relname AS rel, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
              pg_get_expr(d.adbin, d.adrelid) AS def
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE n.nspname = 'smdb_data' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY c.relname, a.attnum`)).rows.map(r => ({ rel: String(r.rel), name: String(r.name), type: String(r.type), notNull: r.not_null === true, def: r.def === null ? null : String(r.def) }));
    const constraints = (await c.query(
      `SELECT c.relname AS rel, k.conname AS name, k.contype::text AS type, pg_get_constraintdef(k.oid) AS def, x.relname AS index, x.relkind::text AS index_kind
         FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_class x ON x.oid = k.conindid
        WHERE n.nspname = 'smdb_data' AND k.contype <> 'n'`)).rows;
    const pk = new Map(constraints.filter(k => k.type === 'p').map(k => [String(k.rel), { name: String(k.name), def: String(k.def), index: String(k.index), indexKind: String(k.index_kind) }]));
    const indexes = (await c.query(
      `SELECT x.relname AS name, x.relkind::text AS kind, t.relname AS table
         FROM pg_index i JOIN pg_class x ON x.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace n ON n.oid = x.relnamespace
        WHERE n.nspname = 'smdb_data'`)).rows.map(r => ({ name: String(r.name), kind: String(r.kind), table: String(r.table) }));
    return { tables, partitions, columns, pk, constraints: constraints.map(k => ({ rel: String(k.rel), name: String(k.name), def: String(k.def) })), indexes };
  } finally {
    await c.query('ROLLBACK');
  }
}

const KIND: Record<string, string> = { i: 'index', I: 'partitioned index' };

function ownSentences(ref: RefShape, table: string, col: RefColumn | null, change: Change, added: Map<string, string>): Expected[] {
  const out: Expected[] = [];
  for (const rel of [table, ...(ref.partitions.get(table) ?? [])]) {
    if (change === 'extra') {
      out.push({ rel, aspect: ASPECT.column, sub: 'x_nb16', text: `smdb_data.${rel} has column x_nb16 (integer), which this bot's schema does not have` });
      continue;
    }
    const c = ref.columns.find(x => x.rel === rel && x.name === col!.name);
    if (!c) continue;
    const at = `smdb_data.${rel} column ${c.name}`;
    const push = (aspect: number, text: string) => out.push({ rel, aspect, sub: c.name, text });
    if (change === 'drop') push(ASPECT.column, `smdb_data.${rel} has no column ${c.name} (${c.type}${c.notNull ? ' NOT NULL' : ''})`);
    if (change === 'retype') push(ASPECT.type, `${at} is ${(c.name === 'doc' ? DOC_RETYPE : RETYPE[c.type]).shown}, where this bot's schema has ${c.type}`);
    if (change === 'notnull') push(ASPECT.notNull, c.notNull ? `${at} allows NULL, where this bot's schema has NOT NULL` : `${at} is NOT NULL, where this bot's schema allows NULL`);
    if (change === 'default') {
      push(ASPECT.default, c.def === null
        ? `${at} has default ${added.get(rel)}, where this bot's schema has no default`
        : `${at} has no default, where this bot's schema has default ${c.def}`);
    }
  }
  return out;
}

function extraSentences(ref: RefShape, table: string, col: RefColumn | null, extras: Extras): Expected[] {
  const out: Expected[] = [...(extras.sentences ?? [])];
  const family = [table, ...(ref.partitions.get(table) ?? [])];
  if (extras.pk) {
    for (const rel of family) {
      const pk = ref.pk.get(rel);
      if (!pk) continue;
      out.push({ rel, aspect: ASPECT.constraint, sub: pk.name, text: `smdb_data.${rel} lacks constraint ${pk.name} (${pk.def})` });
      out.push({ rel: pk.index, aspect: ASPECT.relation, sub: '', text: `smdb_data.${pk.index} (${KIND[pk.indexKind]}) is missing` });
    }
  }
  for (const name of extras.constraints ?? []) {
    const k = ref.constraints.find(x => x.name === name && family.includes(x.rel))!;
    out.push({ rel: k.rel, aspect: ASPECT.constraint, sub: k.name, text: `smdb_data.${k.rel} lacks constraint ${k.name} (${k.def})` });
  }
  for (const name of extras.indexes ?? []) {
    const x = ref.indexes.find(i => i.name === name)!;
    out.push({ rel: x.name, aspect: ASPECT.relation, sub: '', text: `smdb_data.${x.name} (${KIND[x.kind]}) is missing` });
  }
  if (extras.storage && col) {
    const [found, wanted] = extras.storage;
    for (const rel of family.filter(r => ref.columns.some(c => c.rel === r && c.name === col.name))) {
      out.push({ rel, aspect: ASPECT.storage, sub: col.name, text: `smdb_data.${rel} column ${col.name} has storage ${found}, where this bot's schema has ${wanted}` });
    }
  }
  return out;
}

/** An extra must name the table, a partition of it, or an index or constraint that belongs to one of them. */
function belongsToTable(ref: RefShape, table: string, sentence: string): boolean {
  const family = [table, ...(ref.partitions.get(table) ?? [])];
  const names = [...family, ...ref.indexes.filter(i => family.includes(i.table)).map(i => i.name)];
  return names.some(n => sentence.startsWith(`smdb_data.${n} `));
}

function statementFor(table: string, col: RefColumn | null, change: Change): string {
  const t = `smdb_data.${table}`;
  if (change === 'extra') return `ALTER TABLE ${t} ADD COLUMN x_nb16 integer`;
  const c = col!;
  if (change === 'drop') return `ALTER TABLE ${t} DROP COLUMN ${c.name}`;
  if (change === 'retype') {
    const to = c.name === 'doc' ? DOC_RETYPE : RETYPE[c.type];
    if (!to) throw new Error(`add a retype for ${c.type}`);
    return `ALTER TABLE ${t} ALTER COLUMN ${c.name} TYPE ${to.sql} USING ${c.name}::${to.sql}`;
  }
  if (change === 'notnull') return `ALTER TABLE ${t} ALTER COLUMN ${c.name} ${c.notNull ? 'DROP' : 'SET'} NOT NULL`;
  if (c.def !== null) return `ALTER TABLE ${t} ALTER COLUMN ${c.name} DROP DEFAULT`;
  const value = DEFAULT_FOR[c.type];
  if (!value) throw new Error(`add a default for ${c.type}`);
  return `ALTER TABLE ${t} ALTER COLUMN ${c.name} SET DEFAULT ${value}`;
}

describe('the sweep of every column of every table (item 5)', () => {
  it('each change gives its own sentences and its recorded extras in decision 9 order, and leaves the catalog as it was', async () => {
    const ref = await readReference(client);
    const before = await catalogSnapshot(client);
    const sequencesBefore = await sequenceValues(client);
    expect(ref.tables.length).toBeGreaterThan(0);
    const unrecorded: string[] = [];
    let iterations = 0;
    for (const table of ref.tables) {
      const pkColumns = new Set((ref.pk.get(table)?.def.match(/\(([^)]*)\)/)?.[1] ?? '').split(',').map(s => s.trim()));
      const cols = ref.columns.filter(c => c.rel === table);
      const plan: Array<[RefColumn | null, Change]> = [
        ...cols.flatMap(c => (['drop', 'retype', 'notnull', 'default'] as Change[]).map(ch => [c, ch] as [RefColumn, Change])),
        [null, 'extra'],
      ];
      for (const [col, change] of plan) {
        const key = `${table}.${col?.name ?? 'x_nb16'} ${change}`;
        const skipCode = SKIP[key] ?? (change === 'notnull' && col?.notNull && pkColumns.has(col.name) ? '42P16' : undefined);
        const statement = statementFor(table, col, change);
        await client.query('BEGIN');
        let differences: string[] = [];
        let refused: string | undefined;
        const added = new Map<string, string>();
        try {
          await client.query('SET LOCAL search_path = pg_catalog');
          await client.query('SET LOCAL quote_all_identifiers = off');
          await client.query('SAVEPOINT change');
          try {
            await client.query(statement);
          } catch (error) {
            refused = (error as { code?: string }).code ?? 'no code';
            await client.query('ROLLBACK TO SAVEPOINT change');
          }
          if (!skipCode && refused === undefined) {
            if (change === 'default' && col && col.def === null) {
              const defs = await client.query(
                `SELECT c.relname, pg_get_expr(d.adbin, d.adrelid) AS def FROM pg_attrdef d JOIN pg_class c ON c.oid = d.adrelid
                   JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
                  WHERE c.relnamespace = 'smdb_data'::regnamespace AND a.attname = $1`, [col.name]);
              for (const r of defs.rows) added.set(String(r.relname), String(r.def));
            }
            differences = (await checkShape(client, 'provisioned')).differences.map(d => d.text);
          }
        } finally {
          await client.query('ROLLBACK');
        }
        expect.soft(await catalogSnapshot(client), `the catalog changed after ${key}`).toEqual(before);
        expect.soft(await sequenceValues(client), `a sequence value changed after ${key}`).toEqual(sequencesBefore);
        iterations += 1;
        if (skipCode) {
          expect.soft(refused, `${key} is in the skip set: ${statement}`).toBe(skipCode);
          continue;
        }
        if (refused !== undefined) {
          expect.soft(refused, `${key}: ${statement}`).toBeUndefined();
          continue;
        }
        const own = ownSentences(ref, table, col, change, added);
        const others = differences.filter(d => !own.some(e => e.text === d));
        const recorded = EXTRAS[key];
        if (others.length && !recorded) {
          unrecorded.push(`record the extras of ${key}: ${JSON.stringify(others)}`);
          continue;
        }
        const extras = recorded ? extraSentences(ref, table, col, recorded) : [];
        for (const e of extras) expect.soft(belongsToTable(ref, table, e.text), `${key}: the extra "${e.text}" names nothing of ${table}`).toBe(true);
        expect.soft(differences, key).toEqual(inOrder([...own, ...extras]));
      }
    }
    expect(unrecorded).toEqual([]);
    expect(iterations).toBeGreaterThan(50);
  }, 1_800_000);
});
