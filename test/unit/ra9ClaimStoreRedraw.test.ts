import { describe, expect, it } from 'vitest';

import {
  CLOSE_SQL, ClaimFailure, ClaimStore, GATE_DELETE_SQL, GATE_HELD_SQL, GATE_READ_SQL, REDRAW_SQL, TAKE_INSERT_SQL,
} from '../../src/bot/internalSetup/fleet/claimStore';
import { claimTimings } from '../../src/bot/internalSetup/fleet/claimRules';

// ClaimStore over a fake client that answers the redraw's and the first take's statements as Postgres would: each
// statement's parameters bound by number (too few is pg's bind error), an empty statement answers no row.

const T = claimTimings(30);
const ME = { processId: 'p-a', nodeId: 'n-a', nodeName: 'A' };
const UP_MS = 10_000;
const U_PRIME = 10_400;
const ATTEMPT = '11111111-1111-4111-8111-111111111111';

interface Reshard {
  attempt: string | null;
  state: string | null;
  from_count: number | null;
  to_count: number | null;
  target?: number | null;
  target_by?: string | null;
  closed?: boolean;
}

interface Row {
  shard_count: number;
  shard_id: number;
  released: boolean;
  expires_up_ms: number;
  holder_process: string;
  holder_name: string;
  claim: number;
}

interface Db {
  reshard: Reshard | null;
  meta: number | null;
  rows: Row[];
  sent: string[];
  fail?: (text: string) => boolean;
  delay?: (text: string) => number;
  hang?: (text: string) => boolean;
}

function db(over: Partial<Db> = {}): Db {
  return { reshard: null, meta: null, rows: [], sent: [], ...over };
}

function bindError(given: number, wanted: number): Error {
  const error = new Error(`bind message supplies ${given} parameters, but prepared statement "" requires ${wanted}`) as Error & { code: string };
  error.code = '08P01';
  return error;
}

const live = (r: Row, up: number) => !r.released && r.expires_up_ms > up;

