import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  snapshots: [] as any[],
  plans: [] as { shards: number[]; shardCount: number }[],
  gatewayCalls: 0,
}));

vi.mock('../../src/bot/internalSetup/fleet/placement', async importOriginal => {
  const real: any = await importOriginal();
  return {
    ...real,
    fetchGatewayInfoResult: vi.fn(async () => {
      h.gatewayCalls++;
      return { info: { recommendedShards: 4, sessionStartLimit: null }, error: null };
    }),
  };
});

vi.mock('../../src/bot/internalSetup/utils/dataBackends/dataReadiness', async importOriginal => {
  const real: any = await importOriginal();
  return {
    ...real,
    getDataReadiness: () => ({
      onLeaseChanged: (s: any) => h.snapshots.push(s),
    }),
  };
});

vi.mock('../../src/bot/internalSetup/utils/dataBackends/fileBackend', async importOriginal => {
  const real: any = await importOriginal();
  return { ...real, cleanOrphanTmpFiles: vi.fn(async () => {}) };
});

vi.mock('../../src/bot/internalSetup/fleet/nodeIdentity', async importOriginal => {
  const real: any = await importOriginal();
  return { ...real, getNodeId: () => 'node-a', getNodeName: () => 'Node A', getAppVersion: () => '1.0.0' };
});

vi.mock('../../src/bot/internalSetup/ingest/ingestService', () => {
  const fake = {
    setShardPlan: (shards: number[], shardCount: number) => h.plans.push({ shards: [...shards], shardCount }),
    isStarted: () => false,
    start: vi.fn(async () => 'ok'),
    stop: vi.fn(async () => {}),
    getClient: () => null,
  };
  return { getIngestService: () => fake };
});

import { bootShards, getFleetContext } from '../../src/bot/internalSetup/fleet/shardBoot';
import { getFleetState } from '../../src/bot/internalSetup/fleet/state';

describe('shardBoot runs every shard in this process', () => {
  it('holds shards 0..n-1 with no claim on a JSON bot and hands them to the data readiness driver', async () => {
    expect(getFleetContext()).toBeNull();
    const ctx = await bootShards();
    expect(ctx.nodeId).toBe('node-a');
    expect(ctx.nodeName).toBe('Node A');
    expect(ctx.shardCount).toBe(4);
    expect(h.plans.at(-1)).toEqual({ shards: [0, 1, 2, 3], shardCount: 4 });
    expect(h.snapshots).toHaveLength(1);
    expect(h.snapshots[0]).toEqual({
      nodeId: 'node-a',
      claim: null,
      shardCount: 4,
      shardIds: [0, 1, 2, 3],
    });
  });

  it('returns the same context when called twice and getFleetContext returns it', async () => {
    const first = await bootShards();
    const [again, parallel] = await Promise.all([bootShards(), bootShards()]);
    expect(again).toBe(first);
    expect(parallel).toBe(first);
    expect(getFleetContext()).toBe(first);
    expect(h.gatewayCalls).toBe(1);
    expect(h.snapshots).toHaveLength(1);
  });

  it('reports the node and its shards in the fleet state view', async () => {
    await bootShards();
    const state = getFleetState();
    expect(state.initialized).toBe(true);
    expect(state.nodeId).toBe('node-a');
    expect(state.nodeName).toBe('Node A');
    expect(state.shardCount).toBe(4);
    expect(state.leases.map(l => l.shardId).sort()).toEqual([0, 1, 2, 3]);
    expect(state.shardTable.map(s => s.nodeId)).toEqual(['node-a', 'node-a', 'node-a', 'node-a']);
    expect(state.claim).toBeNull();
  });
});
