import net from 'net';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import fc from 'fast-check';
import { Client, type Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { initWorkingSet, type WorkingSetManager } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { appendDataTracked, saveData, saveDataTracked } from '../../src/bot/internalSetup/utils/dataManager';
import { flushBoundMs, textRefusal } from '../../src/bot/internalSetup/utils/storableData';
import { setBackendKind } from '../helpers/backendKind';
import { takeShard } from '../helpers/pgClaims';
import { poolFor, startPostgres } from '../helpers/postgres';

// NB12 item 11 (wip-redesign/sheets/NB12.md): what the server refuses, and the rules keeping it from the flush.

let container: StartedPostgreSqlContainer;
let direct: Pool;
let backend: PostgresBackend;
let ws: WorkingSetManager;
let token: FenceToken;
let guilds = 990_000_000_000_000_000n;
const MIB = 1024 * 1024;

const url = () => {
  const user = encodeURIComponent(container.getUsername());
  const password = encodeURIComponent(container.getPassword());
  return `postgres://${user}:${password}@${container.getHost()}:${container.getPort()}/${container.getDatabase()}`;
};

async function freshGuild(): Promise<string> {
  const guildId = String(++guilds);
  expect(await ws.hydrate(guildId, token)).toBe('ready');
  return guildId;
}

beforeAll(async () => {
  container = await startPostgres();
  direct = poolFor(container);
  backend = new PostgresBackend({ url: url() });
  backend.start();
  const until = Date.now() + 60_000;
  while (backend.connectionState().state !== 'ready' && Date.now() < until) await new Promise(resolve => { setTimeout(resolve, 100); });
  expect(backend.connectionState().state).toBe('ready');
  token = await takeShard(direct, { processId: 'nb12-process', nodeId: 'nb12-node' });
  ws = initWorkingSet(backend);
}, 180_000);

// setup.ts resets the backend kind before each test, so the facade takes the working-set route only when set here.
beforeEach(() => setBackendKind('postgres'));

afterAll(async () => {
  await backend?.stop();
  await direct?.end();
  await container?.stop();
});

interface SentQuery { text: string; bytes: number; ms: number }
type Connect = (cb?: unknown) => Promise<any> | void;

const ownQuery = Symbol('nb12-own-query');

/**
 * Wraps the pool's promise connect (the flush's path) to record each query's text, its size with its values and
 * its time; the callback connect pool.query uses (askDatabase) is passed through untouched. A pooled client is
 * handed out many times, so each hand-out wraps the client's own query once (never a wrapper of a wrapper), and
 * restore gives every touched client its own query back, so no hook outlives its test.
 */
function recordFlushQueries(pool: Pool, hooks: { onBegin?: () => void; beforeCommit?: () => Promise<void>; onEnd?: () => void } = {}): { sent: SentQuery[]; restore: () => void } {
  const target = pool as unknown as { connect: Connect };
  const realConnect = target.connect.bind(pool) as Connect;
  const sent: SentQuery[] = [];
  const touched = new Set<any>();
  target.connect = (cb?: unknown) => {
    if (typeof cb === 'function') return realConnect(cb);
    return (realConnect() as Promise<any>).then(client => {
      const query = (client[ownQuery] ??= client.query) as (...args: any[]) => any;
      touched.add(client);
      client.query = async (sql: any, ...rest: any[]) => {
        const text = typeof sql === 'string' ? sql : String(sql?.text ?? '');
        const values: unknown[] = Array.isArray(rest[0]) ? rest[0] : [];
        const bytes = Buffer.byteLength(text) + values.reduce<number>((n, v) => n + (v === null || v === undefined ? 0 : Buffer.byteLength(String(v))), 0);
        const flushTx = text.startsWith('BEGIN; SET LOCAL statement_timeout');
        if (flushTx) hooks.onBegin?.();
        if (text === 'COMMIT' && hooks.beforeCommit) await hooks.beforeCommit();
        const started = performance.now();
        try {
          return await query.call(client, sql, ...rest);
        } finally {
          sent.push({ text: text.slice(0, 60), bytes, ms: performance.now() - started });
          if (flushTx) client.nb12FlushOpen = true;
          else if ((text === 'COMMIT' || text === 'ROLLBACK') && client.nb12FlushOpen) {
            client.nb12FlushOpen = false;
            hooks.onEnd?.();
          }
        }
      };
      return client;
    });
  };
  return {
    sent,
    restore: () => {
      target.connect = realConnect;
      for (const client of touched) {
        client.query = client[ownQuery];
        delete client.nb12FlushOpen;
      }
    },
  };
}

const codeOf = async (sql: string, params: unknown[]) => {
  try {
    await direct.query(sql, params);
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'none';
  }
};

describe('characterization: what the server keeps and refuses', () => {
  it('U+0000 in a chunk fails 22021, a null doc 23502, a 3000-character filename 54000', async () => {
    expect(await codeOf('INSERT INTO smdb_data.guild_append (guild_id, module, filename, chunk) VALUES ($1, $2, $3, $4)', ['1', 'm', 'a.jsonl', 'a\u0000b'])).toBe('22021');
    expect(await codeOf('INSERT INTO smdb_data.guild_data (guild_id, module, filename, doc) VALUES ($1, $2, $3, $4)', ['1', 'm', 'n.json', null])).toBe('23502');
    const random = Array.from({ length: 3000 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
    expect(await codeOf('INSERT INTO smdb_data.guild_data (guild_id, module, filename, doc) VALUES ($1, $2, $3, $4)', ['1', 'm', random, '{}'])).toBe('54000');
  });

  it('a lone surrogate comes back as U+FFFD; a JSON text holding escapes comes back equal', async () => {
    await direct.query('INSERT INTO smdb_data.guild_append (guild_id, module, filename, chunk) VALUES ($1, $2, $3, $4)', ['2', 'm', 's.jsonl', '\uD800']);
    const back = await direct.query('SELECT chunk FROM smdb_data.guild_append WHERE guild_id = $1', ['2']);
    expect(back.rows[0].chunk).toBe('\uFFFD');
    const text = JSON.stringify({ a: '\u0000\uD800' }, null, 2);
    await direct.query('INSERT INTO smdb_data.guild_data (guild_id, module, filename, doc) VALUES ($1, $2, $3, $4)', ['2', 'm', 'e.json', text]);
    const doc = (await direct.query('SELECT doc FROM smdb_data.guild_data WHERE guild_id = $1', ['2'])).rows[0].doc;
    expect(doc).toBe(text);
    expect(JSON.parse(doc)).toEqual({ a: '\u0000\uD800' });
  });
});

describe('the real backend and working set', () => {
  it('an append holding U+0000 is refused, the guild is not held, and the next append lands', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const guildId = await freshGuild();
    expect(appendDataTracked('log.jsonl', { guildId, category: 'm' }, 'a\u0000\n')).toMatchObject({ outcome: 'refused', cause: 'unstorable' });
    expect(ws.heldGuilds()).toEqual([]);
    expect(appendDataTracked('log.jsonl', { guildId, category: 'm' }, 'ok\n').outcome).toBe('appended');
    expect(await ws.flushGuildNow(guildId, 10_000)).toBe('ok');
    const rows = await direct.query('SELECT chunk FROM smdb_data.guild_append WHERE guild_id = $1 ORDER BY seq', [guildId]);
    expect(rows.rows.map(r => r.chunk).join('')).toBe('ok\n');
  });

  it('a save of undefined leaves the next guild saving, with nothing unhandled', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => { rejections.push(e); };
    process.on('unhandledRejection', onRejection);
    try {
      const a = await freshGuild();
      const b = await freshGuild();
      expect(saveData('a.json', { guildId: a, category: 'm' }, undefined)).toBe(false);
      expect(saveDataTracked('b.json', { guildId: b, category: 'm' }, { v: 1 }).outcome).toBe('saved');
      expect(await ws.flushGuildNow(b, 10_000)).toBe('ok');
      expect(ws.heldGuilds().map(h => h.guildId)).not.toContain(a);
      const row = await direct.query('SELECT doc FROM smdb_data.guild_data WHERE guild_id = $1', [b]);
      expect(JSON.parse(row.rows[0].doc)).toEqual({ v: 1 });
      await new Promise(resolve => setTimeout(resolve, 1000));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('a 201-byte part and the placement pairs are refused', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const guildId = await freshGuild();
    const options = { guildId };
    expect(saveDataTracked(`m/${'a'.repeat(201)}`, options, 1)).toMatchObject({ outcome: 'refused', cause: 'unstorable' });
    expect(saveDataTracked('m/a', options, 1).outcome).toBe('saved');
    expect(saveDataTracked('m/a/x.json', options, 1)).toMatchObject({ outcome: 'refused', cause: 'unstorable' });
    expect(saveDataTracked('w/kir.json', options, 1).outcome).toBe('saved');
    expect(saveDataTracked('w/k\u0131r.json', options, 1)).toMatchObject({ outcome: 'refused', cause: 'unstorable' });
  });

  it('a flush at the acceptance bound commits in statements of about 4 MiB, and the bound ends with it', async () => {
    expect(await ws.flushAllDirty()).toEqual([]);
    const guildId = await freshGuild();
    const options = { guildId, category: 'big' };
    // Acceptance closes once the backlog passes 64 MiB and the write that crosses it is accepted, so the sixteen
    // documents stay just under 64 MiB together and the 4 MiB append is the write that crosses.
    const docs = Array.from({ length: 16 }, (_, i) => `${String(i % 10)}${'x'.repeat(4 * MIB - 4096)}`);
    for (let i = 0; i < 16; i++) expect(saveData(`d${i}.json`, options, docs[i])).toBe(true);
    const line = `${'y'.repeat(4 * MIB - 1)}\n`;
    expect(appendDataTracked('s.jsonl', options, line).outcome).toBe('appended');
    const recorder = recordFlushQueries(backend.getPool());
    try {
      expect(await ws.flushGuildNow(guildId, 120_000)).toBe('ok');
    } finally {
      recorder.restore();
    }
    for (const q of recorder.sent) console.log(`[NB12] ${q.text.split('\n')[0]}: ${q.bytes} B in ${Math.round(q.ms)} ms`);
    expect(recorder.sent.filter(q => q.text.startsWith('BEGIN; SET LOCAL statement_timeout'))).toHaveLength(1);
    expect(recorder.sent.filter(q => q.text === 'COMMIT')).toHaveLength(1);
    for (const q of recorder.sent) {
      expect(q.bytes).toBeLessThanOrEqual(4 * MIB + 4096);
      expect(q.ms).toBeLessThan(3000);
    }
    const stored = await direct.query('SELECT filename, doc FROM smdb_data.guild_data WHERE guild_id = $1 AND module = $2', [guildId, 'big']);
    expect(stored.rows).toHaveLength(16);
    for (const row of stored.rows) expect(row.doc).toBe(JSON.stringify(docs[Number(/^d(\d+)\.json$/.exec(row.filename)![1])], null, 2));
    const joined = await direct.query("SELECT string_agg(chunk, '' ORDER BY seq) AS text FROM smdb_data.guild_append WHERE guild_id = $1", [guildId]);
    expect(joined.rows[0].text).toBe(line);
    const pool = backend.getPool();
    const clients = await Promise.all(Array.from({ length: 3 }, () => pool.connect()));
    try {
      for (const client of clients) expect((await client.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('30s');
    } finally {
      for (const client of clients) client.release();
    }
  }, 300_000);

  it('twelve flushes together never hold more than 8 transactions open, and the database still answers', async () => {
    expect(await ws.flushAllDirty()).toEqual([]);
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push(await freshGuild());
    let open = 0;
    let maxOpen = 0;
    const recorder = recordFlushQueries(backend.getPool(), {
      onBegin: () => { open += 1; maxOpen = Math.max(maxOpen, open); },
      beforeCommit: () => new Promise(resolve => { setTimeout(resolve, 500); }),
      onEnd: () => { open -= 1; },
    });
    try {
      const value = 'z'.repeat(200 * 1024);
      for (const id of ids) expect(saveData('x.json', { guildId: id, category: 'm' }, value)).toBe(true);
      const all = ws.flushAllDirty();
      await new Promise(resolve => { setTimeout(resolve, 100); });
      const asked = performance.now();
      expect(await backend.askDatabase()).toBe('answers');
      expect(performance.now() - asked).toBeLessThan(1000);
      expect(await all).toEqual([]);
      expect(maxOpen).toBeGreaterThan(1);
      expect(maxOpen).toBeLessThanOrEqual(8);
      const rows = await direct.query('SELECT guild_id, doc FROM smdb_data.guild_data WHERE guild_id = ANY($1) AND module = $2', [ids, 'm']);
      expect(rows.rows).toHaveLength(12);
      for (const row of rows.rows) expect(row.doc).toBe(JSON.stringify(value, null, 2));
    } finally {
      recorder.restore();
    }
  }, 120_000);

  it('four guilds of one 4 MiB document each, flushed together, commit with each statement within its bound (a guard)', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(await freshGuild());
    const doc = 'q'.repeat(4 * MIB - 2);
    for (const id of ids) expect(saveData('big.json', { guildId: id, category: 'm' }, doc)).toBe(true);
    const recorder = recordFlushQueries(backend.getPool());
    try {
      expect(await ws.flushAllDirty()).toEqual([]);
    } finally {
      recorder.restore();
    }
    const largest = Math.max(...recorder.sent.map(q => q.bytes));
    expect(largest).toBeGreaterThan(4 * MIB);
    for (const q of recorder.sent) expect(q.ms).toBeLessThan(flushBoundMs(largest));
    const rows = await direct.query('SELECT doc FROM smdb_data.guild_data WHERE guild_id = ANY($1) AND module = $2', [ids, 'm']);
    expect(rows.rows).toHaveLength(4);
    for (const row of rows.rows) expect(row.doc).toBe(JSON.stringify(doc, null, 2));
  }, 300_000);
});

describe('characterization: the statement timer while a Bind arrives over a slow link', () => {
  function slowProxy(rateBytesPerS: number): Promise<{ port: number; forwarded: () => number; close: () => void }> {
    let forwarded = 0;
    const sockets: net.Socket[] = [];
    const server = net.createServer(client => {
      const upstream = net.connect(container.getPort(), container.getHost());
      sockets.push(client, upstream);
      upstream.pipe(client);
      const queue: Buffer[] = [];
      client.on('data', chunk => { queue.push(chunk); });
      const perTick = Math.max(1, Math.floor(rateBytesPerS / 10));
      const timer = setInterval(() => {
        let budget = perTick;
        while (budget > 0 && queue.length > 0) {
          const head = queue[0];
          const part = head.subarray(0, budget);
          upstream.write(part);
          forwarded += part.length;
          budget -= part.length;
          if (part.length === head.length) queue.shift();
          else queue[0] = head.subarray(part.length);
        }
      }, 100);
      const end = () => { clearInterval(timer); upstream.destroy(); client.destroy(); };
      client.on('close', end);
      upstream.on('close', end);
      client.on('error', end);
      upstream.on('error', end);
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
      port: (server.address() as net.AddressInfo).port,
      forwarded: () => forwarded,
      close: () => { for (const s of sockets) s.destroy(); server.close(); },
    })));
  }

  async function insertThrough(timeoutMs: number): Promise<{ code: string | null; forwardedAtAnswer: number; sentBytes: number }> {
    const proxy = await slowProxy(64 * 1024);
    const client = new Client({
      host: '127.0.0.1', port: proxy.port, user: container.getUsername(), password: container.getPassword(), database: container.getDatabase(),
    });
    try {
      await client.connect();
      await client.query(`SET statement_timeout = ${timeoutMs}`);
      await client.query('CREATE TEMP TABLE nb12_slow (t text)');
      const value = 'v'.repeat(192 * 1024);
      const before = proxy.forwarded();
      let code: string | null = null;
      try {
        await client.query('INSERT INTO nb12_slow (t) VALUES ($1)', [value]);
      } catch (error) {
        code = (error as { code?: string }).code ?? 'none';
      }
      return { code, forwardedAtAnswer: proxy.forwarded() - before, sentBytes: value.length };
    } finally {
      await client.end().catch(() => undefined);
      proxy.close();
    }
  }

  it('a 1 s bound on a 3 s upload: 57014 only after the whole Bind arrived (or, if the server drops it, the insert commits)', async () => {
    const short = await insertThrough(1000);
    if (short.code === null) console.warn('[NB12] The server dropped a statement timeout that fired while the Bind arrived; record this in the build notes');
    else {
      expect(short.code).toBe('57014');
      expect(short.forwardedAtAnswer).toBeGreaterThanOrEqual(short.sentBytes);
    }
    const long = await insertThrough(5000);
    expect(long.code).toBeNull();
  }, 60_000);
});

describe('property: lines over every UTF-16 code unit', () => {
  it('each line is refused exactly when the rule names a reason, and an accepted line is stored as it was', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await fc.assert(fc.asyncProperty(fc.string({ unit: 'binary', maxLength: 40 }), async text => {
      const guildId = await freshGuild();
      const line = `${text}\n`;
      const answer = appendDataTracked('p.jsonl', { guildId, category: 'm' }, line);
      expect(answer.outcome === 'refused').toBe(textRefusal(line) !== null);
      if (answer.outcome !== 'appended') return;
      expect(await ws.flushGuildNow(guildId, 10_000)).toBe('ok');
      const rows = await direct.query("SELECT string_agg(chunk, '' ORDER BY seq) AS text FROM smdb_data.guild_append WHERE guild_id = $1", [guildId]);
      expect(rows.rows[0].text).toBe(line);
    }), { numRuns: 50 });
  }, 300_000);
});
