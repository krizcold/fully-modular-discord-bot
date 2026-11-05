import * as fs from 'fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { heartbeat, me, startClaimRig, TIMINGS, type ClaimRig } from '../helpers/pgClaimRig';
import { stopSteps } from '../helpers/stopRig';
import { ClaimStore, RELEASE_SQL, type ClaimStoreApi, type Heartbeat } from '../../src/bot/internalSetup/fleet/claimStore';
import { aboveReason, claimTimings, planReturns, type Pair } from '../../src/bot/internalSetup/fleet/claimRules';
import { ShardClaims } from '../../src/bot/internalSetup/fleet/shardClaims';

// NB4 owner ruling on capacity (decisions 10 and 11): FLEET_SHARD_CAPACITY is a target, not a cap. A node takes above
// it only for its own rows or for shards no other fit node with a web UI has room for; a node with no web UI counts as
// no room and receives nothing; its release keeps its rows until they expire; the page names why a node stays above.

let rig: ClaimRig;
const stores: Record<string, ClaimStore> = {};
beforeAll(async () => {
  rig = await startClaimRig();
  for (const name of ['a', 'a2', 'b', 'c']) stores[name] = rig.store();
}, 180_000);
afterAll(async () => { await rig?.stop(); });
beforeEach(async () => { await rig.reset(); });

const A = me('a');
const A2 = { ...A, processId: 'p-a-next' };
const B = me('b');
const C = me('c');
const renew = (who: typeof A, store: string, hb: Partial<Heartbeat> = {}, pairs: Pair[] = []) =>
  stores[store].renew({ me: who, pairs, ttlMs: TIMINGS.ttlMs, heartbeat: heartbeat(hb) });
const take = async (who: typeof A, store: string, over: Record<string, unknown>) => {
  const got = await stores[store].take({ me: who, capacity: 1, ttlMs: TIMINGS.ttlMs, boot: true, known: [], localCount: 4, reserve: false, ...over });
  if (got.kind !== 'done') throw new Error('no take');
  return got;
};
const ids = (got: { taken: Array<{ pair: Pair }> }) => got.taken.map(t => t.pair.shardId).sort((x, y) => x - y);
const expireAll = async () => {
  const exp = Math.max(...(await rig.direct.query(`SELECT expires_up_ms::text AS e FROM smdb_data.shard_claims`)).rows.map(r => Number(r.e)));
  await rig.direct.query(`UPDATE smdb_data.claim_clock SET up_ms = $1, ticked_at = now()`, [exp]);
};

describe('the target', () => {
  it('one node, target 1, 4 shards: it takes all 4, three above the target for want of room', async () => {
    await renew(A, 'a', { capacity: 1 });
    const got = await take(A, 'a', {});
    expect(ids(got)).toEqual([0, 1, 2, 3]);
    expect(got.taken.filter(t => t.above === 'no-room')).toHaveLength(3);
  });

  it('two fit nodes, target 1: A\'s boot takes three and leaves one for B\'s room', async () => {
    await renew(B, 'b', { capacity: 1 });
    await renew(A, 'a', { capacity: 1 });
    const got = await take(A, 'a', {});
    expect(got.taken).toHaveLength(3);
    expect(got.plan.leftToOthers).toBe(1);
    const bGot = await take(B, 'b', {});
    expect(bGot.taken).toHaveLength(1);
  });

  it('a node at target 0 takes nothing while another fit node has room, and takes a shard no other node has room for', async () => {
    await renew(B, 'b', { capacity: 3 });
    await renew(A, 'a', { capacity: 0 });
    const got = await take(A, 'a', { capacity: 0 });
    expect(got.taken).toHaveLength(1);
    expect(got.taken[0].above).toBe('no-room');
    expect(got.plan.leftToOthers).toBe(3);
  });
});

