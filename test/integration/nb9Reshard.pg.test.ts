import { randomUUID } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { heartbeat, me, startClaimRig, TIMINGS, type ClaimRig } from '../helpers/pgClaimRig';
import { ClaimFailure, type ClaimStore } from '../../src/bot/internalSetup/fleet/claimStore';
import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import type { Me } from '../../src/bot/internalSetup/fleet/claimRules';
import { ShardClaims } from '../../src/bot/internalSetup/fleet/shardClaims';
import { callOffReshard, closeReshard, flipReshard, startReshard, type SqlClient } from '../../src/bot/internalSetup/fleet/reshardStore';

// NB9 test 10, the rows that drive claimStore.ts and reshardStore.ts: decision 6's start, 8's flip, 10's close, 11's
// call-offs with 66, the take gate under an open attempt (C1) and the serve's redraw (29, 59, D9). The old rows come
// from NB4's real take and release, the standby's rows from its real take (7, 61) and, when ready, its real renewal (C14).

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
const reshard = async () => (await rig.direct.query(`SELECT attempt::text AS attempt, state, from_count, to_count, failures,
  (extract(epoch FROM retry_after - now()))::float8 AS retry_in FROM smdb_data.reshard WHERE id = 1`)).rows[0];
const meta = async () => (await rig.direct.query(`SELECT value FROM smdb_data.meta WHERE key = 'shard_count'`)).rows[0]?.value ?? null;
const rowsOf = async (count: number) => (await rig.direct.query(`SELECT shard_id, released, holder_process, claim::text AS claim, expires_up_ms::text AS exp
  FROM smdb_data.shard_claims WHERE shard_count = $1 ORDER BY shard_id`, [count])).rows;

/** NB4's real boot take of count 4 by A (every shard) after its heartbeat. */
async function oldSet(capacity = 4) {
  await a.renew({ me: A, pairs: [], ttlMs: TIMINGS.ttlMs, heartbeat: heartbeat({ capacity }) });
  const got = await a.take({ me: A, capacity, ttlMs: TIMINGS.ttlMs, boot: true, known: [], localCount: 4, reserve: false });
  expect(got.kind).toBe('done');
  return got.kind === 'done' ? got.taken.map(t => t.pair) : [];
}

/** B's heartbeat, so B is a live, fit machine. */
const heartbeatB = (over = {}) => b.renew({ me: B, pairs: [], ttlMs: TIMINGS.ttlMs, heartbeat: heartbeat(over) });

async function startOverlap(attempt = randomUUID(), wanted = 8) {
  const started = await onClient(c => startReshard(c, { attempt, wanted, method: 'overlap', reason: null, startedBy: 'A', maxConcurrency: 1 }));
  expect(started.kind).toBe('started');
  return attempt;
}

/**
 * The standby's real take of shards 0 to k-1 of count 8 (capacity k) for the open attempt; ready through its renewal.
 * With k under 8, A's heartbeat capacity must hold the other 8 - k, or NB4's no-room rule takes more.
 */
async function standbyRows(ids: number[], ready: boolean, holder: Me = S) {
  const { attempt } = await reshard();
  const took = await s.standbyTake({ me: holder, capacity: ids.length, ttlMs: TIMINGS.ttlMs, attempt, shardCount: 8 });
  expect(took.kind === 'done' ? took.taken.map(p => p.shardId) : took).toEqual(ids);
  if (ready && took.kind === 'done') {
    await s.renewStandby({ me: holder, pairs: took.taken.map(p => ({ ...p, ready: true })), ttlMs: TIMINGS.ttlMs });
  }
}

const releaseA = (pairs: Array<{ shardCount: number; shardId: number; claim: number }>) =>
  a.release({ me: A, reserved: [], handOvers: [], ttlMs: TIMINGS.ttlMs }).then(rows => { expect(rows.length).toBe(pairs.length); });

