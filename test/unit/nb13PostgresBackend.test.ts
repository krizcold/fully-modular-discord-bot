import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FenceToken, GuildFlushBatch } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';

// NB13 decisions 3 and 4 at the backend: COMMIT under a client bound, the mark in the fence, and the check of a flush
// whose COMMIT got no answer. The scripted client keeps node-pg's query_timeout: an unanswered statement sent with one
// rejects when it passes.

const backends: PostgresBackend[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const b of backends.splice(0)) await b.stop();
});

const BOUND = 40_000;
const token: FenceToken = { nodeId: 'node-a', claim: 7, processId: 'p-a', shardId: 2, shardCount: 4 };
const FLUSH_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

function batchOf(): GuildFlushBatch {
  return {
    upserts: [{ key: { module: 'm', filename: 'a.json' }, doc: '{}' }],
    deletes: [],
    appends: [{ key: { module: 'm', filename: 'l.jsonl' }, chunk: 'x\n' }],
    flushId: FLUSH_ID,
  };
}

type Answer = unknown | Error | 'never';
interface Sent { sql: string; params?: unknown[]; timeout?: number; commitSentThen?: boolean }

function scripted(answer: (sql: string, params?: unknown[]) => Answer, batch?: GuildFlushBatch) {
  const backend = new PostgresBackend({ url: 'postgres://nobody@127.0.0.1:9/none' });
  backends.push(backend);
  (backend as unknown as { state: string }).state = 'ready';
  const sent: Sent[] = [];
  const releases: Array<boolean | undefined> = [];
  const client = {
    query: (q: string | { text: string; values?: unknown[]; query_timeout?: number }, params?: unknown[]) => {
      const sql = (typeof q === 'string' ? q : q.text).trim();
      const values = params ?? (typeof q === 'string' ? undefined : q.values);
      const timeout = typeof q === 'string' ? undefined : q.query_timeout;
      sent.push({ sql, params: values, timeout, commitSentThen: batch?.commitSent });
      const res = answer(sql, values);
      if (res === 'never') {
        return new Promise((_resolve, reject) => {
          if (timeout) setTimeout(() => reject(new Error('Query read timeout')), timeout);
        });
      }
      if (res instanceof Error) return Promise.reject(res);
      return Promise.resolve(res ?? { rows: [], rowCount: 0 });
    },
    release: (destroy?: boolean) => { releases.push(destroy); },
  };
  const connect = vi.fn(async () => client);
  (backend.getPool() as unknown as { connect: unknown }).connect = connect;
  return { backend, sent, releases, connect };
}

const fenced = (sql: string) => /INSERT INTO smdb_data\.guild_ownership AS o/.test(sql) ? { rows: [], rowCount: 1 } : undefined;
const failure = (code: string | undefined, severity?: string) =>
  Object.assign(new Error('connection ended'), code ? { code } : {}, severity ? { severity } : {});

describe('2.1 a COMMIT without an answer', () => {
  it.each([
    ['no code', failure(undefined)],
    ['57P01 at FATAL', failure('57P01', 'FATAL')],
    ['57P01 with a localized severity', failure('57P01', 'ВАЖНО')],
    ['08006 at ERROR', failure('08006', 'ERROR')],
    ['XX000 at ERROR', failure('XX000', 'ERROR')],
  ])('COMMIT failing with %s carries commitUnanswered, destroys the client and sends no ROLLBACK', async (_name, error) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const batch = batchOf();
    const { backend, sent, releases } = scripted(sql => sql === 'COMMIT' ? error : fenced(sql), batch);
    const outcome = await backend.flushGuild('g1', batch, token);
    expect(outcome).toMatchObject({ ok: false, reason: 'unavailable', commitUnanswered: true });
    expect(releases).toEqual([true]);
    expect(sent.filter(s => s.sql === 'ROLLBACK')).toHaveLength(0);
  });

  it('COMMIT answered 23505 at ERROR is plain unavailable with its code', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const batch = batchOf();
    const { backend, sent } = scripted(sql => sql === 'COMMIT' ? failure('23505', 'ERROR') : fenced(sql), batch);
    const outcome = await backend.flushGuild('g1', batch, token);
    expect(outcome).toMatchObject({ ok: false, reason: 'unavailable', code: '23505' });
    expect(outcome).not.toHaveProperty('commitUnanswered');
    expect(sent.filter(s => s.sql === 'ROLLBACK')).toHaveLength(1);
  });

  it('COMMIT answered 40001 at ERROR is plain unavailable with its code, and one ROLLBACK is sent', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const batch = batchOf();
    const { backend, sent } = scripted(sql => sql === 'COMMIT' ? failure('40001', 'ERROR') : fenced(sql), batch);
    const outcome = await backend.flushGuild('g1', batch, token);
    expect(outcome).toMatchObject({ ok: false, reason: 'unavailable', code: '40001' });
    expect(outcome).not.toHaveProperty('commitUnanswered');
    expect(sent.filter(s => s.sql === 'ROLLBACK')).toHaveLength(1);
  });

  it.each([
    ['the fence', /INSERT INTO smdb_data\.guild_ownership AS o/],
    ['an upsert', /INSERT INTO smdb_data\.guild_data/],
    ['an append insert', /INSERT INTO smdb_data\.guild_append/],
  ])('a throw at %s carries no commitUnanswered and sends one ROLLBACK', async (_name, at) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const batch = batchOf();
    const { backend, sent } = scripted(sql => at.test(sql) ? failure(undefined) : fenced(sql), batch);
    const outcome = await backend.flushGuild('g1', batch, token);
    expect(outcome).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(outcome).not.toHaveProperty('commitUnanswered');
    expect(sent.filter(s => s.sql === 'ROLLBACK')).toHaveLength(1);
  });
});

