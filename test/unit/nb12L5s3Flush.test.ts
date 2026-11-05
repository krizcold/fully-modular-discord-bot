import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FenceToken, GuildFlushBatch } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import type { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { FLUSH_STATEMENT_BYTES, flushBoundMs } from '../../src/bot/internalSetup/utils/storableData';
import { type Sent, bytesOf, scriptedBackend } from '../helpers/scriptedPg';

// NB12 item 9 (wip-redesign/sheets/NB12.md, decision 6): how a flush packs its statements, the bound it sets from the
// largest one, and what it logs when it cannot build them.

const MIB = 1024 * 1024;
const token: FenceToken = { nodeId: 'node-a', claim: 3, processId: 'process-a', shardId: 0, shardCount: 1 };
const backends: PostgresBackend[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const backend of backends.splice(0)) await backend.stop();
});

function scripted() {
  const rigged = scriptedBackend();
  backends.push(rigged.backend);
  return rigged;
}

function quiet(): string[] {
  const errors: string[] = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  return errors;
}

const upsertsOf = (sent: Sent[]) => sent.filter(s => s.sql.startsWith('INSERT INTO smdb_data.guild_data'));
const rowsOf = (st: Sent) => (st.params!.length - 1) / 3;
// The document and key text a statement carries: every parameter after the guild id.
const rowTextOf = (st: Sent) => st.params!.slice(1).reduce<number>((n, v) => n + Buffer.byteLength(String(v)), 0);

async function flush(batch: GuildFlushBatch) {
  quiet();
  const { backend, sent } = scripted();
  expect(await backend.flushGuild('1', batch, token)).toEqual({ ok: true });
  return sent;
}

const smallDocs = (count: number): GuildFlushBatch['upserts'] =>
  Array.from({ length: count }, (_, i) => ({ key: { module: 'm', filename: `d${i}.json` }, doc: '{}' }));

describe('the upserts of a flush', () => {
  it('sends two small documents as one statement', async () => {
    const sent = await flush({ upserts: smallDocs(2), deletes: [], appends: [] });
    const upserts = upsertsOf(sent);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].params).toEqual(['1', 'm', 'd0.json', '{}', 'm', 'd1.json', '{}']);
  });

  it('sends 201 small documents as 200 rows and then 1', async () => {
    const sent = await flush({ upserts: smallDocs(201), deletes: [], appends: [] });
    expect(upsertsOf(sent).map(rowsOf)).toEqual([200, 1]);
  });

  it('keeps two rows of exactly 4 MiB of text together in one statement', async () => {
    const doc = 'x'.repeat(2 * MIB - 7);
    const upserts = [{ key: { module: 'm', filename: 'a.json' }, doc }, { key: { module: 'm', filename: 'b.json' }, doc }];
    const sent = await flush({ upserts, deletes: [], appends: [] });
    const statements = upsertsOf(sent);
    expect(statements.map(rowsOf)).toEqual([2]);
    expect(rowTextOf(statements[0])).toBe(FLUSH_STATEMENT_BYTES);
  });

  it.each([
    ['a long file name', { module: 'm', filename: 'f'.repeat(100) }],
    ['a long module name', { module: 'm'.repeat(100), filename: 'f.json' }],
  ])('counts %s toward the 4 MiB of a statement', async (_name, key) => {
    const doc = 'x'.repeat(2 * MIB - 50);
    const upserts = [{ key: { ...key, filename: `${key.filename}1` }, doc }, { key: { ...key, filename: `${key.filename}2` }, doc }];
    const sent = await flush({ upserts, deletes: [], appends: [] });
    const statements = upsertsOf(sent);
    expect(statements.map(rowsOf)).toEqual([1, 1]);
    for (const st of statements) expect(rowTextOf(st)).toBeGreaterThan(2 * MIB);
    expect(rowTextOf(statements[0]) + rowTextOf(statements[1])).toBeGreaterThan(FLUSH_STATEMENT_BYTES);
  });

  it('sends a document over 4 MiB alone, with no empty statement before it', async () => {
    const doc = 'x'.repeat(4 * MIB + 10);
    const sent = await flush({ upserts: [{ key: { module: 'm', filename: 'big.json' }, doc }], deletes: [], appends: [] });
    const statements = upsertsOf(sent);
    expect(statements.map(rowsOf)).toEqual([1]);
    expect(statements[0].params![3]).toBe(doc);
  });

  it('sends no upsert at all for a flush of deletes only', async () => {
    const sent = await flush({ upserts: [], deletes: [{ module: 'm', filename: 'gone.json' }], appends: [] });
    expect(upsertsOf(sent)).toHaveLength(0);
    expect(sent.filter(s => s.sql.startsWith('INSERT'))).toHaveLength(0);
  });
});

describe('the deletes of a flush', () => {
  it('deletes the document rows and the append rows of each key', async () => {
    const deletes = [{ module: 'm', filename: 'a.json' }, { module: 'n', filename: 'b.jsonl' }];
    const sent = await flush({ upserts: [], deletes, appends: [] });
    const body = sent.filter(s => s.sql.startsWith('DELETE'));
    expect(body.map(s => s.sql)).toEqual([
      'DELETE FROM smdb_data.guild_data WHERE guild_id = $1 AND (module, filename) IN (($2, $3), ($4, $5))',
      'DELETE FROM smdb_data.guild_append WHERE guild_id = $1 AND (module, filename) IN (($2, $3), ($4, $5))',
    ]);
    for (const st of body) expect(st.params).toEqual(['1', 'm', 'a.json', 'n', 'b.jsonl']);
  });
});

describe('the bound of a flush', () => {
  it('comes from its largest statement, even when a smaller one is sent last', async () => {
    const doc = 'x'.repeat(MIB);
    const sent = await flush({ upserts: [{ key: { module: 'm', filename: 'a.json' }, doc }], deletes: [{ module: 'm', filename: 'b.json' }], appends: [] });
    const largest = Math.max(...sent.filter(s => s.sql !== 'COMMIT' && !s.sql.startsWith('BEGIN')).map(bytesOf));
    expect(largest).toBe(bytesOf(upsertsOf(sent)[0]));
    const begin = sent.find(s => s.sql.startsWith('BEGIN'))!;
    expect(begin.sql).toBe(`BEGIN; SET LOCAL statement_timeout = ${flushBoundMs(largest)}`);
    expect(flushBoundMs(largest)).toBeGreaterThan(flushBoundMs(bytesOf(sent[sent.length - 2])));
  });
});

describe('a flush whose statements cannot be built', () => {
  it('sends nothing, answers unavailable and says the caller retries', async () => {
    const errors = quiet();
    const { backend, sent, connect } = scripted();
    const batch = { upserts: [{ key: { module: 'm', filename: 'a.json' }, doc: null as unknown as string }], deletes: [], appends: [] };
    expect(await backend.flushGuild('77', batch, token)).toEqual({ ok: false, reason: 'unavailable' });
    expect(connect).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].startsWith('[PostgresBackend] flushGuild for 77 could not build its statements; nothing was sent (caller retries): ')).toBe(true);
  });
});