describe('decision 6, the start', () => {
  it('two concurrent starts write one attempt', async () => {
    await oldSet();
    const one = randomUUID();
    const two = randomUUID();
    const answers = await Promise.all([one, two].map(attempt => onClient(c =>
      startReshard(c, { attempt, wanted: 8, method: 'overlap', reason: null, startedBy: 'A', maxConcurrency: 1 }))));
    expect(answers.map(x => x.kind).sort()).toEqual(['refused', 'started']);
    const row = await reshard();
    expect(row.state).toBe('standby');
    expect([one, two]).toContain(row.attempt);
    expect([row.from_count, row.to_count]).toEqual([4, 8]);
  });

  it('a store whose row 1 was deleted by hand gets the seed back before its read (C1)', async () => {
    await oldSet();
    await rig.direct.query(`DELETE FROM smdb_data.reshard`);
    await startOverlap();
    expect((await reshard()).state).toBe('standby');
  });
});

describe('C1: a boot take under an open attempt', () => {
  it('with live count-8 standby rows and every count-4 row released, boot takes of local count 6 and 8 take under 4', async () => {
    const pairs = await oldSet();
    await startOverlap();
    await standbyRows([0, 1, 2, 3, 4, 5, 6, 7], false);
    await releaseA(pairs);
    for (const local of [6, 8]) {
      const got = await b.take({ me: B, capacity: 4, ttlMs: TIMINGS.ttlMs, boot: true, known: [], localCount: local, reserve: false });
      expect(got.kind === 'done' && got.shardCount).toBe(4);
      expect(await meta()).toBe('{"count":4}');
      const eight = await rowsOf(8);
      expect(eight).toHaveLength(8);
      expect(eight.every(r => r.released === false)).toBe(true);
      await b.release({ me: B, reserved: [], handOvers: [], ttlMs: TIMINGS.ttlMs });
    }
  });
});

describe('decision 8, the flip', () => {
  async function standbyReady() {
    await oldSet();
    await heartbeatB();
    const attempt = await startOverlap();
    await standbyRows([0, 1, 2, 3, 4, 5, 6, 7], true);
    return attempt;
  }

  it('does not commit with one new shard unready', async () => {
    const attempt = await standbyReady();
    await rig.direct.query(`UPDATE smdb_data.shard_claims SET ready = false WHERE shard_count = 8 AND shard_id = 7`);
    expect((await onClient(c => flipReshard(c, attempt))).kind).toBe('not-yet');
    expect(await meta()).toBe('{"count":4}');
  });

  it('does not commit with a stale renewed_at', async () => {
    const attempt = await standbyReady();
    await rig.direct.query(`UPDATE smdb_data.shard_claims SET renewed_at = now() - interval '16 seconds' WHERE shard_count = 8 AND shard_id = 0`);
    expect((await onClient(c => flipReshard(c, attempt))).kind).toBe('not-yet');
  });

  it('does not commit with the old machine unfit', async () => {
    const attempt = await standbyReady();
    await a.renew({ me: A, pairs: [], ttlMs: TIMINGS.ttlMs, heartbeat: heartbeat({ fit: false }) });
    expect((await onClient(c => flipReshard(c, attempt))).kind).toBe('not-yet');
    expect((await reshard()).state).toBe('standby');
  });

  it('commits meta and the state in one transaction otherwise', async () => {
    const attempt = await standbyReady();
    expect(await onClient(c => flipReshard(c, attempt))).toEqual({ kind: 'flipped', fromCount: 4, toCount: 8 });
    expect(await meta()).toBe('{"count":8}');
    expect((await reshard()).state).toBe('flipped');
  });
});

