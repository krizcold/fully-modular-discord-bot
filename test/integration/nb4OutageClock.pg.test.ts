import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { heartbeat, me, startClaimRig, TIMINGS, type ClaimRig } from '../helpers/pgClaimRig';
import type { ClaimStore } from '../../src/bot/internalSetup/fleet/claimStore';
import { applyRenewal, type ClaimRow, type Pair } from '../../src/bot/internalSetup/fleet/claimRules';
import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';

// NB4 decision 4 and invariant 3b: the claim clock runs only with ticks, by at most 7.5 s per tick; the first tick after
// a gap gives every claim live before it its whole TTL again, once until its holder writes it; expired rows stay expired.

let rig: ClaimRig;
let a: ClaimStore;
let b: ClaimStore;
let c: ClaimStore;
beforeAll(async () => {
  rig = await startClaimRig();
  a = rig.store();
  b = rig.store();
  c = rig.store();
}, 180_000);
afterAll(async () => { await rig?.stop(); });
beforeEach(async () => { await rig.reset(); });

const A = me('a');
const B = me('b');
const C = me('c');
const snapshot = async () => {
  const rows: ClaimRow[] = (await rig.direct.query(`SELECT shard_count, shard_id, claim::text AS claim, holder_process, holder_node, holder_name,
      home_node, released, reserved, ttl_ms::text AS ttl, expires_up_ms::text AS exp, extended FROM smdb_data.shard_claims ORDER BY shard_count, shard_id`)).rows
    .map(r => ({
      shardCount: r.shard_count, shardId: r.shard_id, claim: Number(r.claim), holderProcess: r.holder_process, holderNode: r.holder_node,
      holderName: r.holder_name, homeNode: r.home_node, released: r.released, reserved: r.reserved, takenAt: 0, renewedAt: 0,
      ttlMs: Number(r.ttl), expiresUpMs: Number(r.exp), extended: r.extended,
    }));
  const c = (await rig.direct.query(`SELECT up_ms::text AS up, last_gap_ms::text AS gap, (extract(epoch FROM ticked_at) * 1000)::float8 AS at FROM smdb_data.claim_clock`)).rows[0];
  return { rows, clock: { upMs: Number(c.up), lastGapMs: Number(c.gap), tickedAt: Number(c.at) } };
};
const judged = (rows: ClaimRow[]) => rows.map(r => ({ shard: `${r.shardCount}:${r.shardId}`, claim: r.claim, exp: r.expiresUpMs, extended: r.extended, ttl: r.ttlMs }));

/** Every renewal here is also run through applyRenewal, the rule MemClaimStore and the property model use, on the rows as they stood. */
async function renew(s: ClaimStore, who: typeof A, pairs: Pair[] = []) {
  const before = await snapshot();
  const answer = await s.renew({ me: who, pairs, ttlMs: TIMINGS.ttlMs, heartbeat: heartbeat() });
  const after = await snapshot();
  expect(Math.abs(answer.at - before.clock.tickedAt - after.clock.lastGapMs)).toBeLessThanOrEqual(1);
  const model = applyRenewal(before.rows, { upMs: before.clock.upMs, tickedAt: 0, lastGapMs: before.clock.lastGapMs }, after.clock.lastGapMs, who.processId, pairs, TIMINGS.ttlMs);
  expect(after.clock.upMs).toBe(model.clock.upMs);
  expect(judged(after.rows)).toEqual(judged(before.rows));
  expect(answer.rows.map(r => `${r.shardCount}:${r.shardId}:${r.mine}`).sort()).toEqual(model.returned.map(r => `${r.row.shardCount}:${r.row.shardId}:${r.mine}`).sort());
  return answer;
}

const G0 = String(4n << 22n);
const tokenOf = (p: Pair): FenceToken => ({ nodeId: A.nodeId, claim: p.claim, processId: A.processId, shardId: p.shardId, shardCount: p.shardCount });
const batch = (doc: string) => ({ upserts: [{ key: { module: 'm', filename: 'x.json' }, doc }], deletes: [], appends: [] });
const stored = async (guildId: string) => (await rig.direct.query(`SELECT doc FROM smdb_data.guild_data WHERE guild_id = $1`, [guildId])).rows;

async function aHoldsEverything(): Promise<Pair[]> {
  await renew(a, A);
  const taken = await a.take({ me: A, capacity: 4, ttlMs: TIMINGS.ttlMs, boot: true, known: [], localCount: 2, reserve: false });
  if (taken.kind !== 'done') throw new Error('no take');
  return taken.taken.map(t => t.pair);
}

