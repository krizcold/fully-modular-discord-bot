import { randomUUID } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { heartbeat, me, startClaimRig, TIMINGS, type ClaimRig } from '../helpers/pgClaimRig';
import type { ClaimStore } from '../../src/bot/internalSetup/fleet/claimStore';
import { closeReshard, flipReshard, startReshard, type SqlClient } from '../../src/bot/internalSetup/fleet/reshardStore';
import { processId } from '../../src/bot/internalSetup/fleet/processId';

// NB9 test 10, row 41 (decisions 29, 41, C5, D1): the serve's redraw through bootShards({ taken }). The standby's
// rows come from its real take under this OS process's id (processId()), A's old rows from NB4's real take and
// release, 'done' from the real close; shardBoot.ts runs with its data layer mocked to 'serving' and its claims store
// built on the rig's database. The redraw matches holder_process = taken.processId, so one id serves both phases.

const h = vi.hoisted(() => ({ grants: [] as any[] }));

vi.mock('../../src/bot/internalSetup/fleet/placement', async orig => ({
  ...(await orig<any>()),
  fetchGatewayInfoResult: vi.fn(async () => ({ info: { recommendedShards: 8, sessionStartLimit: null }, error: null })),
}));
vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async orig => ({
  ...(await orig<any>()),
  cleanOrphanTmpFiles: vi.fn(async () => {}),
}));
vi.mock('../../src/bot/internalSetup/fleet/nodeIdentity', async orig => ({
  ...(await orig<any>()),
  getNodeId: () => 'n-b', getNodeName: () => 'B', getAppVersion: () => '1.0.0',
}));
vi.mock('../../src/bot/internalSetup/ingest/ingestService', () => {
  const fake = { setShardPlan: () => undefined, isStarted: () => false, start: vi.fn(async () => 'ok'), stop: vi.fn(async () => undefined), getClient: () => null };
  return { getIngestService: () => fake };
});
vi.mock('../../src/bot/internalSetup/utils/dataBackends/boot', async orig => ({
  ...(await orig<any>()),
  getDataBootStatus: () => ({ state: 'serving' }),
}));
vi.mock('../../src/bot/internalSetup/utils/dataManager', async orig => ({
  ...(await orig<any>()),
  getBackendHealth: () => ({ state: 'healthy', oldestDirtyMs: 0, dirtyBytes: 0, lastError: null }),
  getGuildDataBackend: () => null,
  isStopping: () => false,
}));
vi.mock('../../src/bot/internalSetup/utils/maintenance', async orig => ({
  ...(await orig<any>()),
  maintenanceUnfit: () => null,
  startLeave: () => undefined,
}));
vi.mock('../../src/bot/internalSetup/fleet/shardRecord', async orig => ({
  ...(await orig<any>()),
  writeShardRecord: () => undefined,
  readShardRecord: () => null,
}));
vi.mock('../../src/utils/envLoader', async orig => ({
  ...(await orig<any>()),
  resolveDataBackend: () => 'postgres',
}));

let rig: ClaimRig;
let a: ClaimStore;
let s: ClaimStore;
beforeAll(async () => {
  rig = await startClaimRig();
  a = rig.store();
  s = rig.store();
}, 180_000);
afterAll(async () => { await rig?.stop(); });
beforeEach(async () => { await rig.reset(); h.grants = []; });

const A = me('a');

async function onClient<T>(fn: (c: SqlClient) => Promise<T>): Promise<T> {
  const client = await rig.direct.connect();
  try { return await fn(client); } finally { client.release(); }
}

describe('test 10, row 41: the redraw through bootShards({ taken })', () => {
  it("serves the standby's rows under new claims above every stamp, holder this process's one id, the sessions kept", async () => {
    const S = { processId: processId(), nodeId: 'n-b', nodeName: 'B' };
    await a.renew({ me: A, pairs: [], ttlMs: TIMINGS.ttlMs, heartbeat: heartbeat({ capacity: 8 }) });
    const old = await a.take({ me: A, capacity: 4, ttlMs: TIMINGS.ttlMs, boot: true, known: [], localCount: 4, reserve: false });
    expect(old.kind).toBe('done');
    const attempt = randomUUID();
    expect((await onClient(c => startReshard(c, { attempt, wanted: 8, method: 'overlap', reason: null, startedBy: 'A', maxConcurrency: 1 }))).kind).toBe('started');
    const took = await s.standbyTake({ me: S, capacity: 8, ttlMs: TIMINGS.ttlMs, attempt, shardCount: 8 });
    expect(took.kind).toBe('done');
    if (took.kind !== 'done') return;
    await s.renewStandby({ me: S, pairs: took.taken.map(p => ({ ...p, ready: true })), ttlMs: TIMINGS.ttlMs });
    expect((await onClient(c => flipReshard(c, attempt))).kind).toBe('flipped');
    await a.release({ me: A, reserved: [], handOvers: [], ttlMs: TIMINGS.ttlMs });
    expect((await onClient(c => closeReshard(c, attempt))).kind).toBe('closed');
    const floor = Number((await rig.direct.query(`SELECT max(claim)::text AS m FROM smdb_data.shard_claims`)).rows[0].m);

    const { LeaseRuntime } = await import('../../src/bot/internalSetup/fleet/leaseRuntime');
    const runtime = new LeaseRuntime({ setShardPlan: () => undefined, isStarted: () => false, start: async () => 'ok', stop: async () => undefined, getClient: () => null } as any);
    runtime.applyGrant = (async (grant: any) => { h.grants.push(grant); }) as any;
    const mod = await import('../../src/bot/internalSetup/fleet/shardBoot');
    mod._setClaimStoreFactory(() => rig.store());
    const stopLanes = vi.fn(async () => undefined);
    const ctx = await mod.bootShards({ taken: { count: 8, processId: S.processId, pairs: took.taken, runtime, stopLanes, release: async () => undefined } });
    try {
      expect(stopLanes).toHaveBeenCalledTimes(1);
      expect(ctx.shardCount).toBe(8);
      expect(ctx.keptSessions).toBe(true);
      expect(h.grants.at(-1).leases.map((l: any) => l.shardId)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      const rows = (await rig.direct.query(`SELECT shard_id, holder_process, claim::text AS claim, released FROM smdb_data.shard_claims WHERE shard_count = 8 ORDER BY shard_id`)).rows;
      expect(rows).toHaveLength(8);
      for (const row of rows) {
        expect(row.holder_process).toBe(S.processId);
        expect(row.released).toBe(false);
        expect(Number(row.claim)).toBeGreaterThan(floor);
      }
      expect(mod.getShardClaims()!.heldPairs().map(p => p.claim)).toEqual(rows.map(r => Number(r.claim)));
    } finally {
      await mod.getShardClaims()?.finishStop();
    }
  }, 60_000);
});
