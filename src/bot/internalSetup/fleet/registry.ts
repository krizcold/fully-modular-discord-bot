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

/**
 * A grant whose ack was lost. The worker may have applied it despite the lost
 * ack, so the shard is NOT free (granting it elsewhere would dual-identify).
 * Resolved by heartbeat truth: reconcilePending() confirms or frees it.
 */
export interface PendingLease {
  shardId: number;
  nodeId: string;
  leaseId: string;
  term: number;
  epoch: number;
  grantedAt: number;
}

export class Registry {
  term = 0;
  epoch = 0;
  shardCount = 1;

  readonly nodes = new Map<string, RegistryNode>();
  readonly shardTable = new Map<number, ShardLease>();
  readonly pendingConfirmation = new Map<number, PendingLease>();
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

  clearPendingForNode(nodeId: string): void {
    for (const [shardId, pending] of this.pendingConfirmation) {
      if (pending.nodeId === nodeId) this.pendingConfirmation.delete(shardId);
    }
  }

  shardIdsOf(nodeId: string): number[] {
    const shardIds: number[] = [];
    for (const lease of this.shardTable.values()) {
      if (lease.nodeId === nodeId) shardIds.push(lease.shardId);
    }
    return shardIds.sort((a, b) => a - b);
  }

  /**
   * A shard is FREE when it is unassigned, not pending-confirmation and not
   * frozen. Shards leased to a currently-disconnected node stay in shardTable,
   * so they read as held here (Wait mode; never auto-moved).
   */
  freeShards(): number[] {
    const free: number[] = [];
    for (let shardId = 0; shardId < this.shardCount; shardId++) {
      if (this.shardTable.has(shardId)) continue; // held (live or frozen)
      if (this.pendingConfirmation.has(shardId)) continue;
      free.push(shardId);
    }
    return free;
  }

  /**
   * Resolve pending-confirmation shards from heartbeat truth. Heartbeats that
   * reach the registry are already valid-term (the control server fences stale
   * terms), so a target node's reported shard set is authoritative once a
   * heartbeat lands AFTER the grant: present -> confirm the lease; absent ->
   * the grant never took, free the shard.
   */
  reconcilePending(): void {
    for (const [shardId, pending] of this.pendingConfirmation) {
      const node = this.nodes.get(pending.nodeId);
      if (!node) {
        this.pendingConfirmation.delete(shardId);
        continue;
      }
      if (!node.connected) {
        // Target vanished mid-pending: adopt it as that node's (now frozen)
        // lease so Wait mode holds it until Declare Lost, rather than granting
        // a maybe-identified shard to someone else.
        this.shardTable.set(shardId, { shardId, nodeId: pending.nodeId, leaseId: pending.leaseId, term: pending.term, epoch: pending.epoch });
        this.pendingConfirmation.delete(shardId);
        continue;
      }
      if (node.lastHeartbeatAt === null || node.lastHeartbeatAt <= pending.grantedAt) continue;
      if (node.shards.some(s => s.shardId === shardId)) {
        this.shardTable.set(shardId, { shardId, nodeId: pending.nodeId, leaseId: pending.leaseId, term: pending.term, epoch: pending.epoch });
      }
      this.pendingConfirmation.delete(shardId);
    }
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
