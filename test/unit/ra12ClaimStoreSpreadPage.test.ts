import { describe, expect, it } from 'vitest';

import {
  ClaimStore, GATE_DELETE_SQL, GATE_HELD_SQL, GATE_READ_SQL, PAGE_ATTEMPT_ROWS_SQL, PAGE_RESHARD_SQL, TAKE_INSERT_SQL, TAKE_UPDATE_SQL,
} from '../../src/bot/internalSetup/fleet/claimStore';
import { claimTimings } from '../../src/bot/internalSetup/fleet/claimRules';

// ClaimStore over an in-memory table set that answers each statement by what its text says, as Postgres would:
// parameters bound by number, and a statement nobody scripted is an error.

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
}

interface Db {
  claims: Row[];
  nodes: any[];
  meta: number | null;
  reshard: Record<string, any> | null;
  page: Record<string, any> | null;
  counted: Record<string, any> | null;
  seq: number;
  sent: string[];
}

function world(over: Partial<Db> = {}): Db {
  return { claims: [], nodes: [], meta: null, reshard: null, page: null, counted: null, seq: 100, sent: [], ...over };
}

function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, severity: 'ERROR' });
}

const asPg = (v: unknown): unknown => (v === undefined ? null : Array.isArray(v) ? v.map(asPg) : v);

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
  if (t === '') throw pgError('42601', 'syntax error: empty statement');
  const find = (count: number, id: number) => d.claims.find(c => c.shard_count === count && c.shard_id === id);
  if (/^(BEGIN|COMMIT|ROLLBACK)/.test(t) || t.includes('pg_advisory_xact_lock')) return { rows: [] };
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
  if (text === PAGE_RESHARD_SQL) return { rows: [d.page] };
  if (text === PAGE_ATTEMPT_ROWS_SQL) return { rows: [d.counted] };
  if (t.startsWith('SELECT value FROM smdb_data.meta')) return { rows: d.meta === null ? [] : [{ value: JSON.stringify({ count: d.meta }) }] };
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
  if (t.startsWith('SELECT shard_count, shard_id, claim::text AS claim') && t.includes('FROM smdb_data.shard_claims')) {
    return { rows: d.claims.filter(c => v.length === 0 || c.shard_count === v[0]).map(rowOut) };
  }
  if (t.startsWith('SELECT node_id, node_name')) return { rows: d.nodes };
  if (t.startsWith('SELECT GREATEST(') && t.includes('max(claim)')) {
    return { rows: [{ floor: String(Math.max(0, ...d.claims.map(c => c.claim))) }] };
  }
  if (t.startsWith("SELECT nextval('smdb_data.claim_seq')")) {
    return { rows: Array.from({ length: Math.max(0, Number(v[0])) }, () => ({ n: String(d.seq++) })) };
  }
  if (t.startsWith("SELECT setval('smdb_data.claim_seq'")) {
    d.seq = Number(v[0]) + 1;
    return { rows: [] };
  }
  if (text === TAKE_INSERT_SQL) {
    const out: any[] = [];
    (v[1] as number[]).forEach((id, i) => {
      if (find(v[0], id)) return;
      d.claims.push({
        shard_count: v[0], shard_id: id, claim: Number(v[2][i]), holder_process: v[3], holder_node: v[4], holder_name: v[5],
        home_node: v[4], released: v[6], reserved: v[6], ttl_ms: Number(v[7]), expires_up_ms: Number(v[8]), extended: false,
      });
      out.push({ shard_id: id, claim: String(v[2][i]) });
    });
    return { rows: out };
  }
  if (text === TAKE_UPDATE_SQL) return { rows: [] };
  if (t.startsWith('INSERT INTO smdb_data.shard_claims AS c') && t.includes("$2::text, p.node_id, p.node_name, p.node_id, true, false")
    && t.includes('ON CONFLICT (shard_count, shard_id) DO UPDATE SET') && t.endsWith('RETURNING c.shard_id')) {
    const out: any[] = [];
    (v[3] as number[]).forEach((id, i) => {
      const fields: Row = {
        shard_count: v[0], shard_id: id, claim: Number(v[4][i]), holder_process: v[1], holder_node: v[5][i], holder_name: v[6][i],
        home_node: v[5][i], released: true, reserved: false, ttl_ms: Number(v[7][i]), expires_up_ms: Number(v[2]) + Number(v[7][i]),
        extended: false,
      };
      const c = find(v[0], id);
      if (!c) {
        d.claims.push(fields);
        out.push({ shard_id: id });
        return;
      }
      if (!(c.released || c.expires_up_ms <= v[8])) return;
      Object.assign(c, fields);
      out.push({ shard_id: id });
    });
    return { rows: out };
  }
  if (t.startsWith('UPDATE smdb_data.shard_claims c') && t.includes('SET claim = p.claim, taken_at = now(), renewed_at = now(), ttl_ms = $4::bigint')
    && t.includes('WHERE c.holder_process = $1::text AND c.shard_count = $6::int') && t.endsWith('RETURNING c.shard_id, c.claim::text AS claim')) {
    const out: any[] = [];
    for (const c of d.claims) {
      const i = (v[1] as number[]).indexOf(c.shard_id);
      if (i < 0 || c.holder_process !== v[0] || c.shard_count !== v[5] || c.released || c.expires_up_ms <= v[6] || d.meta !== v[5]) continue;
      c.claim = Number(v[2][i]);
      c.ttl_ms = Number(v[3]);
      c.expires_up_ms = Number(v[4]);
      out.push({ shard_id: c.shard_id, claim: String(c.claim) });
    }
    return { rows: out };
  }
  if (t.startsWith('INSERT INTO smdb_data.reshard (id) VALUES (1) ON CONFLICT (id) DO NOTHING')) {
    if (d.reshard === null) d.reshard = { attempt: null, state: null, from_count: null, to_count: null };
    return { rows: [] };
  }
  if (t.startsWith('UPDATE smdb_data.reshard SET attempt = $4::uuid')) {
    if (d.reshard !== null) Object.assign(d.reshard, { attempt: v[3], from_count: v[0], to_count: v[1], state: 'done' });
    return { rows: [] };
  }
  if (t.startsWith("UPDATE smdb_data.reshard SET state = 'done'")) return { rows: [] };
  throw new Error(`unscripted statement: ${t.slice(0, 80)}`);
}

