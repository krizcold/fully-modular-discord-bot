import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClaimFailure, ClaimStore } from '../../src/bot/internalSetup/fleet/claimStore';
import { claimTimings } from '../../src/bot/internalSetup/fleet/claimRules';

// NB4 decisions 2, 10 and 12 on the claims store: what the take and the release write and answer. The pool is a fake
// that keeps the two tables and answers each statement as the real SQL would over them.

const T = claimTimings(30);
const me = { processId: 'p-a', nodeId: 'n-a', nodeName: 'A' };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface Row {
  shard_count: number; shard_id: number; claim: number; holder_process: string; holder_node: string; holder_name: string;
  home_node: string; released: boolean; reserved: boolean; renewed_at: number; ttl_ms: number; expires_up_ms: number;
}

interface Node {
  node_id: string; node_name: string; process_id: string; capacity: number; takeover_seconds: number; fit: boolean;
  restartable: boolean; returns: boolean; seen_ago_ms: number; healthy_for_ms: number | null;
}

interface Sent { text: string; values: unknown[] }

interface DbOptions {
  count?: number | null;
  upMs?: number;
  uPrimeMs?: number;
  rows?: Partial<Row>[];
  nodes?: Partial<Node>[];
  floor?: string | Error;
  nextval?: string[];
  delay?: { match: RegExp; ms: number };
  hang?: RegExp;
}

function row(r: Partial<Row>): Row {
  return {
    shard_count: 2, shard_id: 0, claim: 1, holder_process: 'p-b', holder_node: 'n-b', holder_name: 'B', home_node: 'n-b',
    released: false, reserved: false, renewed_at: 0, ttl_ms: T.ttlMs, expires_up_ms: 1_000_000, ...r,
  };
}

function node(n: Partial<Node>): Node {
  return {
    node_id: 'n-b', node_name: 'B', process_id: 'p-b', capacity: 2, takeover_seconds: 30, fit: true, restartable: true,
    returns: true, seen_ago_ms: 0, healthy_for_ms: 400_000, ...n,
  };
}

const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

