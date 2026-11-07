import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClaimStore, ClaimFailure, ClaimTimeoutError } from '../../src/bot/internalSetup/fleet/claimStore';
import { claimTimings } from '../../src/bot/internalSetup/fleet/claimRules';

// NB4 decisions 5, 10, 11, 12 and 13 on the claims store, driven through a fake pool that answers as node-pg does:
// the release hands a shard only to a receiver with room and reports each row as stored, the page and row reads use
// the stored shard count, every bound names what got no answer, and a destroyed connection is never reused.

const T = claimTimings(30);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Answer = { rows?: any[] } | 'hang' | Error;

interface Sent { text: string; values: unknown[] }

interface FakeClient {
  sent: Sent[];
  released: Array<boolean | undefined>;
  query: (config: any, values?: unknown[]) => Promise<any>;
  release: (destroy?: boolean) => void;
}

function fakePool(script: (text: string, values: unknown[]) => Answer, connect?: () => Promise<void>) {
  const clients: FakeClient[] = [];
  const state = { ended: false };
  const pool = {
    async connect() {
      if (connect) await connect();
      const pending: Array<(e: Error) => void> = [];
      const client: FakeClient = {
        sent: [],
        released: [],
        query(config: any, values?: unknown[]) {
          const text = typeof config === 'string' ? config : config.text;
          const bound = (typeof config === 'string' ? values : config.values) ?? [];
          client.sent.push({ text, values: bound });
          const answer = script(text, bound);
          if (answer === 'hang') return new Promise((_, reject) => { pending.push(reject); });
          if (answer instanceof Error) return Promise.reject(answer);
          return Promise.resolve({ rows: answer.rows ?? [], rowCount: (answer.rows ?? []).length });
        },
        release(destroy?: boolean) {
          client.released.push(destroy);
          if (destroy === true) for (const reject of pending.splice(0)) reject(new Error('Connection terminated'));
        },
      };
      clients.push(client);
      return client;
    },
    async end() { state.ended = true; },
    on() { return pool; },
  };
  return { pool, clients, state };
}

function storeWith(pool: object): ClaimStore {
  const store = new ClaimStore('postgres://nobody@127.0.0.1:1/none', T);
  void (store as any).pool.end().catch(() => undefined);
  (store as any).pool = pool;
  return store;
}

const me = { processId: 'p-a', nodeId: 'n-a', nodeName: 'A' };
const clockRow = { up_ms: '1000', u_prime: '1200', now_ms: 5000 };

function claimRow(shardCount: number, shardId: number, extra: Record<string, unknown> = {}) {
  return {
    shard_count: shardCount, shard_id: shardId, claim: '3', holder_process: 'p-z', holder_node: 'n-z', holder_name: 'Z',
    home_node: 'n-z', released: false, reserved: false, taken_at: 1, renewed_at: 2, ttl_ms: '30000',
    expires_up_ms: '50000', extended: false, renewed_ago_ms: 10, ...extra,
  };
}

function nodeRow(nodeId: string, extra: Record<string, unknown> = {}) {
  return {
    node_id: nodeId, node_name: nodeId.toUpperCase(), process_id: `p-${nodeId}`, capacity: 1, takeover_seconds: 30,
    fit: true, restartable: true, returns: true, seen_ago_ms: 100, healthy_for_ms: 400_000, ...extra,
  };
}

const isRelease = (text: string) => /SET released = true, reserved = false/.test(text);

function releaseScript(nodes: any[], answer: Answer = { rows: [] }) {
  return (text: string): Answer => {
    if (isRelease(text)) return answer;
    if (/^\s*SELECT up_ms::text/.test(text)) return { rows: [clockRow] };
    if (/FROM smdb_data\.shard_claims/.test(text)) return { rows: [] };
    if (/FROM smdb_data\.shard_nodes/.test(text)) return { rows: nodes };
    return { rows: [] };
  };
}

function releaseCall(client: FakeClient): Sent {
  const call = client.sent.find(s => isRelease(s.text));
  expect(call).toBeDefined();
  return call!;
}

const releaseRequest = (handOvers: Array<{ shardId: number; receiver: string; move: boolean }>) =>
  ({ me, reserved: [], handOvers, ttlMs: 30_000 });

