import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { heartbeat, me, startClaimRig, TIMINGS, type ClaimRig } from '../helpers/pgClaimRig';
import type { ClaimStore } from '../../src/bot/internalSetup/fleet/claimStore';
import type { Pair } from '../../src/bot/internalSetup/fleet/claimRules';
import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';

// NB4 decisions 2, 8, 10 and 13: a takeover only at expiry, the old holder's save refused after it, the new holder
// reading the old one's last landed write; concurrent takes; the shard count in the database.

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
const take = (s: ClaimStore, who: typeof A, over: Record<string, unknown> = {}) =>
  s.take({ me: who, capacity: 4, ttlMs: TIMINGS.ttlMs, boot: false, known: [], localCount: 1, reserve: false, ...over });
const token = (who: typeof A, p: Pair): FenceToken => ({ nodeId: who.nodeId, claim: p.claim, processId: who.processId, shardId: p.shardId, shardCount: p.shardCount });
const batch = (doc: string) => ({ upserts: [{ key: { module: 'm', filename: 'x.json' }, doc }], deletes: [], appends: [] });

describe('a takeover', () => {
  it('B takes nothing 1 s before the expiry and takes at 1 s past; A\'s flush is then refused and B reads A\'s last landed write', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await renew(a, A);
    const got = await take(a, A, { boot: true });
    if (got.kind !== 'done') throw new Error('no take');
    const pa = got.taken[0].pair;
    await renew(a, A, [pa]);
    const guildId = String(1n << 22n);
    expect((await rig.backend.hydrateGuild(guildId, token(A, pa))).ok).toBe(true);
    expect(await rig.backend.flushGuild(guildId, batch('{"from":"a"}'), token(A, pa))).toEqual({ ok: true });
    const row = await rig.row(0);
    await rig.direct.query(`UPDATE smdb_data.claim_clock SET up_ms = $1, ticked_at = now()`, [Number(row.exp) - 1000]);
    expect((await take(b, B)).kind === 'done' && ((await take(b, B)) as any).taken).toEqual([]);
    await rig.direct.query(`UPDATE smdb_data.claim_clock SET up_ms = $1, ticked_at = now()`, [Number(row.exp) + 1000]);
    const bGot = await take(b, B);
    if (bGot.kind !== 'done') throw new Error('no take');
    expect(bGot.taken.map(t => t.pair.shardId)).toEqual([0]);
    const pb = bGot.taken[0].pair;
    expect(pb.claim).toBeGreaterThan(pa.claim);
    const after = await rig.row(0);
    expect(new Date(after.taken_at).getTime()).toBeGreaterThan(new Date(row.taken_at).getTime());
    expect(await rig.backend.flushGuild(guildId, batch('{"from":"a2"}'), token(A, pa))).toMatchObject({ ok: false, reason: 'deposed' });
    const hydrated = await rig.backend.hydrateGuild(guildId, token(B, pb));
    expect(hydrated).toMatchObject({ ok: true, docs: [{ doc: '{"from":"a"}' }] });
  });

  /**
   * The first tick after the write comes within G (no extension), so the stored expiry is the write's own: u' + TTL.
   * B ticks every R after that and tries a take after each tick; it may take only once the clock reached that expiry.
   */
  async function staleClockRun(write: () => Promise<void>, gapBeforeMs: number) {
    await renew(b, B);
    await rig.idle(gapBeforeMs);
    const upBefore = (await rig.clock()).upMs;
    await write();
    const exp = Number((await rig.row(0)).exp);
    expect(exp).toBeGreaterThanOrEqual(upBefore + Math.min(gapBeforeMs, 7500) + TIMINGS.ttlMs);
    expect(exp).toBeLessThan(upBefore + Math.min(gapBeforeMs, 7500) + TIMINGS.ttlMs + 1000);
    await rig.idle(Math.max(0, 7000 - gapBeforeMs));
    await renew(b, B);
    expect((await rig.clock()).lastGapMs).toBeLessThan(7500);
    let takenAt: number | null = null;
    let triedBefore = 0;
    for (let i = 0; i < 12 && takenAt === null; i++) {
      expect(Number((await rig.row(0)).exp)).toBe(exp);
      const up = (await rig.clock()).upMs;
      const got = await take(b, B);
      if (got.kind === 'done' && got.taken.some(t => t.pair.shardId === 0)) takenAt = up;
      else if (up >= upBefore + TIMINGS.ttlMs && up < exp) triedBefore += 1;
      if (takenAt === null) {
        await rig.idle(TIMINGS.renewMs);
        await renew(b, B);
      }
    }
    expect(takenAt).not.toBeNull();
    expect(takenAt!).toBeGreaterThanOrEqual(exp);
    expect(takenAt!).toBeLessThan(exp + TIMINGS.renewMs + 1000);
    expect(triedBefore).toBeGreaterThan(0);
  }

  it.each([6000, TIMINGS.renewMs + TIMINGS.statementMs])('a stale clock (ticked_at %i ms back): a take\'s expiry is u\' + TTL, and B takes only at it', async gap => {
    await staleClockRun(async () => {
      const got = await take(a, A, { boot: true });
      if (got.kind !== 'done' || got.taken.length === 0) throw new Error('no take');
    }, gap);
  });

  const dbNow = async () => new Date((await rig.direct.query(`SELECT clock_timestamp() AS t`)).rows[0].t).getTime();

  it('the same for a reservation, which sets taken_at to its transaction\'s time', async () => {
    await staleClockRun(async () => {
      const startedAt = await dbNow();
      const got = await take(a, A, { reserve: true });
      const endedAt = await dbNow();
      if (got.kind !== 'done' || got.taken.length === 0) throw new Error('no reservation');
      const row = await rig.row(0);
      expect(row).toMatchObject({ holder_process: A.processId, released: true, reserved: true });
      const takenAt = new Date(row.taken_at).getTime();
      expect(takenAt).toBeGreaterThanOrEqual(startedAt);
      expect(takenAt).toBeLessThanOrEqual(endedAt);
    }, 6000);
  });

  it('a reservation over an expired row of another process moves taken_at from that row\'s take to its own', async () => {
    await renew(b, B);
    const first = await take(b, B, { boot: true });
    if (first.kind !== 'done' || first.taken.length === 0) throw new Error('no take');
    const before = await rig.row(0);
    await rig.direct.query(`UPDATE smdb_data.claim_clock SET up_ms = $1, ticked_at = now()`, [Number(before.exp) + 1000]);
    await renew(a, A);
    const startedAt = await dbNow();
    const got = await take(a, A, { reserve: true });
    const endedAt = await dbNow();
    if (got.kind !== 'done') throw new Error('no reservation');
    expect(got.taken.map(t => t.pair.shardId)).toEqual([0]);
    const after = await rig.row(0);
    expect(after).toMatchObject({ holder_process: A.processId, released: true, reserved: true });
    expect(Number(after.claim_text)).toBe(got.taken[0].pair.claim);
    const takenAt = new Date(after.taken_at).getTime();
    expect(takenAt).toBeGreaterThan(new Date(before.taken_at).getTime());
    expect(takenAt).toBeGreaterThanOrEqual(startedAt);
    expect(takenAt).toBeLessThanOrEqual(endedAt);
  });

  it('the same for the release\'s kept row', async () => {
    const got = await take(a, A, { boot: true });
    if (got.kind !== 'done' || got.taken.length === 0) throw new Error('no take');
    await staleClockRun(async () => {
      const rows = await a.release({ me: A, reserved: [], handOvers: [], ttlMs: TIMINGS.ttlMs });
      expect(rows.map(r => r.shardId)).toEqual([0]);
    }, 6000);
  });
});

