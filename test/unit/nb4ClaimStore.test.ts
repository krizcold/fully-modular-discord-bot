import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClaimStore, classifyFailure } from '../../src/bot/internalSetup/fleet/claimStore';
import { claimTimings } from '../../src/bot/internalSetup/fleet/claimRules';

// NB4 decision 5 and R2-OPS-1: every claims query has a client bound, and a query still on the wire at its bound has
// its connection destroyed (release(true)), so the next call gets a new one. The take refuses a claim number it cannot
// use. A 28000 on the claims pool reaches the login-refused listener. The pool is a fake that answers as node-pg does.

const T = claimTimings(30);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Answer = { rows?: any[]; rowCount?: number } | 'hang' | Error;

interface FakeClient {
  id: number;
  sent: string[];
  released: Array<boolean | undefined>;
  query: (config: any, values?: unknown[]) => Promise<any>;
  release: (destroy?: boolean) => void;
}

function fakePool(script: (text: string, client: FakeClient, values: unknown[]) => Answer, opts: { connect?: () => Promise<void> } = {}) {
  const clients: FakeClient[] = [];
  const pool = {
    async connect() {
      await opts.connect?.();
      const client: FakeClient = {
        id: clients.length + 1,
        sent: [],
        released: [],
        query(config: any, values?: unknown[]) {
          const text = typeof config === 'string' ? config : config.text;
          const bound = (typeof config === 'string' ? values : config.values) ?? [];
          client.sent.push(text.trim().split(/\s+/).slice(0, 3).join(' '));
          const answer = script(text, client, bound);
          if (answer === 'hang') return new Promise(() => undefined);
          if (answer instanceof Error) return Promise.reject(answer);
          return Promise.resolve({ rows: answer.rows ?? [], rowCount: answer.rowCount ?? (answer.rows ?? []).length });
        },
        release(destroy?: boolean) { client.released.push(destroy); },
      };
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

const me = { processId: 'p-a', nodeId: 'n-a', nodeName: 'A' };
const hb = { capacity: 4, takeoverSeconds: 30, fit: true, restartable: true, returns: true, startedAt: 0 };
const renewAnswer = { rows: [{ at: 1000, prior_process: null, rows: [] }] };

/** The take's statements on an empty table, with the sequence answering `nextval` and the floor `floor`. */
function takeScript(nextval: string, floor = '0', hang?: RegExp) {
  return (text: string, _client?: unknown, values: unknown[] = []): Answer => {
    if (hang?.test(text)) return 'hang';
    if (/pg_advisory_xact_lock/.test(text)) return { rows: [{}] };
    if (/FROM smdb_data\.claim_clock/.test(text)) return { rows: [{ up_ms: '0', u_prime: '0', now_ms: 0 }] };
    if (/LEFT JOIN smdb_data\.reshard/.test(text)) return { rows: [{ attempt: null, state: null, from_count: null, to_count: null, target: null, target_by: null, target_at: null, meta_count: null }] };
    if (/FROM smdb_data\.meta/.test(text)) return { rows: [] };
    if (/FROM smdb_data\.shard_claims( WHERE shard_count = \$1)?$/.test(text.trim()) || /AS renewed_ago_ms FROM smdb_data\.shard_claims/.test(text)) return { rows: [] };
    if (/FROM smdb_data\.shard_nodes/.test(text)) return { rows: [] };
    if (/AS floor/.test(text)) return { rows: [{ floor }] };
    if (/nextval/.test(text)) return { rows: [{ n: nextval }] };
    if (/setval/.test(text)) return { rows: [{}] };
    if (/INSERT INTO smdb_data\.shard_claims/.test(text)) {
      const ids = (Array.isArray(values[1]) ? values[1] : [values[1]]) as number[];
      const claims = (Array.isArray(values[2]) ? values[2] : [values[2]]) as number[];
      return { rows: ids.map((id, i) => ({ shard_id: id, claim: String(claims[i]) })), rowCount: ids.length };
    }
    return { rows: [] };
  };
}
const takeRequest = { me, capacity: 1, ttlMs: T.ttlMs, boot: true, known: [], localCount: 1, reserve: false };

describe('the client bounds', () => {
  it('a hung renewal is rejected as a timeout at R, its connection destroyed; the next renewal gets a new connection', async () => {
    vi.useFakeTimers();
    let hang = true;
    const { pool, clients } = fakePool(() => (hang ? 'hang' : renewAnswer));
    const store = storeWith(pool);
    const first = store.renew({ me, pairs: [], ttlMs: T.ttlMs, heartbeat: hb });
    const failure = first.catch(error => classifyFailure(error));
    await vi.advanceTimersByTimeAsync(T.renewMs - 1);
    expect(clients[0].released).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await failure).toEqual({ kind: 'timeout' });
    expect(clients[0].released[0]).toBe(true);
    hang = false;
    await store.renew({ me, pairs: [], ttlMs: T.ttlMs, heartbeat: hb });
    expect(clients).toHaveLength(2);
    expect(clients[1].released).toEqual([undefined]);
  });

  it.each([
    ['take', (s: ClaimStore) => s.take(takeRequest)],
    ['page read', (s: ClaimStore) => s.readPage(1)],
  ] as const)('a hung %s is rejected at 2R, not at R, with its connection destroyed', async (_name, call) => {
    vi.useFakeTimers();
    const { pool, clients } = fakePool(text => (/BEGIN/.test(text) ? { rows: [] } : 'hang'));
    const store = storeWith(pool);
    const failure = call(store).catch(error => classifyFailure(error));
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(clients[0].released).toEqual([]);
    await vi.advanceTimersByTimeAsync(T.renewMs);
    expect(await failure).toEqual({ kind: 'timeout' });
    expect(clients[0].released[0]).toBe(true);
  });

  it('abandonWork destroys the connection of the work lane query on the wire', async () => {
    const { pool, clients } = fakePool(text => (/BEGIN/.test(text) ? { rows: [] } : 'hang'));
    const store = storeWith(pool);
    void store.readPage(1).catch(() => undefined);
    await vi.waitFor(() => expect(clients).toHaveLength(1));
    store.abandonWork();
    expect(clients[0].released[0]).toBe(true);
  });

  it('the release has one 2 s bound for the connect and the transaction together (NB4-RUN-5)', async () => {
    vi.useFakeTimers();
    const { pool } = fakePool(text => (/pg_advisory_xact_lock/.test(text) ? 'hang' : { rows: [] }), {
      connect: () => new Promise(resolve => { setTimeout(resolve, 1500); }),
    });
    const store = storeWith(pool);
    let settledAt: number | null = null;
    const start = Date.now();
    void store.release({ me, reserved: [], handOvers: [], ttlMs: T.ttlMs }).catch(() => { settledAt = Date.now() - start; });
    await vi.advanceTimersByTimeAsync(2000);
    expect(settledAt).toBe(2000);
  });

  it('a release that never got past the lock wait was never sent (NB4-DL-4, NB4-RUN-5)', async () => {
    vi.useFakeTimers();
    const { pool } = fakePool(text => (/pg_advisory_xact_lock/.test(text) ? 'hang' : { rows: [] }));
    const store = storeWith(pool);
    let sent = false;
    const done = store.release({ me, reserved: [], handOvers: [], ttlMs: T.ttlMs }, () => { sent = true; }).catch(error => classifyFailure(error));
    await vi.advanceTimersByTimeAsync(2000);
    expect(await done).toEqual({ kind: 'timeout' });
    expect(sent).toBe(false);
  });
});

describe('the claim number the take writes', () => {
  it.each([
    ['not a number', 'abc', '0'],
    ['above the largest safe integer', '9007199254740993', '0'],
    ['a floor above the largest safe integer', '5', '9007199254740993'],
  ])('a sequence answer %s is refused: no row is written, no COMMIT is sent and the connection is destroyed', async (_name, nextval, floor) => {
    const { pool, clients } = fakePool(takeScript(nextval, floor));
    const store = storeWith(pool);
    await expect(store.take(takeRequest)).rejects.toThrow();
    const sent = clients[0].sent.join(' | ');
    expect(sent).not.toMatch(/INSERT INTO smdb_data\.shard_claims|COMMIT/);
    expect(sent).toMatch(/ROLLBACK/);
    expect(clients[0].released.at(-1)).toBe(true);
  });

  it.each([['0', 1], ['-5', 1]])('a sequence answer %s at or below the floor is raised to the floor + 1 with setval', async (nextval, claim) => {
    const values: unknown[][] = [];
    const script = takeScript(nextval, '0');
    const { pool } = fakePool((text, c, v) => script(text, c, v));
    const store = storeWith(pool);
    const realQuery = pool.connect.bind(pool);
    (pool as any).connect = async () => {
      const client = await realQuery();
      const q = client.query.bind(client);
      client.query = (config: any, v?: unknown[]) => { values.push(typeof config === 'string' ? v ?? [] : config.values ?? []); return q(config, v); };
      return client;
    };
    const answer = await store.take(takeRequest);
    expect(answer.kind === 'done' && answer.taken.map(t => t.pair.claim)).toEqual([claim]);
    expect(values).toContainEqual([claim]);
  });
});

describe('a refused login on the claims pool', () => {
  it('a 28000 at connect calls the login-refused listener once and is classed refused', async () => {
    const refused = Object.assign(new Error('password authentication failed'), { code: '28000' });
    const { pool } = fakePool(() => ({ rows: [] }), { connect: () => Promise.reject(refused) });
    const onRefused = vi.fn();
    const store = storeWith(pool, onRefused);
    const failure = await store.renew({ me, pairs: [], ttlMs: T.ttlMs, heartbeat: hb }).catch(error => classifyFailure(error));
    expect(failure).toEqual({ kind: 'refused' });
    expect(onRefused).toHaveBeenCalledTimes(1);
  });

  it('a 28000 answering a statement calls it too', async () => {
    const refused = Object.assign(new Error('role is not permitted to log in'), { code: '28000' });
    const { pool } = fakePool(() => refused);
    const onRefused = vi.fn();
    const store = storeWith(pool, onRefused);
    await expect(store.renew({ me, pairs: [], ttlMs: T.ttlMs, heartbeat: hb })).rejects.toThrow();
    expect(onRefused).toHaveBeenCalledTimes(1);
  });
});
