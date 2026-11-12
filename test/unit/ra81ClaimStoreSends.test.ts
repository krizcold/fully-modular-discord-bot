import { describe, expect, it } from 'vitest';

import {
  ClaimStore, GATE_DELETE_SQL, GATE_HELD_SQL, GATE_READ_SQL, SPREAD_SQL, TAKE_INSERT_SQL, TAKE_UPDATE_SQL,
} from '../../src/bot/internalSetup/fleet/claimStore';
import { claimTimings } from '../../src/bot/internalSetup/fleet/claimRules';

// L5 run A, chunk 81: which statements the re-take and the count-writing take send, over the in-memory tables of
// ra8ClaimStoreSpread.test.ts, and the spread of a count-writing take whose own node row is in shard_nodes.

const T = claimTimings(30);
const ME = { processId: 'p-a', nodeId: 'n-a', nodeName: 'A' };
const UP_MS = 10_000;
const U_PRIME = 12_000;

interface Row {
  shard_count: number;
  shard_id: number;
  claim: number;
  holder_process: string;
  holder_node: string;
  holder_name: string;
  home_node: string;
  released: boolean;
  reserved: boolean;
  ttl_ms: number;
  expires_up_ms: number;
  extended: boolean;
  ready: boolean;
}

interface Reshard {
  attempt: string | null;
  state: string | null;
  from_count: number | null;
  to_count: number | null;
  target?: number | null;
  target_by?: string | null;
  started_by?: string | null;
}

interface World {
  claims: Row[];
  nodes: any[];
  meta: number | null;
  reshard: Reshard | null;
  seq: number;
}

interface Db extends World {
  sent: string[];
}

function world(over: Partial<World> = {}): Db {
  return { claims: [], nodes: [], meta: null, reshard: null, seq: 100, sent: [], ...over };
}

const NOT_NULL: Array<keyof Row> = [
  'shard_count', 'shard_id', 'claim', 'holder_process', 'holder_node', 'holder_name', 'home_node', 'ttl_ms', 'expires_up_ms',
];

function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, severity: 'ERROR' });
}

function checked(row: Row): Row {
  for (const col of NOT_NULL) {
    const v = row[col] as unknown;
    if (v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v))) {
      throw pgError('23502', `null value in column "${col}" of relation "shard_claims" violates not-null constraint`);
    }
  }
  return row;
}

const asPg = (v: unknown): unknown => (v === undefined ? null : Array.isArray(v) ? v.map(asPg) : v);
const num = (v: unknown) => (v === null ? null : Number(v));

function rowOut(r: Row) {
  return {
    shard_count: r.shard_count, shard_id: r.shard_id, claim: String(r.claim), holder_process: r.holder_process,
    holder_node: r.holder_node, holder_name: r.holder_name, home_node: r.home_node, released: r.released,
    reserved: r.reserved, taken_at: 0, renewed_at: 0, ttl_ms: String(r.ttl_ms), expires_up_ms: String(r.expires_up_ms),
    extended: r.extended, renewed_ago_ms: 0,
  };
}

