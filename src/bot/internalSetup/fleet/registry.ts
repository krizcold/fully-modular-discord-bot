// Master-side fleet model: node table, shard-lease table and guild -> shard
// map, fed by registrations, heartbeats and guild notices.

import { performance } from 'perf_hooks';
import { HEARTBEAT_MS, LEASE_TTL_MS } from './constants';
import type {
  GuildNoticePayload,
  HeartbeatPayload,
  LeaseInfo,
  LoadSample,
  NodeCapabilities,
  ShardStatusEntry,
} from './protocol';
import { guildIdToShardId } from './placement';

export type NodeHealth = 'up' | 'late' | 'down';

export interface RegistryNode {
  nodeId: string;
  nodeName: string;
  appVersion: string;
  capabilities: NodeCapabilities;
  isSelf: boolean;
  connected: boolean;
  /** Set at (re)registration, cleared once a grant is acked; a rejoining node always gets a fresh grant. */
  needsGrant: boolean;
  lastHeartbeatAt: number | null;
  lastSeq: number;
  shards: ShardStatusEntry[];
  guildCount: number;
  load: LoadSample | null;
  send: ((message: object) => void) | null;
}

export interface ShardLease {
  shardId: number;
  nodeId: string;
  leaseId: string;
  term: number;
  epoch: number;
}

export class Registry {
  term = 0;
  epoch = 0;
  shardCount = 1;

  readonly nodes = new Map<string, RegistryNode>();
  readonly shardTable = new Map<number, ShardLease>();
  readonly guildMap = new Map<string, number>();

  upsertNode(input: {
    nodeId: string;
    nodeName: string;
    appVersion: string;
    capabilities: NodeCapabilities;
    isSelf: boolean;
    send: ((message: object) => void) | null;
  }): RegistryNode {
    const existing = this.nodes.get(input.nodeId);
    const node: RegistryNode = {
      nodeId: input.nodeId,
      nodeName: input.nodeName,
      appVersion: input.appVersion,
      capabilities: input.capabilities,
      isSelf: input.isSelf,
      connected: true,
      needsGrant: true,
      lastHeartbeatAt: existing?.lastHeartbeatAt ?? null,
      lastSeq: existing?.lastSeq ?? 0,
      shards: existing?.shards ?? [],
      guildCount: existing?.guildCount ?? 0,
      load: existing?.load ?? null,
      send: input.send,
    };
    this.nodes.set(input.nodeId, node);
    return node;
  }

  markDisconnected(nodeId: string): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    node.connected = false;
    node.send = null;
  }

  recordHeartbeat(nodeId: string, hb: HeartbeatPayload): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    // Out-of-order frames from a reconnecting socket must not roll the model back.
    if (hb.seq <= node.lastSeq && hb.seq !== 1) return;
    node.lastSeq = hb.seq;
    node.lastHeartbeatAt = performance.now();
    node.shards = Array.isArray(hb.shards) ? hb.shards : [];
    node.guildCount = Array.isArray(hb.guilds) ? hb.guilds.length : 0;
    node.load = hb.load ?? null;
    this.replaceNodeGuilds(nodeId, Array.isArray(hb.guilds) ? hb.guilds : []);
  }

  applyGuildNotice(notice: GuildNoticePayload): void {
    if (notice.kind === 'delete') {
      this.guildMap.delete(notice.guildId);
    } else {
      this.guildMap.set(notice.guildId, guildIdToShardId(notice.guildId, this.shardCount));
    }
  }

  applyAssignment(nodeId: string, leases: LeaseInfo[], term: number, epoch: number): void {
    this.clearNodeAssignment(nodeId);
    for (const lease of leases) {
      this.shardTable.set(lease.shardId, { shardId: lease.shardId, nodeId, leaseId: lease.leaseId, term, epoch });
    }
  }

  clearNodeAssignment(nodeId: string): void {
    for (const [shardId, lease] of this.shardTable) {
      if (lease.nodeId === nodeId) this.shardTable.delete(shardId);
    }
  }

  shardIdsOf(nodeId: string): number[] {
    const shardIds: number[] = [];
    for (const lease of this.shardTable.values()) {
      if (lease.nodeId === nodeId) shardIds.push(lease.shardId);
    }
    return shardIds.sort((a, b) => a - b);
  }

  healthOf(node: RegistryNode): NodeHealth {
    if (!node.connected && !node.isSelf) return 'down';
    if (node.lastHeartbeatAt === null) return 'late';
    const age = performance.now() - node.lastHeartbeatAt;
    if (age < HEARTBEAT_MS * 2.5) return 'up';
    if (age < LEASE_TTL_MS) return 'late';
    return 'down';
  }

  private replaceNodeGuilds(nodeId: string, guilds: string[]): void {
    const ownedShards = new Set(this.shardIdsOf(nodeId));
    for (const [guildId, shardId] of this.guildMap) {
      if (ownedShards.has(shardId)) this.guildMap.delete(guildId);
    }
    for (const guildId of guilds) {
      this.guildMap.set(guildId, guildIdToShardId(guildId, this.shardCount));
    }
  }
}
