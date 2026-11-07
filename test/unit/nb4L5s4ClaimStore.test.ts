import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClaimStore, classifyFailure } from '../../src/bot/internalSetup/fleet/claimStore';
import { claimTimings } from '../../src/bot/internalSetup/fleet/claimRules';

// NB4 decisions 2, 5, 10 and 13 on the claims store: the client bounds and their destroyed connections, the lanes
// abandonWork reaches, the login-refused listener, what the renewal sends and answers, and the take's shard count,
// rows, nodes and writes. The pool is a fake that answers as node-pg and Postgres do: a statement sent with bound
// values it has no placeholders for is refused (08P01), and a transaction lasts from BEGIN to COMMIT or ROLLBACK.

const T = claimTimings(30);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Answer = { rows?: any[] } | 'hang' | Error;

interface Sent {
  text: string;
  values: unknown[];
  inTx: boolean;
}

interface FakeClient {
  id: number;
  sent: Sent[];
  released: Array<boolean | undefined>;
  committed: boolean;
  query: (config: any, values?: unknown[]) => Promise<any>;
  release: (destroy?: boolean) => void;
}

type Script = (text: string, client: FakeClient, values: unknown[]) => Answer | Promise<Answer>;

function placeholders(text: string): number {
  let max = 0;
  for (const m of text.matchAll(/\$(\d+)/g)) max = Math.max(max, Number(m[1]));
  return max;
}

function makeClient(id: number, script: Script): FakeClient {
  let inTx = false;
  const client: FakeClient = {
    id,
    sent: [],
    released: [],
    committed: false,
    query(config: any, values?: unknown[]) {
      const text: string = typeof config === 'string' ? config : config.text;
      const bound: unknown[] = (typeof config === 'string' ? values : config.values) ?? [];
      const trimmed = text.trim();
      if (bound.length > 0 && placeholders(trimmed) !== bound.length) {
        return Promise.reject(Object.assign(new Error(`bind message supplies ${bound.length} parameters, but prepared statement "" requires ${placeholders(trimmed)}`), { code: '08P01' }));
      }
      if (/^BEGIN/.test(trimmed)) inTx = true;
      client.sent.push({ text: trimmed, values: bound, inTx });
      if (/^COMMIT/.test(trimmed)) { if (inTx) client.committed = true; inTx = false; }
      if (/^ROLLBACK/.test(trimmed)) inTx = false;
      return Promise.resolve(script(trimmed, client, bound)).then(answer => {
        if (answer === 'hang') return new Promise(() => undefined);
        if (answer instanceof Error) throw answer;
        const rows = answer.rows ?? [];
        return { rows, rowCount: rows.length };
      });
    },
    release(destroy?: boolean) { client.released.push(destroy); },
  };
  return client;
}

function fakePool(script: Script, opts: { connect?: () => Promise<void>; reuse?: boolean } = {}) {
  const clients: FakeClient[] = [];
  const pool = {
    async connect() {
      await opts.connect?.();
      if (opts.reuse && clients.length > 0) return clients[0];
      const client = makeClient(clients.length + 1, script);
      clients.push(client);
      return client;
    },
    async end() { /* nothing open */ },
    on() { return pool; },
  };
  return { pool, clients };
}

function storeWith(pool: object, onRefused: () => void = () => undefined): ClaimStore {
  const store = new ClaimStore('postgres://nobody@127.0.0.1:1/none', T, onRefused);
  void (store as any).pool.end().catch(() => undefined);
  (store as any).pool = pool;
  return store;
}

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

const me = { processId: 'p-a', nodeId: 'n-a', nodeName: 'A' };
const hb = { capacity: 4, takeoverSeconds: 30, fit: true, restartable: true, returns: true, startedAt: 0 };
const renewReq = (pairs: Array<{ shardCount: number; shardId: number; claim: number }> = []) => ({ me, pairs, ttlMs: T.ttlMs, heartbeat: hb });
const RENEWAL = /^WITH pairs AS/;

function renewScript(answer: { at: unknown; prior_process: unknown; rows: unknown }): Script {
  return text => (RENEWAL.test(text) ? { rows: [answer] } : { rows: [] });
}

// ---- the take's database ----

interface RowSpec {
  count: number;
  id: number;
  claim?: number;
  holderProcess?: string;
  holderNode?: string;
  released?: boolean;
  expiresUpMs?: number;
  renewedAt?: number;
}

