import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ClaimFailure, ClaimStore, CLOSE_SQL, GATE_DELETE_SQL, GATE_HELD_SQL, GATE_READ_SQL, TAKE_INSERT_SQL, TAKE_UPDATE_SQL,
} from '../../src/bot/internalSetup/fleet/claimStore';
import { claimTimings, type Pair } from '../../src/bot/internalSetup/fleet/claimRules';

// The standby take, the work lane's client and the move's re-take over a fake pool that keeps the claim and guild
// tables and answers the take writes by their SQL's rules, so each test reads the rows a call stored.

const T = claimTimings(30);
const me = { processId: 'p-a', nodeId: 'n-a', nodeName: 'A' };
const UP_MS = 1000;
const U_PRIME = 1200;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

interface Guild { guild_id: string; shard_count: number; shard_id: number; claim: number }

const pgError = (message: string, code: string) => Object.assign(new Error(message), { code, severity: 'ERROR' });

function arr(v: unknown): unknown[] {
  if (!Array.isArray(v)) throw pgError('could not determine data type of parameter', '42P18');
  return v;
}

function row(shardCount: number, shardId: number, claim: number, holder: string, extra: Partial<Row> = {}): Row {
  const node = holder === me.processId ? me.nodeId : `n-${holder}`;
  return {
    shard_count: shardCount, shard_id: shardId, claim, holder_process: holder, holder_node: node, holder_name: holder,
    home_node: node, released: false, reserved: false, ttl_ms: 30000, expires_up_ms: 50000, extended: false, ready: true, ...extra,
  };
}