function fakeDb(opts: DbOptions) {
  const upMs = opts.upMs ?? 1000;
  const uPrimeMs = opts.uPrimeMs ?? 1500;
  const rows = (opts.rows ?? []).map(row);
  const nodes = (opts.nodes ?? []).map(node);
  const sent: Sent[] = [];
  const released: Array<boolean | undefined> = [];
  const asRaw = (r: Row) => ({
    ...r, claim: String(r.claim), ttl_ms: String(r.ttl_ms), expires_up_ms: String(r.expires_up_ms), taken_at: 0,
    extended: false, renewed_ago_ms: 0,
  });
  const answer = (text: string, values: unknown[]): { rows: any[] } | Error | 'hang' => {
    if (opts.hang?.test(text)) return 'hang';
    if (/^\s*WITH clk AS/.test(text)) {
      const [proc, nodeId, nodeName, ttl] = values as [string, string, string, number];
      const resCounts = arr(values[4]); const resIds = arr(values[5]); const resClaims = arr(values[6]);
      const handIds = arr(values[7]); const receivers = arr(values[8]);
      const out: any[] = [];
      for (const r of rows) {
        if (r.holder_process !== proc) continue;
        const reserved = resIds.some((id, i) => id === r.shard_id && resCounts[i] === r.shard_count && resClaims[i] === r.claim);
        if (r.released && !reserved) continue;
        const h = handIds.indexOf(r.shard_id);
        const recv = h >= 0 && !r.released ? nodes.find(n => n.node_id === receivers[h]) : undefined;
        out.push({ shard_id: r.shard_id, claim: String(r.claim), was_released: r.released, handed_to: recv ? recv.node_name : null });
        r.released = true; r.reserved = false;
        r.holder_node = recv ? recv.node_id : nodeId; r.holder_name = recv ? recv.node_name : nodeName;
        r.ttl_ms = recv ? recv.takeover_seconds * 1000 : ttl; r.expires_up_ms = uPrimeMs + r.ttl_ms;
      }
      return { rows: out };
    }
    if (/^\s*(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(text) || text.trim() === '') return { rows: [] };
    if (/pg_advisory_xact_lock/.test(text)) return { rows: [{}] };
    if (/FROM smdb_data\.claim_clock WHERE id = 1\s*$/.test(text)) return { rows: [{ up_ms: String(upMs), u_prime: String(uPrimeMs), now_ms: 0 }] };
    if (/FROM smdb_data\.meta/.test(text)) return { rows: opts.count == null ? [] : [{ value: JSON.stringify({ count: opts.count }) }] };
    if (/AS renewed_ago_ms FROM smdb_data\.shard_claims\s*$/.test(text)) return { rows: rows.map(asRaw) };
    if (/FROM smdb_data\.shard_nodes\s*$/.test(text)) return { rows: nodes };
    if (/AS floor/.test(text)) return opts.floor instanceof Error ? opts.floor : { rows: [{ floor: opts.floor ?? '0' }] };
    if (/nextval/.test(text)) {
      const k = Number(values[0]);
      const list = opts.nextval ?? Array.from({ length: k }, (_, i) => String(100 + i));
      return { rows: list.map(n => ({ n })) };
    }
    if (/setval/.test(text)) return { rows: [{}] };
    if (/^\s*INSERT INTO smdb_data\.shard_claims/.test(text)) {
      const ids = arr(values[1]); const claims = arr(values[2]);
      const out: any[] = [];
      ids.forEach((id, i) => {
        if (rows.some(r => r.shard_count === values[0] && r.shard_id === id)) return;
        rows.push(row({
          shard_count: values[0] as number, shard_id: id, claim: claims[i], holder_process: values[3] as string,
          holder_node: values[4] as string, holder_name: values[5] as string, home_node: values[4] as string,
          released: values[6] as boolean, reserved: values[6] as boolean, ttl_ms: values[7] as number, expires_up_ms: values[8] as number,
        }));
        out.push({ shard_id: id, claim: String(claims[i]) });
      });
      return { rows: out };
    }
    if (/^\s*UPDATE smdb_data\.shard_claims c/.test(text)) {
      const ids = arr(values[1]); const claims = arr(values[2]); const oldClaims = arr(values[9]); const oldHolders = arr(values[10]);
      const out: any[] = [];
      ids.forEach((id, i) => {
        const r = rows.find(x => x.shard_count === values[0] && x.shard_id === id && x.claim === oldClaims[i] && x.holder_process === oldHolders[i]);
        if (!r) return;
        const takeable = r.expires_up_ms <= (values[11] as number) || (r.released && r.holder_node === values[4]) || r.holder_process === values[3];
        if (!takeable) return;
        Object.assign(r, {
          claim: claims[i], holder_process: values[3], holder_node: values[4], holder_name: values[5], released: values[6],
          reserved: values[6], ttl_ms: values[7], expires_up_ms: values[8],
        });
        out.push({ shard_id: id, claim: String(claims[i]) });
      });
      return { rows: out };
    }
    return { rows: [] };
  };
  const client = {
    query(config: any, given?: unknown[]) {
      const text: string = typeof config === 'string' ? config : config.text;
      const values = (typeof config === 'string' ? given : config.values) ?? [];
      sent.push({ text, values });
      const a = answer(text, values);
      if (a === 'hang') return new Promise(() => undefined);
      if (a instanceof Error) return Promise.reject(a);
      const delay = opts.delay && opts.delay.match.test(text) ? opts.delay.ms : 0;
      if (delay > 0) return new Promise(resolve => { setTimeout(() => resolve({ rows: a.rows, rowCount: a.rows.length }), delay); });
      return Promise.resolve({ rows: a.rows, rowCount: a.rows.length });
    },
    release(destroy?: boolean) { released.push(destroy); },
  };
  const pool = { async connect() { return client; }, async end() { /* nothing open */ }, on() { return pool; } };
  const store = new ClaimStore('postgres://nobody@127.0.0.1:1/none', T);
  void (store as any).pool.end().catch(() => undefined);
  (store as any).pool = pool;
  const statements = () => sent.map(s => s.text.trim());
  const find = (re: RegExp) => sent.filter(s => re.test(s.text));
  return { store, rows, sent, statements, find, released };
}

const INSERT = /^\s*INSERT INTO smdb_data\.shard_claims/;
const UPDATE = /^\s*UPDATE smdb_data\.shard_claims c/;

function take(over: Partial<Parameters<ClaimStore['take']>[0]> = {}) {
  return { me, capacity: 2, ttlMs: T.ttlMs, boot: false, known: [], localCount: 2, reserve: false, ...over };
}

describe('decision 10 (b): the predecessor rows a boot take reports', () => {
  const rows: Partial<Row>[] = [
    { shard_count: 4, shard_id: 0, holder_node: 'n-a', holder_process: 'p-old', renewed_at: 111 },
    { shard_count: 4, shard_id: 1, holder_node: 'n-b', holder_process: 'p-b', renewed_at: 222 },
    { shard_count: 4, shard_id: 2, holder_node: 'n-a', holder_process: 'p-a', renewed_at: 333 },
    { shard_count: 4, shard_id: 3, holder_node: 'n-a', holder_process: 'p-old', released: true, renewed_at: 444 },
  ];

  it('at boot, only an unreleased row of this node naming another process is a predecessor row, with its renewed_at', async () => {
    const db = fakeDb({ count: 4, rows });
    const answer = await db.store.take(take({ boot: true, localCount: 4, capacity: 4 }));
    expect(answer.kind).toBe('done');
    if (answer.kind !== 'done') return;
    expect([...answer.predecessorRenewedAt.entries()]).toEqual([[0, 111]]);
    expect(answer.plan.wait?.shardIds).toEqual([0]);
  });
});

describe('decision 10: what the take writes', () => {
  it('a take with nothing takeable draws no claim number, so a failing floor read cannot fail it', async () => {
    const db = fakeDb({ count: 1, rows: [{ shard_count: 1, shard_id: 0 }], floor: new Error('floor read failed') });
    const answer = await db.store.take(take({ localCount: 1 }));
    expect(answer.kind === 'done' && answer.taken).toEqual([]);
    expect(db.find(/nextval|AS floor/)).toEqual([]);
  });

  it('an expired row and a missing row: the expired one re-taken pinned to its claim and holder, the new one inserted, both expiring at u\' + TTL', async () => {
    const db = fakeDb({
      count: 2, upMs: 1000, uPrimeMs: 1500, floor: '7',
      rows: [{ shard_count: 2, shard_id: 0, claim: 7, holder_process: 'p-b', expires_up_ms: 100 }],
    });
    const answer = await db.store.take(take());
    expect(answer.kind === 'done' && answer.taken).toEqual([
      { pair: { shardCount: 2, shardId: 0, claim: 100 }, above: null },
      { pair: { shardCount: 2, shardId: 1, claim: 101 }, above: null },
    ]);
    expect(db.rows.map(r => [r.shard_id, r.claim, r.holder_process, r.holder_node, r.expires_up_ms])).toEqual([
      [0, 100, 'p-a', 'n-a', 1500 + T.ttlMs],
      [1, 101, 'p-a', 'n-a', 1500 + T.ttlMs],
    ]);
    const inserts = db.find(INSERT);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].values[1]).toEqual([1]);
    expect(inserts[0].values[8]).toBe(1500 + T.ttlMs);
    const updates = db.find(UPDATE);
    expect(updates).toHaveLength(1);
    expect(updates[0].values).toEqual([2, [0], [100], 'p-a', 'n-a', 'A', false, T.ttlMs, 1500 + T.ttlMs, [7], ['p-b'], 1000]);
    expect(db.find(/setval/)).toEqual([]);
  });

  it('a take of only expired rows sends no INSERT', async () => {
    const db = fakeDb({ count: 1, rows: [{ shard_count: 1, shard_id: 0, claim: 3, expires_up_ms: 100 }] });
    const answer = await db.store.take(take({ localCount: 1 }));
    expect(answer.kind === 'done' && answer.taken.map(t => t.pair)).toEqual([{ shardCount: 1, shardId: 0, claim: 100 }]);
    expect(db.find(INSERT)).toEqual([]);
  });

  it('a take of only missing rows sends no UPDATE', async () => {
    const db = fakeDb({ count: 1 });
    const answer = await db.store.take(take({ localCount: 1 }));
    expect(answer.kind === 'done' && answer.taken.map(t => t.pair)).toEqual([{ shardCount: 1, shardId: 0, claim: 100 }]);
    expect(db.find(UPDATE)).toEqual([]);
  });
});

