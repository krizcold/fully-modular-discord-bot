import { describe, expect, it } from 'vitest';

import {
  ClaimStore, GATE_DELETE_SQL, GATE_HELD_SQL, GATE_READ_SQL, REDRAW_SQL, TAKE_INSERT_SQL, identifyAborted,
} from '../../src/bot/internalSetup/fleet/claimStore';
import { claimTimings } from '../../src/bot/internalSetup/fleet/claimRules';

// ClaimStore over a pool that answers by what each statement says, as Postgres would: an empty statement answers no
// row, so a statement that lost its text reads as nothing found.

const T = claimTimings(30);
const ME = { processId: 'p-a', nodeId: 'n-a', nodeName: 'A' };
const UP_MS = 10_000;

interface Claim {
  shard_count: number;
  shard_id: number;
  released: boolean;
  expires_up_ms: number;
  ready: boolean;
  holder_name: string;
}

interface Db {
  reshard: Record<string, any> | null;
  pageRow: boolean;
  meta: number | null;
  claims: Claim[];
  slots: Map<number, { at: number; process: string }>;
  sent: string[];
}

function db(over: Partial<Db> = {}): Db {
  return { reshard: null, pageRow: true, meta: null, claims: [], slots: new Map(), sent: [], ...over };
}

const live = (c: Claim) => !c.released && c.expires_up_ms > UP_MS;

