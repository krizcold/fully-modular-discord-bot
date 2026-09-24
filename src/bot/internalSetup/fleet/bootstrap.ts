// Fleet boot orchestration: role resolution, control-plane wiring, shard
// placement. The master claims up to ITS capacity, or every shard while no
// other node can hold any, and grants workers only FREE shards; owned shards
// move exclusively through the (future) migration system, never
// automatically. Standalone IS the master path claiming every shard,
// byte-identical to today's single-box boot.

import { performance } from 'perf_hooks';
import type { Client } from 'discord.js';
import { getIngestService } from '../ingest/ingestService';
import {
  CONTROL_PORT_DEFAULT,
  GUILD_TOTALS_REFRESH_MS,
  HEARTBEAT_MS,
  DECLINE_COOLDOWN_MS,
  INCOMING_RESOLVE_INTERVAL_MS,
  LEASE_RENEW_MS,
  LOSS_LOG_CAP,
  PEER_TERM_PROBE_BUDGET_MS,
  PEER_TERM_PROBE_MS,
  PROTOCOL_VERSION,
  RECOVERY_HOLDDOWN_MS,
  REGISTER_GRACE_MS,
  TERM_GUARD_POLL_MS,
  TERM_STAMP_MS,
  TERM_TAKEOVER_STALE_MS,
  XFER_COMMIT_RETRY_MS,
} from './constants';
import { DataBackendInfo, FleetConfigPayload, HeartbeatPayload, LeaseGrantPayload, LeaseInfo, LeaseRenewedPayload, LeaseRevokePayload, MSG, NodeCapabilities, NodeDrainPayload, NodeRole, RegisterPayload, RegisterResult, SlotStatusPayload, SyncPosturePayload } from './protocol';
import {
  clearRoleOverride,
  consentsToActiveMode,
  consumeTakeoverFlags,
  getAppVersion,
  getNodeId,
  getNodeName,
  invalidateRoleOverrideCache,
  isBackupMaster,
  isStandalone,
  isStandInBoot,
  rawMasterUrls,
  readRoleOverride,
  resolveEnvRole,
  resolveNodeRole,
  wasNodeIdFreshlyGenerated,
  writeRoleOverride,
} from './nodeIdentity';
import { ControlStoreReadOnlyError, createStandInControlStore, prepareControlStore, PostgresControlStore } from './postgresControlStore';
import { ArmRecord, readArmRecord, writeArmRecord } from './armRecord';
import { closeStandInLane, rememberLineageVerdict, seizedEpisode, standInEnding, writeEpisodeRecordOrWarn } from './episodeRecord';
import { backupModeEnabled, leverRank, readModeOverride } from './modeOverride';
import { clearOwnSyncPosture } from './syncPosture';
import { Registry, RegistryNode } from './registry';
import { ControlServer } from './controlServer';
import { ControlClient } from './controlClient';
import { LeaseRuntime } from './leaseRuntime';
import { HealthMonitor } from './healthMonitor';
import { IdentifyLedger } from './identifyLedger';
import {
  assignIdentifyDelays,
  declaredCapacityOf,
  fetchAllGuilds,
  fetchGatewayInfo,
  getShardCountOverride,
  guildIdToShardId,
  otherNodeCanHoldShards,
  overCapacityOf,
  pickFreePlacements,
  resolvePinnedShardId,
  resolveShardCapacity,
  resolveShardCount,
} from './placement';
import { evaluateRecovery } from './recovery';
import { _setControlStoreFenced, _setEmptyStoreHold, _setFleetStateSources, _setFollowerFollowingSupplier, _setFollowerHold, _setFollowerLineage, _setOwnCopyLineage, _setReadOnlyStorePark, _setSlotStatus, _setStaleMasterPark, _setSuperseded, _setTakeoverHold, FleetRecoverySource, FleetRefusedRegistration, FollowerHoldBase, getFleetState } from './state';
import type { MigrationView, PinViolationView, UnassignedView } from './state';
import { serveSyncRequest, SyncAuthority } from './syncAuthority';
import { SyncEngine } from './syncEngine';
import { getFrozenStats, getGuildDataBackend, setOwnerInfoProvider } from '../utils/dataManager';
import {
  applyOperatorDataRead,
  applyOperatorDataWrite,
  GuildDataReadRequest,
  GuildDataWriteRequest,
  setDataOpForwarder,
} from '../utils/ipcDataHandler';
import { applyDeliveredBackend, ensureRuntimeWith, getActiveBackendUrl, getDataBootStatus, getDeliveredBackendUrls, hasDelivery, holdOwnRuntimeForDelivery, pickDeliveredUrl, repointRuntimeForThisProcess } from '../utils/dataBackends/boot';
import { setLeaseDeclineHandler } from '../utils/dataBackends/dataReadiness';
import { applyRouteOverrides, currentRouteDefault } from '../utils/dataBackends/routeResolver';
import { loadCredentials, resolveDataBackend, upsertCredentials } from '../../../utils/envLoader';
import { MigrationDisposition, resolveIncomingWithMaster, resumeSourceGraveyarding, runResidueSweep } from './migration/residueSweep';
import { MigrationCoordinator, PrecheckResult, StartPayload } from './migration/migrationCoordinator';
import { MigrationExecutor } from './migration/migrationExecutor';
import { TransformationCoordinator } from './transformation/transformationCoordinator';
import { TransformationExecutor } from './transformation/transformationExecutor';
import type { ControlStore, PersistedFleetConfig, PersistedTerm, TransformDirection } from './controlStore';
import { effectiveFleetConfigView, effectiveMasterUrls, emptyStoreHoldEvidence, fleetConfigViewOf, forcePassive, readFleetConfigCache, rememberBackups, validateMasterCandidates, renumberDesignations, validateBackupDesignations, validateWitnessChannelId, writeFleetConfigCache } from './fleetConfig';
import { getLocalReplicaIdentity, getReplicaHealth, getSlotSample, setReplicaProbeListener } from './replicaHealth';
import { canonicalIsOwnReplica, canonicalStoreReachable, currentCanonicalUrl, hasDbReplica, probeReplica, readTermRow, resolveReplicaEndpoints, spliceFleetCredentials } from './replicaPromotion';
import { ArmEvidenceInputs, armDeferral, evaluateArmEvidence, ledgerAllowsArm, preArmRefusal, reachabilityWarning } from './armLane';
import { StandInWriteContext, evaluateStandInWrites } from './armWrites';
import { readReshardPending, readStandbyTermRow } from './armProbe';
import { clearSlotStatus, readSlotStatus, recordFromPush, sourceMatchesAny, writeSlotStatus } from './slotStatus';
import { startSyncPostureEngine, SyncPostureEngine, SyncPostureTarget } from './syncPostureEngine';
import { clearSyncPostureRecord, recordFromPosturePush, writeSyncPostureRecord } from './syncPostureFact';
import { BeaconFacts, DiscordWitness, FleetWitness, startWitnessLoop, WitnessStatus } from './witness';
import { probePeerTerm } from './peerTermProbe';
import { probeStoreEmpty } from './emptyStore';
import { readPromoteRecord, writePromoteRecord } from './promoteRecord';
import { clearHolderSighting, noteHolderSighting, readHolderSighting } from './holderSighting';
import { judgeLineage, LINEAGE_REFRESH_MS, LineageFact } from './lineage';
import {
  clearFreshFleetConfirm,
  clearSuperseded,
  copyBlockEndpoint,
  freshHigherTermClaim,
  freshMasterClaim,
  hasFreshFleetConfirm,
  notifyStepDown,
  readCopyBlock,
  readSuperseded,
  requestStepDownRestart,
  SupersededSource,
  witnessWinner,
  writeCopyBlock,
  writeSuperseded,
} from './stepDown';
import { ARM_MAX_ATTEMPTS, LEASE_TTL_MS, STANDIN_FENCE_HOLD_MS, STEP_DOWN_NOTIFY_MS, STEPDOWN_FALLBACK_MS, STEPDOWN_HANDOVER_DELAY_MS, WITNESS_FRESH_WINDOW_MS } from './constants';
import type { StepDownPayload } from './protocol';
import { planPinRestoreLegs } from './placement';
import { TRANSFER_PORT_DEFAULT } from './constants';

export interface FleetContext {
  role: NodeRole;
  standalone: boolean;
  nodeId: string;
  nodeName: string;
  attachClient(client: Client): void;
  startIngest(token: string | undefined): void;
  /** Boot gate: instant on master + standalone; a co-worker blocks until its first verified reconcile. */
  awaitSyncReady(): Promise<void>;
}

let context: FleetContext | null = null;

export function getFleetContext(): FleetContext | null {
  return context;
}

// Unsolicited fleet-status push (migration progress rides the existing
// bot:fleet:status WS push; no new WS event). Defined here to avoid an import
// cycle with ipcFleetHandler (which imports this module).
function pushFleetStatusNow(): void {
  if (!process.send) return;
  try {
    process.send({ type: 'fleet:status', data: getFleetState() });
  } catch { /* push must never take the bot down */ }
}

export type AssignResult = { success: boolean; error?: string };

// Master-only manual FREE-shard assignment, wired by initMaster. Co-workers
// leave it null so the IPC handler reports a clear not-master error.
let masterAssign: ((shardId: number, nodeId: string) => Promise<AssignResult>) | null = null;

/** Manual assign of a FREE shard to a node (Usage-tab action). Master-only. */
export async function fleetAssignShard(shardId: number, nodeId: string): Promise<AssignResult> {
  if (!masterAssign) return { success: false, error: 'This node is not the fleet master' };
  return masterAssign(shardId, nodeId);
}

let stopSyncPosture: (() => Promise<void>) | null = null;

/**
 * Relax the master's synchronous posture before a planned exit, ahead of the
 * write drain: an armed posture stalls every write in that drain for its whole
 * bound, so leaving it to the next boot's clear would cost the shutdown its
 * own data. A node with no posture engine returns immediately.
 */
export async function relaxFleetSyncPosture(): Promise<void> {
  const stop = stopSyncPosture;
  stopSyncPosture = null;
  if (stop) await stop();
}

let masterResume: (() => Promise<AssignResult>) | null = null;

/** End the reshard pause: delete the marker and let distribution proceed (Usage-tab action). Master-only. */
export async function fleetResumeAssignments(): Promise<AssignResult> {
  if (!masterResume) return { success: false, error: 'This node is not the fleet master' };
  return masterResume();
}

let masterDeclareLost: ((nodeId: string) => Promise<AssignResult>) | null = null;

/** Operator verdict on a down node: free its shards and forget it (Usage-tab action). Master-only. */
export async function fleetDeclareLost(nodeId: string): Promise<AssignResult> {
  if (!masterDeclareLost) return { success: false, error: 'This node is not the fleet master' };
  return masterDeclareLost(nodeId);
}

let masterDrainNode: ((nodeId: string) => Promise<AssignResult>) | null = null;

/** Manual lease drain of a live worker (Usage-tab action). Master-only. */
export async function fleetDrainNode(nodeId: string): Promise<AssignResult> {
  if (!masterDrainNode) return { success: false, error: 'This node is not the fleet master' };
  return masterDrainNode(nodeId);
}

let masterSyncBump: ((scope: string) => void) | null = null;

/** Webui-nudged sync revision bump (fire-and-forget IPC). No-op standalone and on co-workers. */
export function fleetSyncBump(scope: string): void {
  masterSyncBump?.(scope);
}

// This node's LeaseRuntime, wired in initFleet. Used only by the dev lease-corrupt
// fault hook (drill P2.8); null before init and on nodes with no runtime.
let devRuntime: LeaseRuntime | null = null;

/** Dev fault hook: corrupt a held lease id on this node. Double-gated by FLEET_DEV_HOOKS. */
export function fleetDevCorruptLease(shardId: number): { ok: boolean; error?: string } {
  if (process.env.FLEET_DEV_HOOKS !== '1') return { ok: false, error: 'dev hooks disabled (set FLEET_DEV_HOOKS=1)' };
  if (!devRuntime) return { ok: false, error: 'fleet not initialized on this node' };
  return devRuntime.corruptLeaseForTest(shardId);
}

// Migration control surface (master-only; null on co-workers and standalone,
// where the migration subsystem is never constructed). Mirrors masterAssign.
let masterMigrateStart: ((payload: StartPayload) => Promise<{ ok: boolean; error?: string; migrationId?: string }>) | null = null;
let masterMigrateAbort: ((migrationId: string) => Promise<{ ok: boolean; error?: string }>) | null = null;
let masterMigrateResume: ((migrationId: string) => Promise<{ ok: boolean; error?: string }>) | null = null;
let masterMigratePrecheck: ((payload: StartPayload) => Promise<PrecheckResult>) | null = null;
let masterMigrateList: (() => MigrationView) | null = null;

export async function fleetMigrateStart(payload: StartPayload): Promise<{ ok: boolean; error?: string; migrationId?: string }> {
  if (!masterMigrateStart) return { ok: false, error: 'This node is not the fleet master' };
  return masterMigrateStart(payload);
}

export async function fleetMigrateAbort(migrationId: string): Promise<{ ok: boolean; error?: string }> {
  if (!masterMigrateAbort) return { ok: false, error: 'This node is not the fleet master' };
  return masterMigrateAbort(migrationId);
}

export async function fleetMigrateResume(migrationId: string): Promise<{ ok: boolean; error?: string }> {
  if (!masterMigrateResume) return { ok: false, error: 'This node is not the fleet master' };
  return masterMigrateResume(migrationId);
}

export async function fleetMigratePrecheck(payload: StartPayload): Promise<PrecheckResult> {
  if (!masterMigratePrecheck) return { ok: false, error: 'This node is not the fleet master' };
  return masterMigratePrecheck(payload);
}

export function fleetMigrationsList(): MigrationView {
  if (!masterMigrateList) return { active: null, history: [] };
  return masterMigrateList();
}

// Backend transformation control surface (any master, standalone included - a
// mismatched standalone deployment transforms itself; null on co-workers).
let masterTransformStart: ((payload: { direction?: TransformDirection }) => Promise<{ ok: boolean; error?: string; transformationId?: string }>) | null = null;
let masterTransformPause: (() => { ok: boolean; error?: string }) | null = null;
let masterTransformResume: (() => Promise<{ ok: boolean; error?: string }>) | null = null;
let masterTransformAbort: (() => Promise<{ ok: boolean; error?: string }>) | null = null;

export async function fleetTransformStart(payload: { direction?: TransformDirection }): Promise<{ ok: boolean; error?: string; transformationId?: string }> {
  if (!masterTransformStart) return { ok: false, error: 'This node is not the fleet master' };
  return masterTransformStart(payload);
}

export function fleetTransformPause(): { ok: boolean; error?: string } {
  if (!masterTransformPause) return { ok: false, error: 'This node is not the fleet master' };
  return masterTransformPause();
}

export async function fleetTransformResume(): Promise<{ ok: boolean; error?: string }> {
  if (!masterTransformResume) return { ok: false, error: 'This node is not the fleet master' };
  return masterTransformResume();
}

export async function fleetTransformAbort(): Promise<{ ok: boolean; error?: string }> {
  if (!masterTransformAbort) return { ok: false, error: 'This node is not the fleet master' };
  return masterTransformAbort();
}

let readWitnessNow: (() => Promise<WitnessStatus | null>) | null = null;

/**
 * Force a witness read and return the resulting status (B4). The promote's c3
 * verdict turns on whether a live master can still reach its own store, which
 * flips within seconds; judging that from the loop's cached snapshot means
 * trusting a reading up to two beacon cadences old. Null when this node runs no
 * witness (a plain co-worker, standalone, or no token).
 */
export async function fleetReadWitness(): Promise<WitnessStatus | null> {
  if (!readWitnessNow) return null;
  return readWitnessNow();
}

let followedBackend: (() => { url: string; forms: string[] } | null) | null = null;

/**
 * The database a follower hold serves from, WITH credentials, for the parent's
 * promote engine (B6 map F28): the hold persists nothing, so this is the only
 * place the parent can take the fleet database and its credentials from. Null
 * until a delivery installed and verified.
 */
export function fleetFollowedBackend(): { url: string; forms: string[] } | null {
  return followedBackend ? followedBackend() : null;
}

let masterConfigSet: ((candidates: string[], witnessChannelId: unknown, backupDesignations: unknown) => Promise<{ ok: boolean; error?: string; revision?: number }>) | null = null;

/** Runtime fleet-config edit (B2, backup order B5); master-only, pushed fleet-wide with zero restarts. */
export async function fleetSetConfig(candidates: unknown, witnessChannelId?: unknown, backupDesignations?: unknown): Promise<{ ok: boolean; error?: string; revision?: number }> {
  if (!masterConfigSet) return { ok: false, error: 'This node is not the fleet master' };
  return masterConfigSet(Array.isArray(candidates) ? (candidates as string[]) : [], witnessChannelId, backupDesignations);
}

export async function initFleet(): Promise<FleetContext> {
  if (context) return context;
  if ((process.env.MASTER_URLS || '').trim() !== '' && (process.env.BOT_NODE_ROLE || '').trim() === '' && !readRoleOverride()) {
    console.warn('[Fleet] MASTER_URLS is set but BOT_NODE_ROLE is not. The candidate list NEVER changes a node\'s role; set BOT_NODE_ROLE=master, co-worker or backup-master explicitly on every node that carries MASTER_URLS.');
  }
  // A stale stand-in override on a node that has since lost its fleet wiring
  // would otherwise take the ORDINARY master path onto a database still in
  // recovery, with none of the stand-in guards and no way back: the lane's own
  // standIn flag requires a fleet, so it would read false here.
  if (isStandalone() && isStandInBoot()) {
    console.warn('[Fleet] Clearing a stand-in role override on a standalone boot: there is no fleet to stand in for');
    clearRoleOverride();
    invalidateRoleOverrideCache();
  }
  const role = resolveNodeRole();
  const standalone = isStandalone();
  const nodeId = getNodeId();
  const nodeName = getNodeName();
  const appVersion = getAppVersion();
  const ingest = getIngestService();
  const runtime = new LeaseRuntime(ingest);
  devRuntime = runtime;
  const advertisedTransferUrl = (process.env.TRANSFER_URL || '').trim() || undefined;
  const capabilities: NodeCapabilities = {
    shardCapacity: resolveShardCapacity(),
    dataBackend: resolveDataBackend(),
    ...(advertisedTransferUrl ? { transferUrl: advertisedTransferUrl } : {}),
    ...(isBackupMaster() ? { backupMaster: true } : {}),
    ...(consentsToActiveMode() ? { activeCapable: true } : {}),
  };

  const init = { nodeId, nodeName, appVersion, capabilities, runtime };
  const boot = role === 'master' ? await initMaster({ standalone, ...init }) : await initCoWorker(init);
  // A master that came back behind its stand-in, or on a copy, follows the
  // node holding the fleet as a co-worker (20.5, B6 map F28). Its identity
  // stays master (env and override untouched): the promote engine reads it
  // as the returning master, and a restart re-derives the same hold.
  context = 'followerHold' in boot ? await initCoWorker(init, boot.followerHold) : boot;

  // Boot ownership sweep: stamp-if-missing (adopt), foreign-residue -> graveyard,
  // orphaned *.tmp cleanup, _incoming disposition. Runs before any ingest login
  // so a cloned/foreign data volume is made safe before the bot connects. When
  // node.json was freshly minted this boot the sweep ADOPTS mismatched dirs
  // instead of graveyarding them (a regenerated identity is not a clone).
  try {
    await runResidueSweep(nodeId, wasNodeIdFreshlyGenerated());
  } catch (error) {
    console.error('[Fleet] Residue sweep failed:', error instanceof Error ? error.message : error);
  }

  // Source-side graveyard resume (both roles): finish any interrupted retire of
  // an already-transferred source copy. Idempotent.
  try {
    await resumeSourceGraveyarding();
  } catch (error) {
    console.error('[Fleet] Source graveyard resume failed:', error instanceof Error ? error.message : error);
  }

  // Node-side _incoming resolution: the master answers from its own coordinator
  // record; a co-worker retains staging until the master's active-migration
  // abort/commit broadcast (or the retention TTL) resolves it - staging is never
  // deleted while the master might still consider the migration live.
  if (!standalone) {
    const resolveIncoming = async (): Promise<void> => {
      try {
        await resolveIncomingWithMaster(async (migrationId): Promise<MigrationDisposition> => {
          const decision = migrationDispositionOf(migrationId);
          if (decision) return decision;
          // Not the master (or migration not in the local coordinator): defer to
          // the broadcast/TTL path by signalling unreachable (reject).
          throw new Error('migration status not locally resolvable');
        });
      } catch (error) {
        console.warn('[Fleet] _incoming resolution failed:', error instanceof Error ? error.message : error);
      }
    };
    await resolveIncoming();
    // Periodic retry: staging retained at boot (master unreachable, or this is
    // a co-worker) is re-resolved in place, so the retention TTL reclaims
    // aborted staging within a day of the abort instead of a day plus a reboot.
    // Skipped while migration work is live on this node: the resolver's
    // commitFromStaging must never race the executor's own commit path.
    setInterval(() => {
      if (migrationWorkActive()) return;
      void resolveIncoming();
    }, INCOMING_RESOLVE_INTERVAL_MS).unref();
  }

  return context;
}

// Master-side disposition of a migration id for the boot _incoming resolution;
// null on co-workers and when the coordinator does not know the migration.
let migrationDispositionOf: (migrationId: string) => MigrationDisposition | null = () => null;
// Whether migration work (coordinator active record or a live executor leg) is
// running on this node; the periodic staging resolver must never race it.
let migrationWorkActive: () => boolean = () => false;

interface CommonInit {
  nodeId: string;
  nodeName: string;
  appVersion: string;
  capabilities: NodeCapabilities;
  runtime: LeaseRuntime;
}

function sameShardSet(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every(id => set.has(id));
}

function isValidHeldLeases(held: NonNullable<RegisterPayload['heldLeases']>): boolean {
  if (typeof held !== 'object') return false;
  if (!Number.isInteger(held.term) || held.term < 0) return false;
  if (!Number.isInteger(held.epoch) || held.epoch < 0) return false;
  if (!Number.isInteger(held.shardCount) || held.shardCount < 0) return false;
  if (!Array.isArray(held.leases)) return false;
  for (const lease of held.leases) {
    if (typeof lease?.leaseId !== 'string' || lease.leaseId.length === 0) return false;
    if (!Number.isInteger(lease?.shardId) || lease.shardId < 0) return false;
  }
  return true;
}

// Boot takeover guard (PLAN_STANDBY 3.2). Returns the FOREIGN previous term
// holder (chain input) or null when the row is absent or this node's own.
// Freshness is OBSERVED: the row must stop advancing for the full staleness
// window of local time before an unconfirmed boot may take over; no
// cross-machine clock comparison ever happens. An unreachable store yields no
// evidence either way, so it resets the observation window (fail safe).
async function runTakeoverGuard(
  store: PostgresControlStore,
  selfNodeId: string,
  takeoverConfirmed: boolean,
): Promise<{ term: number; nodeId: string } | null> {
  const read = async (): Promise<{ term: number; nodeId: string; updatedAt: number } | null | 'unreachable'> => {
    try {
      return await store.getTerm();
    } catch {
      return 'unreachable';
    }
  };
  let row = await read();
  while (row === 'unreachable') {
    // Cannot observe, cannot CAS either; hold here rather than inside
    // acquireTerm so the guard is never skipped by a store blip.
    await guardSleep(TERM_GUARD_POLL_MS);
    row = await read();
  }
  if (!row || row.nodeId === selfNodeId) return null;
  if (takeoverConfirmed) {
    console.warn(`[Fleet] Takeover CONFIRMED over term ${row.term} (node ${row.nodeId.slice(0, 8)}); skipping the guard`);
    return { term: row.term, nodeId: row.nodeId };
  }
  console.warn(`[Fleet] TAKEOVER GUARD: term ${row.term} is held by another node (${row.nodeId.slice(0, 8)}); holding until its stamp stops advancing for ${Math.round(TERM_TAKEOVER_STALE_MS / 1000)}s (Promote sets takeover; FLEET_CONFIRM_TAKEOVER=1 is the env override)`);
  let baseline = row;
  let lastAdvanceAt = Date.now();
  for (;;) {
    const observingForMs = Date.now() - lastAdvanceAt;
    if (observingForMs >= TERM_TAKEOVER_STALE_MS) break;
    _setTakeoverHold({
      observedTerm: baseline.term,
      observedNodeId: baseline.nodeId,
      observingForMs,
      requiredMs: TERM_TAKEOVER_STALE_MS,
    });
    await guardSleep(TERM_GUARD_POLL_MS);
    const next = await read();
    if (next === 'unreachable') {
      lastAdvanceAt = Date.now();
      continue;
    }
    if (!next) {
      _setTakeoverHold(null);
      return null;
    }
    if (next.nodeId === selfNodeId) {
      _setTakeoverHold(null);
      return null;
    }
    if (next.term !== baseline.term || next.updatedAt !== baseline.updatedAt) {
      baseline = next;
      lastAdvanceAt = Date.now();
    }
  }
  _setTakeoverHold(null);
  console.warn(`[Fleet] Takeover guard released: term ${baseline.term} (node ${baseline.nodeId.slice(0, 8)}) stopped advancing; proceeding to take over`);
  return { term: baseline.term, nodeId: baseline.nodeId };
}

/**
 * Stale-master boot fence (PLAN_REPLICATION Stage 4). The takeover guard above
 * judges the term ROW; it cannot judge which DATABASE that row lives in, and
 * promoting a database replica FORKS the store. A returned old master then
 * reads its own copy, finds nothing contradicting it, and mints a term that
 * nothing can ever fence. So before acquiring, a master with candidates
 * configured asks them who they are and what term they hold.
 *
 * The two run in sequence and prove different halves of the same question.
 * Reaching this line means nobody is writing this node's term row: either it
 * belongs to this node, or the guard above watched a foreign holder go silent
 * for its full staleness window. A candidate that answers ANYWAY is therefore
 * a master serving from a database this one is not part of, and acquiring here
 * would put two masters on one bot token. That is the whole verdict; the term
 * comparison only keeps this node from deferring to a peer staler than itself.
 *
 * Silence is never evidence. A dead, renamed or secret-rotated candidate reads
 * identically to a healthy one, so failing closed would strand masters that
 * have nothing wrong with them. A fork that survives a partition is the
 * accepted residual risk of having no third witness (Section 11 ruling).
 *
 * Parking is terminal by design: this node's database is the forked copy, so
 * the verdict cannot improve by waiting. Demote is the way out. The one
 * non-terminal answer is a stand-in that names this node and has taken writes:
 * that copy descends from this one and the failback brings it back, so the
 * fence returns a follower hold instead of parking (20.5, B6 map F28).
 */
