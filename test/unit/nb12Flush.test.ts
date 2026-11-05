import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FenceToken, GuildFlushBatch } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { WorkingSetManager } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import { type Answer, bytesOf, scriptedBackend } from '../helpers/scriptedPg';

// NB12 item 9 (wip-redesign/sheets/NB12.md, decision 6): the flush sends statements of at most 4 MiB, splits an append
// buffer into rows, rides its time bound on BEGIN, waits in a gate of 8, and logs a 57014 by when it came.

const MIB = 1024 * 1024;
const token: FenceToken = { nodeId: 'node-a', claim: 3, processId: 'process-a', shardId: 0, shardCount: 1 };
const backends: PostgresBackend[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const backend of backends.splice(0)) await backend.stop();
});

function scripted(answer?: Answer) {
  const rigged = scriptedBackend(answer);
  backends.push(rigged.backend);
  return rigged;
}

const quiet = () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  return vi.spyOn(console, 'error').mockImplementation(() => {});
};

const docs = (count: number, size: number): GuildFlushBatch['upserts'] =>
  Array.from({ length: count }, (_, i) => ({ key: { module: 'm', filename: `d${i}.json` }, doc: 'x'.repeat(size) }));

describe('the statements of a flush', () => {
  it('packs upserts at most 200 rows and 4 MiB of text, a larger row alone', async () => {
    quiet();
    const { backend, sent } = scripted();
    expect(await backend.flushGuild('1', { upserts: docs(300, MIB), deletes: [], appends: [] }, token)).toEqual({ ok: true });
    const upserts = sent.filter(s => s.sql.startsWith('INSERT INTO smdb_data.guild_data'));
    expect(upserts.length).toBeGreaterThanOrEqual(75);
    for (const st of upserts) {
      expect((st.params!.length - 1) / 3).toBeLessThanOrEqual(200);
      expect(bytesOf(st)).toBeLessThanOrEqual(4 * MIB + 2048);
    }
    expect(upserts.reduce((n, st) => n + (st.params!.length - 1) / 3, 0)).toBe(300);
  });

  it('sends an append buffer as rows of at most 4 MiB, in order, cut between code points', async () => {
    quiet();
    const { backend, sent } = scripted();
    const pair = '\uD83D\uDE00';
    // The fill is 4-byte characters, so the split walks a quarter as many code points. The marker pairs span bytes
    // 4 MiB-2 to 4 MiB+2 and 8 MiB-3 to 8 MiB+1, so each crosses a cut the flush makes.
    const chunk = `aa${'\uD83D\uDE01'.repeat(MIB - 1)}${pair}${'\uD83D\uDE02'.repeat(MIB - 2)}bbb${pair}${'\uD83D\uDE03'.repeat(MIB / 2)}`;
    expect(await backend.flushGuild('1', { upserts: [], deletes: [], appends: [{ key: { module: 'm', filename: 'l.jsonl' }, chunk }] }, token)).toEqual({ ok: true });
    const rows = sent.filter(s => s.sql.startsWith('INSERT INTO smdb_data.guild_append')).map(s => String(s.params![3]));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(Buffer.byteLength(row)).toBeLessThanOrEqual(4 * MIB);
      expect(row.isWellFormed()).toBe(true);
    }
    expect(Buffer.byteLength(rows[0])).toBeGreaterThanOrEqual(4 * MIB - 3);
    expect(Buffer.byteLength(rows[1])).toBeGreaterThanOrEqual(4 * MIB - 3);
    expect(rows[1].startsWith(pair)).toBe(true);
    expect(rows[2].startsWith(pair)).toBe(true);
    expect(rows.join('')).toBe(chunk);
  });

  it('a failure on the third statement rolls back and answers unavailable', async () => {
    quiet();
    const { backend, sent } = scripted((sql, _p, call) => (call === 4 ? Object.assign(new Error('boom'), { code: '08006' }) : undefined));
    const answer = await backend.flushGuild('1', { upserts: docs(300, 32 * 1024), deletes: [], appends: [] }, token);
    expect(answer).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(sent.some(s => s.sql === 'ROLLBACK')).toBe(true);
    expect(sent.some(s => s.sql === 'COMMIT')).toBe(false);
  });
});