describe('an outage for every process', () => {
  it('moves no shard: after 3 x TTL with no tick, B ticks first, every claim gets clock + TTL, B takes nothing, A renews every pair', async () => {
    const pairs = await aHoldsEverything();
    await renew(a, A, pairs);
    await rig.idle(3 * TIMINGS.ttlMs);
    await renew(b, B);
    const clock = await rig.clock();
    for (const p of pairs) {
      const row = await rig.row(p.shardId);
      expect(Number(row.exp)).toBeGreaterThanOrEqual(clock.upMs + TIMINGS.ttlMs);
      expect(row.extended).toBe(true);
    }
    const bTake = await b.take({ me: B, capacity: 4, ttlMs: TIMINGS.ttlMs, boot: false, known: [], localCount: 2, reserve: true });
    expect(bTake.kind === 'done' && bTake.taken).toEqual([]);
    await rig.idle(2 * TIMINGS.renewMs);
    const back = await renew(a, A, pairs);
    expect(back.rows.filter(r => r.mine && !r.released).map(r => r.shardId).sort()).toEqual(pairs.map(p => p.shardId).sort());
  });

  it("A's write kept through the outage lands at its first renewal after it", async () => {
    const pairs = await aHoldsEverything();
    await renew(a, A, pairs);
    const shard0 = pairs.find(p => p.shardId === 0)!;
    expect((await rig.backend.hydrateGuild(G0, tokenOf(shard0))).ok).toBe(true);
    expect(await rig.backend.flushGuild(G0, batch('{"v":1}'), tokenOf(shard0))).toEqual({ ok: true });
    await rig.idle(3 * TIMINGS.ttlMs);
    await renew(b, B);
    const bTake = await b.take({ me: B, capacity: 4, ttlMs: TIMINGS.ttlMs, boot: false, known: [], localCount: 2, reserve: true });
    expect(bTake.kind === 'done' && bTake.taken).toEqual([]);
    await rig.idle(2 * TIMINGS.renewMs);
    await renew(b, B);
    await renew(a, A, pairs);
    expect(await rig.backend.flushGuild(G0, batch('{"v":2}'), tokenOf(shard0))).toEqual({ ok: true });
    expect(await stored(G0)).toEqual([{ doc: '{"v":2}' }]);
  });

  it('a reader before the first tick sees the clock as it stood: with A within G of its expiry, C\'s boot take after a long gap takes nothing', async () => {
    const pairs = await aHoldsEverything();
    await rig.direct.query(`UPDATE smdb_data.shard_claims SET home_node = 'n-c'`);
    await renew(a, A, pairs);
    // B ticks every R while A's renewals do not arrive, until A's rows are less than G of clock from their expiry.
    for (let i = 0; i < 10; i++) {
      const row = await rig.row(pairs[0].shardId);
      if (Number(row.exp) - (await rig.clock()).upMs < 7500) break;
      await rig.idle(TIMINGS.renewMs);
      await renew(b, B);
    }
    const left = Number((await rig.row(pairs[0].shardId)).exp) - (await rig.clock()).upMs;
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(7500);
    await rig.idle(3600_000);
    const take = await c.take({ me: C, capacity: 4, ttlMs: TIMINGS.ttlMs, boot: true, known: [], localCount: 2, reserve: false });
    expect(take.kind === 'done' && take.taken).toEqual([]);
    for (const p of pairs) {
      const row = await rig.row(p.shardId);
      expect(row.claim_text).toBe(String(p.claim));
      expect(row.holder_process).toBe(A.processId);
    }
    await rig.idle(3600_000);
    const again = await c.take({ me: C, capacity: 4, ttlMs: TIMINGS.ttlMs, boot: true, known: [], localCount: 2, reserve: false });
    expect(again.kind === 'done' && again.taken).toEqual([]);
    await renew(c, C);
    const clock = await rig.clock();
    for (const p of pairs) {
      const row = await rig.row(p.shardId);
      expect(row.extended).toBe(true);
      expect(Number(row.exp)).toBeGreaterThanOrEqual(clock.upMs + TIMINGS.ttlMs);
    }
    const third = await c.take({ me: C, capacity: 4, ttlMs: TIMINGS.ttlMs, boot: true, known: [], localCount: 2, reserve: false });
    expect(third.kind === 'done' && third.taken).toEqual([]);
    const back = await renew(a, A, pairs);
    expect(back.rows.filter(r => r.mine && !r.released).map(r => r.shardId).sort()).toEqual(pairs.map(p => p.shardId).sort());
  });

  it('a row already expired before the gap is not extended and stays takeable', async () => {
    const pairs = await aHoldsEverything();
    await rig.direct.query(`UPDATE smdb_data.shard_claims SET expires_up_ms = 0 WHERE shard_id = $1`, [pairs[0].shardId]);
    await rig.direct.query(`UPDATE smdb_data.claim_clock SET up_ms = 1000`);
    await rig.idle(60_000);
    await renew(b, B);
    const row = await rig.row(pairs[0].shardId);
    expect(row.extended).toBe(false);
    expect(Number(row.exp)).toBe(0);
    const bTake = await b.take({ me: B, capacity: 4, ttlMs: TIMINGS.ttlMs, boot: false, known: [], localCount: 2, reserve: true });
    expect(bTake.kind === 'done' && bTake.taken.map(t => t.pair.shardId)).toEqual([pairs[0].shardId]);
  });
});