describe('own rows', () => {
  it('three machines, target 1, 2 shards: A\'s clean restart takes its kept shard back while C has room', async () => {
    await renew(C, 'c', { capacity: 1 });
    await renew(B, 'b', { capacity: 1 });
    await renew(A, 'a', { capacity: 1 });
    const aGot = await take(A, 'a', { localCount: 2 });
    const bGot = await take(B, 'b', { localCount: 2 });
    expect(aGot.taken).toHaveLength(1);
    expect(bGot.taken).toHaveLength(1);
    await stores.a.release({ me: A, reserved: [], handOvers: [], ttlMs: TIMINGS.ttlMs });
    await renew(A2, 'a2', { capacity: 1 });
    const cGot = await take(C, 'c', { localCount: 2, boot: false, reserve: true });
    expect(cGot.taken).toEqual([]);
    const next = await take(A2, 'a2', { localCount: 2 });
    expect(ids(next)).toEqual(ids(aGot));
  });

  it('a return to B while C has room lands on B: B\'s tick reserves the row kept for it', async () => {
    await renew(C, 'c', { capacity: 1 });
    await renew(B, 'b', { capacity: 1 });
    await renew(A, 'a', { capacity: 2 });
    const aGot = await take(A, 'a', { localCount: 2, capacity: 2 });
    expect(aGot.taken).toHaveLength(2);
    await rig.direct.query(`UPDATE smdb_data.shard_claims SET home_node = 'n-b' WHERE shard_id = 1`);
    await rig.direct.query(`UPDATE smdb_data.shard_nodes SET healthy_since = now() - interval '301 seconds' WHERE node_id = 'n-b'`);
    const rows = await stores.a.release({ me: A, reserved: [], handOvers: [{ shardId: 1, receiver: 'n-b', move: false }], ttlMs: TIMINGS.ttlMs });
    expect(rows.find(r => r.shardId === 1)!.handedTo).toBe('B');
    const cGot = await take(C, 'c', { localCount: 2, boot: false, reserve: true });
    expect(ids(cGot)).not.toContain(1);
    const bGot = await take(B, 'b', { localCount: 2, boot: false, reserve: true });
    expect(ids(bGot)).toEqual([1]);
  });

  it('a node at its target takes its predecessor\'s expired rows at boot; kept rows above its target are all taken, marked own', async () => {
    await renew(B, 'b', { capacity: 4 });
    await renew(A, 'a', { capacity: 3 });
    const aGot = await take(A, 'a', { capacity: 3 });
    expect(aGot.taken).toHaveLength(3);
    await stores.a.release({ me: A, reserved: [], handOvers: [], ttlMs: TIMINGS.ttlMs });
    await renew(A2, 'a2', { capacity: 1 });
    const next = await take(A2, 'a2', { capacity: 1 });
    expect(ids(next)).toEqual(ids(aGot));
    expect(next.taken.filter(t => t.above === 'own')).toHaveLength(2);
  });

  it('kept rows taken back above the target: the work cycle moves the extra to a healthy B with room, and the release hands them (NB4-R8-T2)', async () => {
    await renew(B, 'b', { capacity: 4 });
    await renew(A, 'a', { capacity: 3 });
    const aGot = await take(A, 'a', { capacity: 3 });
    const former = ids(aGot);
    expect(former).toHaveLength(3);
    await stores.a.release({ me: A, reserved: [], handOvers: [], ttlMs: TIMINGS.ttlMs });
    const restarts: string[] = [];
    const lines: string[] = [];
    const claims = new ShardClaims({
      store: stores.a2, me: A2, timings: TIMINGS, capacity: 1, takeoverSeconds: 30, returns: true, restartable: true, startedAt: Date.now(),
      fitness: () => null, gateClosed: () => false, isStopping: () => false, stopServingStep: () => undefined,
      noteLapsed: () => undefined, noteLost: () => undefined,
      restartForShards: reason => { restarts.push(reason); return true; },
      log: { log: l => lines.push(String(l)), warn: l => lines.push(String(l)), error: l => lines.push(String(l)) },
    });
    expect(await claims.firstRenewal()).toBe(true);
    const taken = await claims.bootTake(async () => 4);
    expect(taken!.pairs.map(p => p.shardId).sort((x, y) => x - y)).toEqual(former);
    claims.noteGranted();
    await renew(B, 'b', { capacity: 4 });
    await rig.direct.query(`UPDATE smdb_data.shard_nodes SET healthy_since = now() - interval '301 seconds' WHERE node_id = 'n-b'`);
    await claims.renewOnce();
    const until = Date.now() + 10_000;
    while (restarts.length === 0 && Date.now() < until) await new Promise(resolve => { setTimeout(resolve, 50); });
    const [keep, mid, high] = former;
    expect([...claims.snapshot().returning].sort((x, y) => x - y)).toEqual([mid, high]);
    expect(restarts).toEqual([`move shard ${high} to B; move shard ${mid} to B`]);
    claims.beginStop();
    await claims.finishStop();
    expect(lines).toContain(`[Shards] Handed shard ${mid} to B`);
    expect(lines).toContain(`[Shards] Handed shard ${high} to B`);
    expect(lines.some(l => l.startsWith(`[Shards] Handed shard ${keep} `))).toBe(false);
    for (const id of [mid, high]) {
      const row = await rig.row(id, 4);
      expect([row.holder_node, row.home_node, row.released]).toEqual(['n-b', 'n-b', true]);
    }
    const kept = await rig.row(keep, 4);
    expect([kept.holder_process, kept.holder_node, kept.home_node, kept.released]).toEqual(['p-a-next', 'n-a', 'n-a', true]);
  });
});

