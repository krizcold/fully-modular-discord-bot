import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { heartbeat, me, startClaimRig, TIMINGS, type ClaimRig } from '../helpers/pgClaimRig';
import type { ClaimStore } from '../../src/bot/internalSetup/fleet/claimStore';
import { claimState, type Pair } from '../../src/bot/internalSetup/fleet/claimRules';

// NB4 decisions 10, 11 and 12: a released row goes back to its node's next process at once and to no other node before
// its expiry; a hand-over only to a receiver that still qualifies, never past its room; reservations kept at the
// release; the deferrals for a restarted node and the page state.

let rig: ClaimRig;
let a: ClaimStore;
let a2: ClaimStore;
let b: ClaimStore;
beforeAll(async () => {
  rig = await startClaimRig();
  a = rig.store();
  a2 = rig.store();
  b = rig.store();
}, 180_000);
afterAll(async () => { await rig?.stop(); });
beforeEach(async () => { await rig.reset(); });

const A = me('a');
const A2 = { ...A, processId: 'p-a-next' };
const B = me('b');
const renew = (s: ClaimStore, who: typeof A, pairs: Pair[] = [], hb = heartbeat()) => s.renew({ me: who, pairs, ttlMs: TIMINGS.ttlMs, heartbeat: hb });
const take = (s: ClaimStore, who: typeof A, over: Record<string, unknown> = {}) =>
  s.take({ me: who, capacity: 4, ttlMs: TIMINGS.ttlMs, boot: true, known: [], localCount: 2, reserve: false, ...over });

async function aHolds(): Promise<Pair[]> {
  await renew(a, A);
  const got = await take(a, A);
  if (got.kind !== 'done') throw new Error('no take');
  return got.taken.map(t => t.pair);
}

