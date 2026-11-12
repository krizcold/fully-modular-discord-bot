import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryConfig } from 'pg';

import * as pg from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';

const { checkMoveTarget } = pg;

// A target that matches this bot's store, scripted as nb5fMoveCheck.test.ts scripts it (foundRow, fr and GOOD_META are
// copied from there), with Postgres's own refusal of a bind message whose parameter count differs from the statement's.

const W = 'postgres://bot@w:5432/bot';
const SECOND = 1000;
const OVER_BOUND = 'the check of its store did not finish within 60 s';

type Row = Record<string, unknown>;

const FOUND = /has_database_privilege/;
const VERSION = /^SELECT value::text FROM ONLY smdb_data\.meta WHERE key = 'schema_version'/;
const STORE_ID = /^SELECT value FROM ONLY smdb_data\.meta WHERE key = 'store_id'$/;

function fr(name: string, kind: string): Row {
  const table = ['r', 'p', 'v', 'm', 'f'].includes(kind);
  const seq = kind === 'S';
  return {
    name, kind, is_partition: false,
    select: table ? true : null, insert: table ? true : null, update: table ? true : null, delete: table ? true : null,
    usage: seq ? true : null, update_seq: seq ? true : null,
  };
}
const GOOD_META = { kind: 'r', key_text: true, value_text: true, value_not_null: true, rls: false, unique_key: true, select: true };
const FOUND_ROW = {
  role: 'smdb_bot', db: 'smdb', db_create: true, schema_exists: true, schema_usage: true, schema_create: true,
  relations: [fr('meta', 'r'), fr('meta_pkey', 'i')], meta: GOOD_META,
};

function reply(sql: string): { rows: Row[]; rowCount: number } {
  const rows = (r: Row[]) => ({ rows: r, rowCount: r.length });
  if (sql === 'SHOW server_version_num') return rows([{ server_version_num: '160004' }]);
  if (sql === 'SHOW server_encoding') return rows([{ server_encoding: 'UTF8' }]);
  if (FOUND.test(sql)) return rows([FOUND_ROW]);
  if (VERSION.test(sql)) return rows([{ value: JSON.stringify({ v: pg.SCHEMA_VERSION }) }]);
  if (STORE_ID.test(sql)) return rows([{ value: '"S"' }]);
  return rows([]);
}

interface Script {
  connectAfterMs?: number;
  connectHangs?: boolean;
  answerAfterMs?: (sql: string) => number;
}

function scripted(script: Script = {}) {
  const sent: Array<{ text: string; values: unknown[]; timeout?: number }> = [];
  const end = vi.fn(async () => undefined);
  const after = <T>(ms: number, value: () => T): Promise<T> =>
    new Promise((resolve, reject) => { setTimeout(() => { try { resolve(value()); } catch (error) { reject(error); } }, ms); });
  const session = () => ({
    connect: () => {
      if (script.connectHangs) return new Promise<never>(() => undefined);
      return script.connectAfterMs === undefined ? Promise.resolve() : after(script.connectAfterMs, () => undefined);
    },
    query: (q: QueryConfig) => {
      const sql = q.text.trim();
      const values = q.values ?? [];
      sent.push({ text: sql, values, timeout: (q as { query_timeout?: number }).query_timeout });
      let wanted = 0;
      for (const match of sql.matchAll(/\$(\d+)/g)) wanted = Math.max(wanted, Number(match[1]));
      const settle = () => {
        if (values.length !== wanted) {
          throw Object.assign(new Error(`bind message supplies ${values.length} parameters, but prepared statement "" requires ${wanted}`), { code: '08P01', severity: 'ERROR' });
        }
        return reply(sql);
      };
      const delay = script.answerAfterMs?.(sql) ?? 0;
      return delay === 0 ? Promise.resolve().then(settle) : after(delay, settle);
    },
    end,
  });
  return { session, sent, end };
}

const check = (s: ReturnType<typeof scripted>) => checkMoveTarget(W, () => 'S', { session: s.session as never });

beforeEach(() => {
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'hrtime', 'performance', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function settled<T>(work: Promise<T>, stepMs: number, steps: number): Promise<T | 'pending'> {
  let out: T | 'pending' = 'pending';
  void work.then(value => { out = value; });
  for (let i = 0; i < steps && out === 'pending'; i += 1) await vi.advanceTimersByTimeAsync(stepMs);
  return out;
}

describe('checkMoveTarget on a matching store', () => {
  it('answers null, sends BEGIN and ROLLBACK with no values, and leaves no timer behind', async () => {
    const s = scripted();
    expect(await check(s)).toBeNull();
    const plain = s.sent.filter(q => q.text === 'BEGIN' || q.text === 'ROLLBACK');
    expect(plain.map(q => q.text)).toEqual(['BEGIN', 'ROLLBACK']);
    expect(plain.map(q => q.values)).toEqual([[], []]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for a connect that takes 2 s and answers null', async () => {
    const s = scripted({ connectAfterMs: 2 * SECOND });
    expect(await settled(check(s), SECOND, 10)).toBeNull();
    expect(s.sent[0]?.text).toBe('BEGIN');
  });

  it('a connect that never completes ends at the 60 s bound of the whole check', async () => {
    const s = scripted({ connectHangs: true });
    let answer: unknown = 'pending';
    void check(s).then(a => { answer = a; });
    await vi.advanceTimersByTimeAsync(60 * SECOND - 10);
    expect(answer).toBe('pending');
    await vi.advanceTimersByTimeAsync(20);
    expect(answer).toBe(OVER_BOUND);
    expect(s.sent).toEqual([]);
  });
});

describe('the statement floor: no statement is sent with less than 1 s of the check left', () => {
  it('with 0.5 s left, the next statement is not sent and the check ends at its own bound', async () => {
    const s = scripted({ answerAfterMs: sql => (sql === 'BEGIN' ? 39_700 : sql === 'SHOW server_version_num' ? 19_800 : 0) });
    const answer = await settled(check(s), 100, 700);
    expect(answer).toBe(OVER_BOUND);
    expect(s.sent.map(q => q.text)).toEqual(['BEGIN', 'SHOW server_version_num']);
  });

  it('with exactly 1 s left, the next statement is sent with a 1 s bound and the check completes', async () => {
    const s = scripted({ answerAfterMs: sql => (sql === 'BEGIN' ? 39_000 : sql === 'SHOW server_version_num' ? 20_000 : 0) });
    const answer = await settled(check(s), 1000, 70);
    expect(answer).toBeNull();
    expect(s.sent.length).toBeGreaterThan(3);
    expect(s.sent[2]?.timeout).toBe(1000);
    expect(s.sent.at(-1)?.text).toBe('ROLLBACK');
  });
});
