import { describe, expect, it } from 'vitest';

import { ClaimFailure, ClaimStore, TAKE_INSERT_SQL, TAKE_UPDATE_SQL } from '../../src/bot/internalSetup/fleet/claimStore';
import { claimTimings } from '../../src/bot/internalSetup/fleet/claimRules';

// The standby take over a pool whose tables answer as Postgres would for the statements it sends: parameters bound
// by number (a count that differs is pg's bind error), writes kept apart until COMMIT and dropped at ROLLBACK.

const T = claimTimings(30);
const ME = { processId: 'p-me', nodeId: 'n-me', nodeName: 'Me' };
const UP_MS = 50_000;
const ATTEMPT = '11111111-1111-4111-8111-111111111111';

interface Row {
  shard_count: number;
  shard_id: number;
  claim: string;
  holder_process: string;
  holder_node: string;
  holder_name: string;
  home_node: string;
  released: boolean;
  reserved: boolean;
  ready: boolean;
  expires_up_ms: number;
}

interface NodeFact {
  node_id: string;
  node_name: string;
  process_id: string;
  capacity: number;
  takeover_seconds: number;
  fit: boolean;
  restartable: boolean;
  returns: boolean;
  seen_ago_ms: number;
  healthy_for_ms: number | null;
}

interface Db {
  reshard: { attempt: string | null; state: string | null; reason: string | null; to_count: number | null } | null;
  claims: Row[];
  nodes: NodeFact[];
  work: Row[] | null;
  sent: string[];
  fail?: (text: string) => boolean;
}

function db(over: Partial<Db> = {}): Db {
  return {
    reshard: { attempt: ATTEMPT, state: 'standby', reason: null, to_count: 2 },
    claims: [], nodes: [], work: null, sent: [], ...over,
  };
}

function row(shard_count: number, shard_id: number, over: Partial<Row> = {}): Row {
  return {
    shard_count, shard_id, claim: '7', holder_process: 'p-b', holder_node: 'n-b', holder_name: 'B', home_node: 'n-b',
    released: false, reserved: false, ready: true, expires_up_ms: UP_MS + 60_000, ...over,
  };
}

const clone = (rows: Row[]) => rows.map(r => ({ ...r }));

