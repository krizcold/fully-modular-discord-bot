import net from 'net';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { PostgresBackend, SCHEMA_VERSION } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { fixedDatabase } from '../helpers/fixedDatabase';
import { takeShard } from '../helpers/pgClaims';
import { poolFor, startPostgres } from '../helpers/postgres';

// NB14 test 5 (wip-redesign/sheets/NB14.md) and the check's rows 12 to 14: the replace's move-out and copy-in in one
// transaction, the batch names and the sweep on the database's clock, the graveyard lock and the keep time, against a
// real Postgres behind a TCP hop that can drop traffic.

/** A TCP hop whose stall drops bytes both ways without a reset, as a network that loses packets. */
class Hop {
  private readonly sockets = new Set<net.Socket>();
  private stalled = false;
  private repliesStalled = false;
  private readonly upstreams = new Set<net.Socket>();
  private readonly crossed = new Set<net.Socket>();
  private readonly server = net.createServer(client => this.accept(client));

  constructor(private readonly target: { host: string; port: number }) {}

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => resolve((this.server.address() as net.AddressInfo).port));
    });
  }

  stall(): void {
    this.stalled = true;
    for (const socket of this.sockets) this.crossed.add(socket);
  }

  stallReplies(): void {
    this.repliesStalled = true;
    for (const socket of this.sockets) this.crossed.add(socket);
  }

  restore(): void {
    this.stalled = false;
    this.repliesStalled = false;
    for (const socket of this.crossed) socket.destroy();
    this.crossed.clear();
  }

  close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    return new Promise(resolve => { this.server.close(() => resolve()); });
  }

  private dropping(from: net.Socket): boolean {
    return this.stalled || (this.repliesStalled && this.upstreams.has(from));
  }

  private accept(client: net.Socket): void {
    const upstream = net.connect(this.target.port, this.target.host);
    this.upstreams.add(upstream);
    for (const [from, to] of [[client, upstream], [upstream, client]] as const) {
      this.sockets.add(from);
      if (this.stalled || this.repliesStalled) this.crossed.add(from);
      from.on('data', chunk => { if (!this.dropping(from)) to.write(chunk); });
      from.on('close', () => {
        this.sockets.delete(from);
        this.upstreams.delete(from);
        if (!this.dropping(from)) to.destroy();
      });
      from.on('error', () => { /* the close that follows ends the other side */ });
    }
  }
}

const SECOND = 1000;
const DAY = 24 * 60 * 60 * SECOND;
const LOCK_KEY = "hashtext('smdb_data_graveyard')";

let container: StartedPostgreSqlContainer;
let direct: Pool;
let hop: Hop;
let backend: PostgresBackend;
let claim: number;
let guilds = 940_000;

const freshGuild = () => String(++guilds);
const tokenOf = (c: number): FenceToken => ({ nodeId: 'node-a', claim: c, processId: 'process-a', shardId: 0, shardCount: 1 });
const none = () => null;
const monoIn = (ms: number) => process.hrtime.bigint() + BigInt(ms) * 1_000_000n;
const sleep = (ms: number) => new Promise(resolve => { setTimeout(resolve, ms); });
const rows = async (sql: string, values: unknown[] = []) => (await direct.query(sql, values)).rows;
const dbNow = async () => Number((await rows(`SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now`))[0].now);

async function waitReady(b: PostgresBackend): Promise<void> {
  const until = Date.now() + 60_000;
  while (b.connectionState().state !== 'ready' && Date.now() < until) await sleep(100);
  expect(b.connectionState().state).toBe('ready');
}

beforeAll(async () => {
  container = await startPostgres();
  direct = poolFor(container);
  hop = new Hop({ host: container.getHost(), port: container.getPort() });
  const port = await hop.listen();
  const user = encodeURIComponent(container.getUsername());
  const password = encodeURIComponent(container.getPassword());
  backend = new PostgresBackend(fixedDatabase(`postgres://${user}:${password}@127.0.0.1:${port}/${container.getDatabase()}`));
  backend.start();
  await waitReady(backend);
  claim = (await takeShard(direct, { processId: 'process-a', nodeId: 'node-a' })).claim!;
}, 120_000);

