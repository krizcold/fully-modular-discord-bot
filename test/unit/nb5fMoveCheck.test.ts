import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientConfig, QueryConfig } from 'pg';

import * as pg from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import * as shape from '../../src/bot/internalSetup/utils/dataBackends/storeShape';
import { MainChooser, type ProbeAnswer } from '../../src/bot/internalSetup/utils/dataBackends/mainDatabase';
import { parseAddressList, showEntry } from '../../src/utils/databaseAddress';
import { fixedChooser } from '../helpers/fixedDatabase';

const { PostgresBackend, checkMoveTarget } = pg;

// NB5F decisions 3 and 4: the move's check of its target runs NB16's check of a store (inspectStore) in one
// transaction it rolls back, then the store id step. The session is scripted in nb16Provision.test.ts's form: the
// found list and catalog rows are built as that file builds them (foundRow, fr, relRow and colRow, copied here), the
// rows readFoundList and readCatalog read from a store the bot provisioned.

const A = 'postgres://bot@a:5432/bot';
const W = 'postgres://bot@w:5432/bot';
const SECOND = 1000;

type Row = Record<string, unknown>;
type Which = 'relations' | 'columns' | 'constraints' | 'rules';

const FOUND = /has_database_privilege/;
const VERSION = /^SELECT value::text FROM ONLY smdb_data\.meta WHERE key = 'schema_version'/;
const STORE_ID = /^SELECT value FROM ONLY smdb_data\.meta WHERE key = 'store_id'$/;
const SCRATCH = /^CREATE SCHEMA IF NOT EXISTS smdb_shape_[0-9a-f]{12}$/;

function whichCatalog(sql: string): Which | null {
  if (/pg_get_partkeydef/.test(sql)) return 'relations';
  if (/format_type/.test(sql)) return 'columns';
  if (/pg_get_constraintdef/.test(sql)) return 'constraints';
  if (/pg_get_triggerdef/.test(sql)) return 'rules';
  return null;
}

function fr(name: string, kind: string, extra: Row = {}): Row {
  const table = ['r', 'p', 'v', 'm', 'f'].includes(kind);
  const seq = kind === 'S';
  return {
    name, kind, is_partition: false,
    select: table ? true : null, insert: table ? true : null, update: table ? true : null, delete: table ? true : null,
    usage: seq ? true : null, update_seq: seq ? true : null, ...extra,
  };
}
const GOOD_META = { kind: 'r', key_text: true, value_text: true, value_not_null: true, rls: false, unique_key: true, select: true };
function foundRow(extra: Row = {}): Row {
  return {
    role: 'smdb_bot', db: 'smdb', db_create: true, schema_exists: true, schema_usage: true, schema_create: true,
    relations: [fr('meta', 'r'), fr('meta_pkey', 'i')], meta: GOOD_META, ...extra,
  };
}
const EMPTY_FOUND = { role: 'smdb_bot', db: 'smdb', db_create: true, schema_exists: false, schema_usage: null, schema_create: null, relations: [], meta: null };
function relRow(name: string, kind: string, extra: Row = {}): Row {
  return {
    name, kind, persistence: 'p', is_partition: false, rls: false, force_rls: false,
    access_method: kind === 'r' ? 'heap' : null, partition_key: null, bound: null, parent: null, inherits: [],
    index_def: null, index_valid: null, index_table: null, seq_increment: null, seq_min: null, seq_max: null,
    seq_cache: null, seq_cycle: null, ...extra,
  };
}
function colRow(rel: string, name: string, type: string, notNull: boolean, extra: Row = {}): Row {
  return {
    rel, name, type, not_null: notNull, default_expr: null, identity: '', generated: '', generated_expr: null,
    collation: type === 'text' ? '"default"' : null, storage: type === 'text' ? 'x' : 'p', not_null_validated: null, ...extra,
  };
}
const CURRENT = [{ value: JSON.stringify({ v: pg.SCHEMA_VERSION }) }];

