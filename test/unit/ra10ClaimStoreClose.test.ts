import { describe, expect, it } from 'vitest';

import {
  CLOSE_SQL, ClaimFailure, ClaimStore, GATE_DELETE_SQL, GATE_HELD_SQL, GATE_READ_SQL, IDENTIFY_SLOT_SQL, IDENTIFY_WAIT_SQL,
  PAGE_ATTEMPT_ROWS_SQL, PAGE_RESHARD_SQL, REDRAW_SQL, TAKE_INSERT_SQL,
} from '../../src/bot/internalSetup/fleet/claimStore';
import { claimTimings } from '../../src/bot/internalSetup/fleet/claimRules';

// ClaimStore over a pool whose one table set answers as Postgres would for the statements these paths send: each
// statement's parameters bound by number (too few is pg's bind error), an empty statement answers no row.

const T = claimTimings(30);
const ME = { processId: 'p-a', nodeId: 'n-a', nodeName: 'A' };
const UP_MS = 10_000;

interface Reshard {
  attempt: string | null;
  state: string | null;
  from_count: number | null;
  to_count: number | null;
  method?: string | null;
  reason?: string | null;
  started_by?: string | null;
  started_ago_ms?: number | null;
  until_ms?: number | null;
  ended_ago_ms?: number | null;
  ended?: boolean;
  failures?: number;
  retry_after?: number | null;
}

interface Claim {
  shard_count: number;
  shard_id: number;
  released: boolean;
  expires_up_ms: number;
  ready: boolean;
  holder_name: string;
}

interface Db {
  reshard: Reshard | null;
  meta: number | null;
  claims: Claim[];
  slots: Map<number, { at: number; process: string }>;
  sent: string[];
  onHeld?: () => void;
  hang?: (text: string) => boolean;
}

function db(over: Partial<Db> = {}): Db {
  return { reshard: null, meta: null, claims: [], slots: new Map(), sent: [], ...over };
}

function bindError(given: number, wanted: number): Error {
  const error = new Error(`bind message supplies ${given} parameters, but prepared statement "" requires ${wanted}`) as Error & { code: string };
  error.code = '08P01';
  return error;
}