afterAll(async () => {
  await hop?.close();
  await backend?.stop();
  await direct?.end();
  await container?.stop();
});

afterEach(() => {
  vi.restoreAllMocks();
  hop.restore();
});

async function bury(guildId: string, retiredAt: number, docs: Record<string, string>, appends: Record<string, string> = {}, reason = 'test'): Promise<void> {
  for (const [filename, doc] of Object.entries(docs)) {
    await direct.query(`INSERT INTO smdb_data.guild_data_graveyard (guild_id, module, filename, kind, doc, retired_at, reason) VALUES ($1, 'm', $2, 'doc', $3, $4, $5)`, [guildId, filename, doc, retiredAt, reason]);
  }
  for (const [filename, chunk] of Object.entries(appends)) {
    await direct.query(`INSERT INTO smdb_data.guild_data_graveyard (guild_id, module, filename, kind, doc, retired_at, reason) VALUES ($1, 'm', $2, 'append', $3, $4, $5)`, [guildId, filename, chunk, retiredAt, reason]);
  }
}

async function live(guildId: string, docs: Record<string, string>, chunks: [string, string][] = []): Promise<void> {
  for (const [filename, doc] of Object.entries(docs)) {
    await direct.query(`INSERT INTO smdb_data.guild_data (guild_id, module, filename, doc) VALUES ($1, 'm', $2, $3)`, [guildId, filename, doc]);
  }
  for (const [filename, chunk] of chunks) {
    await direct.query(`INSERT INTO smdb_data.guild_append (guild_id, module, filename, chunk) VALUES ($1, 'm', $2, $3)`, [guildId, filename, chunk]);
  }
}

const liveDocs = (g: string) => rows(`SELECT filename, doc FROM smdb_data.guild_data WHERE guild_id = $1 ORDER BY filename`, [g]);
const liveStreams = (g: string) => rows(`SELECT filename, string_agg(chunk, '' ORDER BY seq) AS doc FROM smdb_data.guild_append WHERE guild_id = $1 GROUP BY filename ORDER BY filename`, [g]);
const batch = (g: string, at: number) => rows(`SELECT filename, kind, doc, reason, used_at FROM smdb_data.guild_data_graveyard WHERE guild_id = $1 AND retired_at = $2 ORDER BY filename`, [g, at]);
const batches = async (g: string) => (await rows(`SELECT DISTINCT retired_at FROM smdb_data.guild_data_graveyard WHERE guild_id = $1 ORDER BY retired_at`, [g])).map(r => Number(r.retired_at));
const replace = (g: string, retiredAt: number | null) => backend.restoreGuild(g, retiredAt, tokenOf(claim), none, monoIn(40 * SECOND), true);

/** Calls act once, right after a statement matching match is handed to a client of the backend's pool. */
function onStatement(match: (text: string) => boolean, act: () => void): () => void {
  const pool = backend.getPool() as any;
  const connect = pool.connect;
  const patched = new Map<any, any>();
  let fired = false;
  const patch = (client: any) => {
    if (!client || patched.has(client)) return;
    const query = client.query;
    patched.set(client, query);
    client.query = (config: any, ...rest: any[]) => {
      const text = typeof config === 'string' ? config : config?.text;
      const sent = query.call(client, config, ...rest);
      if (!fired && typeof text === 'string' && match(text.trim())) {
        fired = true;
        setImmediate(act);
      }
      return sent;
    };
  };
  pool.connect = (...args: any[]) => {
    const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
    if (callback) {
      return connect.call(pool, (error: unknown, client: any, done: unknown) => {
        if (!error) patch(client);
        callback(error, client, done);
      });
    }
    return connect.call(pool).then((client: any) => { patch(client); return client; });
  };
  return () => {
    pool.connect = connect;
    for (const [client, query] of patched) client.query = query;
  };
}