describe('the time bound', () => {
  it.each([
    ['a 4 MiB document', { upserts: docs(1, 4 * MIB - 100), deletes: [], appends: [] }, 671_000],
    ['ten 1 KiB documents and a 100 KiB append', { upserts: docs(10, 1024), deletes: [], appends: [{ key: { module: 'm', filename: 'l.jsonl' }, chunk: 'z'.repeat(100 * 1024) }] }, 46_000],
    ['one 1 KiB document', { upserts: docs(1, 1024), deletes: [], appends: [] }, 31_000],
  ] as Array<[string, GuildFlushBatch, number]>)('%s: BEGIN carries SET LOCAL statement_timeout = %i', async (_label, batch, ms) => {
    quiet();
    const { backend, sent } = scripted();
    await backend.flushGuild('1', batch, token);
    expect(sent[0].sql).toBe(`BEGIN; SET LOCAL statement_timeout = ${ms}`);
    expect(sent.slice(1).some(s => /\bSET\b/.test(s.sql) && !/DO UPDATE SET|SET doc|SET node_id|UPDATE smdb_data/.test(s.sql))).toBe(false);
  });
});

describe('the 57014 log', () => {
  const timeout = () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });

  function clocked(failAt: (sql: string) => boolean, afterMs: number) {
    let now = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    return scripted(sql => {
      if (!failAt(sql)) return undefined;
      now += afterMs;
      return timeout();
    });
  }

  it('a 57014 at the bound logs the bound line with the statement size', async () => {
    const error = quiet();
    const { backend } = clocked(sql => sql.startsWith('INSERT INTO smdb_data.guild_data'), 671_000);
    expect(await backend.flushGuild('7', { upserts: docs(1, 4 * MIB - 100), deletes: [], appends: [] }, token)).toMatchObject({ ok: false, reason: 'unavailable' });
    const line = error.mock.calls.map(c => String(c[0])).find(l => l.includes('SQLSTATE 57014'));
    expect(line).toContain("flushGuild for 7: a statement of 4097 KiB did not finish within the flush's 671 s bound (SQLSTATE 57014)");
  });

  it('a 57014 before the bound is a cancel, not a missed bound', async () => {
    const error = quiet();
    const { backend } = clocked(sql => sql.startsWith('INSERT INTO smdb_data.guild_data'), 2_000);
    expect(await backend.flushGuild('7', { upserts: docs(1, 4 * MIB - 100), deletes: [], appends: [] }, token)).toMatchObject({ ok: false, reason: 'unavailable' });
    const line = error.mock.calls.map(c => String(c[0])).find(l => l.includes('SQLSTATE 57014'))!;
    expect(line).toContain("a statement of 4097 KiB was cancelled after 2 s, before the flush's 671 s bound (SQLSTATE 57014)");
    expect(line).not.toContain('did not finish within');
  });

  it('a 57014 on the fenced claim at the bound names a lock held by another transaction', async () => {
    const error = quiet();
    let now = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const backend = new PostgresBackend({ url: 'postgres://nobody@127.0.0.1:9/none' });
    backends.push(backend);
    (backend as unknown as { state: string }).state = 'ready';
    (backend.getPool() as unknown as { connect: unknown }).connect = async () => ({
      query: async (sql: string) => {
        if (/INSERT INTO smdb_data\.guild_ownership AS o\b/.test(sql)) { now += 671_000; throw timeout(); }
        return { rows: [], rowCount: 0 };
      },
      release: () => {},
    });
    await backend.flushGuild('7', { upserts: docs(1, 4 * MIB - 100), deletes: [], appends: [] }, token);
    const line = error.mock.calls.map(c => String(c[0])).find(l => l.includes('SQLSTATE 57014'))!;
    expect(line).toContain("did not finish within the flush's 671 s bound");
    expect(line).toContain('a lock held by another transaction');
  });

  it("a connection reset keeps today's line", async () => {
    const error = quiet();
    const { backend } = scripted(sql => (sql.startsWith('INSERT') ? Object.assign(new Error('reset'), { code: 'ECONNRESET' }) : undefined));
    await backend.flushGuild('7', { upserts: docs(1, 10), deletes: [], appends: [] }, token);
    expect(error.mock.calls.some(c => String(c[0]) === '[PostgresBackend] flushGuild failed for 7 (caller retries):')).toBe(true);
  });
});