function pgError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function answer(d: Db, text: string, v: any[]): { rows: any[] } {
  const wanted = Math.max(0, ...[...text.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
  if (v.length < wanted || (v.length > 0 && v.length !== wanted)) {
    throw pgError(`bind message supplies ${v.length} parameters, but prepared statement "" requires ${wanted}`, '08P01');
  }
  if (d.fail?.(text)) throw pgError('permission denied', '42501');
  const t = text.trim();
  if (t === '') return { rows: [] };
  if (t === 'BEGIN') { d.work = clone(d.claims); return { rows: [] }; }
  if (t === 'COMMIT') { if (d.work) d.claims = d.work; d.work = null; return { rows: [] }; }
  if (t === 'ROLLBACK') { d.work = null; return { rows: [] }; }
  if (t.includes('pg_advisory_xact_lock')) return { rows: [] };
  if (t.startsWith('SELECT up_ms::text AS up_ms')) return { rows: [{ up_ms: String(UP_MS), u_prime: String(UP_MS), now_ms: Date.now() }] };
  if (t.startsWith('SELECT attempt::text AS attempt, state, reason, to_count FROM smdb_data.reshard')) {
    return { rows: d.reshard === null ? [] : [{ ...d.reshard }] };
  }
  const table = d.work ?? d.claims;
  if (t.startsWith('SELECT') && t.includes('FROM smdb_data.shard_claims WHERE shard_count = $1')) {
    return {
      rows: table.filter(r => r.shard_count === v[0]).map(r => ({
        ...r, expires_up_ms: String(r.expires_up_ms), ttl_ms: '30000', taken_at: 0, renewed_at: 0, extended: false, renewed_ago_ms: 0,
      })),
    };
  }
  if (t.startsWith('SELECT') && t.includes('FROM smdb_data.shard_nodes')) return { rows: d.nodes.map(n => ({ ...n })) };
  if (t.startsWith('SELECT GREATEST(')) return { rows: [{ floor: '0' }] };
  if (t.startsWith("SELECT nextval('smdb_data.claim_seq')")) return { rows: Array.from({ length: v[0] }, (_, i) => ({ n: String(100 + i) })) };
  if (text === TAKE_INSERT_SQL) {
    const out: any[] = [];
    (v[1] as number[]).forEach((id, i) => {
      if (table.some(r => r.shard_count === v[0] && r.shard_id === id)) return;
      const claim = String((v[2] as number[])[i]);
      table.push({
        shard_count: v[0], shard_id: id, claim, holder_process: v[3], holder_node: v[4], holder_name: v[5], home_node: v[4],
        released: v[6], reserved: v[6], ready: false, expires_up_ms: v[8],
      });
      out.push({ shard_id: id, claim });
    });
    return { rows: out };
  }
  if (text === TAKE_UPDATE_SQL) {
    const out: any[] = [];
    (v[1] as number[]).forEach((id, i) => {
      const r = table.find(c => c.shard_count === v[0] && c.shard_id === id && c.claim === String((v[9] as number[])[i])
        && c.holder_process === (v[10] as string[])[i]
        && (c.expires_up_ms <= v[11] || (c.released && c.holder_node === v[4]) || c.holder_process === v[3]));
      if (!r) return;
      Object.assign(r, {
        claim: String((v[2] as number[])[i]), holder_process: v[3], holder_node: v[4], holder_name: v[5], released: v[6],
        reserved: v[6], expires_up_ms: v[8], ready: false,
      });
      out.push({ shard_id: id, claim: r.claim });
    });
    return { rows: out };
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

const take = (store: ClaimStore, shardCount = 2, capacity = 4) =>
  store.standbyTake({ me: ME, capacity, ttlMs: T.ttlMs, attempt: ATTEMPT, shardCount });

const mine = (d: Db, shardCount: number) =>
  d.claims.filter(r => r.shard_count === shardCount).sort((a, b) => a.shard_id - b.shard_id)
    .map(r => ({ id: r.shard_id, claim: r.claim, holder: r.holder_process, node: r.holder_node, ready: r.ready, released: r.released }));

describe('the standby take refuses when the reshard row no longer holds its attempt in standby', () => {
  it('a flipped attempt answers its own attempt, state, reason and count, and writes nothing', async () => {
    const d = db({ reshard: { attempt: ATTEMPT, state: 'flipped', reason: 'stopped by the operator', to_count: 4 } });
    const store = await storeOver(d);
    const out = await take(store);
    expect(out).toEqual({ kind: 'not-standby', attempt: ATTEMPT, state: 'flipped', reason: 'stopped by the operator', toCount: 4 });
    expect(d.claims).toEqual([]);
    expect(d.sent).not.toContain(TAKE_INSERT_SQL);
    await store.end();
  });

  it('no reshard row answers every field null', async () => {
    const d = db({ reshard: null });
    const store = await storeOver(d);
    await expect(take(store)).resolves.toEqual({ kind: 'not-standby', attempt: null, state: null, reason: null, toCount: null });
    expect(d.claims).toEqual([]);
    await store.end();
  });

  it('another attempt in standby with no target count answers a null count, not zero', async () => {
    const other = '22222222-2222-4222-8222-222222222222';
    const d = db({ reshard: { attempt: other, state: 'standby', reason: null, to_count: null } });
    const store = await storeOver(d);
    await expect(take(store)).resolves.toEqual({ kind: 'not-standby', attempt: other, state: 'standby', reason: null, toCount: null });
    expect(d.claims).toEqual([]);
    await store.end();
  });
});

describe('the standby take of rows of count W', () => {
  it('takes every free shard of W as new rows, not ready, and commits them; rows of other counts stay', async () => {
    const d = db({ claims: [row(1, 0)] });
    const store = await storeOver(d);
    const out = await take(store);
    expect(out.kind).toBe('done');
    expect(out.kind === 'done' && out.taken).toEqual([{ shardCount: 2, shardId: 0, claim: 100 }, { shardCount: 2, shardId: 1, claim: 101 }]);
    expect(mine(d, 2)).toEqual([
      { id: 0, claim: '100', holder: 'p-me', node: 'n-me', ready: false, released: false },
      { id: 1, claim: '101', holder: 'p-me', node: 'n-me', ready: false, released: false },
    ]);
    expect(mine(d, 1)).toEqual([{ id: 0, claim: '7', holder: 'p-b', node: 'n-b', ready: true, released: false }]);
    await store.end();
  });

  it('retakes an expired row of W from a machine that is gone, beside a new row', async () => {
    const d = db({ claims: [row(2, 0, { expires_up_ms: UP_MS - 1 })] });
    const store = await storeOver(d);
    const out = await take(store);
    expect(out.kind === 'done' && out.taken).toEqual([{ shardCount: 2, shardId: 0, claim: 100 }, { shardCount: 2, shardId: 1, claim: 101 }]);
    expect(mine(d, 2)).toEqual([
      { id: 0, claim: '100', holder: 'p-me', node: 'n-me', ready: false, released: false },
      { id: 1, claim: '101', holder: 'p-me', node: 'n-me', ready: false, released: false },
    ]);
    await store.end();
  });

  it('waits while this machine\'s earlier process still holds a live row of W, and takes nothing', async () => {
    const held = row(2, 0, { holder_process: 'p-old', holder_node: 'n-me', home_node: 'n-me', holder_name: 'Me' });
    const d = db({ claims: [held] });
    const store = await storeOver(d);
    const out = await take(store);
    expect(out.kind).toBe('done');
    expect(out.kind === 'done' && out.taken).toEqual([]);
    expect(out.kind === 'done' && out.plan.wait).toEqual({ shardIds: [0], remainingMs: 60_000 });
    expect(d.claims).toEqual([held]);
    await store.end();
  });

  it('leaves an expired row of W to its machine while that machine is seen with a new process', async () => {
    const d = db({
      claims: [row(1, 0, { expires_up_ms: UP_MS - 1 })],
      nodes: [{
        node_id: 'n-b', node_name: 'B', process_id: 'p-b2', capacity: 4, takeover_seconds: 60, fit: true, restartable: true,
        returns: true, seen_ago_ms: 0, healthy_for_ms: null,
      }],
    });
    const store = await storeOver(d);
    const out = await take(store, 1);
    expect(out.kind === 'done' && out.taken).toEqual([]);
    expect(out.kind === 'done' && out.plan.waitingForOwner).toBe(1);
    expect(mine(d, 1)).toEqual([{ id: 0, claim: '7', holder: 'p-b', node: 'n-b', ready: true, released: false }]);
    await store.end();
  });

  it('with nothing to take, draws no claim number: a refused claim number read does not fail the take', async () => {
    const held = row(2, 0, { holder_process: 'p-old', holder_node: 'n-me', home_node: 'n-me', holder_name: 'Me' });
    const d = db({ claims: [held], fail: text => text.trim().startsWith('SELECT GREATEST(') || text.includes('claim_seq') });
    const store = await storeOver(d);
    const out = await take(store);
    expect(out.kind === 'done' && out.taken).toEqual([]);
    expect(d.claims).toEqual([held]);
    await store.end();
  });

  it('a take of only expired rows writes them by the guarded update, so a refused insert does not fail it', async () => {
    const d = db({ claims: [row(1, 0, { expires_up_ms: UP_MS - 1 })], fail: text => text === TAKE_INSERT_SQL });
    const store = await storeOver(d);
    const out = await take(store, 1);
    expect(out.kind === 'done' && out.taken).toEqual([{ shardCount: 1, shardId: 0, claim: 100 }]);
    await store.end();
  });

  it('a refused insert fails a take of a new row as a claim failure and commits nothing', async () => {
    const d = db({ fail: text => text === TAKE_INSERT_SQL });
    const store = await storeOver(d);
    await expect(take(store)).rejects.toBeInstanceOf(ClaimFailure);
    expect(d.claims).toEqual([]);
    await store.end();
  });
});