describe('decision 2: the claim numbers the take draws', () => {
  it('a draw with any number at or below the floor is rebased above the highest of floor and draw, and the sequence set to the last', async () => {
    const db = fakeDb({ count: 2, floor: '5', nextval: ['1', '10'] });
    const answer = await db.store.take(take());
    expect(answer.kind === 'done' && answer.taken.map(t => t.pair.claim)).toEqual([11, 12]);
    const setvals = db.find(/setval/);
    expect(setvals).toHaveLength(1);
    expect(setvals[0].values).toEqual([12]);
  });

  it('a draw with fewer numbers than shards is refused: no row written, rolled back, the reason named', async () => {
    const db = fakeDb({ count: 2, nextval: ['40'] });
    const error = await db.store.take(take()).catch(e => e);
    expect(error).toBeInstanceOf(ClaimFailure);
    expect(error.message).toBe('unreachable: drew 1 claim numbers for 2 shards');
    expect(db.find(INSERT)).toEqual([]);
    expect(db.statements()).toContain('ROLLBACK');
    expect(db.rows).toEqual([]);
  });

  it('a claim number 0 is refused even above the floor: no row written, the number named', async () => {
    const db = fakeDb({ count: 1, floor: '-1', nextval: ['0'] });
    const error = await db.store.take(take({ localCount: 1 })).catch(e => e);
    expect(error).toBeInstanceOf(ClaimFailure);
    expect(error.message).toBe('unreachable: unusable claim number 0');
    expect(db.find(INSERT)).toEqual([]);
    expect(db.rows).toEqual([]);
  });
});