describe('decision 10, the close', () => {
  async function flipped() {
    const pairs = await oldSet();
    await heartbeatB();
    const attempt = await startOverlap();
    await standbyRows([0, 1, 2, 3, 4, 5, 6, 7], true);
    expect((await onClient(c => flipReshard(c, attempt))).kind).toBe('flipped');
    return { attempt, pairs };
  }

  it('does not commit while an old row is live', async () => {
    const { attempt } = await flipped();
    expect((await onClient(c => closeReshard(c, attempt))).kind).toBe('not-yet');
    expect(await rowsOf(4)).toHaveLength(4);
  });

  it("45: with one old row left to expire, the standby's poll writes 'done' after the expiry, no release or boot running", async () => {
    const { attempt } = await flipped();
    await a.release({ me: A, reserved: [], handOvers: [], ttlMs: TIMINGS.ttlMs });
    await rig.direct.query(`UPDATE smdb_data.shard_claims SET released = false, expires_up_ms = 0 WHERE shard_count = 4 AND shard_id = 3`);
    const lines: string[] = [];
    const log = { log: (l: string) => lines.push(l), warn: (l: string) => lines.push(l), error: (l: string) => lines.push(l) };
    const done: number[] = [];
    const claims = new ShardClaims({
      store: s, me: S, timings: TIMINGS, capacity: 8, takeoverSeconds: 30, returns: false, restartable: true, startedAt: Date.now(),
      fitness: () => null, gateClosed: () => false, isStopping: () => false, stopServingStep: () => undefined,
      noteLapsed: () => undefined, noteLost: () => undefined, restartForShards: () => false, log, countSetting: () => null,
      standby: { attempt, count: 8, onEnd: () => undefined, onDone: () => { done.push(Date.now()); } },
    });
    claims.start();
    for (let i = 0; i < 100 && done.length === 0; i++) await new Promise(resolve => { setTimeout(resolve, 100); });
    await claims.stopLanes();
    const row = await reshard();
    expect([row.state, row.failures]).toEqual(['done', 0]);
    expect(await rowsOf(4)).toEqual([]);
    expect(done).toHaveLength(1);
    expect(lines).toContain("[Shards] The 4 old shards are released or expired; each machine's new shards serve once its old bot process has stopped; shard(s) 3 expired instead (their process stopped renewing before it released them)");
  });

  it('deletes the old rows once all are released or expired, and names the expired ones', async () => {
    const { attempt, pairs } = await flipped();
    await releaseA(pairs);
    await rig.direct.query(`UPDATE smdb_data.shard_claims SET released = false, expires_up_ms = 0 WHERE shard_count = 4 AND shard_id = 2`);
    expect(await onClient(c => closeReshard(c, attempt))).toEqual({ kind: 'closed', fromCount: 4, toCount: 8, expired: [2] });
    expect(await rowsOf(4)).toEqual([]);
    const row = await reshard();
    expect([row.state, row.failures]).toEqual(['done', 0]);
  });
});

describe('decision 11 with 66, the call-offs', () => {
  it('an expired unreleased old row in standby: cancelled, failures + 1, retry_after 15 min on', async () => {
    await oldSet();
    await heartbeatB();
    const attempt = await startOverlap();
    await rig.direct.query(`UPDATE smdb_data.shard_claims SET expires_up_ms = 0 WHERE shard_count = 4 AND shard_id = 1`);
    const answer = await onClient(c => callOffReshard(c, attempt));
    expect(answer).toMatchObject({ kind: 'called-off', reason: 'shard 1 of A is no longer renewed' });
    const row = await reshard();
    expect([row.state, row.failures]).toEqual(['cancelled', 1]);
    expect(row.retry_in).toBeGreaterThan(14 * 60);
  });

  it('an unfit old machine keeps failures', async () => {
    await oldSet();
    await heartbeatB();
    const attempt = await startOverlap();
    await a.renew({ me: A, pairs: [], ttlMs: TIMINGS.ttlMs, heartbeat: heartbeat({ fit: false }) });
    expect(await onClient(c => callOffReshard(c, attempt))).toMatchObject({ kind: 'called-off', reason: 'A is not healthy' });
    expect((await reshard()).failures).toBe(0);
  });
});