describe('a node with no web UI', () => {
  it('counts as no room: A at its target takes a crashed node\'s expired shard above its target', async () => {
    await renew(B, 'b', { capacity: 1, restartable: false });
    await renew(A, 'a', { capacity: 1 });
    await rig.direct.query(`INSERT INTO smdb_data.meta (key, value) VALUES ('shard_count', '{"count":2}')`);
    await rig.direct.query(`INSERT INTO smdb_data.shard_claims (shard_count, shard_id, claim, holder_process, holder_node, holder_name, home_node, ttl_ms, expires_up_ms)
      VALUES (2, 0, 3, 'p-a', 'n-a', 'A', 'n-a', 30000, 999999999), (2, 1, 4, 'p-dead', 'n-dead', 'DEAD', 'n-dead', 30000, 0)`);
    await rig.direct.query(`SELECT setval('smdb_data.claim_seq', 10)`);
    const got = await take(A, 'a', { boot: false, reserve: true, localCount: 2, known: [{ shardCount: 2, shardId: 0, claim: 3 }] });
    expect(got.taken.map(t => [t.pair.shardId, t.above])).toEqual([[1, 'no-room']]);
  });

  it('B holding 0 and 1 stops: its release keeps them, and A takes both once they expire, not before; no row names B\'s process after', async () => {
    await renew(A, 'a', { capacity: 4 });
    await renew(B, 'b', { capacity: 2, restartable: false });
    await take(B, 'b', { capacity: 2, localCount: 2 });
    const released = await stores.b.release({ me: B, reserved: [], handOvers: [], ttlMs: TIMINGS.ttlMs });
    expect(released.map(r => r.shardId).sort()).toEqual([0, 1]);
    const early = await take(A, 'a', { capacity: 4, localCount: 2, boot: false, reserve: true });
    expect(early.taken).toEqual([]);
    await expireAll();
    const late = await take(A, 'a', { capacity: 4, localCount: 2, boot: false, reserve: true });
    expect(ids(late)).toEqual([0, 1]);
    expect((await rig.direct.query(`SELECT count(*)::int AS n FROM smdb_data.shard_claims WHERE holder_process = 'p-b'`)).rows[0].n).toBe(0);
  });

  it('A\'s work cycle over the real store decides no return to a healthy B with room but no web UI, and asks for no restart (NB4-R7-T3)', async () => {
    await renew(B, 'b', { capacity: 2, restartable: false });
    await rig.direct.query(`UPDATE smdb_data.shard_nodes SET healthy_since = now() - interval '301 seconds' WHERE node_id = 'n-b'`);
    const restarts: string[] = [];
    const lines: string[] = [];
    const reads = { n: 0 };
    const inner = stores.a;
    const store: ClaimStoreApi = {
      renew: request => inner.renew(request),
      take: (request, onBegin) => inner.take(request, onBegin),
      release: (request, onSent, onConnected) => inner.release(request, onSent, onConnected),
      readPage: shardCount => { reads.n += 1; return inner.readPage(shardCount); },
      readRow: (shardCount, shardId) => inner.readRow(shardCount, shardId),
      abandonWork: () => inner.abandonWork(),
      abandonRenewal: () => inner.abandonRenewal(),
      end: () => inner.end(),
    };
    const claims = new ShardClaims({
      store, me: A, timings: TIMINGS, capacity: 1, takeoverSeconds: 30, returns: true, restartable: true, startedAt: Date.now(),
      fitness: () => null, gateClosed: () => false, isStopping: () => false, stopServingStep: () => undefined,
      noteLapsed: () => undefined, noteLost: () => undefined,
      restartForShards: reason => { restarts.push(reason); return true; },
      log: { log: l => lines.push(String(l)), warn: l => lines.push(String(l)), error: l => lines.push(String(l)) },
    });
    expect(await claims.firstRenewal()).toBe(true);
    const taken = await claims.bootTake(async () => 2);
    expect(taken!.pairs.map(p => p.shardId).sort()).toEqual([0, 1]);
    claims.noteGranted();
    await rig.direct.query(`UPDATE smdb_data.shard_claims SET home_node = 'n-b' WHERE shard_id = 1`);
    const before = reads.n;
    const until = Date.now() + 10_000;
    while (reads.n < before + 2 && Date.now() < until) {
      await claims.renewOnce();
      await new Promise(resolve => { setTimeout(resolve, 100); });
    }
    expect(reads.n).toBeGreaterThanOrEqual(before + 2);
    const page = await stores.c.readPage(2);
    expect(page.rows.find(r => r.shardId === 1)!.homeNode).toBe('n-b');
    expect(page.nodes.find(n => n.nodeId === 'n-b')!.restartable).toBe(false);
    expect(claims.snapshot().returning).toEqual([]);
    expect(restarts).toEqual([]);
    claims.beginStop();
    await claims.finishStop();
    expect(lines.some(l => l.startsWith('[Shards] Handed shard'))).toBe(false);
    const r1 = await rig.row(1);
    expect([r1.holder_process, r1.holder_node, r1.released, r1.home_node]).toEqual(['p-a', 'n-a', true, 'n-b']);
  });

  it('a hand-over asked for B after B\'s heartbeat turned to no web UI: the release keeps the row for A (NB4-R7-T3)', async () => {
    const holdBoth = async () => {
      await renew(B, 'b', { capacity: 2 });
      await renew(A, 'a', { capacity: 2 });
      const aGot = await take(A, 'a', { capacity: 2, localCount: 2 });
      expect(ids(aGot)).toEqual([0, 1]);
      await rig.direct.query(`UPDATE smdb_data.shard_claims SET home_node = 'n-b' WHERE shard_id = 1`);
      await rig.direct.query(`UPDATE smdb_data.shard_nodes SET healthy_since = now() - interval '301 seconds' WHERE node_id = 'n-b'`);
    };
    const flipB = async () => {
      await renew(B, 'b', { capacity: 2, restartable: false });
      await rig.direct.query(`UPDATE smdb_data.shard_nodes SET healthy_since = now() - interval '301 seconds' WHERE node_id = 'n-b'`);
      const node = (await rig.direct.query(`SELECT fit, restartable, seen_at > now() - interval '30 seconds' AS seen FROM smdb_data.shard_nodes WHERE node_id = 'n-b'`)).rows[0];
      expect([node.fit, node.restartable, node.seen]).toEqual([true, false, true]);
    };
    // RELEASE_SQL as assignReceivers sends it when B's heartbeat turns between its read and the statement.
    const statement = () => rig.direct.query(RELEASE_SQL, ['p-a', 'n-a', 'A', TIMINGS.ttlMs, [], [], [], [1], ['n-b'], [false]]);
    const handed = (res: { rows: any[] }) => res.rows.map(r => [Number(r.shard_id), r.handed_to ?? null]).sort((x, y) => (x[0] as number) - (y[0] as number));

    await holdBoth();
    expect(handed(await statement())).toEqual([[0, null], [1, 'B']]);

    await rig.reset();
    await holdBoth();
    await flipB();
    expect(handed(await statement())).toEqual([[0, null], [1, null]]);
    const r1 = await rig.row(1);
    expect([r1.holder_process, r1.holder_node, r1.holder_name, r1.released, r1.home_node]).toEqual(['p-a', 'n-a', 'A', true, 'n-b']);
    expect(Number(r1.ttl_ms)).toBe(TIMINGS.ttlMs);

    await rig.reset();
    await holdBoth();
    await flipB();
    const rows = await stores.a.release({ me: A, reserved: [], handOvers: [{ shardId: 1, receiver: 'n-b', move: false }], ttlMs: TIMINGS.ttlMs });
    expect(rows.map(r => [r.shardId, r.handedTo]).sort((x, y) => (x[0] as number) - (y[0] as number))).toEqual([[0, null], [1, null]]);
    const again = await rig.row(1);
    expect([again.holder_process, again.holder_node, again.released, again.home_node]).toEqual(['p-a', 'n-a', true, 'n-b']);
  });
});

