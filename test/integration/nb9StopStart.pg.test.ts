import { randomUUID } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { heartbeat, me, startClaimRig, TIMINGS, type ClaimRig } from '../helpers/pgClaimRig';
import { ClaimFailure, type ClaimStore, type Heartbeat, type TakeRequest } from '../../src/bot/internalSetup/fleet/claimStore';
import type { Me } from '../../src/bot/internalSetup/fleet/claimRules';
import { callOffReshard, flipReshard, startReshard, type SqlClient } from '../../src/bot/internalSetup/fleet/reshardStore';

// NB9 test 11, the rows of part 2b: decision 12's count change with its spread (36), 11's call-off at until_at, 13's
// direct change, the gate's refusals of 73 and 77, and C1's running take after a count change. Every row starts from
// NB4's real take and release and decision 6's real start.

let rig: ClaimRig;
let a: ClaimStore;
let b: ClaimStore;
let c: ClaimStore;
let s: ClaimStore;
beforeAll(async () => {
  rig = await startClaimRig();
  a = rig.store();
  b = rig.store();
  c = rig.store();
  s = rig.store();
}, 180_000);
afterAll(async () => { await rig?.stop(); });
beforeEach(async () => { await rig.reset(); });

const A = me('a');
const B = me('b');
const C = me('c');

async function onClient<T>(fn: (client: SqlClient) => Promise<T>): Promise<T> {
  const client = await rig.direct.connect();
  try { return await fn(client); } finally { client.release(); }
}
const reshard = async () => (await rig.direct.query(`SELECT attempt::text AS attempt, state, method, from_count, to_count, reason
  FROM smdb_data.reshard WHERE id = 1`)).rows[0];
const meta = async () => (await rig.direct.query(`SELECT value FROM smdb_data.meta WHERE key = 'shard_count'`)).rows[0]?.value ?? null;
const rowsOf = async (count: number) => (await rig.direct.query(`SELECT shard_id, released, holder_process, holder_node, home_node,
  claim::text AS claim, ttl_ms::text AS ttl, expires_up_ms::text AS exp FROM smdb_data.shard_claims WHERE shard_count = $1 ORDER BY shard_id`, [count])).rows;

const beat = (store: ClaimStore, who: Me, capacity = 4) => store.renew({ me: who, pairs: [], ttlMs: TIMINGS.ttlMs, heartbeat: heartbeat({ capacity }) });
const boot = (store: ClaimStore, who: Me, localCount: number | null, over: Partial<TakeRequest> = {}) =>
  store.take({ me: who, capacity: 4, ttlMs: TIMINGS.ttlMs, boot: true, known: [], localCount, reserve: false, ...over });
const release = (store: ClaimStore, who: Me) => store.release({ me: who, reserved: [], handOvers: [], ttlMs: TIMINGS.ttlMs });

async function startStopStart(wanted = 8, attempt = randomUUID()) {
  const started = await onClient(client => startReshard(client, {
    attempt, wanted, method: 'stop-start', reason: 'two tries beside the running shards were called off', startedBy: 'A', maxConcurrency: 1,
  }));
  expect(started.kind).toBe('started');
  return attempt;
}

/** Meta 4 with A holding every shard by NB4's real boot take, and B a live machine. */
async function fourOnA() {
  await beat(a, A);
  await beat(b, B);
  const got = await boot(a, A, 4);
  expect(got.kind === 'done' && got.taken.length).toBe(4);
}