function rawRow(r: RowSpec) {
  const node = r.holderNode ?? 'n-b';
  return {
    shard_count: r.count, shard_id: r.id, claim: String(r.claim ?? 5), holder_process: r.holderProcess ?? 'p-b',
    holder_node: node, holder_name: node === 'n-a' ? 'A' : 'B', home_node: node, released: r.released ?? false,
    reserved: false, taken_at: 100, renewed_at: r.renewedAt ?? 500, ttl_ms: '30000',
    expires_up_ms: String(r.expiresUpMs ?? 999_999), extended: false, renewed_ago_ms: 0,
  };
}

function rawNode(nodeId: string, capacity: number) {
  return {
    node_id: nodeId, node_name: nodeId.toUpperCase(), process_id: `p-${nodeId}`, capacity, takeover_seconds: 30,
    fit: true, restartable: true, returns: true, seen_ago_ms: 0, healthy_for_ms: 600_000,
  };
}

function takeDb(opts: { stored?: number | null; rows?: RowSpec[]; nodes?: any[] }): Script {
  let next = 100;
  return (text, _client, values) => {
    if (/pg_advisory_xact_lock/.test(text)) return { rows: [{}] };
    if (/FROM smdb_data\.claim_clock/.test(text)) return { rows: [{ up_ms: '1000', u_prime: '1000', now_ms: 0 }] };
    if (/LEFT JOIN smdb_data\.reshard/.test(text)) {
      return { rows: [{ attempt: null, state: null, from_count: null, to_count: null, target: null, target_by: null, target_at: null, meta_count: opts.stored ?? null }] };
    }
    const dead = (r: RowSpec) => r.released === true || (r.expiresUpMs ?? 999_999) <= 1000;
    if (/^DELETE FROM smdb_data\.shard_claims c/.test(text)) {
      return { rows: (opts.rows ?? []).filter(r => r.count !== values[0] && dead(r)).map(r => ({ shard_count: r.count, shard_id: r.id, released: r.released ?? false })) };
    }
    if (/^SELECT c\.shard_count, c\.shard_id, c\.holder_name/.test(text)) {
      return { rows: (opts.rows ?? []).filter(r => r.count !== values[0] && !dead(r)).map(r => ({ shard_count: r.count, shard_id: r.id, holder_name: rawRow(r).holder_name })) };
    }
    if (/AS renewed_ago_ms\s+FROM smdb_data\.shard_claims WHERE shard_count = \$1$/.test(text)) {
      return { rows: (opts.rows ?? []).filter(r => r.count === values[0]).map(rawRow) };
    }
    if (/AS healthy_for_ms\s+FROM smdb_data\.shard_nodes$/.test(text)) return { rows: opts.nodes ?? [] };
    if (/AS floor/.test(text)) return { rows: [{ floor: '0' }] };
    if (/nextval/.test(text)) {
      const k = Number(values[0]);
      return { rows: Array.from({ length: k }, () => ({ n: String(next++) })) };
    }
    if (/^INSERT INTO smdb_data\.shard_claims/.test(text) || /^UPDATE smdb_data\.shard_claims/.test(text)) {
      const ids = values[1] as number[];
      const claims = values[2] as number[];
      return { rows: ids.map((id, i) => ({ shard_id: id, claim: String(claims[i]) })) };
    }
    return { rows: [] };
  };
}

const takeReq = (o: { localCount: number | null; capacity?: number; boot?: boolean }) => ({
  me, capacity: o.capacity ?? 4, ttlMs: T.ttlMs, boot: o.boot ?? false, known: [], localCount: o.localCount, reserve: false,
});

async function runTake(db: Script, req: ReturnType<typeof takeReq>) {
  const { pool, clients } = fakePool(db);
  const store = storeWith(pool);
  const answer = await store.take(req);
  return { answer: answer as any, sent: clients[0].sent, client: clients[0] };
}

const takenIds = (answer: any) => answer.taken.map((t: any) => [t.pair.shardId, t.above]);
const metaWrites = (sent: Sent[]) => sent.filter(s => /^INSERT INTO smdb_data\.meta/.test(s.text));
const deletes = (sent: Sent[]) => sent.filter(s => /^DELETE FROM smdb_data\.shard_claims/.test(s.text));

describe('the claims pool logs', () => {
  it('an error on an idle claims connection is logged with its tag and message', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new ClaimStore('postgres://nobody@127.0.0.1:1/none', T);
    (store as any).pool.emit('error', new Error('connection reset by peer'));
    expect(error).toHaveBeenCalledWith('[Shards] Idle claims connection error:', 'connection reset by peer');
    await store.end();
  });
});

