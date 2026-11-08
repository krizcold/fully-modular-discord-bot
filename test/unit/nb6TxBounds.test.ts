import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { ANSWER_BOUND_MS, PostgresBackend, type SharedStatement } from '../../src/bot/internalSetup/utils/dataBackends/postgresBackend';
import { FLUSH_STATEMENT_BYTES, flushBoundMs } from '../../src/bot/internalSetup/utils/storableData';
import { fixedDatabase } from '../helpers/fixedDatabase';
import { type Answer, type Sent, scriptedBackend } from '../helpers/scriptedPg';

// NB6 test 65 (wip-redesign/sheets/NB6.md, C4, C5, C6, D5, D6, D11 and E1): a shared transaction's bounds and places,
// through the real PostgresBackend over scripted clients. Cells 421, 422 and 424 (their transaction halves), 452 to 456.

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

const textBytes = (text: string, values: unknown[]) =>
  Buffer.byteLength(text) + values.reduce<number>((n, v) => n + (Buffer.isBuffer(v) ? v.length : v === null || v === undefined ? 0 : Buffer.byteLength(String(v))), 0);

const boundOf = (s: Sent) => (typeof s.raw === 'string' ? undefined : (s.raw as { query_timeout?: number }).query_timeout);
const valuesOf = (s: Sent): unknown[] => s.params ?? (typeof s.raw === 'string' ? [] : ((s.raw as { values?: unknown[] }).values ?? []));

const op = (id: string): SharedStatement => ({ text: 'INSERT INTO smdb_data.shared_ops (id) VALUES ($1)', values: [id] });
const tx = (backend: PostgresBackend, statements: SharedStatement[]) => backend.sharedTx({ check: null, statements: () => statements });
const READ = 'SELECT bytes FROM smdb_data.shared_module_files WHERE module = $1';
const sleep = (ms = 1) => new Promise(resolve => { setTimeout(resolve, ms); });

/** Named gates: a scripted answer waits on one until the test opens it. */
function gates() {
  const open = new Map<string, () => void>();
  return {
    wait: (key: string) => new Promise<undefined>(resolve => { open.set(key, () => resolve(undefined)); }),
    open: (key: string) => { const go = open.get(key); open.delete(key); go?.(); },
    has: (key: string) => open.has(key),
    keys: () => [...open.keys()],
  };
}

const guildOf = (sent: Sent[], client: number) => {
  const fence = sent.find(s => s.client === client && /INSERT INTO smdb_data\.guild_ownership AS o\b/.test(s.sql));
  return fence ? String(fence.params?.[0]) : null;
};

/** The shared work a client carries: its op id, or 'read' for the module fetch. */
const sharedOf = (sent: Sent[], client: number) => {
  const st = sent.find(s => s.client === client && (s.sql.startsWith('INSERT INTO smdb_data.shared_ops') || s.sql === READ));
  return st ? (st.sql === READ ? 'read' : String(st.params?.[0])) : null;
};

/** Every guild flush gated at its COMMIT, every shared op at its insert and the read at its SELECT. */
function gatedRig() {
  const g = gates();
  const rig: { r?: ReturnType<typeof scripted> } = {};
  const r = scripted((sql, params, _call, client) => {
    if (sql === 'COMMIT') {
      const guild = guildOf(rig.r!.sent, client);
      if (guild !== null) return g.wait(`g${guild}`);
    }
    if (sql.startsWith('INSERT INTO smdb_data.shared_ops')) return g.wait(String(params?.[0]));
    if (sql === READ) return g.wait('read');
    return undefined;
  });
  rig.r = r;
  const live = (kind: 'shared' | 'guild') => {
    const released = new Set(r.releases.map(x => x.client));
    const clients = new Set(r.sent.map(s => s.client));
    return [...clients].filter(c => !released.has(c) && (kind === 'shared' ? sharedOf(r.sent, c) !== null : guildOf(r.sent, c) !== null)).length;
  };
  const flush = (guild: string) => r.backend.flushGuild(guild, { upserts: [{ key: { module: 'm', filename: 'd.json' }, doc: '{}' }], deletes: [], appends: [] }, token);
  return { ...r, g, live, flush };
}

describe('cell 421: the transaction carries its size bound', () => {
  it('sends BEGIN; SET LOCAL statement_timeout = flushBoundMs(largest) as one query, statements with no client bound, COMMIT with 40 s', async () => {
    quiet();
    const { backend, sent } = scripted();
    const body = Buffer.alloc(4 * MIB - 4096, 0x61);
    const upsert: SharedStatement = { text: 'INSERT INTO smdb_data.shared_docs (key, body, sha, rev, updated_by) VALUES ($1, $2, $3, nextval(\'smdb_data.shared_rev_seq\'), $4)', values: ['global/a.json', body, 'f'.repeat(64), 'node-a'] };
    const outcome = await tx(backend, [{ text: 'SELECT pg_advisory_xact_lock(1, 2)', values: [] }, upsert, op('op-1')]);
    expect(outcome).toMatchObject({ kind: 'committed' });
    const ms = flushBoundMs(textBytes(upsert.text, upsert.values));
    expect(sent.map(s => s.sql)).toEqual([`BEGIN; SET LOCAL statement_timeout = ${ms}`, 'SELECT pg_advisory_xact_lock(1, 2)', upsert.text, op('op-1').text, 'COMMIT']);
    expect(sent.slice(0, -1).map(boundOf)).toEqual([undefined, undefined, undefined, undefined]);
    expect(boundOf(sent[sent.length - 1])).toBe(ANSWER_BOUND_MS);
    expect(sent[2].params?.[1]).toBe(body);
  });

  it('answers the results of its statements in order', async () => {
    quiet();
    const { backend } = scripted(sql => (sql.startsWith('SELECT rev') ? { rows: [{ rev: '7' }], rowCount: 1 } : undefined));
    const outcome = await tx(backend, [{ text: 'SELECT rev FROM smdb_data.shared_docs', values: [] }, op('op-1')]);
    expect(outcome.kind === 'committed' && outcome.results.map(r => r.rows)).toEqual([[{ rev: '7' }], []]);
  });
});

