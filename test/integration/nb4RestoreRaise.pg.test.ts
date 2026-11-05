import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { heartbeat, me, startClaimRig, TIMINGS, type ClaimRig } from '../helpers/pgClaimRig';
import { RESTORE_FLOOR_SQL, RESTORE_RAISE_SQL } from '../helpers/restoreRaise';
import type { ClaimStore } from '../../src/bot/internalSetup/fleet/claimStore';
import type { Pair } from '../../src/bot/internalSetup/fleet/claimRules';
import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';

// NB4 decision 23: after a restore, every restored claim gets a number above the floor and an expiry at or below the
// restored clock, so a process from before the restore renews nothing and saves nothing, and the first tick (late, after
// a gap above G) leaves the restored rows expired, free to any machine.

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
const renew = (s: ClaimStore, who: typeof A, pairs: Pair[] = []) => s.renew({ me: who, pairs, ttlMs: TIMINGS.ttlMs, heartbeat: heartbeat() });
const token = (p: Pair): FenceToken => ({ nodeId: A.nodeId, claim: p.claim, processId: A.processId, shardId: p.shardId, shardCount: p.shardCount });
const batch = (doc: string) => ({ upserts: [{ key: { module: 'm', filename: 'x.json' }, doc }], deletes: [], appends: [] });

describe("NM9's restore raise on live, unexpired claims", () => {
  it('renumbers above the floor, caps the expiry, keeps holders; the late first tick leaves the rows expired; the old process renews and saves nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await renew(a, A);
    const got = await a.take({ me: A, capacity: 4, ttlMs: TIMINGS.ttlMs, boot: true, known: [], localCount: 2, reserve: false });
    if (got.kind !== 'done') throw new Error('no take');
    const pairs = got.taken.map(t => t.pair);
    await renew(a, A, pairs);
    const guildId = String(2n << 22n);
    const onShard = pairs.find(p => p.shardId === 0)!;
    expect((await rig.backend.hydrateGuild(guildId, token(onShard))).ok).toBe(true);
    expect(await rig.backend.flushGuild(guildId, batch('{"v":1}'), token(onShard))).toEqual({ ok: true });
    const clockBefore = await rig.clock();
    for (const p of pairs) expect(Number((await rig.row(p.shardId)).exp)).toBeGreaterThan(clockBefore.upMs);

    const floor = Number((await rig.direct.query(RESTORE_FLOOR_SQL)).rows[0].floor);
    await rig.direct.query(RESTORE_RAISE_SQL, [floor]);

    const rows = (await rig.direct.query(`SELECT shard_id, claim::text AS claim, expires_up_ms::text AS exp, holder_process, holder_node, home_node, released FROM smdb_data.shard_claims ORDER BY shard_id`)).rows;
    const claims = rows.map(r => Number(r.claim));
    expect(new Set(claims).size).toBe(claims.length);
    for (const c of claims) expect(c).toBeGreaterThan(floor);
    for (const r of rows) {
      expect(Number(r.exp)).toBeLessThanOrEqual(clockBefore.upMs);
      expect(r.holder_process).toBe(A.processId);
      expect(r.holder_node).toBe(A.nodeId);
      expect(r.released).toBe(false);
    }
    const seq = (await rig.direct.query(`SELECT last_value::text AS v FROM smdb_data.claim_seq`)).rows[0];
    expect(Number(seq.v)).toBeGreaterThanOrEqual(Math.max(...claims));

    await rig.idle(60_000);
    await renew(b, B);
    expect((await rig.clock()).lastGapMs).toBeGreaterThan(7500);
    const clockAfter = await rig.clock();
    for (const p of pairs) {
      const row = await rig.row(p.shardId);
      expect(row.extended).toBe(false);
      expect(Number(row.exp)).toBeLessThanOrEqual(clockAfter.upMs);
    }

    const back = await renew(a, A, pairs);
    expect(back.rows.filter(r => r.mine)).toEqual([]);
    expect(await rig.backend.flushGuild(guildId, batch('{"v":2}'), token(onShard))).toMatchObject({ ok: false, reason: 'deposed' });

    const bGot = await b.take({ me: B, capacity: 4, ttlMs: TIMINGS.ttlMs, boot: false, known: [], localCount: 2, reserve: true });
    expect(bGot.kind === 'done' && bGot.taken.map(t => t.pair.shardId).sort()).toEqual([0, 1]);
    for (const t of bGot.kind === 'done' ? bGot.taken : []) expect(t.pair.claim).toBeGreaterThan(Math.max(...claims));
    const doc = (await rig.direct.query(`SELECT doc FROM smdb_data.guild_data WHERE guild_id = $1`, [guildId])).rows;
    expect(doc).toEqual([{ doc: '{"v":1}' }]);
  });
});
