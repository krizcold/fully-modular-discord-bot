// Read-only fleet state accessor. The web-UI consumes this over the existing
// fork IPC (a follow-up ipcFleetHandler answers 'fleet:state' with it).

import { performance } from 'perf_hooks';
import { CONTROL_PORT_DEFAULT, LEASE_TTL_MS, PROTOCOL_VERSION } from './constants';
import { getShardSource, isPinEnabled, resolveShardCapacity } from './placement';
import type { BudgetInfo, NodeRole } from './protocol';
import { isBackupMaster, readRoleOverride, resolveMasterUrls } from './nodeIdentity';
import { hasDbReplica } from './replicaPromotion';
import type { Registry } from './registry';
import type { LeaseRuntime } from './leaseRuntime';
import type { ControlClient } from './controlClient';
import type { HealthMonitor, LossEvent } from './healthMonitor';
import type { IdentifyLedger } from './identifyLedger';
import type { IngestService } from '../ingest/ingestService';
import { resolveDataBackend } from '../../../utils/envLoader';
import { getGuildDataBackend } from '../utils/dataManager';
import { getReplicaHealth, getStandbyLinks, startReplicaHealthSampler, StandbyLinkView } from './replicaHealth';
import type { ReplicaHealthReport } from './protocol';
import { getRouteOverrides } from '../utils/dataBackends/routeResolver';
import { getDataBootStatus, DataBootStatus } from '../utils/dataBackends/boot';
import type { TransformationView } from './transformation/transformationCoordinator';

export interface FleetStateNode {
  nodeId: string;
  nodeName: string;
  isSelf: boolean;
  isMaster: boolean;
  connected: boolean;
  health: 'up' | 'late' | 'down';
  appVersion: string;
  capabilities: { shardCapacity: number; dataBackend: string; backupMaster?: boolean; autoPromote?: boolean };
  capacity: number;
  onHold: boolean;
  shardIds: number[];
  guildCount: number;
  load: { cpuPct: number; rssMb: number; loopLagMs: number } | null;
  lastHeartbeatAgoMs: number | null;
  /** Ms since the health monitor confirmed the node down; null while up. */
  downSinceMs: number | null;
  draining: boolean;
  /** Active crash-loop identify backoff, from the master's ledger. */
  backoff: { crashCount: number; nextPermitInMs: number } | null;
  /** Last fully-applied sync revision from the node's heartbeats (master view); null when unreported. */
  syncAppliedRevision: number | null;
  /** The node's local database standby from its heartbeat; null when it has none. */
  dbReplica: ReplicaHealthReport | null;
}

export interface FleetRefusedRegistration {
  nodeName: string;
  reason: string;
  at: number;
}

export interface MigrationLegView {
  legId: string;
  shardId: number;
  from: string;
  to: string;
  guildsDone: number;
  guildsTotal: number;
  bytesSent: number;
  round: number;
  deltaFiles: number;
  legState?: string;
}

export interface MigrationActiveView {
  id: string;
  kind: string;
  state: string;
  currentLegIndex?: number;
  legs: MigrationLegView[];
  frozenWriteRejections: number;
  paused?: boolean;
  error?: string;
}

export interface MigrationView {
  active: MigrationActiveView | null;
  history: { id: string; kind: string; state: string; error?: string; updatedAt: number }[];
}

export interface PinViolationLeg {
  shardId: number;
  fromNodeId: string;
  toNodeId: string;
}

export interface PinViolationView {
  shardId: number;
  holderNodeId: string;
  proposedLegs: PinViolationLeg[] | null;
  reason?: string;
}

