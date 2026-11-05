import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { heartbeat, me, startClaimRig, TIMINGS, type ClaimRig } from '../helpers/pgClaimRig';
import { ClaimStore, classifyFailure } from '../../src/bot/internalSetup/fleet/claimStore';
import type { Pair } from '../../src/bot/internalSetup/fleet/claimRules';
import { ShardClaims } from '../../src/bot/internalSetup/fleet/shardClaims';
import { stopSteps } from '../helpers/stopRig';
import type { FenceToken } from '../../src/bot/internalSetup/utils/dataBackends/backend';

// NB4 decision 22 on real Postgres: a role at NOLOGIN with its sessions ended refuses every renewal with 28000, which
// reaches the login-refused listener; no process ticks, so no claim expires. With one process's role refused and the
// other's not, the other takes after TTL, and the refused process finds the loss at the login's return and its kept
// write is refused 'deposed'.

let rig: ClaimRig;
const extra: ClaimStore[] = [];
beforeAll(async () => {
  rig = await startClaimRig();
  for (const role of ['smdb_role_a', 'smdb_role_b']) {
    await rig.direct.query(`CREATE ROLE ${role} LOGIN PASSWORD 'pw'`);
    await rig.direct.query(`GRANT USAGE ON SCHEMA smdb_data TO ${role}`);
    await rig.direct.query(`GRANT ALL ON ALL TABLES IN SCHEMA smdb_data TO ${role}`);
    await rig.direct.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA smdb_data TO ${role}`);
  }
}, 180_000);
afterAll(async () => {
  for (const s of extra) await s.end();
  await rig?.stop();
});
beforeEach(async () => {
  await rig.reset();
  for (const role of ['smdb_role_a', 'smdb_role_b']) await rig.direct.query(`ALTER ROLE ${role} LOGIN`);
});

const A = me('a');
const B = me('b');
const urlFor = (role: string) => `postgres://${role}:pw@${rig.container.getHost()}:${rig.container.getPort()}/${rig.container.getDatabase()}`;
function storeAs(role: string, onRefused: () => void): ClaimStore {
  const s = new ClaimStore(urlFor(role), TIMINGS, onRefused);
  extra.push(s);
  return s;
}
async function refuse(role: string) {
  await rig.direct.query(`ALTER ROLE ${role} NOLOGIN`);
  await rig.direct.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1`, [role]);
}
const renew = (s: ClaimStore, who: typeof A, pairs: Pair[] = []) => s.renew({ me: who, pairs, ttlMs: TIMINGS.ttlMs, heartbeat: heartbeat() });
const token = (p: Pair): FenceToken => ({ nodeId: A.nodeId, claim: p.claim, processId: A.processId, shardId: p.shardId, shardCount: p.shardCount });

describe('a boot whose login is refused before its first renewal (sheet [pg] 12, R2-CAP-TAUT)', () => {
  it('its leave ends with no IPC before the take and reaches the real stop handler, which exits once; the login returns: no take is sent, the boot grants nothing, and no row ever names its process', async () => {
    const timings = { ...TIMINGS, renewMs: 1000 };
    const counts: number[] = [];
    const poll = async () => {
      counts.push((await rig.direct.query(`SELECT count(*)::int AS n FROM smdb_data.shard_claims WHERE holder_process = 'p-b'`)).rows[0].n);
    };
    const realSend = process.send;
    (process as { send?: unknown }).send = undefined;
    vi.resetModules();
    const m = await import('../../src/bot/internalSetup/utils/maintenance');
    const dm = await import('../../src/bot/internalSetup/utils/dataManager');
    const gate = await import('../../src/bot/internalSetup/utils/maintenanceGate');
    const { getWorkingSet } = await import('../../src/bot/internalSetup/utils/dataBackends/workingSet');
    const exit = vi.spyOn(process, 'exit').mockImplementation(((() => undefined) as unknown) as typeof process.exit);
    const lines: string[] = [];
    const capture = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    vi.spyOn(console, 'log').mockImplementation(capture);
    vi.spyOn(console, 'warn').mockImplementation(capture);
    vi.spyOn(console, 'error').mockImplementation(capture);
    try {
      m._setMaintenanceTiming({ leaveRetryMs: 500, filePollMs: 600_000, leaveSaveBoundMs: 2000 });
      let fire: () => void = () => undefined;
      m.watchDataBackend({ onLoginRefused: cb => { fire = cb; }, askDatabase: async () => 'refused' as const }, { retryMs: 600_000 });
      const a = rig.store();
      await renew(a, A);
      await refuse('smdb_role_b');
      let refused = 0;
      const b = storeAs('smdb_role_b', () => { refused += 1; fire(); });
      const take = vi.spyOn(b, 'take');
      const claims = new ShardClaims({
        store: b, me: B, timings, capacity: 4, takeoverSeconds: 30, returns: true, restartable: m.canRestart(), startedAt: Date.now(),
        fitness: m.maintenanceUnfit, gateClosed: gate.isMaintenanceGateClosed, isStopping: dm.isStopping,
        stopServingStep: () => undefined, noteLapsed: m.noteClaimsLapsed, noteLost: () => undefined,
        restartForShards: reason => m.restartForShards(reason, m.maintenanceUnfit),
        log: { log: capture, warn: capture, error: capture },
      });
      dm.stopHandler(stopSteps({ claims: () => claims, drainForExit: dm.drainForExit, hasWorkingSet: () => getWorkingSet() !== null }));
      claims.start();
      const first = claims.firstRenewal();
      const got = await a.take({ me: A, capacity: 4, ttlMs: TIMINGS.ttlMs, boot: true, known: [], localCount: 2, reserve: false });
      expect(got.kind).toBe('done');
      await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1), { timeout: 20_000, interval: 100 });
      expect(exit.mock.calls).toEqual([[0]]);
      expect(refused).toBeGreaterThanOrEqual(1);
      expect(gate.maintenanceCause()).toBe('login-refused');
      expect(lines).toContain('[Maintenance] The database refused the login (SQLSTATE 28000) while the bot process booted; saving what this process holds before it stops (no web UI process runs to restart it)');
      expect(lines.some(l => l.includes('A stop step failed'))).toBe(false);
      expect(lines.some(l => l.startsWith('[Shards] Released shards'))).toBe(false);
      expect(await first).toBe(false);
      expect(await claims.bootTake(async () => 2)).toBeNull();
      await poll();
      await rig.direct.query(`ALTER ROLE smdb_role_b LOGIN`);
      for (let i = 0; i < 6; i++) {
        await new Promise(resolve => { setTimeout(resolve, timings.renewMs); });
        await poll();
      }
      expect(take).not.toHaveBeenCalled();
      expect(counts.length).toBeGreaterThanOrEqual(7);
      expect(counts.every(n => n === 0)).toBe(true);
      expect((await rig.direct.query(`SELECT count(*)::int AS n FROM smdb_data.shard_nodes WHERE process_id = 'p-b'`)).rows[0].n).toBe(0);
      expect(claims.heldPairs()).toEqual([]);
      expect(exit).toHaveBeenCalledTimes(1);
    } finally {
      m._resetMaintenance();
      (process as { send?: unknown }).send = realSend;
      vi.restoreAllMocks();
    }
  });
});

describe('maintenance by NOLOGIN', () => {
  it('every process refused: renewals fail with 28000 and reach the listener; the clock does not move, so nothing expires; the login returns and A keeps its pairs', async () => {
    let refusedA = 0;
    let refusedB = 0;
    const a = storeAs('smdb_role_a', () => { refusedA += 1; });
    const b = storeAs('smdb_role_b', () => { refusedB += 1; });
    await renew(a, A);
    const got = await a.take({ me: A, capacity: 4, ttlMs: TIMINGS.ttlMs, boot: true, known: [], localCount: 2, reserve: false });
    if (got.kind !== 'done') throw new Error('no take');
    const pairs = got.taken.map(t => t.pair);
    await renew(a, A, pairs);
    await renew(b, B);
    const upBefore = (await rig.clock()).upMs;
    await refuse('smdb_role_a');
    await refuse('smdb_role_b');
    for (const [s, who] of [[a, A], [b, B]] as const) {
      const failure = await renew(s, who, s === a ? pairs : []).then(() => null, e => classifyFailure(e));
      expect(failure).toEqual({ kind: 'refused' });
    }
    expect(refusedA).toBeGreaterThanOrEqual(1);
    expect(refusedB).toBeGreaterThanOrEqual(1);
    await rig.idle(10 * TIMINGS.ttlMs);
    expect((await rig.clock()).upMs).toBe(upBefore);
    for (const p of pairs) expect(Number((await rig.row(p.shardId)).exp)).toBeGreaterThan(upBefore);
    await rig.direct.query(`ALTER ROLE smdb_role_a LOGIN`);
    await rig.direct.query(`ALTER ROLE smdb_role_b LOGIN`);
    const back = await renew(a, A, pairs);
    expect(back.rows.filter(r => r.mine && !r.released).map(r => r.shardId).sort()).toEqual([0, 1]);
  });

  it('one process refused: the other takes after TTL; at the login\'s return the refused one finds the loss and its kept write is refused deposed', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = storeAs('smdb_role_a', () => undefined);
    const b = rig.store();
    await renew(a, A);
    const got = await a.take({ me: A, capacity: 4, ttlMs: TIMINGS.ttlMs, boot: true, known: [], localCount: 2, reserve: false });
    if (got.kind !== 'done') throw new Error('no take');
    const pairs = got.taken.map(t => t.pair);
    await renew(a, A, pairs);
    const guildId = String(4n << 22n);
    const onShard = pairs.find(p => p.shardId === 0)!;
    expect((await rig.backend.hydrateGuild(guildId, token(onShard))).ok).toBe(true);
    expect(await rig.backend.flushGuild(guildId, { upserts: [{ key: { module: 'm', filename: 'x.json' }, doc: '{"v":1}' }], deletes: [], appends: [] }, token(onShard))).toEqual({ ok: true });
    await refuse('smdb_role_a');
    await renew(b, B);
    const exp = Math.min(...await Promise.all(pairs.map(async p => Number((await rig.row(p.shardId)).exp))));
    let taken: number[] = [];
    for (let i = 0; i < 12 && taken.length < 2; i++) {
      await rig.idle(TIMINGS.renewMs);
      await renew(b, B);
      const up = (await rig.clock()).upMs;
      const t = await b.take({ me: B, capacity: 4, ttlMs: TIMINGS.ttlMs, boot: false, known: [], localCount: 2, reserve: true });
      const now = t.kind === 'done' ? t.taken.map(x => x.pair.shardId) : [];
      if (now.length > 0) expect(up).toBeGreaterThanOrEqual(exp);
      taken = taken.concat(now);
    }
    expect(taken.sort()).toEqual([0, 1]);
    await rig.direct.query(`ALTER ROLE smdb_role_a LOGIN`);
    const back = await renew(a, A, pairs);
    expect(back.rows.filter(r => r.mine)).toEqual([]);
    expect(await rig.backend.flushGuild(guildId, { upserts: [{ key: { module: 'm', filename: 'x.json' }, doc: '{"v":2}' }], deletes: [], appends: [] }, token(onShard))).toMatchObject({ ok: false, reason: 'deposed' });
    expect(errors.mock.calls.map(c => String(c[0])).some(l => l.startsWith('[PostgresBackend] Flush rejected: deposed') && l.includes(guildId))).toBe(true);
    expect((await rig.direct.query(`SELECT doc FROM smdb_data.guild_data WHERE guild_id = $1`, [guildId])).rows).toEqual([{ doc: '{"v":1}' }]);
  });
});