describe('cell 422: a statement passes its size bound', () => {
  const timeout = () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014', severity: 'ERROR' });

  function clocked(afterMs: number) {
    let now = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    return scripted(sql => {
      if (!sql.startsWith('INSERT INTO smdb_data.shared_docs')) return undefined;
      now += afterMs;
      return timeout();
    });
  }
  const big: SharedStatement = { text: 'INSERT INTO smdb_data.shared_docs (key, body) VALUES ($1, $2)', values: ['k', Buffer.alloc(4 * MIB - 100, 0x62)] };

  it('at the bound: rolled back, nothing committed, answered with the statement size and the bound', async () => {
    quiet();
    const ms = flushBoundMs(textBytes(big.text, big.values));
    const { backend, sent } = clocked(ms);
    const outcome = await tx(backend, [big, op('op-1')]);
    expect(outcome).toEqual({
      kind: 'failed', step: 'statements', code: '57014', detail: expect.stringContaining('SQLSTATE 57014'),
      timeout: { bytes: textBytes(big.text, big.values), elapsedMs: ms, boundMs: ms, atBound: true },
    });
    expect(sent.map(s => s.sql).slice(-1)).toEqual(['ROLLBACK']);
    expect(sent.some(s => s.sql === 'COMMIT' || s.sql.startsWith('INSERT INTO smdb_data.shared_ops'))).toBe(false);
  });

  it('before the bound: a cancel, atBound false', async () => {
    quiet();
    const { backend } = clocked(2_000);
    const outcome = await tx(backend, [big]);
    expect(outcome).toMatchObject({ kind: 'failed', step: 'statements', code: '57014', timeout: { elapsedMs: 2_000, atBound: false } });
  });
});

describe('the OwnStateRefusal answers (C6)', () => {
  it("'held' at checkout: refused, nothing sent, both places given back", async () => {
    quiet();
    const { backend, sent, connect } = scripted();
    (backend as unknown as { state: string }).state = 'outage';
    const outcome = await tx(backend, [op('op-1')]);
    expect(outcome).toMatchObject({ kind: 'refused', phase: 'held' });
    expect(sent).toEqual([]);
    expect(connect).not.toHaveBeenCalled();
    expect(backend.sharedPlacesInUse()).toEqual({ shared: 0, flush: 0 });
  });

  it("'latched' before COMMIT was sent: refused, COMMIT not sent", async () => {
    quiet();
    const holder = scripted((sql, _p, call) => {
      if (call === 2) holder.backend.latch({ kind: 'tie', generation: 4 });
      return undefined;
    });
    const outcome = await tx(holder.backend, [op('op-1'), op('op-2')]);
    expect(outcome).toMatchObject({ kind: 'refused', phase: 'latched' });
    expect(holder.sent.some(s => s.sql === 'COMMIT')).toBe(false);
  });

  it('a COMMIT answered after the latch rose: the outcome is unknown, never committed', async () => {
    quiet();
    let commitSent = 0;
    const holder = scripted(sql => {
      if (sql === 'COMMIT') holder.backend.latch({ kind: 'tie', generation: 4 });
      return undefined;
    });
    const outcome = await holder.backend.sharedTx({ check: null, statements: () => [op('op-1')], onCommitSent: () => { commitSent += 1; } });
    expect(outcome).toMatchObject({ kind: 'unknown' });
    expect(commitSent).toBe(1);
  });

  it('a COMMIT whose answer is lost: unknown, the COMMIT marked sent', async () => {
    quiet();
    let commitSent = 0;
    const { backend, sent } = scripted(sql => (sql === 'COMMIT' ? Object.assign(new Error('reset'), { code: 'ECONNRESET' }) : undefined));
    const outcome = await backend.sharedTx({ check: null, statements: () => [op('op-1')], onCommitSent: () => { commitSent += 1; } });
    expect(outcome).toMatchObject({ kind: 'unknown' });
    expect(commitSent).toBe(1);
    expect(sent.some(s => s.sql === 'ROLLBACK')).toBe(false);
  });
});

describe('cell 424: guild flushes hold every flush place', () => {
  it('a shared transaction waits first in, first out, holding no client, and starts when a place is given back', async () => {
    quiet();
    const rig = gatedRig();
    const flushes = Array.from({ length: 8 }, (_, i) => rig.flush(String(i + 1)));
    await vi.waitFor(() => expect(rig.g.keys().filter(k => k.startsWith('g'))).toHaveLength(8));
    const shared = tx(rig.backend, [op('op-x')]);
    const ninth = rig.flush('9');
    await sleep(5);
    expect(rig.connect).toHaveBeenCalledTimes(8);
    expect(rig.sent.some(s => s.params?.[0] === 'op-x')).toBe(false);
    rig.g.open('g1');
    await vi.waitFor(() => expect(rig.g.has('op-x')).toBe(true));
    expect(rig.sent.some(s => /guild_ownership AS o\b/.test(s.sql) && s.params?.[0] === '9')).toBe(false);
    rig.g.open('op-x');
    await vi.waitFor(() => expect(rig.g.has('g9')).toBe(true));
    for (const key of rig.g.keys()) rig.g.open(key);
    expect(await shared).toMatchObject({ kind: 'committed' });
    expect((await Promise.all([...flushes, ninth])).every(f => f.ok)).toBe(true);
    expect(rig.backend.sharedPlacesInUse()).toEqual({ shared: 0, flush: 0 });
  });
});

