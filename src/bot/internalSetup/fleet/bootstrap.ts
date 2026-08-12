// Fleet boot orchestration: role resolution, control-plane wiring, shard
// placement. The master claims up to ITS capacity and grants workers only
// FREE shards; owned shards move exclusively through the (future) migration
// system, never automatically. Standalone IS the master path claiming every
// shard, byte-identical to today's single-box boot.

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
  PROTOCOL_VERSION,
  RECOVERY_HOLDDOWN_MS,
  REGISTER_GRACE_MS,
  XFER_COMMIT_RETRY_MS,
} from './constants';
import { DataBackendInfo, HeartbeatPayload, LeaseGrantPayload, LeaseInfo, LeaseRenewedPayload, LeaseRevokePayload, MSG, NodeCapabilities, NodeDrainPayload, NodeRole, RegisterPayload, RegisterResult } from './protocol';
import { getAppVersion, getNodeId, getNodeName, isStandalone, resolveNodeRole, wasNodeIdFreshlyGenerated } from './nodeIdentity';
import { prepareControlStore, PostgresControlStore } from './postgresControlStore';
import { Registry, RegistryNode } from './registry';
import { ControlServer } from './controlServer';
import { ControlClient } from './controlClient';
import { LeaseRuntime } from './leaseRuntime';
import { HealthMonitor } from './healthMonitor';
import { IdentifyLedger } from './identifyLedger';
import {
  assignIdentifyDelays,
  fetchAllGuilds,
  fetchGatewayInfo,
  getShardCountOverride,
  guildIdToShardId,
  pickFreePlacements,
  resolvePinnedShardId,
  resolveShardCapacity,
  resolveShardCount,
} from './placement';
import { evaluateRecovery } from './recovery';
import { _setControlStoreFenced, _setFleetStateSources, FleetRecoverySource, FleetRefusedRegistration, getFleetState } from './state';
import type { MigrationView, PinViolationView } from './state';
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
import { applyDeliveredBackend, ensureRuntimeWith } from '../utils/dataBackends/boot';
import { setLeaseDeclineHandler } from '../utils/dataBackends/dataReadiness';
import { applyRouteOverrides, currentRouteDefault } from '../utils/dataBackends/routeResolver';
import { loadCredentials, resolveDataBackend, upsertCredentials } from '../../../utils/envLoader';
import { MigrationDisposition, resolveIncomingWithMaster, resumeSourceGraveyarding, runResidueSweep } from './migration/residueSweep';
import { MigrationCoordinator, PrecheckResult, StartPayload } from './migration/migrationCoordinator';
import { MigrationExecutor } from './migration/migrationExecutor';
import { TransformationCoordinator } from './transformation/transformationCoordinator';
import { TransformationExecutor } from './transformation/transformationExecutor';
import type { TransformDirection } from './controlStore';
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

export async function initFleet(): Promise<FleetContext> {
  if (context) return context;
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
  };

  context = role === 'master'
    ? await initMaster({ standalone, nodeId, nodeName, appVersion, capabilities, runtime })
    : await initCoWorker({ nodeId, nodeName, appVersion, capabilities, runtime });

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