describe('a replace', () => {
  it('commits both: the live rows are X\'s, X is unchanged but stamped, R holds the previous rows', async () => {
    const g = freshGuild();
    await live(g, { 'a.json': '{"a":1}', 'b.json': '{"b":1}' }, [['l.jsonl', 'one\n'], ['l.jsonl', 'two\n'], ['k.jsonl', 'k\n']]);
    await bury(g, 5, { 'x.json': '{"x":1}' }, { 'y.jsonl': 'y\n' });
    const answer = await replace(g, 5);
    expect(answer).toMatchObject({ ok: true, retiredAt: 5, copied: 2, replaced: { moved: 4, reason: 'replaced-by-restore-5' } });
    const r = (answer as { replaced: { retiredAt: number } }).replaced.retiredAt;
    expect(await liveDocs(g)).toEqual([{ filename: 'x.json', doc: '{"x":1}' }]);
    expect(await liveStreams(g)).toEqual([{ filename: 'y.jsonl', doc: 'y\n' }]);
    expect((await batch(g, 5)).map(b => [b.filename, b.doc])).toEqual([['x.json', '{"x":1}'], ['y.jsonl', 'y\n']]);
    expect((await batch(g, 5)).every(b => b.used_at !== null)).toBe(true);
    expect((await batch(g, r)).map(b => [b.filename, b.kind, b.doc, b.reason])).toEqual([
      ['a.json', 'doc', '{"a":1}', 'replaced-by-restore-5'],
      ['b.json', 'doc', '{"b":1}', 'replaced-by-restore-5'],
      ['k.jsonl', 'append', 'k\n', 'replaced-by-restore-5'],
      ['l.jsonl', 'append', 'one\ntwo\n', 'replaced-by-restore-5'],
    ]);
    const owner = (await rows(`SELECT retired_at FROM smdb_data.guild_ownership WHERE guild_id = $1`, [g]))[0];
    expect(owner.retired_at).toBeNull();
  });

  it('a plain restore copies: X unchanged, the live rows equal it', async () => {
    const g = freshGuild();
    await bury(g, 5, { 'x.json': '{"x":1}' });
    expect(await backend.restoreGuild(g, 5, tokenOf(claim), none, monoIn(40 * SECOND))).toMatchObject({ ok: true, retiredAt: 5, copied: 1 });
    expect(await liveDocs(g)).toEqual([{ filename: 'x.json', doc: '{"x":1}' }]);
    expect((await batch(g, 5)).map(b => b.doc)).toEqual(['{"x":1}']);
  });

  it('a second replace with no retiredAt puts the previous data back and moves X\'s copy above R', async () => {
    const g = freshGuild();
    await live(g, { 'a.json': '{"a":1}' });
    await bury(g, 5, { 'x.json': '{"x":1}' });
    const first = await replace(g, 5) as { replaced: { retiredAt: number } };
    const second = await replace(g, null);
    expect(second).toMatchObject({ ok: true, retiredAt: first.replaced.retiredAt });
    const r2 = (second as { replaced: { retiredAt: number } }).replaced.retiredAt;
    expect(r2).toBeGreaterThan(first.replaced.retiredAt);
    expect(await liveDocs(g)).toEqual([{ filename: 'a.json', doc: '{"a":1}' }]);
    expect((await batch(g, r2)).map(b => b.doc)).toEqual(['{"x":1}']);
    expect(await batches(g)).toEqual([5, first.replaced.retiredAt, r2]);
  });

  it('a delete after a replace names a batch above R', async () => {
    const g = freshGuild();
    await live(g, { 'a.json': '{"a":1}' });
    await bury(g, 5, { 'x.json': '{"x":1}' });
    const first = await replace(g, 5) as { replaced: { retiredAt: number } };
    const retired = await backend.retireGuild(g, 'webui-operator-delete', tokenOf(claim), monoIn(40 * SECOND));
    expect(retired).toMatchObject({ ok: true, moved: 1 });
    expect((retired as { retiredAt: number }).retiredAt).toBeGreaterThan(first.replaced.retiredAt);
  });

  it('the fence: a stored claim above the replacer\'s answers deposed and moves nothing', async () => {
    const g = freshGuild();
    await direct.query(`INSERT INTO smdb_data.guild_ownership (guild_id, node_id, shard_id, claim, shard_count) VALUES ($1, 'node-b', 0, $2, 1)`, [g, claim + 1]);
    await live(g, { 'a.json': '{"a":1}' });
    await bury(g, 5, { 'x.json': '{"x":1}' });
    expect(await replace(g, 5)).toMatchObject({ ok: false, reason: 'deposed' });
    expect(await liveDocs(g)).toEqual([{ filename: 'a.json', doc: '{"a":1}' }]);
    expect(await batches(g)).toEqual([5]);
  });

  it('a doc and an append stream under one name: the move-out is refused with 23505 and nothing moves', async () => {
    const g = freshGuild();
    await live(g, { 'a.json': '{"a":1}' }, [['a.json', 'x\n']]);
    await bury(g, 5, { 'x.json': '{"x":1}' });
    const answer = await replace(g, 5);
    expect(answer).toMatchObject({ ok: false, reason: 'refused', code: '23505' });
    expect(await liveDocs(g)).toEqual([{ filename: 'a.json', doc: '{"a":1}' }]);
    expect(await batches(g)).toEqual([5]);
  });
});