function out(r: Row) {
  return {
    shard_count: r.shard_count, shard_id: r.shard_id, claim: String(r.claim), holder_process: r.holder_process,
    holder_node: r.holder_node, holder_name: r.holder_name, home_node: r.home_node, released: r.released, reserved: r.reserved,
    taken_at: 1, renewed_at: 2, ttl_ms: String(r.ttl_ms), expires_up_ms: String(r.expires_up_ms), extended: r.extended,
    renewed_ago_ms: 10,
  };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

function world() {
  const claims = new Map<string, Row>();
  const guilds: Guild[] = [];
  const sent: Array<{ text: string; values: unknown[] | undefined }> = [];
  const w = {
    claims, guilds, sent,
    seq: 100,
    reshard: { attempt: 'att-1', state: 'standby', reason: null, to_count: 2 } as Record<string, unknown>,
    gate: { attempt: null, state: null, from_count: null, to_count: null, target: null, target_by: null, target_at: null, meta_count: 4 } as Record<string, unknown>,
    generationTable: false,
    generations: [] as string[],
    beforeDraw: undefined as undefined | (() => void),
    fail: undefined as undefined | ((text: string) => Error | undefined),
    hold: undefined as undefined | ((text: string) => Promise<void> | undefined),
    put(r: Row) { claims.set(`${r.shard_count}:${r.shard_id}`, r); },
    get(count: number, id: number) { return claims.get(`${count}:${id}`); },
    texts() { return sent.map(s => s.text); },
  };

  function insert(values: unknown[]) {
    const [count, ids, cl, proc, node, name, rel, ttl, exp] = values;
    const idList = arr(ids);
    const claimList = arr(cl);
    if (typeof rel !== 'boolean') throw pgError('invalid input syntax for type boolean', '22P02');
    const rows: any[] = [];
    for (let i = 0; i < Math.max(idList.length, claimList.length); i++) {
      const id = idList[i];
      const claim = claimList[i];
      if (!Number.isInteger(id) || !Number.isInteger(claim)) throw pgError('null value violates not-null constraint', '23502');
      if (w.get(Number(count), id as number)) continue;
      w.put({
        shard_count: Number(count), shard_id: id as number, claim: claim as number, holder_process: proc as string,
        holder_node: node as string, holder_name: name as string, home_node: node as string, released: rel, reserved: rel,
        ttl_ms: Number(ttl), expires_up_ms: Number(exp), extended: false, ready: false,
      });
      rows.push({ shard_id: id, claim: String(claim) });
    }
    return rows;
  }

  function update(values: unknown[]) {
    if (values.length < 12) throw pgError('there is no parameter $1', '42P02');
    const [count, ids, cl, proc, node, name, rel, ttl, exp, oldClaims, oldHolders, up] = values;
    const idList = arr(ids);
    const claimList = arr(cl);
    const oldClaimList = arr(oldClaims);
    const oldHolderList = arr(oldHolders);
    if (typeof rel !== 'boolean') throw pgError('invalid input syntax for type boolean', '22P02');
    const rows: any[] = [];
    const n = Math.max(idList.length, claimList.length, oldClaimList.length, oldHolderList.length);
    for (let i = 0; i < n; i++) {
      const r = w.get(Number(count), idList[i] as number);
      if (!r || r.claim !== Number(oldClaimList[i]) || r.holder_process !== oldHolderList[i]) continue;
      if (!(r.expires_up_ms <= Number(up) || (r.released && r.holder_node === node) || r.holder_process === proc)) continue;
      const claim = claimList[i];
      if (!Number.isInteger(claim)) throw pgError('null value violates not-null constraint', '23502');
      Object.assign(r, {
        claim, holder_process: proc, holder_node: node, holder_name: name, released: rel, reserved: rel,
        ttl_ms: Number(ttl), expires_up_ms: Number(exp), extended: false, ready: false,
      });
      rows.push({ shard_id: r.shard_id, claim: String(claim) });
    }
    return rows;
  }

  function answer(text: string, values: unknown[]): any[] {
    const failure = w.fail?.(text);
    if (failure) throw failure;
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return [];
    if (text.includes('pg_advisory_xact_lock')) return [];
    if (/^SELECT up_ms::text/.test(text.trim())) return [{ up_ms: String(UP_MS), u_prime: String(U_PRIME), now_ms: 5000 }];
    if (text.includes('reason, to_count FROM smdb_data.reshard')) return [w.reshard];
    if (text === GATE_READ_SQL) return [w.gate];
    if (text === GATE_DELETE_SQL || text === GATE_HELD_SQL || text === CLOSE_SQL) return [];
    if (text.includes('to_regclass')) return [{ present: w.generationTable }];
    if (text.includes('FROM smdb_manager.generation')) {
      if (!w.generationTable) throw pgError('relation "smdb_manager.generation" does not exist', '42P01');
      return w.generations.map(generation => ({ generation }));
    }
    if (text.includes('FROM smdb_data.shard_claims WHERE shard_count = $1')) {
      if (!Number.isInteger(values[0])) throw pgError('there is no parameter $1', '42P02');
      return [...claims.values()].filter(r => r.shard_count === values[0]).map(out);
    }
    if (text.includes('FROM smdb_data.shard_claims WHERE shard_id = ANY($1::int[])')) {
      const ids = arr(values[0]);
      return [...claims.values()].filter(r => ids.includes(r.shard_id)).map(out);
    }
    if (text.includes('FROM smdb_data.shard_nodes')) return [];
    if (text.includes('FROM smdb_data.guild_ownership') && !text.includes('GREATEST(')) {
      if (values.length < 3) throw pgError('there is no parameter $1', '42P02');
      const ids = arr(values[1]);
      const gids = arr(values[2]);
      return guilds.filter(g => (g.shard_count === values[0] && ids.includes(g.shard_id)) || gids.includes(g.guild_id))
        .map(g => ({ ...g, claim: String(g.claim) }));
    }
    if (text.includes('GREATEST(')) {
      w.beforeDraw?.();
      const floor = Math.max(0, ...[...claims.values()].map(r => r.claim), ...guilds.map(g => g.claim));
      return [{ floor: String(floor) }];
    }
    if (text.includes('nextval')) {
      const k = Number(values[0]);
      return Array.from({ length: k }, () => ({ n: String(w.seq++) }));
    }
    if (text === TAKE_INSERT_SQL) return insert(values);
    if (text === TAKE_UPDATE_SQL) return update(values);
    if (text === 'SELECT 1') return [{ one: 1 }];
    throw new Error(`unexpected statement: ${text.slice(0, 60)}`);
  }

  const released: Array<boolean | undefined> = [];
  const pool = {
    async connect() {
      const pending: Array<(e: Error) => void> = [];
      return {
        async query(config: any) {
          const text = typeof config === 'string' ? config : config.text;
          const values = typeof config === 'string' ? undefined : config.values;
          sent.push({ text, values });
          const wait = w.hold?.(text);
          if (wait) {
            await new Promise<void>((resolve, reject) => { pending.push(reject); void wait.then(resolve); });
          }
          const rows = answer(text, values ?? []);
          return { rows, rowCount: rows.length };
        },
        release(destroy?: boolean) {
          released.push(destroy);
          if (destroy === true) for (const reject of pending.splice(0)) reject(new Error('Connection terminated'));
        },
      };
    },
    async end() { /* nothing open */ },
    on() { return pool; },
  };
  return Object.assign(w, { pool, released });
}

function storeOn(w: ReturnType<typeof world>): ClaimStore {
  const store = new ClaimStore('postgres://nobody@127.0.0.1:1/none', T);
  void (store as any).pool.end().catch(() => undefined);
  (store as any).pool = w.pool;
  return store;
}

const standbyRequest = (shardCount: number) => ({ me, capacity: 4, ttlMs: T.ttlMs, attempt: 'att-1', shardCount });
const retakeRequest = (pairs: Pair[], guildIds: Array<{ shardId: number; guildIds: string[] }> = []) =>
  ({ me, shardCount: 4, pairs, guildIds: guildIds.length > 0 ? guildIds : pairs.map(p => ({ shardId: p.shardId, guildIds: [] })), generation: 0, ttlMs: T.ttlMs });

function liveMine(r: Row | undefined, claim: number) {
  expect(r).toMatchObject({
    claim, holder_process: 'p-a', holder_node: 'n-a', holder_name: 'A', released: false, reserved: false,
    ttl_ms: T.ttlMs, expires_up_ms: U_PRIME + T.ttlMs, ready: false,
  });
}

describe('the standby take stores and answers what it took', () => {
  it('takes a missing shard and re-takes its own row of W, each live and unreleased until u\' plus the TTL, and answers both', async () => {
    const w = world();
    w.put(row(2, 1, 50, 'p-a', { expires_up_ms: 900 }));
    const store = storeOn(w);
    const answer = await store.standbyTake(standbyRequest(2));
    expect(answer.kind).toBe('done');
    expect(answer.kind === 'done' ? answer.taken : null).toEqual([
      { shardCount: 2, shardId: 1, claim: 100 },
      { shardCount: 2, shardId: 0, claim: 101 },
    ]);
    liveMine(w.get(2, 1), 100);
    liveMine(w.get(2, 0), 101);
    expect(w.claims.size).toBe(2);
    expect(w.texts().at(-1)).toBe('COMMIT');
  });

  it('with no row of W to re-take, inserts the new rows and sends no update', async () => {
    const w = world();
    const store = storeOn(w);
    const answer = await store.standbyTake(standbyRequest(1));
    expect(answer.kind === 'done' ? answer.taken : null).toEqual([{ shardCount: 1, shardId: 0, claim: 100 }]);
    liveMine(w.get(1, 0), 100);
    expect(w.texts()).toContain(TAKE_INSERT_SQL);
    expect(w.texts()).not.toContain(TAKE_UPDATE_SQL);
  });
});

describe('the work lane\'s client for reshardStore.ts', () => {
  it('sends a statement given no values with an empty parameter list', async () => {
    const w = world();
    const store = storeOn(w);
    const got = await store.withWorkClient('the check', client => client.query('SELECT 1'));
    expect(got.rows).toEqual([{ one: 1 }]);
    expect(w.sent).toEqual([{ text: 'SELECT 1', values: [] }]);
  });

  it('waits up to twice R for its work before it fails', async () => {
    const w = world();
    const gate = deferred();
    w.hold = text => (text === 'SELECT 1' ? gate.promise : undefined);
    const store = storeOn(w);
    vi.useFakeTimers();
    let settled = false;
    const call = store.withWorkClient('the check', client => client.query('SELECT 1')).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(2 * T.renewMs - 50);
    expect(settled).toBe(false);
    gate.resolve();
    await expect(call).resolves.toMatchObject({ rows: [{ one: 1 }] });
  });
});

describe('the move\'s re-take', () => {
  it('rolls back a re-take the gate refuses, before any commit, and writes nothing', async () => {
    const w = world();
    w.gate = { ...w.gate, meta_count: 8 };
    w.put(row(4, 3, 50, 'p-a'));
    const store = storeOn(w);
    const onCommitSent = vi.fn();
    const answer = await store.retake(retakeRequest([{ shardCount: 4, shardId: 3, claim: 40 }]), onCommitSent);
    expect(answer.taken).toEqual([]);
    expect(answer.refused?.kind).toBe('count');
    expect(onCommitSent).not.toHaveBeenCalled();
    expect(w.texts().at(-1)).toBe('ROLLBACK');
    expect(w.texts()).not.toContain('COMMIT');
    expect(w.get(4, 3)?.claim).toBe(50);
  });

  it('rolls back when a statement fails, and rejects', async () => {
    const w = world();
    w.fail = text => (text.includes('pg_advisory_xact_lock') ? pgError('could not obtain lock', '55P03') : undefined);
    const store = storeOn(w);
    const onCommitSent = vi.fn();
    await expect(store.retake(retakeRequest([{ shardCount: 4, shardId: 3, claim: 40 }]), onCommitSent)).rejects.toBeInstanceOf(ClaimFailure);
    expect(w.texts()).toEqual(['BEGIN', expect.stringContaining('pg_advisory_xact_lock'), 'ROLLBACK']);
    expect(onCommitSent).not.toHaveBeenCalled();
  });

  it('re-takes the row naming this process on a database with no generation table', async () => {
    const w = world();
    w.put(row(4, 3, 50, 'p-a'));
    const store = storeOn(w);
    const before = { shardCount: 4, shardId: 3, claim: 40 };
    const answer = await store.retake(retakeRequest([before]));
    expect(answer).toEqual({ taken: [{ before, pair: { shardCount: 4, shardId: 3, claim: 100 } }] });
    liveMine(w.get(4, 3), 100);
    expect(w.texts().some(t => t.includes('FROM smdb_manager.generation'))).toBe(false);
    expect(w.texts().at(-1)).toBe('COMMIT');
  });

  it('leaves a shard one of whose held guilds is owned elsewhere with a later claim', async () => {
    const w = world();
    w.guilds.push({ guild_id: 'g9', shard_count: 4, shard_id: 5, claim: 70 });
    const store = storeOn(w);
    const answer = await store.retake(retakeRequest([{ shardCount: 4, shardId: 2, claim: 40 }], [{ shardId: 2, guildIds: ['g9'] }]));
    expect(answer).toEqual({ taken: [] });
    expect(w.get(4, 2)).toBeUndefined();
    expect(w.claims.size).toBe(0);
  });

  it('with nothing to take, draws no claim number and leaves another process\'s row', async () => {
    const w = world();
    w.put(row(4, 3, 50, 'p-z'));
    const store = storeOn(w);
    const answer = await store.retake(retakeRequest([{ shardCount: 4, shardId: 3, claim: 40 }]));
    expect(answer).toEqual({ taken: [] });
    expect(w.texts().some(t => t.includes('max(claim)') || t.includes('nextval'))).toBe(false);
    expect(w.get(4, 3)).toMatchObject({ claim: 50, holder_process: 'p-z' });
  });

  it('does not write a row that was read as this process\'s and is gone at the write', async () => {
    const w = world();
    w.put(row(4, 3, 50, 'p-a'));
    w.beforeDraw = () => { w.claims.delete('4:3'); };
    const store = storeOn(w);
    const answer = await store.retake(retakeRequest([{ shardCount: 4, shardId: 3, claim: 40 }]));
    expect(answer).toEqual({ taken: [] });
    expect(w.get(4, 3)).toBeUndefined();
  });

  it('waits up to twice R for its transaction before it fails', async () => {
    const w = world();
    w.put(row(4, 3, 50, 'p-a'));
    const gate = deferred();
    w.hold = text => (text === 'BEGIN' ? gate.promise : undefined);
    const store = storeOn(w);
    vi.useFakeTimers();
    let settled = false;
    const call = store.retake(retakeRequest([{ shardCount: 4, shardId: 3, claim: 40 }])).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(2 * T.renewMs - 50);
    expect(settled).toBe(false);
    gate.resolve();
    const answer = await call;
    expect(answer.taken).toHaveLength(1);
    expect(w.get(4, 3)?.claim).toBe(100);
  });

  it('names the re-take in the cause of a failure that got no answer', async () => {
    const w = world();
    w.hold = text => (text === 'BEGIN' ? new Promise<void>(() => undefined) : undefined);
    const store = storeOn(w);
    vi.useFakeTimers();
    const call = store.retake(retakeRequest([{ shardCount: 4, shardId: 3, claim: 40 }])).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2 * T.renewMs + 10);
    const error = await call;
    expect(error).toBeInstanceOf(ClaimFailure);
    expect((error as ClaimFailure).failure).toEqual({ kind: 'timeout' });
    expect(((error as ClaimFailure).cause as Error).message).toBe('the re-take got no answer in time');
    expect(w.released).toContain(true);
  });
});
