import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { HYDRATE_BYTES_SQL, PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { flushBoundMs } from '../../src/bot/internalSetup/utils/storableData';
import { fixedDatabase } from '../helpers/fixedDatabase';
import { poolFor, startPostgres } from '../helpers/postgres';

// NB20 against a real Postgres: the hydrate sizes its statement_timeout by the guild's UTF-8 bytes and leaves the
// pooled client with the pool's 30 s.

let container: StartedPostgreSqlContainer;
let direct: Pool;
let backend: PostgresBackend;

type Connect = (cb?: unknown) => Promise<any> | void;
const ownQuery = Symbol('nb20-own-query');

/** Records the text of each query the pool's promise-connect clients send; restore gives each client its own query back. */
function recordHydrate(pool: Pool): { sent: string[]; restore: () => void } {
  const target = pool as unknown as { connect: Connect };
  const realConnect = target.connect.bind(pool) as Connect;
  const sent: string[] = [];
  const touched = new Set<any>();
  target.connect = (cb?: unknown) => {
    if (typeof cb === 'function') return realConnect(cb);
    return (realConnect() as Promise<any>).then(client => {
      const query = (client[ownQuery] ??= client.query) as (...args: any[]) => any;
      touched.add(client);
      client.query = (sql: any, ...rest: any[]) => {
        sent.push((typeof sql === 'string' ? sql : String(sql?.text ?? '')).trim());
        return query.call(client, sql, ...rest);
      };
      return client;
    });
  };
  return {
    sent,
    restore: () => {
      target.connect = realConnect;
      for (const client of touched) client.query = client[ownQuery];
    },
  };
}

const token: FenceToken = { nodeId: 'node-1', claim: 1, processId: 'p-1', shardId: 0, shardCount: 101 };

beforeAll(async () => {
  container = await startPostgres();
  direct = poolFor(container);
  const user = encodeURIComponent(container.getUsername());
  const password = encodeURIComponent(container.getPassword());
  backend = new PostgresBackend(fixedDatabase(`postgres://${user}:${password}@${container.getHost()}:${container.getPort()}/${container.getDatabase()}`));
  backend.start();
  const until = Date.now() + 60_000;
  while (backend.connectionState().state !== 'ready' && Date.now() < until) await new Promise(resolve => { setTimeout(resolve, 100); });
  expect(backend.connectionState().state).toBe('ready');
  await direct.query(`INSERT INTO smdb_data.shard_claims (shard_count, shard_id, claim, holder_process, holder_node, holder_name, home_node, ttl_ms, expires_up_ms)
    VALUES (101, 0, 1, 'p-1', 'node', 'node', 'node', 30000, 30000) ON CONFLICT DO NOTHING`);
}, 180_000);

afterAll(async () => {
  await backend?.stop();
  await direct?.end();
  await container?.stop();
});

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('NB20: the hydrate bound', () => {
  it('a guild of 300 KB of multi-byte text hydrates whole under SET LOCAL sized by the real size statement, and the pooled client keeps 30 s', async () => {
    const guild = '920001';
    const docs = [['m', 'a.json', 'é'.repeat(100_000)], ['ключ', 'b.json', 'x'.repeat(100_000)]];
    for (const [module, filename, doc] of docs) {
      await direct.query('INSERT INTO smdb_data.guild_data (guild_id, module, filename, doc) VALUES ($1, $2, $3, $4)', [guild, module, filename, doc]);
    }
    const bytes = docs.reduce((n, d) => n + d.reduce((m, s) => m + Buffer.byteLength(s, 'utf8'), 0), 0);
    await direct.query(`INSERT INTO smdb_data.guild_append (guild_id, module, filename, chunk) VALUES ($1, 'm', 'l.jsonl', 'x
'), ($1, 'm', 'l.jsonl', 'y
')`, [guild]);
    const counted = await direct.query(HYDRATE_BYTES_SQL, [guild]);
    expect(Number(counted.rows[0].bytes)).toBe(bytes + 2 * 19 + 'm'.length + 'l.jsonl'.length + 19);
    const recorder = recordHydrate(backend.getPool());
    let outcome;
    try {
      outcome = await backend.hydrateGuild(guild, token);
    } finally {
      recorder.restore();
    }
    const sent = recorder.sent;
    const begin = sent.indexOf('BEGIN');
    const set = sent.indexOf(`SET LOCAL statement_timeout = ${flushBoundMs(Number(counted.rows[0].bytes))}`);
    const docsRead = sent.findIndex(t => t.startsWith('SELECT module, filename, doc FROM smdb_data.guild_data'));
    const appendRead = sent.findIndex(t => t.startsWith('SELECT DISTINCT module, filename FROM smdb_data.guild_append'));
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(set).toBeGreaterThan(begin);
    expect(set).toBeGreaterThan(sent.indexOf(HYDRATE_BYTES_SQL));
    expect(docsRead).toBeGreaterThan(set);
    expect(appendRead).toBeGreaterThan(set);
    expect(sent.indexOf('COMMIT')).toBeGreaterThan(Math.max(docsRead, appendRead));
    if (outcome?.ok) expect(outcome.appendKeys).toEqual([{ module: 'm', filename: 'l.jsonl' }]);
    expect(outcome).toMatchObject({ ok: true });
    if (outcome.ok) expect(outcome.docs.map(d => d.doc).sort()).toEqual(docs.map(d => d[2]).sort());
    const shown = await backend.getPool().query('SHOW statement_timeout');
    expect(shown.rows[0].statement_timeout).toBe('30s');
  });
});