describe('the client bounds', () => {
  it('a connection that arrives after the connect bound is destroyed unused', async () => {
    vi.useFakeTimers();
    const { pool, clients } = fakePool(() => ({ rows: [] }), {
      connect: () => new Promise(resolve => { setTimeout(resolve, T.renewMs + 100); }),
    });
    const store = storeWith(pool);
    const failure = store.renew(renewReq()).catch(error => error);
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(classifyFailure(await failure)).toEqual({ kind: 'timeout' });
    expect(clients).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(clients).toHaveLength(1);
    expect(clients[0].sent).toEqual([]);
    expect(clients[0].released).toEqual([true]);
  });

  it('a renewal still on the wire at its bound has its connection destroyed when the bound fires', async () => {
    vi.useFakeTimers();
    const { pool, clients } = fakePool(text => (RENEWAL.test(text) ? 'hang' : { rows: [] }));
    const store = storeWith(pool);
    const failure = store.renew(renewReq()).catch(error => error);
    await vi.advanceTimersByTimeAsync(1);
    expect(clients[0].sent).toHaveLength(1);
    expect(clients[0].released).toEqual([]);
    vi.advanceTimersByTime(T.renewMs);
    expect(clients[0].released[0]).toBe(true);
    expect(classifyFailure(await failure)).toEqual({ kind: 'timeout' });
    expect(clients[0].released.every(d => d === true)).toBe(true);
  });

  it.each([
    ['renewal', (s: ClaimStore) => s.renew(renewReq()), T.renewMs, 'the claim renewal got no answer in time'],
    ['take', (s: ClaimStore) => s.take(takeReq({ localCount: 1 })), 2 * T.renewMs, 'the shard take got no answer in time'],
  ] as const)('a timed-out %s carries the timeout naming the call', async (_name, call, bound, text) => {
    vi.useFakeTimers();
    const { pool } = fakePool(t => (/^BEGIN/.test(t) ? { rows: [] } : 'hang'));
    const store = storeWith(pool);
    const failure = call(store).catch(error => error);
    await vi.advanceTimersByTimeAsync(bound);
    const error = await failure;
    expect(classifyFailure(error)).toEqual({ kind: 'timeout' });
    expect((error.cause as Error).message).toBe(text);
  });
});

describe('the lanes abandonWork reaches', () => {
  it('a work call that ends while a later one is on the wire leaves abandonWork able to destroy the later one', async () => {
    let openA: () => void = () => undefined;
    const gateA = new Promise<void>(resolve => { openA = resolve; });
    const { pool, clients } = fakePool(async (text, client) => {
      if (client.id === 1) {
        if (/WHERE shard_count = \$1 AND shard_id = \$2/.test(text)) await gateA;
        return { rows: [] };
      }
      return /^BEGIN/.test(text) ? { rows: [] } : 'hang';
    });
    const store = storeWith(pool);
    const a = store.readRow(1, 0);
    await flush();
    expect(clients).toHaveLength(1);
    void store.readPage(1).catch(() => undefined);
    await flush();
    expect(clients).toHaveLength(2);
    expect(clients[1].sent.length).toBeGreaterThanOrEqual(2);
    openA();
    expect(await a).toEqual({ row: null, storedCount: null });
    expect(clients[1].released).toEqual([]);
    store.abandonWork();
    expect(clients[1].released).toEqual([true]);
  });

  it('after a work call ended, abandonWork does not touch the pooled connection a renewal now uses', async () => {
    const { pool, clients } = fakePool(text => (RENEWAL.test(text) ? 'hang' : { rows: [] }), { reuse: true });
    const store = storeWith(pool);
    expect(await store.readRow(1, 0)).toEqual({ row: null, storedCount: null });
    expect(clients[0].released).toEqual([undefined]);
    void store.renew(renewReq()).catch(() => undefined);
    await flush();
    expect(clients[0].sent.some(s => RENEWAL.test(s.text))).toBe(true);
    store.abandonWork();
    expect(clients[0].released).toEqual([undefined]);
    store.abandonRenewal();
    expect(clients[0].released).toEqual([undefined, true]);
  });
});