interface Script {
  versionNum?: string;
  encoding?: string;
  found?: Row;
  version?: Row[];
  catalog?: (schema: string, which: Which) => Row[];
  storeId?: Row[];
  fail?: (sql: string) => Error | undefined;
  hang?: (sql: string) => boolean;
  answerAfterMs?: number;
}

function scripted(script: Script) {
  const sent: string[] = [];
  const timeouts: Array<number | undefined> = [];
  const configs: ClientConfig[] = [];
  const end = vi.fn(async () => undefined);
  const reply = (sql: string, args: unknown[] | undefined): { rows: Row[]; rowCount: number } => {
    const rows = (r: Row[]) => ({ rows: r, rowCount: r.length });
    if (sql === 'SHOW server_version_num') return rows([{ server_version_num: script.versionNum ?? '160004' }]);
    if (sql === 'SHOW server_encoding') return rows([{ server_encoding: script.encoding ?? 'UTF8' }]);
    if (FOUND.test(sql)) return rows([script.found ?? foundRow()]);
    if (VERSION.test(sql)) return rows(script.version ?? CURRENT);
    if (STORE_ID.test(sql)) return rows(script.storeId ?? [{ value: '"S"' }]);
    const which = whichCatalog(sql);
    if (which) return rows(script.catalog?.(String(args?.[0]), which) ?? []);
    return rows([]);
  };
  const session = (config: ClientConfig) => {
    configs.push(config);
    return {
      connect: async () => undefined,
      query: (q: QueryConfig) => {
        const sql = q.text.trim();
        sent.push(sql);
        timeouts.push((q as { query_timeout?: number }).query_timeout);
        const failure = script.fail?.(sql);
        if (script.hang?.(sql)) return new Promise<never>(() => undefined);
        const settle = () => {
          if (failure) throw failure;
          return reply(sql, q.values);
        };
        if (script.answerAfterMs === undefined) return Promise.resolve().then(settle);
        return new Promise((resolve, reject) => {
          setTimeout(() => { try { resolve(settle()); } catch (error) { reject(error); } }, script.answerAfterMs);
        });
      },
      end,
    };
  };
  return { session, sent, timeouts, configs, end };
}

const check = (s: ReturnType<typeof scripted>, marker: string | null = 'S') =>
  checkMoveTarget(W, () => marker, { session: s.session as never });
const reasonOf = (answer: unknown): unknown => (answer !== null && typeof answer === 'object' ? (answer as { reason: string }).reason : answer);
const foundList = (row: Row) => shape.readFoundList({ query: async () => ({ rows: [row] }) });
const writes = (sent: string[]) => sent.filter(s => /^(COMMIT|INSERT|UPDATE|DELETE|ALTER|DROP)\b/.test(s));