function answer(d: Db, text: string, v: any[]): { rows: any[] } {
  const wanted = Math.max(0, ...[...text.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
  if (v.length < wanted) throw bindError(v.length, wanted);
  const t = text.trim();
  if (t === '') return { rows: [] };
  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(t) || t.includes('pg_advisory_xact_lock')) return { rows: [] };
  if (t.startsWith('SELECT up_ms::text AS up_ms')) return { rows: [{ up_ms: String(UP_MS), u_prime: String(U_PRIME), now_ms: Date.now() }] };
  const r = d.reshard;
  if (text === GATE_READ_SQL) {
    return { rows: [{
      attempt: r?.attempt ?? null, state: r?.state ?? null, from_count: r?.from_count ?? null, to_count: r?.to_count ?? null,
      target: r?.target ?? null, target_by: r?.target_by ?? null, target_at: null, meta_count: d.meta,
    }] };
  }
  if (t.startsWith('INSERT INTO smdb_data.meta')) {
    d.meta = JSON.parse(v[0]).count;
    return { rows: [] };
  }
  if (text === GATE_DELETE_SQL) {
    const open = ['standby', 'flipped', 'stopping'].includes(v[3]);
    const gone = d.rows.filter(c => c.shard_count !== v[0] && (c.released || c.expires_up_ms <= v[1]) && !(c.shard_count === v[2] && open));
    d.rows = d.rows.filter(c => !gone.includes(c));
    return { rows: gone.map(c => ({ shard_count: c.shard_count, shard_id: c.shard_id, released: c.released })) };
  }
  if (text === GATE_HELD_SQL) {
    const excepted = (c: Row) => v[0] === v[2] && c.shard_count === v[3] && v[4] === v[2];
    const held = d.rows.filter(c => c.shard_count !== v[0] && live(c, v[1]) && !excepted(c))
      .sort((a, b) => a.shard_count - b.shard_count || a.shard_id - b.shard_id);
    return { rows: held.map(c => ({ shard_count: c.shard_count, shard_id: c.shard_id, holder_name: c.holder_name })) };
  }
  if (t.startsWith('SELECT GREATEST(') && t.includes('max(claim)')) return { rows: [{ floor: '0' }] };
  if (t.startsWith("SELECT nextval('smdb_data.claim_seq')")) return { rows: Array.from({ length: v[0] }, (_, i) => ({ n: String(100 + i) })) };
  if (text === REDRAW_SQL) {
    const ids = v[1] as number[];
    const claims = v[2] as number[];
    const out: any[] = [];
    for (const c of d.rows) {
      const i = ids.indexOf(c.shard_id);
      if (i < 0 || c.holder_process !== v[0] || c.shard_count !== v[5] || !live(c, v[6]) || d.meta !== v[5]) continue;
      c.claim = claims[i];
      c.expires_up_ms = Number(v[4]);
      out.push({ shard_id: c.shard_id, claim: String(c.claim) });
    }
    return { rows: out.sort((a, b) => b.shard_id - a.shard_id) };
  }
  if (text === TAKE_INSERT_SQL) {
    const ids = v[1] as number[];
    return { rows: ids.map((id, i) => {
      d.rows.push({ shard_count: v[0], shard_id: id, released: false, expires_up_ms: Number(v[8]), holder_process: v[3], holder_name: v[5], claim: (v[2] as number[])[i] });
      return { shard_id: id, claim: String((v[2] as number[])[i]) };
    }) };
  }
  if (t.startsWith('SELECT') && (t.includes('FROM smdb_data.shard_claims') || t.includes('FROM smdb_data.shard_nodes'))) return { rows: [] };
  if (t.startsWith('INSERT INTO smdb_data.reshard (id, target, target_by, target_at)')) {
    d.reshard = { attempt: null, state: null, from_count: null, to_count: null, ...(d.reshard ?? {}), target: v[0], target_by: v[1] };
    return { rows: [] };
  }
  if (text === CLOSE_SQL) {
    if (r === null || r.attempt === null || r.attempt !== v[0] || r.state !== 'flipped' || r.to_count !== Number(v[1])) return { rows: [] };
    Object.assign(r, { state: 'done', closed: true });
    return { rows: [{ '?column?': 1 }] };
  }
  throw new Error(`unscripted statement: ${t.slice(0, 80)}`);
}

async function storeOver(d: Db, timings = T): Promise<ClaimStore> {
  const store = new ClaimStore('postgres://nobody@127.0.0.1:1/none', timings);
  await (store as any).pool.end().catch(() => undefined);
  const client = {
    async query(config: any, values?: any[]) {
      const text = typeof config === 'string' ? config : config.text;
      const params = (typeof config === 'string' ? values : config.values) ?? [];
      d.sent.push(text);
      if (d.hang?.(text)) return new Promise(() => undefined);
      const wait = d.delay?.(text) ?? 0;
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      if (d.fail?.(text)) {
        const error = new Error('canceling statement due to statement timeout') as Error & { code: string };
        error.code = '57014';
        throw error;
      }
      return answer(d, text, params);
    },
    release() { /* nothing held */ },
  };
  (store as any).pool = { async connect() { return client; }, async end() { /* nothing to close */ }, on() { return this; } };
  return store;
}

function mine(shard_count: number, shard_id: number, over: Partial<Row> = {}): Row {
  return { shard_count, shard_id, released: false, expires_up_ms: UP_MS + 5000, holder_process: ME.processId, holder_name: 'A', claim: 7, ...over };
}

function other(shard_count: number, shard_id: number, over: Partial<Row> = {}): Row {
  return { shard_count, shard_id, released: false, expires_up_ms: UP_MS - 1, holder_process: 'p-b', holder_name: 'B', claim: 3, ...over };
}

const redrawOf = (store: ClaimStore, shardIds = [0, 1, 2, 3]) => store.redraw({ me: ME, shardCount: 4, shardIds, ttlMs: T.ttlMs });

const statements = (d: Db) => d.sent.filter(s => /^(BEGIN|COMMIT|ROLLBACK)$/.test(s.trim()) || s === '');

describe('ra9 the redraw transaction', () => {
  it('redraws every row in one committed transaction and answers the pairs in shard order', async () => {
    const d = db({ meta: 4, rows: [mine(4, 0), mine(4, 1), mine(4, 2), mine(4, 3)] });
    const store = await storeOver(d);
    const result = await redrawOf(store);
    expect(result).toEqual({
      kind: 'done',
      pairs: [
        { shardCount: 4, shardId: 0, claim: 100 }, { shardCount: 4, shardId: 1, claim: 101 },
        { shardCount: 4, shardId: 2, claim: 102 }, { shardCount: 4, shardId: 3, claim: 103 },
      ],
      closed: null,
    });
    expect(d.sent[0]).toBe('BEGIN');
    expect(statements(d)).toEqual(['BEGIN', 'COMMIT']);
    expect(d.sent.at(-1)).toBe('COMMIT');
    await store.end();
  });

  it('stores each redrawn row to expire at u-prime plus the ttl', async () => {
    const d = db({ meta: 4, rows: [mine(4, 0), mine(4, 1)] });
    const store = await storeOver(d);
    await redrawOf(store, [0, 1]);
    expect(d.rows.map(r => [r.shard_id, r.claim, r.expires_up_ms])).toEqual([[0, 100, U_PRIME + T.ttlMs], [1, 101, U_PRIME + T.ttlMs]]);
    await store.end();
  });

  it('a stored count other than the redraw\'s answers count and rolls back', async () => {
    const d = db({ meta: 8, rows: [mine(4, 0)] });
    const store = await storeOver(d);
    const result = await redrawOf(store, [0]);
    expect(result.kind).toBe('count');
    expect(result.kind === 'count' && result.read.metaCount).toBe(8);
    expect(statements(d)).toEqual(['BEGIN', 'ROLLBACK']);
    expect(d.rows[0].claim).toBe(7);
    await store.end();
  });

  it('a live row of another count answers held with its holder and rolls back', async () => {
    const d = db({ meta: 4, rows: [mine(4, 0), other(2, 1, { expires_up_ms: UP_MS + 9000, holder_name: 'B' })] });
    const store = await storeOver(d);
    const result = await redrawOf(store, [0]);
    expect(result).toEqual({
      kind: 'held',
      read: expect.objectContaining({ metaCount: 4 }),
      rows: [{ shardCount: 2, shardId: 1, holderName: 'B' }],
    });
    expect(statements(d)).toEqual(['BEGIN', 'ROLLBACK']);
    expect(d.rows.find(r => r.shard_count === 4)!.claim).toBe(7);
    await store.end();
  });

  it('a failed redraw statement rolls the transaction back and fails as a server error', async () => {
    const d = db({ meta: 4, rows: [mine(4, 0)], fail: text => text === REDRAW_SQL });
    const store = await storeOver(d);
    const error = await redrawOf(store, [0]).then(() => null, e => e);
    expect(error).toBeInstanceOf(ClaimFailure);
    expect(d.sent.at(-1)).toBe('ROLLBACK');
    expect(statements(d)).toEqual(['BEGIN', 'ROLLBACK']);
    await store.end();
  });

  it('a redraw whose statements answer within its bound succeeds', async () => {
    const d = db({ meta: 4, rows: [mine(4, 0)], delay: text => (text === REDRAW_SQL ? 30 : 0) });
    const store = await storeOver(d);
    const result = await redrawOf(store, [0]);
    expect(result.kind).toBe('done');
    await store.end();
  });

  it('a redraw statement with no answer fails as a timeout of the claim redraw', async () => {
    const d = db({ meta: 4, rows: [mine(4, 0)], hang: text => text === REDRAW_SQL });
    const store = await storeOver(d, claimTimings(0.3));
    const error = await redrawOf(store, [0]).then(() => null, e => e);
    expect(error).toBeInstanceOf(ClaimFailure);
    expect((error as ClaimFailure).failure).toEqual({ kind: 'timeout' });
    expect(((error as ClaimFailure).cause as Error).message).toBe('the claim redraw got no answer in time');
    await store.end();
  });
});

describe('ra9 the close after a redraw (step 5)', () => {
  const flipped = (over: Partial<Reshard> = {}, rows: Row[] = []): Db => db({
    meta: 4,
    reshard: { attempt: ATTEMPT, state: 'flipped', from_count: 2, to_count: 4, ...over },
    rows: [mine(4, 0), ...rows],
  });

  it('names only the expired, unreleased rows of the old count it deleted', async () => {
    const d = flipped({}, [other(2, 3), other(2, 2, { released: true }), other(2, 1), other(6, 5)]);
    const store = await storeOver(d);
    const result = await redrawOf(store, [0]);
    expect(result.kind === 'done' && result.closed).toEqual({ fromCount: 2, toCount: 4, expired: [1, 3] });
    expect(d.reshard!.closed).toBe(true);
    await store.end();
  });

  it('a released old row alone is not named expired', async () => {
    const d = flipped({}, [other(2, 2, { released: true })]);
    const store = await storeOver(d);
    const result = await redrawOf(store, [0]);
    expect(result.kind === 'done' && result.closed).toEqual({ fromCount: 2, toCount: 4, expired: [] });
    await store.end();
  });

  it('an expired old row alone is named expired', async () => {
    const d = flipped({}, [other(2, 2)]);
    const store = await storeOver(d);
    const result = await redrawOf(store, [0]);
    expect(result.kind === 'done' && result.closed).toEqual({ fromCount: 2, toCount: 4, expired: [2] });
    await store.end();
  });

  const noClose: Array<[string, Partial<Reshard>]> = [
    ['an attempt in standby toward the count', { state: 'standby' }],
    ['a done attempt toward the count', { state: 'done' }],
    ['a flipped attempt toward another count', { to_count: 8 }],
    ['a standby attempt toward another count', { state: 'standby', to_count: 8 }],
    ['a flipped row with no attempt', { attempt: null }],
  ];
  for (const [name, over] of noClose) {
    it(`${name} is not closed, and a failing close statement does not fail the redraw`, async () => {
      const d = flipped(over);
      d.fail = text => text === CLOSE_SQL;
      const store = await storeOver(d);
      const result = await redrawOf(store, [0]);
      expect(result.kind).toBe('done');
      expect(result.kind === 'done' && result.closed).toBeNull();
      expect(d.sent).not.toContain(CLOSE_SQL);
      expect(d.reshard!.closed).toBeUndefined();
      expect(d.sent.at(-1)).toBe('COMMIT');
      await store.end();
    });
  }
});

describe('ra9 the first take writes the target from the count setting (NB9 4)', () => {
  const takeOf = (store: ClaimStore, countSetting?: number | null) => store.take({
    me: ME, capacity: 4, ttlMs: T.ttlMs, boot: true, known: [], localCount: 2, reserve: false, countSetting,
  });

  it('on an empty database the take stores the count and the target from FLEET_SHARD_COUNT', async () => {
    const d = db();
    const store = await storeOver(d);
    const result = await takeOf(store, 3);
    expect(result.kind).toBe('done');
    expect(d.meta).toBe(2);
    expect(d.reshard).toMatchObject({ target: 3, target_by: 'A' });
    expect(d.sent.at(-1)).toBe('COMMIT');
    await store.end();
  });

  it('with no count setting the take writes no target', async () => {
    const d = db();
    const store = await storeOver(d);
    const result = await takeOf(store, undefined);
    expect(result.kind).toBe('done');
    expect(d.meta).toBe(2);
    expect(d.reshard).toBeNull();
    await store.end();
  });

  it('with a null count setting the take writes no target', async () => {
    const d = db();
    const store = await storeOver(d);
    const result = await takeOf(store, null);
    expect(result.kind).toBe('done');
    expect(d.reshard).toBeNull();
    await store.end();
  });

  it('a take under a stored count writes no target', async () => {
    const d = db({ meta: 2 });
    const store = await storeOver(d);
    const result = await takeOf(store, 3);
    expect(result.kind).toBe('done');
    expect(d.reshard).toBeNull();
    await store.end();
  });
});