describe('the login-refused listener', () => {
  it.each([
    ['a refused connection', Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' })],
    ['a server error', Object.assign(new Error('the database system is shutting down'), { code: '57P03' })],
  ])('%s at connect does not call it', async (_name, cause) => {
    const { pool } = fakePool(() => ({ rows: [] }), { connect: () => Promise.reject(cause) });
    const onRefused = vi.fn();
    const store = storeWith(pool, onRefused);
    const failure = await store.renew(renewReq()).then(() => null, error => classifyFailure(error));
    expect(failure).not.toBeNull();
    expect(failure?.kind).not.toBe('refused');
    expect(onRefused).not.toHaveBeenCalled();
  });

  it('a listener that throws is logged and the failure still answers refused', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const refused = Object.assign(new Error('password authentication failed'), { code: '28000' });
    const thrown = new Error('listener broke');
    const { pool } = fakePool(() => ({ rows: [] }), { connect: () => Promise.reject(refused) });
    const store = storeWith(pool, () => { throw thrown; });
    const failure = await store.renew(renewReq()).catch(e => classifyFailure(e));
    expect(failure).toEqual({ kind: 'refused' });
    expect(error).toHaveBeenCalledWith('[Shards] A login-refused listener threw:', thrown);
  });
});

describe('the renewal', () => {
  it('sends the held pairs as three parallel arrays, then the process, node and heartbeat', async () => {
    const { pool, clients } = fakePool(renewScript({ at: 1, prior_process: null, rows: [] }));
    const store = storeWith(pool);
    await store.renew(renewReq([{ shardCount: 4, shardId: 1, claim: 11 }, { shardCount: 4, shardId: 3, claim: 13 }]));
    const sent = clients[0].sent.find(s => RENEWAL.test(s.text))!;
    expect(sent.values).toEqual([[4, 4], [1, 3], [11, 13], 'p-a', 'n-a', 'A', 4, 30, true, true, true, 0, T.ttlMs, null, true, null, null, null, null, null, false]);
  });

  it.each([
    ['a previous process', 'p-old', 'p-old'],
    ['none', null, null],
  ])('answers the node row\'s prior process: %s', async (_name, prior, expected) => {
    const { pool } = fakePool(renewScript({ at: '1234.5', prior_process: prior, rows: [] }));
    const store = storeWith(pool);
    const answer = await store.renew(renewReq());
    expect(answer.priorProcess).toBe(expected);
    expect(answer.at).toBe(1234.5);
  });

  it.each([
    ['as JSON', (rows: unknown) => rows],
    ['as text', (rows: unknown) => JSON.stringify(rows)],
  ])('answers each returned row with its released and mine flags (%s)', async (_name, shape) => {
    const rows = [
      { shardCount: 4, shardId: 0, claim: '7', released: true, mine: false },
      { shardCount: 4, shardId: 1, claim: '8', released: false, mine: true },
    ];
    const { pool } = fakePool(renewScript({ at: 1, prior_process: null, rows: shape(rows) }));
    const store = storeWith(pool);
    const answer = await store.renew(renewReq());
    expect(answer.rows).toEqual([
      { shardCount: 4, shardId: 0, claim: 7, released: true, mine: false },
      { shardCount: 4, shardId: 1, claim: 8, released: false, mine: true },
    ]);
  });
});