beforeEach(() => {
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('C1: a store that matches', () => {
  it('answers null: BEGIN, the store check in NB16 order, the store id read FROM ONLY, ROLLBACK; no COMMIT, no INSERT, no CREATE outside the savepoint; one end', async () => {
    const s = scripted({});
    expect(await check(s)).toBeNull();
    expect(s.sent[0]).toBe('BEGIN');
    expect(s.sent.slice(1, 6)).toEqual([
      'SHOW server_version_num',
      'SET LOCAL search_path = pg_catalog',
      'SET LOCAL quote_all_identifiers = off',
      'SET LOCAL default_table_access_method = heap',
      'SHOW server_encoding',
    ]);
    expect(FOUND.test(s.sent[6])).toBe(true);
    expect(VERSION.test(s.sent[7])).toBe(true);
    expect(s.sent[8]).toBe('SAVEPOINT shape');
    expect(SCRATCH.test(s.sent[9])).toBe(true);
    const back = s.sent.indexOf('ROLLBACK TO SAVEPOINT shape');
    expect(s.sent.slice(back)).toEqual([
      'ROLLBACK TO SAVEPOINT shape',
      'RELEASE SAVEPOINT shape',
      "SELECT value FROM ONLY smdb_data.meta WHERE key = 'store_id'",
      'ROLLBACK',
    ]);
    expect(writes(s.sent)).toEqual([]);
    const outside = [...s.sent.slice(0, 8), ...s.sent.slice(back)];
    expect(outside.filter(x => /^CREATE\b/.test(x))).toEqual([]);
    expect(s.sent.filter(x => /^CREATE\b/.test(x) && /smdb_data\./.test(x))).toEqual([]);
    expect(s.sent.filter(x => /smdb_data\.meta/.test(x) && !/FROM ONLY smdb_data\.meta/.test(x) && !FOUND.test(x))).toEqual([]);
    expect(s.end).toHaveBeenCalledTimes(1);
    expect(s.configs[0]).toMatchObject({
      application_name: 'smdb-move-check', connectionTimeoutMillis: 5_000, statement_timeout: 30_000,
      idle_in_transaction_session_timeout: 10_000, keepAlive: true, host: 'w', database: 'bot',
    });
    expect(s.timeouts.every(t => typeof t === 'number' && t > 0 && t <= pg.ANSWER_BOUND_MS)).toBe(true);
  });
});

describe('C2: each refusal answers its reason and ends in ROLLBACK and one end', () => {
  const graveyardNullable = (schema: string, which: Which): Row[] => {
    if (which === 'relations') return [relRow('meta', 'r'), relRow('guild_data_graveyard', 'r')];
    if (which === 'columns') return [colRow('guild_data_graveyard', 'reason', 'text', schema !== 'smdb_data')];
    return [];
  };
  const insertLacking = foundRow({ relations: [fr('meta', 'r'), fr('guild_data', 'p', { insert: false })] });
  const cases: Array<[string, Script, string | null, () => Promise<string> | string]> = [
    ['a server older than 13 (120017)', { versionNum: '120017' }, 'S', () => shape.serverVersionRefusal('12.17').reason],
    ['encoding LATIN1', { encoding: 'LATIN1' }, 'S', () => shape.encodingRefusal('LATIN1').reason],
    ['the gate: no CREATE on the database', { found: foundRow({ db_create: false }) }, 'S',
      async () => shape.gateRefusal(await foundList(foundRow({ db_create: false })))!.reason],
    ['schema version {"v":5}', { version: [{ value: '{"v":5}' }] }, 'S',
      () => 'the database holds schema version {"v":5}, and this bot reads only version 8'],
    ['an empty found list', { found: EMPTY_FOUND }, 'S',
      () => "the database holds no tables in smdb_data, so it holds no copy of this bot's store; a move does not provision a database"],
    ['no version row', { version: [] }, 'S',
      async () => shape.unversionedRefusal(await foundList(foundRow()), { differences: [], counted: 0, total: 0 }).reason],
    ['a column difference', { catalog: graveyardNullable }, 'S',
      () => "the database's smdb_data differs from this bot's schema (version 8): smdb_data.guild_data_graveyard column reason allows NULL, where this bot's schema has NOT NULL"],
    ['a missing INSERT on guild_data', {
      found: insertLacking,
      catalog: (_schema, which) => (which === 'relations' ? [relRow('meta', 'r'), relRow('guild_data', 'p', { partition_key: 'HASH (guild_id)' })] : []),
    }, 'S', () => "this bot's database role smdb_bot lacks privileges on smdb_data, which matches this bot's schema (version 8): this bot's database role smdb_bot lacks INSERT on smdb_data.guild_data"],
    ["the scratch's 42501", {
      fail: sql => (SCRATCH.test(sql) ? Object.assign(new Error('permission denied for database smdb'), { severity: 'ERROR', code: '42501' }) : undefined),
    }, 'S', () => shape.scratchRefusal('42501', 'permission denied for database smdb', 'smdb_bot', 'smdb').reason],
    ['no store_id row, S recorded', { storeId: [] }, 'S', () => shape.storeIdRefusal('S').reason],
    ['no store_id row, none recorded', { storeId: [] }, null,
      () => "the database's smdb_data matches this bot's schema (version 8) but smdb_data.meta holds no store_id row, and this machine records no store id, so this bot can't confirm whose store it is; a move writes no store id"],
    ['store_id "T", S recorded', { storeId: [{ value: '"T"' }] }, 'S',
      () => "the configured database is not the one this deployment's data lives in (store T vs recorded S)"],
    ['store_id 5', { storeId: [{ value: '5' }] }, 'S', () => "its store id can't be read (the stored value is not a JSON string)"],
  ];

  it.each(cases)('%s', async (name, script, marker, expected) => {
    const s = scripted(script);
    expect(reasonOf(await check(s, marker))).toBe(await expected());
    expect(s.sent[0]).toBe('BEGIN');
    expect(s.sent.at(-1)).toBe('ROLLBACK');
    expect(s.sent.filter(x => x === 'ROLLBACK')).toHaveLength(1);
    expect(writes(s.sent)).toEqual([]);
    expect(s.end).toHaveBeenCalledTimes(1);
    if (name === 'an empty found list') expect(s.sent.filter(x => /CREATE SCHEMA/.test(x))).toEqual([]);
  });

  it('a refusal with differences answers them as details', async () => {
    const s = scripted({ catalog: graveyardNullable });
    expect(await check(s)).toEqual({
      reason: "the database's smdb_data differs from this bot's schema (version 8): smdb_data.guild_data_graveyard column reason allows NULL, where this bot's schema has NOT NULL",
      details: ['smdb_data.guild_data_graveyard column reason allows NULL, where this bot\'s schema has NOT NULL'],
    });
  });
});

describe('C3 to C5: errors and bounds', () => {
  it('C3: an answered 42501 on the found list: ROLLBACK and T14 with its SQLSTATE', async () => {
    const s = scripted({ fail: sql => (FOUND.test(sql) ? Object.assign(new Error('permission denied for schema smdb_data'), { severity: 'ERROR', code: '42501' }) : undefined) });
    expect(await check(s)).toBe('the check of its store could not be completed (SQLSTATE 42501: permission denied for schema smdb_data)');
    expect(s.sent.at(-1)).toBe('ROLLBACK');
    expect(s.end).toHaveBeenCalledTimes(1);
  });

  it('C4: a 57P01 FATAL on the found list: no ROLLBACK, T14, end called', async () => {
    const s = scripted({ fail: sql => (FOUND.test(sql) ? Object.assign(new Error('terminating connection due to administrator command'), { severity: 'FATAL', code: '57P01' }) : undefined) });
    expect(await check(s)).toBe('the check of its store could not be completed (SQLSTATE 57P01: terminating connection due to administrator command)');
    expect(s.sent).not.toContain('ROLLBACK');
    expect(FOUND.test(s.sent.at(-1)!)).toBe(true);
    expect(s.end).toHaveBeenCalledTimes(1);
  });

  it('C4: a statement that never answers: T14 at 40 s, no ROLLBACK, end called', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'hrtime', 'performance', 'Date'] });
    const s = scripted({ hang: sql => FOUND.test(sql) });
    let answer: unknown = 'pending';
    void check(s).then(a => { answer = a; });
    await vi.advanceTimersByTimeAsync(40 * SECOND - 10);
    expect(answer).toBe('pending');
    await vi.advanceTimersByTimeAsync(20);
    expect(answer).toBe('the check of its store could not be completed (the database did not answer within 40 s)');
    expect(s.sent).not.toContain('ROLLBACK');
    expect(s.end).toHaveBeenCalledTimes(1);
  });

  it('C4: the connect rejected: T14 with the failure, no statement sent, end called once', async () => {
    const s = scripted({});
    const refused = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNREFUSED' });
    const session = (config: ClientConfig) => ({ ...s.session(config), connect: () => Promise.reject(refused) });
    const answer = await checkMoveTarget(W, () => 'S', { session: session as never });
    expect(answer).toBe('the check of its store could not be completed (connect ECONNREFUSED 10.0.0.5:5432)');
    expect(s.sent).toEqual([]);
    expect(s.end).toHaveBeenCalledTimes(1);
  });

  it("C4: pg's own 'Query read timeout' on a statement bounded at 40 s: T14 with 40 s, no ROLLBACK, end called once", async () => {
    const s = scripted({ fail: sql => (sql === 'BEGIN' ? new Error('Query read timeout') : undefined) });
    expect(await check(s)).toBe('the check of its store could not be completed (the database did not answer within 40 s)');
    expect(s.sent).toEqual(['BEGIN']);
    expect(s.timeouts).toEqual([40 * SECOND]);
    expect(s.end).toHaveBeenCalledTimes(1);
  });

  it("C4: pg's own 'Query read timeout' on a statement bounded by the 60 s left: T15, no ROLLBACK, end called once", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'hrtime', 'performance', 'Date'] });
    const s = scripted({ answerAfterMs: 25 * SECOND, hang: sql => sql === 'SHOW server_version_num' });
    const session = (config: ClientConfig) => {
      const base = s.session(config);
      return {
        ...base,
        query: (q: QueryConfig) => {
          const pending = base.query(q);
          if (q.text.trim() !== 'SHOW server_version_num') return pending;
          const bound = (q as { query_timeout?: number }).query_timeout;
          return new Promise<never>((_, reject) => { setTimeout(() => reject(new Error('Query read timeout')), bound); });
        },
      };
    };
    let answer: unknown = 'pending';
    void checkMoveTarget(W, () => 'S', { session: session as never }).then(a => { answer = a; });
    await vi.advanceTimersByTimeAsync(60 * SECOND - 10);
    expect(answer).toBe('pending');
    await vi.advanceTimersByTimeAsync(20);
    expect(answer).toBe('the check of its store did not finish within 60 s');
    expect(s.sent).toEqual(['BEGIN', 'SHOW server_version_num']);
    expect(s.timeouts[1]).toBeLessThan(40 * SECOND);
    expect(s.end).toHaveBeenCalledTimes(1);
  });

  it('C5: statements answering after 39 s each: T15 at 60 s, no ROLLBACK, end called', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'hrtime', 'performance', 'Date'] });
    const s = scripted({ answerAfterMs: 39 * SECOND });
    let answer: unknown = 'pending';
    void check(s).then(a => { answer = a; });
    await vi.advanceTimersByTimeAsync(60 * SECOND - 10);
    expect(answer).toBe('pending');
    await vi.advanceTimersByTimeAsync(20);
    expect(answer).toBe('the check of its store did not finish within 60 s');
    expect(s.sent).toEqual(['BEGIN', 'SHOW server_version_num']);
    expect(s.end).toHaveBeenCalledTimes(1);
  });
});