describe('a return decided by the work cycle (R2-RETURNS)', () => {
  it('A\'s cycle over the real store decides the return planReturns gives for the page, and the release hands exactly that shard', async () => {
    await renew(B, 'b', { capacity: 1 });
    await rig.direct.query(`UPDATE smdb_data.shard_nodes SET healthy_since = now() - interval '301 seconds' WHERE node_id = 'n-b'`);
    const restarts: string[] = [];
    const lines: string[] = [];
    const claims = new ShardClaims({
      store: stores.a, me: A, timings: TIMINGS, capacity: 2, takeoverSeconds: 30, returns: true, restartable: true, startedAt: Date.now(),
      fitness: () => null, gateClosed: () => false, isStopping: () => false, stopServingStep: () => undefined,
      noteLapsed: () => undefined, noteLost: () => undefined,
      restartForShards: reason => { restarts.push(reason); return true; },
      log: { log: l => lines.push(String(l)), warn: l => lines.push(String(l)), error: l => lines.push(String(l)) },
    });
    expect(await claims.firstRenewal()).toBe(true);
    const taken = await claims.bootTake(async () => 2);
    expect(taken!.pairs.map(p => p.shardId).sort()).toEqual([0, 1]);
    claims.noteGranted();
    await rig.direct.query(`UPDATE smdb_data.shard_claims SET home_node = 'n-b' WHERE shard_id = 1`);
    await claims.renewOnce();
    const until = Date.now() + 10_000;
    while (restarts.length === 0 && Date.now() < until) await new Promise(resolve => { setTimeout(resolve, 50); });
    const page = await stores.c.readPage(2);
    expect(planReturns({ me: A, capacity: 2, held: claims.heldPairs(), rows: page.rows, nodes: page.nodes, upMs: page.upMs }))
      .toEqual([{ shardId: 1, receiver: 'n-b', move: false }]);
    expect(claims.snapshot().returning).toEqual([1]);
    expect(restarts).toEqual(['return shard 1 to B']);
    claims.beginStop();
    await claims.finishStop();
    expect(lines).toContain('[Shards] Handed shard 1 to B');
    const r1 = await rig.row(1);
    const r0 = await rig.row(0);
    expect([r1.holder_node, r1.released, r1.home_node]).toEqual(['n-b', true, 'n-b']);
    expect([r0.holder_node, r0.released]).toEqual(['n-a', true]);
  });
});