function answer(d: Db, text: string, v: any[]): { rows: any[] } {
  const t = text.trim();
  if (t === '') return { rows: [] };
  if (/^(BEGIN|COMMIT|ROLLBACK)/.test(t) || t.includes('pg_advisory_xact_lock')) return { rows: [] };
  if (t.startsWith('SELECT up_ms::text AS up_ms')) return { rows: [{ up_ms: String(UP_MS), u_prime: String(UP_MS), now_ms: Date.now() }] };
  const r = d.reshard;
  const gateRow = {
    attempt: r?.attempt ?? null, state: r?.state ?? null, from_count: r?.from_count ?? null, to_count: r?.to_count ?? null,
    target: r?.target ?? null, target_by: r?.target_by ?? null, target_at: r?.target_at ?? null, meta_count: d.meta,
  };
  if (text === GATE_READ_SQL) return { rows: [gateRow] };
  if (t.includes('AS started_ago_ms') && t.includes('AS until_ms') && t.includes('AS ended_ago_ms') && t.includes('LEFT JOIN smdb_data.reshard r ON r.id = 1')) {
    if (!d.pageRow) return { rows: [] };
    return { rows: [{ ...gateRow, method: r?.method ?? null, reason: r?.reason ?? null, started_ago_ms: r?.started_ago_ms ?? null, until_ms: r?.until_ms ?? null, ended_ago_ms: r?.ended_ago_ms ?? null }] };
  }
  if (t.includes('AS connected') && t.includes('AS waiting_for') && t.includes('c.shard_count = $2::int AND c.ready') && t.includes('c.shard_count = $1::int AND NOT c.released')) {
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
  if (text === GATE_HELD_SQL) return { rows: [] };
  if (t.startsWith('SELECT GREATEST(') && t.includes('max(claim)')) return { rows: [{ floor: '0' }] };
  if (t.startsWith("SELECT nextval('smdb_data.claim_seq')")) return { rows: Array.from({ length: v[0] }, (_, i) => ({ n: String(100 + i) })) };
  if (text === REDRAW_SQL || text === TAKE_INSERT_SQL) {
    return { rows: (v[1] as number[]).map((id, i) => ({ shard_id: id, claim: String((v[2] as number[])[i]) })) };
  }
  if (t.startsWith('SELECT') && (t.includes('FROM smdb_data.shard_claims') || t.includes('FROM smdb_data.shard_nodes'))) return { rows: [] };
  if (t.startsWith("UPDATE smdb_data.reshard SET state = 'done', ended_at = now(), failures = 0, retry_after = NULL")
    && t.includes("WHERE id = 1 AND attempt = $1::uuid AND state = 'flipped' AND to_count = $2::int") && t.endsWith('RETURNING 1')) {
    if (r === null || r.attempt !== v[0] || r.state !== 'flipped' || r.to_count !== Number(v[1])) return { rows: [] };
    Object.assign(r, { state: 'done', ended: true, failures: 0, retry_after: null });
    return { rows: [{ '?column?': 1 }] };
  }
  if (t.startsWith('INSERT INTO smdb_data.identify_slots AS s (bucket, last_at, process_id)')
    && t.includes("WHERE s.last_at <= clock_timestamp() - interval '5500 milliseconds'") && t.endsWith('RETURNING 1')) {
    const now = Date.now();
    const slot = d.slots.get(v[0]);
    if (slot !== undefined && slot.at > now - 5500) return { rows: [] };
    d.slots.set(v[0], { at: now, process: v[1] });
    return { rows: [{ '?column?': 1 }] };
  }
  if (t.startsWith('SELECT GREATEST((extract(epoch FROM s.last_at + interval \'5500 milliseconds\' - clock_timestamp())')
    && t.includes('AS wait_ms') && t.includes('FROM smdb_data.identify_slots s WHERE bucket = $1::int')) {
    const slot = d.slots.get(v[0]);
    return { rows: slot === undefined ? [] : [{ wait_ms: String(Math.max(slot.at + 5500 - Date.now(), 0)) }] };
  }
  throw new Error(`unscripted statement: ${t.slice(0, 80)}`);
}

async function storeOver(d: Db): Promise<ClaimStore> {
  const store = new ClaimStore('postgres://nobody@127.0.0.1:1/none', T);
  await (store as any).pool.end().catch(() => undefined);
  const client = {
    async query(config: any, values?: any[]) {
      const text = typeof config === 'string' ? config : config.text;
      const params = (typeof config === 'string' ? values : config.values) ?? [];
      d.sent.push(text);
      return answer(d, text, params);
    },
    release() { /* nothing held */ },
  };
  (store as any).pool = { async connect() { return client; }, async end() { /* nothing to close */ }, on() { return this; } };
  return store;
}

function claim(shard_count: number, shard_id: number, over: Partial<Claim> = {}): Claim {
  return { shard_count, shard_id, released: false, expires_up_ms: UP_MS + 9000, ready: true, holder_name: 'B', ...over };
}

const pageClaims = () => [
  claim(4, 0), claim(4, 1), claim(4, 2, { released: true }), claim(4, 3, { ready: false }),
  claim(2, 0, { holder_name: 'B' }), claim(2, 1, { holder_name: 'A' }),
];

async function pageOf(reshard: Record<string, any> | null, over: Partial<Db> = {}) {
  const d = db({ meta: 2, reshard, claims: pageClaims(), ...over });
  const store = await storeOver(d);
  try {
    return await store.readPage(2);
  } finally {
    await store.end();
  }
}

describe('ra11: the fleet page read of a reshard attempt', () => {
  it('an overlap attempt shows its method, reason, times, ready new rows and the machines on the old count', async () => {
    const read = await pageOf({
      attempt: 'a1', state: 'flipped', from_count: 2, to_count: 4, target: 4, target_by: 'B', target_at: 5,
      method: 'overlap', reason: 'r1', started_ago_ms: 1000, until_ms: 2000, ended_ago_ms: null,
    });
    expect(read.reshard).toEqual({ attempt: 'a1', state: 'flipped', fromCount: 2, toCount: 4, metaCount: 2, target: 4, targetBy: 'B', targetAt: 5 });
    expect(read.attempt).toEqual({ method: 'overlap', reason: 'r1', startedAgoMs: 1000, untilMs: 2000, endedAgoMs: null, connected: 2, waitingFor: ['A', 'B'] });
  });

  it('a stop-start attempt that ended shows its method and how long ago it ended', async () => {
    const read = await pageOf({
      attempt: 'a2', state: 'done', from_count: 2, to_count: 4, method: 'stop-start', reason: null,
      started_ago_ms: 0, until_ms: null, ended_ago_ms: 30,
    });
    expect(read.attempt).toEqual({ method: 'stop-start', reason: null, startedAgoMs: 0, untilMs: null, endedAgoMs: 30, connected: 2, waitingFor: ['A', 'B'] });
  });

  it('a method the page does not know shows as no method', async () => {
    const read = await pageOf({ attempt: 'a3', state: 'flipped', from_count: 2, to_count: 4, method: 'sideways', reason: 'x' });
    expect(read.attempt?.method).toBeNull();
    expect(read.attempt?.reason).toBe('x');
  });

  it('a time that is not a finite number shows as no time', async () => {
    const read = await pageOf({ attempt: 'a4', state: 'flipped', from_count: 2, to_count: 4, method: 'overlap', started_ago_ms: 'soon', until_ms: Infinity, ended_ago_ms: 12.5 });
    expect(read.attempt).toMatchObject({ startedAgoMs: null, untilMs: null, endedAgoMs: 12.5 });
  });

  it('a reshard read that answers no row shows no attempt, with nulls and nothing connected', async () => {
    const read = await pageOf({ attempt: 'a5', state: 'flipped', from_count: 2, to_count: 4, method: 'overlap', reason: 'r' }, { pageRow: false });
    expect(read.reshard).toEqual({ attempt: null, state: null, fromCount: null, toCount: null, metaCount: null, target: null, targetBy: null, targetAt: null });
    expect(read.attempt).toStrictEqual({ method: null, reason: null, startedAgoMs: null, untilMs: null, endedAgoMs: null, connected: 0, waitingFor: [] });
  });
});

describe('ra11: the close of a flipped attempt in the redraw', () => {
  it('sets the attempt done and answers what it closed', async () => {
    const d = db({
      meta: 4,
      reshard: { attempt: '11111111-1111-4111-8111-111111111111', state: 'flipped', from_count: 2, to_count: 4 },
      claims: [claim(2, 1, { expires_up_ms: UP_MS - 1 })],
    });
    const store = await storeOver(d);
    const answer = await store.redraw({ me: ME, shardCount: 4, shardIds: [0], ttlMs: T.ttlMs });
    await store.end();
    expect(answer.kind === 'done' && answer.closed).toEqual({ fromCount: 2, toCount: 4, expired: [1] });
    expect(d.reshard).toMatchObject({ state: 'done', ended: true, failures: 0, retry_after: null });
  });
});

describe('ra11: the identify slot', () => {
  it('grants a free bucket and records this process as its holder', async () => {
    const d = db();
    const store = await storeOver(d);
    const answer = await store.reserveIdentifySlot(3, 'p-a');
    await store.end();
    expect(answer).toEqual({ granted: true });
    expect(d.slots.get(3)?.process).toBe('p-a');
  });

  it('a bucket taken 1.5 s ago answers about 4 s left and keeps its holder', async () => {
    const d = db();
    d.slots.set(3, { at: Date.now() - 1500, process: 'p-b' });
    const store = await storeOver(d);
    const answer = await store.reserveIdentifySlot(3, 'p-a');
    await store.end();
    expect(answer.granted).toBe(false);
    const waitMs = (answer as { waitMs: number }).waitMs;
    expect(waitMs).toBeGreaterThan(3000);
    expect(waitMs).toBeLessThanOrEqual(4000);
    expect(d.slots.get(3)?.process).toBe('p-b');
  });

  it('an aborted wait fails as an AbortError that says the identify wait was aborted', async () => {
    const d = db();
    const store = await storeOver(d);
    const controller = new AbortController();
    controller.abort();
    const error = await store.reserveIdentifySlot(3, 'p-a', controller.signal).then(() => null, e => e as Error);
    await store.end();
    expect(error).toBeInstanceOf(Error);
    expect(error!.name).toBe('AbortError');
    expect(error!.message).toBe('The identify wait was aborted');
    expect(identifyAborted().message).toBe('The identify wait was aborted');
    expect(d.sent).toEqual([]);
  });
});