describe('the take', () => {
  it('runs under the lock inside one transaction that it commits, and every statement passes the bind check', async () => {
    const { answer, sent, client } = await runTake(takeDb({ stored: null }), takeReq({ localCount: 2 }));
    expect(takenIds(answer)).toEqual([[0, null], [1, null]]);
    expect(sent[0].text).toMatch(/^BEGIN/);
    expect(sent.find(s => /pg_advisory_xact_lock/.test(s.text))!.inTx).toBe(true);
    expect(sent.find(s => /^INSERT INTO smdb_data\.shard_claims/.test(s.text))!.inTx).toBe(true);
    expect(sent.at(-1)!.text).toBe('COMMIT');
    expect(client.committed).toBe(true);
    expect(client.released).toEqual([undefined]);
  });

  it('a first take writes the shard count after step (1) and deletes the released row of another count in step (2)', async () => {
    const { answer, sent } = await runTake(takeDb({ stored: null, rows: [{ count: 2, id: 0, released: true }] }), takeReq({ localCount: 3 }));
    expect(answer.kind).toBe('done');
    expect(answer.shardCount).toBe(3);
    const stepOne = sent.findIndex(s => /LEFT JOIN smdb_data\.reshard/.test(s.text));
    expect(stepOne).toBeGreaterThan(-1);
    expect(sent.findIndex(s => /^INSERT INTO smdb_data\.meta/.test(s.text))).toBeGreaterThan(stepOne);
    const writes = metaWrites(sent);
    expect(writes).toHaveLength(1);
    expect(writes[0].values).toHaveLength(1);
    expect(JSON.parse(writes[0].values[0] as string)).toEqual({ count: 3 });
    expect(writes[0].text).toMatch(/VALUES \('shard_count', \$1\)/);
    const dels = deletes(sent);
    expect(dels).toHaveLength(1);
    expect(dels[0].text).toMatch(/WHERE c\.shard_count <> \$1::int AND \(c\.released OR c\.expires_up_ms <= \$2::bigint\)/);
    expect(dels[0].values[0]).toBe(3);
    expect(dels[0].inTx).toBe(true);
    expect(sent.at(-1)!.text).toBe('COMMIT');
  });

  it('a take under the stored count it agrees with writes no count and deletes nothing; other nodes with room keep the rest', async () => {
    const inner = takeDb({ stored: 2, nodes: [rawNode('n-b', 5)] });
    const deleted: unknown[] = [];
    const db: Script = async (text, client, values) => {
      const reply = await inner(text, client, values);
      if (/^DELETE FROM smdb_data\.shard_claims/.test(text)) deleted.push(...((reply as any)?.rows ?? []));
      return reply;
    };
    const { answer, sent } = await runTake(db, takeReq({ localCount: 2, capacity: 1 }));
    expect(answer.shardCount).toBe(2);
    expect(metaWrites(sent)).toEqual([]);
    expect(deleted).toEqual([]);
    expect(takenIds(answer)).toEqual([[0, null]]);
    expect(answer.plan.leftToOthers).toBe(1);
  });

  it('a running take of own count 1 under meta 2 is refused count and writes nothing (NB9 C1)', async () => {
    const db = takeDb({ stored: 2, rows: [{ count: 2, id: 0 }] });
    const { answer, sent } = await runTake(db, takeReq({ localCount: 1, boot: false }));
    expect(answer.kind).toBe('count');
    expect(metaWrites(sent)).toEqual([]);
    expect(sent.some(s => /^INSERT INTO smdb_data\.shard_claims|^UPDATE smdb_data\.shard_claims/.test(s.text))).toBe(false);
    expect(sent.at(-1)!.text).toBe('ROLLBACK');
  });

  it('a stored count whose only live row is of another count does not change: the take is refused count (NB9 C1)', async () => {
    const db = takeDb({ stored: 2, rows: [{ count: 1, id: 0 }] });
    const { answer, sent } = await runTake(db, takeReq({ localCount: 1 }));
    expect(answer.kind).toBe('count');
    expect(metaWrites(sent)).toEqual([]);
    expect(deletes(sent)).toEqual([]);
  });

  it('a live row of another count holds the take back: held with that row, nothing taken (NB9 56)', async () => {
    const db = takeDb({ stored: 1, rows: [{ count: 2, id: 0 }] });
    const { answer, sent } = await runTake(db, takeReq({ localCount: 1 }));
    expect(answer).toMatchObject({ kind: 'held', rows: [{ shardCount: 2, shardId: 0, holderName: 'B' }] });
    expect(sent.some(s => /^INSERT INTO smdb_data\.shard_claims|^UPDATE smdb_data\.shard_claims/.test(s.text))).toBe(false);
    expect(sent.at(-1)!.text).toBe('ROLLBACK');
  });

  it('a live row of the active count held by another node is not taken', async () => {
    const db = takeDb({ stored: 1, rows: [{ count: 1, id: 0 }] });
    const { answer, sent } = await runTake(db, takeReq({ localCount: 1 }));
    expect(takenIds(answer)).toEqual([]);
    expect(answer.plan.heldElsewhere).toBe(1);
    expect(sent.some(s => /^INSERT INTO smdb_data\.shard_claims|^UPDATE smdb_data\.shard_claims/.test(s.text))).toBe(false);
  });

  it('only a boot take reports the predecessor rows of this node', async () => {
    const rows: RowSpec[] = [{ count: 1, id: 0, holderNode: 'n-a', holderProcess: 'p-old', renewedAt: 777 }];
    const later = await runTake(takeDb({ stored: 1, rows }), takeReq({ localCount: 1, boot: false }));
    expect([...later.answer.predecessorRenewedAt.entries()]).toEqual([]);
    const boot = await runTake(takeDb({ stored: 1, rows }), takeReq({ localCount: 1, boot: true }));
    expect([...boot.answer.predecessorRenewedAt.entries()]).toEqual([[0, 777]]);
  });
});
