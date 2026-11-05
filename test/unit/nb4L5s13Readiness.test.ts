import { afterEach, describe, expect, it, vi } from 'vitest';

import { initDataReadiness, type DataReadinessDriver } from '../../src/bot/internalSetup/utils/dataBackends/dataReadiness';
import { initWorkingSet, type WorkingSetManager } from '../../src/bot/internalSetup/utils/dataBackends/workingSet';
import type { FenceToken, FlushOutcome, GuildFlushBatch } from '../../src/bot/internalSetup/utils/dataBackends/backend';
import { FakeStore } from '../helpers/fakeStore';
import { setBackendKind } from '../helpers/backendKind';

// NB4 decision 17: a shard that leaves this process freezes every set of that shard in one synchronous pass before
// any flush starts, and a set of a shard still leased here keeps serving.

class SpyStore extends FakeStore {
  onFlush: ((guildId: string) => void) | null = null;
  override async flushGuild(guildId: string, batch: GuildFlushBatch, token: FenceToken): Promise<FlushOutcome> {
    this.onFlush?.(guildId);
    return super.flushGuild(guildId, batch, token);
  }
}

// Discord's guild->shard formula over 2 shards: (id >> 22) % 2.
const onShard = (n: bigint) => String(n << 22n);
const SHARD1_A = onShard(1n);
const SHARD1_B = onShard(3n);
const SHARD0 = onShard(2n);
const tokenOf = (shardId: number): FenceToken => ({ nodeId: 'node-a', claim: 1, processId: 'process-a', shardId, shardCount: 2 });

let driver: DataReadinessDriver | null = null;

afterEach(() => {
  driver?.stop();
  driver = null;
  setBackendKind(null);
  vi.restoreAllMocks();
});

async function rig(): Promise<{ store: SpyStore; ws: WorkingSetManager; driver: DataReadinessDriver }> {
  setBackendKind('postgres');
  const store = new SpyStore();
  const ws = initWorkingSet(store);
  const d = initDataReadiness(store, ws, { held: false });
  driver = d;
  d.onLeaseChanged({ nodeId: 'node-a', processId: 'process-a', claims: { 0: 1, 1: 1 }, shardCount: 2, shardIds: [0, 1] });
  for (const [guildId, shardId] of [[SHARD1_A, 1], [SHARD1_B, 1], [SHARD0, 0]] as const) {
    expect(await ws.hydrate(guildId, tokenOf(shardId))).toBe('ready');
  }
  return { store, ws, driver: d };
}

describe('a shard leaving this process', () => {
  it('freezes every set of the shard before the first flush starts, and only those', async () => {
    const { store, ws, driver: d } = await rig();
    expect(ws.save(SHARD1_A, 'm', 'a.json', '1')).toBe('accepted');
    const seenAtFlush: Array<string | null> = [];
    store.onFlush = () => { seenAtFlush.push(ws.stateOf(SHARD1_B)); };
    d.onLeaseChanged({ nodeId: 'node-a', processId: 'process-a', claims: { 0: 1 }, shardCount: 2, shardIds: [0] });
    expect(seenAtFlush).toEqual(['frozen-retained']);
    expect(ws.stateOf(SHARD1_A)).toBe('frozen-retained');
    expect(ws.stateOf(SHARD1_B)).toBe('frozen-retained');
    expect(ws.stateOf(SHARD0)).toBe('ready');
    expect(ws.save(SHARD0, 'm', 'b.json', '2')).toBe('accepted');
    expect(ws.save(SHARD1_B, 'm', 'b.json', '2')).toBe('frozen-window');
    store.onFlush = null;
  });
});