describe('cell 452: one cap of 4 shared places', () => {
  it('6 shared place-takers and 8 guild flushes due: at most 4 shared on the wire, in order, guild flushes keep 4 places', async () => {
    quiet();
    const rig = gatedRig();
    const shared = [
      ...Array.from({ length: 5 }, (_, i) => tx(rig.backend, [op(`op-${i}`)])),
      rig.backend.sharedRead(READ, ['mod']),
    ];
    const flushes = Array.from({ length: 8 }, (_, i) => rig.flush(String(i + 1)));
    await vi.waitFor(() => expect(rig.g.keys()).toHaveLength(8));
    expect(rig.live('shared')).toBe(4);
    expect(rig.live('guild')).toBe(4);
    expect(rig.maxOut()).toBe(8);
    let maxShared = 0;
    let done = false;
    const all = Promise.all([...shared, ...flushes]).finally(() => { done = true; });
    while (!done) {
      const next = rig.g.keys()[0];
      if (next !== undefined) rig.g.open(next);
      await sleep(2);
      maxShared = Math.max(maxShared, rig.live('shared'));
    }
    await all;
    const outcomes = await Promise.all(shared);
    expect(outcomes.slice(0, 5).every(o => o.kind === 'committed')).toBe(true);
    expect(outcomes[5]).toMatchObject({ kind: 'read', rows: [] });
    expect((await Promise.all(flushes)).every(f => f.ok)).toBe(true);
    expect(maxShared).toBeLessThanOrEqual(4);
    expect(rig.maxOut()).toBe(8);
    const order = [...new Set(rig.sent.map(s => s.client))].map(c => sharedOf(rig.sent, c)).filter(k => k !== null);
    expect(order).toEqual(['op-0', 'op-1', 'op-2', 'op-3', 'op-4', 'read']);
  });
});

describe('cell 453: a shared holder waits for a flush place', () => {
  it('holds its shared place and no client, and starts when a flush place is given back', async () => {
    quiet();
    const rig = gatedRig();
    const flushes = Array.from({ length: 8 }, (_, i) => rig.flush(String(i + 1)));
    await vi.waitFor(() => expect(rig.g.keys()).toHaveLength(8));
    const shared = ['a', 'b', 'c', 'd', 'e'].map(k => tx(rig.backend, [op(k)]));
    await sleep(5);
    expect(rig.connect).toHaveBeenCalledTimes(8);
    expect(rig.backend.sharedPlacesInUse()).toEqual({ shared: 4, flush: 8 });
    for (const g of ['g1', 'g2', 'g3', 'g4', 'g5']) rig.g.open(g);
    await vi.waitFor(() => expect(['a', 'b', 'c', 'd'].every(k => rig.g.has(k))).toBe(true));
    await sleep(5);
    expect(rig.g.has('e')).toBe(false);
    expect(rig.live('shared')).toBe(4);
    rig.g.open('a');
    await vi.waitFor(() => expect(rig.g.has('e')).toBe(true));
    for (const key of rig.g.keys()) rig.g.open(key);
    expect((await Promise.all(shared)).every(o => o.kind === 'committed')).toBe(true);
    expect((await Promise.all(flushes)).every(f => f.ok)).toBe(true);
  });
});

describe('E1: both places are given back when sharedTx ends', () => {
  it('after a commit, a rollback, a failed connect, a thrown statement and a refusal', async () => {
    quiet();
    const backend = new PostgresBackend(fixedDatabase('postgres://nobody@127.0.0.1:9/none'));
    backends.push(backend);
    (backend as unknown as { state: string }).state = 'ready';
    let mode: 'ok' | 'connect' | 'throw' | 'stop' = 'ok';
    (backend.getPool() as unknown as { connect: unknown }).connect = async () => {
      if (mode === 'connect') throw new Error('connect ECONNREFUSED');
      return {
        query: async (raw: unknown) => {
          const sql = typeof raw === 'string' ? raw : String((raw as { text: string }).text);
          if (mode === 'throw' && sql.startsWith('INSERT')) throw Object.assign(new Error('boom'), { code: '23505', severity: 'ERROR' });
          return { rows: [], rowCount: 0 };
        },
        release: () => {},
      };
    };
    for (const m of ['ok', 'throw', 'stop', 'connect', 'connect'] as const) {
      mode = m;
      await Promise.all(Array.from({ length: 10 }, (_, i) => backend.sharedTx({
        check: null,
        statements: () => [{ ...op(`op-${i}`), next: m === 'stop' ? () => ({ stop: 'changed' }) : undefined }],
      })));
      expect(backend.sharedPlacesInUse()).toEqual({ shared: 0, flush: 0 });
    }
  });
});