describe('2.2 a COMMIT that never answers', () => {
  it('answers commitUnanswered after the bound, destroys the client and queues no ROLLBACK', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const batch = batchOf();
    const { backend, sent, releases } = scripted(sql => sql === 'COMMIT' ? 'never' : fenced(sql), batch);
    let outcome: unknown;
    void backend.flushGuild('g1', batch, token).then(o => { outcome = o; });
    await vi.advanceTimersByTimeAsync(BOUND - 1);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toMatchObject({ ok: false, reason: 'unavailable', commitUnanswered: true });
    expect(sent.find(s => s.sql === 'COMMIT')?.timeout).toBe(BOUND);
    expect(releases).toEqual([true]);
    expect(sent.filter(s => s.sql === 'ROLLBACK')).toHaveLength(0);
  });
});

describe('2.3 the mark rides in the fence', () => {
  it('the one fence statement of a flush sets last_flush from $7, bound to the flush id', async () => {
    const batch = batchOf();
    const { backend, sent } = scripted(fenced, batch);
    expect(await backend.flushGuild('g1', batch, token)).toEqual({ ok: true });
    const stamps = sent.filter(s => /guild_ownership/.test(s.sql));
    expect(stamps).toHaveLength(1);
    expect(stamps[0].sql).toContain('last_flush = EXCLUDED.last_flush');
    expect(stamps[0].sql).toContain('$7');
    expect(stamps[0].params).toEqual(['g1', 'node-a', 2, 7, 4, 'p-a', FLUSH_ID]);
  });

  it('hydrate and retire never write the mark', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const call of [(b: PostgresBackend) => b.hydrateGuild('g1', token), (b: PostgresBackend) => b.retireGuild('g1', 'test', token)]) {
      const { backend, sent } = scripted(fenced);
      await call(backend);
      for (const s of sent) expect(s.sql).not.toContain('last_flush');
    }
  });

  it('commitSent is false while the statements before COMMIT run and true when COMMIT is issued', async () => {
    const batch = batchOf();
    const { backend, sent } = scripted(fenced, batch);
    await backend.flushGuild('g1', batch, token);
    for (const s of sent.filter(x => x.sql !== 'COMMIT')) expect(s.commitSentThen ?? false).toBe(false);
    expect(sent.find(s => s.sql === 'COMMIT')?.commitSentThen).toBe(true);
  });

  it('a throw at an upsert leaves commitSent false', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const batch = batchOf();
    const { backend } = scripted(sql => /INSERT INTO smdb_data\.guild_data/.test(sql) ? failure(undefined) : fenced(sql), batch);
    await backend.flushGuild('g1', batch, token);
    expect(batch.commitSent ?? false).toBe(false);
  });
});

const readSql = /^SELECT claim, last_flush\b[\s\S]*FROM smdb_data\.guild_ownership WHERE guild_id = \$1 FOR SHARE$/;
const row = (claim: number, mark: string | null) => ({ rows: [{ claim: String(claim), last_flush: mark }], rowCount: 1 });
const reading = (...answers: unknown[]) => {
  let n = 0;
  return (sql: string) => readSql.test(sql) ? answers[Math.min(n++, answers.length - 1)] : undefined;
};

