import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FenceToken, GuildFlushBatch } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { ANSWER_BOUND_MS, PostgresBackend } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { flushBoundMs } from '../../src/bot/internalSetup/utils/storableData';

// NB5 section 8 test 6 and the rulings that amend it (C, D, G to K): the latch, the hold and the data-pool lease at
// the backend, over a fake pool that replaces the backend's whole pool (K3). Its clients record every statement with
// its config, every release argument and every end; end() rejects the statement on the wire as pg does.

const SECOND = 1000;
const A = 'postgres://bot@db1:5432/bot';
const W = 'postgres://bot@db2:5432/bot';
const WHY = 'db1:5432/bot was replaced by node-b (generation 4)';
const LATCHED = `${WHY}; this process does not write to it`;
const SILENT_A = 'the database did not answer; this process checks that db1:5432/bot is still the main before writing to it';
const token: FenceToken = { nodeId: 'node-a', claim: 7, processId: 'p-a', shardId: 2, shardCount: 4 };
const FLUSH_ID = '11111111-1111-4111-8111-111111111111';
const CAUSE = { kind: 'replaced', machine: 'node-b', generation: 4 } as const;

type Reply = { rows?: unknown[]; rowCount?: number } | Error | 'hang' | Promise<unknown> | undefined;
type Script = (sql: string, values: unknown[] | undefined) => Reply;

interface Sent { sql: string; values?: unknown[]; timeout?: number; client: number }

const sqlState = (code: string, severity = 'ERROR') => Object.assign(new Error(`scripted ${code}`), { code, severity });
const sysError = (code: string) => Object.assign(new Error(`connect ${code} 10.0.0.1:5432`), { code, errno: -1, syscall: 'connect' });

const isFence = (s: string) => /^INSERT INTO smdb_data\.guild_ownership AS o\b/.test(s);
const isOwnerRead = (s: string) => /^SELECT node_id, claim FROM smdb_data\.guild_ownership/.test(s);
const isShardRead = (s: string) => /^SELECT claim::text AS claim, holder_name/.test(s);
const isDocInsert = (s: string) => /^INSERT INTO smdb_data\.guild_data_graveyard/.test(s) && s.includes("'doc'");
const isAppendInsert = (s: string) => /^INSERT INTO smdb_data\.guild_data_graveyard/.test(s) && s.includes("'append'");
const isLive = (s: string) => /AS present$/.test(s) && /guild_append WHERE guild_id = \$1\) AS present/.test(s);
const isBatch = (s: string) => /max\(retired_at\)/i.test(s) && !/^WITH/.test(s) && !/^INSERT/.test(s);
const isMove = (s: string) => /^WITH moved AS/.test(s);
const isUpsert = (s: string) => /^INSERT INTO smdb_data\.guild_data \(/.test(s);
const isCopy = (s: string) => /^WITH batch AS/.test(s) && s.includes('guild_data_graveyard');
const isMark = (s: string) => /^SELECT claim, last_flush/.test(s);
const isDocsRead = (s: string) => /^SELECT module, filename, doc FROM smdb_data\.guild_data WHERE guild_id/.test(s);
const isSetLocal = (s: string) => s.startsWith('BEGIN; SET LOCAL');

const backends: PostgresBackend[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'hrtime', 'performance', 'Date'] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const b of backends.splice(0)) await b.stop().catch(() => undefined);
});

function fakePool(script: Script) {
  const sent: Sent[] = [];
  const releases: Array<boolean | undefined> = [];
  const ends: number[] = [];
  const poolQueries: string[] = [];
  let ids = 0;
  const emitter = new EventEmitter();
  const makeClient = () => {
    const id = ++ids;
    let active: ((error: Error) => void) | null = null;
    return {
      query(config: string | { text: string; values?: unknown[]; query_timeout?: number }, maybe?: unknown[]) {
        const sql = (typeof config === 'string' ? config : config.text).trim();
        const values = maybe ?? (typeof config === 'string' ? undefined : config.values);
        const timeout = typeof config === 'string' ? undefined : config.query_timeout;
        sent.push({ sql, values, timeout, client: id });
        const reply = script(sql, values);
        return new Promise((resolve, reject) => {
          let done = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const finish = (r: unknown) => {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            active = null;
            if (r instanceof Error) reject(r);
            else resolve(r ?? { rows: [], rowCount: 0 });
          };
          active = error => finish(error);
          if (timeout !== undefined) timer = setTimeout(() => finish(new Error('Query read timeout')), timeout);
          if (reply === 'hang') return;
          if (reply instanceof Promise) { void reply.then(finish, finish); return; }
          finish(reply);
        });
      },
      release(arg?: boolean) { releases.push(arg); },
      end() {
        ends.push(id);
        active?.(new Error('Connection terminated'));
        return Promise.resolve();
      },
    };
  };
  const pool = {
    connect: vi.fn(async () => makeClient()),
    query: vi.fn(async (config: unknown) => {
      poolQueries.push(typeof config === 'string' ? config : String((config as { text?: unknown })?.text));
      throw new Error('pool.query is not part of this fake');
    }),
    end: vi.fn(async () => undefined),
    on: (event: string, fn: (...args: unknown[]) => void) => { emitter.on(event, fn); return pool; },
    emit: (event: string, arg: unknown) => emitter.emit(event, arg),
  };
  const statements = () => sent.map(s => s.sql);
  return { pool, sent, releases, ends, poolQueries, statements };
}

/** The chooser the tests drive by hand: it chose A, and it confirms nothing on its own. */
function handChooser(entry = A) {
  return {
    chosen: () => entry,
    awaitChoice: async () => entry,
    lastPassLogin: () => 'unreachable' as const,
    holdStarted: vi.fn(),
    confirmNow: vi.fn(),
    stop: () => undefined,
  };
}

const defaultScript: Script = sql => (isFence(sql) ? { rows: [], rowCount: 1 } : undefined);

function rig(script: Script = defaultScript) {
  const chooser = handChooser();
  const backend = new PostgresBackend({ chooser } as never);
  backends.push(backend);
  const realPool = backend.getPool() as unknown as EventEmitter;
  const fake = fakePool(script);
  const internals = backend as unknown as { pool: unknown; state: string; provisioned: boolean };
  internals.pool = fake.pool;
  internals.state = 'ready';
  internals.provisioned = true;
  const idleError = (error: unknown) => realPool.emit('error', error);
  return { backend, chooser, idleError, ...fake };
}

const batchOf = (extra: Partial<GuildFlushBatch> = {}): GuildFlushBatch => ({
  upserts: [{ key: { module: 'm', filename: 'a.json' }, doc: '{}' }],
  deletes: [],
  appends: [],
  flushId: FLUSH_ID,
  ...extra,
});

const later = <T>(ms: number, value: T) => new Promise<T>(resolve => { setTimeout(() => resolve(value), ms); });
const monoIn = (ms: number) => process.hrtime.bigint() + BigInt(Math.round(ms * 1e6));
const settle = (p: Promise<unknown>) => {
  const box: { value?: unknown; done: boolean } = { done: false };
  void p.then(v => { box.value = v; box.done = true; });
  return box;
};
const errorLines = () => vi.mocked(console.error).mock.calls.map(c => c.map(String).join(' '));
const allLines = () => [console.error, console.log, console.warn].flatMap(f => vi.mocked(f).mock.calls.map(c => c.map(String).join(' ')));

/** Happy answers of a restore of batch 5. */
const restoreScript = (override: (sql: string) => Reply | null = () => null): Script => sql => {
  const own = override(sql);
  if (own !== null) return own;
  if (isFence(sql)) return { rows: [], rowCount: 1 };
  if (isBatch(sql)) return { rows: [{ retired_at: '5' }], rowCount: 1 };
  if (/^SELECT 1 FROM smdb_data\.guild_data_graveyard/.test(sql)) return { rows: [{ '?column?': 1 }], rowCount: 1 };
  if (isLive(sql)) return { rows: [{ present: false }], rowCount: 1 };
  if (isMove(sql)) return { rows: [{ taken: '3', put: '3', reason: 'webui-operator-delete' }], rowCount: 1 };
  return undefined;
};

/** Happy answers of a retire whose two graveyard inserts move docs and appends rows. */
const retireScript = (docs: number, appends: number, override: (sql: string) => Reply | null = () => null): Script => sql => {
  const own = override(sql);
  if (own !== null) return own;
  if (isFence(sql)) return { rows: [], rowCount: 1 };
  if (isDocInsert(sql)) return { rows: [], rowCount: docs };
  if (isAppendInsert(sql)) return { rows: [], rowCount: appends };
  return undefined;
};