describe('the above-target reason on the page', () => {
  it('returns-off, no-web-ui, waiting-healthy, moving and no-room, from the page read', async () => {
    await renew(A, 'a', { capacity: 1 });
    await take(A, 'a', { capacity: 1, localCount: 3 });
    const reason = async () => {
      const page = await stores.c.readPage(3);
      const node = page.nodes.find(n => n.nodeId === 'n-a')!;
      return aboveReason(node, page.nodes, page.rows, page.upMs);
    };
    await renew(A, 'a', { capacity: 1, returns: false });
    expect((await reason()).kind).toBe('returns-off');
    await renew(A, 'a', { capacity: 1, restartable: false });
    expect((await reason()).kind).toBe('no-web-ui');
    await renew(A, 'a', { capacity: 1 });
    await renew(B, 'b', { capacity: 2 });
    await rig.direct.query(`UPDATE smdb_data.shard_nodes SET healthy_since = now() - interval '100 seconds' WHERE node_id = 'n-b'`);
    const waiting = await reason();
    expect(waiting.kind).toBe('waiting-healthy');
    expect(waiting.kind === 'waiting-healthy' && waiting.name).toBe('B');
    await rig.direct.query(`UPDATE smdb_data.shard_nodes SET healthy_since = now() - interval '300 seconds' WHERE node_id = 'n-b'`);
    expect(await reason()).toEqual({ kind: 'moving', to: 'B' });
    await renew(B, 'b', { capacity: 0 });
    expect((await reason()).kind).toBe('no-room');
  });
});

