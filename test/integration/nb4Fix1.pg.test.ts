import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { heartbeat, me, startClaimRig, TIMINGS, type ClaimRig } from '../helpers/pgClaimRig';
import { classifyFailure, type ClaimStore } from '../../src/bot/internalSetup/fleet/claimStore';
import { releaseFailureLine } from '../../src/bot/internalSetup/fleet/shardClaims';
import type { Pair } from '../../src/bot/internalSetup/fleet/claimRules';

// Round 1 fixes of NB4 on real Postgres: the take's two batched writes (new rows and re-taken rows, each one statement
// for any number of shards) and the release's sent flag, set only once COMMIT is sent.

let rig: ClaimRig;
let a: ClaimStore;
let b: ClaimStore;
beforeAll(async () => {
  rig = await startClaimRig();
  a = rig.store();
  b = rig.store();
}, 180_000);
afterAll(async () => { await rig?.stop(); });
beforeEach(async () => {
  await rig.reset();
  await rig.direct.query(`DELETE FROM smdb_data.guild_ownership WHERE guild_id = 'nb4fix1'`);
});

const A = me('a');
const B = me('b');
const renew = (s: ClaimStore, who: typeof A, pairs: Pair[] = []) => s.renew({ me: who, pairs, ttlMs: TIMINGS.ttlMs, heartbeat: heartbeat({ capacity: 40 }) });

describe('the batched take', () => {
  it('a boot take of 40 new rows writes each with its own number above the guild floor', async () => {
    await rig.direct.query(`SELECT setval('smdb_data.claim_seq', 3)`);
    await rig.direct.query(`INSERT INTO smdb_data.guild_ownership (guild_id, node_id, shard_id, claim, shard_count) VALUES ('nb4fix1', 'n', 0, 1000, 1)`);
    await renew(a, A);
    const got = await a.take({ me: A, capacity: 40, ttlMs: TIMINGS.ttlMs, boot: true, known: [], localCount: 40, reserve: false });
    if (got.kind !== 'done') throw new Error('no take');
    expect(got.taken.map(t => t.pair.shardId)).toEqual(Array.from({ length: 40 }, (_, i) => i));
    const claims = got.taken.map(t => t.pair.claim);
    expect(new Set(claims).size).toBe(40);
    expect(Math.min(...claims)).toBeGreaterThan(1000);
    const rows = (await rig.direct.query(`SELECT shard_id, claim::text AS claim, holder_process, released FROM smdb_data.shard_claims WHERE shard_count = 40 ORDER BY shard_id`)).rows;
    expect(rows.map(r => [r.shard_id, Number(r.claim), r.holder_process, r.released])).toEqual(got.taken.map(t => [t.pair.shardId, t.pair.claim, A.processId, false]));
    const seq = Number((await rig.direct.query(`SELECT last_value::text AS v FROM smdb_data.claim_seq`)).rows[0].v);
    expect(seq).toBeGreaterThanOrEqual(Math.max(...claims));
    const renewed = await renew(a, A, got.taken.map(t => t.pair));
    expect(renewed.rows.filter(r => r.mine && !r.released)).toHaveLength(40);
  });

  it('a take of expired rows re-takes them in one statement and leaves the row its holder renewed', async () => {
    await renew(a, A);
    const first = await a.take({ me: A, capacity: 4, ttlMs: TIMINGS.ttlMs, boot: true, known: [], localCount: 4, reserve: false });
    if (first.kind !== 'done') throw new Error('no take');
    const exp = Number((await rig.row(0, 4)).exp);
    await rig.direct.query(`UPDATE smdb_data.claim_clock SET up_ms = $1, ticked_at = now()`, [exp + 1000]);
    await renew(a, A, [first.taken[0].pair]);
    const kept = await rig.row(0, 4);
    await renew(b, B);
    const got = await b.take({ me: B, capacity: 4, ttlMs: TIMINGS.ttlMs, boot: false, known: [], localCount: 4, reserve: false });
    if (got.kind !== 'done') throw new Error('no take');
    expect(got.taken.map(t => t.pair.shardId)).toEqual([1, 2, 3]);
    for (const t of got.taken) {
      const row = await rig.row(t.pair.shardId, 4);
      expect([row.holder_process, Number(row.claim_text)]).toEqual([B.processId, t.pair.claim]);
      expect(t.pair.claim).toBeGreaterThan(Math.max(...first.taken.map(x => x.pair.claim)));
    }
    expect(await rig.row(0, 4)).toEqual(kept);
  });
});

describe('the release sent flag', () => {
  it('a completed release reports its COMMIT as sent once', async () => {
    await renew(a, A);
    const got = await a.take({ me: A, capacity: 2, ttlMs: TIMINGS.ttlMs, boot: true, known: [], localCount: 2, reserve: false });
    if (got.kind !== 'done') throw new Error('no take');
    let sent = 0;
    const rows = await a.release({ me: A, reserved: [], handOvers: [], ttlMs: TIMINGS.ttlMs }, () => { sent += 1; });
    expect(sent).toBe(1);
    expect(rows.map(r => r.shardId).sort()).toEqual([0, 1]);
    expect((await rig.row(0, 2)).released).toBe(true);
  });

  it('a lock wait that times out is a server error with no COMMIT sent, and nothing changed', async () => {
    await renew(a, A);
    const got = await a.take({ me: A, capacity: 1, ttlMs: TIMINGS.ttlMs, boot: true, known: [], localCount: 1, reserve: false });
    if (got.kind !== 'done') throw new Error('no take');
    const holder = await rig.direct.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtext('smdb_data_claim'))`);
      let sent = false;
      const error = await a.release({ me: A, reserved: [], handOvers: [], ttlMs: TIMINGS.ttlMs }, () => { sent = true; }).then(() => null, (e: unknown) => e);
      expect(sent).toBe(false);
      const failure = classifyFailure(error);
      // lock_timeout and statement_timeout are both S here; either server error is a rolled-back transaction.
      expect(failure.kind === 'error' && ['55P03', '57014'].includes(failure.code)).toBe(true);
      expect(releaseFailureLine(got.taken.map(t => t.pair), failure, sent)).toMatch(/^\[Shards\] Could not release shards 0 \(SQLSTATE (55P03|57014) /);
      expect((await rig.row(0, 1)).released).toBe(false);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  });
});