describe('a crash or a lost COMMIT', () => {
  it.each([
    ['after the move-out', (t: string) => t.startsWith('WITH r AS')],
    ['after the copy-in', (t: string) => t.startsWith('WITH src AS')],
    ['before COMMIT', null],
  ] as const)('a stall %s changes nothing once the server rolls back', async (_name, match) => {
    const g = freshGuild();
    await live(g, { 'a.json': '{"a":1}' });
    await bury(g, 5, { 'x.json': '{"x":1}' });
    const undo = match ? onStatement(match, () => hop.stall()) : () => undefined;
    const beforeCommit = match ? none : () => { hop.stall(); return null; };
    try {
      expect(await backend.restoreGuild(g, 5, tokenOf(claim), beforeCommit, monoIn(40 * SECOND), true)).toMatchObject({ ok: false });
    } finally {
      undo();
      hop.restore();
    }
    await sleep(41 * SECOND);
    expect(await liveDocs(g)).toEqual([{ filename: 'a.json', doc: '{"a":1}' }]);
    expect(await batches(g)).toEqual([5]);
    expect((await batch(g, 5))[0].used_at).toBeNull();
  }, 150_000);

  it('a COMMIT with no answer names X and R; a minute later either both happened or neither, and X exists', async () => {
    const g = freshGuild();
    await live(g, { 'a.json': '{"a":1}' });
    await bury(g, 5, { 'x.json': '{"x":1}' });
    const undo = onStatement(t => t === 'COMMIT', () => hop.stallReplies());
    let answer;
    try {
      answer = await replace(g, 5);
    } finally {
      undo();
      hop.restore();
    }
    expect(answer).toMatchObject({ ok: false, reason: 'unknown', retiredAt: 5, replaced: { moved: 1, reason: 'replaced-by-restore-5' } });
    const r = (answer as { replaced: { retiredAt: number } }).replaced.retiredAt;
    await sleep(60 * SECOND);
    const now = await liveDocs(g);
    const all = await batches(g);
    expect(all).toContain(5);
    if (all.includes(r)) expect(now).toEqual([{ filename: 'x.json', doc: '{"x":1}' }]);
    else expect(now).toEqual([{ filename: 'a.json', doc: '{"a":1}' }]);
  }, 180_000);
});