describe('cell 454: an attempt of an op holding unknown ids', () => {
  it('BEGIN with the 30 s server bound, the lock and the SELECT under one 40 s deadline, then the size bound, the statements and COMMIT', async () => {
    quiet();
    const { backend, sent } = scripted(async sql => {
      if (sql.startsWith('SELECT now(), pg_advisory_xact_lock')) await sleep(30);
      return undefined;
    });
    const seen: unknown[] = [];
    const body = Buffer.alloc(MIB, 0x63);
    const upsert: SharedStatement = { text: 'INSERT INTO smdb_data.shared_docs (key, body) VALUES ($1, $2)', values: ['k', body] };
    const outcome = await backend.sharedTx({
      check: [
        { text: 'SELECT now(), pg_advisory_xact_lock(1, 2)', values: [] },
        { text: 'SELECT id FROM smdb_data.shared_ops WHERE id = ANY($1)', values: [['u-1']] },
      ],
      statements: rows => { seen.push(rows?.length); return [upsert, op('op-2')]; },
    });
    expect(outcome).toMatchObject({ kind: 'committed' });
    expect(seen).toEqual([2]);
    const ms = flushBoundMs(textBytes(upsert.text, upsert.values));
    expect(sent.map(s => s.sql)).toEqual([
      'BEGIN; SET LOCAL statement_timeout = 30000', 'SELECT now(), pg_advisory_xact_lock(1, 2)', 'SELECT id FROM smdb_data.shared_ops WHERE id = ANY($1)',
      `SET LOCAL statement_timeout = ${ms}`, upsert.text, op('op-2').text, 'COMMIT',
    ]);
    const [begin, lock, select] = sent.slice(0, 3).map(boundOf) as number[];
    expect(begin).toBeLessThanOrEqual(ANSWER_BOUND_MS);
    expect(lock).toBeLessThanOrEqual(begin);
    expect(select).toBeLessThanOrEqual(ANSWER_BOUND_MS - 25);
    expect(select).toBeGreaterThanOrEqual(1);
    expect(sent.slice(3, 6).map(boundOf)).toEqual([undefined, undefined, undefined]);
    expect(boundOf(sent[6])).toBe(ANSWER_BOUND_MS);
  });

  it('a row found: ROLLBACK, landed, nothing written', async () => {
    quiet();
    const { backend, sent } = scripted(sql => (sql.startsWith('SELECT id FROM smdb_data.shared_ops') ? { rows: [{ id: 'u-1' }], rowCount: 1 } : undefined));
    const outcome = await backend.sharedTx({
      check: [{ text: 'SELECT id FROM smdb_data.shared_ops WHERE id = ANY($1)', values: [['u-1']] }],
      statements: rows => (rows![0].rows.length > 0 ? 'landed' : [op('op-2')]),
    });
    expect(outcome).toEqual({ kind: 'landed' });
    expect(sent.map(s => s.sql)).toEqual(['BEGIN; SET LOCAL statement_timeout = 30000', 'SELECT id FROM smdb_data.shared_ops WHERE id = ANY($1)', 'ROLLBACK']);
  });
});