describe('decision 12, the count change, and 36, its spread', () => {
  it('waits for a live old row, then writes meta, done and the spread rows together', async () => {
    await fourOnA();
    const attempt = await startStopStart();
    const change = () => boot(b, B, 8, { writesMeta: { kind: 'change', attempt } });
    expect((await change()).kind).toBe('held');
    expect(await meta()).toBe('{"count":4}');
    expect(await rowsOf(8)).toEqual([]);
    await release(a, A);
    const floor = Number((await rig.direct.query(`SELECT max(claim)::text AS m FROM smdb_data.shard_claims`)).rows[0].m);
    const got = await change();
    expect(got.kind).toBe('done');
    if (got.kind !== 'done') return;
    expect(got.taken.map(t => t.pair.shardId)).toEqual([0, 1, 2, 3]);
    expect(got.spread).toEqual({ fromCount: 4, kept: [{ nodeName: 'A', shardIds: [4, 5, 6, 7], seconds: 30 }] });
    expect(await meta()).toBe('{"count":8}');
    expect((await reshard()).state).toBe('done');
    expect(await rowsOf(4)).toEqual([]);
    const eight = await rowsOf(8);
    const kept = eight.filter(r => r.shard_id >= 4);
    for (const r of kept) {
      expect([r.released, r.holder_process, r.holder_node, r.home_node, r.ttl]).toEqual([true, `spread:${attempt}`, A.nodeId, A.nodeId, '30000']);
    }
    const claims = eight.map(r => Number(r.claim));
    expect(new Set(claims).size).toBe(8);
    for (const claim of claims) expect(claim).toBeGreaterThan(floor);
  });

  it('C1: a running take of the old count after the change is refused count; meta and the spread rows stay', async () => {
    await fourOnA();
    const attempt = await startStopStart();
    await release(a, A);
    expect((await boot(b, B, 8, { writesMeta: { kind: 'change', attempt } })).kind).toBe('done');
    const before = await rowsOf(8);
    const got = await a.take({ me: A, capacity: 4, ttlMs: TIMINGS.ttlMs, boot: false, known: [], localCount: 4, reserve: true });
    expect(got.kind).toBe('count');
    expect(await meta()).toBe('{"count":8}');
    expect(await rowsOf(8)).toEqual(before);
  });

  it('a boot of the machine a row was kept for takes it; another machine does not before its expiry', async () => {
    await fourOnA();
    const attempt = await startStopStart();
    await release(a, A);
    expect((await boot(b, B, 8, { writesMeta: { kind: 'change', attempt } })).kind).toBe('done');
    await beat(c, C);
    const other = await boot(c, C, 8);
    expect(other.kind === 'done' && other.taken).toEqual([]);
    const own = await boot(a, A, 8);
    expect(own.kind === 'done' && own.taken.map(t => t.pair.shardId)).toEqual([4, 5, 6, 7]);
  });
});

describe('decision 11 in stopping', () => {
  it('until_at passed with a live old row: called off, and a boot takes the old count again', async () => {
    await fourOnA();
    const attempt = await startStopStart();
    await rig.direct.query(`UPDATE smdb_data.reshard SET until_at = now() - interval '1 second'`);
    expect(await onClient(client => callOffReshard(client, attempt))).toMatchObject({ kind: 'called-off', reason: 'A did not stop within 10 min' });
    expect((await reshard()).state).toBe('cancelled');
    const got = await boot(b, B, 8);
    expect(got.kind === 'done' && got.shardCount).toBe(4);
  });
});

describe('decision 13, the direct change', () => {
  it('refused while a row of the stored count is live, meta unchanged; commits once it is released', async () => {
    await fourOnA();
    const direct = () => boot(b, B, 8, { writesMeta: { kind: 'direct', from: 4 } });
    expect((await direct()).kind).toBe('held');
    expect(await meta()).toBe('{"count":4}');
    await release(a, A);
    const got = await direct();
    expect(got.kind === 'done' && got.spread).toEqual({ fromCount: 4, kept: [{ nodeName: 'A', shardIds: [4, 5, 6, 7], seconds: 30 }] });
    expect(await meta()).toBe('{"count":8}');
    const row = await reshard();
    expect([row.state, row.method, row.from_count, row.to_count]).toEqual(['done', 'stop-start', 4, 8]);
    expect((await rowsOf(8)).filter(r => r.released).every(r => r.holder_process === `spread:${row.attempt}`)).toBe(true);
  });

  it('73: refused count while an attempt is standby; the reshard row unchanged', async () => {
    await fourOnA();
    const attempt = randomUUID();
    expect((await onClient(client => startReshard(client, { attempt, wanted: 8, method: 'overlap', reason: null, startedBy: 'A', maxConcurrency: 1 }))).kind).toBe('started');
    const before = await reshard();
    expect((await boot(b, B, 8, { writesMeta: { kind: 'direct', from: 4 } })).kind).toBe('count');
    expect(await reshard()).toEqual(before);
  });
});