async function initMaster(init: CommonInit & { standalone: boolean }): Promise<FleetContext> {
  const { standalone, nodeId, nodeName, appVersion, capabilities, runtime } = init;
  const ingest = getIngestService();
  const store = await prepareControlStore(standalone);
  // A control-store fence trip means a second master owns the schema: this
  // master stops granting entirely (the higher-term master is the healthy one).
  let controlFenced = false;
  if (store instanceof PostgresControlStore) {
    store.onFenced(observedTerm => {
      controlFenced = true;
      _setControlStoreFenced(observedTerm);
      console.error(`[Fleet] MASTER DEPOSED BY CONTROL STORE: term ${observedTerm} observed; granting stopped until restart`);
      pushFleetStatusNow();
    });
  }
  // Shards declined for hydration-timeout: held UNPLACED while the data
  // backend is globally unhealthy (re-granting would just burn identifies);
  // the first healthy report re-enters them into placement.
  const timeoutDeclinedShards = new Set<number>();
  const term = await store.acquireTerm(nodeId);

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
  const rec = await evaluateRecovery(store, {
    newTerm: term,
    resolvedShardCount: shardCount,
    liveRecommendation: recommendedShards,
    override: getShardCountOverride(),
    standalone,
    dataBackend: resolveDataBackend(),
  });
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
  if (healthMonitor) healthMonitor.seed((await store.loadRegistry()).lostNodes ?? []);

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
  // applies only in FLEET mode.
  const targetFor = (node: RegistryNode): number => {
    if (node.isSelf && standalone) return registry.shardCount;
    return Math.max(1, node.capabilities?.shardCapacity ?? 1);
  };

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
      const url = (loadCredentials().DATA_BACKEND_URL || '').trim();
      if (url) grant.dataBackendUrl = url;
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

    const candidates = [...registry.nodes.values()].filter(n => !ledger || !ledger.inBackoff(n.nodeId));
    // Headroom counts pending-confirmation leases: they are not in the shard
    // table yet, but every composed grant re-delivers them (reGrantSetOf), so
    // they book capacity - otherwise a returning worker whose set is split
    // table/pending is undercounted and wins a free shard over its cap.
    const placements = pickFreePlacements(pool, candidates, registry, node =>
      targetFor(node) - pendingShardIdsOf(node.nodeId).length - (grantsByNode.get(node.nodeId)?.length ?? 0));
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
      const headroom = Math.max(0, targetFor(node) - reGrant.length - pinnedPlaced.length);
      if (trimmable.length > headroom) {
        const trimmed = trimmable.slice(headroom);
        trimmable = trimmable.slice(0, headroom);
        console.warn(`[Fleet] Trimmed free placement [${trimmed.join(', ')}] to ${node.nodeName}: capacity ${targetFor(node)} already booked by held+pending leases`);
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

  async function distribute(): Promise<void> {
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
    if (transformationId) {
      // Mid-window delivery: the live default plus the routing map and the
      // URL (a file-default worker still needs the runtime for converted
      // guilds); post-flip (RETIRING) the changed default IS the flip
      // instruction for a node that missed the broadcast.
      return {
        backend: live,
        url: (loadCredentials().DATA_BACKEND_URL || '').trim(),
        transformationId,
        routes: transformer!.routesView(),
      };
    }
    if (live !== 'postgres') return { backend: 'file' };
    return { backend: 'postgres', url: (loadCredentials().DATA_BACKEND_URL || '').trim() };
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

    server = new ControlServer({
      getTerm: () => registry.term,
      onRegister: (payload: RegisterPayload, send): RegisterResult => {
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
        return { accepted: true, term: registry.term, budget: ledger?.getBudgetInfo() ?? null, dataBackend: buildDataBackendInfo() };
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

  const selfHeartbeat = setInterval(() => {
    registry.recordHeartbeat(nodeId, runtime.buildHeartbeat(registry.term));
    healthMonitor?.tick();
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
  });

  // Owner-info source for .owner manifests (dataManager cannot import fleet).
  setOwnerInfoProvider(() => ({
    nodeId,
    term: registry.term,
    epoch: registry.epoch,
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

async function initCoWorker(init: CommonInit): Promise<FleetContext> {
  const { nodeId, nodeName, appVersion, capabilities, runtime } = init;
  const ingest = getIngestService();
  const masterUrl = (process.env.MASTER_URL || '').trim();
  const secret = (process.env.CONTROL_SECRET || '').trim();

  console.log(`[Fleet] Role: co-worker node=${nodeName} (${nodeId.slice(0, 8)}) master=${masterUrl || 'none'} capacity=${capabilities.shardCapacity}`);

  let controlClient: ControlClient | null = null;
  let syncEngine: SyncEngine | null = null;
  let executor: MigrationExecutor | null = null;
  if (masterUrl && secret) {
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
    migrationWorkActive = () => executor?.hasActiveLegs() ?? false;
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
    controlClient = new ControlClient({
      masterUrl,
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
      onXferControl: (type, data) => executor!.handle(type, data),
      onTransformControl: (type, data) => transformExecutor.handle(type, data),
      onDataRoutes: (_transformationId, routes, url) => {
        // Applied before the grant's hydration: a converted shard placed here
        // mid-window must read its guilds from the destination.
        applyRouteOverrides(routes);
        if (url) ensureRuntimeWith(url);
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
            const changed = await applyDeliveredBackend(info);
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
    console.error('[Fleet] Co-worker requires MASTER_URL and CONTROL_SECRET; idling without a master');
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
        console.warn('[Fleet] Co-worker unconfigured: module loading gated until MASTER_URL/CONTROL_SECRET are saved and the bot restarts');
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
      console.warn('[Fleet] Co-worker idle: MASTER_URL/CONTROL_SECRET not configured');
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