describe('2.4 resolveFlush', () => {
  it('reads the row FOR SHARE and answers landed when the mark is the flush id', async () => {
    const { backend, sent } = scripted(reading(row(7, FLUSH_ID)));
    expect(await backend.resolveFlush('g1', FLUSH_ID, 7, token)).toEqual({ fate: 'landed' });
    expect(sent.some(s => readSql.test(s.sql))).toBe(true);
  });

  it('answers not-landed for another mark under the sent claim', async () => {
    const { backend } = scripted(reading(row(7, OTHER_ID)));
    expect(await backend.resolveFlush('g1', FLUSH_ID, 7, token)).toEqual({ fate: 'not-landed' });
  });

  it('answers not-landed with no log line for a claim below the sent one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { backend } = scripted(reading(row(5, OTHER_ID)));
    expect(await backend.resolveFlush('g1', FLUSH_ID, 7, token)).toEqual({ fate: 'not-landed' });
    expect([...warn.mock.calls, ...error.mock.calls]).toEqual([]);
  });

  it('answers deposed with landed null above the token claim, true when the mark is equal, and fires the deposed alert', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { backend } = scripted(reading(row(9, OTHER_ID)));
    const alerts: string[] = [];
    backend.onAlert(event => { alerts.push(event); });
    expect(await backend.resolveFlush('g1', FLUSH_ID, 7, token)).toMatchObject({ fate: 'deposed', landed: null });
    const second = scripted(reading(row(9, FLUSH_ID))).backend;
    expect(await second.resolveFlush('g1', FLUSH_ID, 7, token)).toMatchObject({ fate: 'deposed', landed: true });
    expect(alerts).toEqual(['deposed']);
  });

  it("answers not-landed with the can't-confirm line for a claim above the sent one and not above the token's", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { backend } = scripted(reading(row(6, OTHER_ID)));
    expect(await backend.resolveFlush('g1', FLUSH_ID, 5, token)).toEqual({ fate: 'not-landed' });
    expect(warn.mock.calls.map(c => String(c[0]))).toContain(
      "[Data] Guild g1: a save sent under claim 5 got no answer, and the guild's ownership row now holds claim 6; can't confirm whether it landed, so it is sent again, and lines it appended may be stored twice");
  });

  it('answers not-landed when no row exists and the insert adds one', async () => {
    const { backend } = scripted(sql => readSql.test(sql) ? { rows: [], rowCount: 0 } : /^INSERT INTO smdb_data\.guild_ownership/.test(sql) ? { rows: [], rowCount: 1 } : undefined);
    expect(await backend.resolveFlush('g1', FLUSH_ID, 7, token)).toEqual({ fate: 'not-landed' });
  });

  it('reads again when no row exists and the insert conflicts', async () => {
    const { backend, sent } = scripted(sql => readSql.test(sql)
      ? (sent.filter(s => readSql.test(s.sql)).length === 1 ? { rows: [], rowCount: 0 } : row(7, FLUSH_ID))
      : undefined);
    expect(await backend.resolveFlush('g1', FLUSH_ID, 7, token)).toEqual({ fate: 'landed' });
    expect(sent.filter(s => readSql.test(s.sql))).toHaveLength(2);
  });

  it('a query error answers unknown with its detail and enters outage', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { backend } = scripted(sql => readSql.test(sql) ? Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }) : undefined);
    expect(await backend.resolveFlush('g1', FLUSH_ID, 7, token)).toEqual({
      fate: 'unknown', detail: 'SQLSTATE 57014: canceling statement due to statement timeout', code: '57014',
    });
    expect(backend.connectionState().state).toBe('outage');
  });
});

describe('2.5 every statement of the check carries the client bound', () => {
  it('BEGIN, the read, the insert, the second read and ROLLBACK are sent with query_timeout 40000', async () => {
    const { backend, sent } = scripted(sql => readSql.test(sql)
      ? (sent.filter(s => readSql.test(s.sql)).length === 1 ? { rows: [], rowCount: 0 } : row(7, OTHER_ID))
      : undefined);
    await backend.resolveFlush('g1', FLUSH_ID, 7, token);
    await new Promise(resolve => setImmediate(resolve));
    expect(sent.map(s => s.sql.split(/\s+/)[0])).toEqual(['BEGIN', 'SELECT', 'INSERT', 'SELECT', 'ROLLBACK']);
    for (const s of sent) expect(s.timeout).toBe(BOUND);
  });
});