describe('73 and 77, the gate\'s refusals around a start', () => {
  it('77: a boot take that reads stopping after a real start takes nothing; after the release the change commits', async () => {
    await beat(a, A, 2);
    await beat(b, B, 2);
    expect((await a.take({ me: A, capacity: 2, ttlMs: TIMINGS.ttlMs, boot: true, known: [], localCount: 4, reserve: false })).kind).toBe('done');
    expect((await b.take({ me: B, capacity: 2, ttlMs: TIMINGS.ttlMs, boot: true, known: [], localCount: 4, reserve: false })).kind).toBe('done');
    await release(a, A);
    const attempt = await startStopStart();
    const before = await rowsOf(4);
    expect((await boot(c, C, 4)).kind).toBe('count');
    expect(await rowsOf(4)).toEqual(before);
    expect(await meta()).toBe('{"count":4}');
    expect((await reshard()).state).toBe('stopping');
    await release(b, B);
    expect((await boot(c, C, 8, { writesMeta: { kind: 'change', attempt } })).kind).toBe('done');
    expect(await meta()).toBe('{"count":8}');
  });

  it('73: two first boots with counts 4 and 8 on an empty database both run under 4', async () => {
    await beat(a, A);
    await beat(b, B);
    expect((await boot(a, A, 4)).kind).toBe('done');
    const second = await boot(b, B, 8);
    expect(second.kind === 'done' && second.shardCount).toBe(4);
    expect(await meta()).toBe('{"count":4}');
  });

  it('73: the change of a called-off attempt after a start of another is refused count, meta unchanged', async () => {
    await fourOnA();
    const first = await startStopStart();
    await rig.direct.query(`UPDATE smdb_data.reshard SET until_at = now() - interval '1 second'`);
    expect((await onClient(client => callOffReshard(client, first))).kind).toBe('called-off');
    await rig.direct.query(`UPDATE smdb_data.reshard SET retry_after = NULL`);
    await startStopStart(6);
    await release(a, A);
    expect((await boot(b, B, 8, { writesMeta: { kind: 'change', attempt: first } })).kind).toBe('count');
    expect(await meta()).toBe('{"count":4}');
  });
});