const retiredAtOf = (sent: Sent[]) => Number(sent.find(s => isDocInsert(s.sql))?.values?.[1]);
const restore = (b: PostgresBackend, deadline: bigint, retiredAt: number | null = 5) => b.restoreGuild('1', retiredAt, token, () => null, deadline);

describe('after the latch every operation is refused with no connection (test 6, G12)', () => {
  it('hydrate, flush and reclaim answer unavailable with the latch detail; retire and restore answer latched', async () => {
    const { backend, pool } = rig();
    backend.latch(CAUSE);
    expect(await backend.hydrateGuild('1', token)).toEqual({ ok: false, reason: 'unavailable', detail: LATCHED });
    expect(await backend.flushGuild('1', batchOf(), token)).toMatchObject({ ok: false, reason: 'unavailable', detail: LATCHED });
    expect(await backend.reclaimGuild('1', token)).toBeNull();
    expect(await backend.retireGuild('1', 'r', token)).toEqual({ ok: false, reason: 'latched', detail: WHY });
    expect(await restore(backend, monoIn(60 * SECOND))).toEqual({ ok: false, reason: 'latched', detail: WHY });
    expect(await backend.askDatabase()).toBe('unreachable');
    expect(pool.connect).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
    expect(backend.connectionState().state).toBe('latched');
    expect(backend.servesData()).toBe(false);
    expect(backend.refusesByOwnState()).toBe(true);
  });

  it('round 3 and G11: sweepGraveyard, listOwnedGuilds, loadDoc and resolveFlush send nothing while latched and while held', async () => {
    for (const enter of ['latch', 'hold'] as const) {
      const { backend, pool, idleError } = rig();
      if (enter === 'latch') backend.latch(CAUSE);
      else idleError(sysError('ECONNRESET'));
      await expect(backend.sweepGraveyard(0)).rejects.toThrow();
      await expect(backend.listOwnedGuilds([2], 4)).rejects.toThrow();
      await expect(backend.loadDoc('1', { module: 'm', filename: 'a.json' })).rejects.toThrow();
      expect(await backend.resolveFlush('1', FLUSH_ID, 7, token)).toEqual({ fate: 'unknown', detail: enter === 'latch' ? LATCHED : SILENT_A });
      expect((backend as unknown as { flushesOnWire: number }).flushesOnWire).toBe(0);
      expect(pool.connect).not.toHaveBeenCalled();
      expect(pool.query).not.toHaveBeenCalled();
      expect(backend.servesData()).toBe(false);
    }
  });

  it('a flush held at an upsert is cut at once: end() in the latch call, no COMMIT and no ROLLBACK (G5 (2), H2)', async () => {
    const { backend, statements, releases, ends } = rig(sql => (isUpsert(sql) ? 'hang' : defaultScript(sql, undefined)));
    const answer = settle(backend.flushGuild('1', batchOf(), token));
    await vi.advanceTimersByTimeAsync(100 * SECOND);
    expect(answer.done).toBe(false);
    expect(backend.connectionState().state).toBe('ready');
    backend.latch(CAUSE);
    expect(ends).toEqual([1]);
    await vi.advanceTimersByTimeAsync(0);
    expect(answer.value).toMatchObject({ ok: false, reason: 'unavailable', detail: LATCHED });
    expect(statements()).not.toContain('COMMIT');
    expect(statements()).not.toContain('ROLLBACK');
    expect(releases).toEqual([true]);
  });

  it('G5 (1): a 4 MiB flush sends no client bound before COMMIT and 40 s on COMMIT', async () => {
    const { backend, sent } = rig();
    const doc = 'x'.repeat(4 * 1024 * 1024);
    expect(await backend.flushGuild('1', batchOf({ upserts: [{ key: { module: 'm', filename: 'a.json' }, doc }] }), token)).toEqual({ ok: true });
    expect(sent.find(s => isSetLocal(s.sql))?.sql).toContain('statement_timeout = 671000');
    for (const s of sent.filter(s => isSetLocal(s.sql) || isFence(s.sql) || isUpsert(s.sql))) expect(s.timeout).toBeUndefined();
    expect(sent.find(s => s.sql === 'COMMIT')?.timeout).toBe(ANSWER_BOUND_MS);
  });

  it('G6 (1): a latch between the last answer and COMMIT: no COMMIT, commitSent false, keys not held as unanswered', async () => {
    const batch = batchOf();
    const { backend, statements } = rig(sql => {
      if (isUpsert(sql)) { backend.latch(CAUSE); return { rows: [], rowCount: 1 }; }
      return defaultScript(sql, undefined);
    });
    const answer = await backend.flushGuild('1', batch, token);
    expect(statements()).not.toContain('COMMIT');
    expect(batch.commitSent).toBe(false);
    expect(answer).toMatchObject({ ok: false, reason: 'unavailable', detail: LATCHED });
    expect((answer as { commitUnanswered?: boolean }).commitUnanswered).toBeUndefined();
  });

  it('G6 (2): a restore whose fence is refused with the latch raised before its ROLLBACK sends neither ROLLBACK nor the owner read', async () => {
    const { backend, statements, releases } = rig(restoreScript(sql => {
      if (isFence(sql)) { backend.latch(CAUSE); return { rows: [], rowCount: 0 }; }
      return null;
    }));
    expect(await restore(backend, monoIn(60 * SECOND))).toEqual({ ok: false, reason: 'deposed' });
    expect(statements()).not.toContain('ROLLBACK');
    expect(statements().some(isOwnerRead)).toBe(false);
    expect(releases).toEqual([true]);
  });
});