describe('the flush gate', () => {
  it('twelve flushes never hold more than 8 clients, and start in the order called', async () => {
    quiet();
    const gates: Array<() => void> = [];
    const { backend, sent, maxOut } = scripted(sql => (sql === 'COMMIT' ? new Promise(resolve => { gates.push(() => resolve(undefined)); }) : undefined));
    const flushes = Array.from({ length: 12 }, (_, i) => backend.flushGuild(String(i + 1), { upserts: docs(1, 10), deletes: [], appends: [] }, token));
    await vi.waitFor(() => expect(gates).toHaveLength(8));
    expect(sent.filter(s => s.sql.startsWith('BEGIN'))).toHaveLength(8);
    gates.shift()!();
    await vi.waitFor(() => expect(sent.filter(s => s.sql.startsWith('BEGIN'))).toHaveLength(9));
    while (gates.length > 0 || sent.filter(s => s.sql === 'COMMIT').length < 12) {
      await new Promise(resolve => setTimeout(resolve, 1));
      gates.shift()?.();
    }
    expect((await Promise.all(flushes)).every(f => f.ok)).toBe(true);
    expect(maxOut()).toBe(8);
    const order = sent.filter(s => /INSERT INTO smdb_data\.guild_ownership AS o\b/.test(s.sql)).map(s => String(s.params?.[0]));
    expect(order).toEqual(Array.from({ length: 12 }, (_, i) => String(i + 1)));
  });

  it('a failed connect, a deposed answer and a thrown statement each give the place back', async () => {
    quiet();
    const backend = new PostgresBackend({ url: 'postgres://nobody@127.0.0.1:9/none' });
    backends.push(backend);
    (backend as unknown as { state: string }).state = 'ready';
    let mode: 'connect' | 'deposed' | 'throw' = 'connect';
    (backend.getPool() as unknown as { connect: unknown }).connect = async () => {
      if (mode === 'connect') throw new Error('connect ECONNREFUSED');
      return {
        query: async (sql: string) => {
          if (mode === 'throw' && sql.startsWith('INSERT')) throw new Error('boom');
          if (mode === 'deposed') return { rows: [], rowCount: 0 };
          return /INSERT INTO smdb_data\.guild_ownership AS o\b/.test(sql) ? { rows: [], rowCount: 1 } : { rows: [], rowCount: 0 };
        },
        release: () => {},
      };
    };
    for (const m of ['connect', 'deposed', 'throw'] as const) {
      mode = m;
      await Promise.all(Array.from({ length: 10 }, () => backend.flushGuild('1', { upserts: docs(1, 10), deletes: [], appends: [] }, token)));
    }
    expect((backend as unknown as { flushesOnWire: number }).flushesOnWire).toBe(0);
  });
});

/** The pool's other users (askDatabase, pool.query) take a client from the same 10 the flushes take. */
function poolQueriesThroughClients(rigged: ReturnType<typeof scripted>) {
  const pool = rigged.backend.getPool() as unknown as { query: unknown; connect: () => Promise<{ query: (sql: string, params?: unknown[]) => Promise<unknown>; release: () => void }> };
  const connect = pool.connect;
  pool.connect = async () => {
    if (rigged.out() >= 10) throw new Error('timeout exceeded when trying to connect');
    return connect();
  };
  pool.query = async (sql: unknown, params?: unknown[]) => {
    const client = await pool.connect();
    try {
      return await client.query(typeof sql === 'string' ? sql : String((sql as { text?: unknown }).text), params);
    } finally {
      client.release();
    }
  };
}