describe('the database\'s clock', () => {
  it('R is a batch at the database\'s now plus 60000, plus 1; the bot\'s clock an hour back changes nothing', async () => {
    const g = freshGuild();
    const ahead = (await dbNow()) + 60_000;
    await live(g, { 'a.json': '{"a":1}' });
    await bury(g, ahead, { 'x.json': '{"x":1}' });
    const real = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(real - 3_600_000);
    const answer = await replace(g, ahead);
    expect(answer).toMatchObject({ ok: true, replaced: { retiredAt: ahead + 1 } });
  });

  it('a sweep with the bot\'s clock a day ahead and a TTL of one hour does not remove a fresh R', async () => {
    const g = freshGuild();
    await live(g, { 'a.json': '{"a":1}' });
    await bury(g, 5, { 'x.json': '{"x":1}' });
    const r = ((await replace(g, 5)) as { replaced: { retiredAt: number } }).replaced.retiredAt;
    const real = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(real + DAY);
    await backend.sweepGraveyard(3_600_000);
    expect(await batches(g)).toContain(r);
  });

  it("a retire's batch is the one settleRetires reads (C5)", async () => {
    const g = freshGuild();
    await live(g, { 'a.json': '{"a":1}' });
    const real = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(real - 3_600_000);
    const retired = await backend.retireGuild(g, 'webui-operator-delete', tokenOf(claim), monoIn(40 * SECOND));
    expect(retired).toMatchObject({ ok: true });
    vi.restoreAllMocks();
    expect(await backend.retireReached(g, (retired as { retiredAt: number }).retiredAt)).toBe(true);
  });

  it('a re-save batch reads the database\'s clock (C4)', async () => {
    const g = freshGuild();
    await live(g, { 'gone.json': '{"g":1}' });
    const real = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(real + 3_600_000);
    const answer = await backend.flushGuild(g, { upserts: [{ key: { module: 'm', filename: 'kept.json' }, doc: '{"k":1}' }], deletes: [], appends: [], replace: { docKeys: [{ module: 'm', filename: 'kept.json' }], appendKeys: [], reason: 're-saved' } }, tokenOf(claim));
    vi.restoreAllMocks();
    expect(answer).toEqual({ ok: true });
    const [at] = await batches(g);
    expect(Math.abs(at - (await dbNow()))).toBeLessThan(5 * SECOND);
  });
});