describe('31 and 52: the renewal writes count_setting and, on its edge, the target', () => {
  const target = async () => (await rig.direct.query(`SELECT target, target_by, target_at FROM smdb_data.reshard WHERE id = 1`)).rows[0];
  const node = async (nodeId: string) => (await rig.direct.query(`SELECT count_setting, reshard_overlap, memory_room, memory_free_mb,
    memory_use_mb, memory_error, (extract(epoch FROM now() - memory_at))::float8 AS memory_age_s FROM smdb_data.shard_nodes WHERE node_id = $1`, [nodeId])).rows[0];
  const renew = (store: ClaimStore, who: Me, over: Partial<Heartbeat>) =>
    store.renew({ me: who, pairs: [], ttlMs: TIMINGS.ttlMs, heartbeat: heartbeat(over) });

  it('a first heartbeat from a node with no row writes count_setting and no target', async () => {
    const answer = await renew(a, A, { countSetting: 8, targetEdge: true });
    expect(answer.targetWritten ?? null).toBeNull();
    expect((await node(A.nodeId)).count_setting).toBe(8);
    expect(await target()).toEqual({ target: null, target_by: null, target_at: null });
  });

  it('the pre-read finds another value: target, target_by and target_at in the same statement, and the answer says so', async () => {
    await renew(a, A, { countSetting: 4, targetEdge: true });
    const next: Me = { ...A, processId: 'p-a2' };
    const answer = await renew(b, next, { countSetting: 8, targetEdge: true });
    expect(answer.targetWritten).toEqual({ from: 4, to: 8 });
    const t = await target();
    expect([t.target, t.target_by]).toEqual([8, 'A']);
    expect(t.target_at).not.toBeNull();
  });

  it('a setting removed writes target NULL', async () => {
    await renew(a, A, { countSetting: 4, targetEdge: true });
    const answer = await renew(a, { ...A, processId: 'p-a2' }, { countSetting: null, targetEdge: true });
    expect(answer.targetWritten).toEqual({ from: 4, to: null });
    const t = await target();
    expect([t.target, t.target_by]).toEqual([null, 'A']);
    expect(t.target_at).not.toBeNull();
  });

  it('with the edge off, count_setting changes and the target does not', async () => {
    await renew(a, A, { countSetting: 4, targetEdge: true });
    const answer = await renew(a, A, { countSetting: 6, targetEdge: false });
    expect(answer.targetWritten ?? null).toBeNull();
    expect((await node(A.nodeId)).count_setting).toBe(6);
    expect((await target()).target_at).toBeNull();
  });

  it("a lost reply's retry finds this process's own value and writes no second target_at", async () => {
    await renew(a, A, { countSetting: 4, targetEdge: true });
    const next: Me = { ...A, processId: 'p-a2' };
    await renew(b, next, { countSetting: 8, targetEdge: true });
    const first = (await target()).target_at;
    const retry = await renew(b, next, { countSetting: 8, targetEdge: true });
    expect(retry.targetWritten ?? null).toBeNull();
    expect((await target()).target_at).toEqual(first);
  });

  it('writes reshard_overlap and the memory reading as received (37), and five NULLs with no reading', async () => {
    await renew(a, A, { reshardOverlap: false, memory: { room: null, freeMb: 10, useMb: 20, error: 'e'.repeat(300), ageMs: 60_000 } });
    const n = await node(A.nodeId);
    expect([n.reshard_overlap, n.memory_room, n.memory_free_mb, n.memory_use_mb, n.memory_error.length]).toEqual([false, null, 10, 20, 200]);
    expect(n.memory_age_s).toBeGreaterThan(59);
    expect(n.memory_age_s).toBeLessThan(90);
    await renew(a, A, { memory: null });
    const none = await node(A.nodeId);
    expect([none.reshard_overlap, none.memory_room, none.memory_free_mb, none.memory_use_mb, none.memory_error, none.memory_age_s])
      .toEqual([true, null, null, null, null, null]);
  });
});

describe('4 and 31: the first take writes the target from FLEET_SHARD_COUNT', () => {
  const target = async () => (await rig.direct.query(`SELECT target, target_by, target_at IS NOT NULL AS at FROM smdb_data.reshard WHERE id = 1`)).rows[0];

  it('on an empty database, with the setting', async () => {
    await beat(a, A);
    expect((await boot(a, A, 6, { countSetting: 6 })).kind).toBe('done');
    expect(await meta()).toBe('{"count":6}');
    expect(await target()).toEqual({ target: 6, target_by: 'A', at: true });
  });

  it('with no setting, or on a database that holds a count, no target', async () => {
    await beat(a, A);
    expect((await boot(a, A, 6, { countSetting: null })).kind).toBe('done');
    expect(await target()).toEqual({ target: null, target_by: null, at: false });
    expect((await boot(b, B, 8, { countSetting: 8 })).kind).toBe('done');
    expect(await target()).toEqual({ target: null, target_by: null, at: false });
  });
});

