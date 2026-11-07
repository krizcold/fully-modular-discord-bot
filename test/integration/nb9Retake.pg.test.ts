import { randomUUID } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { heartbeat, me, startClaimRig, TIMINGS, type ClaimRig } from '../helpers/pgClaimRig';
import type { ClaimStore, RetakeAnswer, RetakeRequest } from '../../src/bot/internalSetup/fleet/claimStore';
import type { Me, Pair } from '../../src/bot/internalSetup/fleet/claimRules';
import { flipReshard, startReshard, type SqlClient } from '../../src/bot/internalSetup/fleet/reshardStore';

// NB9 test 20: NB5's re-take through the take gate on the main a move writes next (35, 56, 58, D9). The old rows come
// from NB4's real take and release, the attempt from decision 6's start and 8's flip. The standby's rows of 8 are one
// direct INSERT of the columns its take writes, as in nb9Reshard.pg.test.ts, until part 3 lands that take.

let rig: ClaimRig;
let a: ClaimStore;
let b: ClaimStore;
let s: ClaimStore;
beforeAll(async () => {
  rig = await startClaimRig();
  a = rig.store();
  b = rig.store();
  s = rig.store();
}, 180_000);
afterAll(async () => { await rig?.stop(); });
beforeEach(async () => { await rig.reset(); });

const A = me('a');
const B = me('b');
const S: Me = { processId: randomUUID(), nodeId: 'n-b', nodeName: 'B' };

async function onClient<T>(fn: (c: SqlClient) => Promise<T>): Promise<T> {
  const client = await rig.direct.connect();
  try { return await fn(client); } finally { client.release(); }
}
const reshard = async () => (await rig.direct.query(`SELECT attempt::text AS attempt, state FROM smdb_data.reshard WHERE id = 1`)).rows[0];
const meta = async () => (await rig.direct.query(`SELECT value FROM smdb_data.meta WHERE key = 'shard_count'`)).rows[0]?.value ?? null;
const rowsOf = async (count: number) => (await rig.direct.query(`SELECT shard_id, released, holder_process, claim::text AS claim
  FROM smdb_data.shard_claims WHERE shard_count = $1 ORDER BY shard_id`, [count])).rows;

/** NB4's real boot take of count 4 by A (every shard) after its heartbeat, and B's heartbeat. */
async function oldSet(): Promise<Pair[]> {
  await a.renew({ me: A, pairs: [], ttlMs: TIMINGS.ttlMs, heartbeat: heartbeat() });
  await b.renew({ me: B, pairs: [], ttlMs: TIMINGS.ttlMs, heartbeat: heartbeat() });
  const got = await a.take({ me: A, capacity: 4, ttlMs: TIMINGS.ttlMs, boot: true, known: [], localCount: 4, reserve: false });
  expect(got.kind).toBe('done');
  return got.kind === 'done' ? got.taken.map(t => t.pair) : [];
}

async function standbyRows(ids: number[], count = 8, holder: Me = S): Promise<Pair[]> {
  const { upMs } = await rig.clock();
  const out: Pair[] = [];
  for (const id of ids) {
    const r = await rig.direct.query(`INSERT INTO smdb_data.shard_claims (shard_count, shard_id, claim, holder_process, holder_node, holder_name,
      home_node, released, reserved, taken_at, renewed_at, ttl_ms, expires_up_ms, extended, ready)
      VALUES ($7, $1, nextval('smdb_data.claim_seq'), $2, $3, $4, $3, false, false, now(), now(), $5, $6, false, true)
      RETURNING claim::text AS claim`,
    [id, holder.processId, holder.nodeId, holder.nodeName, TIMINGS.ttlMs, upMs + TIMINGS.ttlMs, count]);
    out.push({ shardCount: count, shardId: id, claim: Number(r.rows[0].claim) });
  }
  return out;
}

async function startOverlap(): Promise<string> {
  const attempt = randomUUID();
  const started = await onClient(c => startReshard(c, { attempt, wanted: 8, method: 'overlap', reason: null, startedBy: 'A', maxConcurrency: 1 }));
  expect(started.kind).toBe('started');
  return attempt;
}

/** 'flipped' 4 -> 8 with meta 8; the standby S holds every row of 8, and the move's target lost S's row of shard 0. */
async function flippedWithLostRow() {
  const old = await oldSet();
  const attempt = await startOverlap();
  const mine = await standbyRows([0, 1, 2, 3, 4, 5, 6, 7]);
  expect((await onClient(c => flipReshard(c, attempt))).kind).toBe('flipped');
  await rig.direct.query(`DELETE FROM smdb_data.shard_claims WHERE shard_count = 8 AND shard_id = 0`);
  return { attempt, old, lost: mine[0] };
}

const retake = (store: ClaimStore, who: Me, pair: Pair): Promise<RetakeAnswer> => {
  const request: RetakeRequest = {
    me: who, shardCount: pair.shardCount, pairs: [pair], guildIds: [{ shardId: pair.shardId, guildIds: [] }], generation: 0, ttlMs: TIMINGS.ttlMs,
  };
  return store.retake(request);
};