async function runStaleMasterFence(
  store: ControlStore,
  selfNodeId: string,
  selfNodeName: string,
  standalone: boolean,
  envConfirm: boolean,
  stagedTakeover: boolean,
  storeDeadPeer: string | null,
  standIn = false,
): Promise<FollowerHoldBase | null> {
  if (standalone) return null;
  // Only the operator's env confirm skips this fence. A takeover a promote
  // staged was decided on what that node could see at the time: a candidate
  // answering NOW at or above this node's term is a live holder it did not
  // see (a healed partition, the node's own outage), which the sighting file
  // cannot record (a holder that never stopped holding is the same holding),
  // so the peer half runs; the one peer it lets answer at this node's own
  // term is the c3 master the verdict saw alive with its database dead. The
  // witness half judges FRESH beacons only: the superseded or dead master's
  // last ones age out, while a stand-in that armed after the decision, or a
  // second backup promoted by hand, renews its beacon and is a live holder.
  if (envConfirm) {
    console.warn('[Fleet] Takeover CONFIRMED by FLEET_CONFIRM_TAKEOVER; skipping the stale-master fence');
    // A stand-in seen holding the fleet for this node is the episode this
    // confirm ends (B6-j): whatever it accepted while standing in is discarded.
    const seen = readHolderSighting();
    if (!standIn && seen && seen.via === 'fence-hold') {
      writeEpisodeRecordOrWarn(seizedEpisode(seen, selfNodeId, selfNodeName));
    }
    return null;
  }
  if (stagedTakeover) console.warn(`[Fleet] Takeover staged by a promote: keeping the peer half of the stale-master fence (a live holder invalidates the decision${storeDeadPeer ? `; node ${storeDeadPeer.slice(0, 8)}, superseded with its database dead, may answer at this node's own term` : ''}) and only fresh beacons in the witness half`);
  const secret = (process.env.CONTROL_SECRET || '').trim();
  const { urls: candidates } = effectiveMasterUrls();
  const token = (process.env.DISCORD_TOKEN || '').trim();
  if ((secret === '' || candidates.length === 0) && token === '') return null;

  // Hold rather than skip on an unreadable store, exactly like the guard: the
  // very next statement blocks on the same store until it answers, so waiting
  // here costs nothing and silently dropping the only fork check costs a fleet.
  let local: PersistedTerm | null = null;
  for (let waited = 0; ; waited += TERM_GUARD_POLL_MS) {
    try {
      local = await store.getTerm();
      break;
    } catch {
      // Unbounded is right for a real master: the next statement blocks on the
      // same store anyway. A stand-in is the opposite case - it has already
      // given up backup duty and its witness, so holding here forever is worse
      // than never having armed, and nothing is left running to change its mind.
      if (standIn && waited >= STANDIN_FENCE_HOLD_MS) {
        return disarmStandIn('the copy this node would serve from is unreadable');
      }
      console.warn('[Fleet] Stale-master fence: control store unreadable; holding before it can judge the boot');
      await guardSleep(TERM_GUARD_POLL_MS);
    }
  }
  const localTerm = local ? local.term : 0;
  const park = (observedTerm: number, peerUrl: string, holderNodeId: string, detail: string, extra = ''): Promise<never> => {
    // A stand-in that trips the fence has learned the master is alive after all,
    // which is the best possible outcome: it simply stops standing in. Parking
    // it instead would strand a node that is no longer a backup and no longer a
    // master, with nothing left running to change its mind.
    if (standIn) return disarmStandIn(`${detail}; the master this node was covering is alive`);
    console.error(`[Fleet] STALE MASTER FENCE: ${detail}; parking the boot instead of acquiring a term on a database the fleet has moved off. Demote this node to rejoin as a co-worker.${extra}`);
    noteHolderSighting(holderNodeId, observedTerm, 'fence-park', selfNodeId);
    _setStaleMasterPark({ observedTerm, localTerm, peerUrl, at: Date.now() });
    pushFleetStatusNow();
    return (async () => { for (;;) await guardSleep(TERM_GUARD_POLL_MS); })();
  };
  // The failback's first half (20.5, B6 map F28): the stand-in's copy is the
  // fleet database now and this one is behind it, so this node follows that
  // node as a co-worker instead of parking, until the failback syncs this
  // database from its copy and promotes it back. A stand-in that lands here
  // has learned the master is alive and stops standing in, as on a park.
  const hold = (observedTerm: number, seenVia: string, standInNodeId: string, standInName: string | null, detail: string): Promise<FollowerHoldBase> => {
    if (standIn) return disarmStandIn(`${detail}; the master this node was covering is alive`);
    console.error(`[Fleet] FOLLOWER HOLD: ${detail}; following that node as a co-worker instead of minting a term past the writes its copy holds. To take the fleet back, re-seed this database as a standby of that copy and promote this node once it has caught up; demote this node to stay a co-worker instead. If that node is gone for good, FLEET_CONFIRM_TAKEOVER=1 on this node plus a restart seizes the fleet back onto this database, losing everything that node accepted during the outage.`);
    noteHolderSighting(standInNodeId, observedTerm, 'fence-hold', selfNodeId);
    return Promise.resolve({ reason: 'behind', standInNodeId, standInName, observedTerm, localTerm, seenVia, since: Date.now() });
  };

  // One witness read serves both halves: the c3 exception in the peer half
  // re-proves its premise on that node's own FRESH beacon, and the witness half
  // judges the rest. Under a staged takeover only a beacon still being renewed
  // is a holder: the superseded or dead master's last ones are history, and a
  // lossy failover of a lagging copy must not park on them.
  const claims = token !== ''
    ? await new DiscordWitness({ token, nodeId: selfNodeId, nodeName: selfNodeName, getChannelId: () => readFleetConfigCache()?.witnessChannelId ?? null }).readClaims()
    : null;
  const usable = stagedTakeover && claims ? claims.filter(c => Date.now() - c.observedAt <= WITNESS_FRESH_WINDOW_MS) : claims;
  // The c3 re-proof (20.12) needs no probe: the staged fact names the node
  // and its own fresh beacon is already in hand, where a probe it does not
  // answer (undialable, or past the probe budget) could not show a store that
  // came back at the same term. A beacon that no longer says dead at or above
  // this node's term is a live holder again: one that names this node holds
  // (its copy is the fleet database and this one a promoted fork of it), any
  // other parks. A still-dead store, or no fresh beacon, keeps the pass:
  // silence is not evidence.
  if (stagedTakeover && storeDeadPeer !== null) {
    const own = usable?.find(c => c.nodeId === storeDeadPeer) ?? null;
    if (own && own.storeState !== 'dead' && own.term >= localTerm) {
      const via = `witness beacon of ${own.nodeName}`;
      const detail = `${own.nodeName} (${own.nodeId.slice(0, 8)}) is the node this promote superseded with its database reported dead, but its beacon now reports that database ${own.storeState ?? 'healthy'} at term ${own.term} while this node's store holds ${localTerm}`;
      if (own.standingInFor === selfNodeId) return hold(own.term, via, own.nodeId, own.nodeName, detail);
      // Named by node, not by the witness-half marker: that marker switches on
      // the tab's restore-from-a-dump tail, which belongs to a beacon nobody
      // renews, where this holder is live right now.
      await park(own.term, `${own.nodeName} (${own.nodeId.slice(0, 8)})`, own.nodeId, detail);
    }
  }

  if (secret !== '' && candidates.length > 0) {
    const deadline = Date.now() + PEER_TERM_PROBE_BUDGET_MS;
    for (const url of candidates) {
      if (Date.now() >= deadline) {
        console.warn('[Fleet] Stale-master fence: probe budget spent; proceeding on the evidence gathered');
        break;
      }
      const peer = await probePeerTerm(url, secret, PEER_TERM_PROBE_MS);
      // This node's own answer proves nothing: candidates include its own
      // advertised URL, and a predecessor process may still hold the port.
      if (peer === null || peer.nodeId === selfNodeId || peer.term < localTerm) continue;
      // 20.12 c3: the promote saw this master alive with its DATABASE dead and
      // the operator took the RPO confirm over it; its bot still answers at the
      // term its dead store froze on, and this node's higher beacon is what
      // steps it down. That fact flips within seconds and a store that comes
      // back keeps its term, so it was re-proved ahead of this loop on the
      // node's own fresh beacon, whether or not it answers the probe; here the
      // answer is only logged. A higher term from it means it minted: parked
      // above like any other. Judged BEFORE the
      // hand-back below: a stand-in that took writes for this node and whose
      // store then died is this peer too, and the hand-back's equal-term
      // continue must not pass it unproved.
      if (stagedTakeover && storeDeadPeer !== null && peer.nodeId === storeDeadPeer && peer.term === localTerm) {
        const own = usable?.find(c => c.nodeId === storeDeadPeer) ?? null;
        console.warn(`[Fleet] Stale-master fence: ${url} is the master this promote superseded with its database reported dead (term ${peer.term}${own ? ', its beacon still says so' : ', no fresh beacon from it'}); proceeding, its bot steps down on this node's higher beacon`);
        continue;
      }
      // A stand-in covering THIS node is the one peer that must not fence it:
      // it holds the fleet at this node's own inherited term precisely so this
      // node can come back, so parking here would strand the fleet on a
      // temporary copy forever. The witness half already carries the same
      // exception (F21); the peer half needs it too, and needs it MORE, because
      // an inherited term is equal rather than higher and so always trips the
      // comparison above (B6 map F28).
      if (peer.standingInFor === selfNodeId) {
        if (peer.term === localTerm) {
          console.warn(`[Fleet] Stale-master fence: ${url} is standing in for this node at term ${peer.term}; continuing the boot so it can hand back`);
          continue;
        }
        // A higher term means it TOOK WRITES (B6-f2): its copy is the fleet
        // database now and this one is behind it, so serving would fork the
        // data the outage produced.
        return hold(peer.term, url, peer.nodeId, null, `${url} is standing in for this node and has taken writes at term ${peer.term} while this node's store holds ${localTerm}: its copy is the fleet database now and this one is behind it`);
      }
      await park(peer.term, url, peer.nodeId, `${url} answers as a live master on term ${peer.term} while this node's store holds ${localTerm} and nothing is writing to it`);
    }
  }

  // Witness half (PLAN_REPLICATION 20.6/20.14): a higher term another node
  // EVER posted means this copy is a stale fork, fresh beacon or not, and it
  // is the only evidence that reaches a master that cannot be dialed
  // (Windows, NAT). Darkness is not evidence, like silence above.
  if (usable) {
    const higher = witnessWinner(usable, selfNodeId, localTerm);
    if (higher && higher.standingInFor === selfNodeId) {
      return hold(higher.term, `witness beacon of ${higher.nodeName}`, higher.nodeId, higher.nodeName, `${higher.nodeName} (${higher.nodeId.slice(0, 8)}) is standing in for this node and has taken writes at term ${higher.term} while this node's store holds ${localTerm}: its copy is the fleet database now and this one is behind it`);
    }
    if (higher) {
      // The restore tail belongs to THIS half only: the peer half means a
      // foreign master is answering LIVE right now, where the same advice
      // would talk an operator into a dual-master seize.
      await park(higher.term, `witness beacon of ${higher.nodeName}`, higher.nodeId, `the witness holds a beacon from ${higher.nodeName} (${higher.nodeId.slice(0, 8)}) at term ${higher.term} while this node's store holds ${localTerm}`,
        ' If this database was DELIBERATELY restored from a dump, the fleet has not moved anywhere: the manager\'s restore lane advances the restored control term automatically, and FLEET_CONFIRM_TAKEOVER=1 on the next start overrides the fence by hand.');
    }
  }
  return null;
}

function otherNodesConfigured(selfNodeId: string): string[] {
  return emptyStoreHoldEvidence(readFleetConfigCache(), rawMasterUrls(), selfNodeId, (process.env.FLEET_PUBLIC_URL || '').trim() !== '');
}

/**
 * Boot hold on an EMPTY store (PLAN_REPLICATION 20.14). A master configured
 * with other nodes whose store holds no term row and no guild ownership is a
 * fresh copy that must seed FROM a backup before it may serve: minting a term
 * here is the "fresh init looks newer" trap the lineage invariant forbids.
 * Runs BEFORE the control store is prepared, because preparing it seeds an
 * empty postgres store from local files and provisions DDL, either of which
 * would make the store look populated. Unreachable holds too: an empty store
 * that is merely late to start must not slip through. Exits when the store is
 * populated (seeded), on FLEET_CONFIRM_TAKEOVER, or on the operator's
 * brand-new-fleet confirmation, which
 * is CONSUMED here: it answers the empty store in front of it, never every
 * empty store this node will ever boot with.
 */
async function runEmptyStoreHold(standalone: boolean, selfNodeId: string): Promise<boolean> {
  if (standalone || resolveDataBackend() !== 'postgres') return false;
  const candidates = otherNodesConfigured(selfNodeId);
  // The confirmation answers ONE hold. Any boot that does not need it clears it
  // here, so a stale answer can never wave a later empty store through in
  // silence - the case the lineage invariant exists for.
  if (candidates.length === 0) {
    clearFreshFleetConfirm();
    return false;
  }
  const since = Date.now();
  let announced = false;
  let usedConfirm = false;
  for (;;) {
    const creds = loadCredentials();
    const dataUrl = (creds.DATA_BACKEND_URL || '').trim();
    const controlUrl = (creds.CONTROL_STORE_URL || '').trim() || dataUrl;
    const verdict = await probeStoreEmpty(controlUrl, dataUrl);
    if (verdict === 'populated') {
      clearFreshFleetConfirm();
      break;
    }
    // A takeover a promote staged releases nothing here: every lane that
    // stages one verified moments earlier that the copy had left recovery
    // holding the fleet's data, so a store reading empty, or unreachable
    // while it initialises, is not the database that promote was decided on;
    // a populated one breaks above, and the restart that promote runs ends
    // this child anyway. The operator's env confirm is the deliberate release.
    if ((process.env.FLEET_CONFIRM_TAKEOVER || '').trim() === '1') {
      clearFreshFleetConfirm();
      break;
    }
    if (hasFreshFleetConfirm()) {
      // Consumed only once the boot survives the fence that runs after this
      // hold: burning it here would leave an operator who then parks on a live
      // peer's beacon having to answer both gates twice.
      usedConfirm = true;
      console.warn('[Fleet] Brand-new fleet confirmed; releasing the empty-store hold');
      break;
    }
    if (!announced) {
      announced = true;
      console.error(`[Fleet] EMPTY STORE HOLD: this master's database is ${verdict} while this fleet has other nodes on record (${candidates.join(', ')}). It will not mint a term on an empty store while a backup may hold the real data. Provision this machine as a standby of the node that holds the data and let it catch up, or demote this node to rejoin as a co-worker, or confirm a brand-new fleet from the Fleet tab.`);
    }
    _setEmptyStoreHold({ candidates, since, storeState: verdict });
    pushFleetStatusNow();
    await guardSleep(TERM_GUARD_POLL_MS);
  }
  if (announced) {
    _setEmptyStoreHold(null);
    pushFleetStatusNow();
    console.warn('[Fleet] Empty-store hold released');
  }
  return usedConfirm;
}

function guardSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * The stand-in lane's only exit from a boot that must not continue. It replaces
 * park() on this path deliberately: park is a terminal hold, which for a
 * stand-in is strictly WORSE than never arming, because the node has already
 * abandoned its backup duty and its witness. Anything that would park a
 * stand-in instead returns it to being a backup (B6 map F40, and the park
 * hazard 20.5's reversibility rule exists to avoid).
 */
async function disarmStandIn(reason: string): Promise<never> {
  const record = readArmRecord();
  if (record) {
    // The episode closes with the lane (B6-j), the lane's state first. Every
    // exit here is a serve-only boot's (a promoted lane parks or holds
    // instead), so no writes were ever at stake: never-served, whatever ended
    // it.
    if (record.phase !== 'disarmed') closeStandInLane(record, getNodeId(), getNodeName(), null, 'never-served', reason, reason);
    else writeArmRecord({ ...record, phase: 'disarmed', disarmedAt: Date.now(), disarmReason: reason });
  }
  // Forced to co-worker rather than cleared: an explicit override records that
  // this node stood down, and stamps who did it, where a deleted file would say
  // only that no override was ever written.
  writeRoleOverride({ role: 'co-worker', setAt: Date.now(), setBy: 'stand-in' });
  invalidateRoleOverrideCache();
  console.error(`[Fleet] STAND-IN DISARMED: ${reason}; returning to backup duty`);
  requestStepDownRestart();
  const retry = setInterval(() => requestStepDownRestart(), STEPDOWN_FALLBACK_MS);
  retry.unref();
  for (;;) await guardSleep(TERM_GUARD_POLL_MS);
}

/**
 * The follower hold's structural entry (20.5, B6 map F28, D8): a master with
 * no database of its own beside a manager-provisioned standby is a copy by
 * configuration. Asked before the empty-store hold, which probes the node's
 * own database and would hold forever when there is none to probe; the
 * in-recovery entry is asked after it.
 */
async function ownStoreIsCopy(): Promise<FollowerHoldBase | null> {
  const url = currentCanonicalUrl();
  // No database of its own but a manager-provisioned standby beside it: the
  // manager's re-seed retires the primary's env pins and leaves the standby's,
  // which is the returning master's shape on a managed machine. A node that
  // owns a primary beside its standby (20.19 F7) keeps its own URL.
  if (url === '' && hasDbReplica()) {
    console.error('[Fleet] FOLLOWER HOLD: this node is the fleet\'s master by configuration but carries no database of its own, only a standby; following the node holding the fleet as a co-worker until the failback promotes that copy, or demote this node to stay a co-worker');
    return { reason: 'copy', standInNodeId: null, standInName: null, observedTerm: null, localTerm: null, seenVia: 'own database re-seeded as a standby', since: Date.now() };
  }
  return null;
}

/**
 * The copy hold's probe entry: this node's own database is in recovery. Waits
 * for that database to answer, rather than shooting once, whenever the control
 * store about to be prepared blocks on this same database (a live postgres
 * runtime, or a CONTROL_STORE_URL of its own): a sidecar still starting would
 * otherwise turn a copy into "not a copy" and send the boot into the control
 * store's seeding loop, which issues DDL a standby refuses forever, and the
 * wait costs nothing there. A transformation-required boot (configured
 * postgres, live file, no control store of its own) comes up on the FILE
 * control store to serve its diagnosis, so it keeps the single shot.
 */
async function ownStoreInRecovery(selfNodeId: string): Promise<FollowerHoldBase | null> {
  const url = currentCanonicalUrl();
  if (url === '' || resolveDataBackend() !== 'postgres') return null;
  // The wait's premise, that the control store about to be prepared blocks on
  // this same database, holds only when this boot runs a postgres runtime or
  // names a control store of its own: a transformation-required boot
  // (configured postgres, live file) comes up on the file control store to
  // serve its diagnosis, and must not wait on a database it never had.
  const blocksOnIt = getDataBootStatus().mode === 'postgres' || (loadCredentials().CONTROL_STORE_URL || '').trim() !== '';
  let probe = await probeReplica(url);
  for (let announced = false; blocksOnIt && !probe.ok; probe = await probeReplica(url)) {
    if (!announced) {
      announced = true;
      console.warn('[Fleet] Copy hold: this node\'s own database is not answering yet; holding before it can judge the boot');
    }
    await guardSleep(TERM_GUARD_POLL_MS);
  }
  if (!probe.ok || probe.inRecovery !== true) return null;
  const row = await readTermRow(url);
  const holder = row && row.nodeId !== selfNodeId ? row.nodeId : null;
  console.error(`[Fleet] FOLLOWER HOLD: this node's own database is in recovery, a copy${holder ? ` of ${holder.slice(0, 8)}'s at term ${row!.term}` : ''}, so it cannot serve as master from it; following the node holding the fleet as a co-worker until the failback promotes this copy, or demote this node to stay a co-worker`);
  noteHolderSighting(holder, row?.term ?? null, 'fence-hold', selfNodeId);
  return { reason: 'copy', standInNodeId: holder, standInName: null, observedTerm: row?.term ?? null, localTerm: null, seenVia: 'own database in recovery', since: Date.now() };
}

/**
 * Read-only control store (B7-F6): a standby, or a primary fenced read-only (a
 * promote that moved the fleet off it, a restore, a recovery-channel swap). No term
 * can be minted here, and a retry that
 * outlived the posture would mint on a forked copy at the live master's own
 * term, so the boot parks with the exits named. Terminal, like the stale-master
 * park, whose Demote exit it shares.
 */
function parkOnReadOnlyStore(error: ControlStoreReadOnlyError): Promise<never> {
  const exits = error.cause === 'standby'
    ? 'point CONTROL_STORE_URL or DATA_BACKEND_URL at the primary, or promote this copy, then restart'
    : error.provisioned
      ? 'default_transaction_read_only = on is a saved setting of this database, written by whichever lane fenced it: a promote (finished with Continue on the promoting node, and once it completes this database stays fenced for good), a restore (it lifts the fence when it finishes, and running it again retries the lift) or a swap quiesced through a recovery channel (its teardown disarms this machine, and that disarm lifts the fence; the channel stays armed for the whole swap and for any rescue run again through it, and Disarm here drops the slot the copy is catching up through and unfences this database, so Disarm here only once the machine being rescued shows no rescue running or seeding through this channel; then it lifts the fence, whether the swap was cancelled or its teardown never landed or could not finish). Never lift the fence by hand under a running lane. If the lane has finished and this node still parks, restart the database container: that clears a fence the lane removed from the saved settings but could not lift live; if it comes up fenced again, the setting is still saved and the lane remedy above is what is left. Then start this node again. Once the fleet has moved off this database for good, Demote this node to rejoin as a co-worker, or re-seed its database from the machine that serves the fleet'
      : 'check DATA_BACKEND_URL and CONTROL_STORE_URL and the database they name; an empty database fenced read-only is what a restore that failed leaves behind, and running the restore again is its exit';
  const reason = `READ-ONLY CONTROL STORE: ${error.message}; parking the boot instead of minting a term on it. ${exits}`;
  console.error(`[Fleet] ${reason}`);
  _setReadOnlyStorePark({ cause: error.cause, provisioned: error.provisioned, reason, at: Date.now() });
  pushFleetStatusNow();
  return (async () => { for (;;) await guardSleep(TERM_GUARD_POLL_MS); })();
}

async function initMaster(init: CommonInit & { standalone: boolean }): Promise<FleetContext | { followerHold: FollowerHoldBase }> {
  // A master follows no slot: a record left by this node's co-worker past must
  // not keep answering the manager's facts hook. The posture fact goes with it,
  // for the same reason: a master is not a standby of itself.
  // Kept for a stand-in: it never promoted, so it IS still a standby, and
  // blanking its slot facts would hide a live copy from the manager's replica
  // automation for the whole outage.
  if (!isStandInBoot()) {
    clearSlotStatus();
    clearSyncPostureRecord();
    _setSlotStatus(null);
  }
  const { standalone, nodeId, nodeName, appVersion, capabilities, runtime } = init;
  const ingest = getIngestService();
  // SERVE-ONLY STAND-IN BOOT (20.5, B6-f). This node coordinates the fleet from
  // a database that is STILL A STANDBY, so postgres refuses every write here
  // with SQLSTATE 25006 - including CREATE ... IF NOT EXISTS, which is rejected
  // on the command class before it checks whether the object exists (measured
  // 2026-09-10 on a real pair). Write sites on this path are therefore SKIPPED
  // rather than attempted and caught: several retry forever, and a boot that
  // never reaches server.start serves nobody while having already given up
  // being a backup.
  const armRecord: ArmRecord | null = readArmRecord();
  const standIn = !standalone && isStandInBoot();
  if (standIn && (!armRecord || armRecord.phase === 'disarmed')) {
    return disarmStandIn('the stand-in role override carries no live arm record, so this node cannot say which master it covers');
  }
  const coveringNodeId = standIn ? armRecord!.coveringNodeId : null;
  // Every OTHER stand-in failure routes here; these reads reach the pool with no
  // catch of their own, and initFleet has none either, so without this a copy
  // that blinks between the fence and the read crashes the bot child, which
  // re-enters the same stand-in boot instead of going back to being a backup.
  const standInGuard = async <T>(what: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (!serveOnly) throw error;
      return disarmStandIn(`${what} failed on the copy this node is serving: ${error instanceof Error ? error.message : error}`);
    }
  };
  let standInUrl = '';
  // Which half of F2's gate this boot is on is asked of the COPY, not assumed
  // from the record: the parent may have promoted it and died before writing
  // 'promoted', and a copy that has left recovery cannot be served read-only
  // through a store that asserts it is a replica.
  let serveOnly = false;
  if (standIn) {
    // The gate text belongs to the phase that wrote it. Cleared here so that,
    // before this boot initializes, only the genuine hold below can be read
    // as one by the Fleet tab and by demote's known-hold list.
    if (armRecord!.writeGate !== null) writeArmRecord({ ...armRecord!, writeGate: null });
    const endpoints = resolveReplicaEndpoints();
    const spliced = endpoints ? spliceFleetCredentials(endpoints.local) : {};
    if ('url' in spliced && spliced.url) standInUrl = spliced.url;
    if (armRecord!.phase === 'promoted') {
      // Past F2's irreversible half: the copy is the fleet database and
      // /data/.env already names it, so nothing on this path may disarm.
      serveOnly = false;
    } else {
      if (standInUrl === '') return disarmStandIn('this node holds no usable database standby to serve from');
      const copy = await probeReplica(standInUrl);
      serveOnly = copy.inRecovery !== false;
    }
    if (!serveOnly && armRecord!.phase !== 'promoted' && !canonicalIsOwnReplica(endpoints!)) {
      // The copy left recovery but the fleet's database URL was never
      // persisted: the parent's write step died between pg_promote and the
      // persist. Booting the master path here would open the DEAD primary and
      // wait on it forever, and disarming is forbidden past the irreversible
      // half (the copy holds the fleet's writes). So this holds, visibly, until
      // the parent's resume or the operator's Continue persists the URL and
      // restarts this node. Only on THIS branch: a record already promoted was
      // written after the persist, and the replica env it would be checked
      // against is free to name a new standby of this node by then.
      const reason = 'this node\'s copy has left recovery but the fleet database URL still names the old primary, so the write step never finished persisting it. Continue the parked write step from the Fleet tab (it persists the URL and restarts this node), or demote this node and re-seed it as a standby';
      const onDisk = readArmRecord();
      if (onDisk) writeArmRecord({ ...onDisk, writeGate: reason });
      console.error(`[Fleet] STAND-IN WRITE STEP HELD: ${reason}`);
      pushFleetStatusNow();
      for (;;) await guardSleep(TERM_GUARD_POLL_MS);
    }
    if (!serveOnly) {
      console.warn(`[Fleet] STAND-IN WRITE STEP: this node's copy has left recovery; booting as a writing master for ${coveringNodeId}`);
    }
  }
  if (serveOnly) {
    // Guild data has to follow the control plane onto the copy. Both endpoints
    // otherwise resolve to the MASTER's primary, which is the host the arm lane
    // proved unreachable in order to arm at all, so a stand-in that repointed
    // only its control store would coordinate a fleet it could not serve.
    //
    // IN PROCESS ONLY, and nothing is written to /data/.env. The delivered-backend
    // lane persists on purpose, because a worker must still know its endpoint
    // after a restart; a stand-in is the opposite case, deriving this endpoint
    // again from FLEET_DB_REPLICA_URL on every boot. A persisted value would
    // outlive the stand-in that wrote it and need unwinding later, across exits
    // that are not one code path, and the canonical endpoint it replaced is what
    // the arm conjunction probes: left behind, this node's own copy answers that
    // probe forever and the lane quietly retires. Dying with the process is what
    // keeps serve-only reversible at no cost.
    const repointed = await repointRuntimeForThisProcess(standInUrl)
      .catch(err => {
        console.warn('[Fleet] Stand-in data backend repoint failed:', err instanceof Error ? err.message : err);
        return false;
      });
    if (!repointed) {
      return disarmStandIn('this node could not point its data layer at the copy it would serve from');
    }
  }
  // Counted on every serve-only BOOT, not just on every arm, and reset the
  // moment this node actually serves. A boot that dies before that point comes
  // straight back here with the override still set, so counting arms alone
  // would never increment in exactly the reboot loop the cap exists to stop.
  if (serveOnly) {
    if (armRecord!.attempts >= ARM_MAX_ATTEMPTS) {
      return disarmStandIn(`this node has tried to stand in ${armRecord!.attempts} times without serving; failing over now needs a manual promote`);
    }
    writeArmRecord({ ...armRecord!, attempts: armRecord!.attempts + 1, lastAttemptAt: Date.now(), writeGate: null });
  }
  // The store is populated by replication by construction (the arm read its term
  // row), and the hold's own probe loop is unbounded on an error, so running it
  // here can only wedge a boot whose answer is already known.
  // Before the empty-store hold, which probes the node's own database and
  // holds forever when there is none to probe.
  if (!standalone && !standIn) {
    const copyOf = await ownStoreIsCopy();
    if (copyOf) return { followerHold: copyOf };
  }
  const usedFreshConfirm = standIn ? false : await runEmptyStoreHold(standalone, nodeId);
  // The copy hold's probe entry; it waits for the store where the control
  // store would block on it anyway.
  if (!standalone && !standIn) {
    const inRecovery = await ownStoreInRecovery(nodeId);
    if (inRecovery) return { followerHold: inRecovery };
  }
  // Before the control store and before any write of this boot (B6 map F18):
  // a master that died while armed comes back armed, and its first write would
  // hang behind standbys that may no longer exist. Relaxing writes no WAL, so
  // this is the one statement that can always get through.
  // Skipped because it dials the CANONICAL endpoint, which on this path is the
  // dead master's primary: a stand-in has no business relaxing a posture on a
  // cluster it does not serve from. The copy's OWN inherited
  // synchronous_standby_names still has to go, but only when it leaves recovery,
  // which is the write step's job.
  if (!serveOnly) await clearOwnSyncPosture();
  const store = serveOnly ? createStandInControlStore(standInUrl) : await prepareControlStore(standalone).catch((error: unknown) => {
    if (error instanceof ControlStoreReadOnlyError) return parkOnReadOnlyStore(error);
    throw error;
  });
  // A control-store fence trip means a second master owns the schema: this
  // master stops granting entirely (the higher-term master is the healthy
  // one). Teardown (assigned once the server exists) drops every worker so
  // their candidate cycle finds the live master, and new registers are
  // refused 'deposed' via the controlFenced check in onRegister. The
  // supersession hook (assigned once the registry exists) turns the fence
  // into a step-down (B4).
  let controlFenced = false;
  let syncPosture: SyncPostureEngine | null = null;
  let onDeposedTeardown: (() => void) | null = null;
  let onSupersededByStore: ((observedTerm: number) => void) | null = null;
  let beginSupersession: ((by: { nodeId: string; nodeName: string; term: number }, source: SupersededSource) => void) | null = null;
  let finishStepDown: ((reason: string) => void) | null = null;
  if (store instanceof PostgresControlStore) {
    store.onFenced(observedTerm => {
      controlFenced = true;
      _setControlStoreFenced(observedTerm);
      console.error(`[Fleet] MASTER DEPOSED BY CONTROL STORE: term ${observedTerm} observed; granting stopped`);
      onDeposedTeardown?.();
      onSupersededByStore?.(observedTerm);
      pushFleetStatusNow();
    });
  }
  // A node booting as master is not a superseded one; the fact belongs to the
  // co-worker it becomes after a step-down, and to the manager reading it.
  clearSuperseded();
  // Shards declined for hydration-timeout: held UNPLACED while the data
  // backend is globally unhealthy (re-granting would just burn identifies);
  // the first healthy report re-enters them into placement.
  const timeoutDeclinedShards = new Set<number>();

  // Boot takeover guard (PLAN_STANDBY 3.2) + previous-holder capture for the
  // ruling-5 takeover chain. The override's one-shot flags are read BEFORE the
  // CAS and consumed right after it succeeds.
  const bootOverride = readRoleOverride();
  // A staged takeover is consent only while nothing has held the fleet since
  // it was staged: a holder sighting at or after the override's own stamp (the
  // engine refuses to stage over an older one) means the fleet moved past it
  // while the restart never took. Booting on it would skip the guard and the
  // fence onto a fleet somebody else holds, so the boot runs both instead,
  // which park or hold on the live holder; keyed on the override rather than
  // the promote record, which its own lane may have finished or dismissed
  // meanwhile. The operator's Cancel on the record clears both, and the env
  // confirm stays the deliberate seizure, chain included.
  const envConfirm = (process.env.FLEET_CONFIRM_TAKEOVER || '').trim() === '1';
  const stagedSeen = bootOverride?.takeover === true || bootOverride?.chainTakeover === true ? readHolderSighting() : null;
  const stagedSuperseded = !!stagedSeen && stagedSeen.nodeId !== nodeId && stagedSeen.seenAt >= bootOverride!.setAt;
  if (stagedSuperseded && !envConfirm) {
    console.error(`[Fleet] TAKEOVER NOT HONOURED: node ${stagedSeen!.nodeId.slice(0, 8)} has held the fleet at term ${stagedSeen!.term} since this takeover was staged; booting through the takeover guard and the stale-master fence instead. Cancel the promote that staged it on the Fleet tab if it is still on record, or demote this node there; FLEET_CONFIRM_TAKEOVER=1 on this node seizes the fleet deliberately`);
  }
  const takeoverConfirmed = (bootOverride?.takeover === true && !stagedSuperseded) || envConfirm;
  const chainTakeover = !standalone && bootOverride?.chainTakeover === true && (!stagedSuperseded || envConfirm);
  let previousHolder: { term: number; nodeId: string } | null = null;
  // The guard watches for a FROZEN term row and reports its holder as takeover
  // chain input. A stand-in's row is frozen by construction on BOTH of its
  // boots: serve-only because the master is gone and this node never stamps,
  // writes because the copy has left recovery and nothing can advance the row
  // but this node's own mint. Watching it for 90 s would measure nothing and
  // hand back a chain input that must never be acted on (chaining ends in a
  // Declare Lost, which F8 forbids an automatic lane). The evidence the guard
  // would have supplied was gathered by the arm conjunction and re-proved by
  // the write step before either override was written.
  if (store instanceof PostgresControlStore && !standalone && !standIn) {
    previousHolder = await runTakeoverGuard(store, nodeId, takeoverConfirmed);
  }
  // The fence stays ON for a stand-in: its PEER half parks on any answering peer
  // at an equal or higher term, which is how a master that came back between the
  // arm decision and this boot is caught. Two things differ for a stand-in: the
  // terminal park becomes a disarm, and the otherwise unbounded hold on an
  // unreadable store is bounded.
  // The witness half does NOT catch that case, because an inherited term equals
  // the returning master's and higherTermClaim is strictly-greater; the pre-arm
  // contestedTerm check is what covers an undialable one.
  const stagedTakeover = bootOverride?.takeover === true && !stagedSuperseded;
  const followerHold = await runStaleMasterFence(store, nodeId, nodeName, standalone, envConfirm, stagedTakeover, stagedTakeover ? bootOverride?.supersededStoreDead ?? null : null, serveOnly);
  if (followerHold) {
    if (store instanceof PostgresControlStore) await store.close();
    return { followerHold };
  }

  // The boot cleared every gate, so the brand-new-fleet answer has been spent
  // on the store it was given for.
  if (usedFreshConfirm) clearFreshFleetConfirm();
  // Past every gate this node holds the fleet itself; the holder it last saw
  // is one it has replaced.
  clearHolderSighting();
  // A stand-in INHERITS the term instead of minting one. Minting is an INSERT,
  // which a replica refuses, and acquireTerm retries forever, so on this path it
  // is not merely wrong but a guaranteed wedge. Inheriting is also the correct
  // semantics: the stand-in is holding the dead master's term open until it
  // returns, not starting an era of its own, and a higher term would make the
  // returning master's own boot fence park it out of its fleet.
  let term: number;
  if (serveOnly) {
    const inherited = await standInGuard('reading the inherited term', () => store.getTerm());
    if (!inherited || !Number.isFinite(inherited.term) || inherited.term <= 0) {
      return disarmStandIn('the replayed control store carries no term row to stand in at');
    }
    // The record was written before a restart; if the row now names a different
    // master, this node would publish standingInFor X while holding Y's term,
    // and the returning master's fence exception keys on the published name.
    if (inherited.nodeId !== coveringNodeId) {
      return disarmStandIn(`the term row now names ${inherited.nodeId}, not the ${coveringNodeId} this node armed to cover`);
    }
    term = inherited.term;
    // Re-read rather than spread: the boot already wrote attempts+1 to DISK,
    // but this closure still holds the object as it was BEFORE that write, so
    // spreading it would rewind the counter and leave the cap unable to bound
    // the reboot loop it exists for.
    const onDisk = readArmRecord() ?? armRecord!;
    // A record in phase promoting stays promoting: the parent may hold a parked
    // write step for it, and Continue needs that phase while Cancel needs a copy
    // still in recovery, so writing serving over it here would close both exits.
    writeArmRecord({ ...onDisk, phase: onDisk.phase === 'promoting' ? 'promoting' : 'serving', inheritedTerm: term, inheritedFrom: inherited.nodeId });
    console.warn(`[Fleet] STANDING IN for ${coveringNodeId} at inherited term ${term}; serving READ-ONLY until the write step`);
  } else {
    term = await store.acquireTerm(nodeId).catch((error: unknown) => {
      if (error instanceof ControlStoreReadOnlyError) return parkOnReadOnlyStore(error);
      throw error;
    });
    if (standIn) {
      // The inherited term becomes an OWNED one here, one above it, on the copy
      // that now holds the fleet's writes. The number is the whole signal: a
      // stand-in at the master's own term is serve-only and reversible, so the
      // returning master continues past it; a stand-in at a higher term has
      // taken writes, so the returning master parks on it (20.14 lineage) until
      // the failback lane exists to sync it from this copy first.
      const onDisk = readArmRecord();
      if (onDisk) writeArmRecord({ ...onDisk, phase: 'promoted', promotedAt: onDisk.promotedAt ?? Date.now(), writeRequestedAt: null, writeGate: null });
      console.error(`[Fleet] STANDING IN for ${coveringNodeId} WITH WRITES at term ${term} (inherited ${armRecord!.inheritedTerm ?? 'unknown'}): this copy is the fleet database until the master returns for failback or an operator promotes this node for good`);
    }
  }
  if (bootOverride?.takeover || bootOverride?.chainTakeover) consumeTakeoverFlags();
  // The stamp is this master's own lease (PLAN_STANDBY 3.1): deposed masters
  // learn of it within one interval, and stamp health feeds the fleet-state banner.
  // Suppressed while standing in: the stamp is an UPDATE, and a zero-row result
  // latches the control-store fence. The stand-in does not own this term and
  // must not start claiming its lease.
  if (store instanceof PostgresControlStore && !standalone && !serveOnly) {
    const stampTimer = setInterval(() => void store.stampTerm(), TERM_STAMP_MS);
    stampTimer.unref();
  }

  // Fleet runtime config (PLAN_REPLICATION 20.7, B2): the stored copy owns the
  // topology once it exists; the env list seeds it exactly once, on the first
  // master boot against a store that has none.
  let fleetConfig: PersistedFleetConfig | null = null;
  if (!standalone) {
    fleetConfig = await standInGuard('reading the fleet config', () => store.loadFleetConfig());
    // A stand-in reads the topology and never rewrites it: the seed and the
    // self-removal below are both writes, and the list it would be editing
    // belongs to the master it is covering.
    if (!fleetConfig && serveOnly) {
      return disarmStandIn('the replayed control store carries no fleet config to serve from');
    }
    if (!fleetConfig) {
      // Seed from the UNFILTERED env list: the stored copy is fleet-wide and
      // must include this master's own URL (workers dial it); the per-node
      // self-filter applies at dial time (effectiveMasterUrls).
      fleetConfig = { revision: 1, masterCandidates: rawMasterUrls(), backupDesignations: [], updatedAt: Date.now() };
      await store.saveFleetConfig(fleetConfig)
        .catch(err => console.warn('[Fleet] Failed to persist the seeded fleet config:', err instanceof Error ? err.message : err));
    }
    // Before the self-removal below, so a promoted backup that was the only
    // designation still carries the fact that this fleet has had one.
    if (fleetConfig) fleetConfig = rememberBackups(fleetConfig);
    // A master is not its own backup: a promoted backup's entry, pushed to every
    // node until now, leaves the list it now owns.
    if (!standIn && fleetConfig && fleetConfig.backupDesignations.some(d => d.nodeId === nodeId)) {
      fleetConfig = {
        ...fleetConfig,
        revision: fleetConfig.revision + 1,
        backupDesignations: renumberDesignations(fleetConfig.backupDesignations.filter(d => d.nodeId !== nodeId)),
        updatedAt: Date.now(),
      };
      await store.saveFleetConfig(fleetConfig)
        .catch(err => console.warn('[Fleet] Failed to persist the fleet config after dropping this master from its backups:', err instanceof Error ? err.message : err));
    }
  }
  const fleetConfigPayload = (): FleetConfigPayload => ({
    revision: fleetConfig!.revision,
    masterCandidates: fleetConfig!.masterCandidates,
    backupDesignations: fleetConfig!.backupDesignations,
    ...(fleetConfig!.witnessChannelId !== undefined ? { witnessChannelId: fleetConfig!.witnessChannelId } : {}),
    ...(fleetConfig!.hadBackup === true ? { hadBackup: true } : {}),
  });
  if (fleetConfig) writeFleetConfigCache(fleetConfigPayload());

  const gateway = await fetchGatewayInfo(process.env.DISCORD_TOKEN);
  if (!gateway && process.env.DISCORD_TOKEN) {
    console.warn('[Fleet] /gateway/bot unreachable; assuming 1 recommended shard');
  }
  const maxConcurrency = gateway?.maxConcurrency ?? 1;
  const recommendedShards = gateway?.recommendedShards ?? null;
  const shardCount = resolveShardCount(gateway?.recommendedShards ?? 1);

  const registry = new Registry();
  registry.term = term;
  registry.shardCount = shardCount;
  registry.upsertNode({ nodeId, nodeName, appVersion, capabilities, isSelf: true, send: null });

  // Declared before the recovery self-grant below (grantShardsTo reads it);
  // constructed after the recovery sources exist.
  let transformer: TransformationCoordinator | null = null;

  const ledger = standalone ? null : new IdentifyLedger(process.env.DISCORD_TOKEN, registry, gateway?.sessionStartLimit ?? null);

  // One pending ledger-retry timer: every refusal in a window coalesces into
  // a single deferred distribute() (the 5s tick re-evaluates anyway).
  let ledgerRetryTimer: NodeJS.Timeout | null = null;
  function scheduleLedgerRetry(retryInMs: number): void {
    if (ledgerRetryTimer) return;
    ledgerRetryTimer = setTimeout(() => {
      ledgerRetryTimer = null;
      void distribute();
    }, retryInMs);
    ledgerRetryTimer.unref();
  }

  // Deferral warn throttle: once per node per refusal window; a NEW refusal
  // reason warns immediately even inside an older window.
  const ledgerDeferWarnAt = new Map<string, { until: number; category: string }>();
  function warnLedgerDeferred(node: RegistryNode, shardIds: number[], verdict: { retryInMs: number; reason: string }): void {
    const now = Date.now();
    const category = verdict.reason.startsWith('budget floor') ? 'budget floor' : verdict.reason;
    const prev = ledgerDeferWarnAt.get(node.nodeId);
    if (prev && now < prev.until && prev.category === category) return;
    ledgerDeferWarnAt.set(node.nodeId, { until: now + verdict.retryInMs, category });
    console.warn(`[Fleet] Grant of [${shardIds.join(', ')}] to ${node.nodeName} deferred by identify ledger (${verdict.reason}); retrying in ${Math.ceil(verdict.retryInMs / 1000)}s`);
  }

  // Heartbeat/held-lease claims are ledger-trusted only when they postdate the
  // node's last LEASE_REVOKE: frames built mid-teardown still claim revoked
  // shards, and trusting them would charge 0 for real identifies. Every revoke
  // send goes through sendRevoke so the barrier covers all sites.
  const lastRevokeSentAt = new Map<string, number>();
  const revokesInFlight = new Map<string, number>();
  function sendRevoke(revokeNodeId: string, revoke: LeaseRevokePayload): Promise<any> {
    lastRevokeSentAt.set(revokeNodeId, performance.now());
    revokesInFlight.set(revokeNodeId, (revokesInFlight.get(revokeNodeId) ?? 0) + 1);
    return server!.request(revokeNodeId, MSG.LEASE_REVOKE, revoke).finally(() => {
      const left = (revokesInFlight.get(revokeNodeId) ?? 1) - 1;
      if (left > 0) revokesInFlight.set(revokeNodeId, left);
      else revokesInFlight.delete(revokeNodeId);
      if (registry.nodes.has(revokeNodeId)) lastRevokeSentAt.set(revokeNodeId, performance.now());
      else lastRevokeSentAt.delete(revokeNodeId);
    });
  }

  // Grant leaseIds currently awaiting their ack, so register-time fencing can
  // tell the master's own in-flight grant apart from Declare-Lost/drain residue.
  const inFlightGrantLeases = new Map<string, Set<string>>();

  // Restart recovery (fleet mode only; evaluateRecovery never reads the store
  // standalone): adopt the persisted plan so owned shards never move across a
  // master restart. Self leases are re-granted immediately (the old process's
  // sessions died with it); remote leases seed the shardTable at their old
  // (term, epoch) and read as frozen until their node re-registers.
  const rec = await standInGuard('reading the persisted plan', () => evaluateRecovery(store, {
    newTerm: term,
    resolvedShardCount: shardCount,
    liveRecommendation: recommendedShards,
    override: getShardCountOverride(),
    standalone,
    dataBackend: resolveDataBackend(),
    termInherited: serveOnly,
  }));
  // Reshard pause: while the marker exists NOTHING is auto-assigned - no
  // self-claim, no Phase R/F (distribute returns immediately). Manual assign
  // and Resume are allowed only after the hold-down window (a partitioned
  // old-count holder inside its lease TTL never re-registers, so only time
  // guarantees its sessions died). Cleared only by fleetResumeAssignments
  // deleting the marker.
  let paused = rec.reshardPaused !== undefined;
  if (rec.plan) {
    const plan = rec.plan;
    registry.shardCount = plan.shardCount;
    registry.epoch = plan.epoch;
    for (const assignment of plan.assignments) {
      for (const lease of assignment.leases) {
        registry.shardTable.set(lease.shardId, {
          shardId: lease.shardId,
          nodeId: assignment.nodeId,
          leaseId: lease.leaseId,
          term: plan.term,
          epoch: plan.epoch,
        });
      }
    }
    for (const persistedNode of rec.nodes ?? []) {
      if (persistedNode.nodeId === nodeId) continue;
      registry.restoreNode(persistedNode);
    }
    const selfShardIds = registry.shardIdsOf(nodeId);
    if (selfShardIds.length > 0) {
      registry.epoch += 1;
      await grantShardsTo(registry.nodes.get(nodeId)!, selfShardIds, registry.epoch);
    }
    console.log(`[Fleet] Recovery: adopted plan (term ${term}, epoch ${registry.epoch}, ${registry.shardCount} shards${paused ? ', reshard pause active' : `, hold-down ${Math.round(RECOVERY_HOLDDOWN_MS / 1000)}s`})`);
  }

  const pinnedShardId = resolvePinnedShardId(registry.shardCount);

  const recoverySource: FleetRecoverySource | null = standalone ? null : {
    adopted: rec.plan !== undefined,
    holdDownUntil: 0,
    reshardAdvised: rec.reshardAdvised ?? null,
    reshardApplied: rec.reshardApplied ? { from: rec.reshardApplied.from, to: rec.reshardApplied.to } : null,
    reshardNeedsConfirm: rec.reshardNeedsConfirm ?? null,
    reshardPaused: rec.reshardPaused ?? null,
  };

  let server: ControlServer | null = null;
  let syncAuthority: SyncAuthority | null = null;

  // Persist + push a fleet-config change (B2). The cache write is synchronous
  // truth for this node; the store write and the per-node pushes are fire-and-
  // forget (a missed push is re-delivered on that node's next register).
  const persistFleetConfig = (why: string): void => {
    if (!fleetConfig) return;
    fleetConfig = rememberBackups(fleetConfig);
    const payload = fleetConfigPayload();
    writeFleetConfigCache(payload);
    void store.saveFleetConfig(fleetConfig)
      .catch(err => console.warn(`[Fleet] Failed to persist fleet config (${why}):`, err instanceof Error ? err.message : err));
    for (const node of registry.nodes.values()) {
      if (node.isSelf || !node.connected) continue;
      void server?.request(node.nodeId, MSG.CONFIG_UPDATE, payload).catch(() => { /* re-delivered on register */ });
    }
    console.log(`[Fleet] Fleet config revision ${fleetConfig.revision} (${why}) pushed to the fleet`);
  };
  masterConfigSet = async (candidates: string[], witnessChannelId: unknown, backupDesignations: unknown) => {
    if (!fleetConfig) return { ok: false, error: 'a standalone master holds no fleet config' };
    const valid = validateMasterCandidates(candidates);
    if (!valid.ok) return { ok: false, error: valid.error };
    // Undefined = the caller did not touch the order; a list replaces it whole.
    let designations: { nodeId: string; priority: number }[] | undefined;
    if (backupDesignations !== undefined) {
      const known = new Set<string>([...registry.nodes.keys(), ...fleetConfig.backupDesignations.map(d => d.nodeId)]);
      // A node absent from the registry cannot be shown to consent, and silence
      // never buys active mode (20.5, B6 map F7).
      const order = validateBackupDesignations(backupDesignations, known, id => registry.nodes.get(id)?.capabilities?.activeCapable === true);
      if (!order.ok) return { ok: false, error: order.error };
      if (order.designations.some(d => d.nodeId === nodeId)) return { ok: false, error: 'the master is not its own backup' };
      designations = order.designations;
    }
    // Undefined = the caller did not touch the witness field; empty = clear to the owner DM default.
    const witness = witnessChannelId === undefined
      ? { ok: true as const, value: fleetConfig.witnessChannelId }
      : validateWitnessChannelId(witnessChannelId);
    if (!witness.ok) return { ok: false, error: witness.error };
    fleetConfig = {
      ...fleetConfig,
      revision: fleetConfig.revision + 1,
      masterCandidates: valid.urls,
      ...(designations ? { backupDesignations: designations } : {}),
      updatedAt: Date.now(),
    };
    if (witness.value !== undefined) fleetConfig.witnessChannelId = witness.value;
    else delete fleetConfig.witnessChannelId;
    persistFleetConfig('config edited');
    return { ok: true, revision: fleetConfig.revision };
  };
  let coordinator: MigrationCoordinator | null = null;
  let selfExecutor: MigrationExecutor | null = null;
  let pinViolation: PinViolationView | null = null;

  // Confirmed-down actions beyond the monitor's own bookkeeping: terminate a
  // silent-but-open socket so markDisconnected freeze semantics engage, and
  // persist the bumped epoch + loss ring. Never moves a lease.
  const healthMonitor = standalone ? null : new HealthMonitor({
    registry,
    onTransition: (transNodeId, _from, to) => {
      if (to !== 'down') return;
      server?.dropNode(transNodeId);
      // A confirmed-down node that is a migration participant is a node-down
      // event for the coordinator (pre-commit -> abort; post-commit -> retries).
      coordinator?.onNodeDown(transNodeId);
      // A confirmed LOSS auto-pauses an active transformation (spec 3.3);
      // plain disconnects do not - in-flight converts fail loudly on their own.
      transformer?.onNodeDown(transNodeId);
      persist().catch(error => console.warn('[Fleet] Persist after down transition failed:', error instanceof Error ? error.message : error));
    },
  });
  if (healthMonitor) healthMonitor.seed((await standInGuard('reading the node registry', () => store.loadRegistry())).lostNodes ?? []);

  // graceOver gates nothing that auto-runs while paused (distribute returns
  // immediately), so paused boots start with it set; holdDownUntil is still
  // armed to time-fence Resume and manual assign against stale holders.
  let graceOver = standalone || paused;

  let distributeRunning = false;
  let distributeQueued = false;

  // Redistribute-proposal shards whose Resume grant hard-refused (ledger floor /
  // worker refusal) and are awaiting a bounded grant retry. They are fenced OFF
  // the free pool (distributeOnce subtracts them, like the coordinator fence) so
  // a data-blind distribute() can never load-place a shard whose only committed
  // copy sits on its proposal owner. Emptied as each proposal grant lands.
  const resumePendingShards = new Set<number>();
  const resumeProposalOwner = new Map<number, string>(); // shardId -> its proposal owner
  let resumeRetryTimer: NodeJS.Timeout | null = null;

  // STANDALONE master claims EVERY shard regardless of FLEET_SHARD_CAPACITY
  // (today's single-box behavior, byte-identical boot); the capacity cap
  // applies only in FLEET mode. Capacity 0 is a real declaration (a pure
  // standby that serves nothing, PLAN_STANDBY ruling 1); only absent/invalid
  // declarations fall back to 1. A fleet master that is the only node able to
  // hold shards (alone) takes every free shard past its capacity rather than
  // leave any unserved (B7-F15); a master declaring 0 cannot hold shards
  // either, so it stays out of the exception and the unassigned report names
  // the shards. The exception ends the moment another node that can hold
  // shards is up, but shards already taken stay until moved.
  const targetFor = (node: RegistryNode, alone = false): number => {
    if (node.isSelf && (standalone || (alone && declaredCapacityOf(node) > 0))) return registry.shardCount;
    return declaredCapacityOf(node);
  };
  const reshardHint = (): string =>
    recommendedShards !== null && recommendedShards < registry.shardCount
      ? `, or reshard: Discord recommends ${recommendedShards} shard(s), set FLEET_SHARD_COUNT`
      : '';

  // Master-side mirror of the worker's same-shape adopt: a grant identifies
  // NOTHING when it matches what the node currently holds (its heldLeases when
  // a fresh register awaits its grant, the lease table otherwise); any other
  // shape rebuilds the gateway, identifying the FULL granted set.
  function shardsForcingIdentify(node: RegistryNode, fullShardIds: number[]): number[] {
    let heldShardCount: number | null = null;
    let heldIds: number[] | null = null;
    if (node.isSelf) {
      const current = runtime.getCurrent();
      if (current) {
        heldShardCount = current.shardCount;
        heldIds = current.leases.map(l => l.shardId);
      }
    } else if (node.needsGrant) {
      // Prefer heartbeat truth over the register-time snapshot: a post-register
      // heartbeat under the current shardCount proves the lease set held NOW,
      // so a confirmed-then-re-granted set charges 0 like the worker's adopt.
      // The claim must also postdate the node's last revoke (none in flight):
      // a heartbeat built during the teardown still lists revoked shards.
      if (node.lastHeartbeatAt !== null && node.lastHeartbeatAt > node.registeredAt
          && !revokesInFlight.has(node.nodeId)
          && node.lastHeartbeatAt > (lastRevokeSentAt.get(node.nodeId) ?? 0)
          && node.lastShardCount === registry.shardCount) {
        heldShardCount = registry.shardCount;
        heldIds = node.shards.map(s => s.shardId);
      } else if (node.heldLeases) {
        heldShardCount = node.heldLeases.shardCount;
        heldIds = node.heldLeases.leases.map(l => l.shardId);
      }
    } else {
      heldShardCount = registry.shardCount;
      heldIds = registry.shardIdsOf(node.nodeId);
    }
    if (heldIds !== null && heldShardCount === registry.shardCount && sameShardSet(heldIds, fullShardIds)) return [];
    return fullShardIds;
  }

  // Mark a maybe-applied grant's NEW shards pending-confirmation (NOT free)
  // so they are never granted elsewhere and dual-identified.
  function stampPendingGrant(pendingNodeId: string, leases: LeaseInfo[], epoch: number): number[] {
    const alreadyHeld = new Set(registry.shardIdsOf(pendingNodeId));
    const pendingIds: number[] = [];
    for (const lease of leases) {
      if (alreadyHeld.has(lease.shardId)) continue;
      registry.pendingConfirmation.set(lease.shardId, {
        shardId: lease.shardId,
        nodeId: pendingNodeId,
        leaseId: lease.leaseId,
        term: registry.term,
        epoch,
        grantedAt: performance.now(),
      });
      pendingIds.push(lease.shardId);
    }
    return pendingIds;
  }

  async function grantShardsTo(node: RegistryNode, fullShardIds: number[], epoch: number): Promise<{ ok: boolean; pending: boolean }> {
    const identifying = ledger ? shardsForcingIdentify(node, fullShardIds) : [];
    if (ledger && identifying.length > 0) {
      // Reserve (permit + debit in one synchronous step) so concurrent grant
      // paths can never pass the floor on the same headroom; released only on
      // paths where the worker provably did not adopt.
      const verdict = ledger.reserve(node.nodeId, identifying.length);
      if (!verdict.ok) {
        warnLedgerDeferred(node, fullShardIds, verdict);
        scheduleLedgerRetry(verdict.retryInMs);
        return { ok: false, pending: false };
      }
      ledgerDeferWarnAt.delete(node.nodeId);
    }
    // A draining target never receives a grant: placements planned before the
    // drain and manual assigns to a draining node are refused before the send.
    if (!node.isSelf && registry.nodes.get(node.nodeId)?.draining) {
      ledger?.release(node.nodeId, identifying.length);
      return { ok: false, pending: false };
    }
    const reuseLeaseIds = new Map<number, string>();
    for (const lease of registry.shardTable.values()) reuseLeaseIds.set(lease.shardId, lease.leaseId);
    for (const pending of registry.pendingConfirmation.values()) reuseLeaseIds.set(pending.shardId, pending.leaseId);
    const leases = assignIdentifyDelays(new Map([[node.nodeId, fullShardIds]]), maxConcurrency, reuseLeaseIds).get(node.nodeId) ?? [];
    const grant: LeaseGrantPayload = { term: registry.term, epoch, shardCount: registry.shardCount, leases };
    const activeTransformationId = transformer?.activeId() ?? null;
    if (activeTransformationId) {
      // A shard placed mid-window arrives with the routes (and the URL) it
      // needs BEFORE hydration - without them a converted guild would be read
      // from the wrong backend and served empty.
      grant.transformationId = activeTransformationId;
      grant.dataRoutes = transformer!.routesView();
      const grantCreds = loadCredentials();
      const url = (grantCreds.DATA_BACKEND_LOCAL_URL || '').trim() || (grantCreds.DATA_BACKEND_URL || '').trim();
      if (url) grant.dataBackendUrl = url;
      const publicUrl = (grantCreds.DATA_BACKEND_PUBLIC_URL || '').trim();
      if (publicUrl) grant.dataBackendPublicUrl = publicUrl;
    }

    if (node.isSelf) {
      const ack = await runtime.applyGrant(grant);
      if (ack.ok) {
        registry.applyAssignment(node.nodeId, leases, registry.term, epoch);
        node.needsGrant = false;
      } else {
        ledger?.release(node.nodeId, identifying.length);
      }
      return { ok: ack.ok, pending: false };
    }

    const grantLeaseIds = leases.map(l => l.leaseId);
    const inFlight = inFlightGrantLeases.get(node.nodeId) ?? new Set<string>();
    for (const id of grantLeaseIds) inFlight.add(id);
    inFlightGrantLeases.set(node.nodeId, inFlight);
    try {
      const ack = await server!.request(node.nodeId, MSG.LEASE_GRANT, grant);
      // Drain raced this grant: never adopt it into the table; the shards stay
      // pending (off the free pool) until the teardown revoke is confirmed.
      if (registry.nodes.get(node.nodeId)?.draining) {
        if (ack?.ok) {
          stampPendingGrant(node.nodeId, leases, epoch);
          void revokeDrainedGrant(node.nodeId, grantLeaseIds);
        }
        return { ok: false, pending: false };
      }
      if (ack?.ok) {
        registry.applyAssignment(node.nodeId, leases, registry.term, epoch);
        registry.clearPendingForNode(node.nodeId);
        node.needsGrant = false;
        return { ok: true, pending: false };
      }
      // Refused (stale-term etc.): the worker did NOT adopt, so the shards stay free.
      ledger?.release(node.nodeId, identifying.length);
      console.error(`[Fleet] Grant refused by ${node.nodeName}: ${ack?.reason ?? 'unknown'}`);
      return { ok: false, pending: false };
    } catch (error) {
      if (registry.nodes.get(node.nodeId)?.draining) {
        stampPendingGrant(node.nodeId, leases, epoch);
        void revokeDrainedGrant(node.nodeId, grantLeaseIds);
        return { ok: false, pending: false };
      }
      // UNACKED grant fence: the worker may have applied it despite the lost
      // ack; heartbeats resolve the pending shards. The reservation is kept
      // (conservative); the budget refresh reconciles it against live truth.
      const pendingIds = stampPendingGrant(node.nodeId, leases, epoch);
      console.warn(
        `[Fleet] Grant to ${node.nodeName} unacked; shards [${pendingIds.join(', ')}] pending confirmation:`,
        error instanceof Error ? error.message : error,
      );
      return { ok: false, pending: true };
    } finally {
      for (const id of grantLeaseIds) inFlight.delete(id);
      if (inFlight.size === 0 && inFlightGrantLeases.get(node.nodeId) === inFlight) inFlightGrantLeases.delete(node.nodeId);
    }
  }

  function pendingShardIdsOf(pendingNodeId: string): number[] {
    const ids: number[] = [];
    for (const pending of registry.pendingConfirmation.values()) {
      if (pending.nodeId === pendingNodeId) ids.push(pending.shardId);
    }
    return ids;
  }

  // Full re-grant set: table leases plus unconfirmed pending grants, so a
  // re-grant never shrinks (and bounces) a worker that applied an unacked one.
  function reGrantSetOf(grantNodeId: string): number[] {
    return [...new Set([...registry.shardIdsOf(grantNodeId), ...pendingShardIdsOf(grantNodeId)])].sort((a, b) => a - b);
  }

  // Phase R: re-grant each connected node's full CURRENT set under the current
  // term. No shard changes hands, so it is conflict-free and exempt from the
  // hold-down; workers see the same shard set + shardCount and adopt without a
  // session bounce. Ledger-refused nodes are filtered out BEFORE the epoch
  // bump so refused rounds are free of epoch/persist churn.
  async function reGrantOnly(): Promise<void> {
    const needing = [...registry.nodes.values()].filter(node => {
      if (!node.connected || node.draining) return false;
      let wants = node.needsGrant && registry.shardIdsOf(node.nodeId).length > 0;
      if (!wants) {
        for (const lease of registry.shardTable.values()) {
          if (lease.nodeId === node.nodeId && lease.term < registry.term) {
            wants = true;
            break;
          }
        }
      }
      if (!wants) return false;
      if (ledger) {
        const identifying = shardsForcingIdentify(node, reGrantSetOf(node.nodeId));
        if (identifying.length > 0) {
          const verdict = ledger.permit(node.nodeId, identifying.length);
          if (!verdict.ok) {
            warnLedgerDeferred(node, reGrantSetOf(node.nodeId), verdict);
            scheduleLedgerRetry(verdict.retryInMs);
            return false;
          }
        }
      }
      return true;
    });
    if (needing.length === 0) return;
    registry.epoch += 1;
    const epoch = registry.epoch;
    for (const node of needing) {
      await grantShardsTo(node, reGrantSetOf(node.nodeId), epoch);
    }
    await persist();
  }

  // Free-shard distribution: Phase R re-grants first, then (Phase F) FREE
  // shards go to the least-loaded eligible nodes (placement v1.5), the master
  // keeping the pinned shard. Owned and frozen shards are never touched here,
  // so a joining worker can only ever take shards nobody serves.
  async function distributeOnce(): Promise<void> {
    await reGrantOnly();
    // Fence: a shard under an active migration's in-flight window is off the
    // free pool until the migration grants it (or abort rolls it back), so the
    // free-shard distributor can never re-place a drained-but-not-yet-granted
    // shard onto a data-less node (double-ownership / dual-identify). reGrantOnly
    // stays unfiltered: re-granting a node its own current set is conflict-free.
    // A redistribute-proposal shard awaiting its Resume grant retry
    // (resumePendingShards) is fenced identically: it must land on its proposal
    // owner (which holds the data), never on a load-picked node. A shard with a
    // still-pending source cleanup (a source down at COMMITTING) is fenced too,
    // so a shard freed by a later Declare Lost is never load-placed back onto its
    // own un-cleaned source before the deferred graveyard runs.
    const migratingShards = coordinator?.migratingShardIds();
    const pendingCleanupShards = coordinator?.pendingSourceCleanupShardIds();
    // Transformation pinning (spec 3.3): a shard still holding a file-routed
    // window guild stays with its holder - placing it on a node without the
    // bytes would serve (and later convert) it empty. Fully-converted shards
    // place normally; grant-carried routes make that safe.
    const transformPinned = transformer?.pinnedShardIds();
    const fenced = (migratingShards?.size ?? 0) > 0 || (pendingCleanupShards?.size ?? 0) > 0
      || (transformPinned?.size ?? 0) > 0 || resumePendingShards.size > 0;
    const free = fenced
      ? registry.freeShards().filter(id => !migratingShards?.has(id) && !pendingCleanupShards?.has(id)
        && !transformPinned?.has(id) && !resumePendingShards.has(id))
      : registry.freeShards();
    if (free.length === 0) return;

    const pool = [...free];
    if (timeoutDeclinedShards.size > 0) {
      const selfBackend = getGuildDataBackend();
      const anyHealthy = (selfBackend ? selfBackend.healthy() : false)
        || [...registry.nodes.values()].some(n => n.connected && n.dataBackendHealthy === true);
      if (anyHealthy) {
        timeoutDeclinedShards.clear();
      } else {
        for (let i = pool.length - 1; i >= 0; i--) {
          if (timeoutDeclinedShards.has(pool[i])) pool.splice(i, 1);
        }
        if (pool.length === 0) return;
      }
    }
    const master = registry.nodes.get(nodeId);
    const grantsByNode = new Map<string, number[]>();
    const addGrant = (id: string, shardId: number) => {
      const arr = grantsByNode.get(id) ?? [];
      arr.push(shardId);
      grantsByNode.set(id, arr);
    };

    // Iron rule: the pinned shard is the master's; never hand it to a worker.
    if (pinnedShardId !== null && master && master.connected) {
      const idx = pool.indexOf(pinnedShardId);
      if (idx !== -1) {
        pool.splice(idx, 1);
        addGrant(nodeId, pinnedShardId);
      }
    }

    const alone = !otherNodeCanHoldShards(registry);
    const candidates = [...registry.nodes.values()].filter(n => !ledger || !ledger.inBackoff(n.nodeId));
    // Headroom counts pending-confirmation leases: they are not in the shard
    // table yet, but every composed grant re-delivers them (reGrantSetOf), so
    // they book capacity - otherwise a returning worker whose set is split
    // table/pending is undercounted and wins a free shard over its cap.
    const placements = pickFreePlacements(pool, candidates, registry, node =>
      targetFor(node, alone) - pendingShardIdsOf(node.nodeId).length - (grantsByNode.get(node.nodeId)?.length ?? 0));
    for (const [placedNodeId, shardIds] of placements) {
      for (const shardId of shardIds) addGrant(placedNodeId, shardId);
    }

    if (grantsByNode.size === 0) return;
    // Drop ledger-refused grants BEFORE the epoch bump: a fully-refused round
    // must not bump the epoch, persist or spam warns every tick.
    if (ledger) {
      for (const [grantNodeId, shardIds] of [...grantsByNode]) {
        const grantNode = registry.nodes.get(grantNodeId);
        if (!grantNode) {
          grantsByNode.delete(grantNodeId);
          continue;
        }
        const fullSet = [...new Set([...reGrantSetOf(grantNodeId), ...shardIds])].sort((a, b) => a - b);
        const identifying = shardsForcingIdentify(grantNode, fullSet);
        if (identifying.length === 0) continue;
        const verdict = ledger.permit(grantNodeId, identifying.length);
        if (!verdict.ok) {
          warnLedgerDeferred(grantNode, shardIds, verdict);
          scheduleLedgerRetry(verdict.retryInMs);
          grantsByNode.delete(grantNodeId);
        }
      }
      if (grantsByNode.size === 0) return;
    }
    registry.epoch += 1;
    const epoch = registry.epoch;

    // Deliver remote grants (and collect their acks) BEFORE the master's own
    // identify: a rejoining worker destroys stale sessions on adopt, so the
    // master never identifies into a shard a worker still holds.
    const execOrder = [...grantsByNode.keys()].sort((a, b) => {
      const aSelf = registry.nodes.get(a)?.isSelf ? 1 : 0;
      const bSelf = registry.nodes.get(b)?.isSelf ? 1 : 0;
      return aSelf - bSelf;
    });
    for (const grantNodeId of execOrder) {
      const node = registry.nodes.get(grantNodeId);
      if (!node) continue;
      const reGrant = reGrantSetOf(grantNodeId);
      const rawPlaced = grantsByNode.get(grantNodeId) ?? [];
      // Invariant backstop: an automatic grant never exceeds declared capacity.
      // Only load-picked FREE shards are trimmed - the re-grant set is the
      // node's own recorded holding, and the pinned shard is the master's by
      // the iron rule regardless of capacity (trimming it would strand it
      // free forever: workers are fenced off it above).
      const pinnedPlaced = pinnedShardId !== null ? rawPlaced.filter(id => id === pinnedShardId) : [];
      let trimmable = pinnedPlaced.length > 0 ? rawPlaced.filter(id => id !== pinnedShardId) : rawPlaced;
      const headroom = Math.max(0, targetFor(node, alone) - reGrant.length - pinnedPlaced.length);
      if (trimmable.length > headroom) {
        const trimmed = trimmable.slice(headroom);
        trimmable = trimmable.slice(0, headroom);
        console.warn(`[Fleet] Trimmed free placement [${trimmed.join(', ')}] to ${node.nodeName}: capacity ${targetFor(node, alone)} already booked by held+pending leases`);
      }
      const placed = [...pinnedPlaced, ...trimmable];
      if (placed.length === 0) continue;
      const fullSet = [...new Set([...reGrant, ...placed])].sort((a, b) => a - b);
      await grantShardsTo(node, fullSet, epoch);
    }

    await persist();
    if (!standalone) {
      const summary = [...registry.nodes.values()]
        .map(n => `${n.nodeName}${n.isSelf ? ' (self)' : ''}=[${registry.shardIdsOf(n.nodeId).join(', ')}]`)
        .join(' ');
      console.log(`[Fleet] Placement (term ${registry.term}, epoch ${epoch}, ${registry.shardCount} shards): ${summary}`);
    }
  }

  // Over capacity is never silent (B7-F15): after every distribution run the
  // master reads its own holding against its declared capacity (one rule,
  // overCapacityOf, shared with the fleet state) and prints an error line once
  // per change of the holding or of alone, so a restarted master that still
  // carries the whole fleet says so again.
  let overCapacityKey = '';
  function reportOverCapacity(): void {
    const view = standalone ? null : overCapacityOf(registry, nodeId, pinnedShardId);
    const key = view ? `${view.shardIds.join(',')}:${view.pinned}:${view.alone}` : '';
    if (key === overCapacityKey) return;
    if (view) {
      const exit = view.alone ? 'Start another instance and move shards to it' : 'Move shards to another node';
      const pin = view.pinned !== null ? `, plus pinned shard ${view.pinned} which stays here` : '';
      console.error(`[Fleet] OVER CAPACITY: this master holds [${view.shardIds.join(', ')}] (${view.shardIds.length} of ${registry.shardCount}${pin}) against declared capacity ${view.capacity}${view.alone ? ' as the only node able to hold shards' : ''}. ${exit}${reshardHint()}`);
    } else {
      console.log('[Fleet] The master is back within its declared capacity');
    }
    overCapacityKey = key;
  }

  // Unassigned shards are never silent (B7-F15): after every distribution
  // run the master names the free shards it could not place and why, once
  // per change, and the Fleet tab shows the same report. A fence, a reshard
  // pause, the register grace or the recovery hold-down defers distribution,
  // so the report is dropped there and starts afresh when it resumes.
  let unassigned: UnassignedView[] | null = null;
  let unassignedKey = '';
  function setUnassigned(next: UnassignedView[] | null): void {
    const key = next ? next.map(u => `${u.shardIds.join(',')}:${u.reason}`).join('|') : '';
    unassigned = next;
    if (key === unassignedKey) return;
    if (next) console.error(`[Fleet] UNASSIGNED shards ${next.map(u => `[${u.shardIds.join(', ')}]: ${u.reason}`).join('; ')}`);
    else if (unassignedKey !== '') console.log('[Fleet] Every shard is assigned again');
    unassignedKey = key;
  }
  function reportUnassigned(): void {
    const free = registry.freeShards();
    if (free.length === 0) {
      setUnassigned(null);
      return;
    }
    const alone = !otherNodeCanHoldShards(registry);
    const roomOf = (n: RegistryNode): number =>
      targetFor(n, alone) - registry.shardIdsOf(n.nodeId).length - pendingShardIdsOf(n.nodeId).length;
    const withRoom = [...registry.nodes.values()].filter(n => n.connected && !n.draining && roomOf(n) > 0);
    // Priced like the grant distributeOnce composes: a changed shape
    // identifies the whole set, a same-shape grant identifies nothing and
    // skips the ledger gate. A free placement also needs the node out of the
    // crash backoff (the candidate filter); the pinned shard is the master's
    // outside every capacity rule, so only the gate on its composed grant
    // can hold that one back.
    const LEDGER = 'deferred by the identify ledger; its warning names the retry';
    const ledgerRefuses = (n: RegistryNode, wouldHold: number[]): boolean => {
      if (!ledger) return false;
      const price = shardsForcingIdentify(n, [...new Set(wouldHold)].sort((a, b) => a - b)).length;
      return price > 0 && !ledger.permit(n.nodeId, price).ok;
    };
    const ledgerBlocks = (n: RegistryNode): boolean =>
      ledger !== null && (ledger.inBackoff(n.nodeId) || ledgerRefuses(n, [...reGrantSetOf(n.nodeId), ...free.slice(0, roomOf(n))]));
    const openReason = withRoom.length === 0
      ? 'no connected node has free capacity; start another instance or reshard'
      : withRoom.every(ledgerBlocks) ? LEDGER : 'placement pending';
    // The master's one composed grant carries the pin plus its free picks,
    // the pin having taken one slot of its room.
    const self = registry.nodes.get(nodeId);
    const pinReason = pinnedShardId !== null && self
      && ledgerRefuses(self, [...reGrantSetOf(nodeId), pinnedShardId, ...free.filter(id => id !== pinnedShardId).slice(0, Math.max(0, roomOf(self) - 1))])
      ? LEDGER : 'placement pending';
    const groups = new Map<string, number[]>();
    for (const shardId of free) {
      const reason = coordinator?.migratingShardIds().has(shardId) || coordinator?.pendingSourceCleanupShardIds().has(shardId)
          || transformer?.pinnedShardIds().has(shardId)
        ? 'held back by a migration or transformation in progress'
        : resumePendingShards.has(shardId)
          ? 'awaiting its redistribute grant'
          : timeoutDeclinedShards.has(shardId)
            ? 'declined after a hydration timeout, retried once a data backend is healthy'
            : shardId === pinnedShardId
              ? pinReason
              : openReason;
      groups.set(reason, [...(groups.get(reason) ?? []), shardId]);
    }
    setUnassigned([...groups].map(([reason, shardIds]) => ({ shardIds, reason })));
  }

  async function distribute(): Promise<void> {
    if (controlFenced || paused || !graceOver) {
      unassigned = null;
      unassignedKey = '';
    }
    if (controlFenced) return;
    if (paused) return;
    if (!graceOver) {
      try {
        await reGrantOnly();
      } catch (error) {
        console.error('[Fleet] Distribute failed:', error);
      }
      return;
    }
    if (distributeRunning) {
      distributeQueued = true;
      return;
    }
    distributeRunning = true;
    try {
      do {
        distributeQueued = false;
        await distributeOnce();
      } while (distributeQueued);
      reportUnassigned();
      reportOverCapacity();
    } catch (error) {
      console.error('[Fleet] Distribute failed:', error);
    } finally {
      distributeRunning = false;
    }
  }

  // Revoke-on-register (term fencing alone cannot stop a node re-registered
  // at the current term from serving its cached lease): a shardCount mismatch
  // kills the ENTIRE held set (stale-count shards are invisible to both the
  // foreign check and adoption, incl. out-of-range ids after a reshard down);
  // otherwise only leases the table records under ANOTHER owner die. A table
  // entry with the same owner but a drifted leaseId (adoption invented a
  // fresh id) is NOT foreign: Phase R re-issues the table's leaseIds via the
  // same-shape adopt. Unrecorded held shards are left for heartbeat-claims
  // adoption ONLY inside the designed adoption windows (this node's own
  // pending grant, pre-grace, reshard pause); anywhere else they are
  // Declare-Lost/drain residue racing an in-flight survivor grant and die here.
  async function reconcileHeldLeases(heldNodeId: string): Promise<void> {
    const node = registry.nodes.get(heldNodeId);
    const held = node?.heldLeases;
    if (!node || !held || held.leases.length === 0) return;
    let leaseIds: string[] = [];
    let reason = 'not-owner-after-reconcile';
    if (held.shardCount !== registry.shardCount) {
      leaseIds = held.leases.map(l => l.leaseId);
      reason = 'shard-count-mismatch';
    } else {
      for (const l of held.leases) {
        const lease = registry.shardTable.get(l.shardId);
        if (lease === undefined) {
          if (registry.pendingConfirmation.get(l.shardId)?.nodeId === heldNodeId) continue;
          if (inFlightGrantLeases.get(heldNodeId)?.has(l.leaseId)) continue;
          if (!graceOver || paused) {
            // Reserve the unrecorded held shard across the adoption window:
            // without the stamp the first post-grace/post-resume round could
            // grant it elsewhere before this node's heartbeat adoption lands.
            // A shard already reserved under ANOTHER node makes this claimant
            // the loser; register is its only fencing opportunity (a connected
            // zero-table node is never re-granted or revoked later), so the
            // contested lease dies here instead of ping-ponging identifies.
            if (!registry.pendingConfirmation.has(l.shardId)) {
              registry.pendingConfirmation.set(l.shardId, {
                shardId: l.shardId,
                nodeId: heldNodeId,
                leaseId: l.leaseId,
                term: held.term,
                epoch: held.epoch,
                grantedAt: performance.now(),
              });
              continue;
            }
          }
          leaseIds.push(l.leaseId);
        } else if (lease.nodeId !== heldNodeId) {
          leaseIds.push(l.leaseId);
        } else if (lease.leaseId !== l.leaseId) {
          node.needsGrant = true;
        }
      }
    }
    if (leaseIds.length === 0) return;
    if (reason === 'shard-count-mismatch') mismatchRevokeAt.set(heldNodeId, Date.now());
    const revoke: LeaseRevokePayload = { term: registry.term, leaseIds, reason };
    try {
      const ack = await sendRevoke(heldNodeId, revoke);
      if (ack?.ok) {
        // The worker destroyed those sessions before acking: prune them from
        // the held mirrors so the ledger cannot price a re-grant off them.
        const revoked = new Set(leaseIds);
        const revokedShardIds = new Set(held.leases.filter(l => revoked.has(l.leaseId)).map(l => l.shardId));
        if (node.heldLeases) {
          node.heldLeases = { ...node.heldLeases, leases: node.heldLeases.leases.filter(l => !revoked.has(l.leaseId)) };
        }
        node.shards = node.shards.filter(s => !revokedShardIds.has(s.shardId));
        if (node.lastRenewLeaseIds) node.lastRenewLeaseIds = node.lastRenewLeaseIds.filter(id => !revoked.has(id));
      }
      console.log(`[Fleet] Revoked ${leaseIds.length} stale lease(s) from ${node.nodeName} (${reason})`);
    } catch (error) {
      console.warn(`[Fleet] Reconcile revoke to ${node.nodeName} failed:`, error instanceof Error ? error.message : error);
    }
  }

  // A single register-time mismatch revoke can be lost (ack timeout) while
  // the worker keeps serving old-count shards inside its lease TTL and its
  // heartbeats still report them. Retry off those heartbeats, throttled,
  // until one arrives with the current count or no lease (no shardCount).
  const mismatchRevokeAt = new Map<string, number>();
  function maybeRetryMismatchRevoke(hbNodeId: string, hb: HeartbeatPayload): void {
    if (!Number.isInteger(hb.shardCount) || hb.shardCount === registry.shardCount) return;
    const node = registry.nodes.get(hbNodeId);
    const held = node?.heldLeases;
    if (!node || node.isSelf || !held || held.shardCount === registry.shardCount || held.leases.length === 0) return;
    const now = Date.now();
    if (now - (mismatchRevokeAt.get(hbNodeId) ?? 0) < LEASE_RENEW_MS) return;
    mismatchRevokeAt.set(hbNodeId, now);
    const revoke: LeaseRevokePayload = { term: registry.term, leaseIds: held.leases.map(l => l.leaseId), reason: 'shard-count-mismatch' };
    void sendRevoke(hbNodeId, revoke)
      .then(() => console.log(`[Fleet] Re-sent shard-count-mismatch revoke to ${node.nodeName} (${held.leases.length} lease(s))`))
      .catch(error => console.warn(`[Fleet] Mismatch revoke retry to ${node.nodeName} failed:`, error instanceof Error ? error.message : error));
  }

  // Drain teardown state: last revoke send time (heartbeat retry throttle) and
  // leaseIds from grants that settled mid-drain, unioned into every drain
  // revoke until the node provably holds nothing.
  const drainRevokeAt = new Map<string, number>();
  const drainExtraLeaseIds = new Map<string, Set<string>>();

  function recordedLeaseIdsOf(recNodeId: string): string[] {
    const ids: string[] = [];
    for (const lease of registry.shardTable.values()) {
      if (lease.nodeId === recNodeId) ids.push(lease.leaseId);
    }
    for (const pending of registry.pendingConfirmation.values()) {
      if (pending.nodeId === recNodeId) ids.push(pending.leaseId);
    }
    return ids;
  }

  // Every leaseId the node may hold: the master's records plus everything the
  // node itself reported (register summary, last renew, drain-raced grants) -
  // an adoption-invented table leaseId alone would make the revoke a no-op on
  // a worker still serving under the id it was actually granted.
  function drainLeaseIdsOf(drainNodeId: string): string[] {
    const ids = new Set<string>(recordedLeaseIdsOf(drainNodeId));
    const node = registry.nodes.get(drainNodeId);
    for (const l of node?.heldLeases?.leases ?? []) ids.add(l.leaseId);
    for (const id of node?.lastRenewLeaseIds ?? []) ids.add(id);
    for (const id of drainExtraLeaseIds.get(drainNodeId) ?? []) ids.add(id);
    return [...ids];
  }

  function clearCoveredLeases(coveredNodeId: string, leaseIds: string[]): void {
    const covered = new Set(leaseIds);
    for (const [shardId, lease] of registry.shardTable) {
      if (lease.nodeId === coveredNodeId && covered.has(lease.leaseId)) registry.shardTable.delete(shardId);
    }
    for (const [shardId, pending] of registry.pendingConfirmation) {
      if (pending.nodeId === coveredNodeId && covered.has(pending.leaseId)) registry.pendingConfirmation.delete(shardId);
    }
  }

  function clearDrainExtras(extraNodeId: string, leaseIds: string[]): void {
    const extras = drainExtraLeaseIds.get(extraNodeId);
    if (!extras) return;
    for (const id of leaseIds) extras.delete(id);
    if (extras.size === 0) drainExtraLeaseIds.delete(extraNodeId);
  }

  // A grant that settled after a drain started: the worker may have applied
  // it, so it is torn down, never adopted; its shards sit in pendingConfirmation
  // until the revoke ack (or a lease-free heartbeat) proves the teardown took.
  // A lost revoke is retried off the node's heartbeats via drainExtraLeaseIds.
  async function revokeDrainedGrant(drainNodeId: string, leaseIds: string[]): Promise<void> {
    const extras = drainExtraLeaseIds.get(drainNodeId) ?? new Set<string>();
    for (const id of leaseIds) extras.add(id);
    drainExtraLeaseIds.set(drainNodeId, extras);
    const revoke: LeaseRevokePayload = { term: registry.term, leaseIds, reason: 'operator drain' };
    try {
      const ack = await sendRevoke(drainNodeId, revoke);
      if (ack?.ok) {
        clearDrainExtras(drainNodeId, leaseIds);
        clearCoveredLeases(drainNodeId, leaseIds);
        persist().catch(error => console.warn('[Fleet] Persist after drain-race revoke failed:', error instanceof Error ? error.message : error));
        void distribute();
      }
    } catch (error) {
      console.warn(`[Fleet] Drain-race revoke to ${drainNodeId} unacked; retrying off heartbeats:`, error instanceof Error ? error.message : error);
    }
  }

  // Heartbeat-driven drain reconciliation: a draining node's heartbeat that
  // claims no lease proves the teardown took (only then are its shards freed);
  // one still claiming shards gets the union revoke re-sent, throttled.
  function maybeRetryDrainRevoke(hbNodeId: string): void {
    const node = registry.nodes.get(hbNodeId);
    if (!node || !node.draining) return;
    if (node.shards.length === 0) {
      drainRevokeAt.delete(hbNodeId);
      drainExtraLeaseIds.delete(hbNodeId);
      if (recordedLeaseIdsOf(hbNodeId).length === 0) return;
      registry.clearNodeAssignment(hbNodeId);
      registry.clearPendingForNode(hbNodeId);
      console.log(`[Fleet] Drain of ${node.nodeName} confirmed by heartbeat; its shards are freed`);
      persist().catch(error => console.warn('[Fleet] Persist after drain confirmation failed:', error instanceof Error ? error.message : error));
      void distribute();
      return;
    }
    const now = Date.now();
    if (now - (drainRevokeAt.get(hbNodeId) ?? 0) < LEASE_RENEW_MS) return;
    const leaseIds = drainLeaseIdsOf(hbNodeId);
    if (leaseIds.length === 0) return;
    drainRevokeAt.set(hbNodeId, now);
    const revoke: LeaseRevokePayload = { term: registry.term, leaseIds, reason: 'operator drain' };
    void sendRevoke(hbNodeId, revoke)
      .then(ack => {
        if (!ack?.ok) return;
        clearCoveredLeases(hbNodeId, leaseIds);
        clearDrainExtras(hbNodeId, leaseIds);
        console.log(`[Fleet] Drain revoke retry to ${node.nodeName} acked (${leaseIds.length} lease(s))`);
        persist().catch(error => console.warn('[Fleet] Persist after drain revoke retry failed:', error instanceof Error ? error.message : error));
        void distribute();
      })
      .catch(error => console.warn(`[Fleet] Drain revoke retry to ${node.nodeName} failed:`, error instanceof Error ? error.message : error));
  }

  masterAssign = async (shardId: number, targetNodeId: string): Promise<AssignResult> => {
    const holdRemainingMs = recoverySource ? recoverySource.holdDownUntil - Date.now() : 0;
    if (holdRemainingMs > 0) {
      return {
        success: false,
        error: paused
          ? `waiting for stale-holder leases to expire, ${Math.ceil(holdRemainingMs / 1000)}s remaining`
          : `recovery hold-down active, ${Math.ceil(holdRemainingMs / 1000)}s remaining`,
      };
    }
    if (!Number.isInteger(shardId) || shardId < 0 || shardId >= registry.shardCount) {
      return { success: false, error: `shard ${shardId} does not exist (valid 0..${registry.shardCount - 1})` };
    }
    const target = registry.nodes.get(targetNodeId);
    if (!target || !target.connected) {
      return { success: false, error: `node ${targetNodeId || '(none)'} is not connected` };
    }
    if (target.draining) {
      return { success: false, error: `node ${target.nodeName} is draining; restart it to rejoin placement` };
    }
    const held = registry.shardTable.get(shardId);
    if (held) {
      const holder = registry.nodes.get(held.nodeId);
      const holderName = holder?.nodeName ?? held.nodeId;
      if (holder && holder.connected) {
        return { success: false, error: `shard ${shardId} is held by ${holderName}; moving a served shard requires migration` };
      }
      return { success: false, error: `shard ${shardId} is frozen (held by disconnected ${holderName}); requires Declare Lost` };
    }
    if (registry.pendingConfirmation.has(shardId)) {
      return { success: false, error: `shard ${shardId} is pending confirmation; try again shortly` };
    }
    if (coordinator?.migratingShardIds().has(shardId)) {
      return { success: false, error: `shard ${shardId} is being migrated; wait for the migration to finish` };
    }
    if (resumePendingShards.has(shardId)) {
      // A redistribute-proposal shard still awaiting its Resume grant must land
      // on its proposal owner (which holds its data), never on a manual pick.
      return { success: false, error: `shard ${shardId} is awaiting its redistribute-proposal grant; try again shortly` };
    }
    if (coordinator?.pendingSourceCleanupShardIds().has(shardId)) {
      // The old source still holds this shard's frozen guilds pending cleanup;
      // assigning it there would serve stale data and never unfreeze.
      return { success: false, error: `shard ${shardId} has a pending source cleanup; try again shortly` };
    }
    if (transformer?.hasActive()) {
      return { success: false, error: 'a backend transformation is active; shard assignment is locked until it finishes' };
    }
    registry.epoch += 1;
    const fullSet = [...registry.shardIdsOf(targetNodeId), shardId].sort((a, b) => a - b);
    const result = await grantShardsTo(target, fullSet, registry.epoch);
    await persist();
    if (result.ok || result.pending) return { success: true };
    return { success: false, error: `grant to ${target.nodeName} was refused` };
  };

  // One grant pass over the still-fenced redistribute-proposal shards, grouped by
  // proposal owner. Only res.ok (adopted into shardTable) drops a shard from
  // resumePendingShards; a pending (unacked) grant keeps it fenced because
  // pendingConfirmation is not durable (reconcilePending frees an un-adopted
  // pending stamp), so a data-blind distribute() could otherwise load-place it.
  // A hard refusal ({ok:false,pending:false}, ledger floor / worker refusal /
  // disconnected owner) likewise keeps the shard fenced for the next retry.
  async function grantResumeProposal(): Promise<void> {
    if (resumePendingShards.size === 0) return;
    const byNode = new Map<string, number[]>();
    for (const shardId of resumePendingShards) {
      // A proposal owner that is already serving this shard (a prior retry landed
      // it, or a heartbeat confirmed a pending grant) needs no further grant.
      if (registry.shardTable.has(shardId)) { resumePendingShards.delete(shardId); continue; }
      const owner = resumeProposalOwner.get(shardId);
      if (!owner) { resumePendingShards.delete(shardId); continue; }
      const arr = byNode.get(owner) ?? [];
      arr.push(shardId);
      byNode.set(owner, arr);
    }
    if (byNode.size === 0) return;
    registry.epoch += 1;
    const epoch = registry.epoch;
    const order = [...byNode.keys()].sort((a, b) => {
      const aSelf = registry.nodes.get(a)?.isSelf ? 1 : 0;
      const bSelf = registry.nodes.get(b)?.isSelf ? 1 : 0;
      return aSelf - bSelf;
    });
    for (const proposalNodeId of order) {
      const node = registry.nodes.get(proposalNodeId);
      const shards = byNode.get(proposalNodeId) ?? [];
      // A disconnected proposal owner cannot receive the grant now; keep its
      // shards fenced (they hold the data) and retry when it reconnects.
      if (!node || (!node.connected && !node.isSelf)) continue;
      const fullSet = [...new Set([...registry.shardIdsOf(proposalNodeId), ...shards])].sort((a, b) => a - b);
      const res = await grantShardsTo(node, fullSet, epoch);
      if (res.ok) {
        // Adopted into shardTable: drop the resume fence so the shard is now
        // protected by the normal table machinery. A pending (unacked) grant is
        // NOT durable - reconcilePending frees an un-adopted pending stamp - so
        // its shards stay fenced and are re-granted next retry; if the worker had
        // in fact adopted, its heartbeat confirms the shard into shardTable and
        // the line-992 guard drops the fence on the following pass.
        for (const shardId of shards) resumePendingShards.delete(shardId);
      }
    }
    await persist();
  }

  // Bounded retry of the redistribute-proposal grants that hard-refused at Resume
  // (or whose owner was disconnected). Each tick re-runs grantResumeProposal; when
  // every proposal shard has landed the fence empties, the proposal file is
  // cleared, and a load-based distribute() runs for any leftover (unreachable-
  // holder) shards. Reuses XFER_COMMIT_RETRY_MS for cadence parity with the
  // coordinator's grant/commit retries.
  function scheduleResumeRetry(): void {
    if (resumeRetryTimer) return;
    resumeRetryTimer = setInterval(() => {
      void (async () => {
        try {
          await grantResumeProposal();
        } catch (error) {
          console.error('[Fleet] Resume proposal grant retry failed:', error);
          return;
        }
        if (resumePendingShards.size === 0) {
          clearResumeRetry();
          await store.saveRedistributeProposal(null);
          console.log('[Fleet] Reshard pause resume: all proposal grants landed');
          void distribute();
        }
      })();
    }, XFER_COMMIT_RETRY_MS);
    resumeRetryTimer.unref();
  }

  function clearResumeRetry(): void {
    if (resumeRetryTimer) { clearInterval(resumeRetryTimer); resumeRetryTimer = null; }
  }

  masterResume = async (): Promise<AssignResult> => {
    if (!paused) return { success: false, error: 'No reshard pause is active' };
    if (transformer?.hasActive()) {
      return { success: false, error: 'a backend transformation is active; finish or abort it first' };
    }
    const holdRemainingMs = recoverySource ? recoverySource.holdDownUntil - Date.now() : 0;
    if (holdRemainingMs > 0) {
      return { success: false, error: `waiting for stale-holder leases to expire, ${Math.ceil(holdRemainingMs / 1000)}s remaining` };
    }
    // Marker first: if the delete fails the pause must survive the next boot.
    await store.clearReshardMarker();
    paused = false;
    if (recoverySource) recoverySource.reshardPaused = null;
    // Redistribute placed each guild's data on its proposal owner; grant EXACTLY
    // that proposal so a guild is served by the node holding its committed data,
    // not a load-based re-distribute. Only shards actually in the proposal are
    // granted here; anything else (unreachable-holder shards) falls to distribute.
    const persistedProposal = await store.loadRedistributeProposal();
    if (persistedProposal) {
      // Fence EVERY proposal shard off the free pool BEFORE any grant: its only
      // committed copy sits on its proposal owner, so a data-blind distribute()
      // must never load-place it. Shards are removed from the fence only as their
      // grant lands (ok or pending-confirmation). A shard whose grant hard-refuses
      // (ledger floor / worker refusal) stays fenced and is retried on a timer;
      // the proposal file is kept until every proposal shard has landed, so a
      // retry or a fresh crash still re-grants EXACTLY the proposal owner.
      for (const [shardKey, proposalNodeId] of Object.entries(persistedProposal.proposal)) {
        const shardId = Number(shardKey);
        if (!Number.isInteger(shardId) || shardId < 0 || shardId >= registry.shardCount) continue;
        if (registry.shardTable.has(shardId)) continue; // already owned; do not reassign
        resumeProposalOwner.set(shardId, proposalNodeId);
        resumePendingShards.add(shardId);
      }
      if (resumePendingShards.size > 0) {
        await grantResumeProposal();
        if (resumePendingShards.size > 0) scheduleResumeRetry();
        else await store.saveRedistributeProposal(null);
      } else {
        await store.saveRedistributeProposal(null);
      }
      console.log('[Fleet] Reshard pause resumed: granted the redistribute proposal');
    } else {
      console.log('[Fleet] Reshard pause resumed: assignments re-enabled');
    }
    void distribute();
    return { success: true };
  };

  // Operator verdict on a down node (the Wait alternative). The epoch bump
  // orders every later grant after the verdict; if the node returns, its
  // re-register is a fresh node whose stale heldLeases the reconcile revokes.
  masterDeclareLost = async (targetNodeId: string): Promise<AssignResult> => {
    const node = registry.nodes.get(targetNodeId);
    if (!node) return { success: false, error: `node ${targetNodeId || '(none)'} is unknown` };
    if (node.isSelf) return { success: false, error: 'cannot declare the master node lost' };
    if (node.connected) return { success: false, error: 'node is connected; use Drain' };
    // Refused mid-transformation (spec 3.3) EXCEPT during RETIRING: post-flip
    // the data is safe in the destination and only the lost node's source
    // residue is affected - it is recorded and skipped.
    if (transformer?.hasActive() && !transformer.isRetiring()) {
      return { success: false, error: 'a backend transformation is active; abort it (or let it finish) before declaring nodes lost' };
    }
    // Declaring a migration participant lost is a node-down event for the
    // coordinator (pre-commit -> abort; post-commit -> retries at reconnect).
    coordinator?.onNodeDown(targetNodeId);
    transformer?.onNodeRemoved(targetNodeId);
    registry.epoch += 1;
    const shardIds: number[] = [];
    for (const [shardId, lease] of registry.shardTable) {
      if (lease.nodeId !== targetNodeId) continue;
      shardIds.push(shardId);
      registry.shardTable.delete(shardId);
    }
    for (const [shardId, pending] of registry.pendingConfirmation) {
      if (pending.nodeId !== targetNodeId) continue;
      shardIds.push(shardId);
      registry.pendingConfirmation.delete(shardId);
    }
    registry.nodes.delete(targetNodeId);
    // A node that is gone cannot stand in; its designation goes with it.
    if (fleetConfig && fleetConfig.backupDesignations.some(d => d.nodeId === targetNodeId)) {
      fleetConfig = {
        ...fleetConfig,
        revision: fleetConfig.revision + 1,
        backupDesignations: renumberDesignations(fleetConfig.backupDesignations.filter(d => d.nodeId !== targetNodeId)),
        updatedAt: Date.now(),
      };
      persistFleetConfig(`declared lost ${node.nodeName || targetNodeId}`);
    }
    drainRevokeAt.delete(targetNodeId);
    drainExtraLeaseIds.delete(targetNodeId);
    mismatchRevokeAt.delete(targetNodeId);
    ledgerDeferWarnAt.delete(targetNodeId);
    lastRevokeSentAt.delete(targetNodeId);
    shardIds.sort((a, b) => a - b);
    healthMonitor?.recordLoss({ nodeId: targetNodeId, nodeName: node.nodeName, shardIds, at: Date.now() });
    await persist();
    console.warn(`[Fleet] Node ${node.nodeName} DECLARED LOST; shards [${shardIds.join(', ')}] freed for redistribution`);
    void distribute();
    return { success: true };
  };

  // Manual lease drain (Part 3.3): the node is fenced out of placement FIRST
  // (draining set before any await; cleared on its next re-register), then
  // every leaseId it may hold is revoked; sessions are destroyed by the
  // revoke ack before any shard is freed, so the token is never
  // dual-identified. An unacked revoke keeps the table intact and resolves
  // off the node's heartbeats (maybeRetryDrainRevoke).
  masterDrainNode = async (targetNodeId: string): Promise<AssignResult> => {
    const node = registry.nodes.get(targetNodeId);
    if (!node) return { success: false, error: `node ${targetNodeId || '(none)'} is unknown` };
    if (node.isSelf) return { success: false, error: 'cannot drain the master node' };
    if (!node.connected) return { success: false, error: 'node is not connected; use Declare Lost' };
    if (transformer?.hasActive()) {
      return { success: false, error: 'a backend transformation is active; draining would move its shards mid-window' };
    }
    const holdRemainingMs = recoverySource ? recoverySource.holdDownUntil - Date.now() : 0;
    if (holdRemainingMs > 0) {
      return { success: false, error: `recovery hold-down active, ${Math.ceil(holdRemainingMs / 1000)}s remaining` };
    }
    node.draining = true;
    // A re-register during the drain's awaits cancels it (restart = rejoin);
    // the loop must never revoke the rejoined node's fresh leases or report
    // a drained node that is back in placement.
    const drainStartedAt = node.registeredAt;
    const drainCancelled = (): boolean => {
      const live = registry.nodes.get(targetNodeId);
      return !live || !live.draining || live.registeredAt !== drainStartedAt;
    };
    const cancelledResult: AssignResult = { success: false, error: 'node re-registered during drain; drain cancelled (rejoin clears the drain)' };
    const drain: NodeDrainPayload = { term: registry.term, reason: 'operator drain' };
    try {
      await server!.request(targetNodeId, MSG.NODE_DRAIN, drain);
    } catch (error) {
      console.warn(`[Fleet] Drain notice to ${node.nodeName} unacked:`, error instanceof Error ? error.message : error);
    }
    if (drainCancelled()) return cancelledResult;
    const revokedIds = new Set<string>();
    let unacked = false;
    for (let round = 0; round < 3; round++) {
      if (drainCancelled()) return cancelledResult;
      const leaseIds = drainLeaseIdsOf(targetNodeId).filter(id => !revokedIds.has(id));
      if (leaseIds.length === 0) break;
      const revoke: LeaseRevokePayload = { term: registry.term, leaseIds, reason: 'operator drain' };
      try {
        const ack = await sendRevoke(targetNodeId, revoke);
        if (!ack?.ok) {
          console.warn(`[Fleet] Drain revoke refused by ${node.nodeName}: ${ack?.reason ?? 'unknown'}`);
          unacked = true;
          break;
        }
      } catch (error) {
        console.warn(`[Fleet] Drain revoke to ${node.nodeName} unacked:`, error instanceof Error ? error.message : error);
        unacked = true;
        break;
      }
      for (const id of leaseIds) revokedIds.add(id);
      clearCoveredLeases(targetNodeId, leaseIds);
      clearDrainExtras(targetNodeId, leaseIds);
      if (recordedLeaseIdsOf(targetNodeId).length === 0) break;
    }
    if (drainCancelled()) return cancelledResult;
    if (unacked || recordedLeaseIdsOf(targetNodeId).length > 0) {
      drainRevokeAt.set(targetNodeId, Date.now());
      await persist();
      return { success: false, error: `drain pending confirmation: ${node.nodeName} has not confirmed the revoke; its leases stay recorded and the master retries off its heartbeats` };
    }
    await persist();
    console.log(`[Fleet] Node ${node.nodeName} drained (${revokedIds.size} lease(s) revoked); excluded from placement until it re-registers`);
    void distribute();
    return { success: true };
  };

  // The register reply hands workers the deployment's LIVE backend (the
  // route default, which transformation-required overrides), never the raw
  // env value: a fresh worker must serve from where the data actually lives.
  function buildDataBackendInfo(): DataBackendInfo {
    let live: 'file' | 'postgres' = 'file';
    try {
      live = currentRouteDefault();
    } catch { /* invalid DATA_BACKEND refused at data boot; deliver file */ }
    const transformationId = transformer?.activeId() ?? null;
    // The LOCAL form is delivered as the primary url (a master beside the
    // sidecar has it as its own DATA_BACKEND_URL; a remote master carries it
    // in DATA_BACKEND_LOCAL_URL because its own picked url is the public one).
    const creds = loadCredentials();
    const url = (creds.DATA_BACKEND_LOCAL_URL || '').trim() || (creds.DATA_BACKEND_URL || '').trim();
    const publicUrl = (creds.DATA_BACKEND_PUBLIC_URL || '').trim();
    if (transformationId) {
      // Mid-window delivery: the live default plus the routing map and the
      // URL (a file-default worker still needs the runtime for converted
      // guilds); post-flip (RETIRING) the changed default IS the flip
      // instruction for a node that missed the broadcast.
      return {
        backend: live,
        url,
        ...(publicUrl ? { publicUrl } : {}),
        transformationId,
        routes: transformer!.routesView(),
      };
    }
    if (live !== 'postgres') return { backend: 'file' };
    return { backend: 'postgres', url, ...(publicUrl ? { publicUrl } : {}) };
  }

  async function persist(): Promise<void> {
    const byNode = new Map<string, { leaseId: string; shardId: number; identifyDelayMs: number }[]>();
    for (const lease of registry.shardTable.values()) {
      const arr = byNode.get(lease.nodeId) ?? [];
      arr.push({ leaseId: lease.leaseId, shardId: lease.shardId, identifyDelayMs: 0 });
      byNode.set(lease.nodeId, arr);
    }
    await store.savePlan({
      term: registry.term,
      epoch: registry.epoch,
      shardCount: registry.shardCount,
      assignments: [...byNode.entries()].map(([assignedNodeId, leases]) => ({ nodeId: assignedNodeId, leases })),
      updatedAt: Date.now(),
    });
    await store.saveRegistry({
      nodes: [...registry.nodes.values()].map(n => ({
        nodeId: n.nodeId,
        nodeName: n.nodeName,
        appVersion: n.appVersion,
        capabilities: n.capabilities,
        lastSeenAt: Date.now(),
      })),
      lostNodes: healthMonitor?.getLossEvents(),
      updatedAt: Date.now(),
    });
  }

  const refusedRegistrations: FleetRefusedRegistration[] = [];

  // Backend transformation subsystem (spec 3.2): constructed on EVERY master,
  // standalone included (C6 - a mismatched standalone deployment transforms
  // itself). The master is a participant of its own transformation via a
  // local executor; sendControl mirrors the migration self-participant path.
  const transformExecutor = new TransformationExecutor({ getTerm: () => registry.term });
  transformer = new TransformationCoordinator({
    registry,
    store,
    isPaused: () => paused,
    holdDownRemainingMs: () => (recoverySource ? Math.max(0, recoverySource.holdDownUntil - Date.now()) : 0),
    migrationActive: () => (coordinator?.hasActive() ?? false) || (selfExecutor?.hasActiveLegs() ?? false),
    refusedRegistrationsPending: () => refusedRegistrations.length > 0,
    sendControl: (targetNodeId, type, data, timeoutMs) => {
      if (registry.nodes.get(targetNodeId)?.isSelf) return transformExecutor.handle(type, data);
      if (!server) return Promise.reject(new Error(`Node ${targetNodeId} is not reachable (no control server)`));
      return server.request(targetNodeId, type, data, timeoutMs);
    },
    pushStatus: () => pushFleetStatusNow(),
    persistEnvBackend: backend => {
      const result = upsertCredentials({ DATA_BACKEND: backend });
      if (!result.success) console.warn('[Fleet] Could not persist DATA_BACKEND after the flip:', result.error);
    },
  });
  masterTransformStart = payload => transformer!.start(payload);
  masterTransformPause = () => transformer!.pause();
  masterTransformResume = () => transformer!.resume();
  masterTransformAbort = () => transformer!.abort();

  if (!standalone) {
    const secret = (process.env.CONTROL_SECRET || '').trim();
    const port = Number(process.env.CONTROL_PORT) || CONTROL_PORT_DEFAULT;
    const refuse = (reason: string, payload: RegisterPayload | undefined): RegisterResult => {
      refusedRegistrations.push({ nodeName: payload?.nodeName || payload?.nodeId || 'unknown', reason, at: Date.now() });
      if (refusedRegistrations.length > LOSS_LOG_CAP) refusedRegistrations.shift();
      return { accepted: false, term: registry.term, reason };
    };
    syncAuthority = new SyncAuthority({
      getTerm: () => registry.term,
      listWorkers: () => [...registry.nodes.values()]
        .filter(n => !n.isSelf && n.connected)
        .map(n => ({ nodeId: n.nodeId, nodeName: n.nodeName, syncAppliedRevision: n.syncAppliedRevision, syncOk: n.syncOk })),
      pushToNode: (pushNodeId, statePayload) => server!.request(pushNodeId, MSG.SYNC_STATE, statePayload),
    });
    masterSyncBump = scope => syncAuthority!.bump(scope);

    // Migration subsystem (fleet master only; never constructed standalone).
    // The master is also a participant of its own migrations, so it runs a
    // self-executor; sendControl routes to a remote node via the server or to
    // this executor directly (the self-participant path mirrors the self-grant).
    const transferPort = Number(process.env.TRANSFER_PORT) || TRANSFER_PORT_DEFAULT;
    const selfTransferUrl = (process.env.TRANSFER_URL || '').trim() || undefined;
    selfExecutor = new MigrationExecutor({
      sendToMaster: (type, data) => {
        // Self-participant progress/verify routes straight into the coordinator;
        // the sender is this master node, which is a legitimate participant of
        // any leg it owns (the coordinator authenticates side <-> sender).
        if (type === MSG.XFER_PROGRESS) coordinator?.onProgress(nodeId, data);
        else if (type === MSG.XFER_VERIFY) coordinator?.onVerify(nodeId, data);
        else if (type === MSG.XFER_FLUSHED) coordinator?.onFlushed(nodeId, data);
      },
      selfTransferUrl: () => selfTransferUrl,
      transferPort: () => transferPort,
    });
    const executor = selfExecutor;
    coordinator = new MigrationCoordinator({
      registry,
      selfNodeId: nodeId,
      store,
      isPaused: () => paused,
      holdDownRemainingMs: () => (recoverySource ? Math.max(0, recoverySource.holdDownUntil - Date.now()) : 0),
      grantShardsTo: async (targetNodeId, fullShardIds, epoch) => {
        const node = registry.nodes.get(targetNodeId);
        if (!node) return { ok: false, pending: false };
        return grantShardsTo(node, fullShardIds, epoch);
      },
      revokeLease: async (targetNodeId, leaseIds, reason) => {
        if (registry.nodes.get(targetNodeId)?.isSelf) {
          const ack = await runtime.revoke(registry.term, leaseIds, reason);
          return { ok: ack.ok };
        }
        try {
          const ack = await sendRevoke(targetNodeId, { term: registry.term, leaseIds, reason });
          return { ok: !!ack?.ok };
        } catch {
          return { ok: false };
        }
      },
      drainLeaseIdsForShards: (targetNodeId, shardIds) => {
        // Robust lease-id union scoped to the moving shards: every id the node
        // may hold for those shards, so an adoption-invented table leaseId alone
        // cannot make the revoke a no-op. Shard-mappable sources (table, pending,
        // self.current, heldLeases summary) are filtered by shard directly; the
        // node's last-renew ids are shard-unmapped, so they are included ONLY
        // when they are not already recorded under a NON-migrating shard for
        // this node (those belong to shards that must keep serving).
        const wantShards = new Set(shardIds);
        const ids = new Set<string>();
        const keepIds = new Set<string>(); // ids the node holds for non-migrating shards
        for (const lease of registry.shardTable.values()) {
          if (lease.nodeId !== targetNodeId) continue;
          if (wantShards.has(lease.shardId)) ids.add(lease.leaseId);
          else keepIds.add(lease.leaseId);
        }
        for (const pending of registry.pendingConfirmation.values()) {
          if (pending.nodeId !== targetNodeId) continue;
          if (wantShards.has(pending.shardId)) ids.add(pending.leaseId);
          else keepIds.add(pending.leaseId);
        }
        const node = registry.nodes.get(targetNodeId);
        if (node?.isSelf) {
          for (const l of runtime.getCurrent()?.leases ?? []) {
            if (wantShards.has(l.shardId)) ids.add(l.leaseId);
            else keepIds.add(l.leaseId);
          }
        }
        for (const l of node?.heldLeases?.leases ?? []) {
          if (wantShards.has(l.shardId)) ids.add(l.leaseId);
          else keepIds.add(l.leaseId);
        }
        for (const id of node?.lastRenewLeaseIds ?? []) if (!keepIds.has(id)) ids.add(id);
        return [...ids];
      },
      persistPlan: () => persist(),
      saveRedistributeProposal: proposal =>
        store.saveRedistributeProposal(proposal ? { proposal, updatedAt: Date.now() } : null),
      loadRedistributeProposal: async () => (await store.loadRedistributeProposal())?.proposal ?? null,
      sendControl: (targetNodeId, type, data) => {
        if (registry.nodes.get(targetNodeId)?.isSelf) return executor.handle(type, data);
        return server!.request(targetNodeId, type, data);
      },
      isSelf: id => registry.nodes.get(id)?.isSelf === true,
      selfExecutor: executor,
      transferUrlOf: id => {
        if (registry.nodes.get(id)?.isSelf) return selfTransferUrl;
        return registry.nodes.get(id)?.capabilities?.transferUrl;
      },
      pushStatus: () => pushFleetStatusNow(),
      frozenWriteRejections: () => getFrozenStats().frozenWriteRejections,
      dataBackendHealthy: () => getGuildDataBackend()?.healthy() ?? false,
      onNodeDownDuringMigration: () => { /* coordinator aborts; the node-down bump is informational */ },
      transformationActive: () => transformer?.hasActive() ?? false,
    });
    masterMigrateStart = payload => coordinator!.start(payload);
    masterMigrateAbort = migrationId => coordinator!.abort(migrationId);
    masterMigrateResume = migrationId => coordinator!.resume(migrationId);
    masterMigratePrecheck = payload => coordinator!.precheck(payload);
    masterMigrateList = () => coordinator!.getView();
    migrationDispositionOf = migrationId => coordinator!.dispositionOf(migrationId);
    migrationWorkActive = () => coordinator!.hasActive() || selfExecutor!.hasActiveLegs();

    // Webui write-through-owner hop (6.3): the master routes an operator data
    // op to the guild's owning node over the control channel; a self-owned
    // guild applies through the local facade directly.
    setDataOpForwarder(async (kind, req) => {
      const shardId = guildIdToShardId(req.guildId, registry.shardCount);
      const owner = registry.shardTable.get(shardId);
      if (!owner) return { ok: false, code: 'not-owner', error: `shard ${shardId} is unassigned` };
      const node = registry.nodes.get(owner.nodeId);
      if (!node || (!node.connected && !node.isSelf)) {
        return { ok: false, code: 'owner-unreachable', error: 'owning instance is not connected' };
      }
      if (node.isSelf) {
        return kind === 'write'
          ? applyOperatorDataWrite(req as GuildDataWriteRequest)
          : applyOperatorDataRead(req as GuildDataReadRequest);
      }
      const type = kind === 'write' ? MSG.DATA_WRITE : MSG.DATA_READ;
      try {
        const reply = await server!.request(owner.nodeId, type, { term: registry.term, ...req, ...(kind === 'write' ? { origin: 'webui-operator' } : {}) });
        return reply ?? { ok: false, code: 'owner-unreachable', error: 'empty reply from the owning instance' };
      } catch (error) {
        return { ok: false, code: 'owner-unreachable', error: error instanceof Error ? error.message : String(error) };
      }
    });

    // Supersession (PLAN_REPLICATION 20.3 Case 2, 20.13; B4). A higher term
    // elsewhere means this node is no longer the master: it stops granting at
    // once, keeps serving the shards it holds, records the fact for its
    // manager, and steps down (co-worker override + restart) as soon as the
    // new master is proven up, by its STEP_DOWN notice or by a fresh
    // higher-term beacon, with a bounded fallback so a fenced master never
    // idles forever. A notice that carries the new data backend drains this
    // node's buffered writes into the new database before the restart.
    let supersededBy: { nodeId: string; nodeName: string; term: number } | null = null;
    let stepDownStaged = false;
    let supersededSince = 0;
    let supersededSource: SupersededSource = 'store-fence';
    // Latched once any supersession arrived through this copy's own term row
    // (the stamp found it taken, or a notice the row corroborated): the claim
    // landed here, which a later witness claim at a higher term cannot undo.
    let supersededOnCopy = false;
    const persistSupersession = (steppedDown: boolean): void => {
      if (!supersededBy) return;
      noteHolderSighting(supersededBy.nodeId, supersededBy.term, 'step-down', nodeId);
      const existing = readSuperseded();
      writeSuperseded({
        byNodeId: supersededBy.nodeId,
        byNodeName: supersededBy.nodeName,
        term: supersededBy.term,
        // A retire request only ever arrives from the new master's register
        // reply; never clear one this node already recorded.
        retireRequested: existing?.retireRequested === true,
        at: supersededSince,
        source: supersededSource,
        steppedDown,
      });
      _setSuperseded({ byNodeId: supersededBy.nodeId, byNodeName: supersededBy.nodeName, term: supersededBy.term, source: supersededSource, since: supersededSince, steppedDown });
      pushFleetStatusNow();
    };
    finishStepDown = (reason: string): void => {
      if (stepDownStaged || !supersededBy) return;
      stepDownStaged = true;
      if (standIn) {
        const arm = readArmRecord();
        if (arm && arm.phase !== 'disarmed') {
          // The lane's state first; then how the episode ended (B6-j), which
          // is the episode module's rule, from whether writes were taken and
          // whether the claim landed on this copy (the latch above).
          const ending = standInEnding(arm, { nodeId: supersededBy.nodeId, onCopy: supersededOnCopy });
          closeStandInLane(arm, nodeId, nodeName, supersededBy.nodeId === arm.coveringNodeId ? supersededBy.nodeName : null, ending, `${supersededBy.nodeName} took term ${supersededBy.term} ${supersededOnCopy ? 'on this copy' : 'on another database'}`, `${supersededBy.nodeName} holds a higher term (${supersededBy.term}); this node stops standing in`);
        }
      }
      persistSupersession(true);
      console.warn(`[Fleet] STEP-DOWN (${reason}): restarting in ${Math.round(STEPDOWN_HANDOVER_DELAY_MS / 1000)}s to rejoin under ${supersededBy.nodeName} (term ${supersededBy.term})`);
      setTimeout(() => requestStepDownRestart(), STEPDOWN_HANDOVER_DELAY_MS).unref();
      // The IPC send is the only way back to a co-worker, and it can be lost
      // (parent mid-restart, detached child), so it repeats until the process
      // is replaced. The override is already on disk either way.
      setInterval(() => requestStepDownRestart(), STEPDOWN_FALLBACK_MS).unref();
    };
    beginSupersession = (by, source): void => {
      if (source !== 'witness') supersededOnCopy = true;
      if (supersededBy) {
        // A newer claim supersedes the recorded one; the manager reads this
        // file to decide which node's database this side must follow.
        if (by.term > supersededBy.term) {
          supersededBy = by;
          supersededSource = source;
          persistSupersession(stepDownStaged);
        }
        return;
      }
      supersededBy = by;
      supersededSource = source;
      supersededSince = Date.now();
      controlFenced = true;
      onDeposedTeardown?.();
      // Stage the co-worker role NOW, not at the restart: a superseded master
      // that is restarted before its handover completes (host reboot, docker
      // restart policy) would otherwise boot as a master again against a
      // database the promote fenced read-only, where the control store's own
      // provisioning can never complete.
      if (resolveEnvRole() === 'co-worker') clearRoleOverride();
      else writeRoleOverride({ role: 'co-worker', setAt: Date.now(), setBy: 'stepdown' });
      persistSupersession(false);
      console.error(`[Fleet] SUPERSEDED (${source}) by ${by.nodeName} (${by.nodeId.slice(0, 8)}) at term ${by.term}; serving held shards until the new master is proven up`);
      setTimeout(() => finishStepDown?.('fallback timer'), STEPDOWN_FALLBACK_MS).unref();
    };
    // A fenced stamp names a successor only when the row actually holds one.
    // The same zero-row result also means the term row VANISHED (a restored or
    // truncated control database), which names nobody: stop granting there, but
    // never stage a permanent role change on evidence that says "unknown", or a
    // sole master would demote itself into a fleet with no master at all.
    const fenceWithoutSuccessor = (detail: string): void => {
      controlFenced = true;
      onDeposedTeardown?.();
      console.error(`[Fleet] CONTROL STORE FENCED with no successor named (${detail}); granting stopped and the role is unchanged. Check the control database before restarting this node.`);
      pushFleetStatusNow();
    };
    onSupersededByStore = observedTerm => {
      void store.getTerm()
        .then(row => {
          // Judged on the FRESH read, never on the fence's own observation:
          // that observation is -1 whenever the follow-up select failed too
          // (the promote's backend sweep does exactly that), and discarding a
          // successor the row plainly names would strand this node fenced with
          // no step-down at all.
          if (!row || row.nodeId === nodeId) {
            fenceWithoutSuccessor(row ? `the row is held by this node at term ${row.term}` : 'the term row is gone');
            return;
          }
          beginSupersession!({ nodeId: row.nodeId, nodeName: row.nodeId.slice(0, 8), term: Math.max(observedTerm, row.term) }, 'store-fence');
        })
        .catch(() => fenceWithoutSuccessor('the control store could not be re-read'));
    };
    // The buffered writes a fenced master could not flush are drained into the
    // new database before it restarts; keepPrevious spares the pool its own
    // control store shares (it still reads the store until the restart).
    const stepDownAfterBackend = (info: StepDownPayload['dataBackend']): void => {
      if (!info) { finishStepDown?.('step-down notice'); return; }
      void applyDeliveredBackend(info, { keepPrevious: true })
        .then(({ recycled }) => { if (recycled) runtime.renotifyDataLayer(); })
        .catch(error => console.error('[Fleet] Could not drain into the new master\'s database before stepping down:', error instanceof Error ? error.message : error))
        .finally(() => finishStepDown?.('step-down notice'));
    };

    server = new ControlServer({
      getTerm: () => registry.term,
      getNodeId: () => nodeId,
      getNodeName: () => nodeName,
      getStandingInFor: () => coveringNodeId,
      onStepDown: payload => {
        const noticeTerm = Number(payload?.term);
        if (!Number.isFinite(noticeTerm) || typeof payload?.nodeId !== 'string' || payload.nodeId === '') return { ok: false, reason: 'invalid' };
        if (payload.nodeId === nodeId) return { ok: false, reason: 'self' };
        if (noticeTerm <= registry.term) return { ok: false, reason: 'stale-term' };
        // The notice is a hint, never the authority: the control secret every
        // co-worker holds must not be enough to depose a master or to point it
        // at a database of the sender's choosing. The term row decides, and it
        // already holds the new master's claim by the time this arrives. An
        // unreadable store proves nothing, so the notice is ignored there and
        // the witness (20.6) is what covers a master whose database died.
        void (async () => {
          let row: PersistedTerm | null = null;
          try {
            row = await store.getTerm();
          } catch {
            console.warn(`[Fleet] Step-down notice from ${payload.nodeId.slice(0, 8)} (term ${noticeTerm}) cannot be corroborated (control store unreadable); ignoring it`);
            return;
          }
          // The row must name the SENDER and stand above this node's own term.
          // Its term is NOT compared with the notice's: a promoted node claims
          // once here and then again on its own copy at boot, so a genuine
          // notice always carries a term one above the row it wrote. The
          // holder is the real authority, and without it a secret holder could
          // ride a real supersession to point this node's data layer at a
          // store of its own choosing.
          if (!row || row.nodeId !== payload.nodeId || row.term <= registry.term) {
            console.warn(`[Fleet] Step-down notice from ${payload.nodeId.slice(0, 8)} (term ${noticeTerm}) is NOT corroborated by the term row (${row ? `term ${row.term}, holder ${row.nodeId.slice(0, 8)}` : 'no row'}); ignoring it`);
            return;
          }
          beginSupersession!({ nodeId: payload.nodeId, nodeName: payload.nodeName || payload.nodeId.slice(0, 8), term: Math.max(noticeTerm, row.term) }, 'step-down');
          stepDownAfterBackend(payload.dataBackend);
        })();
        return { ok: true };
      },
      onRegister: (payload: RegisterPayload, send): RegisterResult => {
        // Deposed: refuse with the reason the client treats as
        // advance-to-next-candidate, so redialing workers find the live master.
        if (controlFenced) {
          return refuse('deposed', payload);
        }
        if (!payload || typeof payload.nodeId !== 'string' || payload.nodeId.length === 0) {
          return refuse('invalid-register-payload', payload);
        }
        if (payload.protocolVersion !== PROTOCOL_VERSION) {
          return refuse(`protocol-version-mismatch (master ${PROTOCOL_VERSION})`, payload);
        }
        if (payload.appVersion !== appVersion) {
          return refuse(`app-version-mismatch (master ${appVersion})`, payload);
        }
        if (payload.nodeId === nodeId) {
          // A worker cloned from the master's data volume would collide in the registry.
          return refuse('node-id-collision-with-master', payload);
        }
        if (payload.heldLeases != null && !isValidHeldLeases(payload.heldLeases)) {
          return refuse('bad-held-leases', payload);
        }
        const node = registry.upsertNode({
          nodeId: payload.nodeId,
          nodeName: payload.nodeName || payload.nodeId,
          appVersion: payload.appVersion,
          // No declared capabilities: record 'unknown', never a guessed backend,
          // so the migration backend-skew check can tell "declared file" apart
          // from "never declared".
          capabilities: payload.capabilities ?? { shardCapacity: 1, dataBackend: 'unknown' },
          isSelf: false,
          send,
        });
        node.heldLeases = payload.heldLeases ?? null;
        // Re-register resets the drain (upsert cleared draining); the fresh
        // heldLeases summary is authoritative and reconciled right after.
        drainRevokeAt.delete(payload.nodeId);
        drainExtraLeaseIds.delete(payload.nodeId);
        mismatchRevokeAt.delete(payload.nodeId);
        ledgerDeferWarnAt.delete(payload.nodeId);
        ledger?.onRegister(payload.nodeId);
        console.log(`[Fleet] Node registered: ${payload.nodeName} (${payload.nodeId})`);
        // A backup-master's designation is env-seeded into the runtime config
        // on its first registration; from then on the stored list owns the
        // ORDER, and env stays the trigger: a node whose env no longer says
        // backup-master leaves the list on its next register (20.19 F8/F11).
        const listed = !!fleetConfig && fleetConfig.backupDesignations.some(d => d.nodeId === payload.nodeId);
        if (fleetConfig && payload.capabilities?.backupMaster === true && !listed) {
          const priority = fleetConfig.backupDesignations.reduce((max, d) => Math.max(max, d.priority), 0) + 1;
          fleetConfig = {
            ...fleetConfig,
            revision: fleetConfig.revision + 1,
            backupDesignations: [...fleetConfig.backupDesignations, { nodeId: payload.nodeId, priority }],
            updatedAt: Date.now(),
          };
          persistFleetConfig(`designated backup ${payload.nodeName || payload.nodeId}`);
        } else if (fleetConfig && payload.capabilities?.backupMaster !== true && listed) {
          fleetConfig = {
            ...fleetConfig,
            revision: fleetConfig.revision + 1,
            backupDesignations: renumberDesignations(fleetConfig.backupDesignations.filter(d => d.nodeId !== payload.nodeId)),
            updatedAt: Date.now(),
          };
          persistFleetConfig(`backup designation withdrawn ${payload.nodeName || payload.nodeId}`);
        } else if (fleetConfig && listed && payload.capabilities?.activeCapable !== true
          && fleetConfig.backupDesignations.some(d => d.nodeId === payload.nodeId && d.mode === 'active')) {
          // Consent withdrawn (or never declared by this build): the enable goes.
          // Only ever downward, so a master's own downgrade is never undone here
          // and re-enabling stays the master operator's act (20.5, B6 map F7).
          fleetConfig = {
            ...fleetConfig,
            revision: fleetConfig.revision + 1,
            backupDesignations: forcePassive(fleetConfig.backupDesignations, payload.nodeId),
            updatedAt: Date.now(),
          };
          persistFleetConfig(`active mode withdrawn ${payload.nodeName || payload.nodeId}`);
        }
        // B4 facts: the node this master superseded learns it here (and
        // whether the owner asked to retire it); designated backups, and the
        // node a stand-in covers, get the copy block a machine seeds from (the
        // failback re-seeds the returning master from it, B6 map F32).
        // Delivered ONCE (marked in afterRegister, once the reply is actually
        // on the wire): a standing retire instruction re-armed on every
        // reconnect would keep a long-retired side flagged forever.
        const promote = readPromoteRecord();
        const superseded = promote && promote.supersededNodeId === payload.nodeId && !promote.supersededDelivered
          ? { byNodeId: nodeId, byNodeName: nodeName, term: registry.term, retireRequested: promote.retireOldMaster, at: Date.now() }
          : null;
        // Only a block naming THIS master's own database is relayed: a block
        // inherited from the master this node superseded names a fenced
        // database, and a standby seeded from it would follow the wrong side.
        const held = payload.capabilities?.backupMaster === true || (coveringNodeId !== null && payload.nodeId === coveringNodeId) ? readCopyBlock() : null;
        const heldEndpoint = held ? copyBlockEndpoint(held) : null;
        const own = buildDataBackendInfo();
        const ownUrls = [own.url, own.publicUrl].filter((url): url is string => typeof url === 'string' && url !== '');
        const copyBlock = held && heldEndpoint && sourceMatchesAny(heldEndpoint, ownUrls) ? held : null;
        return {
          accepted: true,
          term: registry.term,
          budget: ledger?.getBudgetInfo() ?? null,
          dataBackend: buildDataBackendInfo(),
          ...(fleetConfig ? { fleetConfig: fleetConfigPayload() } : {}),
          ...(superseded ? { superseded } : {}),
          ...(copyBlock ? { copyBlock } : {}),
          // Said in the reply because the node's own manager acts only on what
          // its bot recorded (20.11): a standby beside it must keep its place
          // for the failback instead of re-seeding off the stand-in (B6 map F35).
          ...(coveringNodeId ? { standingInFor: coveringNodeId } : {}),
        };
      },
      onCapabilityRefresh: (fromNodeId, payload) => {
        const node = registry.nodes.get(fromNodeId);
        if (!node || !payload?.capabilities) return;
        node.capabilities = payload.capabilities;
        void persist().catch(err => console.warn('[Fleet] Failed to persist capability refresh:', err));
      },
      onLeaseDecline: (fromNodeId, payload) => {
        if (!payload || payload.term !== registry.term) return;
        let leaseIds = Array.isArray(payload.leaseIds) ? payload.leaseIds.filter(id => typeof id === 'string') : [];
        if (leaseIds.length === 0) return;
        const name = registry.nodes.get(fromNodeId)?.nodeName ?? fromNodeId;
        // A decline for a transformation-pinned shard is refused (spec 3.3):
        // the master logs it and holds the lease; renew drift re-grants it to
        // the same holder, which retries hydration where the bytes live.
        const pinned = transformer?.pinnedShardIds();
        if (pinned && pinned.size > 0) {
          const rest = new Set(leaseIds);
          const allowed: string[] = [];
          let refusedCount = 0;
          for (const lease of registry.shardTable.values()) {
            if (lease.nodeId !== fromNodeId || !rest.has(lease.leaseId)) continue;
            rest.delete(lease.leaseId);
            if (pinned.has(lease.shardId)) refusedCount++;
            else allowed.push(lease.leaseId);
          }
          if (refusedCount > 0) {
            console.warn(`[Fleet] Held ${refusedCount} declined lease(s) from ${name}: shard(s) pinned by the active transformation`);
            leaseIds = [...allowed, ...rest];
            if (leaseIds.length === 0) return;
          }
        }
        console.warn(`[Fleet] ${name} declined ${leaseIds.length} lease(s): ${payload.reason}`);
        if (payload.reason === 'hydration-timeout') {
          const covered = new Set(leaseIds);
          for (const [shardId, lease] of registry.shardTable) {
            if (lease.nodeId === fromNodeId && covered.has(lease.leaseId)) timeoutDeclinedShards.add(shardId);
          }
        }
        clearCoveredLeases(fromNodeId, leaseIds);
        // Cooldown keeps a shard the node cannot hydrate from bouncing back to
        // it every tick; deposed-at-hydration skips it (the shard belongs
        // elsewhere and placement should proceed immediately).
        if (payload.reason !== 'deposed-at-hydration') ledger?.penalize(fromNodeId, DECLINE_COOLDOWN_MS);
        void persist().catch(err => console.warn('[Fleet] Failed to persist lease decline:', err));
        void distribute();
      },
      afterRegister: registeredNodeId => {
        // The superseded fact is burned HERE, not while building the reply:
        // this runs only after the reply was written to the socket, so a
        // dropped connection re-delivers it (and with it the owner's retire
        // instruction, which nothing else carries) on the next register.
        const delivered = readPromoteRecord();
        if (delivered && delivered.supersededNodeId === registeredNodeId && !delivered.supersededDelivered) {
          writePromoteRecord({ ...delivered, supersededDelivered: true });
        }
        // Sync rides the control channel and never delays lease traffic:
        // push the current manifest fire-and-forget beside the reconcile.
        void syncAuthority!.pushTo(registeredNodeId);
        void (async () => {
          try {
            await reconcileHeldLeases(registeredNodeId);
            // A reconnecting redistribute-proposal owner lands its fenced shards
            // (which hold its committed data) BEFORE the data-blind distribute();
            // its shards leave resumePendingShards only once the grant lands.
            if (resumePendingShards.size > 0) {
              await grantResumeProposal();
              if (resumePendingShards.size === 0) {
                clearResumeRetry();
                await store.saveRedistributeProposal(null);
              }
            }
            await distribute();
            // A source that was unreachable at COMMITTING gets its deferred
            // graveyard (idempotent XFER_COMMIT) retried now it is back.
            await coordinator?.retrySourceCleanup(registeredNodeId);
          } catch (error) {
            console.error('[Fleet] Post-register reconcile failed:', error);
          }
        })();
      },
      onHeartbeat: (heartbeatNodeId, hb) => {
        registry.recordHeartbeat(heartbeatNodeId, hb);
        maybeRetryMismatchRevoke(heartbeatNodeId, hb);
        maybeRetryDrainRevoke(heartbeatNodeId);
      },
      onGuildNotice: (_noticeNodeId, notice) => registry.applyGuildNotice(notice),
      // Renew makes lease drift visible without acting on it destructively: a
      // mismatch sets needsGrant and the next Phase R re-grants/revokes.
      onLeaseRenew: (renewNodeId, payload): LeaseRenewedPayload => {
        const node = registry.nodes.get(renewNodeId);
        const budget = ledger?.getBudgetInfo() ?? null;
        const owned = new Set<string>();
        for (const lease of registry.shardTable.values()) {
          if (lease.nodeId === renewNodeId) owned.add(lease.leaseId);
        }
        // A pending-confirmation lease IS this node's in the master's own
        // model; treating it as drift would bounce a correct worker.
        for (const pending of registry.pendingConfirmation.values()) {
          if (pending.nodeId === renewNodeId) owned.add(pending.leaseId);
        }
        const leaseIds = Array.isArray(payload?.leaseIds) ? payload.leaseIds : [];
        if (node) node.lastRenewLeaseIds = leaseIds.filter(id => typeof id === 'string');
        const mismatch = !node || leaseIds.length !== owned.size || leaseIds.some(id => !owned.has(id));
        if (mismatch) {
          if (node) node.needsGrant = true;
          return { ok: false, term: registry.term, epoch: registry.epoch, reason: 'lease-mismatch', budget };
        }
        return { ok: true, term: registry.term, epoch: registry.epoch, budget };
      },
      onDisconnect: disconnectedNodeId => {
        registry.markDisconnected(disconnectedNodeId);
        const name = registry.nodes.get(disconnectedNodeId)?.nodeName ?? disconnectedNodeId;
        console.warn(`[Fleet] Node disconnected: ${name} (owned shards frozen in Wait mode)`);
        // A participant vanishing mid-migration is a node-down event for the
        // coordinator (pre-commit -> abort; post-commit -> retries continue).
        coordinator?.onNodeDown(disconnectedNodeId);
        // Free-shard distribution only; the disconnected node's shards stay frozen.
        void distribute();
      },
      onSyncRequest: (_syncNodeId, type, data) => serveSyncRequest(syncAuthority!, type, data),
      onXferProgress: (xferNodeId, data) => coordinator?.onProgress(xferNodeId, data),
      onXferVerify: (xferNodeId, data) => coordinator?.onVerify(xferNodeId, data),
      onXferFlushed: (xferNodeId, data) => coordinator?.onFlushed(xferNodeId, data),
      onSyncReport: (reportNodeId, data) => {
        const node = registry.nodes.get(reportNodeId);
        if (!node) return;
        if (Number.isInteger(data?.appliedRevision)) node.syncAppliedRevision = data.appliedRevision;
        if (typeof data?.ok === 'boolean') node.syncOk = data.ok;
        if (data?.ok === false) {
          const degraded = Array.isArray(data?.degraded) && data.degraded.length > 0 ? ` (${data.degraded.join(', ')})` : '';
          console.warn(`[Fleet] Sync report from ${node.nodeName}: degraded at revision ${data?.appliedRevision}${degraded}`);
        }
      },
    });
    // Transformation crash recovery BEFORE the server accepts registrations,
    // so the very first register reply already carries the routing map.
    await transformer.recover().catch(error =>
      console.error('[Transform] Recovery failed:', error instanceof Error ? error.message : error));
    await server.start(port, secret);
    // Reaching this line is what "it worked" means for the stand-in lane, so the
    // attempt budget resets HERE. Resetting at term acquisition would clear it
    // before every read that can still fail, and the reboot loop F40 exists to
    // bound would never increment.
    if (standIn) {
      const serving = readArmRecord();
      if (serving) writeArmRecord({ ...serving, attempts: 0 });
    }
    onDeposedTeardown = () => {
      server?.dropAll();
      // A deposed master must not keep another node's writes waiting on a copy
      // it no longer speaks for; the stop relaxes before it lets go.
      void syncPosture?.stop().catch(() => { /* logged inside, and the next boot clears regardless */ });
      syncPosture = null;
    };

    // A promoted master tells every other candidate to step down (B4). The
    // notice carries this node's data backend so the old master drains its
    // buffered writes here before restarting as a co-worker. Best effort: the
    // old master's fallbacks are the witness and its own timer.
    if (takeoverConfirmed) {
      const notice: StepDownPayload = { term, nodeId, nodeName, dataBackend: buildDataBackendInfo() };
      for (const url of effectiveMasterUrls().urls) {
        void notifyStepDown(url, secret, notice, STEP_DOWN_NOTIFY_MS)
          .then(ok => { if (ok) console.log(`[Fleet] Step-down notice acknowledged by ${url}`); });
      }
    }

    // Ruling-5 takeover chain: a promotion staged over a DEAD master
    // (chainTakeover one-shot) declares the previous holder lost once the
    // hold-down proved its sessions gone, freeing its shards for placement.
    // A previous master that somehow re-registered is left strictly alone.
    // Failures NEVER escape (an unhandled rejection here would kill the
    // freshly promoted master mid-failover) and retry on a timer: the
    // one-shot flag and the pre-CAS holder capture cannot survive a restart,
    // so the promoted process itself must see the chain through.
    if (chainTakeover && previousHolder && previousHolder.nodeId !== nodeId) {
      const chainTarget = previousHolder;
      const chainDelayMs = (rec.recovered || paused ? RECOVERY_HOLDDOWN_MS : REGISTER_GRACE_MS) + 2000;
      console.warn(`[Fleet] Takeover chain armed: previous master ${chainTarget.nodeId.slice(0, 8)} (term ${chainTarget.term}) will be declared lost in ${Math.round(chainDelayMs / 1000)}s unless it re-registers`);
      const runChain = async (): Promise<void> => {
        if (controlFenced) return;
        const old = registry.nodes.get(chainTarget.nodeId);
        if (!old) {
          console.log('[Fleet] Takeover chain: the previous master holds nothing (adopted plan empty for it, or already declared lost); chain done');
          return;
        }
        if (old.connected) {
          console.warn(`[Fleet] Takeover chain: previous master ${old.nodeName} re-registered; leaving its shards alone`);
          return;
        }
        console.warn(`[Fleet] Takeover chain: declaring previous master ${old.nodeName} lost (stale term ${chainTarget.term})`);
        try {
          const res = await fleetDeclareLost(chainTarget.nodeId);
          if (res.success) return;
          console.error(`[Fleet] Takeover chain Declare Lost refused: ${res.error}; retrying in ${Math.round(XFER_COMMIT_RETRY_MS / 1000)}s`);
        } catch (error) {
          console.error(`[Fleet] Takeover chain Declare Lost failed (retrying in ${Math.round(XFER_COMMIT_RETRY_MS / 1000)}s):`, error instanceof Error ? error.message : error);
        }
        setTimeout(() => void runChain(), XFER_COMMIT_RETRY_MS).unref();
      };
      setTimeout(() => void runChain(), chainDelayMs).unref();
    }

    // Migration crash recovery runs AFTER the P1 plan/registry reload above (the
    // reload seeded registry.shardTable/epoch), so pre-COMMITTING migrations
    // abort, COMMITTING resumes commit retries, GRANTING re-issues grants.
    if (coordinator) {
      await coordinator.recover().catch(error =>
        console.error('[Migration] Recovery failed:', error instanceof Error ? error.message : error));
    }
    const graceMs = rec.recovered || paused ? RECOVERY_HOLDDOWN_MS : REGISTER_GRACE_MS;
    if ((rec.recovered || paused) && recoverySource) recoverySource.holdDownUntil = Date.now() + graceMs;
    console.log(`[Fleet] Role: master node=${nodeName} (${nodeId.slice(0, 8)}) term=${term} shardCount=${registry.shardCount} capacity=${capabilities.shardCapacity} controlPort=${port}${pinnedShardId !== null ? ` pinnedShard=${pinnedShardId}` : ''}`);
    if (paused && rec.reshardPaused) {
      console.warn(`[Fleet] RESHARD PAUSE active (${rec.reshardPaused.from ?? '?'} -> ${rec.reshardPaused.to ?? '?'} shards): no shards will be assigned until resumed from the Usage tab`);
    }
    setTimeout(() => {
      graceOver = true;
      void distribute();
    }, graceMs).unref();
  } else {
    console.log(`[Fleet] Role: master (standalone) node=${nodeName} (${nodeId.slice(0, 8)}) term=${term} shards=${shardCount} self-granted`);
    await transformer.recover().catch(error =>
      console.error('[Transform] Recovery failed:', error instanceof Error ? error.message : error));
    await distribute();
  }

  let witness: FleetWitness | null = null;
  if (!standalone) {
    const witnessToken = (process.env.DISCORD_TOKEN || '').trim();
    if (witnessToken === '') {
      console.warn('[Fleet] Witness disabled: DISCORD_TOKEN is empty');
    } else {
      // The write step's tick needs what a serving master otherwise never
      // holds: the copy's own endpoint, a way to ask the covered master
      // directly, and which backups are registered HERE (their masterSeen
      // names this stand-in, not the master it covers).
      const writeCtx: StandInWriteContext | null = standIn && serveOnly ? {
        nodeId,
        coveringNodeId: coveringNodeId!,
        standInUrl,
        secret: (process.env.CONTROL_SECRET || '').trim(),
        candidates: () => effectiveMasterUrls().urls,
        peerRegisteredHere: id => registry.nodes.get(id)?.connected === true,
      } : null;
      witness = startWitnessLoop({
        token: witnessToken,
        nodeId,
        nodeName,
        // A stand-in KEEPS its backup identity (20.5), and the F21 park
        // exception it depends on is written as "not role master", so beaconing
        // 'master' here would make the returning true master park on its own
        // stand-in and never come back.
        role: standIn ? 'backup' : 'master',
        getTerm: () => registry.term,
        // Published so a backup can tell "the master's database died" from
        // "I cannot reach the master's database" (20.12 c3): only this node
        // knows which one it is. A stamp failing longer than a worker's lease
        // TTL is a dead store, not a blip.
        getBeaconFacts: (): BeaconFacts => {
          const facts: BeaconFacts = { storeState: 'healthy' };
          // The flag that makes every other node treat this one as the fleet's
          // coordinator while keeping the node it names out of the park path
          // (F21). Published from the master loop because a serving stand-in IS
          // running the master path, and its own role stays 'backup'.
          if (coveringNodeId) facts.standingInFor = coveringNodeId;
          if (store instanceof PostgresControlStore && !standalone) {
            const failing = (store.getStampFailingForMs() ?? 0) >= LEASE_TTL_MS;
            // The third value, and the reason it exists (B6 map F20): while
            // this master's OWN writes are the ones waiting on a departed sync
            // standby, the stamp fails for a reason that is not a dead store.
            // Its database is alive and holds the newest committed writes, and
            // the stall was caused by the absence of the very copy a failover
            // would promote, so publishing 'dead' here would unlock the lossy
            // path in exactly the case that loses the most.
            // A drop that JUST happened counts too: the watchdog relaxes in
            // about a second, so by the time the stamp has failed for a whole
            // lease TTL the posture reads relaxed again while the writes it
            // stalled are still draining. Judging on the live state alone would
            // publish 'dead' for a stall this master had already ended.
            const posture = syncPosture?.getStatus();
            // The recent SAMPLE is the load-bearing half: it is positive
            // evidence that the primary is still answering. Without it a
            // database that DIED while armed would publish 'stalled' forever,
            // because nothing can move the state without the connection that
            // just went away, and 'stalled' is what withholds the operator's
            // failover. That would be worse than the bug F20 exists to fix.
            const ourStall = posture !== undefined
              && Date.now() - posture.lastSampleAt < LEASE_TTL_MS
              && (posture.state !== 'relaxed' || (posture.lastDrop !== null && Date.now() - posture.lastDrop.at < LEASE_TTL_MS));
            facts.storeState = !failing ? 'healthy' : ourStall ? 'stalled' : 'dead';
          }
          // A promote already running here is otherwise invisible to every
          // other machine: the record is node-local (F36).
          const promote = readPromoteRecord();
          if (promote && promote.phase !== 'done' && !(promote.parked && promote.phase === 'claim')) facts.promoting = true;
          return facts;
        },
        getChannelId: () => fleetConfig?.witnessChannelId ?? null,
        ...(writeCtx ? { onTick: (renewOk: boolean, status: WitnessStatus) => void evaluateStandInWrites(writeCtx, renewOk, status) } : {}),
      });
      readWitnessNow = async () => {
        // Null when the read itself failed: readClaims leaves the previous
        // snapshot in place, so returning the status regardless would hand the
        // caller stale evidence wearing a fresh answer's clothes.
        const claims = await witness!.readClaims();
        return claims === null ? null : witness!.getStatus();
      };
    }
  }

  // The in-sync fact (B6 map F23). The watchdog publishes fire and forget, so
  // identity is stamped here and writes are serialised with latest-wins: an
  // older publish that overtakes a newer one must never become the stored
  // truth, and the stored truth is what every standby replays.
  let publishedPosture: SyncPosturePayload | null = null;
  let posturePending: SyncPosturePayload | null = null;
  let postureWriting = false;
  const drainPostureWrites = async (): Promise<void> => {
    if (postureWriting) return;
    postureWriting = true;
    try {
      while (posturePending) {
        const next = posturePending;
        posturePending = null;
        try {
          await store.saveSyncPosture(next);
        } catch (error) {
          console.warn(`[Fleet] Could not record the synchronous posture: ${error instanceof Error ? error.message : error}`);
          // Requeued, never dropped: this row is the carrier that survives the
          // master's death, so a lost write could strand every standby holding
          // an "armed" attestation nothing will ever correct. Retried on the
          // heartbeat tick rather than here, because a store that is down would
          // spin this loop.
          if (!posturePending) posturePending = next;
          break;
        }
      }
    } finally {
      postureWriting = false;
    }
  };
  const publishSyncPosture = (fact: { state: 'armed' | 'relaxed'; slotName: string | null; nodeId: string | null; heldToLsn: string | null }): void => {
    const stamped: SyncPosturePayload = { ...fact, updatedAt: Date.now(), masterNodeId: nodeId, term: registry.term };
    publishedPosture = stamped;
    posturePending = stamped;
    void drainPostureWrites();
  };

  // The second carrier: the same fact on the push lane, for display and for the
  // fast path. It STOPS being pushed once it outlives its own refresh, so a
  // watchdog that died cannot keep an "armed" claim alive by repetition; the
  // receiver's window then expires and the claim disarms itself.
  const POSTURE_PUSH_MAX_AGE_MS = 90_000;
  const posturePushed = new Map<string, number>();
  const pushSyncPosture = (): void => {
    if (posturePending) void drainPostureWrites();
    const fact = publishedPosture;
    if (!fact || Date.now() - fact.updatedAt >= POSTURE_PUSH_MAX_AGE_MS) return;
    for (const node of registry.nodes.values()) {
      // Forgetting a node that is gone is what re-delivers the current fact to
      // it when it comes back, instead of leaving it to wait out a refresh.
      if (node.isSelf || !node.connected || !node.dbReplica) { posturePushed.delete(node.nodeId); continue; }
      // Once per ATTESTATION, not once per tick: the receiver stamps its own
      // freshness clock on arrival, so re-sending an unchanged fact would keep
      // renewing a claim the master had stopped making.
      if (posturePushed.get(node.nodeId) === fact.updatedAt) continue;
      posturePushed.set(node.nodeId, fact.updatedAt);
      void server?.request(node.nodeId, MSG.SYNC_POSTURE, fact)
        .catch(() => { posturePushed.delete(node.nodeId); });
    }
  };

  // Synchronous posture (20.5 active mode, B6 map F12-F17). While a designated
  // ACTIVE backup is provably keeping up, this master holds its own primary
  // waiting for that copy, so a stand-in's data really would be every
  // acknowledged write. Inert until an operator enables active mode on a node
  // that also consents to it, which is nobody by default.
  if (!standalone && !controlFenced && !serveOnly && resolveDataBackend() === 'postgres') {
    const engine = startSyncPostureEngine({
      url: () => getActiveBackendUrl(),
      publish: fact => publishSyncPosture(fact),
      foreignCancelAt: () => {
        let newest = 0;
        for (const node of registry.nodes.values()) {
          if (node.isSelf) continue;
          if ((node.syncWaitCancelledAt ?? 0) > newest) newest = node.syncWaitCancelledAt!;
        }
        return newest;
      },
      // Every eligible backup in priority order, not just the first: whether a
      // copy is actually streaming is the engine's evidence to weigh, and one
      // broken high-priority backup must not hide a working lower one (F14).
      targets: (): SyncPostureTarget[] => {
        if (!fleetConfig) return [];
        const eligible: SyncPostureTarget[] = [];
        for (const designation of [...fleetConfig.backupDesignations].sort((a, b) => a.priority - b.priority)) {
          if (designation.mode !== 'active') continue;
          const node = registry.nodes.get(designation.nodeId);
          // Both halves of the key must still hold, and a backup whose BOT is
          // gone cannot stand in for anything, so the fleet stops paying the
          // stall price for it even while its database keeps streaming.
          if (!node || !node.connected || node.capabilities?.activeCapable !== true) continue;
          const slotName = (node.dbReplicaSlot || '').trim();
          if (slotName === '') continue;
          eligible.push({ nodeId: designation.nodeId, slotName });
        }
        return eligible;
      },
    });
    syncPosture = engine;
    stopSyncPosture = () => engine.stop();
  }

  // Slot signal (20.17): each fresh read of the primary's slot table goes to
  // every connected node that reports a local standby. wal_status lives only
  // on the primary, and a standby cannot tell a lost slot from an offline
  // primary on its own. Fire-and-forget like the config push: the next sample
  // re-delivers, and the receiver judges freshness itself.
  let pushedSlotSampleAt = 0;
  const pushSlotStatus = (): void => {
    const sample = getSlotSample();
    if (!sample || sample.observedAt === pushedSlotSampleAt) return;
    pushedSlotSampleAt = sample.observedAt;
    // Each row is stamped with the node that reports the slot as its own, so
    // a receiver can tell WHOSE copy every row describes (20.19 F14). A slot no
    // connected node claims stays unattributed rather than guessed at.
    const owners = new Map<string, string>();
    for (const node of registry.nodes.values()) {
      if (node.dbReplicaSlot) owners.set(node.dbReplicaSlot, node.nodeId);
    }
    const slots = sample.slots.map(row => {
      const owner = owners.get(row.slotName);
      return owner ? { ...row, nodeId: owner } : row;
    });
    const payload: SlotStatusPayload = { observedAt: sample.observedAt, nodeId, term: registry.term, slots };
    for (const node of registry.nodes.values()) {
      if (node.isSelf || !node.connected || !node.dbReplica) continue;
      void server?.request(node.nodeId, MSG.SLOT_STATUS, payload).catch(() => { /* re-delivered on the next sample */ });
    }
  };

  const selfHeartbeat = setInterval(() => {
    registry.recordHeartbeat(nodeId, runtime.buildHeartbeat(registry.term));
    healthMonitor?.tick();
    pushSlotStatus();
    pushSyncPosture();
    // Witness consumer (20.6): a FRESH beacon with a higher term from another
    // node means a newer master is up, whether or not this node's own store
    // could tell it (a dead store never fences). Begin or finish the step-down.
    if (witness && beginSupersession && finishStepDown) {
      const claim = freshHigherTermClaim(witness.getStatus(), nodeId, registry.term, Date.now());
      if (claim) {
        beginSupersession({ nodeId: claim.nodeId, nodeName: claim.nodeName, term: claim.term }, 'witness');
        finishStepDown('fresh higher-term beacon');
      }
    }
    // Periodic reconcile tick: adopt heartbeat truth for pending leases, then
    // re-run free-shard distribution so on-hold workers claim newly-free
    // shards and drift cannot persist.
    if (!standalone && graceOver) {
      registry.reconcilePending();
      void distribute();
      evaluatePinViolation();
    }
  }, HEARTBEAT_MS);
  selfHeartbeat.unref();

  // Pin-restore proposal (never auto-executed): when the pinned shard sits on a
  // live non-master node, surface the Swap legs for the operator's button.
  function evaluatePinViolation(): void {
    if (standalone || pinnedShardId === null) { pinViolation = null; return; }
    const plan = planPinRestoreLegs(registry, pinnedShardId, nodeId);
    if (!plan) { pinViolation = null; return; }
    const holder = registry.shardTable.get(pinnedShardId);
    pinViolation = {
      shardId: pinnedShardId,
      holderNodeId: holder?.nodeId ?? '',
      proposedLegs: plan.proposedLegs
        ? plan.proposedLegs.map(l => ({ shardId: l.shardId, fromNodeId: l.fromNodeId, toNodeId: l.toNodeId }))
        : null,
      reason: plan.reason,
    };
  }

  // Full guild list via REST (not shard-bound) so per-shard counts cover shards
  // no instance is connected to. Slow refresh; failures keep the last counts.
  const refreshGuildTotals = async (): Promise<void> => {
    const guilds = await fetchAllGuilds(process.env.DISCORD_TOKEN);
    if (guilds) {
      registry.setAllGuilds(guilds);
      console.log(`[Fleet] Guild directory refreshed via REST: ${guilds.length} guild(s) (names for Guilds-by-shard, including unheld shards)`);
    } else {
      console.warn('[Fleet] Guild directory refresh FAILED (REST GET /users/@me/guilds); Guilds-by-shard will show IDs for guilds this node is not connected to');
    }
  };
  void refreshGuildTotals();
  const guildTotalsTimer = setInterval(() => void refreshGuildTotals(), GUILD_TOTALS_REFRESH_MS);
  guildTotalsTimer.unref();

  _setFleetStateSources({
    role: 'master',
    standalone,
    nodeId,
    nodeName,
    appVersion,
    pinnedShardId,
    capacity: capabilities.shardCapacity,
    recommendedShards,
    runtime,
    ingest,
    registry,
    controlClient: null,
    recovery: recoverySource,
    ledger,
    healthMonitor,
    refusedRegistrations: standalone ? null : refusedRegistrations,
    sync: syncAuthority ? () => ({ revision: syncAuthority!.getRevision(), status: 'n/a' as const }) : null,
    migration: coordinator ? () => coordinator!.getView() : null,
    transformation: () => transformer?.getView() ?? null,
    pinViolation: standalone ? null : () => pinViolation,
    unassigned: standalone ? null : () => unassigned,
    termStamp: store instanceof PostgresControlStore && !standalone ? () => store.getStampFailingForMs() : null,
    fleetConfig: () => (fleetConfig ? fleetConfigViewOf(fleetConfig) : null),
    witness: witness ? () => witness!.getStatus() : null,
    migrationActive: null,
  });

  // Owner-info source for .owner manifests (dataManager cannot import fleet).
  // Epoch comes from the master's own LEASE, not the global counter: ownership
  // rows fenced with a newer-than-lease epoch would depose this node's own
  // later hydration claims (which are lease-minted).
  setOwnerInfoProvider(() => ({
    nodeId,
    term: registry.term,
    epoch: runtime.getCurrent()?.epoch ?? registry.epoch,
    shardCount: registry.shardCount,
  }));

  return {
    role: 'master',
    standalone,
    nodeId,
    nodeName,
    attachClient(client: Client): void {
      runtime.attachClient(client);
      client.on('guildCreate', guild => {
        registry.applyGuildNotice({ guildId: guild.id, shardId: guildIdToShardId(guild.id, registry.shardCount), kind: 'create' });
      });
      client.on('guildDelete', guild => {
        registry.applyGuildNotice({ guildId: guild.id, shardId: guildIdToShardId(guild.id, registry.shardCount), kind: 'delete' });
      });
    },
    startIngest(token: string | undefined): void {
      runtime.setToken(token);
    },
    // Master and standalone are their own source of truth: the gate is instant.
    async awaitSyncReady(): Promise<void> {},
  };
}

async function initCoWorker(init: CommonInit, followerHold: FollowerHoldBase | null = null): Promise<FleetContext> {
  const { nodeId, nodeName, appVersion, capabilities, runtime } = init;
  if (followerHold) {
    _setFollowerHold(followerHold);
    // The database this node booted on is behind the fleet's, or is the copy
    // the failback promotes: nothing may be served from it (B6 map F28).
    holdOwnRuntimeForDelivery('this node\'s own database is not the fleet\'s while it holds as a follower; serving waits for the database the node it follows delivers');
    const followed = (): { url: string; forms: string[] } | null => {
      const active = getActiveBackendUrl();
      const forms = hasDelivery() ? getDeliveredBackendUrls() : [];
      return active !== null && forms.includes(active) && getDataBootStatus().state === 'serving' ? { url: active, forms } : null;
    };
    followedBackend = followed;
    _setFollowerFollowingSupplier(() => ({ url: followed()?.url ?? null, forms: hasDelivery() ? getDeliveredBackendUrls() : [] }));
    pushFleetStatusNow();
  }
  // The divergence proof (B6 map F31), judged once a delivery installs and
  // re-judged on a slow cadence: neither position moves while this node
  // follows, so the refresh only catches a side that was unreadable.
  let lineageTimer: NodeJS.Timeout | null = null;
  const judge = (own: () => string | null, followedUrl: () => string | null, set: (fact: LineageFact | null) => void): void => {
    const run = async (): Promise<void> => {
      const ownUrl = own();
      const url = followedUrl();
      set(ownUrl && url ? await judgeLineage(ownUrl, url) : null);
      pushFleetStatusNow();
    };
    if (lineageTimer) clearInterval(lineageTimer);
    lineageTimer = setInterval(() => { void run(); }, LINEAGE_REFRESH_MS);
    lineageTimer.unref();
    void run();
  };
  const ingest = getIngestService();
  const { urls: masterUrls, source: masterUrlsSource } = effectiveMasterUrls();
  const secret = (process.env.CONTROL_SECRET || '').trim();

  console.log(`[Fleet] Role: co-worker node=${nodeName} (${nodeId.slice(0, 8)}) masters=${masterUrls.join(' | ') || 'none'} (${masterUrlsSource}) capacity=${capabilities.shardCapacity}${isBackupMaster() ? ` BACKUP MASTER` : ''}${followerHold ? ' FOLLOWER HOLD (the fleet\'s master by configuration, following the node holding the fleet)' : ''}`);
  // A stepped-down old master carries its superseded fact into the co-worker
  // role until the manager retires or decommissions this side (B4).
  const priorSupersession = readSuperseded();
  if (priorSupersession) {
    _setSuperseded({ byNodeId: priorSupersession.byNodeId, byNodeName: priorSupersession.byNodeName, term: priorSupersession.term, source: priorSupersession.source, since: priorSupersession.at, steppedDown: true });
  }
  // The recorded slot status carries over a restart like the superseded fact
  // (the manager reads the file either way); a node whose standby is gone drops
  // it so no stale verdict outlives the copy it described.
  if (hasDbReplica()) {
    _setSlotStatus(readSlotStatus());
  } else {
    clearSlotStatus();
    clearSyncPostureRecord();
  }
  // The standby's own probe outranks a stale relay: a receiver that is
  // streaming proves the slot is not lost or gone (a re-seeded copy behind a
  // record from before the re-seed), and a copy out of recovery follows no
  // slot at all (promoted). Either way the record describes a copy that no
  // longer exists, so it is dropped rather than left to age out.
  // One streaming reading is not enough: against a lost slot the walreceiver
  // shows "streaming" for the length of a handshake on every 5 s retry, and a
  // probe can land in it. Two probes a minute apart cannot both.
  let streamingProbes = 0;
  setReplicaProbeListener(report => {
    if (report.error) { streamingProbes = 0; return; }
    // A copy out of recovery is nobody's standby any more, so the posture
    // recorded about it goes too, whether or not a slot record exists.
    if (!report.inRecovery) clearSyncPostureRecord();
    const record = readSlotStatus();
    // Counted only against a recorded lost or absent slot, so the streak from
    // the hours of healthy streaming before the loss is never inherited.
    // A record from a master this copy no longer follows is not describing a
    // replaced copy: 'absent' is what a survivor of a failover always reads
    // there, so its own receiver cannot contradict it (20.19 F5).
    const questioned = record !== null && record.sourceIsCurrentMaster !== false
      && (record.walStatus === 'lost' || record.walStatus === 'absent');
    streamingProbes = report.streaming && questioned ? streamingProbes + 1 : 0;
    if (!record) return;
    const contradicted = !report.inRecovery || (questioned && streamingProbes >= 2);
    if (!contradicted) return;
    clearSlotStatus();
    _setSlotStatus(null);
    pushFleetStatusNow();
  });

  let controlClient: ControlClient | null = null;
  let syncEngine: SyncEngine | null = null;
  let executor: MigrationExecutor | null = null;
  if (masterUrls.length > 0 && secret) {
    const engine = new SyncEngine({
      request: (type, data) => controlClient!.syncRequest(type, data),
      getTerm: () => controlClient!.getTerm(),
      sendReport: report => controlClient!.sendSyncReport(report),
    });
    syncEngine = engine;
    // Migration participant: the co-worker performs its own prepare/drain/commit/
    // abort locally using the Stage 4 facade; progress/verify ride back to the
    // master fire-and-forget over the same control channel.
    const transferPort = Number(process.env.TRANSFER_PORT) || TRANSFER_PORT_DEFAULT;
    const advertisedTransferUrl = (process.env.TRANSFER_URL || '').trim() || undefined;
    executor = new MigrationExecutor({
      sendToMaster: (type, data) => controlClient?.sendToMaster(type, data),
      selfTransferUrl: () => advertisedTransferUrl,
      transferPort: () => transferPort,
    });
    // Transformation participant: converts its own guilds and applies the
    // flip; a completed flip refreshes the advertised capability like a
    // delivered-backend change does.
    const transformExecutor = new TransformationExecutor({
      getTerm: () => controlClient?.getTerm() ?? 0,
      onFlipped: () => {
        capabilities.dataBackend = resolveDataBackend();
        controlClient?.sendToMaster(MSG.CAPABILITY_REFRESH, { term: controlClient.getTerm(), capabilities });
      },
    });
    // Promote-precheck signal: BOTH executors' live work counts (a promotion
    // restart mid-convert would break a transformation guild window).
    migrationWorkActive = () => (executor?.hasActiveLegs() ?? false) || transformExecutor.isBusy();
    controlClient = new ControlClient({
      masterUrls,
      secret,
      runtime,
      buildRegister: (): RegisterPayload => ({
        nodeId,
        nodeName,
        protocolVersion: PROTOCOL_VERSION,
        appVersion,
        capabilities,
        heldLeases: runtime.getHeldSummary(),
      }),
      onSyncState: payload => engine.onSyncState(payload),
      onFleetConfig: config => {
        // The registered master is the authority; cache first (reboot truth),
        // then swap the live dial list without dropping the connection.
        writeFleetConfigCache(config);
        controlClient?.updateMasterUrls(config.masterCandidates);
      },
      onMasterIdentity: (masterNodeId, term) => noteHolderSighting(masterNodeId, term, 'register', nodeId),
      onSuperseded: info => {
        // This node is the old master the new one superseded (B4): record the
        // fact, and the owner's retire request, for the manager. An existing
        // record keeps its own timestamp and source (they describe how this
        // node learned it, which is older and more accurate than the reply).
        const current = readSuperseded();
        const source = current?.source ?? 'step-down';
        const since = current?.at ?? info.at;
        const retireRequested = info.retireRequested || current?.retireRequested === true;
        writeSuperseded({ ...info, retireRequested, at: since, source, steppedDown: true });
        noteHolderSighting(info.byNodeId, info.term, 'step-down', nodeId);
        _setSuperseded({ byNodeId: info.byNodeId, byNodeName: info.byNodeName, term: info.term, source, since, steppedDown: true });
        if (info.retireRequested) console.warn(`[Fleet] The owner asked to retire this side after the transfer to ${info.byNodeName}; the manager performs it`);
      },
      onCopyBlock: block => writeCopyBlock(block),
      onSlotStatus: payload => {
        // Only this node's own slot is recorded, judged by primary_slot_name
        // from the standby itself, and "my source is this master" by the
        // database endpoint this master delivered: the manager then acts on
        // a verdict, never on a slot name or URL of its own reading.
        const identity = getLocalReplicaIdentity();
        if (!identity?.slotName) return;
        // A copy out of recovery (promoted) follows no slot; a probe that
        // errored leaves the question open and the previous record ages out.
        const health = getReplicaHealth();
        if (health && !health.error && !health.inRecovery) return;
        const delivered = getDeliveredBackendUrls();
        const record = recordFromPush(payload, identity.slotName, identity.sourceHost ? sourceMatchesAny(identity, delivered) : null, identity.sourceAt);
        writeSlotStatus(record);
        _setSlotStatus(record);
        pushFleetStatusNow();
      },
      onSyncPosture: payload => {
        // Filed whatever it names: a fact that names ANOTHER copy is exactly
        // how this node learns it is not the one being waited for.
        const identity = getLocalReplicaIdentity();
        if (!identity?.slotName) return;
        // A copy out of recovery (promoted) follows no master's posture, the
        // same refusal the slot handler makes on the same evidence.
        const health = getReplicaHealth();
        if (health && !health.error && !health.inRecovery) return;
        const record = recordFromPosturePush(payload, identity.sourceHost ? sourceMatchesAny(identity, getDeliveredBackendUrls()) : null);
        if (record) writeSyncPostureRecord(record);
      },
      onXferControl: (type, data) => executor!.handle(type, data),
      onTransformControl: (type, data) => transformExecutor.handle(type, data),
      onDataRoutes: async (_transformationId, routes, url, publicUrl) => {
        // Applied (and awaited) before the grant's hydration: a converted
        // shard placed here mid-window must read its guilds from the
        // destination, so the runtime must exist before applyGrant runs. The
        // probe only runs while no runtime exists; ensureRuntimeWith no-ops
        // otherwise and the grant ack should not wait on a wasted dial.
        applyRouteOverrides(routes);
        if (url && getActiveBackendUrl() === null) {
          ensureRuntimeWith(await pickDeliveredUrl(url, (publicUrl || '').trim()));
        }
      },
      onDataOp: async (type, data) => {
        // Webui write/read hop: reject a stale term and verify the lease is
        // actually held here (mid-handover race protection), then apply
        // through the local facade.
        const req = (data ?? {}) as { term?: number; guildId?: string };
        if (typeof req.term !== 'number' || req.term !== controlClient?.getTerm()) {
          return { ok: false, code: 'stale-term' };
        }
        const current = runtime.getCurrent();
        if (!current || current.shardCount <= 0 || typeof req.guildId !== 'string') {
          return { ok: false, code: 'not-owner' };
        }
        const shardId = guildIdToShardId(req.guildId, current.shardCount);
        if (!current.leases.some(l => l.shardId === shardId)) {
          return { ok: false, code: 'not-owner' };
        }
        return type === MSG.DATA_WRITE
          ? applyOperatorDataWrite(data as GuildDataWriteRequest)
          : applyOperatorDataRead(data as GuildDataReadRequest);
      },
      onDataBackend: info => {
        void (async () => {
          try {
            const { changed, recycled, unreachable, reason: holdReason } = await applyDeliveredBackend(info, followerHold ? { persist: false } : undefined);
            if (followerHold) {
              // A hold entered without a database of its own could not read
              // whose copy it holds; the delivered credentials can.
              if (followerHold.reason === 'copy' && followerHold.standInNodeId === null && info?.url) {
                const endpoints = resolveReplicaEndpoints();
                const local = endpoints ? spliceFleetCredentials(endpoints.local, info.url).url : undefined;
                const row = local ? await readTermRow(local) : null;
                if (row && row.nodeId !== nodeId) {
                  followerHold.standInNodeId = row.nodeId;
                  followerHold.observedTerm = row.term;
                  _setFollowerHold(followerHold);
                }
              }
              // Behind a stand-in, this node's own database (the one its own
              // URL names; the hold persisted nothing) is judged against the
              // one it now follows. A copy hold has nothing of its own to judge.
              if (followerHold.reason === 'behind') {
                judge(() => currentCanonicalUrl() || null, () => fleetFollowedBackend()?.url ?? null, (fact) => {
                  _setFollowerLineage(fact);
                  // Kept for the failback's promote, which runs in a later process on the re-seeded copy (B6-j).
                  if (fact) rememberLineageVerdict(fact.verdict, followerHold.standInNodeId);
                });
              }
              pushFleetStatusNow();
            } else if (info?.url && hasDbReplica() && readSuperseded()) {
              // A stand-in whose lane ended keeps its promoted copy beside the
              // database it now follows: judged so its manager's drop-back can
              // say what the re-seed would destroy (B6 map F32). Back in
              // recovery, the copy is a plain standby again and there is nothing
              // to judge.
              judge(() => {
                const endpoints = resolveReplicaEndpoints();
                const active = getActiveBackendUrl();
                return endpoints && active ? spliceFleetCredentials(endpoints.local, active).url ?? null : null;
              }, () => getActiveBackendUrl(), fact => _setOwnCopyLineage(fact && fact.ownInRecovery === false ? fact : null));
            }
            // A recycled runtime starts with a driver that knows no shards; the
            // held lease is re-mirrored so it hydrates without waiting for the
            // next grant (which may already have landed). Keyed on the recycle,
            // not on the env change: the two do not always coincide. A hold's
            // delivery installs a fresh runtime instead (its own was dropped at
            // the hold), and a lease granted meanwhile must reach it too.
            if (recycled || (followerHold && getActiveBackendUrl() !== null)) runtime.renotifyDataLayer();
            if (unreachable) {
              // The delivered database could not be installed from here (it
              // never answered, or refused the identity check) and the store
              // this process served from is no longer the fleet's (B7-F5): it
              // holds nothing it may serve. A fresh process picks the form again
              // on its register, with the master's forms probed live.
              console.error(`[Fleet] The delivered database cannot be installed from this node (${holdReason ?? 'no reason given'}); restarting in 3s to pick its form again on the register`);
              setTimeout(() => requestStepDownRestart(), STEPDOWN_HANDOVER_DELAY_MS).unref();
            }
            if (changed) {
              // Mutating the shared object keeps buildRegister's closure
              // current; the refresh converges the master's registry NOW so
              // migration prechecks never read a stale backend.
              capabilities.dataBackend = resolveDataBackend();
              controlClient?.sendToMaster(MSG.CAPABILITY_REFRESH, { term: controlClient.getTerm(), capabilities });
            }
          } catch (error) {
            console.error('[Fleet] Failed to apply the delivered data backend:', error);
          }
        })();
      },
      decorateHeartbeat: hb => {
        const syncState = engine.getSyncState();
        const ok = engine.getLastReportOk();
        return {
          ...hb,
          ...(syncState.appliedRevision !== undefined ? { syncAppliedRevision: syncState.appliedRevision } : {}),
          ...(ok === null ? {} : { syncOk: ok }),
        };
      },
    });
    // Decline-lease path (ruled C1): destroy the sessions FIRST (an acked
    // revoke means the token is free), then hand the leases back. Registered
    // module-level so it survives a data-runtime recycle; masters and
    // standalone never register one.
    setLeaseDeclineHandler((reason, shardIds) => {
      void (async () => {
        try {
          const current = runtime.getCurrent();
          if (!current) return;
          const leaseIds = current.leases.filter(l => shardIds.includes(l.shardId)).map(l => l.leaseId);
          if (leaseIds.length === 0) return;
          console.warn(`[Fleet] Declining ${leaseIds.length} lease(s) for shard(s) ${shardIds.join(', ')} (${reason})`);
          await runtime.revoke(current.term, leaseIds, `declined: ${reason}`);
          controlClient?.sendToMaster(MSG.LEASE_DECLINE, { term: current.term, leaseIds, reason });
        } catch (error) {
          console.error('[Fleet] Lease decline failed:', error);
        }
      })();
    });
  } else {
    console.error('[Fleet] Co-worker requires MASTER_URLS and CONTROL_SECRET; idling without a master');
  }

  // THE STAND-IN ARM DECISION (20.5, B6-f). Runs on the witness tick because
  // term (b) - "this node's own renew succeeded" - is only exact in the tick
  // that performed it, and that term is what separates "the master is gone"
  // from "this node is the one that is isolated".
  let armInFlight = false;
  // When this node's own evidence first held, so a lower-ranked backup can defer
  // to a higher-ranked one by WAITING rather than by asking it anything.
  let evidenceHeldSince = 0;
  const evaluateStandInArm = async (renewOk: boolean, status: WitnessStatus): Promise<void> => {
    if (armInFlight) return;
    armInFlight = true;
    try {
      const now = Date.now();
      // A witness that could not be READ is not evidence of a dark master; it is
      // evidence of nothing. freshMasterClaim returns null for both, so the read
      // freshness is checked separately rather than folded into it.
      const readFresh = status.lastReadAt !== null && now - status.lastReadAt <= WITNESS_FRESH_WINDOW_MS;
      const cheap = {
        ownRenewOk: renewOk,
        masterUnreachable: controlClient?.masterKnown() !== true,
        masterBeaconDark: readFresh && freshMasterClaim(status, nodeId, now) === null,
        noPeerSeesMaster: !status.claims.some(c =>
          c.nodeId !== nodeId && now - c.observedAt <= WITNESS_FRESH_WINDOW_MS && c.masterSeen === true),
      };
      // The last two terms each cost a database connection, so they are gathered
      // only once the free evidence agrees. Passing them as satisfied here is
      // safe because this call can only REFUSE: every real decision below runs
      // against the measured values.
      const cheapVerdict = evaluateArmEvidence({ ...cheap, storeUnreachable: true, receiverStopped: true });
      if (!cheapVerdict.arm) {
        evidenceHeldSince = 0;
        return;
      }

      // Checked before anything dials: on a node that never consented, every
      // one of the connections below would open and time out on every tick for
      // the whole outage, and the answer is already known.
      const designation = readFleetConfigCache()?.backupDesignations.find(d => d.nodeId === nodeId);
      // The emergency lever (B6-k) turns the master's key while the master is
      // unreachable; the node's own consent is the other key, as ever.
      const activeMode = consentsToActiveMode() && backupModeEnabled(designation?.mode, readModeOverride(), cheap.masterUnreachable);
      if (!activeMode || resolveDataBackend() !== 'postgres') {
        evidenceHeldSince = 0;
        return;
      }

      const endpoints = resolveReplicaEndpoints();
      const spliced = endpoints ? spliceFleetCredentials(endpoints.local) : { error: 'no standby endpoint' };
      const localUrl = 'url' in spliced && spliced.url ? spliced.url : '';
      const probe = localUrl === '' ? null : await probeReplica(localUrl);
      const evidence: ArmEvidenceInputs = {
        ...cheap,
        storeUnreachable: !(await canonicalStoreReachable()).ok,
        // probeReplica answers {ok:false} on a refusal or timeout, so without the
        // ok check a probe that never ran would satisfy the term it was meant to
        // measure. An absent fact produces no arm.
        receiverStopped: probe?.ok === true && probe.receiverStreaming !== true,
      };
      const verdict = evaluateArmEvidence(evidence);
      if (!verdict.arm) {
        evidenceHeldSince = 0;
        return;
      }

      // Reading the replayed term row proves three things at once: this copy
      // still holds the fleet's state (F37, which the manager's own copyCleared
      // flag never reaches the bot to tell us), which master would be covered,
      // and at which term the stand-in would serve.
      const termRow = localUrl === '' ? null : await readStandbyTermRow(localUrl);
      const reshard = localUrl === '' ? null : await readReshardPending(localUrl);
      // Decided WITHOUT a connection, deliberately. At arm time both endpoints
      // live on the machine that just died, so a cluster-identity comparison can
      // never come back with anything but "unreachable" and would refuse every
      // deployment rather than only split ones. Two spellings of one cluster now
      // read as split, which is the safe direction, and the refusal says so.
      const controlUrl = (loadCredentials().CONTROL_STORE_URL || '').trim();
      const split = controlUrl !== '' && controlUrl !== (loadCredentials().DATA_BACKEND_URL || '').trim();
      const refusal = preArmRefusal({
        activeMode,
        dataBackendIsPostgres: resolveDataBackend() === 'postgres',
        draining: controlClient?.isDraining() === true,
        migrationWorkActive: migrationWorkActive(),
        hasStandbyEndpoint: localUrl !== '',
        promoteInFlight: (() => {
          const record = readPromoteRecord();
          return record !== null && record.phase !== 'done' && !record.parked;
        })(),
        standbyHoldsFleetState: termRow !== null,
        // Fail closed: an unreadable marker is treated as a pause, because
        // arming into one serves less than the dark master did.
        reshardPending: reshard !== false,
        splitControlStore: split,
        contestedTerm: termRow !== null && status.claims.some(c =>
          c.nodeId !== nodeId
          && now - c.observedAt <= WITNESS_FRESH_WINDOW_MS
          && (c.role === 'master' || c.standingInFor !== undefined)
          && c.term >= termRow.term),
      });
      if (refusal) {
        evidenceHeldSince = 0;
        console.warn(`[Fleet] Stand-in NOT armed: ${refusal}`);
        return;
      }

      // F22's ranking, as ruled: a lower-ranked backup WAITS rather than asks
      // permission. Two designated active backups see identical evidence at the
      // same instant, and nothing can separate them AFTERWARDS - both inherit
      // the same term, and every comparison that would fence one is
      // strictly-greater, so an equal term is invisible to all of them.
      //
      // The wait is measured from when this node's own evidence first held, and
      // it is one full FRESH window per rank step rather than one renew period:
      // the higher-ranked node has to arm, restart, boot and publish its
      // standingInFor beacon before the next node decides, and only the fresh
      // window is long enough to cover that. If it never appears - because that
      // node is dead, unfit, or capped - this one simply proceeds, which is why
      // the rank is a delay and not a veto.
      if (evidenceHeldSince === 0) evidenceHeldSince = now;
      // A node the master never ranked sorts LAST, so it waits out every
      // designated backup its cache lists instead of racing one (F22).
      const rank = designation?.priority ?? leverRank(readFleetConfigCache()?.backupDesignations ?? [], nodeId);
      const deferral = armDeferral(rank, evidenceHeldSince, now);
      if (deferral.defer) {
        console.warn(`[Fleet] Stand-in deferring: ${designation ? `rank ${rank}` : 'unranked (sorting last)'} waits ${Math.round(deferral.waitMs / 1000)}s for any higher-ranked backup to stand in first`);
        return;
      }

      const existing = readArmRecord();
      const allowed = ledgerAllowsArm(existing, now);
      if (!allowed.arm) {
        console.error(`[Fleet] Stand-in NOT armed: ${allowed.reason}`);
        return;
      }

      // Legal but worth saying out loud (F39): 20.9 blesses a solo machine no
      // co-worker can dial, and on one, standing in serves only this machine.
      const warning = reachabilityWarning(process.env.FLEET_PUBLIC_URL || '', rawMasterUrls());
      if (warning) console.warn(`[Fleet] Stand-in reachability: ${warning}`);

      // The point of no return: the override makes the next boot a master boot.
      // The attempt is counted by that boot rather than here, so a node that
      // cannot get through it is bounded by re-entering it (F40).
      // The override goes FIRST. If only the second write fails, the next boot
      // finds a stand-in override with no record and disarms cleanly at one
      // restart's cost; the other order would leave no override and a record
      // whose lastAttemptAt locks this node out for the whole spacing window
      // over an arm that never happened.
      writeRoleOverride({ role: 'master', standIn: true, setAt: now, setBy: 'stand-in' });
      writeArmRecord({
        phase: 'claimed',
        coveringNodeId: termRow!.nodeId,
        armedAt: now,
        updatedAt: now,
        inheritedTerm: termRow!.term,
        inheritedFrom: termRow!.nodeId,
        evidence: { ...evidence, observedAt: now },
        // Counted at the serve-only BOOT rather than here: the override is what
        // persists, so a node that dies before serving is counted by the boot it
        // keeps re-entering, and counting both would spend two of three on one try.
        attempts: existing?.attempts ?? 0,
        lastAttemptAt: now,
        writeRequestedAt: null,
        writeRefusal: null,
        writeRefusedAt: null,
        writeGate: null,
        promotedAt: null,
        disarmedAt: null,
        disarmReason: null,
        copyReseededAt: null,
      });
      invalidateRoleOverrideCache();
      console.error(`[Fleet] STANDING IN for ${termRow!.nodeId} at term ${termRow!.term}: the master is gone on all six checks; restarting to serve READ-ONLY${designation?.mode === 'active' ? '' : ' (the master\'s key was turned by the local emergency lever)'}`);
      requestStepDownRestart();
    } catch (error) {
      console.warn('[Fleet] Stand-in evaluation failed:', error instanceof Error ? error.message : error);
    } finally {
      armInFlight = false;
    }
  };

  let witness: FleetWitness | null = null;
  // A follower hold beacons too (B6 map F28): its promote judges the node it
  // follows on a fresh witness reading, and the owner sees the master is back.
  // It never evaluates the arm: it is not a designated backup, and its own
  // database is the copy that is behind.
  if (isBackupMaster() || followerHold) {
    const witnessToken = (process.env.DISCORD_TOKEN || '').trim();
    if (witnessToken === '') {
      console.warn('[Fleet] Witness disabled: DISCORD_TOKEN is empty');
    } else {
      witness = startWitnessLoop({
        token: witnessToken,
        nodeId,
        nodeName,
        role: 'backup',
        getTerm: () => controlClient?.getTerm() ?? 0,
        getChannelId: () => readFleetConfigCache()?.witnessChannelId ?? null,
        getBeaconFacts: (): BeaconFacts => {
          const facts: BeaconFacts = {};
          // Node-local otherwise, and the one fact that stops an automatic lane
          // arming into the middle of a human-driven promote (F36).
          const promote = readPromoteRecord();
          if (promote && promote.phase !== 'done' && !(promote.parked && promote.phase === 'claim')) facts.promoting = true;
          // Carried so a contested arm can be ranked by the operator's own
          // order instead of an arbitrary tie-break (F22).
          const mine = readFleetConfigCache()?.backupDesignations.find(d => d.nodeId === nodeId);
          if (mine) facts.backupPriority = mine.priority;
          // One backup's view of the master is the only evidence that tells a
          // peer "the master is up and it is YOU who cannot see it" (F19 term f).
          if (controlClient?.masterKnown() === true) facts.masterSeen = true;
          return facts;
        },
        ...(isBackupMaster() ? { onTick: (renewOk: boolean, status: WitnessStatus) => void evaluateStandInArm(renewOk, status) } : {}),
      });
      readWitnessNow = async () => {
        // Null when the read itself failed: readClaims leaves the previous
        // snapshot in place, so returning the status regardless would hand the
        // caller stale evidence wearing a fresh answer's clothes.
        const claims = await witness!.readClaims();
        return claims === null ? null : witness!.getStatus();
      };
    }
  }

  _setFleetStateSources({
    role: 'co-worker',
    standalone: false,
    nodeId,
    nodeName,
    appVersion,
    pinnedShardId: null,
    capacity: capabilities.shardCapacity,
    recommendedShards: null,
    runtime,
    ingest,
    registry: null,
    controlClient,
    recovery: null,
    ledger: null,
    healthMonitor: null,
    refusedRegistrations: null,
    sync: syncEngine ? () => syncEngine!.getSyncState() : null,
    migration: null,
    transformation: null,
    pinViolation: null,
    unassigned: null,
    termStamp: null,
    fleetConfig: () => effectiveFleetConfigView(),
    witness: witness ? () => witness!.getStatus() : null,
    migrationActive: () => migrationWorkActive(),
  });

  // Owner-info source for .owner manifests: null until the first lease grant.
  setOwnerInfoProvider(() => {
    const current = runtime.getCurrent();
    if (!current) return null;
    return { nodeId, term: current.term, epoch: current.epoch, shardCount: current.shardCount };
  });

  const attachGuildNotices = (client: Client) => {
    client.on('guildCreate', guild => {
      const shardCount = runtime.getCurrent()?.shardCount ?? 1;
      controlClient?.sendGuildNotice({ guildId: guild.id, shardId: guildIdToShardId(guild.id, shardCount), kind: 'create' });
    });
    client.on('guildDelete', guild => {
      const shardCount = runtime.getCurrent()?.shardCount ?? 1;
      controlClient?.sendGuildNotice({ guildId: guild.id, shardId: guildIdToShardId(guild.id, shardCount), kind: 'delete' });
    });
  };

  const ctx: FleetContext = {
    role: 'co-worker',
    standalone: false,
    nodeId,
    nodeName,
    attachClient(client: Client): void {
      runtime.attachClient(client);
      attachGuildNotices(client);
      syncEngine?.setClient(client);
    },
    startIngest(token: string | undefined): void {
      runtime.setToken(token);
    },
    awaitSyncReady(): Promise<void> {
      if (!syncEngine) {
        // Unconfigured co-worker: gate module loading forever (it could never
        // lease anyway) while the web UI stays up for the Connection page.
        // Behavior change from the old pointless module load on this path.
        console.warn('[Fleet] Co-worker unconfigured: module loading gated until MASTER_URLS/CONTROL_SECRET are saved and the bot restarts');
        return new Promise<void>(() => {});
      }
      const waitLog = setInterval(() => console.log('[Fleet] Waiting for master sync...'), 15000);
      waitLog.unref();
      return syncEngine.awaitSyncReady().finally(() => clearInterval(waitLog));
    },
  };

  if (!controlClient) {
    // No master configured: keep the process informative and alive, but do NOT
    // block boot - the web UI, IPC and fleet state must still come up.
    setInterval(() => {
      console.warn('[Fleet] Co-worker idle: MASTER_URLS/CONTROL_SECRET not configured');
    }, 3600000);
    return ctx;
  }

  // Boot must NOT block on the first lease: the co-worker starts dialing and
  // returns immediately. It stays on-hold (registered, no lease, no identify)
  // until the master grants a shard, at which point applyGrant -> maybeStart
  // begins ingest. The no-lease login gate keeps Discord untouched meanwhile.
  controlClient.start();
  return ctx;
}