function answer(d: Db, text: string, v: any[]): { rows: any[] } {
  const wanted = Math.max(0, ...[...text.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
  if (v.length < wanted) throw bindError(v.length, wanted);
  const t = text.trim();
  if (t === '') return { rows: [] };
  if (/^(BEGIN|COMMIT|ROLLBACK)/.test(t) || t.includes('pg_advisory_xact_lock')) return { rows: [] };
  if (t.startsWith('SELECT up_ms::text AS up_ms')) return { rows: [{ up_ms: String(UP_MS), u_prime: String(UP_MS), now_ms: Date.now() }] };
  const r = d.reshard;
  const gateRow = {
    attempt: r?.attempt ?? null, state: r?.state ?? null, from_count: r?.from_count ?? null, to_count: r?.to_count ?? null,
    target: null, target_by: null, target_at: null, meta_count: d.meta,
  };
  if (text === GATE_READ_SQL) return { rows: [gateRow] };
  if (text === PAGE_RESHARD_SQL) {
    return { rows: [{ ...gateRow, method: r?.method ?? null, reason: r?.reason ?? null, started_ago_ms: r?.started_ago_ms ?? null, until_ms: r?.until_ms ?? null, ended_ago_ms: r?.ended_ago_ms ?? null }] };
  }
  if (text === PAGE_ATTEMPT_ROWS_SQL) {
    const live = (c: Claim) => !c.released && c.expires_up_ms > UP_MS;
    const connected = d.claims.filter(c => c.shard_count === v[1] && c.ready && live(c)).length;
    const names = [...new Set(d.claims.filter(c => c.shard_count === v[0] && live(c)).map(c => c.holder_name))].sort();
    return { rows: [{ connected, waiting_for: names.length === 0 ? null : names }] };
  }
  if (t.startsWith('INSERT INTO smdb_data.meta')) {
    d.meta = JSON.parse(v[0]).count;
    return { rows: [] };
  }
  if (t.startsWith('SELECT value FROM smdb_data.meta')) return { rows: d.meta === null ? [] : [{ value: JSON.stringify({ count: d.meta }) }] };
  if (text === GATE_DELETE_SQL) {
    const open = ['standby', 'flipped', 'stopping'].includes(v[3]);
    const gone = d.claims.filter(c => c.shard_count !== v[0] && (c.released || c.expires_up_ms <= v[1]) && !(c.shard_count === v[2] && open));
    d.claims = d.claims.filter(c => !gone.includes(c));
    return { rows: gone.map(c => ({ shard_count: c.shard_count, shard_id: c.shard_id, released: c.released })) };
  }
  if (text === GATE_HELD_SQL) {
    d.onHeld?.();
    return { rows: [] };
  }
  if (t.startsWith('SELECT GREATEST(') && t.includes('max(claim)')) return { rows: [{ floor: '0' }] };
  if (t.startsWith("SELECT nextval('smdb_data.claim_seq')")) return { rows: Array.from({ length: v[0] }, (_, i) => ({ n: String(100 + i) })) };
  if (text === REDRAW_SQL || text === TAKE_INSERT_SQL) {
    return { rows: (v[1] as number[]).map((id, i) => ({ shard_id: id, claim: String((v[2] as number[])[i]) })) };
  }
  if (t.startsWith('SELECT') && (t.includes('FROM smdb_data.shard_claims') || t.includes('FROM smdb_data.shard_nodes'))) return { rows: [] };
  if (text === CLOSE_SQL) {
    if (r === null || r.attempt === null || r.attempt !== v[0] || r.state !== 'flipped' || r.to_count !== Number(v[1])) return { rows: [] };
    Object.assign(r, { state: 'done', ended: true, failures: 0, retry_after: null });
    return { rows: [{ '?column?': 1 }] };
  }
  if (/^UPDATE smdb_data\.reshard SET state = 'done'/.test(t) && t.includes("state = 'stopping'")) {
    if (r !== null && r.attempt !== null && r.attempt === v[0] && r.state === 'stopping') Object.assign(r, { state: 'done', ended: true, failures: 0, retry_after: null });
    return { rows: [] };
  }
  if (t === 'INSERT INTO smdb_data.reshard (id) VALUES (1) ON CONFLICT (id) DO NOTHING') {
    if (d.reshard === null) d.reshard = { attempt: null, state: null, from_count: null, to_count: null };
    return { rows: [] };
  }
  if (t.startsWith('UPDATE smdb_data.reshard SET attempt = $4::uuid')) {
    if (r !== null) {
      Object.assign(r, {
        attempt: v[3], from_count: v[0], to_count: v[1], method: 'stop-start', state: 'done', started_by: v[2],
        until_ms: null, ended: true, reason: null, retry_after: null, failures: 0,
      });
    }
    return { rows: [] };
  }
  if (text === IDENTIFY_SLOT_SQL) {
    const now = Date.now();
    const slot = d.slots.get(v[0]);
    if (slot !== undefined && slot.at > now - 5500) return { rows: [] };
    d.slots.set(v[0], { at: now, process: v[1] });
    return { rows: [{ '?column?': 1 }] };
  }
  if (text === IDENTIFY_WAIT_SQL) {
    const slot = d.slots.get(v[0]);
    return { rows: slot === undefined ? [] : [{ wait_ms: String(Math.max(slot.at + 5500 - Date.now(), 0)) }] };
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
      return answer(d, text, params);
    },
    release() { /* nothing held */ },
  };
  (store as any).pool = { async connect() { return client; }, async end() { /* nothing to close */ }, on() { return this; } };
  return store;
}

function claim(shard_count: number, shard_id: number, over: Partial<Claim> = {}): Claim {
  return { shard_count, shard_id, released: false, expires_up_ms: UP_MS - 1, ready: true, holder_name: 'B', ...over };
}

const redrawOf = (store: ClaimStore) => store.redraw({ me: ME, shardCount: 4, shardIds: [0, 1], ttlMs: T.ttlMs });

describe('the close of a flipped attempt (step 5) in the redraw', () => {
  function flipped(over: Partial<Db> = {}): Db {
    return db({
      meta: 4,
      reshard: { attempt: '11111111-1111-4111-8111-111111111111', state: 'flipped', from_count: 2, to_count: 4 },
      claims: [
        claim(2, 3), claim(2, 2, { released: true }), claim(2, 1), claim(6, 5), claim(2, 0),
        claim(2, 4, { expires_up_ms: UP_MS + 5000 }),
      ],
      ...over,
    });
  }

  it('closes the attempt and names the old count\'s expired rows it deleted, in shard order', async () => {
    const d = flipped();
    const store = await storeOver(d);
    const answer = await redrawOf(store);
    expect(answer).toEqual({
      kind: 'done',
      pairs: [{ shardCount: 4, shardId: 0, claim: 100 }, { shardCount: 4, shardId: 1, claim: 101 }],
      closed: { fromCount: 2, toCount: 4, expired: [0, 1, 3] },
    });
    expect(d.reshard).toMatchObject({ state: 'done', ended: true, failures: 0 });
    expect(d.sent.filter(s => s === CLOSE_SQL)).toHaveLength(1);
    await store.end();
  });

  it('a released old row and an expired row of a third count are not named expired', async () => {
    const d = flipped({ claims: [claim(2, 2, { released: true }), claim(6, 5)] });
    const store = await storeOver(d);
    const answer = await redrawOf(store);
    expect(answer.kind === 'done' && answer.closed).toEqual({ fromCount: 2, toCount: 4, expired: [] });
    await store.end();
  });

  it('when another writer moved the row before the close, nothing is closed and the answer says so', async () => {
    const d = flipped();
    d.onHeld = () => { d.reshard!.state = 'done'; d.reshard!.reason = 'by another'; };
    const store = await storeOver(d);
    const answer = await redrawOf(store);
    expect(answer.kind).toBe('done');
    expect(answer.kind === 'done' && answer.closed).toBeNull();
    expect(d.reshard).toMatchObject({ state: 'done', reason: 'by another' });
    expect(d.reshard!.ended).toBeUndefined();
    await store.end();
  });

  it('a flipped row with no attempt sends no close', async () => {
    const d = flipped();
    d.reshard!.attempt = null;
    const store = await storeOver(d);
    const answer = await redrawOf(store);
    expect(answer.kind === 'done' && answer.closed).toBeNull();
    expect(d.sent).not.toContain(CLOSE_SQL);
    await store.end();
  });

  it('a flipped row toward another count is not closed', async () => {
    const d = flipped();
    d.reshard!.to_count = 8;
    const store = await storeOver(d);
    const answer = await redrawOf(store);
    expect(answer.kind === 'done' && answer.closed).toBeNull();
    expect(d.reshard!.state).toBe('flipped');
    await store.end();
  });
});

describe('the count-writing take records the change as done (NB9 12, 13)', () => {
  const takeOf = (store: ClaimStore, writesMeta: any) => store.take({
    me: ME, capacity: 4, ttlMs: T.ttlMs, boot: false, known: [], localCount: 2, reserve: false, writesMeta,
  });

  it("13's direct change on a database with no reshard row writes the row as a done stop-start change", async () => {
    const d = db({ meta: 1 });
    const store = await storeOver(d);
    const answer = await takeOf(store, { kind: 'direct', from: 1 });
    expect(answer.kind).toBe('done');
    expect(d.meta).toBe(2);
    expect(d.reshard).toMatchObject({
      from_count: 1, to_count: 2, method: 'stop-start', state: 'done', started_by: 'A', ended: true, reason: null, failures: 0,
    });
    expect(d.reshard!.attempt).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(d.sent.at(-1)).toBe('COMMIT');
    await store.end();
  });

  it("12's count change sets its stopping attempt done", async () => {
    const attempt = '22222222-2222-4222-8222-222222222222';
    const d = db({ meta: 1, reshard: { attempt, state: 'stopping', from_count: 1, to_count: 2, failures: 3, retry_after: 99 } });
    const store = await storeOver(d);
    const answer = await takeOf(store, { kind: 'change', attempt });
    expect(answer.kind).toBe('done');
    expect(d.reshard).toEqual({ attempt, state: 'done', from_count: 1, to_count: 2, failures: 0, retry_after: null, ended: true });
    expect(d.sent.at(-1)).toBe('COMMIT');
    await store.end();
  });
});

describe('the page read of an attempt (NB9 21)', () => {
  function page(reshard: Reshard): Db {
    return db({
      meta: 2,
      reshard,
      claims: [
        claim(4, 0, { expires_up_ms: UP_MS + 9000 }), claim(4, 1, { expires_up_ms: UP_MS + 9000 }),
        claim(4, 2, { released: true, expires_up_ms: UP_MS + 9000 }), claim(4, 3, { ready: false, expires_up_ms: UP_MS + 9000 }),
        claim(2, 0, { holder_name: 'B', expires_up_ms: UP_MS + 9000 }), claim(2, 1, { holder_name: 'A', expires_up_ms: UP_MS + 9000 }),
        claim(2, 2, { holder_name: 'C', released: true, expires_up_ms: UP_MS + 9000 }),
      ],
    });
  }

  it('shows the attempt\'s columns, its ready rows of to_count and the machines on from_count', async () => {
    const d = page({ attempt: 'a1', state: 'flipped', from_count: 2, to_count: 4, method: 'overlap', reason: 'r1', started_ago_ms: 1000, until_ms: 2000, ended_ago_ms: null });
    const store = await storeOver(d);
    const read = await store.readPage(2);
    expect(read.attempt).toEqual({ method: 'overlap', reason: 'r1', startedAgoMs: 1000, untilMs: 2000, endedAgoMs: null, connected: 2, waitingFor: ['A', 'B'] });
    await store.end();
  });

  it('a row with counts but no attempt shows no rows connected or waited for', async () => {
    const d = page({ attempt: null, state: null, from_count: 2, to_count: 4 });
    const store = await storeOver(d);
    const read = await store.readPage(2);
    expect(read.attempt).toMatchObject({ connected: 0, waitingFor: [] });
    expect(d.sent).not.toContain(PAGE_ATTEMPT_ROWS_SQL);
    await store.end();
  });

  it('an attempt with no from_count shows nothing connected', async () => {
    const d = page({ attempt: 'a1', state: 'flipped', from_count: null, to_count: 4 });
    const store = await storeOver(d);
    const read = await store.readPage(2);
    expect(read.attempt).toMatchObject({ connected: 0, waitingFor: [] });
    await store.end();
  });

  it('an attempt with no to_count shows no machine waited for', async () => {
    const d = page({ attempt: 'a1', state: 'flipped', from_count: 2, to_count: null });
    const store = await storeOver(d);
    const read = await store.readPage(2);
    expect(read.attempt).toMatchObject({ connected: 0, waitingFor: [] });
    await store.end();
  });
});

describe('the identify slot (NB9 16)', () => {
  it('grants a free bucket and records this process as its holder', async () => {
    const d = db();
    const store = await storeOver(d);
    expect(await store.reserveIdentifySlot(3, 'p-a')).toEqual({ granted: true });
    expect(d.slots.get(3)?.process).toBe('p-a');
    await store.end();
  });

  it('a bucket granted under 5.5 s ago answers the time left', async () => {
    const d = db();
    d.slots.set(3, { at: Date.now() - 1500, process: 'p-b' });
    const store = await storeOver(d);
    const answer = await store.reserveIdentifySlot(3, 'p-a');
    expect(answer.granted).toBe(false);
    const waitMs = (answer as { waitMs: number }).waitMs;
    expect(waitMs).toBeGreaterThan(3000);
    expect(waitMs).toBeLessThanOrEqual(4000);
    expect(d.slots.get(3)?.process).toBe('p-b');
    await store.end();
  });

  it('a slot statement with no answer fails as a timeout of the identify slot', async () => {
    const d = db({ hang: text => text === IDENTIFY_SLOT_SQL });
    const store = await storeOver(d, claimTimings(0.3));
    const error = await store.reserveIdentifySlot(3, 'p-a').then(() => null, e => e);
    expect(error).toBeInstanceOf(ClaimFailure);
    expect((error as ClaimFailure).failure).toEqual({ kind: 'timeout' });
    expect(((error as ClaimFailure).cause as Error).message).toBe('the identify slot got no answer in time');
    await store.end();
  });
});