// NB9 code review round 1, lane A finding 2: the sheet's rows of test 11 that were not written.
describe('NB9.md:1217, the target in the renewal statement and the call-off it gives', () => {
  const target = async () => (await rig.direct.query(`SELECT target, target_by, target_at FROM smdb_data.reshard WHERE id = 1`)).rows[0];
  const setting = async (nodeId: string) =>
    (await rig.direct.query(`SELECT count_setting, process_id FROM smdb_data.shard_nodes WHERE node_id = $1`, [nodeId])).rows[0];
  const renew = (store: ClaimStore, who: Me, over: Partial<Heartbeat>) =>
    store.renew({ me: who, pairs: [], ttlMs: TIMINGS.ttlMs, heartbeat: heartbeat(over) });

  it('NB9.md:1217: a forced failure of the renewal statement with a changed setting writes neither count_setting nor the target', async () => {
    await renew(a, A, { countSetting: 4, targetEdge: true });
    await rig.direct.query(`CREATE OR REPLACE FUNCTION public.nb9_forced_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'nb9 forced failure'; END $$`);
    await rig.direct.query(`DROP TRIGGER IF EXISTS nb9_forced_failure ON smdb_data.reshard`);
    await rig.direct.query(`CREATE TRIGGER nb9_forced_failure BEFORE UPDATE ON smdb_data.reshard FOR EACH ROW EXECUTE FUNCTION public.nb9_forced_failure()`);
    let failed: unknown = null;
    try {
      failed = await renew(b, { ...A, processId: 'p-a2' }, { countSetting: 8, targetEdge: true }).then(() => null, (error: unknown) => error);
    } finally {
      await rig.direct.query(`DROP TRIGGER IF EXISTS nb9_forced_failure ON smdb_data.reshard`);
      await rig.direct.query(`DROP FUNCTION IF EXISTS public.nb9_forced_failure()`);
    }
    expect(failed).toBeInstanceOf(ClaimFailure);
    expect(await setting(A.nodeId)).toEqual({ count_setting: 4, process_id: A.processId });
    expect(await target()).toEqual({ target: null, target_by: null, target_at: null });
  });

  it('NB9.md:1217: a call-off fires for target_at > started_at only', async () => {
    await fourOnA();
    await renew(a, A, { countSetting: 4, targetEdge: true });
    await renew(a, { ...A, processId: 'p-a2' }, { countSetting: 6, targetEdge: true });
    const before = await target();
    expect(before.target).toBe(6);
    const first = randomUUID();
    expect((await onClient(client => startReshard(client, { attempt: first, wanted: 8, method: 'overlap', reason: null, startedBy: 'A', maxConcurrency: 1 }))).kind).toBe('started');
    expect((await onClient(client => callOffReshard(client, first))).kind).toBe('none');
    expect((await reshard()).state).toBe('standby');
    await renew(a, { ...A, processId: 'p-a3' }, { countSetting: 5, targetEdge: true });
    const after = await target();
    expect(after.target).toBe(5);
    expect(after.target_at.getTime()).toBeGreaterThan(before.target_at.getTime());
    expect(await onClient(client => callOffReshard(client, first))).toMatchObject({
      kind: 'called-off', reason: 'FLEET_SHARD_COUNT was changed to 5 on A after this reshard started', retryNow: true,
    });
    expect((await reshard()).state).toBe('cancelled');
  });
});