export interface FleetState {
  initialized: boolean;
  role: NodeRole;
  standalone: boolean;
  nodeId: string;
  nodeName: string;
  appVersion: string;
  /** CRITICAL: a control-store write observed a foreign term (two masters on one schema); granting is stopped until restart. */
  controlStoreFenced: { observedTerm: number; at: number } | null;
  /** Boot takeover guard: holding on a foreign term row that still advances (PLAN_STANDBY 3.2). */
  takeoverHold: TakeoverHoldView | null;
  /** Stale-master boot fence: parked because a live peer holds a term this node's own store cannot beat (PLAN_REPLICATION Stage 4). */
  staleMasterPark: StaleMasterParkView | null;
  /** Master self-fence latch: store silent + auto backup unreachable; sessions destroyed until restart (PLAN_STANDBY 3.8). */
  selfFenced: { at: number; reason: string } | null;
  /** Operator role override in force (promotion/demotion); null when the role comes from env. */
  roleOverride: { role: NodeRole; setBy: string; setAt: number } | null;
  /** This node is the designated backup master (FLEET_BACKUP_MASTER=1). */
  backupMaster: boolean;
  /** A manager-provisioned standby of the fleet database lives on this machine; promotion takes the pair. */
  dbReplica: boolean;
  /** Auto-promotion watcher status; null unless this node is an auto-enabled backup. */
  autoPromote: AutoPromoteStatusView | null;
  /** Fleet master: ms the term-row stamp has been failing; null while stamping succeeds (or off-postgres). */
  termStampFailingForMs: number | null;
  /** Co-worker: the ordered master candidate list in use. */
  masterUrls: string[];
  protocolVersion: number;
  term: number;
  epoch: number;
  shardCount: number;
  shardSource: 'discord' | 'override';
  /** Deployment-default data backend (resolveDataBackend()). */
  dataBackend: 'file' | 'postgres';
  /** Per-guild routing overrides while a backend transformation is active (this process's live resolver). */
  dataRouting?: { guildId: string; backend: 'file' | 'postgres' }[];
  /** Data-layer boot status: transformation-required banner, refusals; drives the Fleet-tab transformation surface. */
  dataBoot: DataBootStatus;
  recommendedShards: number | null;
  capacity: number;
  onHold: boolean;
  pinTestGuildShard: boolean;
  pinnedShardId: number | null;
  masterKnown: boolean;
  masterUrl: string | null;
  /**
   * Worker-onboarding block, master-only. masterUrl is the reachable control
   * endpoint: FLEET_PUBLIC_URL when the platform advertised one, else a
   * ws://<host>:<port> template the operator fills in. secret is the master's
   * own CONTROL_SECRET, returned only over the auth-gated web UI so operators
   * can copy-paste a worker's config. Never populated on a co-worker.
   */
  connect: {
    masterUrl: string;
    urlIsTemplate: boolean;
    controlPort: number;
    secretSet: boolean;
    secret?: string;
  } | null;
  /**
   * Restart-recovery block, fleet-mode master only (null standalone and on
   * co-workers). holdDownRemainingMs counts down the recovery hold-down on
   * FREE-pool distribution; reshardAdvised persists while the adopted
   * shardCount differs from Discord's recommendation (DECISION-1);
   * reshardApplied surfaces a confirmed reshard for one boot;
   * reshardNeedsConfirm persists while an override mismatch awaits
   * FLEET_CONFIRM_RESHARD; reshardPaused persists while the reshard pause
   * marker exists (no shard is assigned until resumed; its fields are null
   * when the marker is corrupt, since the pause fails closed).
   */
  recovery: {
    adopted: boolean;
    holdDownRemainingMs: number;
    reshardAdvised: { running: number; recommended: number } | null;
    reshardApplied: { from: number; to: number } | null;
    reshardNeedsConfirm: { from: number; to: number } | null;
    reshardPaused: { from: number | null; to: number | null; archivedAt: number | null } | null;
  } | null;
  /**
   * Sync status: co-worker from the SyncEngine, master revision from the
   * SyncAuthority; status 'n/a' standalone and on fleet masters (a master is
   * always its own source of truth).
   */
  sync: {
    revision?: number;
    appliedRevision?: number;
    status: 'waiting-master' | 'syncing' | 'in-sync' | 'degraded' | 'n/a';
    lastError?: string;
  };
  /** Identify budget: master from the ledger, worker from its last register/renewed copy, standalone null (card hidden). */
  budget: BudgetInfo | null;
  /** Node-loss event ring (down transitions + Declare Lost); master-only content. */
  lossLog: LossEvent[];
  /** Register refusals ring (VersionGate etc.); master-only content. */
  refusedRegistrations: FleetRefusedRegistration[];
  /** Co-worker only: lease still held while the master is unreachable. */
  servingOnCachedLease?: boolean;
  /** Co-worker only: ms until the cached lease expires without master contact; null when not on a cached lease. */
  cachedLeaseTtlRemainingMs?: number | null;
  /** Co-worker only: operator drain received; cleared on the next re-register. */
  draining?: boolean;
  /** Co-worker only: a migration/transformation executor leg is live on this node (promote precheck input). */
  migrationWorkActive?: boolean;
  /** Co-worker only: live data-backend reachability (postgres mode; the control store shares it in the default topology). null in file mode / pre-construction. Promote precheck input. */
  dataBackendHealthy?: boolean | null;
  leases: { leaseId: string; shardId: number; identifyDelayMs: number }[];
  nodes: FleetStateNode[];
  shardTable: { shardId: number; nodeId: string | null; leaseId: string | null; term: number; epoch: number; status: string; guildCount: number }[];
  guildMap: Record<string, number>;
  /** Active/recent migration status (master-only content); null when the subsystem is inert (standalone) or idle. */
  migration: MigrationView | null;
  /** Backend transformation status (any master incl. standalone); null on co-workers and when none has run. */
  transformation: TransformationView | null;
  /** Pin-restore proposal when the pinned shard sits off the master; null otherwise (master-only, never auto-executed). */
  pinViolation: PinViolationView | null;
  /** Names for guilds in guildMap the connected clients cannot name (master's REST list); merged UI-side. */
  guildNames?: Record<string, string>;
  /** Standbys attached to the fleet database, read by whoever serves it; null off-postgres or before the first read. */
  dbStandbys: StandbyLinkView[] | null;
  updatedAt: number;
}