describe('a COMMIT sent before the latch (test 6, C6, C7, J1)', () => {
  const commitLater = (reply: Reply, ms = 3 * SECOND): Script => sql => (sql === 'COMMIT' ? later(ms, reply instanceof Error ? reply : (reply ?? { rows: [], rowCount: 0 })) : defaultScript(sql, undefined));

  it('a flush whose COMMIT answers ok after the latch is held apart, landed on the old database', async () => {
    const { backend, ends } = rig(commitLater(undefined));
    const answer = settle(backend.flushGuild('1', batchOf(), token));
    await vi.advanceTimersByTimeAsync(10);
    backend.latch(CAUSE);
    expect(ends).toEqual([]);
    await vi.advanceTimersByTimeAsync(3 * SECOND);
    expect(answer.value).toMatchObject({ ok: false, reason: 'unavailable', commitUnanswered: true, landedOn: 'db1:5432/bot' });
  });

  it('C changed 2: a COMMIT answered 40001 at ERROR after the latch is unavailable, not held apart', async () => {
    const { backend } = rig(commitLater(sqlState('40001')));
    const answer = settle(backend.flushGuild('1', batchOf(), token));
    await vi.advanceTimersByTimeAsync(10);
    backend.latch(CAUSE);
    await vi.advanceTimersByTimeAsync(3 * SECOND);
    expect(answer.value).toMatchObject({ ok: false, reason: 'unavailable', code: '40001' });
    expect((answer.value as { commitUnanswered?: boolean }).commitUnanswered).toBeUndefined();
  });

  it('C new 6: a COMMIT answered 57P01 at ERROR after the latch is held apart, as an ok is', async () => {
    const { backend } = rig(commitLater(sqlState('57P01')));
    const answer = settle(backend.flushGuild('1', batchOf(), token));
    await vi.advanceTimersByTimeAsync(10);
    backend.latch(CAUSE);
    await vi.advanceTimersByTimeAsync(3 * SECOND);
    expect(answer.value).toMatchObject({ ok: false, reason: 'unavailable', commitUnanswered: true });
  });

  it('a COMMIT that never answers settles at 40 s with commitUnanswered, and starts no hold after the latch', async () => {
    const { backend } = rig(sql => (sql === 'COMMIT' ? 'hang' : defaultScript(sql, undefined)));
    const answer = settle(backend.flushGuild('1', batchOf(), token));
    await vi.advanceTimersByTimeAsync(10);
    backend.latch(CAUSE);
    await vi.advanceTimersByTimeAsync(ANSWER_BOUND_MS);
    expect(answer.value).toMatchObject({ ok: false, reason: 'unavailable', commitUnanswered: true });
    expect(backend.connectionState().state).toBe('latched');
    expect(backend.holdWords()).toBeNull();
  });

  it.each(['retire', 'restore'] as const)('J1 (1), C changed 3: a %s whose COMMIT answers ok 3 s after the latch answers unknown after the latch', async op => {
    const script = op === 'retire'
      ? retireScript(1, 0, sql => (sql === 'COMMIT' ? later(3 * SECOND, { rows: [], rowCount: 0 }) : null))
      : restoreScript(sql => (sql === 'COMMIT' ? later(3 * SECOND, { rows: [], rowCount: 0 }) : null));
    const { backend, sent, ends, releases } = rig(script);
    const answer = settle(op === 'retire' ? backend.retireGuild('1', 'r', token) : restore(backend, monoIn(60 * SECOND)));
    await vi.advanceTimersByTimeAsync(10);
    backend.latch(CAUSE);
    await vi.advanceTimersByTimeAsync(3 * SECOND);
    expect(ends).toEqual([]);
    expect(answer.value).toEqual(op === 'retire'
      ? { ok: false, reason: 'unknown', retiredAt: retiredAtOf(sent), moved: 1, afterLatch: true, late: { committed: true, old: 'db1:5432/bot', why: WHY } }
      : { ok: false, reason: 'unknown', retiredAt: 5, afterLatch: true, late: { committed: true, old: 'db1:5432/bot', why: WHY } });
    expect(releases).toHaveLength(1);
  });

  it.each(['retire', 'restore'] as const)('C new 7 (a): a %s whose COMMIT got no answer by its bound while the latch rose answers unknown after the latch', async op => {
    const script = op === 'retire' ? retireScript(2, 0, sql => (sql === 'COMMIT' ? 'hang' : null)) : restoreScript(sql => (sql === 'COMMIT' ? 'hang' : null));
    const { backend, sent } = rig(script);
    const answer = settle(op === 'retire' ? backend.retireGuild('1', 'r', token) : restore(backend, monoIn(60 * SECOND)));
    await vi.advanceTimersByTimeAsync(10);
    backend.latch(CAUSE);
    await vi.advanceTimersByTimeAsync(ANSWER_BOUND_MS);
    expect(answer.value).toEqual(op === 'retire'
      ? { ok: false, reason: 'unknown', retiredAt: retiredAtOf(sent), moved: 2, afterLatch: true, late: { committed: false, old: 'db1:5432/bot', why: WHY } }
      : { ok: false, reason: 'unknown', retiredAt: 5, afterLatch: true, late: { committed: false, old: 'db1:5432/bot', why: WHY } });
  });

  it.each(['retire', 'restore'] as const)('C new 7 (b): a %s whose COMMIT answers 40001 after the latch answers refused', async op => {
    const script = op === 'retire' ? retireScript(1, 0, sql => (sql === 'COMMIT' ? later(SECOND, sqlState('40001')) : null)) : restoreScript(sql => (sql === 'COMMIT' ? later(SECOND, sqlState('40001')) : null));
    const { backend } = rig(script);
    const answer = settle(op === 'retire' ? backend.retireGuild('1', 'r', token) : restore(backend, monoIn(60 * SECOND)));
    await vi.advanceTimersByTimeAsync(10);
    backend.latch(CAUSE);
    await vi.advanceTimersByTimeAsync(SECOND);
    expect(answer.value).toMatchObject({ ok: false, reason: 'refused' });
  });

  it('J1 (2): a hydrate whose COMMIT answers ok 3 s after the latch answers unavailable, uncut and starting no hold', async () => {
    const { backend, ends, releases } = rig(commitLater(undefined));
    const answer = settle(backend.hydrateGuild('1', token));
    await vi.advanceTimersByTimeAsync(10);
    backend.latch(CAUSE);
    await vi.advanceTimersByTimeAsync(3 * SECOND);
    expect(ends).toEqual([]);
    expect(answer.value).toEqual({ ok: false, reason: 'unavailable' });
    expect(releases).toEqual([undefined]);
    expect(backend.holdWords()).toBeNull();
  });
});

describe('D10 and G2: the COMMIT error of a retire and a restore, with and without a latch', () => {
  const cases: Array<[string, () => Error, 'refused' | 'unknown']> = [
    ['40001 at ERROR', () => sqlState('40001'), 'refused'],
    ['58030 at FEHLER', () => sqlState('58030', 'FEHLER'), 'unknown'],
    ['53300 at ERROR', () => sqlState('53300'), 'unknown'],
    ['XX000 at ERROR', () => sqlState('XX000'), 'unknown'],
    ['57014 at ERROR', () => sqlState('57014'), 'unknown'],
    ['08006', () => sqlState('08006', 'FATAL'), 'unknown'],
    ['57P01 at FATAL', () => sqlState('57P01', 'FATAL'), 'unknown'],
    ['an error with no code', () => new Error('Connection terminated unexpectedly'), 'unknown'],
  ];
  it.each((['retire', 'restore'] as const).flatMap(op => cases.flatMap(([name, error, reason]) => [false, true].map(latched => [op, name, error, reason, latched] as const))))(
    '%s, COMMIT %s, latched %s',
    async (op, _name, error, reason, latched) => {
      const commit = (sql: string) => (sql === 'COMMIT' ? later(SECOND, error()) : null);
      const { backend } = rig(op === 'retire' ? retireScript(1, 0, commit) : restoreScript(commit));
      const answer = settle(op === 'retire' ? backend.retireGuild('1', 'r', token) : restore(backend, monoIn(60 * SECOND)));
      await vi.advanceTimersByTimeAsync(10);
      if (latched) backend.latch(CAUSE);
      await vi.advanceTimersByTimeAsync(SECOND);
      expect(answer.value).toMatchObject({ ok: false, reason });
      const afterLatch = (answer.value as { afterLatch?: boolean }).afterLatch;
      expect(afterLatch).toBe(reason === 'unknown' && latched ? true : undefined);
    },
  );

  it('G2 new: a retire whose COMMIT answers 53300 at ERROR logs that it does not show a rollback, and no answered line', async () => {
    const { backend } = rig(retireScript(1, 0, sql => (sql === 'COMMIT' ? sqlState('53300') : null)));
    const noteSuccess = vi.spyOn(backend as unknown as { noteSuccess(): void }, 'noteSuccess');
    expect(await backend.retireGuild('1', 'r', token)).toMatchObject({ ok: false, reason: 'unknown' });
    const lines = errorLines();
    expect(lines.filter(l => l.includes('COMMIT answered SQLSTATE 53300: scripted 53300, which does not show that it rolled back'))).toHaveLength(1);
    expect(lines.some(l => l.includes('got no answer'))).toBe(false);
    expect(noteSuccess).not.toHaveBeenCalled();
  });
});

describe('G4 and K1: the retire answers its batch and the rows it moved', () => {
  it('ok, unknown with rows, and unknown with none carry retiredAt and moved', async () => {
    const ok = rig(retireScript(2, 1));
    const okAnswer = await ok.backend.retireGuild('1', 'r', token);
    expect(okAnswer).toEqual({ ok: true, moved: 3, retiredAt: retiredAtOf(ok.sent) });

    const unanswered = rig(retireScript(2, 1, sql => (sql === 'COMMIT' ? 'hang' : null)));
    const a = settle(unanswered.backend.retireGuild('1', 'r', token));
    await vi.advanceTimersByTimeAsync(ANSWER_BOUND_MS);
    expect(a.value).toEqual({ ok: false, reason: 'unknown', retiredAt: retiredAtOf(unanswered.sent), moved: 3 });

    const empty = rig(retireScript(0, 0, sql => (sql === 'COMMIT' ? 'hang' : null)));
    const b = settle(empty.backend.retireGuild('1', 'r', token));
    await vi.advanceTimersByTimeAsync(ANSWER_BOUND_MS);
    expect(b.value).toEqual({ ok: false, reason: 'unknown', retiredAt: retiredAtOf(empty.sent), moved: 0 });
  });
});