describe('C6 and C7: useDatabase with the check', () => {
  const backends: InstanceType<typeof PostgresBackend>[] = [];
  afterEach(async () => {
    for (const b of backends.splice(0)) await b.stop();
  });
  function latched() {
    const backend = new PostgresBackend({ chooser: fixedChooser(A) });
    backends.push(backend);
    backend.latch({ kind: 'tie', generation: 2 });
    return backend;
  }
  const steps = (checkTarget: pg.MoveSteps['checkTarget'], extra: Partial<pg.MoveSteps> = {}) => ({
    checkTarget, claims: vi.fn(async () => true), settleRetires: vi.fn(async () => true), moved: vi.fn(), ...extra,
  });

  it('C6: a store with seven differences logs T16 and then the seven difference lines; a second attempt logs nothing', async () => {
    const extra = ['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7'];
    const s = scripted({
      catalog: (schema, which) => (which !== 'relations' ? [] : schema === 'smdb_data'
        ? [relRow('meta', 'r'), ...extra.map(x => relRow(x, 'r'))] : [relRow('meta', 'r')]),
    });
    const backend = latched();
    const moveSteps = steps(entry => checkMoveTarget(entry, () => 'S', { session: s.session as never }));
    const errors = vi.mocked(console.error);
    errors.mockClear();
    expect(await backend.useDatabase(W, moveSteps)).toBe(false);
    const differences = extra.map(x => `smdb_data.${x} (table) is not part of this bot's schema`);
    expect(errors.mock.calls.map(c => String(c[0]))).toEqual([
      `[Database] Not moving to ${showEntry(W)}: the database's smdb_data differs from this bot's schema (version 8): ${differences.slice(0, 5).join('; ')}; and 2 more (the bot's log lists them); this process keeps its unsaved changes and stays stopped`,
      ...differences.map(d => `[PostgresBackend] schema difference: ${d}`),
    ]);
    errors.mockClear();
    expect(await backend.useDatabase(W, moveSteps)).toBe(false);
    expect(errors).not.toHaveBeenCalled();
    expect(moveSteps.claims).not.toHaveBeenCalled();
  });

  it('C7: the exit drain begins while the check is pending: useDatabase false, the pool kept, not moving, the latch kept', async () => {
    const backend = latched();
    const pool = backend.getPool();
    let answer!: (value: null) => void;
    let drained = false;
    const moveSteps = steps(() => new Promise(resolve => { answer = resolve; }), { exitBegan: () => drained });
    const moving = backend.useDatabase(W, moveSteps);
    await Promise.resolve();
    drained = true;
    answer(null);
    expect(await moving).toBe(false);
    expect(backend.getPool()).toBe(pool);
    expect(backend.chosenEntry()).toBe(A);
    expect(backend.isMoving()).toBe(false);
    expect(backend.latchReason()).not.toBeNull();
    expect(moveSteps.claims).not.toHaveBeenCalled();
  });
});