describe('2.6 and 2.7 the bound ends the check', () => {
  it('a read that never answers gives unknown after the bound and destroys the client', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { backend, releases } = scripted(sql => readSql.test(sql) ? 'never' : undefined);
    let fate: unknown;
    void backend.resolveFlush('g1', FLUSH_ID, 7, token).then(f => { fate = f; });
    await vi.advanceTimersByTimeAsync(BOUND - 1);
    expect(fate).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(fate).toMatchObject({ fate: 'unknown' });
    expect(releases).toEqual([true]);
  });

  it('a ROLLBACK that never answers does not hold the answer, and the client is destroyed at the bound', async () => {
    vi.useFakeTimers();
    const { backend, releases } = scripted(sql => readSql.test(sql) ? row(7, FLUSH_ID) : sql === 'ROLLBACK' ? 'never' : undefined);
    let fate: unknown;
    void backend.resolveFlush('g1', FLUSH_ID, 7, token).then(f => { fate = f; });
    await vi.advanceTimersByTimeAsync(0);
    expect(fate).toEqual({ fate: 'landed' });
    expect(releases).toEqual([]);
    await vi.advanceTimersByTimeAsync(BOUND);
    expect(releases).toEqual([true]);
  });

  it('a ROLLBACK that answers gives the client back to the pool', async () => {
    const { backend, releases } = scripted(reading(row(7, FLUSH_ID)));
    await backend.resolveFlush('g1', FLUSH_ID, 7, token);
    await new Promise(resolve => setImmediate(resolve));
    expect(releases).toEqual([undefined]);
  });
});

describe('2.8 the guild pool', () => {
  it('is built with keepAliveInitialDelayMillis 30000', () => {
    const backend = new PostgresBackend({ url: 'postgres://nobody@127.0.0.1:9/none' });
    backends.push(backend);
    expect((backend.getPool() as unknown as { options: { keepAliveInitialDelayMillis?: number } }).options.keepAliveInitialDelayMillis).toBe(30_000);
  });
});

describe('2.9 the check insert', () => {
  const insertSql = /^INSERT INTO smdb_data\.guild_ownership/;

  it('carries no claims test and ends ON CONFLICT (guild_id) DO NOTHING, bound to the token', async () => {
    const { backend, sent } = scripted(sql => readSql.test(sql) ? { rows: [], rowCount: 0 } : insertSql.test(sql) ? { rows: [], rowCount: 1 } : undefined);
    expect(await backend.resolveFlush('g1', FLUSH_ID, 7, token)).toEqual({ fate: 'not-landed' });
    const insert = sent.find(s => insertSql.test(s.sql))!;
    expect(insert.sql).not.toContain('shard_claims');
    expect(insert.sql).toMatch(/ON CONFLICT \(guild_id\) DO NOTHING$/);
    expect(insert.params).toEqual(['g1', 'node-a', 2, 7, 4]);
  });

  it('a conflict and then a row answers from the row', async () => {
    let reads = 0;
    const { backend } = scripted(sql => readSql.test(sql) ? (++reads === 1 ? { rows: [], rowCount: 0 } : row(7, OTHER_ID)) : undefined);
    expect(await backend.resolveFlush('g1', FLUSH_ID, 7, token)).toEqual({ fate: 'not-landed' });
  });

  it('a conflict and then no row answers unknown after exactly two reads', async () => {
    const { backend, sent } = scripted(sql => readSql.test(sql) ? { rows: [], rowCount: 0 } : undefined);
    expect(await backend.resolveFlush('g1', FLUSH_ID, 7, token)).toEqual({
      fate: 'unknown', detail: "the guild's ownership row was not found after an insert conflicted on it",
    });
    expect(sent.filter(s => readSql.test(s.sql))).toHaveLength(2);
  });
});

describe('2.10 a token without a claim', () => {
  it('connects nothing and answers unknown with the refusal line', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { backend, connect } = scripted(() => undefined);
    expect(await backend.resolveFlush('g1', FLUSH_ID, 7, { ...token, claim: null })).toEqual({
      fate: 'unknown', detail: 'this process holds no shard claim',
    });
    expect(connect).not.toHaveBeenCalled();
    expect(error.mock.calls.map(c => String(c[0]))).toContain('[PostgresBackend] Refused save check for guild g1: this process holds no shard claim');
  });
});
