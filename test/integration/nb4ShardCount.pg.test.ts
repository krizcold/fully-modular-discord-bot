import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { heartbeat, me, startClaimRig, TIMINGS, type ClaimRig } from '../helpers/pgClaimRig';
import type { ClaimStore } from '../../src/bot/internalSetup/fleet/claimStore';

// NB4 decision 13: the shard count lives in meta 'shard_count'. The first take writes it; a process resolving another
// count runs under the stored one while any row of it is live and unreleased; the count changes, and the old rows go,
// only when every row of it is expired or released; a take with no count anywhere writes nothing.

let rig: ClaimRig;
let a: ClaimStore;
let b: ClaimStore;
beforeAll(async () => {
  rig = await startClaimRig();
  a = rig.store();
  b = rig.store();
}, 180_000);
afterAll(async () => { await rig?.stop(); });
beforeEach(async () => { await rig.reset(); });

const A = me('a');
const B = me('b');
const take = (s: ClaimStore, who: typeof A, localCount: number | null) =>
  s.take({ me: who, capacity: 1, ttlMs: TIMINGS.ttlMs, boot: true, known: [], localCount, reserve: false });
const stored = async () => (await rig.direct.query(`SELECT value FROM smdb_data.meta WHERE key = 'shard_count'`)).rows[0]?.value ?? null;
const counts = async () => (await rig.direct.query(`SELECT DISTINCT shard_count FROM smdb_data.shard_claims ORDER BY shard_count`)).rows.map(r => r.shard_count);

async function aTakesUnder2() {
  await a.renew({ me: A, pairs: [], ttlMs: TIMINGS.ttlMs, heartbeat: heartbeat({ capacity: 1 }) });
  const got = await take(a, A, 2);
  expect(got.kind === 'done' && got.shardCount).toBe(2);
  expect(await stored()).toBe('{"count":2}');
}

describe('the stored shard count', () => {
  it('a second process with another local count runs under the stored one while a row is live and unreleased', async () => {
    await aTakesUnder2();
    await rig.direct.query(`UPDATE smdb_data.shard_claims SET released = true WHERE shard_id = 1`);
    const other = await take(b, B, 4);
    expect(other.kind === 'done' && other.shardCount).toBe(2);
    expect(await stored()).toBe('{"count":2}');
    expect(await counts()).toEqual([2]);
  });

  it('with every row expired a boot of another local count takes under the stored count (NB9 C1)', async () => {
    await aTakesUnder2();
    const exp = Math.max(...(await rig.direct.query(`SELECT expires_up_ms::bigint AS e FROM smdb_data.shard_claims`)).rows.map(r => Number(r.e)));
    await rig.direct.query(`UPDATE smdb_data.claim_clock SET up_ms = $1, ticked_at = now()`, [exp]);
    const changed = await take(b, B, 4);
    expect(changed.kind === 'done' && changed.shardCount).toBe(2);
    expect(await stored()).toBe('{"count":2}');
    expect(await counts()).toEqual([2]);
  });

  it('with every row released, kept for two different nodes and unexpired, the count stays (NB9 C1)', async () => {
    await aTakesUnder2();
    await rig.direct.query(`UPDATE smdb_data.shard_claims SET released = true, holder_node = CASE WHEN shard_id = 0 THEN 'n-a' ELSE 'n-z' END`);
    const changed = await take(b, B, 4);
    expect(changed.kind === 'done' && changed.shardCount).toBe(2);
    expect(await counts()).toEqual([2]);
  });

  it('with one row held unreleased and unexpired it does not', async () => {
    await aTakesUnder2();
    await rig.direct.query(`UPDATE smdb_data.shard_claims SET released = true WHERE shard_id = 0`);
    const kept = await take(b, B, 4);
    expect(kept.kind === 'done' && kept.shardCount).toBe(2);
    expect(await stored()).toBe('{"count":2}');
  });

  it('a take with no stored and no local count writes no count (no 1-shard fallback)', async () => {
    expect(await take(a, A, null)).toEqual({ kind: 'need-count' });
    expect(await stored()).toBeNull();
    expect(await counts()).toEqual([]);
  });
});