describe('the clock', () => {
  it('advances at most 7.5 s in one tick, also after ticked_at is set an hour back', async () => {
    await renew(b, B);
    const before = await rig.clock();
    await rig.idle(3600_000);
    await renew(b, B);
    const after = await rig.clock();
    expect(after.upMs - before.upMs).toBe(7500);
    expect(after.lastGapMs).toBeGreaterThanOrEqual(3600_000);
  });

  it('ticks every R extend nothing', async () => {
    const pairs = await aHoldsEverything();
    await renew(a, A, pairs);
    for (let i = 0; i < 3; i++) {
      await rig.idle(TIMINGS.renewMs);
      await renew(b, B);
    }
    for (const p of pairs) expect((await rig.row(p.shardId)).extended).toBe(false);
  });

  it('one ticker\'s misses extend a cut-off holder once; the holder\'s renewal clears the mark and the next gap extends again', async () => {
    const pairs = await aHoldsEverything();
    await renew(a, A, pairs);
    await rig.idle(0.6 * TIMINGS.ttlMs);
    await renew(b, B);
    const first = Number((await rig.row(pairs[0].shardId)).exp);
    expect((await rig.row(pairs[0].shardId)).extended).toBe(true);
    await rig.idle(0.6 * TIMINGS.ttlMs);
    await renew(b, B);
    expect(Number((await rig.row(pairs[0].shardId)).exp)).toBe(first);
    await renew(a, A, pairs);
    expect((await rig.row(pairs[0].shardId)).extended).toBe(false);
    await rig.idle(0.6 * TIMINGS.ttlMs);
    await renew(b, B);
    expect((await rig.row(pairs[0].shardId)).extended).toBe(true);
  });
});

describe('a holder cut off while another process ticks', () => {
  it('B takes after TTL of clock time and not before', async () => {
    const pairs = await aHoldsEverything();
    await renew(a, A, pairs);
    const take = () => b.take({ me: B, capacity: 4, ttlMs: TIMINGS.ttlMs, boot: false, known: [], localCount: 2, reserve: true });
    for (let t = 0; t < TIMINGS.ttlMs - TIMINGS.renewMs; t += TIMINGS.renewMs) {
      await rig.idle(TIMINGS.renewMs);
      await renew(b, B);
      const got = await take();
      expect(got.kind === 'done' && got.taken).toEqual([]);
    }
    await rig.idle(TIMINGS.renewMs);
    await renew(b, B);
    await rig.idle(TIMINGS.renewMs);
    await renew(b, B);
    const got = await take();
    expect(got.kind === 'done' && got.taken.length).toBe(pairs.length);
  });

  it("A's flush after B's take is refused deposed, logged with the guild, and its write is not stored", async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pairs = await aHoldsEverything();
    await renew(a, A, pairs);
    const shard0 = pairs.find(p => p.shardId === 0)!;
    expect((await rig.backend.hydrateGuild(G0, tokenOf(shard0))).ok).toBe(true);
    expect(await rig.backend.flushGuild(G0, batch('{"v":1}'), tokenOf(shard0))).toEqual({ ok: true });
    let taken: number[] = [];
    for (let i = 0; i < 12 && taken.length === 0; i++) {
      await rig.idle(TIMINGS.renewMs);
      await renew(b, B);
      const got = await b.take({ me: B, capacity: 4, ttlMs: TIMINGS.ttlMs, boot: false, known: [], localCount: 2, reserve: true });
      taken = got.kind === 'done' ? got.taken.map(t => t.pair.shardId) : [];
    }
    expect(taken).toContain(0);
    expect(await rig.backend.flushGuild(G0, batch('{"v":2}'), tokenOf(shard0))).toMatchObject({ ok: false, reason: 'deposed' });
    expect(errors.mock.calls.map(c => String(c[0])).some(l => l.startsWith('[PostgresBackend] Flush rejected: deposed') && l.includes(G0))).toBe(true);
    expect(await stored(G0)).toEqual([{ doc: '{"v":1}' }]);
    errors.mockRestore();
  });

  it("one ticker's misses: B takes A's rows within 2 x TTL + 2R of A's last renewal", async () => {
    const pairs = await aHoldsEverything();
    await renew(a, A, pairs);
    let elapsed = 0;
    let taken: number[] = [];
    let extensions = 0;
    for (let step = 1; step <= 40 && taken.length < pairs.length; step++) {
      await rig.idle(TIMINGS.renewMs);
      elapsed += TIMINGS.renewMs;
      // B's renewal fails about once every 0.6 x TTL, so its next tick finds a gap above G.
      if (step % 4 === 0) continue;
      const wasExtended = (await rig.row(pairs[0].shardId)).extended;
      await renew(b, B);
      if (!wasExtended && (await rig.row(pairs[0].shardId)).extended) extensions += 1;
      const got = await b.take({ me: B, capacity: 4, ttlMs: TIMINGS.ttlMs, boot: false, known: [], localCount: 2, reserve: true });
      if (got.kind === 'done') taken = taken.concat(got.taken.map(t => t.pair.shardId));
    }
    expect(taken.sort()).toEqual(pairs.map(p => p.shardId).sort());
    expect(extensions).toBe(1);
    expect(elapsed).toBeGreaterThan(TIMINGS.ttlMs);
    expect(elapsed).toBeLessThanOrEqual(2 * TIMINGS.ttlMs + 2 * TIMINGS.renewMs);
  });
});
