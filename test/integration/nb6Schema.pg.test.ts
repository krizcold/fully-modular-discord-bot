import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { PostgresBackend, SCHEMA_VERSION } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { checkShape } from '../../src/bot/internalSetup/utils/dataBackends/storeShape';
import { fixedDatabase } from '../helpers/fixedDatabase';
import { startClaimRig, type ClaimRig } from '../helpers/pgClaimRig';

// NB6 test 32 (wip-redesign/sheets/NB6.md, C1 and C12): a fresh store at version 9 holds the six shared tables, the
// sequence and bytea bodies and lines; a store at version 8 is refused.

let rig: ClaimRig;
beforeAll(async () => { rig = await startClaimRig(); }, 180_000);
afterAll(async () => { await rig?.stop(); });
afterEach(() => { vi.restoreAllMocks(); });

const columns = async (table: string) => (await rig.direct.query(
  `SELECT column_name, data_type, is_nullable, column_default IS NOT NULL AS has_default
     FROM information_schema.columns WHERE table_schema = 'smdb_data' AND table_name = $1 ORDER BY ordinal_position`, [table])).rows
  .map(r => `${r.column_name} ${r.data_type}${r.is_nullable === 'NO' ? ' not null' : ''}${r.has_default ? ' default' : ''}`);

describe('a store provisioned at version 9', () => {
  it('holds {"v":9}, the six shared tables with their columns, the sequence and the lines index', async () => {
    expect(SCHEMA_VERSION).toBe(9);
    expect((await rig.direct.query(`SELECT value FROM smdb_data.meta WHERE key = 'schema_version'`)).rows[0].value).toBe('{"v":9}');
    const tables = (await rig.direct.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'smdb_data' AND table_name LIKE 'shared%' ORDER BY table_name`)).rows.map(r => r.table_name);
    expect(tables).toEqual(['shared_docs', 'shared_lines', 'shared_module_files', 'shared_module_status', 'shared_modules', 'shared_ops']);
    expect(await columns('shared_docs')).toEqual([
      'key text not null', 'body bytea not null', 'sha text not null', 'rev bigint not null',
      'updated_at timestamp with time zone not null default', 'updated_by text not null',
    ]);
    expect(await columns('shared_lines')).toEqual([
      'key text not null', 'id uuid not null', 'seq bigint not null default', 'line bytea not null',
      'created_at timestamp with time zone not null default',
    ]);
    expect(await columns('shared_modules')).toEqual([
      'module text not null', 'sha text not null', 'rev bigint not null', 'version text', 'file_count integer not null',
      'bytes bigint not null', 'updated_at timestamp with time zone not null default', 'updated_by text not null',
    ]);
    expect(await columns('shared_module_files')).toEqual(['module text not null', 'rel text not null', 'bytes bytea not null', 'mode integer not null']);
    expect(await columns('shared_module_status')).toEqual([
      'module text not null', 'node_id text not null', 'node_name text not null', 'sha text not null', 'state text not null',
      'error text', 'at timestamp with time zone not null default', 'process_id text not null', 'seq bigint not null',
    ]);
    expect(await columns('shared_ops')).toEqual(['id uuid not null', 'at timestamp with time zone not null default']);
    expect((await rig.direct.query(`SELECT 1 FROM information_schema.sequences WHERE sequence_schema = 'smdb_data' AND sequence_name = 'shared_rev_seq'`)).rowCount).toBe(1);
    expect((await rig.direct.query(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'smdb_data' AND indexname = 'shared_lines_key_seq'`)).rows[0].indexdef)
      .toBe('CREATE INDEX shared_lines_key_seq ON smdb_data.shared_lines USING btree (key, seq)');
    await expect(rig.direct.query(
      `INSERT INTO smdb_data.shared_module_status (module, node_id, node_name, sha, state, process_id, seq) VALUES ('m', 'n', 'N', 's', 'other', 'p', 1)`,
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('keeps a body and a line that are not UTF-8 text byte for byte, and orders lines by the shared sequence', async () => {
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x0a, 0x00]);
    await rig.direct.query(`INSERT INTO smdb_data.shared_docs (key, body, sha, rev, updated_by) VALUES ('global/x.bin', $1, 'sha', nextval('smdb_data.shared_rev_seq'), 'node-a')`, [bytes]);
    await rig.direct.query(`INSERT INTO smdb_data.shared_lines (key, id, line) VALUES ('global/x.jsonl', gen_random_uuid(), $1), ('global/x.jsonl', gen_random_uuid(), $2)`, [bytes, Buffer.from('b')]);
    expect((await rig.direct.query(`SELECT body FROM smdb_data.shared_docs WHERE key = 'global/x.bin'`)).rows[0].body).toEqual(bytes);
    const lines = (await rig.direct.query(`SELECT line, seq FROM smdb_data.shared_lines WHERE key = 'global/x.jsonl' ORDER BY seq`)).rows;
    expect(lines.map(r => r.line)).toEqual([bytes, Buffer.from('b')]);
    const rev = (await rig.direct.query(`SELECT rev FROM smdb_data.shared_docs WHERE key = 'global/x.bin'`)).rows[0].rev;
    expect(Number(lines[0].seq)).toBeGreaterThan(Number(rev));
  });

  it("passes NB16's shape check with no difference", async () => {
    const client = await rig.direct.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path = pg_catalog');
      await client.query('SET LOCAL quote_all_identifiers = off');
      const result = await checkShape(client, 'provisioned');
      await client.query('ROLLBACK');
      expect(result.differences).toEqual([]);
    } finally {
      client.release();
    }
  });
});

describe('a store at version 8', () => {
  it('is refused with the schema mismatch line', async () => {
    await rig.direct.query('CREATE DATABASE nb6_v8');
    const url = rig.url.replace(/\/[^/]+$/, '/nb6_v8');
    const first = new PostgresBackend(fixedDatabase(url));
    first.start();
    try {
      expect(await first.provisionVerdict()).toEqual({ state: 'provisioned' });
    } finally {
      await first.stop();
    }
    const v8 = new Pool({ connectionString: url, max: 1 });
    try {
      await v8.query(`UPDATE smdb_data.meta SET value = '{"v":8}' WHERE key = 'schema_version'`);
    } finally {
      await v8.end();
    }
    const lines: string[] = [];
    const capture = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    vi.spyOn(console, 'error').mockImplementation(capture);
    vi.spyOn(console, 'warn').mockImplementation(capture);
    vi.spyOn(console, 'log').mockImplementation(capture);
    const second = new PostgresBackend(fixedDatabase(url));
    second.start();
    try {
      expect(await second.provisionVerdict()).toEqual({ state: 'mismatch', found: '{"v":8}' });
      const until = Date.now() + 30_000;
      while (!lines.some(l => l.includes('schema-mismatch')) && Date.now() < until) await new Promise(resolve => { setTimeout(resolve, 100); });
      expect(lines).toContain('[PostgresBackend] schema-mismatch: smdb_data.meta schema_version is {"v":8}, expected {"v":9}; refusing to serve');
      expect(second.servesData()).toBe(false);
    } finally {
      await second.stop();
    }
  }, 90_000);
});
