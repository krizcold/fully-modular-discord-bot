import { describe, expect, it, vi } from 'vitest';

// NB9 7, 27 and 29: LeaseRuntime.startStandby logs the standby's shards in with no data grant; the serve's applyGrant
// with the same shard set and count keeps those gateway sessions and only tells the data layer.

const told: unknown[] = [];
vi.mock('../../src/bot/internalSetup/utils/dataBackends/dataReadiness', () => ({
  getDataReadiness: () => ({ onLeaseChanged: (lease: unknown) => { told.push(lease); } }),
}));
vi.mock('../../src/bot/internalSetup/utils/servingGate', () => ({ stoppedServing: () => false }));
vi.mock('../../src/bot/internalSetup/utils/dataManager', () => ({ isStopping: () => false }));
vi.mock('../../src/bot/internalSetup/fleet/nodeIdentity', () => ({ getNodeId: () => 'n-a' }));

function fakeIngest() {
  const calls: string[] = [];
  let started = false;
  const ingest = {
    setShardPlan: (shards: number[], count: number) => { calls.push(`plan ${shards.join(',')}/${count}`); },
    isStarted: () => started,
    start: async (token: string | undefined) => { started = true; calls.push(`start ${token}`); return ''; },
    stop: async (reason: string) => { started = false; calls.push(`stop ${reason}`); },
    getClient: () => null,
  };
  return { ingest, calls };
}

describe('LeaseRuntime.startStandby and the serve grant', () => {
  it('logs in with the standby set and tells the data layer nothing; the grant of that set keeps the sessions', async () => {
    const { LeaseRuntime } = await import('../../src/bot/internalSetup/fleet/leaseRuntime');
    const { ingest, calls } = fakeIngest();
    const runtime = new LeaseRuntime(ingest as any);
    runtime.startStandby({ processId: 'p-s', shardCount: 8, leases: [{ leaseId: 'l1', shardId: 5, claim: 30 }, { leaseId: 'l2', shardId: 4, claim: 31 }] }, 'tok');
    await Promise.resolve();
    expect(calls).toEqual(['plan 4,5/8', 'start tok']);
    expect(told).toEqual([]);
    expect(runtime.getCurrent()?.shardCount).toBe(8);

    await runtime.applyGrant({ processId: 'p-s', shardCount: 8, leases: [{ leaseId: 'l3', shardId: 4, claim: 40 }, { leaseId: 'l4', shardId: 5, claim: 41 }] });
    await new Promise(resolve => setTimeout(resolve, 1600));
    expect(calls).toEqual(['plan 4,5/8', 'start tok', 'plan 4,5/8']);
    expect(told).toEqual([{ nodeId: 'n-a', processId: 'p-s', claims: { 4: 40, 5: 41 }, shardCount: 8, shardIds: [4, 5] }]);
  });

  it('a standby that took no shard logs nothing in', async () => {
    const { LeaseRuntime } = await import('../../src/bot/internalSetup/fleet/leaseRuntime');
    const { ingest, calls } = fakeIngest();
    new LeaseRuntime(ingest as any).startStandby({ processId: 'p-s', shardCount: 8, leases: [] }, 'tok');
    await Promise.resolve();
    expect(calls).toEqual(['plan /8']);
  });
});
