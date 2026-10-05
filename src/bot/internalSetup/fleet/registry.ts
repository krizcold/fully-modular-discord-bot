// Master-side fleet model: node table, shard-lease table and guild -> shard
// map, fed by registrations, heartbeats and guild notices.

import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import { HEALTH_DOWN_MS, HEALTH_LATE_MS } from './constants';
import type {
  GuildNoticePayload,
  HeartbeatPayload,
  LeaseInfo,
  LoadSample,
  NodeCapabilities,
  RegisterPayload,
  ShardStatusEntry,
  MirrorReport,
  ReplicaHealthReport,
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
  /** Worker's cached lease summary from its last register, reconciled right after acceptance. */
  heldLeases: RegisterPayload['heldLeases'];
  /** performance.now() when the health monitor confirmed this node down; null while up. */
  downSince: number | null;
  /** Operator drain: excluded from placement until the node re-registers. */
  draining: boolean;
  /** performance.now() of the last (re)registration; heartbeat-derived held sets are trusted only when newer. */
  registeredAt: number;
  /** shardCount from the node's last accepted heartbeat; null when it carried none. */
  lastShardCount: number | null;
  /** leaseIds from the node's most recent LEASE_RENEW; drain revokes union them in. */
  lastRenewLeaseIds: string[] | null;
  lastHeartbeatAt: number | null;
  lastSeq: number;
  shards: ShardStatusEntry[];
  guildCount: number;
  load: LoadSample | null;
  /** Last fully-applied sync revision from the node's heartbeats; null before the first one. */
  syncAppliedRevision: number | null;
  /** Last heartbeat's data-backend reachability; null when unreported (file mode). */
  dataBackendHealthy: boolean | null;
  /** Free bytes on the node's data volume from its last heartbeat; null when unreported. */
  freeDiskBytes: number | null;
  /** The node's local database standby from its last heartbeat; null when it has none. */
  dbReplica: ReplicaHealthReport | null;
  /** The slot that standby streams on, from the same heartbeat; null when unreported (20.19 F14). */
  dbReplicaSlot: string | null;
  /** The node's guild-data mirror report from its last heartbeat (B4f-1); null when it reports none. */
  mirror: MirrorReport | null;
  /** False while the node's last reconcile ended degraded; null when unreported. */
  syncOk: boolean | null;
  /** When this node last had a write's synchronous wait cancelled, in ITS clock; null when never (B6 map F24). */
  syncWaitCancelledAt: number | null;
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
  /** Free shards a grant carries to a node until it settles (shard id to node id): off the free pool. */
  readonly inFlight = new Map<number, string>();
  readonly guildMap = new Map<string, number>();
  // Fleet-wide guild count per shard from the master's REST guild list, so
  // unassigned shards (no gateway session) still report their real guild count.
  readonly shardGuildTotals = new Map<number, number>();
  // Full guild -> shard map and names from the master's REST guild list, so the
  // Guilds-by-shard view lists guilds on unassigned shards too (which the
  // connection-derived guildMap never sees).
  readonly restGuildShards = new Map<string, number>();
  readonly restGuildNames = new Map<string, string>();

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
      heldLeases: null,
      downSince: null,
      draining: false,
      registeredAt: performance.now(),
      lastShardCount: existing?.lastShardCount ?? null,
      lastRenewLeaseIds: null,
      lastHeartbeatAt: existing?.lastHeartbeatAt ?? null,
      lastSeq: existing?.lastSeq ?? 0,
      shards: existing?.shards ?? [],
      guildCount: existing?.guildCount ?? 0,
      load: existing?.load ?? null,
      syncAppliedRevision: existing?.syncAppliedRevision ?? null,
      syncOk: existing?.syncOk ?? null,
      dataBackendHealthy: existing?.dataBackendHealthy ?? null,
      dbReplica: existing?.dbReplica ?? null,
      dbReplicaSlot: existing?.dbReplicaSlot ?? null,
      mirror: existing?.mirror ?? null,
      syncWaitCancelledAt: existing?.syncWaitCancelledAt ?? null,
      freeDiskBytes: existing?.freeDiskBytes ?? null,
      send: input.send,
    };
    this.nodes.set(input.nodeId, node);
    return node;
  }

  /** Seed a node from the persisted registry at recovery boot: known but not connected, awaiting its re-register. */
  restoreNode(input: {
    nodeId: string;
    nodeName: string;
    appVersion: string;
    capabilities: NodeCapabilities;
  }): RegistryNode {
    const node: RegistryNode = {
      nodeId: input.nodeId,
      nodeName: input.nodeName,
      appVersion: input.appVersion,
      capabilities: input.capabilities,
      isSelf: false,
      connected: false,
      needsGrant: true,
      heldLeases: null,
      downSince: null,
      draining: false,
      registeredAt: performance.now(),
      lastShardCount: null,
      lastRenewLeaseIds: null,
      lastHeartbeatAt: null,
      lastSeq: 0,
      shards: [],
      guildCount: 0,
      load: null,
      syncAppliedRevision: null,
      syncOk: null,
      dataBackendHealthy: null,
      dbReplica: null,
      dbReplicaSlot: null,
      mirror: null,
      syncWaitCancelledAt: null,
      freeDiskBytes: null,
      send: null,
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
    node.lastShardCount = typeof hb.shardCount === 'number' && Number.isInteger(hb.shardCount) ? hb.shardCount : null;
    node.shards = Array.isArray(hb.shards) ? hb.shards : [];
    node.guildCount = Array.isArray(hb.guilds) ? hb.guilds.length : 0;
    node.load = hb.load ?? null;
    if (Number.isInteger(hb.syncAppliedRevision)) node.syncAppliedRevision = hb.syncAppliedRevision!;
    if (typeof hb.syncOk === 'boolean') node.syncOk = hb.syncOk;
    if (typeof hb.dataBackendHealthy === 'boolean') node.dataBackendHealthy = hb.dataBackendHealthy;
    if (hb.dbReplica !== undefined) node.dbReplica = hb.dbReplica;
    // Empty = this node holds no standby now, so its old claim is dropped.
    if (typeof hb.dbReplicaSlot === 'string') node.dbReplicaSlot = hb.dbReplicaSlot || null;
    // Absent = this node keeps no mirror now (a backup demoted to a plain co-worker), so the old report goes.
    node.mirror = hb.mirror ?? null;
    // Never moves backwards: a node that restarts loses its latch, and adopting
    // the lower value would re-fire a disarm the master has already acted on.
    if (Number.isFinite(hb.syncWaitCancelledAt) && Number(hb.syncWaitCancelledAt) > (node.syncWaitCancelledAt ?? 0)) {
      node.syncWaitCancelledAt = Number(hb.syncWaitCancelledAt);
    }
    if (Number.isFinite(hb.freeDiskBytes)) node.freeDiskBytes = hb.freeDiskBytes!;
    this.replaceNodeGuilds(nodeId, Array.isArray(hb.guilds) ? hb.guilds : []);
    this.adoptHeartbeatClaims(nodeId, hb);
  }

  /**
   * Adopt heartbeat truth for shards a node reports live that are recorded
   * nowhere (the grant-then-crash window): the claim becomes that node's
   * lease and Phase R re-issues its full set under the current term.
   */
  adoptHeartbeatClaims(nodeId: string, hb: HeartbeatPayload): void {
    // Adoption fence (network input): only claims made under the CURRENT
    // shardCount are meaningful shard ids. A mid-reshard straggler still
    // serving old-count shards for a few heartbeats (revoke completes async)
    // must never populate the new-count table.
    if (!Number.isInteger(hb.shardCount) || hb.shardCount !== this.shardCount) return;
    const node = this.nodes.get(nodeId);
    if (!node) return;
    // A draining node's claims are teardown residue: the drain retry revokes
    // them off this same heartbeat; adopting would resurrect a revoked lease.
    if (node.draining) return;
    let adopted = false;
    for (const entry of Array.isArray(hb.shards) ? hb.shards : []) {
      if (!Number.isInteger(entry?.shardId) || entry.shardId < 0 || entry.shardId >= this.shardCount) continue;
      if (entry.status === 'NotStarted') continue;
      if (this.shardTable.has(entry.shardId)) continue;
      if (this.pendingConfirmation.has(entry.shardId)) continue;
      if ((this.inFlight.get(entry.shardId) ?? nodeId) !== nodeId) continue;
      this.shardTable.set(entry.shardId, {
        shardId: entry.shardId,
        nodeId,
        leaseId: randomUUID(),
        term: hb.term,
        epoch: this.epoch,
      });
      adopted = true;
      console.log(`[Fleet] Adopted heartbeat-claimed shard ${entry.shardId} from node ${node.nodeName}`);
    }
    if (adopted) node.needsGrant = true;
  }

  applyGuildNotice(notice: GuildNoticePayload): void {
    if (notice.kind === 'delete') {
      this.guildMap.delete(notice.guildId);
    } else {
      this.guildMap.set(notice.guildId, guildIdToShardId(notice.guildId, this.shardCount));
    }
  }

  /** Recompute per-shard totals, the full guild -> shard map and names from the master's REST guild list. */
  setAllGuilds(guilds: { id: string; name: string }[]): void {
    this.shardGuildTotals.clear();
    this.restGuildShards.clear();
    this.restGuildNames.clear();
    for (const g of guilds) {
      const shardId = guildIdToShardId(g.id, this.shardCount);
      this.shardGuildTotals.set(shardId, (this.shardGuildTotals.get(shardId) ?? 0) + 1);
      this.restGuildShards.set(g.id, shardId);
      this.restGuildNames.set(g.id, g.name);
    }
  }

  /**
   * An acked grant; another node's stamp on a granted shard is dropped and
   * returned for the master to revoke. The node's entries the master wrote at
   * a newer epoch (an abort's rollback, a restore) stand for the next grant.
   */
  applyAssignment(nodeId: string, leases: LeaseInfo[], term: number, epoch: number): { nodeId: string; leaseId: string }[] {
    for (const [shardId, lease] of this.shardTable) {
      if (lease.nodeId === nodeId && lease.epoch <= epoch) this.shardTable.delete(shardId);
    }
    const strays: { nodeId: string; leaseId: string }[] = [];
    for (const lease of leases) {
      this.shardTable.set(lease.shardId, { shardId: lease.shardId, nodeId, leaseId: lease.leaseId, term, epoch });
      const stamped = this.pendingConfirmation.get(lease.shardId);
      if (stamped && stamped.nodeId !== nodeId) {
        strays.push({ nodeId: stamped.nodeId, leaseId: stamped.leaseId });
        this.pendingConfirmation.delete(lease.shardId);
      }
    }
    return strays;
  }

  clearNodeAssignment(nodeId: string): void {
    for (const [shardId, lease] of this.shardTable) {
      if (lease.nodeId === nodeId) this.shardTable.delete(shardId);
    }
  }

  /**
   * Mark a maybe-applied grant's NEW shards pending-confirmation (NOT free)
   * so they are never granted elsewhere and dual-identified. A shard the
   * table records (the node's own, or another node's placed there since: a
   * Declare Lost during the ack wait re-places the node's shards) or another
   * node's stamp records is left as it is.
   */
  stampPendingGrant(nodeId: string, leases: LeaseInfo[], epoch: number): number[] {
    const pendingIds: number[] = [];
    for (const lease of leases) {
      if (this.shardTable.has(lease.shardId)) continue;
      const stamped = this.pendingConfirmation.get(lease.shardId);
      if (stamped && stamped.nodeId !== nodeId) continue;
      this.pendingConfirmation.set(lease.shardId, {
        shardId: lease.shardId,
        nodeId,
        leaseId: lease.leaseId,
        term: this.term,
        epoch,
        grantedAt: performance.now(),
      });
      pendingIds.push(lease.shardId);
    }
    return pendingIds;
  }

  /** The node's stamped shards, but for one the table records under another node (the reconcile drops that stamp). */
  pendingShardIdsOf(nodeId: string): number[] {
    const ids: number[] = [];
    for (const pending of this.pendingConfirmation.values()) {
      if (pending.nodeId !== nodeId) continue;
      const placed = this.shardTable.get(pending.shardId);
      if (placed && placed.nodeId !== nodeId) continue;
      ids.push(pending.shardId);
    }
    return ids;
  }

  /** The node's leases among a grant's whose shard the table or a stamp records under another node. */
  placedElsewhere(nodeId: string, leases: LeaseInfo[]): { nodeId: string; leaseId: string }[] {
    return leases.filter(l => {
      const owner = this.shardTable.get(l.shardId)?.nodeId ?? this.pendingConfirmation.get(l.shardId)?.nodeId;
      return owner !== undefined && owner !== nodeId;
    }).map(l => ({ nodeId, leaseId: l.leaseId }));
  }

  /** The node's pending grants among shardIds, held as its leases (frozen while it is not connected). */
  holdPendingAsLeases(nodeId: string, shardIds: number[]): void {
    for (const shardId of shardIds) {
      const pending = this.pendingConfirmation.get(shardId);
      if (pending?.nodeId !== nodeId) continue;
      this.pendingConfirmation.delete(shardId);
      // Placed on another node since: that record stands (the node's register
      // revokes a session it kept).
      const placed = this.shardTable.get(shardId);
      if (placed && placed.nodeId !== nodeId) continue;
      this.shardTable.set(shardId, { shardId, nodeId, leaseId: pending.leaseId, term: pending.term, epoch: pending.epoch });
    }
  }

  /** A shard the master places on a node holding its copy; the next re-grant sends it. */
  placeOnHolder(nodeId: string, shardId: number): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    this.shardTable.set(shardId, { shardId, nodeId, leaseId: randomUUID(), term: this.term, epoch: this.epoch });
    node.needsGrant = true;
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
      if (this.inFlight.has(shardId)) continue;
      free.push(shardId);
    }
    return free;
  }

  /**
   * Resolve pending-confirmation shards from heartbeat truth. Heartbeats that
   * reach the registry are already valid-term (the control server fences stale
   * terms), so a target node's reported shard set is authoritative once a
   * heartbeat lands AFTER the grant: present -> confirm the lease, unless the
   * shard was placed on another node since (that record stands, and the
   * session is returned for the master to revoke); absent -> the grant never
   * took, free the shard.
   */
  reconcilePending(): { nodeId: string; leaseId: string }[] {
    const confirmedNodes = new Set<string>();
    const strays: { nodeId: string; leaseId: string }[] = [];
    for (const [shardId, pending] of this.pendingConfirmation) {
      const node = this.nodes.get(pending.nodeId);
      if (!node) {
        this.pendingConfirmation.delete(shardId);
        continue;
      }
      // A draining node's pending grants resolve through the drain teardown
      // (revoke retry / Declare Lost), never by confirmation into the table.
      if (node.draining) continue;
      if (!node.connected) {
        // Target vanished mid-pending: adopt it as that node's (now frozen)
        // lease so Wait mode holds it until Declare Lost, rather than granting
        // a maybe-identified shard to someone else.
        this.holdPendingAsLeases(pending.nodeId, [shardId]);
        continue;
      }
      if (node.lastHeartbeatAt === null || node.lastHeartbeatAt <= pending.grantedAt) continue;
      if (node.shards.some(s => s.shardId === shardId)) {
        const placed = this.shardTable.get(shardId);
        if (placed && placed.nodeId !== pending.nodeId) {
          strays.push({ nodeId: pending.nodeId, leaseId: pending.leaseId });
        } else {
          this.shardTable.set(shardId, { shardId, nodeId: pending.nodeId, leaseId: pending.leaseId, term: pending.term, epoch: pending.epoch });
          confirmedNodes.add(pending.nodeId);
        }
      }
      this.pendingConfirmation.delete(shardId);
    }
    // Heartbeat proved those sessions live: refresh the node's held snapshot
    // so the identify mirror charges 0 for the follow-up same-set re-grant.
    for (const nodeId of confirmedNodes) {
      const node = this.nodes.get(nodeId);
      if (!node) continue;
      node.heldLeases = {
        term: this.term,
        epoch: this.epoch,
        shardCount: this.shardCount,
        leases: [...this.shardTable.values()]
          .filter(l => l.nodeId === nodeId)
          .map(l => ({ leaseId: l.leaseId, shardId: l.shardId })),
      };
    }
    return strays;
  }

  healthOf(node: RegistryNode): NodeHealth {
    if (!node.connected && !node.isSelf) return 'down';
    if (node.lastHeartbeatAt === null) return 'late';
    const age = performance.now() - node.lastHeartbeatAt;
    if (age < HEALTH_LATE_MS) return 'up';
    if (age < HEALTH_DOWN_MS) return 'late';
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