export interface FleetRecoverySource {
  adopted: boolean;
  /** Epoch ms when the recovery hold-down ends; 0 when no hold-down is active. */
  holdDownUntil: number;
  reshardAdvised: { running: number; recommended: number } | null;
  reshardApplied: { from: number; to: number } | null;
  reshardNeedsConfirm: { from: number; to: number } | null;
  /** Mutable: fleetResumeAssignments nulls it so the pause banner drops without a restart. */
  reshardPaused: { from: number | null; to: number | null; archivedAt: number | null } | null;
}

// Control-store fence trip (two masters on one schema). Latched until restart,
// like the granting stop it accompanies; set by the master's onFenced hook.
let controlStoreFenced: { observedTerm: number; at: number } | null = null;

export function _setControlStoreFenced(observedTerm: number): void {
  controlStoreFenced = { observedTerm, at: Date.now() };
}

/** Boot takeover guard hold (PLAN_STANDBY 3.2): a foreign term row still advancing. */
export interface TakeoverHoldView {
  observedTerm: number;
  observedNodeId: string;
  observingForMs: number;
  requiredMs: number;
}

let takeoverHold: TakeoverHoldView | null = null;

export function _setTakeoverHold(hold: TakeoverHoldView | null): void {
  takeoverHold = hold;
}

/**
 * Stale-master boot fence (PLAN_REPLICATION Stage 4): a live peer holds a term
 * at least as fresh as this node's OWN term row, so the boot parked instead of
 * minting a term on what can only be a forked copy of the fleet database.
 * Terminal until an operator demotes; there is no timeout to wait out.
 */
export interface StaleMasterParkView {
  observedTerm: number;
  localTerm: number;
  peerUrl: string;
  at: number;
}

let staleMasterPark: StaleMasterParkView | null = null;

export function _setStaleMasterPark(park: StaleMasterParkView | null): void {
  staleMasterPark = park;
}

// Master self-fence latch (PLAN_STANDBY 3.8): store silent + auto backup gone.
// Latched until restart, exactly like the deposed fence.
let selfFenced: { at: number; reason: string } | null = null;