describe('a node with no web UI leaves through its own stop handler (NB4-R6-T2, [pg] 12)', () => {
  const T6 = claimTimings(6);
  const until = async (check: () => Promise<boolean> | boolean, ms: number): Promise<void> => {
    const end = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise(resolve => { setTimeout(resolve, 100); });
    }
  };

  /** B's real claim store; its renewals hang while hang is set, and a hung one fails when its connection is destroyed. */
  function hangable(inner: ClaimStore) {
    const s = { hang: false, renewals: 0 };
    let fail: ((error: Error) => void) | null = null;
    const api: ClaimStoreApi = {
      renew: request => {
        s.renewals += 1;
        if (!s.hang) return inner.renew(request);
        return new Promise((_resolve, reject) => { fail = reject; });
      },
      take: (request, onBegin) => inner.take(request, onBegin),
      release: (request, onSent, onConnected) => inner.release(request, onSent, onConnected),
      readPage: shardCount => inner.readPage(shardCount),
      readRow: (shardCount, shardId) => inner.readRow(shardCount, shardId),
      abandonWork: () => inner.abandonWork(),
      abandonRenewal: () => {
        inner.abandonRenewal();
        fail?.(new Error('Connection terminated'));
        fail = null;
      },
      end: () => inner.end(),
    };
    return { api, s };
  }

  async function processB() {
    vi.resetModules();
    const realSend = process.send;
    (process as { send?: unknown }).send = undefined;
    const lines: string[] = [];
    const capture = (...args: unknown[]) => { lines.push(args.map(a => (a instanceof Error ? a.message : String(a))).join(' ')); };
    vi.spyOn(console, 'log').mockImplementation(capture);
    vi.spyOn(console, 'warn').mockImplementation(capture);
    vi.spyOn(console, 'error').mockImplementation(capture);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((() => undefined) as unknown) as typeof process.exit);
    const m = await import('../../src/bot/internalSetup/utils/maintenance');
    const dm = await import('../../src/bot/internalSetup/utils/dataManager');
    const gate = await import('../../src/bot/internalSetup/utils/maintenanceGate');
    const FreshShardClaims = (await import('../../src/bot/internalSetup/fleet/shardClaims')).ShardClaims;
    const { getWorkingSet } = await import('../../src/bot/internalSetup/utils/dataBackends/workingSet');
    m._setMaintenanceTiming({ leaveRetryMs: 500, filePollMs: 300, leaveSaveBoundMs: 2000 });
    const inner = new ClaimStore(rig.url, T6);
    const { api, s } = hangable(inner);
    const calls = { stopStep: 0 };
    expect(m.canRestart()).toBe(false);
    const claims = new FreshShardClaims({
      store: api, me: B, timings: T6, capacity: 2, takeoverSeconds: 6, returns: true, restartable: m.canRestart(),
      startedAt: Date.now(), fitness: m.maintenanceUnfit, gateClosed: gate.isMaintenanceGateClosed, isStopping: dm.isStopping,
      stopServingStep: () => { calls.stopStep += 1; },
      noteLapsed: m.noteClaimsLapsed,
      noteLost: lost => m.startLeave(`Shard ${lost.map(p => p.shardId).join(', ')} ${lost.length > 1 ? 'are' : 'is'} no longer held by this process`),
      restartForShards: reason => m.restartForShards(reason, m.maintenanceUnfit),
    });
    dm.stopHandler(stopSteps({ claims: () => claims, drainForExit: dm.drainForExit, hasWorkingSet: () => getWorkingSet() !== null }));
    const watcher = m.watchDataBackend(rig.backend, { retryMs: 600_000 })!;
    const released = () => lines.filter(l => l.startsWith('[Shards] Released shards'));
    const cleanup = async () => {
      m._resetMaintenance();
      (process as { send?: unknown }).send = realSend;
      await inner.end();
      vi.restoreAllMocks();
    };
    return { m, claims, calls, s, exit, lines, watcher, released, cleanup };
  }

  const bRows = async (shards: number[]) => (await rig.direct.query(
    `SELECT shard_id, holder_process, released, expires_up_ms::text AS exp FROM smdb_data.shard_claims WHERE shard_id = ANY($1::int[]) ORDER BY shard_id`, [shards])).rows;
  const pbRows = async () => (await rig.direct.query(`SELECT count(*)::int AS n FROM smdb_data.shard_claims WHERE holder_process = 'p-b'`)).rows[0].n;

  it('a lapse: the watcher\'s answer starts the leave; the stop releases 0 and 1 once, B exits once and renews no more; A takes both only after they expire', async () => {
    await renew(A, 'a', { capacity: 4 });
    const b = await processB();
    try {
      b.claims.start();
      expect(await b.claims.firstRenewal()).toBe(true);
      const taken = await b.claims.bootTake(async () => 2);
      expect(taken!.pairs.map(p => p.shardId).sort()).toEqual([0, 1]);
      b.claims.noteGranted();
      b.m.markDiscordStarted();
      b.s.hang = true;
      await until(() => b.calls.stopStep === 1, T6.deadlineMs + 5_000);
      expect(b.exit).not.toHaveBeenCalled();
      expect(b.released()).toEqual([]);

      await b.watcher.probeNow();
      await until(() => b.exit.mock.calls.length > 0, 15_000);
      expect(b.lines.filter(l => /^\[Maintenance\] The shard claims lapsed \(no renewal for \d+ s\) and the database answers; saving what this process holds before it stops \(no web UI process runs to restart it\)$/.test(l))).toHaveLength(1);
      expect(b.released()).toEqual(["[Shards] Released shards 0, 1: kept for this machine's next start for 6 s, then free to any machine with room"]);
      expect(b.exit.mock.calls).toEqual([[0]]);
      const rows = await bRows([0, 1]);
      expect(rows.map(r => [r.shard_id, r.holder_process, r.released])).toEqual([[0, 'p-b', true], [1, 'p-b', true]]);
      const up = (await rig.clock()).upMs;
      expect(rows.every(r => Number(r.exp) > up)).toBe(true);

      const early = await take(A, 'a', { capacity: 4, localCount: 2, boot: false, reserve: true });
      expect(early.taken).toEqual([]);
      b.s.hang = false;
      const renewalsAtExit = b.s.renewals;
      await new Promise(resolve => { setTimeout(resolve, 3 * T6.renewMs + 500); });
      expect(b.s.renewals).toBe(renewalsAtExit);
      expect((await bRows([0, 1])).map(r => [r.holder_process, r.released, r.exp])).toEqual(rows.map(r => [r.holder_process, r.released, r.exp]));
      expect(b.exit.mock.calls).toEqual([[0]]);

      await expireAll();
      const late = await take(A, 'a', { capacity: 4, localCount: 2, boot: false, reserve: true });
      expect(ids(late)).toEqual([0, 1]);
      expect(await pbRows()).toBe(0);
    } finally {
      await b.cleanup();
    }
  }, 60_000);

  it('after hook maintenance: maintenance.json turning to running starts the leave; the stop releases B\'s two shards once and exits once; A takes them only after they expire', async () => {
    await renew(A, 'a', { capacity: 2 });
    const b = await processB();
    const mf = await import('../../src/utils/maintenanceFile');
    try {
      b.claims.start();
      expect(await b.claims.firstRenewal()).toBe(true);
      const taken = await b.claims.bootTake(async () => 4);
      const mine = taken!.pairs.map(p => p.shardId).sort((x, y) => x - y);
      expect(mine).toHaveLength(2);
      b.claims.noteGranted();
      b.m.markDiscordStarted();
      const aGot = await take(A, 'a', { capacity: 2, localCount: 4 });
      const known = aGot.taken.map(t => t.pair);
      expect([...mine, ...ids(aGot)].sort((x, y) => x - y)).toEqual([0, 1, 2, 3]);

      mf.writeMaintenanceFile('maintenance', 'Moving the database.');
      b.m.closeMaintenanceGate('hook', 'Moving the database.');
      await new Promise(resolve => { setTimeout(resolve, 2_000); });
      expect(b.exit).not.toHaveBeenCalled();
      expect(b.released()).toEqual([]);
      expect(b.calls.stopStep).toBe(0);
      expect((await bRows(mine)).every(r => r.holder_process === 'p-b' && !r.released)).toBe(true);

      mf.writeMaintenanceFile('running', 'Moving the database.');
      await until(() => b.exit.mock.calls.length > 0, 15_000);
      expect(b.lines).toContain('[Maintenance] maintenance.json says running; saving what this process holds before it stops (no web UI process runs to restart it)');
      expect(b.released()).toEqual([`[Shards] Released shards ${mine.join(', ')}: kept for this machine's next start for 6 s, then free to any machine with room`]);
      expect(b.exit.mock.calls).toEqual([[0]]);
      const rows = await bRows(mine);
      expect(rows.map(r => [r.holder_process, r.released])).toEqual([['p-b', true], ['p-b', true]]);

      const aReleased = await stores.a.release({ me: A, reserved: [], handOvers: [], ttlMs: TIMINGS.ttlMs });
      expect(aReleased.map(r => [r.shardId, r.handedTo]).sort((x, y) => (x[0] as number) - (y[0] as number))).toEqual(ids(aGot).map(s => [s, null]));
      const aRows = (await bRows(ids(aGot))).map(r => [r.shard_id, r.holder_process, r.released]);
      expect(aRows).toEqual(ids(aGot).map(s => [s, 'p-a', true]));
      await renew(A2, 'a2', { capacity: 2 });
      const back = await take(A2, 'a2', { capacity: 2, localCount: 4 });
      expect(ids(back)).toEqual(ids(aGot));
      expect(back.taken.map(t => t.pair.claim).every(c => !known.some(k => k.claim === c))).toBe(true);
      const after = await bRows([0, 1, 2, 3]);
      expect(after.filter(r => ids(aGot).includes(r.shard_id)).map(r => [r.holder_process, r.released])).toEqual([['p-a-next', false], ['p-a-next', false]]);
      expect(after.filter(r => mine.includes(r.shard_id)).map(r => [r.holder_process, r.released])).toEqual([['p-b', true], ['p-b', true]]);
      const known2 = back.taken.map(t => t.pair);
      const early = await take(A2, 'a2', { capacity: 4, localCount: 4, boot: false, reserve: true, known: known2 });
      expect(ids(early).filter(s => mine.includes(s))).toEqual([]);
      const renewalsAtExit = b.s.renewals;
      await new Promise(resolve => { setTimeout(resolve, 3 * T6.renewMs + 500); });
      expect(b.s.renewals).toBe(renewalsAtExit);
      expect(b.exit.mock.calls).toEqual([[0]]);

      await expireAll();
      const late = await take(A2, 'a2', { capacity: 4, localCount: 4, boot: false, reserve: true, known: known2 });
      expect(ids(late).filter(s => mine.includes(s))).toEqual(mine);
      expect(await pbRows()).toBe(0);
    } finally {
      fs.rmSync(mf.maintenanceFilePath(), { force: true });
      await b.cleanup();
    }
  }, 60_000);
});