describe('cell 455: the landing check gets no answer', () => {
  const check: SharedStatement[] = [
    { text: 'SELECT now(), pg_advisory_xact_lock(1, 2)', values: [] },
    { text: 'SELECT id FROM smdb_data.shared_ops WHERE id = ANY($1)', values: [['u-1']] },
  ];

  it('the lock passes its 30 s server bound (57014): ROLLBACK, no answer, nothing written', async () => {
    quiet();
    const { backend, sent } = scripted(sql => (sql.startsWith('SELECT now()')
      ? Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014', severity: 'ERROR' }) : undefined));
    let built = 0;
    const outcome = await backend.sharedTx({ check, statements: () => { built += 1; return [op('op-2')]; } });
    expect(outcome).toMatchObject({ kind: 'failed', step: 'check', code: '57014' });
    expect(built).toBe(0);
    expect(sent.map(s => s.sql)).toEqual(['BEGIN; SET LOCAL statement_timeout = 30000', 'SELECT now(), pg_advisory_xact_lock(1, 2)', 'ROLLBACK']);
    expect(backend.sharedPlacesInUse()).toEqual({ shared: 0, flush: 0 });
  });

  it('the 40 s deadline passes: the client is destroyed, no answer, nothing more sent', async () => {
    quiet();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { backend, sent, releases } = scripted(sql => (sql.startsWith('SELECT now()') ? new Promise(() => {}) : undefined));
    const outcome = backend.sharedTx({ check, statements: () => [op('op-2')] });
    await vi.advanceTimersByTimeAsync(ANSWER_BOUND_MS + 10);
    expect(await outcome).toMatchObject({ kind: 'failed', step: 'check' });
    expect(sent.map(s => s.sql)).toEqual(['BEGIN; SET LOCAL statement_timeout = 30000', 'SELECT now(), pg_advisory_xact_lock(1, 2)']);
    expect(releases).toEqual([{ client: 1, destroyed: true }]);
  });
});

describe('cell 456: a statement with a 4 MiB Buffer value', () => {
  it("bounds by the Buffer's length, not its UTF-8 decoding", async () => {
    quiet();
    const { backend, sent } = scripted();
    const raw = Buffer.alloc(4 * MIB - 200, 0xff);
    const text = 'INSERT INTO smdb_data.shared_docs (key, body, sha) VALUES ($1, $2, $3)';
    expect(await tx(backend, [{ text, values: ['global/b.bin', raw, 'a'.repeat(64)] }])).toMatchObject({ kind: 'committed' });
    const bytes = Buffer.byteLength(text) + Buffer.byteLength('global/b.bin') + raw.length + 64;
    expect(sent[0].sql).toBe(`BEGIN; SET LOCAL statement_timeout = ${flushBoundMs(bytes)}`);
    expect(flushBoundMs(bytes)).toBeLessThan(flushBoundMs(Buffer.byteLength(String(raw))));
  });

  it('a statement over 4 MiB of values is not sent', async () => {
    quiet();
    const { backend, sent, connect } = scripted();
    const outcome = await tx(backend, [{ text: 'INSERT INTO x VALUES ($1, $2)', values: [Buffer.alloc(FLUSH_STATEMENT_BYTES), 'z'] }]);
    expect(outcome).toMatchObject({ kind: 'failed', step: 'build' });
    expect(sent).toEqual([]);
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('statements chosen on an answer', () => {
  it('a stop rolls back and answers its value', async () => {
    quiet();
    const { backend, sent } = scripted(sql => (sql.startsWith('SELECT body') ? { rows: [{ sha: 'other' }], rowCount: 1 } : undefined));
    const outcome = await backend.sharedTx({
      check: null,
      statements: () => [{ text: 'SELECT body, sha FROM smdb_data.shared_docs WHERE key = $1', values: ['k'], next: res => (res.rows[0]?.sha === 'base' ? [op('op-1')] : { stop: 'changed-elsewhere' }) }],
    });
    expect(outcome).toEqual({ kind: 'stopped', value: 'changed-elsewhere' });
    expect(sent.map(s => s.sql).slice(1)).toEqual(['SELECT body, sha FROM smdb_data.shared_docs WHERE key = $1', 'ROLLBACK']);
  });

  it('a chosen statement larger than the bound was set for raises the bound before it is sent', async () => {
    quiet();
    const { backend, sent } = scripted();
    const big: SharedStatement = { text: 'INSERT INTO smdb_data.shared_docs (key, body) VALUES ($1, $2)', values: ['k', Buffer.alloc(2 * MIB)] };
    const small: SharedStatement = { text: 'SELECT body, sha FROM smdb_data.shared_docs WHERE key = $1', values: ['k'], next: () => [big] };
    expect(await tx(backend, [small])).toMatchObject({ kind: 'committed' });
    expect(sent.map(s => s.sql)).toEqual([
      `BEGIN; SET LOCAL statement_timeout = ${flushBoundMs(textBytes(small.text, small.values))}`, small.text,
      `SET LOCAL statement_timeout = ${flushBoundMs(textBytes(big.text, big.values))}`, big.text, 'COMMIT',
    ]);
  });
});

describe("D6: a publish's landing check at once", () => {
  it('COMMIT given up at 40 s: the check runs on a new client while the transaction still holds its places', async () => {
    quiet();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let commits = 0;
    const { backend, sent, releases } = scripted((sql, _p, _c, client) => {
      if (sql === 'COMMIT' && client === 1) { commits += 1; return new Promise(() => {}); }
      if (sql.startsWith('SELECT id FROM smdb_data.shared_ops')) return { rows: [{ id: 'u-1' }], rowCount: 1 };
      return undefined;
    });
    const publish = backend.sharedTx({
      check: null,
      statements: () => [op('u-1')],
      checkAtOnce: [{ text: 'SELECT id FROM smdb_data.shared_ops WHERE id = ANY($1)', values: [['u-1']] }],
    });
    await vi.advanceTimersByTimeAsync(ANSWER_BOUND_MS - 100);
    expect(backend.sharedPlacesInUse()).toEqual({ shared: 1, flush: 1 });
    await vi.advanceTimersByTimeAsync(200);
    const outcome = await publish;
    expect(commits).toBe(1);
    expect(outcome).toMatchObject({ kind: 'unknown', checked: [{ rows: [{ id: 'u-1' }] }] });
    const second = sent.filter(s => s.client === 2).map(s => s.sql);
    expect(second).toEqual(['BEGIN; SET LOCAL statement_timeout = 30000', 'SELECT id FROM smdb_data.shared_ops WHERE id = ANY($1)', 'ROLLBACK']);
    expect(releases[0]).toEqual({ client: 1, destroyed: true });
    expect(backend.sharedPlacesInUse()).toEqual({ shared: 0, flush: 0 });
  });

  it('a check that gets no answer answers checked null', async () => {
    quiet();
    const { backend } = scripted((sql, _p, _c, client) => {
      if (sql === 'COMMIT') return Object.assign(new Error('reset'), { code: 'ECONNRESET' });
      if (client === 2 && sql.startsWith('SELECT id')) return Object.assign(new Error('reset'), { code: 'ECONNRESET' });
      return undefined;
    });
    const outcome = await backend.sharedTx({ check: null, statements: () => [op('u-1')], checkAtOnce: [{ text: 'SELECT id FROM smdb_data.shared_ops WHERE id = ANY($1)', values: [['u-1']] }] });
    expect(outcome).toMatchObject({ kind: 'unknown', checked: null });
  });
});

describe("the module fetch's read (sharedRead)", () => {
  it('runs one SELECT in BEGIN READ ONLY with the 4 MiB bound, each query with a client bound of that plus 10 s', async () => {
    quiet();
    const ms = flushBoundMs(FLUSH_STATEMENT_BYTES);
    const { backend, sent } = scripted(sql => (sql === READ ? { rows: [{ bytes: Buffer.from([0, 1, 2]) }], rowCount: 1 } : undefined));
    const outcome = await backend.sharedRead(READ, ['mod']);
    expect(outcome).toEqual({ kind: 'read', rows: [{ bytes: Buffer.from([0, 1, 2]) }] });
    expect(sent.map(s => s.sql)).toEqual([`BEGIN READ ONLY; SET LOCAL statement_timeout = ${ms}`, READ, 'ROLLBACK']);
    expect(sent.slice(0, 2).map(boundOf)).toEqual([ms + 10_000, ms + 10_000]);
    expect(backend.sharedPlacesInUse()).toEqual({ shared: 0, flush: 0 });
  });

  it("a held backend refuses it before any client is taken", async () => {
    quiet();
    const { backend, connect } = scripted();
    (backend as unknown as { state: string }).state = 'outage';
    expect(await backend.sharedRead(READ, ['mod'])).toMatchObject({ kind: 'refused', phase: 'held' });
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("cell 425 (part 10): the web UI's session, a statement past its bound plus 10 s", () => {
  it('destroys the client, commits nothing and leaves the op queued', async () => {
    quiet();
    const fs = await import('fs');
    const { dataPath } = await import('../../src/utils/dataRoot');
    const dm = await import('../../src/bot/internalSetup/utils/dataManager');
    const store = await import('../../src/bot/internalSetup/utils/sharedStore');
    const { setBackendKind } = await import('../helpers/backendKind');
    const { webuiSessions } = await import('../helpers/nb6WebuiSession');
    const file = dataPath('global', 'nb6txbounds', 'w.json');
    fs.rmSync(dataPath('global', 'nb6txbounds'), { recursive: true, force: true });
    store._resetRowQueue();
    setBackendKind('postgres');
    dm.setGuildDataBackend(null);
    const s = webuiSessions();
    store.useWebuiSessions({
      target: async () => ({ entry: 'postgres://bot:pw@a.example:5432/bot', tag: '1:M', countAtStart: 0 }),
      commitCheck: () => null,
      select: async () => ({ rows: [] }),
      tag: () => '1:M',
      session: config => s.session(config as Record<string, unknown>),
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      s.state.before = sql => (/^SELECT body, sha/.test(sql) ? new Promise(() => {}) : undefined);
      expect(dm.writeRawAtomicTracked(file, '{"w":1}')).toEqual({ accepted: true });
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(s.sent.some(q => /^SELECT body, sha/.test(q.sql))).toBe(true));
      const begin = s.sent[0];
      const bound = Number(/statement_timeout = (\d+)$/.exec(begin.sql)![1]);
      expect(bound).toBe(flushBoundMs(Math.max(...s.sent.map(q => textBytes(q.sql, q.params ?? [])))));
      for (const q of s.sent) expect(q.timeout).toBe(bound + 10_000);
      await vi.advanceTimersByTimeAsync(bound + 10_000);
      const op = store.rowQueue.entryOf('global/nb6txbounds/w.json');
      expect(op?.state).toBe('queued');
      expect(op?.unknown).toEqual([]);
      expect(op?.cause).toBe('Query read timeout');
      expect(s.destroyed).toEqual([1]);
      expect(s.sent.map(q => q.sql)).not.toContain('COMMIT');
      expect(s.rows.docs.size).toBe(0);
    } finally {
      vi.useRealTimers();
      store.useWebuiSessions(null);
      store._resetRowQueue();
      setBackendKind(null);
    }
  });
});

// Part 14: the module rows (cell 423; the transaction halves of cells 459 and 460 and of row 147).
describe('cell 423: a 64 MiB module with a 16 MiB file', () => {
  const INSTALLED = 'global/appstore/installed.json';
  const temps: string[] = [];

  async function moduleRig() {
    const os = await import('os');
    const fs = await import('fs');
    const path = await import('path');
    const dm = await import('../../src/bot/internalSetup/utils/dataManager');
    const modules = await import('../../src/bot/internalSetup/utils/sharedModules');
    const store = await import('../../src/bot/internalSetup/utils/sharedStore');
    const { sharedRows } = await import('../helpers/sharedRows');
    const rows = sharedRows();
    const rigged = scripted(rows.answer);
    store._resetRowQueue();
    dm.setGuildDataBackend(rigged.backend);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nb6mod-'));
    temps.push(root);
    /** A folder written as the App Store's copy writes one: each file whole. */
    const folder = (name: string, files: Record<string, Buffer>) => {
      const dir = path.join(root, name);
      for (const [rel, bytes] of Object.entries(files)) {
        const file = path.join(dir, ...rel.split('/'));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, bytes);
      }
      return dir;
    };
    const readBack = (dir: string) => {
      const out: Record<string, Buffer> = {};
      const walk = (at: string, rel: string) => {
        for (const e of fs.readdirSync(at, { withFileTypes: true })) {
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) walk(path.join(at, e.name), r);
          else out[r] = fs.readFileSync(path.join(at, e.name));
        }
      };
      walk(dir, '');
      return out;
    };
    return { ...rigged, rows, dm, modules, store, root, folder, readBack, fs, path };
  }

  afterEach(async () => {
    const fs = await import('fs');
    const dm = await import('../../src/bot/internalSetup/utils/dataManager');
    const store = await import('../../src/bot/internalSetup/utils/sharedStore');
    dm.setGuildDataBackend(null);
    store.reopenRows();
    store._resetRowQueue();
    for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Bytes that are not text: every value 0 to 255, then a pattern from a seed. */
  const binary = (size: number, seed: number) => {
    const b = Buffer.alloc(size);
    for (let i = 0; i < size; i += 1) b[i] = i < 256 ? i : (i * 31 + seed) & 0xff;
    return b;
  };

  const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
  const moduleSha = (files: Record<string, Buffer>) =>
    sha256(Object.keys(files).sort().map(rel => `${rel}\0${sha256(files[rel])}\n`).join(''));

  function bigModule() {
    const files: Record<string, Buffer> = { 'big.bin': binary(16 * MIB, 7) };
    for (let i = 0; i < 48; i += 1) files[`lib/part${String(i).padStart(2, '0')}.js`] = binary(MIB, i);
    return files;
  }

  it('sends the file rows in batches of at most 4 MiB, the big file as an insert and appends, in one transaction, and answers committed', async () => {
    quiet();
    const r = await moduleRig();
    const files = bigModule();
    const dir = r.folder('m64', files);
    const installed = Buffer.from(JSON.stringify({ m64: { version: '1.0.0' } }));
    const answer = await r.modules.publishModule('m64', dir, installed, 'absent', { operation: 'install', version: '1.0.0' });

    expect(answer).toEqual({ kind: 'committed', sha: moduleSha(files), installedSha: sha256(installed), checked: false });
    expect(new Set(r.sent.map(s => s.client))).toEqual(new Set([1]));
    const sqls = r.sent.map(s => s.sql);
    expect(sqls.filter(s => s.startsWith('BEGIN'))).toHaveLength(1);
    expect(sqls.filter(s => s === 'COMMIT')).toHaveLength(1);
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
    for (const s of r.sent) {
      const values = valuesOf(s).reduce<number>((n, v) => n + (Buffer.isBuffer(v) ? v.length : v === null || v === undefined ? 0 : Buffer.byteLength(String(v))), 0);
      expect(values).toBeLessThanOrEqual(FLUSH_STATEMENT_BYTES);
    }
    // The advisory locks of the module and of installed.json, in the sorted order of the two strings, then the base check.
    expect(r.sent.slice(1, 3).map(s => s.params?.[0])).toEqual([INSTALLED, 'module:m64']);
    expect(sqls[3]).toBe('SELECT sha, updated_by, updated_at FROM smdb_data.shared_docs WHERE key = $1');
    expect(sqls[4]).toBe('DELETE FROM smdb_data.shared_module_files WHERE module = $1');
    const inserts = r.sent.filter(s => s.sql.startsWith('INSERT INTO smdb_data.shared_module_files'));
    const appends = r.sent.filter(s => s.sql.startsWith('UPDATE smdb_data.shared_module_files'));
    expect(inserts.length).toBeGreaterThanOrEqual(13);
    // 4 MiB of values a statement, the module name and rel among them: the 16 MiB file is an insert and four appends.
    expect(appends.map(s => s.params?.[1])).toEqual(['big.bin', 'big.bin', 'big.bin', 'big.bin']);
    const bigInsert = r.sent.findIndex(s => s.sql.startsWith('INSERT INTO smdb_data.shared_module_files') && s.params?.[1] === 'big.bin');
    expect(r.sent[bigInsert].params).toHaveLength(4);
    expect(bigInsert).toBeLessThan(r.sent.findIndex(s => s.sql.startsWith('UPDATE smdb_data.shared_module_files')));

    const stored = r.rows.moduleFiles.get('m64')!;
    expect([...stored.keys()].sort()).toEqual(Object.keys(files).sort());
    for (const [rel, bytes] of Object.entries(files)) expect(stored.get(rel)!.bytes.equals(bytes)).toBe(true);
    expect(r.rows.modules.get('m64')).toMatchObject({ sha: moduleSha(files), version: '1.0.0', file_count: 49, bytes: 64 * MIB });
    expect(r.rows.docs.get(INSTALLED)!.body.equals(installed)).toBe(true);
    expect(r.rows.ops.size).toBe(1);
    expect(r.rows.notices.map(n => JSON.parse(n))).toEqual([
      expect.objectContaining({ k: 'module', module: 'm64', sha: moduleSha(files) }),
      expect.objectContaining({ k: 'doc', key: INSTALLED, sha: sha256(installed) }),
    ]);
  });

  it('the fetch reads the rows back into a new folder byte for byte, at most 4 MiB of file bytes a SELECT', async () => {
    quiet();
    const r = await moduleRig();
    const files = bigModule();
    files['empty.txt'] = Buffer.alloc(0);
    const dir = r.folder('m64', files);
    await r.modules.publishModule('m64', dir, Buffer.from('{}'), 'absent', { operation: 'install' });
    const before = r.sent.length;
    const into = r.path.join(r.root, '.incoming-m64-1');
    const fetched = await r.modules.fetchModule('m64', into);

    expect(fetched).toEqual({ ok: true, sha: moduleSha(files), files: 50, bytes: 64 * MIB });
    const back = r.readBack(into);
    expect(Object.keys(back).sort()).toEqual(Object.keys(files).sort());
    for (const [rel, bytes] of Object.entries(files)) expect(back[rel].equals(bytes)).toBe(true);
    const reads = r.sent.slice(before).filter(s => s.sql.startsWith('SELECT'));
    const sizes = new Map(Object.entries(files).map(([rel, b]) => [rel, b.length]));
    for (const s of reads) {
      if (s.sql.includes('rel = ANY($2)')) expect((valuesOf(s)[1] as string[]).reduce((n, rel) => n + sizes.get(rel)!, 0)).toBeLessThanOrEqual(4 * MIB);
    }
    expect(reads.filter(s => s.sql.startsWith('SELECT substring(bytes FROM $3 FOR 4194304)')).map(s => valuesOf(s)[2])).toEqual([1, 4 * MIB + 1, 8 * MIB + 1, 12 * MIB + 1]);
    // Each SELECT in its own read-only transaction.
    const begins = r.sent.slice(before).filter(s => s.sql.startsWith('BEGIN'));
    expect(begins).toHaveLength(reads.length);
    for (const b of begins) expect(b.sql.startsWith('BEGIN READ ONLY; SET LOCAL statement_timeout = ')).toBe(true);
  });

  it('the fetch refuses a rel that leaves the folder and writes nothing outside it', async () => {
    quiet();
    const r = await moduleRig();
    r.rows.moduleFiles.set('bad', new Map([['../escape.txt', { bytes: Buffer.from('x'), mode: 0o644 }]]));
    const into = r.path.join(r.root, 'nested', '.incoming-bad-1');
    const fetched = await r.modules.fetchModule('bad', into);
    expect(fetched).toEqual({ ok: false, cause: expect.stringContaining('../escape.txt') });
    expect(r.fs.existsSync(r.path.join(r.root, 'nested', 'escape.txt'))).toBe(false);
  });

  it('installed.json changed on another machine: rolled back, refused with that machine and time, nothing stored', async () => {
    quiet();
    const r = await moduleRig();
    r.rows.put(INSTALLED, '{"other":{}}');
    const dir = r.folder('m1', { 'index.js': Buffer.from('module.exports = 1;\n') });
    const answer = await r.modules.publishModule('m1', dir, Buffer.from('{"m1":{}}'), sha256('{}'), { operation: 'update' });
    expect(answer).toEqual({ kind: 'refused', cause: 'changed-elsewhere', by: 'BRAVO', at: r.rows.clock.now });
    expect(r.sent.map(s => s.sql).slice(-1)).toEqual(['ROLLBACK']);
    expect(r.rows.moduleFiles.has('m1')).toBe(false);
    expect(r.rows.ops.size).toBe(0);
  });

  it("cell 459, the transaction half: COMMIT's answer lost, the check at once finds the op: committed", async () => {
    quiet();
    const r = await moduleRig();
    r.rows.fault = sql => (sql === 'COMMIT' ? 'lose' : undefined);
    const dir = r.folder('m2', { 'a.bin': binary(1000, 1) });
    const answer = await r.modules.publishModule('m2', dir, Buffer.from('{"m2":{}}'), 'absent', { operation: 'install' });
    expect(answer).toMatchObject({ kind: 'committed', checked: true });
    const check = r.sent.filter(s => s.client === 2).map(s => s.sql);
    expect(check[0]).toBe('BEGIN; SET LOCAL statement_timeout = 30000');
    expect(check).toContain('SELECT id FROM smdb_data.shared_ops WHERE id = ANY($1)');
  });

  it("cell 459, the transaction half: COMMIT's answer lost and the op not stored: failed, with the lost answer as the cause", async () => {
    quiet();
    const r = await moduleRig();
    const { lost } = await import('../helpers/sharedRows');
    r.rows.fault = (sql, _p, client) => (sql === 'COMMIT' && client === 1 ? lost() : undefined);
    const dir = r.folder('m3', { 'a.bin': binary(1000, 2) });
    const answer = await r.modules.publishModule('m3', dir, Buffer.from('{"m3":{}}'), 'absent', { operation: 'install' });
    expect(answer).toEqual({ kind: 'failed', cause: expect.stringContaining('Connection terminated unexpectedly') });
    expect(r.rows.moduleFiles.has('m3')).toBe(false);
  });

  it("cell 459, the transaction half: COMMIT's answer lost and the check gets no answer: unknown", async () => {
    quiet();
    const r = await moduleRig();
    const { lost } = await import('../helpers/sharedRows');
    r.rows.fault = (sql, _p, client) => (sql === 'COMMIT' ? 'lose' : client > 1 && sql.startsWith('SELECT id') ? lost() : undefined);
    const dir = r.folder('m4', { 'a.bin': binary(1000, 3) });
    const answer = await r.modules.publishModule('m4', dir, Buffer.from('{"m4":{}}'), 'absent', { operation: 'update' });
    expect(answer).toEqual({ kind: 'unknown', cause: expect.stringContaining('Connection terminated unexpectedly') });
  });

  it("cell 460, the transaction half: a statement past its bound ends the publish with T35's module form and cause", async () => {
    const error = quiet();
    let now = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const r = await moduleRig();
    const dir = r.folder('m5', { 'a.bin': binary(2 * MIB, 4) });
    let bound = 0;
    r.rows.fault = sql => {
      const set = /^BEGIN; SET LOCAL statement_timeout = (\d+)$/.exec(sql);
      if (set) bound = Number(set[1]);
      if (!sql.startsWith('INSERT INTO smdb_data.shared_module_files')) return undefined;
      now += bound;
      return Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014', severity: 'ERROR' });
    };
    const answer = await r.modules.publishModule('m5', dir, Buffer.from('{"m5":{}}'), 'absent', { operation: 'install' });
    const insert = r.sent.find(s => s.sql.startsWith('INSERT INTO smdb_data.shared_module_files'))!;
    const kib = Math.ceil(textBytes(insert.sql, insert.params ?? []) / 1024);
    const s = Math.round(bound / 1000);
    expect(answer).toEqual({ kind: 'failed', cause: `a statement of ${kib} KiB did not finish within the ${s} s bound (SQLSTATE 57014)` });
    expect(error.mock.calls.map(c => String(c[0]))).toContain(
      `[Shared] Saving module m5: a statement of ${kib} KiB did not finish within the ${s} s bound (SQLSTATE 57014); a slow link to the database, a slow database or a lock held by another transaction can cause this. Nothing was saved, and the install of m5 ended.`,
    );
    expect(r.rows.moduleFiles.has('m5')).toBe(false);
  });

  it('a deposed process publishes nothing: refused writer-lost', async () => {
    quiet();
    const r = await moduleRig();
    r.store.deposeRows('pid 9');
    const dir = r.folder('m6', { 'a.js': Buffer.from('1') });
    const answer = await r.modules.publishModule('m6', dir, Buffer.from('{}'), 'absent', { operation: 'install' });
    expect(answer).toEqual({ kind: 'refused', cause: 'writer-lost' });
    expect(r.sent).toHaveLength(0);
  });

  it('row 147, the transaction half: unpublish deletes the file rows, the manifest row, the status rows and the credentials doc, and writes installed.json', async () => {
    quiet();
    const r = await moduleRig();
    const dir = r.folder('m7', { 'a.js': Buffer.from('1'), 'b/c.bin': binary(300, 5) });
    const first = Buffer.from('{"m7":{}}');
    await r.modules.publishModule('m7', dir, first, 'absent', { operation: 'install' });
    r.rows.put('global/appstore/credentials/m7.json', '{"KEY":"v"}');
    r.rows.moduleStatus.set('m7', new Map([['node-b', { node_name: 'BRAVO', sha: 'f'.repeat(64), state: 'failed', error: 'it failed', at: '2026-11-07T10:00:00.000Z', process_id: 'p-bravo', seq: 1 }]]));
    r.rows.notices.length = 0;
    const before = r.sent.length;
    const after = Buffer.from('{}');
    const answer = await r.modules.unpublishModule('m7', after, sha256(first));
    expect(answer).toEqual({ kind: 'committed', sha: 'absent', installedSha: sha256(after), checked: false });
    expect(r.sent.slice(before + 1, before + 4).map(s => s.params?.[0])).toEqual(['global/appstore/credentials/m7.json', INSTALLED, 'module:m7']);
    expect(r.rows.moduleFiles.has('m7')).toBe(false);
    expect(r.rows.modules.has('m7')).toBe(false);
    expect(r.rows.moduleStatus.has('m7')).toBe(false);
    expect(r.rows.docs.has('global/appstore/credentials/m7.json')).toBe(false);
    expect(r.rows.docs.get(INSTALLED)!.body.equals(after)).toBe(true);
    expect(r.rows.ops.size).toBe(2);
    expect(r.rows.notices.map(n => JSON.parse(n))).toEqual([
      expect.objectContaining({ k: 'module', module: 'm7', sha: 'absent' }),
      expect.objectContaining({ k: 'doc', key: 'global/appstore/credentials/m7.json', sha: 'absent' }),
      expect.objectContaining({ k: 'doc', key: INSTALLED, sha: sha256(after) }),
    ]);
  });
});