describe('C8: one check at a time (guard)', () => {
  it('confirmNow() during a pending check starts no second check; the next pass follows it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const shown = (entry: string) => parseAddressList(entry)[0].shown;
    const probe = (entry: string, generation: number): ProbeAnswer => ({
      kind: 'answered', address: shown(entry), entry, inRecovery: false, readOnly: false, generation, machine: `node-${generation}`,
      since: '2026-11-01T10:00:00.000Z', sysid: `sys-${entry}`, started: `start-${entry}`, storeId: 'S',
    });
    let list = [A];
    const chooser = new MainChooser({
      entries: () => parseAddressList(list.join(',')),
      probe: async entries => entries.map(e => probe(e.raw, e.raw === A ? 1 : 2)),
      readNotice: async () => ({ kind: 'none' }),
      sendWaitDm: async () => ({ ok: true }),
      markerStoreId: () => 'S',
      noticeCheckOff: () => false,
      nodeName: () => 'node-a',
      onWait: () => undefined,
    });
    expect(await chooser.awaitChoice()).toBe(A);
    const checks: Array<(moved: boolean) => void> = [];
    const backend = {
      databaseEpoch: () => 2,
      chosenEntry: () => A,
      latchReason: () => "can't confirm that a:5432/bot is still the main (another database accepts writes at generation 1)",
      holdWords: () => null,
      connectionState: () => ({ state: 'latched' }),
      isMoving: () => false,
      useDatabase: vi.fn(() => new Promise<boolean>(resolve => { checks.push(resolve); })),
    };
    chooser.attach(backend as never, { stopServing: vi.fn(), report: vi.fn(), markForResave: vi.fn(), startLeave: vi.fn() });
    list = [A, W];
    await vi.advanceTimersByTimeAsync(30 * SECOND);
    expect(backend.useDatabase).toHaveBeenCalledTimes(1);
    chooser.confirmNow();
    await vi.advanceTimersByTimeAsync(20 * SECOND);
    expect(backend.useDatabase).toHaveBeenCalledTimes(1);
    checks[0](false);
    await vi.advanceTimersByTimeAsync(5 * SECOND);
    expect(backend.useDatabase).toHaveBeenCalledTimes(2);
    chooser.stop();
  });
});