describe("test 20: a new main showing 'flipped' with meta W", () => {
  it("a live from_count row naming another process: nothing taken, kind 'held'", async () => {
    const { lost } = await flippedWithLostRow();
    const answer = await retake(s, S, lost);
    expect(answer.taken).toEqual([]);
    expect(answer.refused?.kind).toBe('held');
    expect((await rowsOf(8)).some(r => r.shard_id === 0)).toBe(false);
    expect((await reshard()).state).toBe('flipped');
  });

  it('with that row released: the delete, the close and the re-take in one COMMIT', async () => {
    const { lost } = await flippedWithLostRow();
    await a.release({ me: A, reserved: [], handOvers: [], ttlMs: TIMINGS.ttlMs });
    const answer = await retake(s, S, lost);
    expect(answer.refused).toBeUndefined();
    expect(answer.taken.map(t => t.pair.shardId)).toEqual([0]);
    expect(await rowsOf(4)).toEqual([]);
    expect((await reshard()).state).toBe('done');
    expect((await rowsOf(8)).find(r => r.shard_id === 0)).toMatchObject({ holder_process: S.processId, released: false });
  });

  it('with that row expired: the same, and the close names it', async () => {
    const { lost } = await flippedWithLostRow();
    await rig.direct.query(`UPDATE smdb_data.shard_claims SET expires_up_ms = 0 WHERE shard_count = 4`);
    const answer = await retake(s, S, lost);
    expect(answer.taken.map(t => t.pair.shardId)).toEqual([0]);
    expect(await rowsOf(4)).toEqual([]);
    expect((await reshard()).state).toBe('done');
  });

  it("meta N for a pair of W: kind 'count', nothing written", async () => {
    await oldSet();
    await startOverlap();
    const [pair] = await standbyRows([0]);
    await rig.direct.query(`DELETE FROM smdb_data.shard_claims WHERE shard_count = 8 AND shard_id = 0`);
    const answer = await retake(s, S, pair);
    expect(answer).toMatchObject({ taken: [], refused: { kind: 'count' } });
    expect((await rowsOf(8))).toEqual([]);
    expect(await meta()).toBe('{"count":4}');
  });

  it('a live row of a third count: kind \'held\'', async () => {
    const { lost } = await flippedWithLostRow();
    await a.release({ me: A, reserved: [], handOvers: [], ttlMs: TIMINGS.ttlMs });
    await standbyRows([0], 6, me('c'));
    const answer = await retake(s, S, lost);
    expect(answer.refused?.kind).toBe('held');
    expect(answer.refused?.kind === 'held' && answer.refused.rows.map(r => r.shardCount)).toEqual([6]);
    expect((await reshard()).state).toBe('flipped');
  });
});

describe('test 20: an open attempt on the new main (35, 56)', () => {
  it("a pair of N with live to_count rows of an open attempt: taken", async () => {
    const old = await oldSet();
    await startOverlap();
    await standbyRows([0, 1, 2, 3, 4, 5, 6, 7]);
    await rig.direct.query(`DELETE FROM smdb_data.shard_claims WHERE shard_count = 4 AND shard_id = 2`);
    const answer = await retake(a, A, old[2]);
    expect(answer.refused).toBeUndefined();
    expect(answer.taken.map(t => t.pair.shardId)).toEqual([2]);
    expect(await rowsOf(8)).toHaveLength(8);
    expect((await reshard()).state).toBe('standby');
  });

  it("a 'cancelled' overlap whose dead standby's rows of to_count are still live: the pair of N is taken (the exception keys on from_count, 56)", async () => {
    const old = await oldSet();
    await startOverlap();
    await standbyRows([0, 1]);
    await rig.direct.query(`UPDATE smdb_data.reshard SET state = 'cancelled' WHERE id = 1`);
    await rig.direct.query(`DELETE FROM smdb_data.shard_claims WHERE shard_count = 4 AND shard_id = 2`);
    const answer = await retake(a, A, old[2]);
    expect(answer.refused).toBeUndefined();
    expect(answer.taken.map(t => t.pair.shardId)).toEqual([2]);
    expect(await rowsOf(8)).toHaveLength(2);
  });
});

describe('test 20: D9, a main with no meta shard_count', () => {
  it("NB5's re-take is refused 'count', no claim row is written, and meta stays absent", async () => {
    const old = await oldSet();
    await rig.direct.query(`DELETE FROM smdb_data.meta WHERE key = 'shard_count'`);
    await rig.direct.query(`DELETE FROM smdb_data.shard_claims WHERE shard_count = 4 AND shard_id = 1`);
    const answer = await retake(a, A, old[1]);
    expect(answer).toMatchObject({ taken: [], refused: { kind: 'count' } });
    expect((await rowsOf(4)).map(r => r.shard_id)).toEqual([0, 2, 3]);
    expect(await meta()).toBeNull();
  });
});