export function _setSelfFenced(reason: string): void {
  selfFenced = { at: Date.now(), reason };
}

/** Auto-promotion watcher status (designated backup only). */
export interface AutoPromoteStatusView {
  enabled: boolean;
  /** null before the first read attempt. */
  storeReadOk: boolean | null;
  /** Ms since the term row last advanced across this node's own reads; null before the first successful read. */
  termStaleForMs: number | null;
  fired: boolean;
}

function buildRoleOverrideView(): { role: NodeRole; setBy: string; setAt: number } | null {
  const override = readRoleOverride();
  return override ? { role: override.role, setBy: override.setBy, setAt: override.setAt } : null;
}

export interface FleetStateSources {
  role: NodeRole;
  standalone: boolean;
  nodeId: string;
  nodeName: string;
  appVersion: string;
  pinnedShardId: number | null;
  capacity: number;
  recommendedShards: number | null;
  runtime: LeaseRuntime;
  ingest: IngestService;
  registry: Registry | null;
  controlClient: ControlClient | null;
  recovery: FleetRecoverySource | null;
  ledger: IdentifyLedger | null;
  healthMonitor: HealthMonitor | null;
  refusedRegistrations: FleetRefusedRegistration[] | null;
  /** Sync block supplier: SyncAuthority-backed on a fleet master, SyncEngine-backed on a co-worker, null standalone. */
  sync: (() => FleetState['sync']) | null;
  /** Migration view supplier (fleet master only); null standalone and on co-workers. */
  migration: (() => MigrationView | null) | null;
  /** Transformation view supplier (any master incl. standalone); null on co-workers. */
  transformation: (() => TransformationView | null) | null;
  /** Pin-violation supplier (fleet master only); null otherwise. */
  pinViolation: (() => PinViolationView | null) | null;
  /** Term-stamp health supplier (fleet master on the postgres store only); null otherwise. */
  termStamp: (() => number | null) | null;
  /** Auto-promotion watcher status supplier (auto-enabled backup only); null otherwise. */
  autoPromote: (() => AutoPromoteStatusView | null) | null;
  /** Live migration/transformation work on THIS node (co-worker executors); null on masters (coordinator view covers it). */
  migrationActive: (() => boolean) | null;
}

let sources: FleetStateSources | null = null;

/** Wired once by fleet bootstrap. */
export function _setFleetStateSources(s: FleetStateSources): void {
  sources = s;
}

/**
 * Master-only worker-onboarding block. FLEET_PUBLIC_URL (injected by the
 * manager on a public platform) is the advertised wss endpoint; without it a
 * ws://<host>:<port> template is returned for the operator to fill in. The
 * secret is included only when set so the copy-paste block carries it.
 */
function buildConnect(): FleetState['connect'] {
  const controlPort = Number(process.env.CONTROL_PORT) || CONTROL_PORT_DEFAULT;
  const publicUrl = (process.env.FLEET_PUBLIC_URL || '').trim();
  const secret = (process.env.CONTROL_SECRET || '').trim();
  const urlIsTemplate = publicUrl === '';
  return {
    masterUrl: urlIsTemplate ? `ws://<host>:${controlPort}` : publicUrl,
    urlIsTemplate,
    controlPort,
    secretSet: secret !== '',
    secret: secret !== '' ? secret : undefined,
  };
}