describe('NB4 decision 11/12: the release hands a shard only to a receiver with room', () => {
  it('passes a qualified receiver its shard, its node id and its move flag', async () => {
    const { pool, clients } = fakePool(releaseScript([nodeRow('n-b', { capacity: 2 })]));
    await storeWith(pool).release(releaseRequest([{ shardId: 5, receiver: 'n-b', move: true }]));
    const call = releaseCall(clients[0]);
    expect(call.values[7]).toEqual([5]);
    expect(call.values[8]).toEqual(['n-b']);
    expect(call.values[9]).toEqual([true]);
  });

  it('gives a receiver no more shards than its room', async () => {
    const { pool, clients } = fakePool(releaseScript([nodeRow('n-b', { capacity: 1 })]));
    await storeWith(pool).release(releaseRequest([
      { shardId: 1, receiver: 'n-b', move: false },
      { shardId: 2, receiver: 'n-b', move: true },
    ]));
    const call = releaseCall(clients[0]);
    expect(call.values[7]).toEqual([1]);
    expect(call.values[8]).toEqual(['n-b']);
    expect(call.values[9]).toEqual([false]);
  });

  it('hands nothing to an unknown node or to one that does not qualify, even with room', async () => {
    const { pool, clients } = fakePool(releaseScript([nodeRow('n-c', { capacity: 3, fit: false })]));
    await storeWith(pool).release(releaseRequest([
      { shardId: 1, receiver: 'n-x', move: true },
      { shardId: 2, receiver: 'n-c', move: true },
    ]));
    const call = releaseCall(clients[0]);
    expect(call.values[7]).toEqual([]);
    expect(call.values[8]).toEqual([]);
    expect(call.values[9]).toEqual([]);
  });

  it('reports each row as the statement stored it: reserved or not, and who received it', async () => {
    const { pool, clients } = fakePool(releaseScript([], { rows: [
      { shard_id: '0', claim: '7', was_released: true, handed_to: null },
      { shard_id: '1', claim: '8', was_released: false, handed_to: 'B' },
    ] }));
    const rows = await storeWith(pool).release(releaseRequest([]));
    expect(rows).toEqual([
      { shardId: 0, claim: 7, wasReserved: true, handedTo: null },
      { shardId: 1, claim: 8, wasReserved: false, handedTo: 'B' },
    ]);
    expect(clients[0].sent.some(s => s.text === 'COMMIT')).toBe(true);
  });

  it('rolls the release back when its statement fails, and commits nothing', async () => {
    const { pool, clients } = fakePool(releaseScript([], new Error('deadlock detected')));
    await expect(storeWith(pool).release(releaseRequest([]))).rejects.toBeInstanceOf(ClaimFailure);
    const texts = clients[0].sent.map(s => s.text);
    expect(texts).toContain('ROLLBACK');
    expect(texts).not.toContain('COMMIT');
  });
});

describe('NB4 decision 10: a take re-takes a row it may take through the guarded update', () => {
  it('returns the claim the update stored for a row this process held', async () => {
    const script = (text: string, values: unknown[]): Answer => {
      if (/UPDATE smdb_data\.shard_claims c\s+SET claim = p\.claim/.test(text)) {
        const ids = values[1] as number[];
        const claims = values[2] as number[];
        return { rows: ids.map((id, i) => ({ shard_id: id, claim: String(claims[i]) })) };
      }
      if (/pg_advisory_xact_lock/.test(text)) return { rows: [{}] };
      if (/^\s*SELECT up_ms::text/.test(text)) return { rows: [clockRow] };
      if (/LEFT JOIN smdb_data\.reshard/.test(text)) return { rows: [{ attempt: null, state: null, from_count: null, to_count: null, target: null, target_by: null, target_at: null, meta_count: 1 }] };
      if (/FROM smdb_data\.meta/.test(text)) return { rows: [{ value: '{"count":1}' }] };
      if (/AS floor/.test(text)) return { rows: [{ floor: '3' }] };
      if (/nextval/.test(text)) return { rows: [{ n: '9' }] };
      if (/AS renewed_ago_ms FROM smdb_data\.shard_claims/.test(text)) {
        return { rows: [claimRow(1, 0, { holder_process: 'p-a', holder_node: 'n-a', holder_name: 'A', home_node: 'n-a' })] };
      }
      return { rows: [] };
    };
    const { pool } = fakePool(script);
    const answer = await storeWith(pool).take({ me, capacity: 1, ttlMs: 30_000, boot: false, known: [], localCount: 1, reserve: false });
    expect(answer.kind).toBe('done');
    if (answer.kind !== 'done') return;
    expect(answer.taken).toEqual([{ pair: { shardCount: 1, shardId: 0, claim: 9 }, above: null }]);
  });
});