describe('concurrent takes and lost replies', () => {
  it('two takes in parallel get disjoint shards and distinct claims above every stored claim, and together cover every shard', async () => {
    await a.renew({ me: A, pairs: [], ttlMs: TIMINGS.ttlMs, heartbeat: heartbeat({ capacity: 2 }) });
    await b.renew({ me: B, pairs: [], ttlMs: TIMINGS.ttlMs, heartbeat: heartbeat({ capacity: 2 }) });
    await rig.direct.query(`SELECT setval('smdb_data.claim_seq', 3)`);
    await rig.direct.query(`INSERT INTO smdb_data.guild_ownership (guild_id, node_id, shard_id, claim, shard_count) VALUES ('77', 'n', 0, 100, 1) ON CONFLICT (guild_id) DO UPDATE SET claim = 100`);
    await rig.direct.query(`INSERT INTO smdb_data.shard_claims (shard_count, shard_id, claim, holder_process, holder_node, holder_name, home_node, ttl_ms, expires_up_ms) VALUES (4, 3, 120, 'p-x', 'n-x', 'X', 'n-x', 30000, 0)`);
    await rig.direct.query(`INSERT INTO smdb_data.meta (key, value) VALUES ('shard_count', '{"count":4}')`);
    const [x, y] = await Promise.all([
      take(a, A, { capacity: 2, localCount: 4 }),
      take(b, B, { capacity: 2, localCount: 4 }),
    ]);
    if (x.kind !== 'done' || y.kind !== 'done') throw new Error('no take');
    const all = [...x.taken, ...y.taken].map(t => t.pair);
    expect(new Set(all.map(p => p.shardId)).size).toBe(all.length);
    expect(new Set(all.map(p => p.claim)).size).toBe(all.length);
    for (const p of all) expect(p.claim).toBeGreaterThan(120);
    expect(x.taken).toHaveLength(2);
    expect(y.taken).toHaveLength(2);
    expect(all.map(p => p.shardId).sort()).toEqual([0, 1, 2, 3]);
    const stored = (await rig.direct.query(`SELECT shard_id, claim::text AS claim, holder_process FROM smdb_data.shard_claims WHERE shard_count = 4 ORDER BY shard_id`)).rows;
    const reported = [...x.taken.map(t => ({ p: t.pair, who: A })), ...y.taken.map(t => ({ p: t.pair, who: B }))]
      .sort((l, r) => l.p.shardId - r.p.shardId)
      .map(({ p, who }) => ({ shard_id: p.shardId, claim: String(p.claim), holder_process: who.processId }));
    expect(stored).toEqual(reported);
    const seq = Number((await rig.direct.query(`SELECT last_value::text AS v FROM smdb_data.claim_seq`)).rows[0].v);
    expect(seq).toBeGreaterThanOrEqual(Math.max(...all.map(p => p.claim)));
  });

  it('a take whose reply was lost is taken again under new claims by the same process; another node\'s row stays byte-identical', async () => {
    const x = rig.store();
    const X = me('x');
    await renew(x, X);
    await rig.direct.query(`INSERT INTO smdb_data.meta (key, value) VALUES ('shard_count', '{"count":3}')`);
    await rig.direct.query(`INSERT INTO smdb_data.shard_claims (shard_count, shard_id, claim, holder_process, holder_node, holder_name, home_node, taken_at, renewed_at, ttl_ms, expires_up_ms)
      VALUES (3, 2, 999, 'p-x', 'n-x', 'X', 'n-x', now() - interval '1 minute', now() - interval '2 seconds', 30000, 999999999)`);
    const snapshot = async () => JSON.stringify((await rig.direct.query(`SELECT * FROM smdb_data.shard_claims WHERE shard_count = 3 AND shard_id = 2`)).rows);
    const before = await snapshot();
    await renew(a, A);
    const first = await take(a, A, { boot: true, capacity: 2, localCount: 3 });
    if (first.kind !== 'done') throw new Error('no take');
    expect(first.taken.map(t => t.pair.shardId)).toEqual([0, 1]);
    const again = await take(a, A, { boot: true, capacity: 2, localCount: 3 });
    if (again.kind !== 'done') throw new Error('no take');
    expect(again.taken.map(t => t.pair.shardId)).toEqual([0, 1]);
    for (let i = 0; i < again.taken.length; i++) expect(again.taken[i].pair.claim).toBeGreaterThan(Math.max(...first.taken.map(t => t.pair.claim)));
    for (const t of again.taken) expect((await rig.row(t.pair.shardId, 3)).claim_text).toBe(String(t.pair.claim));
    expect(await snapshot()).toBe(before);
  });
});

