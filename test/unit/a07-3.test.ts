import { describe, expect, it } from 'vitest';
import * as state from '../../src/bot/internalSetup/fleet/state';

const status = (state as unknown as { holderShardStatus?: (h: unknown, id: number, n: number) => string }).holderShardStatus;

describe('a held shard row reads only its holder report', () => {
  it('reads a shard status only from the given holder report', () => {
    expect(typeof status).toBe('function');
    const holder = { shards: [{ shardId: 1, status: 'Ready', guildCount: 0 }], lastShardCount: 2 };
    expect(status!(holder, 0, 2)).toBe('Unknown');
    expect(status!(holder, 1, 2)).toBe('Ready');
  });

  it('ignores a holder report made under another shard count', () => {
    const holder = { shards: [{ shardId: 0, status: 'Ready', guildCount: 0 }], lastShardCount: 4 };
    expect(status!(holder, 0, 2)).toBe('Unknown');
    expect(status!({ ...holder, lastShardCount: null }, 0, 2)).toBe('Ready');
  });

  it('getFleetState colours a held row from its holder, not a revoked former holder', () => {
    const node = (nodeId: string, shards: { shardId: number; status: string; guildCount: number }[]) => ({
      nodeId, nodeName: nodeId, isSelf: false, connected: true, appVersion: '', capabilities: null, guildCount: 0, load: null,
      lastHeartbeatAt: null, downSince: null, draining: false, syncAppliedRevision: null, dbReplica: null, mirror: null,
      shards, lastShardCount: 1,
    });
    const registry = {
      nodes: new Map([['holder', node('holder', [])], ['former', node('former', [{ shardId: 0, status: 'Ready', guildCount: 0 }])]]),
      shardCount: 1, term: 1, epoch: 1,
      shardTable: new Map([[0, { shardId: 0, nodeId: 'holder', leaseId: 'l', term: 1, epoch: 1 }]]),
      pendingConfirmation: new Map(), guildMap: new Map(), shardGuildTotals: new Map(), restGuildShards: new Map(), restGuildNames: new Map(),
      healthOf: () => 'healthy', shardIdsOf: (id: string) => (id === 'holder' ? [0] : []),
    };
    state._setFleetStateSources({
      role: 'master', standalone: false, nodeId: 'm', nodeName: 'm', appVersion: '', pinnedShardId: null, capacity: 1, recommendedShards: null,
      runtime: { getCurrent: () => null }, ingest: {}, registry, controlClient: null, recovery: null, ledger: null, healthMonitor: null,
      refusedRegistrations: null, sync: null, migration: null, transformation: null, pinViolation: null, unassigned: null, termStamp: null,
      fleetConfig: null, witness: null, migrationActive: null,
    } as unknown as Parameters<typeof state._setFleetStateSources>[0]);
    expect(state.getFleetState().shardTable[0].status).toBe('Unknown');
  });
});