function pageScript(meta: string | null, extra: (text: string, values: unknown[]) => Answer | null = () => null) {
  return (text: string, values: unknown[]): Answer => {
    const hit = extra(text, values);
    if (hit) return hit;
    if (/^\s*SELECT up_ms::text/.test(text)) return { rows: [clockRow] };
    if (/FROM smdb_data\.meta WHERE key = 'shard_count'/.test(text)) return { rows: meta === null ? [] : [{ value: meta }] };
    if (/FROM smdb_data\.shard_claims WHERE shard_count = \$1 ORDER BY shard_id/.test(text)) {
      return { rows: values.length === 1 ? [claimRow(Number(values[0]), 2)] : [] };
    }
    if (/FROM smdb_data\.shard_claims WHERE shard_count = \$1 AND shard_id = \$2/.test(text)) {
      return { rows: values.length === 2 ? [claimRow(Number(values[0]), Number(values[1]))] : [] };
    }
    if (/FROM smdb_data\.shard_nodes ORDER BY node_name/.test(text)) return { rows: [nodeRow('n-b')] };
    return { rows: [] };
  };
}

describe('NB4 decision 13: the page read uses the stored shard count', () => {
  it('reads the stored count, its rows and the nodes in one read-only snapshot, and commits it', async () => {
    const { pool, clients } = fakePool(pageScript('{"count":4}'));
    const page = await storeWith(pool).readPage(null);
    expect(page.shardCount).toBe(4);
    expect(page.upMs).toBe(1000);
    expect(page.uPrimeMs).toBe(1200);
    expect(page.rows.map(r => [r.shardCount, r.shardId])).toEqual([[4, 2]]);
    expect(page.nodes.map(n => n.nodeId)).toEqual(['n-b']);
    const texts = clients[0].sent.map(s => s.text);
    expect(texts[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(texts[texts.length - 1]).toBe('COMMIT');
    expect(clients[0].released).toEqual([undefined]);
  });

  it('prefers the stored count over the local one', async () => {
    const { pool } = fakePool(pageScript('{"count":4}'));
    const page = await storeWith(pool).readPage(8);
    expect(page.rows.map(r => r.shardCount)).toEqual([4]);
  });

  it('uses the local count when none is stored, and reports none stored', async () => {
    const { pool } = fakePool(pageScript(null));
    const page = await storeWith(pool).readPage(8);
    expect(page.shardCount).toBeNull();
    expect(page.rows.map(r => r.shardCount)).toEqual([8]);
  });

  it('reads no claim rows when no count is known', async () => {
    const { pool, clients } = fakePool(pageScript(null, text => /FROM smdb_data\.shard_claims/.test(text) ? { rows: [claimRow(1, 0)] } : null));
    const page = await storeWith(pool).readPage(null);
    expect(page.rows).toEqual([]);
    expect(clients[0].sent.some(s => /shard_claims/.test(s.text))).toBe(false);
  });

  it('treats a stored count of 0 as no count', async () => {
    const { pool, clients } = fakePool(pageScript('{"count":0}'));
    const page = await storeWith(pool).readPage(null);
    expect(page.shardCount).toBeNull();
    expect(page.rows).toEqual([]);
    expect(clients[0].sent.some(s => /shard_claims/.test(s.text))).toBe(false);
    const row = await storeWith(fakePool(pageScript('{"count":0}')).pool).readRow(1, 0);
    expect(row.storedCount).toBeNull();
  });

  it('rolls the read back when a query fails', async () => {
    const { pool, clients } = fakePool(pageScript('{"count":4}', text => /shard_nodes/.test(text) ? new Error('boom') : null));
    await expect(storeWith(pool).readPage(null)).rejects.toBeInstanceOf(ClaimFailure);
    const texts = clients[0].sent.map(s => s.text);
    expect(texts).toContain('ROLLBACK');
    expect(texts).not.toContain('COMMIT');
  });
});

describe('NB4: the row read returns the asked row and the stored count', () => {
  it('reads the row by count and shard, and the stored count', async () => {
    const { pool } = fakePool(pageScript('{"count":4}'));
    const answer = await storeWith(pool).readRow(4, 2);
    expect(answer.row && [answer.row.shardCount, answer.row.shardId]).toEqual([4, 2]);
    expect(answer.storedCount).toBe(4);
  });
});

describe('NB4 decision 5: every bound names what got no answer', () => {
  it('the page read', async () => {
    const { pool } = fakePool(() => 'hang');
    const store = storeWith(pool);
    vi.useFakeTimers();
    const read = store.readPage(null).catch(e => e);
    await vi.advanceTimersByTimeAsync(2 * T.renewMs + 1);
    const error = await read;
    expect(error).toBeInstanceOf(ClaimFailure);
    expect(error.cause).toBeInstanceOf(ClaimTimeoutError);
    expect(error.cause.message).toBe('the claims read got no answer in time');
  });

  it('the row read', async () => {
    const { pool } = fakePool(() => 'hang');
    const store = storeWith(pool);
    vi.useFakeTimers();
    const read = store.readRow(1, 0).catch(e => e);
    await vi.advanceTimersByTimeAsync(T.renewMs + 1);
    const error = await read;
    expect(error).toBeInstanceOf(ClaimFailure);
    expect(error.cause.message).toBe('the claim row read got no answer in time');
  });

  it('destroys a connection that arrives after its connect bound', async () => {
    let open!: () => void;
    const { pool, clients } = fakePool(pageScript('{"count":4}'), () => new Promise<void>(resolve => { open = resolve; }));
    const store = storeWith(pool);
    vi.useFakeTimers();
    const read = store.readRow(1, 0).catch(e => e);
    await vi.advanceTimersByTimeAsync(T.renewMs + 1);
    expect(await read).toBeInstanceOf(ClaimFailure);
    open();
    await vi.advanceTimersByTimeAsync(0);
    expect(clients).toHaveLength(1);
    expect(clients[0].released).toEqual([true]);
    expect(clients[0].sent).toEqual([]);
  });

  it('leaves no bound timer behind once a read answered', async () => {
    const { pool } = fakePool(pageScript('{"count":4}'));
    const store = storeWith(pool);
    vi.useFakeTimers();
    await store.readRow(4, 2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no bound timer behind once a read failed', async () => {
    const { pool } = fakePool(() => new Error('boom'));
    const store = storeWith(pool);
    vi.useFakeTimers();
    await expect(store.readRow(4, 2)).rejects.toBeInstanceOf(ClaimFailure);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('NB4: abandoning the renewal and ending the store', () => {
  it('destroys the connection of a renewal on the wire, once', async () => {
    const { pool, clients } = fakePool(() => 'hang');
    const store = storeWith(pool);
    const renewal = store.renew({
      me, pairs: [], ttlMs: 30_000,
      heartbeat: { capacity: 1, takeoverSeconds: 30, fit: true, restartable: true, returns: true, startedAt: 0 },
    }).catch(e => e);
    for (let i = 0; i < 20 && !(clients[0]?.sent.length); i++) await Promise.resolve();
    expect(clients[0].sent).toHaveLength(1);
    store.abandonRenewal();
    expect(clients[0].released).toEqual([true]);
    store.abandonRenewal();
    expect(clients[0].released).toEqual([true]);
    expect(await renewal).toBeInstanceOf(ClaimFailure);
  });

  it('ends its pool', async () => {
    const { pool, state } = fakePool(() => ({ rows: [] }));
    await storeWith(pool).end();
    expect(state.ended).toBe(true);
  });
});