async function storeOver(d: Db): Promise<ClaimStore> {
  const store = new ClaimStore('postgres://nobody@127.0.0.1:1/none', T);
  await (store as any).pool.end().catch(() => undefined);
  const client = {
    async query(config: any, values?: any[]) {
      const text = typeof config === 'string' ? config : config.text;
      const params = ((typeof config === 'string' ? values : config.values) ?? []).map(asPg);
      d.sent.push(text);
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

const directChange = (store: ClaimStore) => store.take({
  me: ME, capacity: 1, ttlMs: T.ttlMs, boot: true, known: [], localCount: 2, reserve: false, writesMeta: { kind: 'direct', from: 1 },
});

describe('ra12 the count-writing take spreads the shards over this machine and the live restartable machines', () => {
  it('a live restartable machine gets its shard kept for it, this machine takes its own, the plan leaves one to others', async () => {
    const d = world({ meta: 1, nodes: [node('n-b', 'B')] });
    const store = await storeOver(d);
    const result = await directChange(store);
    expect(result.kind).toBe('done');
    if (result.kind !== 'done') return;
    expect(result.taken.map(t => t.pair.shardId)).toEqual([0]);
    expect(result.plan.takes.map(t => t.shardId)).toEqual([0]);
    expect(result.plan.leftToOthers).toBe(1);
    expect(result.spread).toEqual({ fromCount: 1, kept: [{ nodeName: 'B', shardIds: [1], seconds: 30 }] });
    expect(rowOf(d, 2, 0)).toMatchObject({ holder_process: 'p-a', holder_node: 'n-a', released: false });
    expect(rowOf(d, 2, 1)).toMatchObject({ holder_node: 'n-b', holder_name: 'B', released: true, holder_process: expect.stringMatching(/^spread:/) });
    expect(d.claims).toHaveLength(2);
    expect(d.sent.at(-1)).toBe('COMMIT');
    await store.end();
  });

  it('two shards kept for one machine are named in one line with both ids', async () => {
    const d = world({ meta: 1, nodes: [node('n-b', 'B', { capacity: 2, takeover_seconds: 45 })] });
    const store = await storeOver(d);
    const result = await store.take({
      me: ME, capacity: 1, ttlMs: T.ttlMs, boot: true, known: [], localCount: 3, reserve: false, writesMeta: { kind: 'direct', from: 1 },
    });
    expect(result.kind).toBe('done');
    if (result.kind !== 'done') return;
    expect(result.spread).toEqual({ fromCount: 1, kept: [{ nodeName: 'B', shardIds: [1, 2], seconds: 45 }] });
    expect(result.plan.leftToOthers).toBe(2);
    await store.end();
  });

  for (const [label, over] of [
    ['a machine that is not restartable', { restartable: false }],
    ['a machine not seen within its takeover time', { seen_ago_ms: 30_000 }],
  ] as const) {
    it(`${label} gets nothing kept, and this machine takes every shard`, async () => {
      const d = world({ meta: 1, nodes: [node('n-b', 'B', over)] });
      const store = await storeOver(d);
      const result = await directChange(store);
      expect(result.kind).toBe('done');
      if (result.kind !== 'done') return;
      expect(result.taken.map(t => t.pair.shardId)).toEqual([0, 1]);
      expect(result.plan.leftToOthers).toBe(0);
      expect(result.spread).toEqual({ fromCount: 1, kept: [] });
      expect(d.claims.every(c => c.holder_process === 'p-a' && c.holder_node === 'n-a' && !c.released)).toBe(true);
      expect(d.claims).toHaveLength(2);
      await store.end();
    });
  }
});

describe('ra12 the redraw writes fresh claims on this process\'s live rows', () => {
  it('returns the redrawn pairs with the claims it stored', async () => {
    const live = (id: number): Row => ({
      shard_count: 2, shard_id: id, claim: 7 + id, holder_process: 'p-a', holder_node: 'n-a', holder_name: 'A', home_node: 'n-a',
      released: false, reserved: false, ttl_ms: 30_000, expires_up_ms: UP_MS + 5_000, extended: false,
    });
    const d = world({ meta: 2, claims: [live(0), live(1)] });
    const store = await storeOver(d);
    const result = await store.redraw({ me: ME, shardCount: 2, shardIds: [0, 1], ttlMs: T.ttlMs });
    expect(result.kind).toBe('done');
    if (result.kind !== 'done') return;
    expect(result.pairs).toEqual([
      { shardCount: 2, shardId: 0, claim: rowOf(d, 2, 0)!.claim },
      { shardCount: 2, shardId: 1, claim: rowOf(d, 2, 1)!.claim },
    ]);
    expect(rowOf(d, 2, 0)!.claim).toBeGreaterThan(8);
    expect(rowOf(d, 2, 0)!.expires_up_ms).toBe(U_PRIME + T.ttlMs);
    expect(d.sent.at(-1)).toBe('COMMIT');
    await store.end();
  });
});

describe('ra12 the page read names the machines a count change waits for', () => {
  const attemptPage = {
    attempt: '11111111-1111-4111-8111-111111111111', state: 'stopping', from_count: 1, to_count: 2, target: 2, target_by: 'A',
    target_at: null, meta_count: 1, method: 'stop-start', reason: null, started_ago_ms: 1000, until_ms: null, ended_ago_ms: null,
  };

  it('keeps only the names in waiting_for', async () => {
    const d = world({ meta: 1, page: attemptPage, counted: { connected: 1, waiting_for: ['B', null, 3, 'C'] } });
    const store = await storeOver(d);
    const page = await store.readPage(1);
    expect(page.attempt?.waitingFor).toEqual(['B', 'C']);
    expect(page.attempt?.connected).toBe(1);
    await store.end();
  });

  it('with no attempt in the row, it waits for no machine', async () => {
    const d = world({ meta: 1, page: { ...attemptPage, attempt: null } });
    const store = await storeOver(d);
    const page = await store.readPage(1);
    expect(page.attempt?.waitingFor).toEqual([]);
    expect(page.attempt?.connected).toBe(0);
    expect(d.sent).not.toContain(PAGE_ATTEMPT_ROWS_SQL);
    await store.end();
  });
});