describe('the sweep and the keep time', () => {
  it('a restore restarts the keep time; a sweep with a 1 ms TTL after the commit removes X', async () => {
    const g = freshGuild();
    const old = (await dbNow()) - 14 * DAY - 3_600_000;
    await live(g, { 'a.json': '{"a":1}' });
    await bury(g, old, { 'x.json': '{"x":1}' });
    const answer = await replace(g, old) as { usedAt: number };
    const stamped = (await batch(g, old)).map(b => Number(b.used_at));
    expect(new Set(stamped)).toEqual(new Set([answer.usedAt]));
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 3_600_000);
    await backend.sweepGraveyard(14 * DAY);
    expect(await batches(g)).toContain(old);
    vi.restoreAllMocks();
    await sleep(5);
    await backend.sweepGraveyard(1);
    expect(await batches(g)).not.toContain(old);
  });

  it('a rolled-back restore leaves used_at NULL', async () => {
    const g = freshGuild();
    await live(g, { 'a.json': '{"a":1}' });
    await bury(g, 5, { 'x.json': '{"x":1}' });
    expect(await backend.restoreGuild(g, 5, tokenOf(claim), () => 'maintenance', monoIn(40 * SECOND), true)).toMatchObject({ ok: false, reason: 'maintenance' });
    expect((await batch(g, 5))[0].used_at).toBeNull();
    expect(await liveDocs(g)).toEqual([{ filename: 'a.json', doc: '{"a":1}' }]);
  });

  it('the sweep cannot split a restore: before, during and after', async () => {
    const g = freshGuild();
    await bury(g, 5, { 'x.json': '{"x":1}', 'y.json': '{"y":1}' });
    const sweeper = await direct.connect();
    try {
      await sweeper.query('BEGIN');
      expect((await sweeper.query(`SELECT pg_try_advisory_xact_lock(${LOCK_KEY}) AS locked`)).rows[0].locked).toBe(true);
      await sweeper.query(`DELETE FROM smdb_data.guild_data_graveyard WHERE guild_id = $1`, [g]);
      const restoring = backend.restoreGuild(g, 5, tokenOf(claim), none, monoIn(40 * SECOND));
      await sleep(500);
      await sweeper.query('COMMIT');
      expect(await restoring).toMatchObject({ ok: false, reason: 'no-entry' });
    } finally {
      sweeper.release();
    }
    expect(await liveDocs(g)).toEqual([]);

    const g2 = freshGuild();
    await bury(g2, 5, { 'x.json': '{"x":1}' });
    const holder = await direct.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock_shared(${LOCK_KEY})`);
      expect(await backend.sweepGraveyard(1)).toBe(0);
      await holder.query('ROLLBACK');
    } finally {
      holder.release();
    }
    expect(await batches(g2)).toEqual([5]);

    expect(await backend.restoreGuild(g2, 5, tokenOf(claim), none, monoIn(40 * SECOND))).toMatchObject({ ok: true });
    await backend.sweepGraveyard(DAY);
    expect(await batches(g2)).toEqual([5]);
    const deadlocks = await rows(`SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`);
    expect(Number(deadlocks[0].deadlocks)).toBe(0);
  });

  it('the sweep\'s DELETE uses guild_graveyard_ttl_idx on a table of 100000 rows, 1% expired', async () => {
    const scratch = await direct.connect();
    try {
      await scratch.query('BEGIN');
      const now = await dbNow();
      await scratch.query(
        `INSERT INTO smdb_data.guild_data_graveyard (guild_id, module, filename, kind, doc, retired_at, reason)
         SELECT 'idx-' || (i % 1000), 'm', 'f' || i || '.json', 'doc', '{}', CASE WHEN i % 100 = 0 THEN $1::bigint - 30 * 86400000::bigint + i ELSE $1::bigint + i END, 'idx'
           FROM generate_series(1, 100000) AS i`, [now]);
      await scratch.query('ANALYZE smdb_data.guild_data_graveyard');
      const plan = await scratch.query(
        `EXPLAIN DELETE FROM smdb_data.guild_data_graveyard
          WHERE retired_at < (extract(epoch FROM statement_timestamp()) * 1000)::bigint - $1
            AND (used_at IS NULL OR used_at < (extract(epoch FROM statement_timestamp()) * 1000)::bigint - $1)`, [14 * DAY]);
      expect(plan.rows.map(r => r['QUERY PLAN']).join('\n')).toMatch(/guild_graveyard_ttl_idx/);
    } finally {
      await scratch.query('ROLLBACK');
      scratch.release();
    }
  });
});

describe('version 10', () => {
  it('a database of version 8 is refused (C19)', async () => {
    expect(SCHEMA_VERSION).toBe(10);
    await direct.query('CREATE DATABASE nb14v7');
    const user = encodeURIComponent(container.getUsername());
    const password = encodeURIComponent(container.getPassword());
    const url = `postgres://${user}:${password}@${container.getHost()}:${container.getPort()}/nb14v7`;
    const first = new PostgresBackend(fixedDatabase(url));
    first.start();
    await waitReady(first);
    await first.stop();
    const v7 = new Pool({ connectionString: url, max: 1 });
    await v7.query(`UPDATE smdb_data.meta SET value = '{"v":8}' WHERE key = 'schema_version'`);
    await v7.end();
    const lines: string[] = [];
    const capture = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    vi.spyOn(console, 'error').mockImplementation(capture);
    vi.spyOn(console, 'warn').mockImplementation(capture);
    vi.spyOn(console, 'log').mockImplementation(capture);
    const second = new PostgresBackend(fixedDatabase(url));
    second.start();
    try {
      const until = Date.now() + 30_000;
      while (!lines.some(l => l.includes('schema-mismatch')) && Date.now() < until) await sleep(100);
      expect(lines).toContain('[PostgresBackend] schema-mismatch: smdb_data.meta schema_version is {"v":8}, expected {"v":10}; refusing to serve');
      expect(second.servesData()).toBe(false);
    } finally {
      await second.stop();
    }
  }, 90_000);
});