describe('decision 12: the release', () => {
  const receiver = { node_id: 'n-b', node_name: 'B', capacity: 2 };
  const held = { shard_count: 2, shard_id: 0, claim: 5, holder_process: 'p-a', holder_node: 'n-a', home_node: 'n-a' };
  const reservation = { shard_count: 2, shard_id: 1, claim: 6, holder_process: 'p-a', holder_node: 'n-a', released: true, reserved: true };
  const request = {
    me, reserved: [{ shardCount: 2, shardId: 1, claim: 6 }], handOvers: [{ shardId: 0, receiver: 'n-b', move: false }], ttlMs: T.ttlMs,
  };

  it('releases the held pair to a receiver with room and the listed reservation kept for this node, and answers both', async () => {
    const db = fakeDb({ rows: [held, reservation], nodes: [receiver] });
    const answer = await db.store.release(request);
    expect(answer).toEqual([
      { shardId: 0, claim: 5, wasReserved: false, handedTo: 'B' },
      { shardId: 1, claim: 6, wasReserved: true, handedTo: null },
    ]);
    expect(db.rows.map(r => [r.shard_id, r.released, r.reserved, r.holder_node])).toEqual([[0, true, false, 'n-b'], [1, true, false, 'n-a']]);
  });

  it('a receiver whose live rows fill its capacity gets nothing: the pair is kept for this node', async () => {
    const full = { shard_count: 2, shard_id: 2, claim: 9, holder_process: 'p-b', holder_node: 'n-b', expires_up_ms: 99_999 };
    const db = fakeDb({ rows: [held, full], nodes: [{ ...receiver, capacity: 1 }] });
    const answer = await db.store.release({ ...request, reserved: [] });
    expect(answer).toEqual([{ shardId: 0, claim: 5, wasReserved: false, handedTo: null }]);
    expect(db.rows[0].holder_node).toBe('n-a');
  });

  it('runs as one transaction: BEGIN, then lock_timeout set to S, then the lock, the release statement, COMMIT', async () => {
    const db = fakeDb({ rows: [held], nodes: [receiver] });
    await db.store.release({ ...request, reserved: [] });
    const s = db.statements();
    expect(s[0]).toBe('BEGIN');
    expect(s[1]).toBe(`SET LOCAL lock_timeout = ${Math.floor(T.statementMs)}`);
    expect(s[1]).toBe('SET LOCAL lock_timeout = 1500');
    expect(s[2]).toMatch(/pg_advisory_xact_lock/);
    expect(s.at(-1)).toBe('COMMIT');
  });

  it('its 2 s bound counts from the start of the release, not from the process start', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(1_000_000);
    const db = fakeDb({ rows: [held], nodes: [receiver], delay: { match: /^\s*WITH clk AS/, ms: 30 } });
    const answer = await db.store.release({ ...request, reserved: [] });
    expect(answer).toEqual([{ shardId: 0, claim: 5, wasReserved: false, handedTo: 'B' }]);
  });

  it('a release with no answer in 2 s fails as a timeout whose cause names the release', async () => {
    vi.useFakeTimers();
    const db = fakeDb({ rows: [held], hang: /pg_advisory_xact_lock/ });
    const done = db.store.release({ ...request, reserved: [] }).catch(e => e);
    await vi.advanceTimersByTimeAsync(2000);
    const error = await done;
    expect(error).toBeInstanceOf(ClaimFailure);
    expect(error.message).toBe('timeout');
    expect((error.cause as Error).message).toBe('the release got no answer in time');
  });
});