describe("NB9.md:2228, Y1 'flipped' and a running reservation", () => {
  const S: Me = { processId: randomUUID(), nodeId: B.nodeId, nodeName: B.nodeName };

  /** Attempt a1 toward 8 called off at its until_at, then a2 toward 8 brought to 'flipped' by the standby's real take, renewal and flip. */
  async function flippedSecondAttempt() {
    await fourOnA();
    const a1 = randomUUID();
    expect((await onClient(client => startReshard(client, { attempt: a1, wanted: 8, method: 'overlap', reason: null, startedBy: 'A', maxConcurrency: 1 }))).kind).toBe('started');
    await rig.direct.query(`UPDATE smdb_data.reshard SET until_at = now() - interval '1 second'`);
    expect((await onClient(client => callOffReshard(client, a1))).kind).toBe('called-off');
    await rig.direct.query(`UPDATE smdb_data.reshard SET retry_after = now() - interval '1 second'`);
    const a2 = randomUUID();
    expect((await onClient(client => startReshard(client, { attempt: a2, wanted: 8, method: 'overlap', reason: null, startedBy: 'A', maxConcurrency: 1 }))).kind).toBe('started');
    const took = await s.standbyTake({ me: S, capacity: 8, ttlMs: TIMINGS.ttlMs, attempt: a2, shardCount: 8 });
    expect(took.kind === 'done' && took.taken.length).toBe(8);
    if (took.kind !== 'done') return a2;
    await s.renewStandby({ me: S, pairs: took.taken.map(p => ({ ...p, ready: true })), ttlMs: TIMINGS.ttlMs });
    expect((await onClient(client => flipReshard(client, a2))).kind).toBe('flipped');
    expect(await meta()).toBe('{"count":8}');
    return a2;
  }

  it('NB9.md:2228 (57): meta W2 with attempt a2 flipped and a live W1 row: the boot take commits nothing; after the release it commits with the close', async () => {
    await flippedSecondAttempt();
    await beat(c, C);
    const eight = await rowsOf(8);
    const four = await rowsOf(4);
    const held = await boot(c, C, 8);
    expect(held.kind).toBe('held');
    expect(await rowsOf(8)).toEqual(eight);
    expect(await rowsOf(4)).toEqual(four);
    expect((await reshard()).state).toBe('flipped');
    await release(a, A);
    const got = await boot(c, C, 8);
    expect(got.kind).toBe('done');
    if (got.kind !== 'done') return;
    expect(got.taken).toEqual([]);
    expect(got.closed).toEqual({ fromCount: 4, toCount: 8, expired: [] });
    expect((await reshard()).state).toBe('done');
    expect(await rowsOf(4)).toEqual([]);
    expect(await rowsOf(8)).toEqual(eight);
  });

  it('NB9.md:2228: a running reservation is refused while a row of another count is live, and taken at the next tick after its release', async () => {
    await flippedSecondAttempt();
    expect(await s.release({ me: S, reserved: [], handOvers: [], ttlMs: TIMINGS.ttlMs })).toHaveLength(8);
    const reserveTake = () => b.take({ me: B, capacity: 4, ttlMs: TIMINGS.ttlMs, boot: false, known: [], localCount: 8, reserve: true });
    const eight = await rowsOf(8);
    const refused = await reserveTake();
    expect(refused.kind).toBe('held');
    expect(await rowsOf(8)).toEqual(eight);
    await release(a, A);
    const got = await reserveTake();
    expect(got.kind).toBe('done');
    if (got.kind !== 'done') return;
    const ids = got.taken.map(t => t.pair.shardId);
    expect(ids.length).toBeGreaterThan(0);
    const rows = (await rig.direct.query(`SELECT shard_id, holder_process, reserved, released FROM smdb_data.shard_claims
      WHERE shard_count = 8 AND shard_id = ANY($1::int[]) ORDER BY shard_id`, [ids])).rows;
    expect(rows).toEqual(ids.slice().sort((x, y) => x - y).map(id => ({ shard_id: id, holder_process: B.processId, reserved: true, released: true })));
  });
});

describe('NB9.md:3076, S0 C5', () => {
  it('NB9.md:3076 (S0 C5): a session ended with pg_terminate_backend after step (0) and before the COMMIT leaves meta, the rows and the reshard row as before', async () => {
    await fourOnA();
    await release(a, A);
    const before = { meta: await meta(), four: await rowsOf(4), eight: await rowsOf(8), reshard: await reshard() };
    const holder = await rig.direct.connect();
    let failed: unknown = null;
    let terminated = false;
    let metaWritten = false;
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM smdb_data.shard_claims WHERE shard_count = 4 AND shard_id = 0 FOR UPDATE`);
      const holderPid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      const take = boot(b, B, 8, { writesMeta: { kind: 'direct', from: 4 } }).then(() => null, (error: unknown) => error);
      for (let i = 0; i < 200 && !terminated; i++) {
        const blocked = (await rig.direct.query(`SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))`, [holderPid])).rows[0];
        if (blocked) {
          const pid = Number(blocked.pid);
          metaWritten = (await rig.direct.query(`SELECT count(*)::int AS n FROM pg_locks l JOIN pg_class k ON k.oid = l.relation
            WHERE l.pid = $1 AND k.relname = 'meta' AND l.mode = 'RowExclusiveLock'`, [pid])).rows[0].n === 1;
          terminated = (await rig.direct.query('SELECT pg_terminate_backend($1) AS ok', [pid])).rows[0].ok === true;
        } else {
          await new Promise(resolve => { setTimeout(resolve, 5); });
        }
      }
      failed = await take;
      await holder.query('ROLLBACK');
    } finally {
      holder.release();
    }
    expect([metaWritten, terminated]).toEqual([true, true]);
    expect(failed).toBeInstanceOf(ClaimFailure);
    expect({ meta: await meta(), four: await rowsOf(4), eight: await rowsOf(8), reshard: await reshard() }).toEqual(before);
  });
});