export function getFleetState(): FleetState {
  // A master builds no heartbeats, so this is where its own sampler starts.
  startReplicaHealthSampler();
  if (!sources) {
    return {
      initialized: false,
      role: 'master',
      standalone: true,
      nodeId: '',
      nodeName: '',
      appVersion: '',
      controlStoreFenced: null,
      // Live during initFleet: the boot takeover guard and the stale-master
      // fence both hold BEFORE the state sources exist, and this pre-init
      // branch is what the UI polls then.
      takeoverHold,
      staleMasterPark,
      selfFenced,
      roleOverride: buildRoleOverrideView(),
      backupMaster: isBackupMaster(),
      dbReplica: hasDbReplica(),
      autoPromote: null,
      termStampFailingForMs: null,
      masterUrls: resolveMasterUrls(),
      protocolVersion: PROTOCOL_VERSION,
      term: 0,
      epoch: 0,
      shardCount: 0,
      shardSource: getShardSource(),
      dataBackend: resolveDataBackend(),
      dataRouting: getRouteOverrides(),
      dataBoot: getDataBootStatus(),
      recommendedShards: null,
      capacity: resolveShardCapacity(),
      onHold: false,
      pinTestGuildShard: isPinEnabled(),
      pinnedShardId: null,
      masterKnown: false,
      masterUrl: null,
      connect: null,
      recovery: null,
      sync: { status: 'n/a' },
      budget: null,
      lossLog: [],
      refusedRegistrations: [],
      leases: [],
      nodes: [],
      shardTable: [],
      guildMap: {},
      dbStandbys: null,
      migration: null,
      transformation: null,
      pinViolation: null,
      updatedAt: Date.now(),
    };
  }

  const { role, standalone, nodeId, nodeName, appVersion, pinnedShardId, capacity, recommendedShards, runtime, ingest, registry, controlClient, ledger, healthMonitor, refusedRegistrations } = sources;
  const lease = runtime.getCurrent();
  const leases = lease ? lease.leases.map(l => ({ ...l })) : [];

  if (role === 'master' && registry) {
    const statusByShard = new Map<number, string>();
    for (const node of registry.nodes.values()) {
      for (const entry of node.shards) statusByShard.set(entry.shardId, entry.status);
    }
    const nodes: FleetStateNode[] = [...registry.nodes.values()].map(node => ({
      nodeId: node.nodeId,
      nodeName: node.nodeName,
      isSelf: node.isSelf,
      isMaster: node.isSelf,
      connected: node.connected,
      health: registry.healthOf(node),
      appVersion: node.appVersion,
      capabilities: node.capabilities,
      capacity: node.capabilities?.shardCapacity ?? 1,
      onHold: !node.isSelf && node.connected && registry.shardIdsOf(node.nodeId).length === 0,
      shardIds: registry.shardIdsOf(node.nodeId),
      guildCount: node.guildCount,
      load: node.load,
      lastHeartbeatAgoMs: node.lastHeartbeatAt === null ? null : Math.round(performance.now() - node.lastHeartbeatAt),
      downSinceMs: node.downSince === null ? null : Math.round(performance.now() - node.downSince),
      draining: node.draining,
      backoff: ledger?.getNodeBackoff(node.nodeId) ?? null,
      syncAppliedRevision: node.syncAppliedRevision,
      // The master keeps no heartbeat of its own, so its standby is read locally.
      dbReplica: node.isSelf ? getReplicaHealth() ?? null : node.dbReplica,
    }));
    // Per-shard guild counts: prefer the REST-derived totals (cover unassigned
    // shards), fall back to the connection-derived guildMap before the first
    // REST fetch lands.
    const gmCounts = new Map<number, number>();
    for (const s of registry.guildMap.values()) gmCounts.set(s, (gmCounts.get(s) ?? 0) + 1);
    const guildsOnShard = (shardId: number): number =>
      registry.shardGuildTotals.get(shardId) ?? gmCounts.get(shardId) ?? 0;
    // Complete shard table: one entry per shardId. Held shards as leased, free
    // shards as unassigned, unacked grants as pending-confirmation (target node).
    const shardTable: FleetState['shardTable'] = [];
    for (let shardId = 0; shardId < registry.shardCount; shardId++) {
      const guildCount = guildsOnShard(shardId);
      const held = registry.shardTable.get(shardId);
      if (held) {
        // A disconnected holder's last heartbeat status would read live; the
        // row is frozen (Wait mode) until the node returns or is declared lost.
        const holder = registry.nodes.get(held.nodeId);
        const frozen = !holder || (!holder.connected && !holder.isSelf);
        shardTable.push({ shardId, nodeId: held.nodeId, leaseId: held.leaseId, term: held.term, epoch: held.epoch, status: frozen ? 'frozen' : statusByShard.get(shardId) ?? 'Unknown', guildCount });
        continue;
      }
      const pending = registry.pendingConfirmation.get(shardId);
      if (pending) {
        shardTable.push({ shardId, nodeId: pending.nodeId, leaseId: pending.leaseId, term: pending.term, epoch: pending.epoch, status: 'pending', guildCount });
        continue;
      }
      shardTable.push({ shardId, nodeId: null, leaseId: null, term: 0, epoch: 0, status: 'unassigned', guildCount });
    }
    return {
      initialized: true,
      role,
      standalone,
      nodeId,
      nodeName,
      appVersion,
      controlStoreFenced,
      takeoverHold,
      staleMasterPark,
      selfFenced,
      roleOverride: buildRoleOverrideView(),
      backupMaster: isBackupMaster(),
      dbReplica: hasDbReplica(),
      autoPromote: sources.autoPromote?.() ?? null,
      termStampFailingForMs: sources.termStamp?.() ?? null,
      masterUrls: resolveMasterUrls(),
      protocolVersion: PROTOCOL_VERSION,
      term: registry.term,
      epoch: registry.epoch,
      shardCount: registry.shardCount,
      shardSource: getShardSource(),
      dataBackend: resolveDataBackend(),
      dataRouting: getRouteOverrides(),
      dataBoot: getDataBootStatus(),
      recommendedShards,
      capacity,
      onHold: false,
      pinTestGuildShard: isPinEnabled(),
      pinnedShardId,
      masterKnown: true,
      masterUrl: null,
      connect: buildConnect(),
      recovery: sources.recovery
        ? {
            adopted: sources.recovery.adopted,
            holdDownRemainingMs: Math.max(0, sources.recovery.holdDownUntil - Date.now()),
            reshardAdvised: sources.recovery.reshardAdvised,
            reshardApplied: sources.recovery.reshardApplied,
            reshardNeedsConfirm: sources.recovery.reshardNeedsConfirm,
            reshardPaused: sources.recovery.reshardPaused,
          }
        : null,
      sync: sources.sync?.() ?? { status: 'n/a' },
      budget: ledger?.getBudgetInfo() ?? null,
      lossLog: healthMonitor?.getLossEvents() ?? [],
      refusedRegistrations: refusedRegistrations ?? [],
      leases,
      nodes,
      shardTable,
      // Full guild map: the master's REST list (every guild, incl. unassigned
      // shards) overlaid with the connection-derived map. Both use the same
      // guild -> shard formula, so the overlay only fills in any not-yet-fetched
      // guilds; the result lets Guilds-by-shard list unserved guilds too.
      guildMap: { ...Object.fromEntries(registry.restGuildShards), ...Object.fromEntries(registry.guildMap) },
      guildNames: Object.fromEntries(registry.restGuildNames),
      dbStandbys: getStandbyLinks() ?? null,
      migration: sources.migration?.() ?? null,
      transformation: sources.transformation?.() ?? null,
      pinViolation: sources.pinViolation?.() ?? null,
      updatedAt: Date.now(),
    };
  }

  // Co-worker view: this node only; the master owns the fleet-wide picture.
  const hb = runtime.getLastHeartbeat();
  const client = ingest.getClient();
  const guildMap: Record<string, number> = {};
  if (client && lease) {
    for (const guild of client.guilds.cache.values()) {
      guildMap[guild.id] = guild.shardId;
    }
  }
  const statusByShard = new Map<number, string>((hb?.shards ?? []).map(s => [s.shardId, s.status]));
  const term = controlClient?.getTerm() ?? lease?.term ?? 0;
  const registered = controlClient?.masterKnown() ?? false;
  const onHold = registered && leases.length === 0;
  const shardCount = lease?.shardCount ?? 0;
  const draining = controlClient?.isDraining() ?? false;
  const servingOnCachedLease = !registered && runtime.hasCurrentLease();
  const lastContactAgoMs = controlClient?.getLastContactAgoMs() ?? null;
  const cachedLeaseTtlRemainingMs = servingOnCachedLease
    ? Math.max(0, LEASE_TTL_MS - (lastContactAgoMs ?? LEASE_TTL_MS))
    : null;
  // Complete shard table from this node's own leases; the master owns the
  // fleet-wide picture, so shards this node does not hold read as unassigned.
  const leaseByShard = new Map<number, { leaseId: string; shardId: number; identifyDelayMs: number }>(leases.map(l => [l.shardId, l]));
  // This node only knows guilds on shards it holds (own client); shards it does
  // not hold read 0 here (the master has the fleet-wide REST-derived totals).
  const ownShardCounts = new Map<number, number>();
  for (const s of Object.values(guildMap)) ownShardCounts.set(s, (ownShardCounts.get(s) ?? 0) + 1);
  const shardTable: FleetState['shardTable'] = [];
  for (let shardId = 0; shardId < shardCount; shardId++) {
    const guildCount = ownShardCounts.get(shardId) ?? 0;
    const l = leaseByShard.get(shardId);
    if (l) {
      shardTable.push({ shardId, nodeId, leaseId: l.leaseId, term: lease?.term ?? term, epoch: lease?.epoch ?? 0, status: statusByShard.get(shardId) ?? 'Unknown', guildCount });
    } else {
      shardTable.push({ shardId, nodeId: null, leaseId: null, term: 0, epoch: 0, status: 'unassigned', guildCount });
    }
  }
  return {
    initialized: true,
    role,
    standalone: false,
    nodeId,
    nodeName,
    appVersion,
    controlStoreFenced: null,
    takeoverHold,
    staleMasterPark,
    selfFenced,
    roleOverride: buildRoleOverrideView(),
    backupMaster: isBackupMaster(),
    dbReplica: hasDbReplica(),
    autoPromote: sources.autoPromote?.() ?? null,
    termStampFailingForMs: null,
    masterUrls: resolveMasterUrls(),
    protocolVersion: PROTOCOL_VERSION,
    term,
    epoch: lease?.epoch ?? 0,
    shardCount,
    shardSource: getShardSource(),
    dataBackend: resolveDataBackend(),
    dataRouting: getRouteOverrides(),
    dataBoot: getDataBootStatus(),
    recommendedShards,
    capacity,
    onHold,
    pinTestGuildShard: isPinEnabled(),
    pinnedShardId: null,
    masterKnown: registered,
    masterUrl: controlClient?.getCurrentMasterUrl() ?? resolveMasterUrls()[0] ?? null,
    connect: null,
    recovery: null,
    sync: sources.sync?.() ?? { status: 'n/a' },
    budget: controlClient?.getLastBudget() ?? null,
    lossLog: [],
    refusedRegistrations: [],
    servingOnCachedLease,
    cachedLeaseTtlRemainingMs,
    draining,
    migrationWorkActive: sources.migrationActive?.() ?? false,
    dataBackendHealthy: getGuildDataBackend()?.healthy() ?? null,
    leases,
    nodes: [
      {
        nodeId,
        nodeName,
        isSelf: true,
        isMaster: false,
        connected: true,
        health: 'up',
        appVersion,
        capabilities: { shardCapacity: capacity, dataBackend: resolveDataBackend() },
        capacity,
        onHold,
        shardIds: leases.map(l => l.shardId).sort((a, b) => a - b),
        guildCount: Object.keys(guildMap).length,
        load: hb?.load ?? null,
        lastHeartbeatAgoMs: null,
        downSinceMs: null,
        draining,
        backoff: null,
        syncAppliedRevision: sources.sync?.().appliedRevision ?? null,
        dbReplica: getReplicaHealth() ?? null,
      },
    ],
    shardTable,
    guildMap,
    dbStandbys: getStandbyLinks() ?? null,
    migration: null,
    transformation: null,
    pinViolation: null,
    updatedAt: Date.now(),
  };
}