describe('G12 and H6: a retire or restore stopped by the backend own state', () => {
  const states = ['latched before the call', 'the latch while the connect is held', 'the latch cutting the second statement', 'held in outage', 'held in confirming'] as const;
  it.each((['retire', 'restore'] as const).flatMap(op => states.map(state => [op, state] as const)))('%s, %s', async (op, state) => {
    let hold: (() => void) | null = null;
    const r = rig(op === 'retire'
      ? retireScript(1, 0, sql => (state === 'the latch cutting the second statement' && isFence(sql) ? 'hang' : null))
      : restoreScript(sql => (state === 'the latch cutting the second statement' && isFence(sql) ? 'hang' : null)));
    const { backend, pool, statements, idleError } = r;
    const spare = fakePool(defaultScript);
    if (state === 'the latch while the connect is held') {
      pool.connect.mockImplementationOnce(() => new Promise(resolve => { hold = () => { void spare.pool.connect().then(resolve); }; }) as never);
    }
    const noteFailure = vi.spyOn(backend as unknown as { noteFailure(e: unknown): void }, 'noteFailure');
    if (state === 'latched before the call') backend.latch(CAUSE);
    if (state === 'held in outage' || state === 'held in confirming') idleError(sysError('ECONNRESET'));
    if (state === 'held in confirming') backend.noteEntryAnswered(backend.databaseEpoch());
    noteFailure.mockClear();
    const answer = settle(op === 'retire' ? backend.retireGuild('1', 'r', token) : restore(backend, monoIn(60 * SECOND)));
    await vi.advanceTimersByTimeAsync(10);
    if (state === 'the latch while the connect is held') {
      backend.latch(CAUSE);
      (hold as unknown as () => void)();
      await vi.advanceTimersByTimeAsync(10);
      expect(spare.statements()).toEqual([]);
      expect(spare.releases).toEqual([true]);
    }
    if (state === 'the latch cutting the second statement') backend.latch(CAUSE);
    await vi.advanceTimersByTimeAsync(10);
    const held = state.startsWith('held');
    const detail = held ? backend.holdWords() : WHY;
    expect(answer.value).toEqual({ ok: false, reason: held ? 'held' : 'latched', detail });
    expect(statements()).not.toContain('COMMIT');
    expect(noteFailure.mock.calls.filter(c => !(c[0] as Error)?.message?.includes('scripted'))).toEqual([]);
    const name = op === 'retire' ? 'retireGuild' : 'restoreGuild';
    expect(allLines().filter(l => l === `[PostgresBackend] ${name} of guild 1 stopped before COMMIT (${detail}); nothing was committed`)).toHaveLength(1);
    expect(allLines().some(l => l.includes('was not sent'))).toBe(false);
  });
});

describe('the hold (decision 13)', () => {
  const starts: Array<[string, () => unknown, string]> = [
    ['ECONNREFUSED', () => sysError('ECONNREFUSED'), 'the database did not answer'],
    ['ECONNRESET', () => sysError('ECONNRESET'), 'the database did not answer'],
    ['Connection terminated', () => new Error('Connection terminated'), 'the database did not answer'],
    ['Connection terminated due to connection timeout', () => new Error('Connection terminated due to connection timeout'), 'the database did not answer'],
    ['the client bound', () => new Error('Query read timeout'), 'the database did not answer'],
    ['08006', () => sqlState('08006', 'FATAL'), 'the database did not answer'],
    ['FATAL 57P01', () => sqlState('57P01', 'FATAL'), "the database ended this process's sessions (SQLSTATE 57P01)"],
    ['FATAL 57P02', () => sqlState('57P02', 'FATAL'), "the database ended this process's sessions (SQLSTATE 57P02)"],
    ['FATAL 57P03', () => sqlState('57P03', 'FATAL'), 'the database is not accepting connections yet (SQLSTATE 57P03)'],
    ['28000', () => sqlState('28000', 'FATAL'), 'the database refused the login (SQLSTATE 28000)'],
    ['CERT_HAS_EXPIRED', () => Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' }), "the database's certificate was refused (CERT_HAS_EXPIRED)"],
    ['ERR_TLS_CERT_ALTNAME_INVALID', () => Object.assign(new Error("Hostname/IP does not match certificate's altnames"), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }), "the database's certificate was refused (ERR_TLS_CERT_ALTNAME_INVALID)"],
  ];
  it.each(starts)('a connect failing with %s starts the hold with its cause', async (_name, error, cause) => {
    const { backend, pool } = rig();
    pool.connect.mockImplementationOnce(async () => { throw error(); });
    expect(await backend.flushGuild('1', batchOf(), token)).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(backend.connectionState().state).toBe('outage');
    expect(backend.holdWords()).toBe(`${cause}; this process checks that db1:5432/bot is still the main before writing to it`);
    expect(await backend.hydrateGuild('2', token)).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(pool.connect).toHaveBeenCalledTimes(1);
  });

  const answers: Array<[string, () => unknown, string]> = [
    ['22P05', () => sqlState('22P05'), '22P05'],
    ['23505', () => sqlState('23505'), '23505'],
    ['54000', () => sqlState('54000'), '54000'],
    ['40001', () => sqlState('40001'), '40001'],
    ['57014', () => sqlState('57014'), '57014'],
  ];
  it.each(answers)('an upsert answered %s starts no hold, and the next flush goes through', async (_name, error, code) => {
    let first = true;
    const { backend } = rig(sql => {
      if (isUpsert(sql) && first) { first = false; return error() as Error; }
      return defaultScript(sql, undefined);
    });
    expect(await backend.flushGuild('1', batchOf(), token)).toMatchObject({ ok: false, reason: 'unavailable', code });
    expect(backend.connectionState().state).toBe('ready');
    expect(await backend.flushGuild('2', batchOf(), token)).toEqual({ ok: true });
  });

  it.each([
    ['53300', () => sqlState('53300', 'FATAL'), '53300'],
    ['3D000', () => sqlState('3D000', 'FATAL'), '3D000'],
    ['28P01', () => sqlState('28P01', 'FATAL'), '28P01'],
    ['the pool timeout', () => new Error('timeout exceeded when trying to connect'), undefined],
  ] as const)('a new client refused at login with %s starts no hold, and a flush on a pooled client goes through', async (_name, error, code) => {
    const { backend, pool } = rig();
    pool.connect.mockImplementationOnce(async () => { throw error(); });
    const answer = await backend.flushGuild('1', batchOf(), token);
    expect(answer).toMatchObject({ ok: false, reason: 'unavailable' });
    if (code) expect(answer).toMatchObject({ code });
    expect(backend.connectionState().state).toBe('ready');
    expect(await backend.flushGuild('2', batchOf(), token)).toEqual({ ok: true });
  });

  it.each([
    ['askDatabase', (b: PostgresBackend) => b.askDatabase()],
    ['guildFileExists', (b: PostgresBackend) => b.guildFileExists('1', { module: 'm', filename: 'a.json' })],
    ['sweepGraveyard', (b: PostgresBackend) => b.sweepGraveyard(5)],
  ] as const)('A1: %s refused a new client at login with FATAL 53300 starts no hold, and a flush goes through', async (_name, call) => {
    const { backend, pool } = rig();
    const tooMany = () => sqlState('53300', 'FATAL');
    pool.connect.mockImplementationOnce(async () => { throw tooMany(); });
    pool.query.mockImplementationOnce(async () => { throw tooMany(); });
    await call(backend).catch(() => undefined);
    expect(backend.holdWords()).toBeNull();
    expect(backend.connectionState().state).toBe('ready');
    expect(await backend.flushGuild('2', batchOf(), token)).toEqual({ ok: true });
  });

  it("NB4's lapse starts the hold with its own cause", () => {
    const { backend } = rig();
    backend.noteLapse();
    expect(backend.holdWords()).toBe("this process's shard claims lapsed; this process checks that db1:5432/bot is still the main before writing to it");
  });

  it('round 5: askDatabase failing with ECONNREFUSED and an idle client given 57P01 each start the hold; 22P05 does not', async () => {
    const one = rig();
    one.pool.connect.mockImplementationOnce(async () => { throw sysError('ECONNREFUSED'); });
    expect(await one.backend.askDatabase()).toBe('unreachable');
    expect(one.backend.holdWords()).toBe(SILENT_A);
    const two = rig();
    two.idleError(sqlState('57P01', 'FATAL'));
    expect(two.backend.holdWords()).toBe("the database ended this process's sessions (SQLSTATE 57P01); this process checks that db1:5432/bot is still the main before writing to it");
    const three = rig();
    three.idleError(sqlState('22P05'));
    expect(three.backend.connectionState().state).toBe('ready');
  });

  it('in outage without a latch, the answer of the chosen entry gives confirming, and only the confirmation makes the backend ready', async () => {
    const { backend, idleError, pool } = rig();
    idleError(sysError('ECONNRESET'));
    expect(await backend.flushGuild('1', batchOf(), token)).toMatchObject({ ok: false, reason: 'unavailable', detail: SILENT_A });
    expect(await backend.hydrateGuild('1', token)).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(pool.connect).not.toHaveBeenCalled();
    const epoch = backend.databaseEpoch();
    backend.noteEntryAnswered(epoch);
    expect(backend.connectionState().state).toBe('confirming');
    expect(backend.refusesByOwnState()).toBe(true);
    expect(backend.holdWords()).toBe("the database answers again, but this process can't confirm yet that db1:5432/bot is still the main (checking)");
    expect(await backend.flushGuild('1', batchOf(), token)).toMatchObject({ ok: false, reason: 'unavailable' });
    backend.confirmHold(epoch);
    expect(backend.connectionState().state).toBe('ready');
    expect(await backend.flushGuild('1', batchOf(), token)).toEqual({ ok: true });
  });

  it('in outage when the latch rises: no recovered alert and no SELECT 1 to the old database', async () => {
    const { backend, idleError, poolQueries } = rig();
    const alerts: string[] = [];
    backend.onAlert(event => alerts.push(event));
    idleError(sysError('ECONNRESET'));
    backend.latch(CAUSE);
    await vi.advanceTimersByTimeAsync(120 * SECOND);
    expect(alerts).not.toContain('recovered');
    expect(alerts).not.toContain('outage');
    expect(poolQueries).toEqual([]);
    expect(backend.connectionState().state).toBe('latched');
  });

  it('round 6 and 7: the hold reports its words on entry, on each new cause and at its end', () => {
    const { backend, idleError } = rig();
    const reports: Array<string | null> = [];
    backend.onHoldChanged(words => reports.push(words));
    idleError(sysError('ECONNRESET'));
    const epoch = backend.databaseEpoch();
    expect(backend.heldUntil()).toBe(Date.now());
    backend.noteEntryAnswered(epoch);
    backend.noteConfirmingCause('Discord answered 403 (Cannot send messages to this user, 50007)', epoch);
    backend.noteConfirmingCause('Discord answered 403 (Cannot send messages to this user, 50007)', epoch);
    backend.noteConfirmingCause('a timeout', epoch);
    vi.advanceTimersByTime(5 * SECOND);
    const confirmedAt = Date.now();
    backend.confirmHold(epoch);
    vi.advanceTimersByTime(5 * SECOND);
    backend.latch(CAUSE);
    expect(reports).toEqual([
      SILENT_A,
      "the database answers again, but this process can't confirm yet that db1:5432/bot is still the main (checking)",
      "the database answers again, but this process can't confirm yet that db1:5432/bot is still the main (Discord answered 403 (Cannot send messages to this user, 50007))",
      "the database answers again, but this process can't confirm yet that db1:5432/bot is still the main (a timeout)",
      null,
    ]);
    expect(backend.heldUntil()).toBe(confirmedAt);
  });
});