describe('the release', () => {
  it('keeps the rows for this node: its next process takes them at once, another node not before their expiry', async () => {
    const pairs = await aHolds();
    const released = await a.release({ me: A, reserved: [], handOvers: [], ttlMs: TIMINGS.ttlMs });
    expect(released.map(r => [r.shardId, r.wasReserved, r.handedTo])).toEqual(pairs.map(p => [p.shardId, false, null]));
    await renew(b, B);
    const bGot = await take(b, B, { boot: false, reserve: true });
    expect(bGot.kind === 'done' && bGot.taken).toEqual([]);
    await renew(a2, A2);
    const next = await take(a2, A2);
    expect(next.kind === 'done' && next.taken.map(t => t.pair.shardId).sort()).toEqual([0, 1]);
  });

  it('covers a reservation still listed and leaves a given-up one as it was', async () => {
    await renew(b, B, [], heartbeat({ capacity: 3 }));
    await renew(a, A);
    const held = await take(a, A, { capacity: 1, localCount: 4 });
    if (held.kind !== 'done') throw new Error('no take');
    const reserved = await take(a, A, { boot: false, reserve: true, capacity: 3, localCount: 4, known: held.taken.map(t => t.pair) });
    if (reserved.kind !== 'done') throw new Error('no reservation');
    const [kept, given] = reserved.taken.map(t => t.pair);
    const before = await rig.row(given.shardId, 4);
    const rows = await a.release({ me: A, reserved: [kept], handOvers: [], ttlMs: TIMINGS.ttlMs });
    expect(rows.map(r => [r.shardId, r.wasReserved]).sort()).toEqual([[held.taken[0].pair.shardId, false], [kept.shardId, true]].sort());
    const after = await rig.row(given.shardId, 4);
    expect(after.exp).toBe(before.exp);
    expect(after.reserved).toBe(true);
  });

  it('hands a shard only to a receiver that qualifies, never more than its room, and a move sets home_node', async () => {
    const pairs = await aHolds();
    await renew(b, B, [], heartbeat({ capacity: 1 }));
    await rig.direct.query(`UPDATE smdb_data.shard_nodes SET healthy_since = now() - interval '301 seconds' WHERE node_id = 'n-b'`);
    const rows = await a.release({ me: A, reserved: [], handOvers: pairs.map(p => ({ shardId: p.shardId, receiver: 'n-b', move: true })), ttlMs: TIMINGS.ttlMs });
    expect(rows.filter(r => r.handedTo === 'B')).toHaveLength(1);
    const handed = rows.find(r => r.handedTo === 'B')!;
    const row = await rig.row(handed.shardId);
    expect(row.holder_node).toBe('n-b');
    expect(row.home_node).toBe('n-b');
    expect(rows.filter(r => r.handedTo === null)).toHaveLength(1);
  });

  it('hands nothing to a receiver healthy for only 299 s', async () => {
    const pairs = await aHolds();
    await renew(b, B, [], heartbeat({ capacity: 2 }));
    await rig.direct.query(`UPDATE smdb_data.shard_nodes SET healthy_since = now() - interval '299 seconds' WHERE node_id = 'n-b'`);
    const rows = await a.release({ me: A, reserved: [], handOvers: [{ shardId: pairs[0].shardId, receiver: 'n-b', move: false }], ttlMs: TIMINGS.ttlMs });
    expect(rows.every(r => r.handedTo === null)).toBe(true);
  });

  it('a take whose COMMIT lands while the release waits on the advisory lock is released with it', async () => {
    await renew(a, A);
    const hold = await rig.direct.connect();
    try {
      await hold.query('BEGIN');
      await hold.query(`SELECT pg_advisory_xact_lock(hashtext('smdb_data_claim'))`);
      await hold.query(`INSERT INTO smdb_data.meta (key, value) VALUES ('shard_count', '{"count":1}') ON CONFLICT (key) DO NOTHING`);
      await hold.query(`INSERT INTO smdb_data.shard_claims (shard_count, shard_id, claim, holder_process, holder_node, holder_name, home_node, ttl_ms, expires_up_ms) VALUES (1, 0, 50, 'p-a', 'n-a', 'A', 'n-a', 30000, 30000)`);
      const release = a.release({ me: A, reserved: [], handOvers: [], ttlMs: TIMINGS.ttlMs });
      await new Promise(resolve => setTimeout(resolve, TIMINGS.lockMs / 2));
      await hold.query('COMMIT');
      expect((await release).map(r => r.shardId)).toEqual([0]);
    } finally {
      hold.release();
    }
  });

  it('a ClaimStore.take whose connection is destroyed while its COMMIT runs still commits, and the release that follows at once waits for it and releases its rows', async () => {
    await rig.direct.query(`CREATE OR REPLACE FUNCTION smdb_data.nb4_slow_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.shard_id = 0 THEN PERFORM pg_sleep(0.8); END IF; RETURN NULL; END $$`);
    await rig.direct.query(`CREATE CONSTRAINT TRIGGER nb4_slow_commit AFTER INSERT ON smdb_data.shard_claims
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION smdb_data.nb4_slow_commit()`);
    try {
      await renew(a, A);
      const pending = take(a, A).then(() => null, error => error);
      let committing = false;
      for (let i = 0; i < 150 && !committing; i++) {
        const n = (await rig.direct.query(`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE application_name = 'smdb-claims' AND state = 'active' AND query = 'COMMIT'`)).rows[0].n;
        committing = n > 0;
        if (!committing) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(committing).toBe(true);
      a.abandonWork();
      expect(await pending).toBeInstanceOf(Error);
      expect((await rig.direct.query(`SELECT count(*)::int AS n FROM smdb_data.shard_claims`)).rows[0].n).toBe(0);
      const released = await a.release({ me: A, reserved: [], handOvers: [], ttlMs: TIMINGS.ttlMs });
      expect(released.map(r => r.shardId).sort()).toEqual([0, 1]);
      expect(released.every(r => !r.wasReserved && r.handedTo === null)).toBe(true);
      const rows = (await rig.direct.query(`SELECT shard_id, holder_process, released, reserved FROM smdb_data.shard_claims ORDER BY shard_id`)).rows;
      expect(rows).toEqual([
        { shard_id: 0, holder_process: A.processId, released: true, reserved: false },
        { shard_id: 1, holder_process: A.processId, released: true, reserved: false },
      ]);
    } finally {
      await rig.direct.query(`DROP TRIGGER IF EXISTS nb4_slow_commit ON smdb_data.shard_claims`);
      await rig.direct.query(`DROP FUNCTION IF EXISTS smdb_data.nb4_slow_commit()`);
    }
  });
});

describe('the page state', () => {
  it('a reserved row reads reserved; a kept row counts down from u\'; a restarted node\'s expired row reads deferred', async () => {
    const pairs = await aHolds();
    await a.release({ me: A, reserved: [], handOvers: [], ttlMs: TIMINGS.ttlMs });
    await rig.idle(6000);
    const page = await b.readPage(2);
    for (const row of page.rows) {
      expect(row.released).toBe(true);
      expect(row.expiresUpMs - page.uPrimeMs).toBeLessThanOrEqual(TIMINGS.ttlMs - 5900);
    }
    await rig.direct.query(`UPDATE smdb_data.shard_claims SET released = false, expires_up_ms = 0`);
    await rig.direct.query(`UPDATE smdb_data.claim_clock SET up_ms = 1000`);
    await renew(a2, A2);
    const deferred = await b.take({ me: B, capacity: 4, ttlMs: TIMINGS.ttlMs, boot: false, known: [], localCount: 2, reserve: true });
    expect(deferred.kind === 'done' && deferred.taken).toEqual([]);
    expect(deferred.kind === 'done' && deferred.plan.waitingForOwner).toBe(pairs.length);
  });
});

describe('more of [pg] 7 (T15)', () => {
  const C = me('c');
  let c: ClaimStore;
  beforeAll(() => { c = rig.store(); });
  const stateOf = async (reader: ClaimStore, shardId: number, count = 2) => {
    const page = await reader.readPage(count);
    const row = page.rows.find(r => r.shardId === shardId)!;
    return { ...claimState(row, row.renewedAgoMs, page.nodes.find(n => n.nodeId === row.holderNode), page.upMs, page.uPrimeMs), row, page };
  };

  it('deferral (c) ends: while Y heartbeats without taking, Z takes once the rows have been expired for Y\'s takeover seconds; the page reads expired-deferred with Y\'s name and time left, then expired', async () => {
    const pairs = await aHolds();
    await renew(b, B);
    const exp = Math.max(...await Promise.all(pairs.map(async p => Number((await rig.row(p.shardId)).exp))));
    await rig.direct.query(`UPDATE smdb_data.claim_clock SET up_ms = $1, ticked_at = now()`, [exp + 1000]);
    await renew(a2, A2);
    const deferred = await stateOf(b, 0);
    expect(deferred.state).toBe('expired-deferred');
    expect(deferred.row.holderName).toBe('A');
    expect(deferred.deferredMs).toBeGreaterThan(28_000);
    expect(deferred.deferredMs).toBeLessThanOrEqual(29_000);
    const waiting = await take(b, B, { boot: false, reserve: true });
    expect(waiting.kind === 'done' && waiting.taken).toEqual([]);
    await rig.direct.query(`UPDATE smdb_data.claim_clock SET up_ms = $1, ticked_at = now()`, [exp + 30_000 + 1]);
    await renew(a2, A2);
    expect((await stateOf(b, 0)).state).toBe('expired');
    const got = await take(b, B, { boot: false, reserve: true });
    expect(got.kind === 'done' && got.taken.map(t => t.pair.shardId).sort()).toEqual([0, 1]);
    for (const p of pairs) expect((await rig.row(p.shardId)).holder_process).toBe('p-b');
  });

  it('a hand-over reads kept for the receiver', async () => {
    const pairs = await aHolds();
    await renew(b, B, [], heartbeat({ capacity: 1 }));
    await rig.direct.query(`UPDATE smdb_data.shard_nodes SET healthy_since = now() - interval '301 seconds' WHERE node_id = 'n-b'`);
    const rows = await a.release({ me: A, reserved: [], handOvers: [{ shardId: pairs[0].shardId, receiver: 'n-b', move: false }], ttlMs: TIMINGS.ttlMs });
    expect(rows.find(r => r.shardId === pairs[0].shardId)!.handedTo).toBe('B');
    const handed = await stateOf(c, pairs[0].shardId);
    expect(handed.state).toBe('kept');
    expect(handed.row.holderName).toBe('B');
    expect(handed.row.holderNode).toBe('n-b');
  });

  it('a reservation whose reserver\'s connection was killed reads reserved until its renewed_at is 3R old, then kept', async () => {
    await renew(b, B, [], heartbeat({ capacity: 4 }));
    await rig.direct.query(`INSERT INTO smdb_data.meta (key, value) VALUES ('shard_count', '{"count":2}')`);
    await rig.direct.query(`INSERT INTO smdb_data.shard_claims (shard_count, shard_id, claim, holder_process, holder_node, holder_name, home_node, ttl_ms, expires_up_ms)
      VALUES (2, 0, 7, 'p-dead', 'n-dead', 'DEAD', 'n-dead', 30000, 0)`);
    await rig.direct.query(`UPDATE smdb_data.claim_clock SET up_ms = 1000`);
    const since = (await rig.direct.query(`SELECT now() AS t`)).rows[0].t;
    const x = rig.store();
    await renew(x, A);
    const got = await take(x, A, { boot: false, reserve: true });
    if (got.kind !== 'done') throw new Error('no reservation');
    expect(got.taken.map(t => t.pair.shardId)).toContain(0);
    const killed = await rig.direct.query(`SELECT count(pg_terminate_backend(pid))::int AS n FROM pg_stat_activity
      WHERE pid <> pg_backend_pid() AND backend_start >= $1 AND application_name <> ''`, [since]);
    expect(killed.rows[0].n).toBeGreaterThanOrEqual(1);
    expect((await stateOf(b, 0)).state).toBe('reserved');
    await rig.direct.query(`UPDATE smdb_data.shard_claims SET renewed_at = now() - interval '14 seconds' WHERE shard_id = 0`);
    expect((await stateOf(b, 0)).state).toBe('reserved');
    await rig.direct.query(`UPDATE smdb_data.shard_claims SET renewed_at = now() - interval '16 seconds' WHERE shard_id = 0`);
    const kept = await stateOf(b, 0);
    expect(kept.state).toBe('kept');
    expect(kept.row.holderName).toBe('A');
  });

  it('a take rolled back by the destroy of its connection leaves the release returning nothing', async () => {
    await renew(a, A);
    const hold = await rig.direct.connect();
    try {
      await hold.query('BEGIN');
      await hold.query(`SELECT pg_advisory_xact_lock(hashtext('smdb_data_claim'))`);
      const pending = take(a, A).catch(error => error);
      await new Promise(resolve => setTimeout(resolve, 100));
      a.abandonWork();
      expect(await pending).toBeInstanceOf(Error);
      await hold.query('COMMIT');
    } finally {
      hold.release();
    }
    expect(await a.release({ me: A, reserved: [], handOvers: [], ttlMs: TIMINGS.ttlMs })).toEqual([]);
    expect((await rig.direct.query(`SELECT count(*)::int AS n FROM smdb_data.shard_claims`)).rows[0].n).toBe(0);
  });

  it('deferral (c): Y\'s boot takes its expired rows at once while Z\'s running take waits; with no new heartbeat from Y, Z takes them at expiry', async () => {
    const pairs = await aHolds();
    await renew(b, B);
    const exp = Math.max(...await Promise.all(pairs.map(async p => Number((await rig.row(p.shardId)).exp))));
    await rig.direct.query(`UPDATE smdb_data.claim_clock SET up_ms = $1, ticked_at = now()`, [exp]);
    await renew(a2, A2);
    const waiting = await take(b, B, { boot: false, reserve: true });
    expect(waiting.kind === 'done' && waiting.taken).toEqual([]);
    const boot = await take(a2, A2);
    expect(boot.kind === 'done' && boot.taken.map(t => t.pair.shardId).sort()).toEqual([0, 1]);
  });

  it('deferral (c) with no new heartbeat from Y: Z takes the rows at their expiry', async () => {
    await aHolds();
    await renew(b, B);
    const exp = Number((await rig.row(0)).exp);
    await rig.direct.query(`UPDATE smdb_data.claim_clock SET up_ms = $1, ticked_at = now()`, [exp]);
    const got = await take(b, B, { boot: false, reserve: true });
    expect(got.kind === 'done' && got.taken.map(t => t.pair.shardId).sort()).toEqual([0, 1]);
  });

  it('a crash restart after a gap above G: Y\'s boot sees its rows extended with no new renewal of theirs, and takes them at the extended expiry', async () => {
    const pairs = await aHolds();
    await renew(a, A, pairs);
    const first = await take(a2, A2);
    if (first.kind !== 'done') throw new Error('no take');
    const renewedBefore = new Map(first.predecessorRenewedAt);
    await rig.idle(60_000);
    await renew(a2, A2);
    const row = await rig.row(0);
    expect(row.extended).toBe(true);
    const waiting = await take(a2, A2);
    if (waiting.kind !== 'done') throw new Error('no take');
    expect(waiting.plan.wait?.shardIds.sort()).toEqual([0, 1]);
    expect(waiting.plan.wait!.remainingMs).toBeGreaterThan(TIMINGS.ttlMs - 1000);
    expect([...waiting.predecessorRenewedAt]).toEqual([...renewedBefore]);
    await rig.direct.query(`UPDATE smdb_data.claim_clock SET up_ms = $1, ticked_at = now()`, [Number(row.exp) - 1000]);
    const early = await take(a2, A2);
    expect(early.kind === 'done' && early.taken).toEqual([]);
    await rig.direct.query(`UPDATE smdb_data.claim_clock SET up_ms = $1, ticked_at = now()`, [Number(row.exp)]);
    const atExpiry = await take(a2, A2);
    expect(atExpiry.kind === 'done' && atExpiry.taken.map(t => t.pair.shardId).sort()).toEqual([0, 1]);
  });

  it('a predecessor\'s row homed at a running node C is taken by Y\'s boot at its expiry, and C does not take it first', async () => {
    const pairs = await aHolds();
    await rig.direct.query(`UPDATE smdb_data.shard_claims SET home_node = 'n-c'`);
    await renew(c, C);
    const exp = Number((await rig.row(pairs[0].shardId)).exp);
    await rig.direct.query(`UPDATE smdb_data.claim_clock SET up_ms = $1, ticked_at = now()`, [exp]);
    await renew(a2, A2);
    const cTake = await take(c, C, { boot: false, reserve: true });
    expect(cTake.kind === 'done' && cTake.taken).toEqual([]);
    const yTake = await take(a2, A2);
    expect(yTake.kind === 'done' && yTake.taken.map(t => t.pair.shardId).sort()).toEqual([0, 1]);
  });

  it('page states: reserved stays reserved across renewals, a given-up one turns kept after 3R, and a reservation of a long-unrenewed row reads reserved at once', async () => {
    await renew(b, B, [], heartbeat({ capacity: 4 }));
    await rig.direct.query(`INSERT INTO smdb_data.meta (key, value) VALUES ('shard_count', '{"count":2}')`);
    await rig.direct.query(`INSERT INTO smdb_data.shard_claims (shard_count, shard_id, claim, holder_process, holder_node, holder_name, home_node, taken_at, renewed_at, ttl_ms, expires_up_ms)
      VALUES (2, 0, 7, 'p-dead', 'n-dead', 'DEAD', 'n-dead', now() - interval '2 hours', now() - interval '1 hour', 30000, 0)`);
    await rig.direct.query(`UPDATE smdb_data.claim_clock SET up_ms = 1000`);
    await renew(a, A);
    const got = await take(a, A, { boot: false, reserve: true });
    if (got.kind !== 'done') throw new Error('no reservation');
    const reserved = got.taken.find(t => t.pair.shardId === 0)!.pair;
    expect((await stateOf(b, 0)).state).toBe('reserved');
    await rig.idle(TIMINGS.renewMs);
    await renew(a, A, [reserved]);
    expect((await stateOf(b, 0)).state).toBe('reserved');
    await rig.direct.query(`UPDATE smdb_data.shard_claims SET renewed_at = now() - interval '14 seconds' WHERE shard_id = 0`);
    expect((await stateOf(b, 0)).state).toBe('reserved');
    await rig.direct.query(`UPDATE smdb_data.shard_claims SET renewed_at = now() - interval '16 seconds' WHERE shard_id = 0`);
    const kept = await stateOf(b, 0);
    expect(kept.state).toBe('kept');
    expect(kept.row.holderName).toBe('A');
  });

  it('a reserved row is renewed by its reserver while listed (mine and released, a later expiry) and no more once its renewals stop listing it', async () => {
    await rig.direct.query(`INSERT INTO smdb_data.meta (key, value) VALUES ('shard_count', '{"count":2}')`);
    await rig.direct.query(`INSERT INTO smdb_data.shard_claims (shard_count, shard_id, claim, holder_process, holder_node, holder_name, home_node, taken_at, renewed_at, ttl_ms, expires_up_ms)
      VALUES (2, 0, 7, 'p-dead', 'n-dead', 'DEAD', 'n-dead', now() - interval '2 hours', now() - interval '1 hour', 30000, 0)`);
    await rig.direct.query(`UPDATE smdb_data.claim_clock SET up_ms = 1000`);
    await renew(a, A);
    const got = await take(a, A, { boot: false, reserve: true });
    if (got.kind !== 'done') throw new Error('no reservation');
    const reserved = got.taken.find(t => t.pair.shardId === 0)!.pair;
    const before = await rig.row(0, 2);
    expect(before).toMatchObject({ holder_process: A.processId, released: true, reserved: true });

    await rig.idle(TIMINGS.renewMs);
    const answer = await renew(a, A, [reserved]);
    expect(answer.rows).toContainEqual({ shardCount: 2, shardId: 0, claim: reserved.claim, released: true, mine: true });
    const renewed = await rig.row(0, 2);
    expect(Number(renewed.exp)).toBe((await rig.clock()).upMs + TIMINGS.ttlMs);
    expect(Number(renewed.exp)).toBeGreaterThan(Number(before.exp));
    expect(renewed.renewed_at.getTime()).toBeGreaterThan(before.renewed_at.getTime());
    expect(renewed).toMatchObject({ holder_process: A.processId, released: true, reserved: true, claim_text: String(reserved.claim) });

    await rig.idle(TIMINGS.renewMs);
    const unlisted = await renew(a, A, []);
    expect(unlisted.rows.filter(r => r.shardId === 0 && r.mine)).toEqual([]);
    const after = await rig.row(0, 2);
    expect(after.exp).toBe(renewed.exp);
    expect(after.renewed_at.getTime()).toBe(renewed.renewed_at.getTime());

    const released = await a.release({ me: A, reserved: [reserved], handOvers: [], ttlMs: TIMINGS.ttlMs });
    expect(released).toContainEqual({ shardId: 0, claim: reserved.claim, wasReserved: true, handedTo: null });
    expect(await rig.row(0, 2)).toMatchObject({ holder_process: A.processId, released: true, reserved: false });
  });

  it('page states: a kept row\'s remaining time is expires_up_ms - u\' with ticked_at 6 s back, and falls', async () => {
    await aHolds();
    await a.release({ me: A, reserved: [], handOvers: [], ttlMs: TIMINGS.ttlMs });
    await rig.idle(6000);
    const one = await stateOf(b, 0);
    expect(one.state).toBe('kept');
    const clock = (await rig.direct.query(`SELECT up_ms::text AS up, (extract(epoch FROM (now() - ticked_at)) * 1000)::float8 AS since FROM smdb_data.claim_clock`)).rows[0];
    expect(one.page.uPrimeMs).toBeGreaterThanOrEqual(Number(clock.up) + 6000);
    expect(one.page.uPrimeMs).toBeLessThanOrEqual(Number(clock.up) + Math.min(Number(clock.since), 7500) + 50);
    await rig.idle(1000);
    const two = await stateOf(b, 0);
    expect(two.row.expiresUpMs - two.page.uPrimeMs).toBeLessThan(one.row.expiresUpMs - one.page.uPrimeMs);
  });
});