function answer(d: Db, text: string, v: any[]): { rows: any[] } {
  const wanted = Math.max(0, ...[...text.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
  if (v.length !== wanted) {
    throw pgError('08P01', `bind message supplies ${v.length} parameters, but prepared statement "" requires ${wanted}`);
  }
  const t = text.trim();
  const find = (count: number, id: number) => d.claims.find(c => c.shard_count === count && c.shard_id === id);
  if (t.includes('pg_advisory_xact_lock')) return { rows: [] };
  if (t.startsWith('SELECT up_ms::text AS up_ms')) return { rows: [{ up_ms: String(UP_MS), u_prime: String(U_PRIME), now_ms: Date.now() }] };
  if (text === GATE_READ_SQL) {
    const r = d.reshard;
    return {
      rows: [{
        attempt: r?.attempt ?? null, state: r?.state ?? null, from_count: r?.from_count ?? null, to_count: r?.to_count ?? null,
        target: r?.target ?? null, target_by: r?.target_by ?? null, target_at: null, meta_count: d.meta,
      }],
    };
  }
  if (t.startsWith('INSERT INTO smdb_data.meta')) {
    d.meta = JSON.parse(v[0]).count;
    return { rows: [] };
  }
  if (text === GATE_DELETE_SQL) {
    const gone = d.claims.filter(c => c.shard_count !== v[0] && (c.released || c.expires_up_ms <= v[1]));
    d.claims = d.claims.filter(c => !gone.includes(c));
    return { rows: gone.map(c => ({ shard_count: c.shard_count, shard_id: c.shard_id, released: c.released })) };
  }
  if (text === GATE_HELD_SQL) {
    return { rows: d.claims.filter(c => c.shard_count !== v[0] && !c.released && c.expires_up_ms > v[1]).map(c => ({ shard_count: c.shard_count, shard_id: c.shard_id, holder_name: c.holder_name })) };
  }
  if (t.startsWith("SELECT to_regclass('smdb_manager.generation')")) return { rows: [{ present: false }] };
  if (t.includes('FROM smdb_data.guild_ownership') && t.startsWith('SELECT guild_id')) return { rows: [] };
  if (t.startsWith('SELECT shard_count, shard_id, claim::text AS claim') && t.includes('WHERE shard_count = $1')) {
    return { rows: d.claims.filter(c => c.shard_count === v[0]).map(rowOut) };
  }
  if (t.startsWith('SELECT shard_count, shard_id, claim::text AS claim') && t.includes('WHERE shard_id = ANY($1::int[])')) {
    return { rows: d.claims.filter(c => (v[0] as number[]).includes(c.shard_id)).map(rowOut) };
  }
  if (t.startsWith('SELECT node_id, node_name')) return { rows: d.nodes };
  if (t.startsWith('SELECT GREATEST(') && t.includes('max(claim)')) {
    return { rows: [{ floor: String(Math.max(0, ...d.claims.map(c => c.claim))) }] };
  }
  if (t.startsWith("SELECT nextval('smdb_data.claim_seq')")) {
    const k = Math.max(0, Number(v[0]));
    return { rows: Array.from({ length: k }, () => ({ n: String(d.seq++) })) };
  }
  if (t.startsWith("SELECT setval('smdb_data.claim_seq'")) {
    d.seq = Number(v[0]) + 1;
    return { rows: [] };
  }
  if (text === TAKE_INSERT_SQL) {
    const out: any[] = [];
    (v[1] as any[]).forEach((id, i) => {
      if (id !== null && find(v[0], id)) return;
      const row = checked({
        shard_count: v[0], shard_id: id, claim: num(v[2][i]) as number, holder_process: v[3], holder_node: v[4], holder_name: v[5],
        home_node: v[4], released: v[6], reserved: v[6], ttl_ms: num(v[7]) as number, expires_up_ms: num(v[8]) as number,
        extended: false, ready: false,
      });
      d.claims.push(row);
      out.push({ shard_id: row.shard_id, claim: String(row.claim) });
    });
    return { rows: out };
  }
  if (text === TAKE_UPDATE_SQL) {
    const out: any[] = [];
    (v[1] as any[]).forEach((id, i) => {
      const c = find(v[0], id);
      if (!c || c.claim !== Number(v[9][i]) || c.holder_process !== v[10][i]) return;
      if (!(c.expires_up_ms <= v[11] || (c.released && c.holder_node === v[4]) || c.holder_process === v[3])) return;
      const next = checked({
        ...c, claim: num(v[2][i]) as number, holder_process: v[3], holder_node: v[4], holder_name: v[5], released: v[6],
        reserved: v[6], ttl_ms: num(v[7]) as number, expires_up_ms: num(v[8]) as number, extended: false, ready: false,
      });
      Object.assign(c, next);
      out.push({ shard_id: c.shard_id, claim: String(c.claim) });
    });
    return { rows: out };
  }
  if (text === SPREAD_SQL) {
    const out: any[] = [];
    (v[3] as any[]).forEach((id, i) => {
      const ttl = num(v[7][i]);
      const fields = {
        shard_count: v[0], shard_id: id, claim: num(v[4][i]) as number, holder_process: v[1], holder_node: v[5][i],
        holder_name: v[6][i], home_node: v[5][i], released: true, reserved: false, ttl_ms: ttl as number,
        expires_up_ms: (ttl === null ? null : Number(v[2]) + ttl) as number, extended: false,
      };
      const c = id === null ? undefined : find(v[0], id);
      if (!c) {
        d.claims.push(checked({ ...fields, ready: false }));
        out.push({ shard_id: id });
        return;
      }
      if (!(c.released || c.expires_up_ms <= v[8])) return;
      Object.assign(c, checked({ ...c, ...fields }));
      out.push({ shard_id: c.shard_id });
    });
    return { rows: out };
  }
  if (t.startsWith('INSERT INTO smdb_data.reshard (id) VALUES (1) ON CONFLICT (id) DO NOTHING')) {
    if (d.reshard === null) d.reshard = { attempt: null, state: null, from_count: null, to_count: null };
    return { rows: [] };
  }
  if (t.startsWith('UPDATE smdb_data.reshard SET attempt = $4::uuid')) {
    if (d.reshard !== null) Object.assign(d.reshard, { attempt: v[3], from_count: v[0], to_count: v[1], state: 'done', started_by: v[2] });
    return { rows: [] };
  }
  if (t.startsWith("UPDATE smdb_data.reshard SET state = 'done'") && t.includes("state = 'stopping'")) {
    if (d.reshard !== null && d.reshard.attempt === v[0] && d.reshard.state === 'stopping') d.reshard.state = 'done';
    return { rows: [] };
  }
  if (t.startsWith('INSERT INTO smdb_data.reshard (id, target, target_by, target_at)')) {
    d.reshard = { attempt: null, state: null, from_count: null, to_count: null, ...d.reshard, target: v[0], target_by: v[1] };
    return { rows: [] };
  }
  throw new Error(`unscripted statement: ${t.slice(0, 80)}`);
}

async function storeOver(d: Db): Promise<ClaimStore> {
  const store = new ClaimStore('postgres://nobody@127.0.0.1:1/none', T);
  await (store as any).pool.end().catch(() => undefined);
  let saved: World | null = null;
  const client = {
    async query(config: any, values?: any[]) {
      const text = typeof config === 'string' ? config : config.text;
      const params = ((typeof config === 'string' ? values : config.values) ?? []).map(asPg);
      d.sent.push(text);
      const t = text.trim();
      if (t === 'BEGIN') {
        saved = structuredClone({ claims: d.claims, nodes: d.nodes, meta: d.meta, reshard: d.reshard, seq: d.seq });
        return { rows: [] };
      }
      if (t === 'COMMIT') { saved = null; return { rows: [] }; }
      if (t === 'ROLLBACK') {
        if (saved !== null) Object.assign(d, saved);
        saved = null;
        return { rows: [] };
      }
      return answer(d, text, params);
    },
    release() { /* nothing held */ },
  };
  (store as any).pool = { async connect() { return client; }, async end() { /* nothing to close */ }, on() { return this; } };
  return store;
}

function node(id: string, name: string, over: Record<string, unknown> = {}) {
  return {
    node_id: id, node_name: name, process_id: `p-${name.toLowerCase()}`, capacity: 1, takeover_seconds: 30, fit: true,
    restartable: true, returns: false, seen_ago_ms: 0, healthy_for_ms: null, ...over,
  };
}

const rowOf = (d: Db, count: number, id: number) => d.claims.find(c => c.shard_count === count && c.shard_id === id);

const retakeOf = (store: ClaimStore, pairs: Array<{ shardCount: number; shardId: number; claim: number }>) => store.retake({
  me: ME, shardCount: 4, generation: 0, ttlMs: T.ttlMs, pairs, guildIds: pairs.map(p => ({ shardId: p.shardId, guildIds: [] })),
});

const mineRow = (shardId: number, claim: number): Row => ({
  shard_count: 4, shard_id: shardId, claim, holder_process: 'p-a', holder_node: 'n-a', holder_name: 'A', home_node: 'n-a',
  released: false, reserved: true, ttl_ms: 30_000, expires_up_ms: UP_MS - 1, extended: true, ready: true,
});

describe('the re-take sends only the statements its picks need', () => {
  it('a re-take whose every pair has a row sends one TAKE_UPDATE_SQL and no TAKE_INSERT_SQL', async () => {
    const d = world({ meta: 4, claims: [mineRow(1, 6), mineRow(2, 7)] });
    const store = await storeOver(d);
    const answer = await retakeOf(store, [{ shardCount: 4, shardId: 1, claim: 6 }, { shardCount: 4, shardId: 2, claim: 7 }]);
    expect(answer.refused).toBeUndefined();
    expect(answer.taken.map(t => t.pair.shardId)).toEqual([1, 2]);
    expect(d.sent.filter(s => s === TAKE_INSERT_SQL)).toHaveLength(0);
    expect(d.sent.filter(s => s === TAKE_UPDATE_SQL)).toHaveLength(1);
    expect(d.sent.at(-1)).toBe('COMMIT');
    await store.end();
  });

  it('a re-take whose every pair has no row sends one TAKE_INSERT_SQL and no TAKE_UPDATE_SQL', async () => {
    const d = world({ meta: 4 });
    const store = await storeOver(d);
    const answer = await retakeOf(store, [{ shardCount: 4, shardId: 0, claim: 5 }, { shardCount: 4, shardId: 3, claim: 8 }]);
    expect(answer.refused).toBeUndefined();
    expect(answer.taken.map(t => t.pair.shardId)).toEqual([0, 3]);
    expect(d.sent.filter(s => s === TAKE_UPDATE_SQL)).toHaveLength(0);
    expect(d.sent.filter(s => s === TAKE_INSERT_SQL)).toHaveLength(1);
    expect(d.sent.at(-1)).toBe('COMMIT');
    await store.end();
  });
});

describe('the count-writing take with no other machine to keep shards for', () => {
  it('takes every shard and sends no SPREAD_SQL', async () => {
    const d = world({ meta: 1 });
    const store = await storeOver(d);
    const result = await store.take({
      me: ME, capacity: 1, ttlMs: T.ttlMs, boot: true, known: [], localCount: 2, reserve: false, writesMeta: { kind: 'direct', from: 1 },
    });
    expect(result.kind).toBe('done');
    if (result.kind !== 'done') return;
    expect(result.taken.map(t => t.pair.shardId)).toEqual([0, 1]);
    expect(result.spread).toEqual({ fromCount: 1, kept: [] });
    expect(d.sent.filter(s => s === SPREAD_SQL)).toHaveLength(0);
    expect(d.sent.at(-1)).toBe('COMMIT');
    await store.end();
  });
});

describe('the count-writing take counts this machine once when its own node row is listed (NB9 12)', () => {
  it('four shards over this machine and B, capacity 1 each: this machine takes 0 and 2, B keeps 1 and 3', async () => {
    const d = world({ meta: 1, nodes: [node('n-a', 'A', { process_id: 'p-a' }), node('n-b', 'B')] });
    const store = await storeOver(d);
    const result = await store.take({
      me: ME, capacity: 1, ttlMs: T.ttlMs, boot: true, known: [], localCount: 4, reserve: false, writesMeta: { kind: 'direct', from: 1 },
    });
    expect(result.kind).toBe('done');
    if (result.kind !== 'done') return;
    expect(result.taken.map(t => t.pair.shardId)).toEqual([0, 2]);
    expect(result.spread).toEqual({ fromCount: 1, kept: [{ nodeName: 'B', shardIds: [1, 3], seconds: 30 }] });
    expect([0, 1, 2, 3].map(id => rowOf(d, 4, id)?.holder_node)).toEqual(['n-a', 'n-b', 'n-a', 'n-b']);
    await store.end();
  });
});