describe('29, 59 and D9: the redraw', () => {
  async function done() {
    const pairs = await oldSet();
    await heartbeatB();
    const attempt = await startOverlap();
    await standbyRows([0, 1, 2, 3, 4, 5, 6, 7], true);
    expect((await onClient(c => flipReshard(c, attempt))).kind).toBe('flipped');
    return { attempt, pairs };
  }
  const redraw = (ids = [0, 1, 2, 3, 4, 5, 6, 7]) => s.redraw({ me: S, shardCount: 8, shardIds: ids, ttlMs: TIMINGS.ttlMs });

  it('after the close it returns every row under a claim above every stamp', async () => {
    const { attempt, pairs } = await done();
    await releaseA(pairs);
    expect((await onClient(c => closeReshard(c, attempt))).kind).toBe('closed');
    const floor = Number((await rig.direct.query(`SELECT max(claim)::text AS m FROM smdb_data.shard_claims`)).rows[0].m);
    const got = await redraw();
    expect(got.kind).toBe('done');
    if (got.kind !== 'done') return;
    expect(got.pairs.map(p => p.shardId)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    for (const p of got.pairs) expect(p.claim).toBeGreaterThan(floor);
  });

  it('on flipped with released and expired old rows it deletes them, writes done and returns its rows in one COMMIT', async () => {
    const { pairs } = await done();
    await releaseA(pairs);
    await rig.direct.query(`UPDATE smdb_data.shard_claims SET released = false, expires_up_ms = 0 WHERE shard_count = 4 AND shard_id = 0`);
    const got = await redraw();
    expect(got).toMatchObject({ kind: 'done', closed: { fromCount: 4, toCount: 8, expired: [0] } });
    expect(await rowsOf(4)).toEqual([]);
    expect((await reshard()).state).toBe('done');
  });

  it('with a live old row it is refused held and changes nothing', async () => {
    await done();
    const before = await rowsOf(8);
    const got = await redraw();
    expect(got.kind).toBe('held');
    expect(await rowsOf(8)).toEqual(before);
    expect((await reshard()).state).toBe('flipped');
  });

  it('a released or expired row of its own is not returned', async () => {
    const { attempt, pairs } = await done();
    await releaseA(pairs);
    await onClient(c => closeReshard(c, attempt));
    await rig.direct.query(`UPDATE smdb_data.shard_claims SET released = true WHERE shard_count = 8 AND shard_id = 6`);
    await rig.direct.query(`UPDATE smdb_data.shard_claims SET expires_up_ms = 0 WHERE shard_count = 8 AND shard_id = 7`);
    const got = await redraw();
    expect(got.kind === 'done' && got.pairs.map(p => p.shardId)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('a second redraw after a lost reply returns the rows again', async () => {
    const { attempt, pairs } = await done();
    await releaseA(pairs);
    await onClient(c => closeReshard(c, attempt));
    const first = await redraw();
    const second = await redraw();
    expect(second.kind === 'done' && second.pairs.map(p => p.shardId)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    if (first.kind === 'done' && second.kind === 'done') expect(second.pairs[0].claim).toBeGreaterThan(first.pairs[0].claim);
  });

  it('a live row of a later attempt\'s to_count does not block it (59)', async () => {
    const { attempt, pairs } = await done();
    await releaseA(pairs);
    await onClient(c => closeReshard(c, attempt));
    await rig.direct.query(`UPDATE smdb_data.reshard SET attempt = $1::uuid, state = 'standby', from_count = 8, to_count = 12 WHERE id = 1`, [randomUUID()]);
    await rig.direct.query(`INSERT INTO smdb_data.shard_claims (shard_count, shard_id, claim, holder_process, holder_node, holder_name,
      home_node, released, reserved, taken_at, renewed_at, ttl_ms, expires_up_ms, extended)
      VALUES (12, 0, nextval('smdb_data.claim_seq'), 'p-x', 'n-a', 'A', 'n-a', false, false, now(), now(), $1, 1e12, false)`, [TIMINGS.ttlMs]);
    expect((await redraw()).kind).toBe('done');
  });

  it('D9: with meta shard_count deleted the redraw returns no row and meta stays absent', async () => {
    const { attempt, pairs } = await done();
    await releaseA(pairs);
    await onClient(c => closeReshard(c, attempt));
    await rig.direct.query(`DELETE FROM smdb_data.meta WHERE key = 'shard_count'`);
    expect((await redraw()).kind).toBe('count');
    expect(await meta()).toBeNull();
  });
});

describe("C14: the standby's renewal", () => {
  const ready = async () => (await rig.direct.query(`SELECT shard_id, ready, renewed_at, expires_up_ms::text AS exp FROM smdb_data.shard_claims
    WHERE shard_count = 8 ORDER BY shard_id`)).rows;

  it("renews its pairs, writes ready per pair, ticks the clock and writes no shard_nodes row", async () => {
    await oldSet(6);
    await heartbeatB();
    await startOverlap();
    await standbyRows([0, 1], false);
    const before = await ready();
    const nodesBefore = (await rig.direct.query(`SELECT node_id, process_id, seen_at FROM smdb_data.shard_nodes ORDER BY node_id`)).rows;
    await rig.idle(2000);
    const pairs = (await rowsOf(8)).map(r => ({ shardCount: 8, shardId: r.shard_id, claim: Number(r.claim), ready: r.shard_id === 0 }));
    const answer = await s.renewStandby({ me: S, pairs, ttlMs: TIMINGS.ttlMs });
    expect(answer.rows.filter(r => r.mine).map(r => r.shardId).sort()).toEqual([0, 1]);
    const after = await ready();
    expect(after.map(r => r.ready)).toEqual([true, false]);
    for (let i = 0; i < 2; i++) expect(BigInt(after[i].exp)).toBeGreaterThan(BigInt(before[i].exp));
    expect((await rig.clock()).upMs).toBeGreaterThanOrEqual(2000);
    expect((await rig.direct.query(`SELECT node_id, process_id, seen_at FROM smdb_data.shard_nodes ORDER BY node_id`)).rows).toEqual(nodesBefore);
  });

  it('run 20 times beside a normal renewal of another session, neither fails with 40P01', async () => {
    const old = await oldSet();
    await heartbeatB();
    await startOverlap();
    await standbyRows([0, 1, 2, 3, 4, 5, 6, 7], false);
    const pairs = (await rowsOf(8)).map(r => ({ shardCount: 8, shardId: r.shard_id, claim: Number(r.claim), ready: true }));
    for (let i = 0; i < 20; i++) {
      await rig.idle(100);
      const results = await Promise.allSettled([
        s.renewStandby({ me: S, pairs, ttlMs: TIMINGS.ttlMs }),
        a.renew({ me: A, pairs: old, ttlMs: TIMINGS.ttlMs, heartbeat: heartbeat() }),
      ]);
      expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled']);
    }
  });
});

// NB9 code review round 1, lane A finding 2 and lane C's test 18 cells: the sheet's rows that were not written.
const flushBatch = { upserts: [{ key: { module: 'm', filename: 'x.json' }, doc: '{"cell":1}' }], deletes: [], appends: [] };
const tokenOf = (who: Me, pair: { shardCount: number; shardId: number; claim: number }): FenceToken =>
  ({ nodeId: who.nodeId, claim: pair.claim, processId: who.processId, shardId: pair.shardId, shardCount: pair.shardCount });
const guildClaim = async (guildId: string) =>
  Number((await rig.direct.query(`SELECT claim::text AS claim FROM smdb_data.guild_ownership WHERE guild_id = $1`, [guildId])).rows[0].claim);
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try { return await fn(); } finally { errors.mockRestore(); }
};
const redrawAll = () => s.redraw({ me: S, shardCount: 8, shardIds: [0, 1, 2, 3, 4, 5, 6, 7], ttlMs: TIMINGS.ttlMs });

describe('NB9.md:606-607 and :1216, the guild fence across the flip', () => {
  it("NB9.md:606-607: an old flush under its claim lands until its release and is refused after; a new hydrate after 'done' stamps a higher claim, and a late old flush is refused 'deposed'", async () => {
    const pairs = await oldSet();
    const old = pairs.find(p => p.shardId === 0)!;
    const g = '960000000000000001';
    expect(await rig.backend.flushGuild(g, flushBatch, tokenOf(A, old))).toEqual({ ok: true });
    await heartbeatB();
    const attempt = await startOverlap();
    await standbyRows([0, 1, 2, 3, 4, 5, 6, 7], true);
    expect((await onClient(c => flipReshard(c, attempt))).kind).toBe('flipped');
    expect(await rig.backend.flushGuild(g, flushBatch, tokenOf(A, old))).toEqual({ ok: true });
    await releaseA(pairs);
    expect(await quiet(() => rig.backend.flushGuild(g, flushBatch, tokenOf(A, old)))).toMatchObject({ ok: false, reason: 'deposed' });
    const got = await redrawAll();
    expect(got.kind).toBe('done');
    if (got.kind !== 'done') return;
    expect((await reshard()).state).toBe('done');
    const fresh = got.pairs.find(p => p.shardId === 0)!;
    expect((await rig.backend.hydrateGuild(g, tokenOf(S, fresh))).ok).toBe(true);
    expect(await guildClaim(g)).toBe(fresh.claim);
    expect(fresh.claim).toBeGreaterThan(old.claim);
    expect(await quiet(() => rig.backend.flushGuild(g, flushBatch, tokenOf(A, old)))).toMatchObject({ ok: false, reason: 'deposed' });
    expect(await guildClaim(g)).toBe(fresh.claim);
  });

  it("NB9.md:1216 (P7): a from_count boot take during 'standby' draws above the standby's claim and stamps g; the redraw draws above that stamp, the new holder's hydrate lands and the old holder's late flush is refused", async () => {
    const pairs = await oldSet();
    await heartbeatB();
    const attempt = await startOverlap();
    await standbyRows([0, 1, 2, 3, 4, 5, 6, 7], true);
    const standbyTop = Math.max(...(await rowsOf(8)).map(r => Number(r.claim)));
    await releaseA(pairs);
    const A2: Me = { ...A, processId: 'p-a2' };
    await a.renew({ me: A2, pairs: [], ttlMs: TIMINGS.ttlMs, heartbeat: heartbeat() });
    const took = await a.take({ me: A2, capacity: 4, ttlMs: TIMINGS.ttlMs, boot: true, known: [], localCount: 4, reserve: false });
    expect(took.kind === 'done' && took.shardCount).toBe(4);
    if (took.kind !== 'done') return;
    const boot = took.taken.map(t => t.pair).find(p => p.shardId === 0)!;
    expect(boot.claim).toBeGreaterThan(standbyTop);
    const g = '960000000000000002';
    expect((await rig.backend.hydrateGuild(g, tokenOf(A2, boot))).ok).toBe(true);
    expect(await guildClaim(g)).toBe(boot.claim);
    expect((await onClient(c => flipReshard(c, attempt))).kind).toBe('flipped');
    expect(await rig.backend.flushGuild(g, flushBatch, tokenOf(A2, boot))).toEqual({ ok: true });
    expect(await a.release({ me: A2, reserved: [], handOvers: [], ttlMs: TIMINGS.ttlMs })).toHaveLength(4);
    const got = await redrawAll();
    expect(got.kind).toBe('done');
    if (got.kind !== 'done') return;
    const fresh = got.pairs.find(p => p.shardId === 0)!;
    expect(fresh.claim).toBeGreaterThan(boot.claim);
    expect((await rig.backend.hydrateGuild(g, tokenOf(S, fresh))).ok).toBe(true);
    expect(await guildClaim(g)).toBe(fresh.claim);
    expect(await quiet(() => rig.backend.flushGuild(g, flushBatch, tokenOf(A2, boot)))).toMatchObject({ ok: false, reason: 'deposed' });
    expect(await guildClaim(g)).toBe(fresh.claim);
  });
});

describe('NB9.md:2227 and :2674, the redraw against concurrent sessions', () => {
  it('NB9.md:2227: a renewal of an expired from_count row racing the redraw, 50 runs: the renewal lands and the redraw refuses, or the delete lands and the renewal returns no row, never both', async () => {
    const outcomes: string[] = [];
    for (let run = 0; run < 50; run++) {
      await rig.reset();
      const pairs = await oldSet();
      await heartbeatB();
      const attempt = await startOverlap();
      await standbyRows([0, 1, 2, 3, 4, 5, 6, 7], true);
      expect((await onClient(c => flipReshard(c, attempt))).kind).toBe('flipped');
      await releaseA(pairs);
      await rig.direct.query(`UPDATE smdb_data.shard_claims SET released = false, expires_up_ms = 0 WHERE shard_count = 4 AND shard_id = 3`);
      const pair = pairs.find(p => p.shardId === 3)!;
      const [renewed, drawn] = await Promise.all([
        a.renew({ me: A, pairs: [pair], ttlMs: TIMINGS.ttlMs, heartbeat: heartbeat() }),
        redrawAll(),
      ]);
      const renewedMine = renewed.rows.some(r => r.shardCount === 4 && r.shardId === 3 && r.mine);
      const left = await rowsOf(4);
      const up = (await rig.clock()).upMs;
      const liveLeft = left.filter(r => !r.released && Number(r.exp) > up);
      if (drawn.kind === 'held') {
        expect(renewedMine).toBe(true);
        expect(liveLeft.map(r => r.shard_id)).toEqual([3]);
        expect((await reshard()).state).toBe('flipped');
        outcomes.push('renewal');
      } else {
        expect(drawn.kind).toBe('done');
        expect(renewedMine).toBe(false);
        expect(left).toEqual([]);
        expect((await reshard()).state).toBe('done');
        outcomes.push('delete');
      }
    }
    expect(outcomes).toHaveLength(50);
  }, 300_000);

  it("NB9.md:2674 (67): a redraw whose gate DELETE waits on a from_count row a second session holds FOR UPDATE fails with the lock's SQLSTATE and writes nothing; the next try after that session's COMMIT returns its rows", async () => {
    const pairs = await oldSet();
    await heartbeatB();
    const attempt = await startOverlap();
    await standbyRows([0, 1, 2, 3, 4, 5, 6, 7], true);
    expect((await onClient(c => flipReshard(c, attempt))).kind).toBe('flipped');
    await releaseA(pairs);
    const eightBefore = await rowsOf(8);
    const fourBefore = await rowsOf(4);
    const holder = await rig.direct.connect();
    let failure: unknown = null;
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM smdb_data.shard_claims WHERE shard_count = 4 AND shard_id = 0 FOR UPDATE`);
      failure = await redrawAll().then(() => null, (error: unknown) => error);
      expect(await rowsOf(8)).toEqual(eightBefore);
      expect(await rowsOf(4)).toEqual(fourBefore);
      expect((await reshard()).state).toBe('flipped');
      expect(await meta()).toBe('{"count":8}');
      await holder.query('COMMIT');
    } finally {
      holder.release();
    }
    expect(failure).toBeInstanceOf(ClaimFailure);
    expect((failure as ClaimFailure).failure).toMatchObject({ kind: 'error', code: '55P03' });
    const got = await redrawAll();
    expect(got.kind === 'done' && got.pairs.map(p => p.shardId)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(await rowsOf(4)).toEqual([]);
    expect((await reshard()).state).toBe('done');
  });
});

describe("test 18's .pg cells", () => {
  it('O5, the 43 s case: the close waits while an old row is live on the claim clock, and commits once the clock passes its expiry, naming it expired', async () => {
    const pairs = await oldSet();
    await heartbeatB();
    const attempt = await startOverlap();
    await standbyRows([0, 1, 2, 3, 4, 5, 6, 7], true);
    expect((await onClient(c => flipReshard(c, attempt))).kind).toBe('flipped');
    const expiry = Number((await rowsOf(4)).find(r => r.shard_id === 3)!.exp);
    await releaseA(pairs);
    await rig.direct.query(`UPDATE smdb_data.shard_claims SET released = false, expires_up_ms = $1 WHERE shard_count = 4 AND shard_id = 3`, [expiry]);
    expect((await onClient(c => closeReshard(c, attempt))).kind).toBe('not-yet');
    for (let tick = 0; tick < 20 && (await rig.clock()).upMs < expiry; tick++) {
      await rig.idle(5000);
      await heartbeatB();
      if ((await rig.clock()).upMs < expiry) expect((await onClient(c => closeReshard(c, attempt))).kind).toBe('not-yet');
    }
    expect((await rig.clock()).upMs).toBeGreaterThanOrEqual(expiry);
    expect(await onClient(c => closeReshard(c, attempt))).toEqual({ kind: 'closed', fromCount: 4, toCount: 8, expired: [3] });
    expect(await rowsOf(4)).toEqual([]);
  });

  it("the expiry call-off in 'standby' gives failures 1, then 2 on the next attempt toward the same count; then overlap is refused and a stop-start start begins", async () => {
    await oldSet();
    await heartbeatB();
    await rig.direct.query(`UPDATE smdb_data.shard_claims SET expires_up_ms = 0 WHERE shard_count = 4 AND shard_id = 1`);
    for (const failures of [1, 2]) {
      const attempt = await startOverlap();
      expect(await onClient(c => callOffReshard(c, attempt))).toMatchObject({ kind: 'called-off', reason: 'shard 1 of A is no longer renewed' });
      const row = await reshard();
      expect([row.state, row.failures]).toEqual(['cancelled', failures]);
      await rig.direct.query(`UPDATE smdb_data.reshard SET retry_after = now() - interval '1 second' WHERE id = 1`);
    }
    expect(await onClient(c => startReshard(c, { attempt: randomUUID(), wanted: 8, method: 'overlap', reason: null, startedBy: 'A', maxConcurrency: 1 })))
      .toEqual({ kind: 'refused', why: 'failures' });
    const started = await onClient(c => startReshard(c, {
      attempt: randomUUID(), wanted: 8, method: 'stop-start', reason: 'two tries beside the running shards were called off', startedBy: 'A', maxConcurrency: 1,
    }));
    expect(started.kind).toBe('started');
    const row = await reshard();
    expect([row.state, row.failures]).toEqual(['stopping', 2]);
  });
});