describe('useDatabase (decision 12) and the epoch of each observation', () => {
  function moveRig(script: Script = defaultScript) {
    const r = rig(script);
    const target = fakePool(defaultScript);
    (r.backend as unknown as { makePool(config: unknown): unknown }).makePool = () => target.pool;
    const changed: string[] = [];
    r.backend.onDatabaseChanged(entry => changed.push(entry));
    const moved = vi.fn();
    const steps = { checkTarget: async () => null, claims: async () => true, settleRetires: async () => true, moved };
    return { ...r, target, changed, moved, steps };
  }

  it('after useDatabase(W) the next flush goes to the new pool, the listeners ran once and the old pool ended', async () => {
    const { backend, pool, target, changed, moved, steps } = moveRig();
    backend.latch(CAUSE);
    expect(await backend.useDatabase(W, steps)).toBe(true);
    expect(changed).toEqual([W]);
    expect(moved).toHaveBeenCalledWith(W);
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(backend.chosenEntry()).toBe(W);
    expect(backend.connectionState().state).toBe('ready');
    expect(await backend.flushGuild('1', batchOf(), token)).toEqual({ ok: true });
    expect(pool.connect).not.toHaveBeenCalled();
    expect(target.pool.connect).toHaveBeenCalledTimes(1);
  });

  it('round 5: a COMMIT on A reaching its bound after the move leaves W ready, logs no outage and calls no listener', async () => {
    for (const late of [new Error('Query read timeout'), sqlState('28000', 'FATAL'), sqlState('57P01', 'FATAL')]) {
      vi.mocked(console.error).mockClear();
      const { backend, steps, target } = moveRig(sql => (sql === 'COMMIT' ? later(ANSWER_BOUND_MS, late) : defaultScript(sql, undefined)));
      const refused = vi.fn();
      backend.onLoginRefused(refused);
      const answer = settle(backend.flushGuild('1', batchOf(), token));
      await vi.advanceTimersByTimeAsync(10);
      backend.latch(CAUSE);
      expect(await backend.useDatabase(W, steps)).toBe(true);
      await vi.advanceTimersByTimeAsync(ANSWER_BOUND_MS);
      expect(answer.done).toBe(true);
      expect(backend.connectionState().state).toBe('ready');
      expect(backend.holdWords()).toBeNull();
      expect(refused).not.toHaveBeenCalled();
      expect(errorLines().some(l => l.includes('entering outage'))).toBe(false);
      expect(await backend.flushGuild('1', batchOf(), token)).toEqual({ ok: true });
      expect(target.pool.connect).toHaveBeenCalled();
    }
  });

  it("round 5: an idle client of A's ended pool erroring after the move starts no hold", async () => {
    const { backend, steps, idleError } = moveRig();
    backend.latch(CAUSE);
    await backend.useDatabase(W, steps);
    idleError(sysError('ECONNRESET'));
    expect(backend.connectionState().state).toBe('ready');
  });

  it('round 6: on W a flush ECONNRESET, askDatabase ECONNREFUSED and an idle 57P01 start the hold; a 28000 calls the listeners once', async () => {
    const one = moveRig();
    one.backend.latch(CAUSE);
    await one.backend.useDatabase(W, one.steps);
    one.target.pool.connect.mockImplementationOnce(async () => { throw sysError('ECONNRESET'); });
    await one.backend.flushGuild('1', batchOf(), token);
    expect(one.backend.holdWords()).toBe('the database did not answer; this process checks that db2:5432/bot is still the main before writing to it');

    const two = moveRig();
    two.backend.latch(CAUSE);
    await two.backend.useDatabase(W, two.steps);
    two.target.pool.connect.mockImplementationOnce(async () => { throw sysError('ECONNREFUSED'); });
    expect(await two.backend.askDatabase()).toBe('unreachable');
    expect(two.backend.connectionState().state).toBe('outage');

    const three = moveRig();
    three.backend.latch(CAUSE);
    await three.backend.useDatabase(W, three.steps);
    three.target.pool.emit('error', sqlState('57P01', 'FATAL'));
    expect(three.backend.connectionState().state).toBe('outage');

    const four = moveRig();
    const refused = vi.fn();
    four.backend.onLoginRefused(refused);
    four.backend.latch(CAUSE);
    await four.backend.useDatabase(W, four.steps);
    four.target.pool.connect.mockImplementationOnce(async () => { throw sqlState('28000', 'FATAL'); });
    await four.backend.flushGuild('1', batchOf(), token);
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it('a move refused by its target check keeps the latch and logs the reason once', async () => {
    const { backend, steps } = moveRig();
    backend.latch(CAUSE);
    const refusing = { ...steps, checkTarget: async () => 'the database holds schema version {"v":4}, and this bot reads only version 5' };
    expect(await backend.useDatabase(W, refusing)).toBe(false);
    expect(await backend.useDatabase(W, refusing)).toBe(false);
    expect(backend.connectionState().state).toBe('latched');
    const line = '[Database] Not moving to db2:5432/bot: the database holds schema version {"v":4}, and this bot reads only version 5; this process keeps its unsaved changes and stays stopped';
    expect(allLines().filter(l => l === line)).toHaveLength(1);
  });

  it('F4c moved to the watch: observations of 57P01 then 28000 tell the login-refused listeners once', () => {
    const { backend } = rig();
    const refused = vi.fn();
    backend.onLoginRefused(refused);
    const epoch = backend.databaseEpoch();
    backend.noteObservation(sqlState('57P01', 'FATAL'), epoch);
    backend.noteObservation(sqlState('57P01', 'FATAL'), epoch);
    backend.noteObservation(sqlState('28000', 'FATAL'), epoch);
    expect(refused).toHaveBeenCalledTimes(1);
    backend.noteObservation(sqlState('28000', 'FATAL'), epoch - 1);
    expect(refused).toHaveBeenCalledTimes(1);
  });
});

describe('H2: the ROLLBACK after a failed hydrate or flush', () => {
  it('a hydrate whose fence never answers settles at 40 s with the hold and no ROLLBACK', async () => {
    const { backend, statements, releases } = rig(sql => (isFence(sql) ? 'hang' : undefined));
    const answer = settle(backend.hydrateGuild('1', token));
    await vi.advanceTimersByTimeAsync(ANSWER_BOUND_MS);
    expect(answer.value).toEqual({ ok: false, reason: 'unavailable' });
    expect(backend.holdWords()).toBe(SILENT_A);
    expect(statements()).not.toContain('ROLLBACK');
    expect(releases).toEqual([true]);
  });

  it('a hydrate whose deposed fence answers in the turn an idle error starts the hold sends neither ROLLBACK nor the owner read', async () => {
    const r = rig(sql => {
      if (isFence(sql)) { r.idleError(sysError('ECONNRESET')); return { rows: [], rowCount: 0 }; }
      return undefined;
    });
    expect(await r.backend.hydrateGuild('1', token)).toEqual({ ok: false, reason: 'unavailable', detail: SILENT_A });
    expect(r.statements()).not.toContain('ROLLBACK');
    expect(r.statements().some(isOwnerRead)).toBe(false);
    expect(r.releases).toEqual([true]);
  });

  it('a flush whose upsert answers 23505 and whose ROLLBACK never answers settles at 40 s with the hold', async () => {
    const { backend, sent, releases } = rig(sql => (isUpsert(sql) ? sqlState('23505') : sql === 'ROLLBACK' ? 'hang' : defaultScript(sql, undefined)));
    const answer = settle(backend.flushGuild('1', batchOf(), token));
    await vi.advanceTimersByTimeAsync(10);
    const rollbacks = sent.filter(s => s.sql === 'ROLLBACK');
    expect(rollbacks).toHaveLength(1);
    expect(rollbacks[0].timeout).toBe(ANSWER_BOUND_MS);
    await vi.advanceTimersByTimeAsync(ANSWER_BOUND_MS);
    expect(answer.value).toMatchObject({ ok: false, reason: 'unavailable', code: '23505' });
    expect(releases).toEqual([true]);
    expect(backend.holdWords()).toBe(SILENT_A);
  });

  it('G5 (3): an upsert on the wire when an idle ECONNRESET starts the hold is not cut, and nothing follows it', async () => {
    const { backend, statements, releases, ends, idleError } = rig(sql => (isUpsert(sql) ? later(5 * SECOND, { rows: [], rowCount: 1 }) : sql === 'ROLLBACK' ? 'hang' : defaultScript(sql, undefined)));
    const answer = settle(backend.flushGuild('1', batchOf(), token));
    await vi.advanceTimersByTimeAsync(10);
    idleError(sysError('ECONNRESET'));
    expect(ends).toEqual([]);
    await vi.advanceTimersByTimeAsync(5 * SECOND);
    expect(answer.value).toMatchObject({ ok: false, reason: 'unavailable', detail: SILENT_A });
    expect(statements()).not.toContain('COMMIT');
    expect(statements()).not.toContain('ROLLBACK');
    expect(releases).toEqual([true]);
  });
});

describe('I1: the data-pool lease', () => {
  it('(1) a hydrate whose owner read never answers settles at 40 s with the hold', async () => {
    const { backend, statements, releases } = rig(sql => (isFence(sql) ? { rows: [], rowCount: 0 } : isOwnerRead(sql) ? 'hang' : undefined));
    const answer = settle(backend.hydrateGuild('1', token));
    await vi.advanceTimersByTimeAsync(ANSWER_BOUND_MS + 10);
    expect(answer.value).toEqual({ ok: false, reason: 'unavailable' });
    expect(backend.holdWords()).toBe(SILENT_A);
    expect(isOwnerRead(statements().at(-1) ?? '')).toBe(true);
    expect(releases).toEqual([true]);
  });

  it('(2) a flush whose owner read never answers settles at 40 s with no shard read and no deposed line', async () => {
    const { backend, statements, releases } = rig(sql => (isFence(sql) ? { rows: [], rowCount: 0 } : isOwnerRead(sql) ? 'hang' : undefined));
    const alerts: string[] = [];
    backend.onAlert(event => alerts.push(event));
    const answer = settle(backend.flushGuild('1', batchOf(), token));
    await vi.advanceTimersByTimeAsync(ANSWER_BOUND_MS + 10);
    expect(answer.value).toMatchObject({ ok: false, reason: 'unavailable', detail: 'Query read timeout' });
    expect(statements().some(isShardRead)).toBe(false);
    expect(alerts).not.toContain('deposed');
    expect(allLines().some(l => l.includes('Flush rejected') || l.includes('has no ownership row'))).toBe(false);
    expect(releases).toEqual([true]);
    expect(backend.holdWords()).toBe(SILENT_A);
    expect((backend as unknown as { flushesOnWire: number }).flushesOnWire).toBe(0);
  });

  it('(3) a flush whose shard read never answers settles at 40 s with the hold', async () => {
    const { backend, releases } = rig(sql => (isFence(sql) ? { rows: [], rowCount: 0 } : isOwnerRead(sql) ? { rows: [{ node_id: 'n', claim: '9' }], rowCount: 1 } : isShardRead(sql) ? 'hang' : undefined));
    const alerts: string[] = [];
    backend.onAlert(event => alerts.push(event));
    const answer = settle(backend.flushGuild('1', batchOf(), token));
    await vi.advanceTimersByTimeAsync(ANSWER_BOUND_MS + 10);
    expect(answer.value).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(releases).toEqual([true]);
    expect(backend.holdWords()).toBe(SILENT_A);
    expect(alerts).not.toContain('deposed');
    expect(allLines().some(l => l.includes('Flush rejected'))).toBe(false);
  });

  it.each(['hydrate', 'flush'] as const)('(4) a %s whose deposed ROLLBACK answers in the turn an idle error starts the hold reads nothing more', async op => {
    const r = rig(sql => {
      if (isFence(sql)) return { rows: [], rowCount: 0 };
      if (sql === 'ROLLBACK') { r.idleError(sysError('ECONNRESET')); return undefined; }
      return undefined;
    });
    const alerts: string[] = [];
    r.backend.onAlert(event => alerts.push(event));
    const answer = op === 'hydrate' ? await r.backend.hydrateGuild('1', token) : await r.backend.flushGuild('1', batchOf(), token);
    expect(answer).toMatchObject({ ok: false, reason: 'unavailable' });
    if (op === 'flush') expect(answer).toMatchObject({ detail: SILENT_A });
    expect(r.statements().some(isOwnerRead)).toBe(false);
    expect(r.statements().some(isShardRead)).toBe(false);
    expect(r.releases).toEqual([true]);
    expect(alerts).not.toContain('deposed');
  });

  it('(5) an owner read answered 42501 says the ownership row could not be read', async () => {
    const { backend, releases } = rig(sql => (isFence(sql) ? { rows: [], rowCount: 0 } : isOwnerRead(sql) ? sqlState('42501') : undefined));
    expect(await backend.flushGuild('1', batchOf(), token)).toEqual({ ok: false, reason: 'deposed', currentOwner: undefined });
    expect(errorLines().filter(l => l === "[PostgresBackend] Flush rejected: deposed: guild 1's ownership row could not be read; shard 2 of 4 has no claim row; local claim 7")).toHaveLength(1);
    expect(backend.connectionState().state).toBe('ready');
    expect(releases).toEqual([undefined]);
  });

  // MB2: NB16's bootstrap takes the transaction lock (pg_try_advisory_xact_lock), which ends with its session.
  it('(6) a bootstrap whose advisory lock never answers fails at 40 s without DDL or ROLLBACK and destroys its client', async () => {
    const { backend, statements, releases } = rig(sql => (/pg_try_advisory_xact_lock/.test(sql) ? 'hang' : undefined));
    (backend as unknown as { provisioned: boolean }).provisioned = false;
    const run = (backend as unknown as { provision(): Promise<void> }).provision();
    const done = settle(run.catch(() => 'failed'));
    await vi.advanceTimersByTimeAsync(ANSWER_BOUND_MS - 10);
    expect(done.done).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(done.done).toBe(true);
    expect(statements().some(s => /^CREATE/.test(s))).toBe(false);
    expect(statements().at(-1)).toMatch(/pg_try_advisory_xact_lock/);
    expect(releases).toEqual([true]);
  });

  it('(7) a bootstrap where the latch rises after the lock answered sends nothing more and destroys its client', async () => {
    const r = rig(sql => {
      if (/pg_try_advisory_xact_lock/.test(sql)) { r.backend.latch(CAUSE); return { rows: [{ locked: true }], rowCount: 1 }; }
      return undefined;
    });
    (r.backend as unknown as { provisioned: boolean }).provisioned = false;
    await (r.backend as unknown as { provision(): Promise<void> }).provision().catch(() => undefined);
    expect(r.statements()).toEqual(['BEGIN', 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED', expect.stringMatching(/pg_try_advisory_xact_lock/)]);
    expect(r.releases).toEqual([true]);
  });
});

describe('I4 and I5: a close that times out', () => {
  const retireDeposed = (b: PostgresBackend, deadline: bigint | null) => b.retireGuild('1', 'r', token, deadline);
  const paths = [
    ['the retire deposed close', (b: PostgresBackend, d: bigint) => retireDeposed(b, d), (sql: string): Reply | null => (isFence(sql) ? { rows: [], rowCount: 0 } : sql === 'ROLLBACK' ? 'hang' : null), { ok: false, reason: 'deposed' }],
    ['the restore deposed close', (b: PostgresBackend, d: bigint) => restore(b, d), (sql: string): Reply | null => (isFence(sql) ? { rows: [], rowCount: 0 } : sql === 'ROLLBACK' ? 'hang' : null), { ok: false, reason: 'deposed' }],
    ['the restore live-rows close', (b: PostgresBackend, d: bigint) => restore(b, d), (sql: string): Reply | null => (isLive(sql) ? { rows: [{ present: true }], rowCount: 1 } : sql === 'ROLLBACK' ? 'hang' : null), { ok: false, reason: 'live-rows', retiredAt: 5 }],
  ] as const;

  it.each(paths)('I4 (1): %s with 60 s left starts the hold at 40 s', async (_name, call, override, expected) => {
    const { backend, releases } = rig(restoreScript(override));
    const answer = settle(call(backend, monoIn(60 * SECOND)));
    await vi.advanceTimersByTimeAsync(ANSWER_BOUND_MS + 10);
    expect(answer.value).toEqual(expected);
    expect(releases).toEqual([true]);
    expect(backend.holdWords()).toBe(SILENT_A);
  });

  it('I4 (2): a restore whose owner read never answers, 60 s left, starts the hold at 40 s', async () => {
    const { backend, releases } = rig(restoreScript(sql => (isFence(sql) ? { rows: [], rowCount: 0 } : isOwnerRead(sql) ? 'hang' : null)));
    const answer = settle(restore(backend, monoIn(60 * SECOND)));
    await vi.advanceTimersByTimeAsync(ANSWER_BOUND_MS + 10);
    expect(answer.value).toEqual({ ok: false, reason: 'deposed' });
    expect(releases).toEqual([true]);
    expect(backend.holdWords()).toBe(SILENT_A);
  });

  it('I4 (3): an out-of-time ROLLBACK cut by the deadline starts no hold and notes no success', async () => {
    const { backend, statements, releases } = rig(retireScript(0, 0, sql => {
      if (/^UPDATE smdb_data\.guild_ownership SET retired_at/.test(sql)) return later(38_500, { rows: [], rowCount: 1 });
      if (sql === 'ROLLBACK') return 'hang';
      return null;
    }));
    const noteSuccess = vi.spyOn(backend as unknown as { noteSuccess(): void }, 'noteSuccess');
    const answer = settle(backend.retireGuild('1', 'r', token, monoIn(40 * SECOND)));
    await vi.advanceTimersByTimeAsync(40 * SECOND + 10);
    expect(answer.value).toEqual({ ok: false, reason: 'out-of-time' });
    expect(statements()).not.toContain('COMMIT');
    expect(releases).toEqual([true]);
    expect(backend.holdWords()).toBeNull();
    expect(noteSuccess).not.toHaveBeenCalled();
  });

  it('I4 (4): a check whose ROLLBACK never answers answers landed at once and starts the hold at 40 s', async () => {
    const { backend, releases } = rig(sql => (isMark(sql) ? { rows: [{ claim: '7', last_flush: FLUSH_ID, node_id: 'node-a' }], rowCount: 1 } : sql === 'ROLLBACK' ? 'hang' : undefined));
    expect(await backend.resolveFlush('1', FLUSH_ID, 7, token)).toEqual({ fate: 'landed' });
    await vi.advanceTimersByTimeAsync(ANSWER_BOUND_MS + 10);
    expect(releases).toEqual([true]);
    expect((backend as unknown as { flushesOnWire: number }).flushesOnWire).toBe(0);
    expect(backend.holdWords()).toBe(SILENT_A);
  });

  it('I4 (5): a retire whose latch rises before its deposed ROLLBACK sends none and logs no hold', async () => {
    const r = rig(retireScript(0, 0, sql => {
      if (isFence(sql)) { r.backend.latch(CAUSE); return { rows: [], rowCount: 0 }; }
      return null;
    }));
    expect(await r.backend.retireGuild('1', 'r', token)).toEqual({ ok: false, reason: 'deposed' });
    expect(r.statements()).not.toContain('ROLLBACK');
    expect(r.releases).toEqual([true]);
    expect(errorLines().some(l => l.includes('entering outage'))).toBe(false);
  });

  it('I4 (6): a close answered with an error counts as an answer', async () => {
    const { backend, releases } = rig(restoreScript(sql => (isFence(sql) ? { rows: [], rowCount: 0 } : isOwnerRead(sql) ? sqlState('42501') : null)));
    expect(await restore(backend, monoIn(60 * SECOND))).toEqual({ ok: false, reason: 'deposed' });
    expect(releases).toEqual([true]);
    expect(backend.holdWords()).toBeNull();
  });

  it.each(paths)('I5 (1): %s with 40 s left is cut by the deadline: no hold and no success noted', async (_name, call, override, expected) => {
    const { backend, releases } = rig(restoreScript(override));
    const noteSuccess = vi.spyOn(backend as unknown as { noteSuccess(): void }, 'noteSuccess');
    const answer = settle(call(backend, monoIn(40 * SECOND)));
    await vi.advanceTimersByTimeAsync(40 * SECOND + 10);
    expect(answer.value).toEqual(expected);
    expect(releases).toEqual([true]);
    expect(backend.holdWords()).toBeNull();
    expect(noteSuccess).not.toHaveBeenCalled();
  });

  it('I5 (2): a retire with no deadline whose fenced update never answers times out at 40 s and starts the hold', async () => {
    const { backend, releases } = rig(retireScript(0, 0, sql => (isFence(sql) ? 'hang' : null)));
    const answer = settle(backend.retireGuild('1', 'r', token));
    await vi.advanceTimersByTimeAsync(ANSWER_BOUND_MS + 10);
    expect(answer.value).toEqual({ ok: false, reason: 'unavailable', timedOut: true });
    expect(releases).toEqual([true]);
    expect(backend.holdWords()).toBe(SILENT_A);
  });

  it('I5 (3): a restore with 60 s left whose live check never answers times out at 40 s and starts the hold', async () => {
    const { backend } = rig(restoreScript(sql => (isLive(sql) ? 'hang' : null)));
    const answer = settle(restore(backend, monoIn(60 * SECOND)));
    await vi.advanceTimersByTimeAsync(ANSWER_BOUND_MS + 10);
    expect(answer.value).toEqual({ ok: false, reason: 'unavailable', detail: "the database did not answer within the restore's 40 s", timedOut: true });
    expect(backend.holdWords()).toBe(SILENT_A);
  });

  it.each([40, 39])('I5 (4): the live check with %i s left times out at the deadline and starts no hold', async seconds => {
    const { backend } = rig(restoreScript(sql => (isLive(sql) ? 'hang' : null)));
    const answer = settle(restore(backend, monoIn(seconds * SECOND)));
    await vi.advanceTimersByTimeAsync(seconds * SECOND + 10);
    expect(answer.value).toMatchObject({ ok: false, timedOut: true });
    expect(backend.holdWords()).toBeNull();
  });
});

describe('J2: statements whose answer can be large carry no client bound', () => {
  it('(1) a hydrate document read answered after 100 s with no bound', async () => {
    const { backend, sent, releases } = rig(sql => (isFence(sql) ? { rows: [], rowCount: 1 } : isDocsRead(sql) ? later(100 * SECOND, { rows: [{ module: 'm', filename: 'a.json', doc: '{}' }], rowCount: 1 }) : undefined));
    const answer = settle(backend.hydrateGuild('1', token));
    await vi.advanceTimersByTimeAsync(100 * SECOND + 10);
    expect(answer.value).toMatchObject({ ok: true, docs: [{ key: { module: 'm', filename: 'a.json' }, doc: '{}' }] });
    expect(sent.find(s => isDocsRead(s.sql))?.timeout).toBeUndefined();
    expect(backend.holdWords()).toBeNull();
    expect(releases).toEqual([undefined]);
  });

  const readers = [
    ['loadDoc', (b: PostgresBackend) => b.loadDoc('1', { module: 'm', filename: 'a.json' }), { rows: [{ doc: '{"a":1}' }], rowCount: 1 }, '{"a":1}'],
    ['listGuilds', (b: PostgresBackend) => b.listGuilds(), { rows: [{ guild_id: '5' }], rowCount: 1 }, ['5']],
    ['listOwnedGuilds', (b: PostgresBackend) => b.listOwnedGuilds([2], 4), { rows: [{ guild_id: '6' }], rowCount: 1 }, ['6']],
    ['listGuildFiles', (b: PostgresBackend) => b.listGuildFiles('1', 'm'), { rows: [{ filename: 'a.json' }], rowCount: 1 }, ['a.json']],
  ] as const;
  it.each(readers)('(2) %s answered after 100 s goes over a leased client with no bound', async (_name, call, rows, value) => {
    const { backend, sent, releases, pool } = rig(() => later(100 * SECOND, rows));
    const answer = settle(call(backend) as Promise<unknown>);
    await vi.advanceTimersByTimeAsync(100 * SECOND + 10);
    expect(answer.value).toEqual(value);
    expect(sent).toHaveLength(1);
    expect(sent[0].timeout).toBeUndefined();
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled();
    expect(releases).toEqual([undefined]);
    expect(backend.holdWords()).toBeNull();
  });

  const onWire = [
    ['the hydrate', (b: PostgresBackend) => b.hydrateGuild('1', token)],
    ['listOwnedGuilds', (b: PostgresBackend) => b.listOwnedGuilds([2], 4)],
  ] as const;
  it.each(onWire)('(3) %s on the wire when the latch rises is cut', async (name, call) => {
    const { backend, statements, releases, ends } = rig(sql => (isFence(sql) ? { rows: [], rowCount: 1 } : sql === 'BEGIN' ? undefined : 'hang'));
    const answer = settle((call(backend) as Promise<unknown>).catch((error: Error) => ({ rejected: error.message })));
    await vi.advanceTimersByTimeAsync(10);
    const before = statements().length;
    backend.latch(CAUSE);
    expect(ends).toEqual([1]);
    await vi.advanceTimersByTimeAsync(10);
    if (name === 'the hydrate') expect(answer.value).toMatchObject({ ok: false, reason: 'unavailable' });
    else expect(answer.value).toEqual({ rejected: WHY });
    expect(statements()).toHaveLength(before);
    expect(releases).toEqual([true]);
    expect(backend.holdWords()).toBeNull();
  });

  it.each(onWire)('(4) %s failing with the keepalive error starts the hold and sends nothing more', async (name, call) => {
    const keepalive = () => Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT', errno: -110, syscall: 'read' });
    const { backend, statements, releases } = rig(sql => (isFence(sql) ? { rows: [], rowCount: 1 } : sql === 'BEGIN' ? undefined : later(100 * SECOND, keepalive())));
    const answer = settle((call(backend) as Promise<unknown>).catch((error: Error) => ({ rejected: error.message })));
    await vi.advanceTimersByTimeAsync(10);
    const before = statements().length;
    await vi.advanceTimersByTimeAsync(100 * SECOND);
    if (name === 'the hydrate') expect(answer.value).toMatchObject({ ok: false, reason: 'unavailable' });
    else expect(answer.value).toEqual({ rejected: 'read ETIMEDOUT' });
    expect(backend.holdWords()).toBe(SILENT_A);
    expect(statements()).toHaveLength(before);
    expect(releases).toEqual([true]);
  });

  it('(5) a hydrate document read answered 57014 rolls back and starts no hold', async () => {
    const { backend, statements, releases } = rig(sql => (isFence(sql) ? { rows: [], rowCount: 1 } : isDocsRead(sql) ? later(100 * SECOND, sqlState('57014')) : undefined));
    const answer = settle(backend.hydrateGuild('1', token));
    await vi.advanceTimersByTimeAsync(100 * SECOND + 10);
    expect(answer.value).toEqual({ ok: false, reason: 'unavailable' });
    expect(statements().filter(s => s === 'ROLLBACK')).toHaveLength(1);
    expect(backend.holdWords()).toBeNull();
    expect(releases).toEqual([true]);
  });
});

describe("G7 and H3: a flagged set's flush in replace mode", () => {
  const replace = (docKeys: number, reason = 're-saved by bot process p-a after it stopped writing to db1:5432/bot; these rows were not in its copy of the guild') => ({
    docKeys: Array.from({ length: docKeys }, (_, i) => ({ module: 'm', filename: `${'k'.repeat(1000)}${i}.json` })),
    appendKeys: [{ module: 'm', filename: 'log.jsonl' }],
    reason,
  });

  it('the copy, then both deletes, follow the fence; the server bound is that of the largest statement, the copy', async () => {
    const { backend, sent } = rig();
    const keys = replace(3000);
    const upserts = keys.docKeys.map(key => ({ key, doc: '{}' }));
    expect(await backend.flushGuild('1', batchOf({ upserts, replace: keys }), token)).toEqual({ ok: true });
    const order = sent.map(s => s.sql);
    const fence = order.findIndex(isFence);
    expect(isCopy(order[fence + 1])).toBe(true);
    expect(order[fence + 2]).toMatch(/^DELETE FROM smdb_data\.guild_data WHERE/);
    expect(order[fence + 3]).toMatch(/^DELETE FROM smdb_data\.guild_append WHERE/);
    const bytes = (s: Sent) => Buffer.byteLength(s.sql) + (s.values ?? []).reduce<number>((n, v) => n + (v === null || v === undefined ? 0 : Buffer.byteLength(String(v))), 0);
    const copy = sent.find(s => isCopy(s.sql))!;
    const bound = flushBoundMs(bytes(copy));
    expect(sent.find(s => isSetLocal(s.sql))?.sql).toBe(`BEGIN; SET LOCAL statement_timeout = ${bound}`);
    for (const s of sent.filter(s => !isSetLocal(s.sql) && s.sql !== 'COMMIT')) expect(flushBoundMs(bytes(s))).toBeLessThanOrEqual(bound);
  });

  it('the line names the rows the copy moved and its batch', async () => {
    const { backend } = rig(sql => (isCopy(sql) ? { rows: [{ moved: '7', retired_at: '1700000000123' }], rowCount: 1 } : defaultScript(sql, undefined)));
    expect(await backend.flushGuild('1', batchOf({ replace: replace(1) }), token)).toEqual({ ok: true });
    expect(allLines().filter(l => l === '[Data] Guild 1: the re-save on db1:5432/bot moved 7 row(s) this process did not hold to the graveyard (batch 1700000000123)')).toHaveLength(1);
  });

  it('450 held keys go as arrays in one delete of each table', async () => {
    const { backend, sent } = rig();
    expect(await backend.flushGuild('1', batchOf({ replace: replace(450) }), token)).toEqual({ ok: true });
    const dataDeletes = sent.filter(s => /^DELETE FROM smdb_data\.guild_data WHERE/.test(s.sql));
    const appendDeletes = sent.filter(s => /^DELETE FROM smdb_data\.guild_append WHERE/.test(s.sql));
    expect(dataDeletes).toHaveLength(1);
    expect(appendDeletes).toHaveLength(1);
    expect((dataDeletes[0].values?.[1] as unknown[]).length).toBe(450);
  });
});