describe('the shard count in the database', () => {
  it('the first take writes it; another local count runs under it while a row is live; it changes once every row is expired or released', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await renew(a, A);
    const first = await take(a, A, { boot: true, localCount: 2, capacity: 1 });
    expect(first.kind === 'done' && first.shardCount).toBe(2);
    expect((await rig.direct.query(`SELECT value FROM smdb_data.meta WHERE key = 'shard_count'`)).rows[0].value).toBe('{"count":2}');
    const other = await take(b, B, { boot: true, localCount: 4, capacity: 1 });
    expect(other.kind === 'done' && other.shardCount).toBe(2);
    await rig.direct.query(`UPDATE smdb_data.shard_claims SET released = true WHERE holder_node = 'n-a'`);
    await rig.direct.query(`UPDATE smdb_data.shard_claims SET released = true, holder_node = 'n-z' WHERE holder_node = 'n-b'`);
    const changed = await take(b, B, { boot: true, localCount: 4, capacity: 1 });
    expect(changed.kind === 'done' && changed.shardCount).toBe(2);
    expect((await rig.direct.query(`SELECT value FROM smdb_data.meta WHERE key = 'shard_count'`)).rows[0].value).toBe('{"count":2}');
    log.mockRestore();
  });

  it('with no stored count and no local count the take answers need-count and writes nothing', async () => {
    expect(await take(a, A, { boot: true, localCount: null })).toEqual({ kind: 'need-count' });
    expect((await rig.direct.query(`SELECT 1 FROM smdb_data.meta WHERE key = 'shard_count'`)).rowCount).toBe(0);
  });
});
