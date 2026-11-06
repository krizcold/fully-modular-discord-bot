import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClaimPausedError, ClaimStore, TAKE_INSERT_SQL, TAKE_UPDATE_SQL } from '../../src/bot/internalSetup/fleet/claimStore';
import { claimTimings, type Pair } from '../../src/bot/internalSetup/fleet/claimRules';

// NB5 test 19 (D1, D7, C5 (b)): the claims store's gate over a fake pool that answers as node-pg does. A call begun
// before a pause is never sent or applied after it, a call started while paused connects nothing unless it is the
// move's, and the move's re-take writes only the rows decision 12 (d) allows.

const T = claimTimings(30);
const me = { processId: 'p-a', nodeId: 'n-a', nodeName: 'A' };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Answer = { rows?: any[] } | 'hang' | 'late' | Error;

interface FakeClient {
  sent: string[];
  released: Array<boolean | undefined>;
  query: (config: any) => Promise<any>;
  release: (destroy?: boolean) => void;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakePool(script: (text: string, values: unknown[]) => Answer = () => ({ rows: [] })) {
  const clients: FakeClient[] = [];
  const state = { connects: 0, ended: false, hold: false, connectError: null as Error | null };
  const held: Array<{ go: () => void; fail: (e: Error) => void }> = [];
  const late: Array<() => void> = [];
  const pool = {
    async connect() {
      state.connects += 1;
      if (state.hold) {
        const d = deferred();
        held.push({ go: () => d.resolve(), fail: e => d.reject(e) });
        await d.promise;
      }
      if (state.connectError) throw state.connectError;
      const pending: Array<(e: Error) => void> = [];
      const client: FakeClient = {
        sent: [],
        released: [],
        query(config: any) {
          const text = typeof config === 'string' ? config : config.text;
          const values = (typeof config === 'string' ? [] : config.values) ?? [];
          client.sent.push(text);
          const answer = script(text, values);
          if (answer === 'hang') return new Promise((_, reject) => { pending.push(reject); });
          if (answer === 'late') return new Promise(resolve => { late.push(() => resolve({ rows: [renewalRow()], rowCount: 1 })); });
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
  return {
    pool, clients, state,
    releaseConnects: () => { for (const h of held.splice(0)) h.go(); },
    failConnects: (e: Error) => { for (const h of held.splice(0)) h.fail(e); },
    answerLate: () => { for (const go of late.splice(0)) go(); },
  };
}

function storeWith(pool: object, onLoginRefused: () => void = () => undefined): ClaimStore {
  const store = new ClaimStore('postgres://nobody@127.0.0.1:1/none', T, onLoginRefused);
  void (store as any).pool.end().catch(() => undefined);
  (store as any).pool = pool;
  return store;
}

const renewalRow = () => ({ at: 5000, prior_process: 'p-a', rows: [{ shardCount: 4, shardId: 3, claim: '40', released: false, mine: true }] });
const isRenewal = (text: string) => text.includes('WITH pairs AS');
const renewScript = (text: string): Answer => (isRenewal(text) ? { rows: [renewalRow()] } : { rows: [] });
const renewRequest = () => ({
  me, pairs: [{ shardCount: 4, shardId: 3, claim: 40 }], ttlMs: T.ttlMs,
  heartbeat: { capacity: 1, takeoverSeconds: 30, fit: true, restartable: true, returns: true, startedAt: 0 },
});
const takeRequest = () => ({ me, capacity: 1, ttlMs: T.ttlMs, boot: true, known: [], localCount: 4, reserve: false });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

describe('D1: a call begun before a pause is never sent or applied after it', () => {
  it('(a) a renewal whose connect is held across pause(): the client is destroyed with nothing sent', async () => {
    const f = fakePool(renewScript);
    const store = storeWith(f.pool);
    f.state.hold = true;
    const call = store.renew(renewRequest());
    await flush();
    store.pause();
    f.releaseConnects();
    await expect(call).rejects.toBeInstanceOf(ClaimPausedError);
    expect(f.clients).toHaveLength(1);
    expect(f.clients[0].released).toEqual([true]);
    expect(f.clients[0].sent).toEqual([]);
  });

  it('(a) the same when the pool is replaced while the connect is held', async () => {
    const f = fakePool(renewScript);
    const store = storeWith(f.pool);
    f.state.hold = true;
    const call = store.renew(renewRequest());
    await flush();
    (store as any).pool = fakePool(renewScript).pool;
    f.releaseConnects();
    await expect(call).rejects.toBeInstanceOf(ClaimPausedError);
    expect(f.clients[0].released).toEqual([true]);
    expect(f.clients[0].sent).toEqual([]);
  });

  it('(b) a connect that fails with 28000 after pause(): ClaimPausedError, and the login-refused listener is not called', async () => {
    const f = fakePool(renewScript);
    const refused = vi.fn();
    const store = storeWith(f.pool, refused);
    f.state.hold = true;
    const call = store.renew(renewRequest());
    await flush();
    store.pause();
    f.failConnects(Object.assign(new Error('role is not permitted to log in'), { code: '28000', severity: 'FATAL' }));
    await expect(call).rejects.toBeInstanceOf(ClaimPausedError);
    expect(refused).not.toHaveBeenCalled();
  });

  it('(c) an answer that arrives after pause() is dropped; after resume() a new renewal connects and answers', async () => {
    let mode: 'late' | 'ok' = 'late';
    const f = fakePool(text => (isRenewal(text) ? (mode === 'late' ? 'late' : { rows: [renewalRow()] }) : { rows: [] }));
    const store = storeWith(f.pool);
    const call = store.renew(renewRequest());
    await flush();
    expect(f.clients[0].sent).toHaveLength(1);
    store.pause();
    f.answerLate();
    await expect(call).rejects.toBeInstanceOf(ClaimPausedError);
    store.resume();
    mode = 'ok';
    const answer = await store.renew(renewRequest());
    expect(answer.rows).toEqual([{ shardCount: 4, shardId: 3, claim: 40, released: false, mine: true }]);
    expect(f.state.connects).toBe(2);
  });

  it('(d) while paused every call but the move\'s is refused with no connect; renew with move and retake connect and send', async () => {
    const f = fakePool(text => (isRenewal(text) ? { rows: [renewalRow()] } : /SELECT up_ms::text/.test(text) ? { rows: [{ up_ms: '1000', u_prime: '1200', now_ms: 5000 }] } : text.includes('GREATEST(') ? { rows: [{ floor: '0' }] } : text.includes('nextval') ? { rows: [{ n: '1' }] } : { rows: [] }));
    const store = storeWith(f.pool);
    store.pause();
    await expect(store.renew(renewRequest())).rejects.toBeInstanceOf(ClaimPausedError);
    await expect(store.take(takeRequest())).rejects.toBeInstanceOf(ClaimPausedError);
    await expect(store.readPage(4)).rejects.toBeInstanceOf(ClaimPausedError);
    await expect(store.readRow(4, 3)).rejects.toBeInstanceOf(ClaimPausedError);
    await expect(store.release({ me, reserved: [], handOvers: [], ttlMs: T.ttlMs })).rejects.toBeInstanceOf(ClaimPausedError);
    expect(f.state.connects).toBe(0);
    await store.renew(renewRequest(), { move: true });
    await store.retake({ me, shardCount: 4, pairs: [{ shardCount: 4, shardId: 3, claim: 40 }], guildIds: [], generation: 0, ttlMs: T.ttlMs });
    expect(f.state.connects).toBe(2);
    expect(f.clients[0].sent.some(isRenewal)).toBe(true);
    expect(f.clients[1].sent[0]).toBe('BEGIN');
  });

  it('(e) a move renewal on the wire when pause() runs again has its answer dropped', async () => {
    const f = fakePool(text => (isRenewal(text) ? 'late' : { rows: [] }));
    const store = storeWith(f.pool);
    store.pause();
    const call = store.renew(renewRequest(), { move: true });
    await flush();
    expect(f.clients[0].sent).toHaveLength(1);
    store.pause();
    f.answerLate();
    await expect(call).rejects.toBeInstanceOf(ClaimPausedError);
  });

  it('(f) a take whose connect is held across pause() sends no BEGIN', async () => {
    const f = fakePool();
    const store = storeWith(f.pool);
    f.state.hold = true;
    const call = store.take(takeRequest());
    await flush();
    store.pause();
    f.releaseConnects();
    await expect(call).rejects.toBeInstanceOf(ClaimPausedError);
    expect(f.clients[0].sent).toEqual([]);
    expect(f.clients[0].released).toEqual([true]);
  });
});

describe('C5 (b): retarget', () => {
  it('destroys both lanes\' clients, ends the old pool, and the next renewal goes to a pool built from the new entry', async () => {
    const built: string[] = [];
    const next = fakePool(renewScript);
    const first = fakePool(text => (isRenewal(text) ? 'hang' : /SELECT/.test(text) ? 'hang' : { rows: [] }));
    const store = storeWith(first.pool);
    vi.spyOn(ClaimStore.prototype as any, 'makePool').mockImplementation((entry: unknown) => { built.push(String(entry)); return next.pool; });
    const renewal = store.renew(renewRequest()).catch(e => e);
    const read = store.readRow(4, 3).catch(e => e);
    await flush();
    expect(first.clients).toHaveLength(2);
    store.retarget('postgres://bot@db3:5432/bot');
    expect(first.clients.map(c => c.released[0])).toEqual([true, true]);
    await flush();
    expect(first.state.ended).toBe(true);
    expect(await renewal).toBeInstanceOf(ClaimPausedError);
    expect(await read).toBeInstanceOf(ClaimPausedError);
    expect(built).toEqual(['postgres://bot@db3:5432/bot']);
    await store.renew(renewRequest());
    expect(next.clients[0].sent.some(isRenewal)).toBe(true);
  });

  it('builds its pool from the entry\'s parts (pgConfig), never the raw list', () => {
    const store = new ClaimStore('postgres://bot:pw@db3.example:5433/botdb', T);
    const options = (store as any).pool.options;
    expect(options).toMatchObject({ host: 'db3.example', port: 5433, database: 'botdb', user: 'bot', application_name: 'smdb-claims', max: 2 });
    expect(options.connectionString).toBeUndefined();
    void store.end();
  });
});

describe('D7: the re-take', () => {
  it('sends its statements in order, calls onCommitSent before COMMIT, takes a row naming this process and a missing row, and leaves another process\'s row', async () => {
    const pairs: Pair[] = [{ shardCount: 4, shardId: 2, claim: 40 }, { shardCount: 4, shardId: 3, claim: 40 }, { shardCount: 4, shardId: 1, claim: 40 }];
    const claimRow = (shardId: number, claim: string, holder: string) => ({
      shard_count: 4, shard_id: shardId, claim, holder_process: holder, holder_node: holder === 'p-a' ? 'n-a' : 'n-z',
      holder_name: holder === 'p-a' ? 'A' : 'Z', home_node: 'n-a', released: false, reserved: false, taken_at: 1, renewed_at: 2,
      ttl_ms: '30000', expires_up_ms: '50000', extended: false, renewed_ago_ms: 10,
    });
    const order: string[] = [];
    let commitSentAt = -1;
    const f = fakePool((text, values) => {
      order.push(text);
      if (/^SELECT up_ms::text/.test(text.trim())) return { rows: [{ up_ms: '1000', u_prime: '1200', now_ms: 5000 }] };
      if (text.includes('to_regclass')) return { rows: [{ present: true }] };
      if (text.includes('FROM smdb_manager.generation')) return { rows: [{ generation: '2' }] };
      if (text.includes('FROM smdb_data.shard_claims WHERE shard_id = ANY')) return { rows: [claimRow(3, '91', 'p-a'), claimRow(1, '50', 'p-z')] };
      if (text.includes('SELECT DISTINCT shard_count')) return { rows: [{ shard_count: 4 }] };
      if (text.includes('GREATEST(')) return { rows: [{ floor: '91' }] };
      if (text.includes('FROM smdb_data.guild_ownership')) return { rows: [] };
      if (text.includes('nextval')) return { rows: [{ n: '92' }, { n: '93' }] };
      if (text === TAKE_INSERT_SQL) return { rows: (values[1] as number[]).map((id, i) => ({ shard_id: id, claim: String((values[2] as number[])[i]) })) };
      if (text === TAKE_UPDATE_SQL) return { rows: (values[1] as number[]).map((id, i) => ({ shard_id: id, claim: String((values[2] as number[])[i]) })) };
      return { rows: [] };
    });
    const store = storeWith(f.pool);
    const answer = await store.retake(
      { me, shardCount: 4, pairs, guildIds: [{ shardId: 2, guildIds: ['g2'] }, { shardId: 3, guildIds: [] }, { shardId: 1, guildIds: [] }], generation: 2, ttlMs: T.ttlMs },
      () => { commitSentAt = order.length; },
    );
    const kinds = order.map(text => {
      if (text === 'BEGIN' || text === 'COMMIT') return text;
      if (text.includes('pg_advisory_xact_lock')) return 'lock';
      if (/^SELECT up_ms::text/.test(text.trim())) return 'clock';
      if (text.includes('to_regclass') || text.includes('smdb_manager.generation')) return 'generation';
      if (text.includes('WHERE shard_id = ANY')) return 'claim rows';
      if (text.includes('DISTINCT shard_count')) return 'counts';
      if (text.includes('GREATEST(') || text.includes('nextval')) return 'draw';
      if (text.includes('guild_ownership')) return 'guild claims';
      if (text === TAKE_INSERT_SQL || text === TAKE_UPDATE_SQL) return 'write';
      return text;
    });
    expect(kinds).toEqual(['BEGIN', 'lock', 'clock', 'generation', 'generation', 'claim rows', 'counts', 'guild claims', 'draw', 'draw', 'write', 'write', 'COMMIT']);
    expect(commitSentAt).toBe(order.length - 1);
    const insert = f.clients[0].sent.indexOf(TAKE_INSERT_SQL);
    const update = f.clients[0].sent.indexOf(TAKE_UPDATE_SQL);
    expect(insert).toBeGreaterThan(0);
    expect(update).toBeGreaterThan(insert);
    expect(answer.taken).toEqual([
      { before: pairs[0], pair: { shardCount: 4, shardId: 2, claim: 92 } },
      { before: pairs[1], pair: { shardCount: 4, shardId: 3, claim: 93 } },
    ]);
  });

  it('pins the old claim and this process in the update of a row naming it above the held claim', async () => {
    let updateValues: unknown[] = [];
    const f = fakePool((text, values) => {
      if (/^SELECT up_ms::text/.test(text.trim())) return { rows: [{ up_ms: '1000', u_prime: '1200', now_ms: 5000 }] };
      if (text.includes('to_regclass')) return { rows: [{ present: false }] };
      if (text.includes('WHERE shard_id = ANY')) return { rows: [{ shard_count: 4, shard_id: 3, claim: '91', holder_process: 'p-a', holder_node: 'n-a', holder_name: 'A', home_node: 'n-a', released: false, reserved: false, taken_at: 1, renewed_at: 2, ttl_ms: '30000', expires_up_ms: '50000', extended: false, renewed_ago_ms: 1 }] };
      if (text.includes('DISTINCT shard_count')) return { rows: [{ shard_count: 4 }] };
      if (text.includes('GREATEST(')) return { rows: [{ floor: '91' }] };
      if (text.includes('nextval')) return { rows: [{ n: '92' }] };
      if (text === TAKE_UPDATE_SQL) { updateValues = values; return { rows: [{ shard_id: 3, claim: '92' }] }; }
      return { rows: [] };
    });
    const store = storeWith(f.pool);
    const answer = await store.retake({ me, shardCount: 4, pairs: [{ shardCount: 4, shardId: 3, claim: 40 }], guildIds: [], generation: 0, ttlMs: T.ttlMs });
    expect(updateValues[3]).toBe('p-a');
    expect(updateValues[6]).toBe(false);
    expect(updateValues[9]).toEqual([91]);
    expect(updateValues[10]).toEqual(['p-a']);
    expect(answer.taken).toEqual([{ before: { shardCount: 4, shardId: 3, claim: 40 }, pair: { shardCount: 4, shardId: 3, claim: 92 } }]);
  });
});