describe('the flush gate beside the pool', () => {
  const poolOfTen = poolQueriesThroughClients;

  it('askDatabase answers while twelve flushes hold their COMMITs', async () => {
    quiet();
    const gates: Array<() => void> = [];
    const rigged = scripted(sql => (sql === 'COMMIT' ? new Promise(resolve => { gates.push(() => resolve(undefined)); }) : undefined));
    poolOfTen(rigged);
    const flushes = Array.from({ length: 12 }, (_, i) => rigged.backend.flushGuild(String(i + 1), { upserts: docs(1, 10), deletes: [], appends: [] }, token));
    await vi.waitFor(() => expect(gates).toHaveLength(8));
    expect(await rigged.backend.askDatabase()).toBe('answers');
    while (gates.length > 0 || rigged.sent.filter(s => s.sql === 'COMMIT').length < 12) {
      gates.shift()?.();
      await new Promise(resolve => setTimeout(resolve, 1));
      if (gates.length > 0) expect(await rigged.backend.askDatabase()).toBe('answers');
    }
    expect((await Promise.all(flushes)).every(f => f.ok)).toBe(true);
    expect(rigged.maxOut()).toBeLessThanOrEqual(9);
  });

  it('four flushes of 1 MiB started together send four BEGINs before the first COMMIT', async () => {
    quiet();
    const { backend, sent } = scripted();
    await Promise.all(Array.from({ length: 4 }, (_, i) => backend.flushGuild(String(i + 1), { upserts: docs(1, MIB), deletes: [], appends: [] }, token)));
    const firstCommit = sent.findIndex(s => s.sql === 'COMMIT');
    expect(sent.slice(0, firstCommit).filter(s => s.sql.startsWith('BEGIN'))).toHaveLength(4);
  });

  it('a 1 KiB flush started while a 1 MiB flush is on the wire commits before it', async () => {
    quiet();
    let releaseBig: (() => void) | null = null;
    let bigInserted = false;
    const { backend, sent } = scripted((sql, params) => {
      if (sql.startsWith('INSERT INTO smdb_data.guild_data') && params?.[0] === 'big') bigInserted = true;
      else if (sql === 'COMMIT' && bigInserted && releaseBig === null) return new Promise(resolve => { releaseBig = () => resolve(undefined); });
      return undefined;
    });
    const big = backend.flushGuild('big', { upserts: docs(1, MIB), deletes: [], appends: [] }, token);
    await vi.waitFor(() => expect(releaseBig).not.toBeNull());
    expect(await backend.flushGuild('small', { upserts: docs(1, 1024), deletes: [], appends: [] }, token)).toEqual({ ok: true });
    expect(sent.filter(s => s.sql === 'COMMIT')).toHaveLength(2);
    releaseBig!();
    expect(await big).toEqual({ ok: true });
    const order = sent.filter(s => s.sql.startsWith('BEGIN') || s.sql === 'COMMIT').map(s => s.sql.slice(0, 5));
    expect(order).toEqual(['BEGIN', 'COMMI', 'BEGIN', 'COMMI']);
  });

  it("the working set's retry loop over the real backend keeps clients free, lists the waiting guilds as held, and the database answers", async () => {
    quiet();
    vi.useFakeTimers();
    let failing = true;
    const gates: Array<() => void> = [];
    const rigged = scripted(sql => {
      if (failing && sql.startsWith('INSERT')) return Object.assign(new Error('reset'), { code: 'ECONNRESET' });
      if (sql === 'COMMIT' && !failing) return new Promise(resolve => { gates.push(() => resolve(undefined)); });
      return undefined;
    });
    poolOfTen(rigged);
    const ws = new WorkingSetManager(rigged.backend);
    const ids = Array.from({ length: 12 }, (_, i) => String(9_800_000_000 + i));
    for (const id of ids) {
      const hydrated = ws.hydrate(id, token);
      await vi.advanceTimersByTimeAsync(10);
      expect(await hydrated).toBe('ready');
      expect(ws.save(id, 'm', 'x.json', '1')).toBe('accepted');
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(ws.heldGuilds().map(h => h.guildId).sort()).toEqual(ids);
    failing = false;
    let maxOut = 0;
    let released = 0;
    for (let t = 0; t < 240 && ws.dirtyGuildIds().length > 0; t++) {
      await vi.advanceTimersByTimeAsync(500);
      maxOut = Math.max(maxOut, rigged.out());
      if (gates.length > 0) {
        expect(rigged.out()).toBeLessThanOrEqual(8);
        // Every guild whose COMMIT has not been answered, on the wire or still waiting its turn, is listed held.
        expect(ws.heldGuilds()).toHaveLength(ids.length - released);
        expect(await rigged.backend.askDatabase()).toBe('answers');
        while (gates.length > 0) {
          gates.shift()!();
          released += 1;
        }
      }
    }
    expect(released).toBe(ids.length);
    expect(ws.dirtyGuildIds()).toEqual([]);
    expect(maxOut).toBeLessThanOrEqual(8);
    for (const id of ids) ws.evict(id);
  }, 30_000);
});

describe('a flush of many append buffers', () => {
  it('150,000 one-line buffers: the flush answers and nothing escapes', async () => {
    quiet();
    const { backend, sent } = scripted();
    const appends = Array.from({ length: 150_000 }, (_, i) => ({ key: { module: 'm', filename: `l${i}.jsonl` }, chunk: 'x\n' }));
    expect(await backend.flushGuild('1', { upserts: [], deletes: [], appends }, token)).toEqual({ ok: true });
    expect(sent.filter(s => s.sql.startsWith('INSERT INTO smdb_data.guild_append'))).toHaveLength(150_000);
  }, 60_000);
});

describe('no client-side bound', () => {
  it('a COMMIT that answers after 45 s is waited for, the append is sent once, and the next flush stores the line once', async () => {
    quiet();
    vi.useFakeTimers();
    let slowCommit = false;
    const rigged = scripted(sql => (sql === 'COMMIT' && slowCommit ? new Promise(resolve => { setTimeout(() => resolve(undefined), 45_000); }) : undefined));
    expect((rigged.backend.getPool() as unknown as { options: Record<string, unknown> }).options.query_timeout).toBeUndefined();
    poolQueriesThroughClients(rigged);
    const ws = new WorkingSetManager(rigged.backend);
    const hydrated = ws.hydrate('1', token);
    await vi.advanceTimersByTimeAsync(10);
    expect(await hydrated).toBe('ready');
    slowCommit = true;
    const line = `${'x'.repeat(1023)}\n`;
    expect(ws.append('1', 'm', 'log.jsonl', line)).toBe('accepted');
    const settled = async <T>(p: Promise<T>): Promise<T> => {
      let done = false;
      void p.then(() => { done = true; }, () => { done = true; });
      for (let t = 0; t < 300 && !done; t++) await vi.advanceTimersByTimeAsync(1000);
      expect(done).toBe(true);
      return p;
    };
    const commits = () => rigged.sent.filter(s => s.sql === 'COMMIT').length;
    expect(await settled(ws.flushGuildNow('1', 120_000))).toBe('ok');
    expect(commits()).toBe(2);
    slowCommit = false;
    expect(ws.save('1', 'm', 'after.json', '1')).toBe('accepted');
    expect(await settled(ws.flushGuildNow('1', 10_000))).toBe('ok');
    const appended = rigged.sent.filter(s => s.sql.startsWith('INSERT INTO smdb_data.guild_append'));
    expect(appended).toHaveLength(1);
    expect(appended[0].params?.[3]).toBe(line);
    for (const s of rigged.sent) {
      expect(typeof s.raw === 'string' || !('query_timeout' in (s.raw as object))).toBe(true);
    }
    ws.evict('1');
  });
});
