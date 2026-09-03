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
import { DataBackendInfo, FleetConfigPayload, HeartbeatPayload, LeaseGrantPayload, LeaseInfo, LeaseRenewedPayload, LeaseRevokePayload, MSG, NodeCapabilities, NodeDrainPayload, NodeRole, RegisterPayload, RegisterResult } from './protocol';
import {
  clearRoleOverride,
  consumeTakeoverFlags,
  getAppVersion,
  getNodeId,
  getNodeName,
  invalidateRoleOverrideCache,
  isBackupMaster,
  isStandalone,
  rawMasterUrls,
  readRoleOverride,
  resolveEnvRole,
  resolveNodeRole,
  stripSelfUrl,
  wasNodeIdFreshlyGenerated,
  writeRoleOverride,
} from './nodeIdentity';
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
import { _setControlStoreFenced, _setEmptyStoreHold, _setFleetStateSources, _setStaleMasterPark, _setSuperseded, _setTakeoverHold, FleetRecoverySource, FleetRefusedRegistration, getFleetState } from './state';
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
import { applyDeliveredBackend, ensureRuntimeWith, getActiveBackendUrl, pickDeliveredUrl } from '../utils/dataBackends/boot';
import { setLeaseDeclineHandler } from '../utils/dataBackends/dataReadiness';
import { applyRouteOverrides, currentRouteDefault } from '../utils/dataBackends/routeResolver';
import { loadCredentials, resolveDataBackend, upsertCredentials } from '../../../utils/envLoader';
import { MigrationDisposition, resolveIncomingWithMaster, resumeSourceGraveyarding, runResidueSweep } from './migration/residueSweep';
import { MigrationCoordinator, PrecheckResult, StartPayload } from './migration/migrationCoordinator';
import { MigrationExecutor } from './migration/migrationExecutor';
import { TransformationCoordinator } from './transformation/transformationCoordinator';
import { TransformationExecutor } from './transformation/transformationExecutor';
import type { ControlStore, PersistedFleetConfig, PersistedTerm, TransformDirection } from './controlStore';
import { effectiveFleetConfigView, effectiveMasterUrls, readFleetConfigCache, validateMasterCandidates, validateWitnessChannelId, writeFleetConfigCache } from './fleetConfig';
import { DiscordWitness, FleetWitness, startWitnessLoop, WitnessStatus } from './witness';
import { probePeerTerm } from './peerTermProbe';
import { probeStoreEmpty } from './emptyStore';
import { readPromoteRecord, writePromoteRecord } from './promoteRecord';
import {
  clearFreshFleetConfirm,
  clearSuperseded,
  freshHigherTermClaim,
  hasFreshFleetConfirm,
  higherTermClaim,
  notifyStepDown,
  readCopyBlock,
  readSuperseded,
  requestStepDownRestart,
  SupersededSource,
  writeCopyBlock,
  writeSuperseded,
} from './stepDown';
import { LEASE_TTL_MS, STEP_DOWN_NOTIFY_MS, STEPDOWN_FALLBACK_MS, STEPDOWN_HANDOVER_DELAY_MS } from './constants';
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

let masterConfigSet: ((candidates: string[], witnessChannelId: unknown) => Promise<{ ok: boolean; error?: string; revision?: number }>) | null = null;

/** Runtime fleet-config edit (B2); master-only, pushed fleet-wide with zero restarts. */
export async function fleetSetConfig(candidates: unknown, witnessChannelId?: unknown): Promise<{ ok: boolean; error?: string; revision?: number }> {
  if (!masterConfigSet) return { ok: false, error: 'This node is not the fleet master' };
  return masterConfigSet(Array.isArray(candidates) ? (candidates as string[]) : [], witnessChannelId);
}

export async function initFleet(): Promise<FleetContext> {
  if (context) return context;
  if ((process.env.MASTER_URLS || '').trim() !== '' && (process.env.BOT_NODE_ROLE || '').trim() === '' && !readRoleOverride()) {
    console.warn('[Fleet] MASTER_URLS is set but BOT_NODE_ROLE is not. The candidate list NEVER changes a node\'s role; set BOT_NODE_ROLE=master, co-worker or backup-master explicitly on every node that carries MASTER_URLS.');
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
 * the verdict cannot improve by waiting. Demote is the way out.
 */
async function runStaleMasterFence(
  store: ControlStore,
  selfNodeId: string,
  selfNodeName: string,
  standalone: boolean,
  takeoverConfirmed: boolean,
): Promise<void> {
  if (standalone) return;
  if (takeoverConfirmed) {
    console.warn('[Fleet] Takeover CONFIRMED; skipping the stale-master fence');
    return;
  }
  const secret = (process.env.CONTROL_SECRET || '').trim();
  const { urls: candidates } = effectiveMasterUrls();
  const token = (process.env.DISCORD_TOKEN || '').trim();
  if ((secret === '' || candidates.length === 0) && token === '') return;

  // Hold rather than skip on an unreadable store, exactly like the guard: the
  // very next statement blocks on the same store until it answers, so waiting
  // here costs nothing and silently dropping the only fork check costs a fleet.
  let local: PersistedTerm | null = null;
  for (;;) {
    try {
      local = await store.getTerm();
      break;
    } catch {
      console.warn('[Fleet] Stale-master fence: control store unreadable; holding before it can judge the boot');
      await guardSleep(TERM_GUARD_POLL_MS);
    }
  }
  const localTerm = local ? local.term : 0;
  const park = (observedTerm: number, peerUrl: string, detail: string, extra = ''): Promise<never> => {
    console.error(`[Fleet] STALE MASTER FENCE: ${detail}; parking the boot instead of acquiring a term on a database the fleet has moved off. Demote this node to rejoin as a co-worker.${extra}`);
    _setStaleMasterPark({ observedTerm, localTerm, peerUrl, at: Date.now() });
    pushFleetStatusNow();
    return (async () => { for (;;) await guardSleep(TERM_GUARD_POLL_MS); })();
  };

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
      await park(peer.term, url, `${url} answers as a live master on term ${peer.term} while this node's store holds ${localTerm} and nothing is writing to it`);
    }
  }

  // Witness half (PLAN_REPLICATION 20.6/20.14): a higher term another node
  // EVER posted means this copy is a stale fork, fresh beacon or not, and it
  // is the only evidence that reaches a master that cannot be dialed
  // (Windows, NAT). Darkness is not evidence, like silence above.
  if (token !== '') {
    const witness = new DiscordWitness({
      token,
      nodeId: selfNodeId,
      nodeName: selfNodeName,
      getChannelId: () => readFleetConfigCache()?.witnessChannelId ?? null,
    });
    const claims = await witness.readClaims();
    const higher = claims ? higherTermClaim(claims, selfNodeId, localTerm) : null;
    if (higher) {
      // The restore tail belongs to THIS half only: the peer half means a
      // foreign master is answering LIVE right now, where the same advice
      // would talk an operator into a dual-master seize.
      await park(higher.term, `witness beacon of ${higher.nodeName}`, `the witness holds a beacon from ${higher.nodeName} (${higher.nodeId.slice(0, 8)}) at term ${higher.term} while this node's store holds ${localTerm}`,
        ' If this database was DELIBERATELY restored from a dump, the fleet has not moved anywhere: the manager\'s restore lane advances the restored control term automatically, and FLEET_CONFIRM_TAKEOVER=1 on the next start overrides the fence by hand.');
    }
  }
}

/**
 * Master candidates that are provably NOT this node. FLEET_PUBLIC_URL makes the
 * self-filter exact; without it (a hand deployment where the manager injects
 * nothing) a lone entry may well be this node's own advertised URL, while two
 * or more entries always include at least one foreign node. A stored backup
 * designation is evidence on its own, and survives a lost database volume
 * because it lives in the node's data directory.
 */
function otherNodesConfigured(selfNodeId: string): string[] {
  const cached = readFleetConfigCache();
  // A designation is the strongest evidence and the one that survives a lost
  // database volume, so it is checked on its own, never behind a URL list: a
  // manager-deployed master often carries no MASTER_URLS at all (the workers
  // dial it), which would otherwise read as a fleet of one.
  const designated = (cached?.backupDesignations ?? []).filter(d => d.nodeId !== selfNodeId);
  // The runtime list owns the topology once it exists (20.7); env seeds it.
  const fleetWide = cached?.masterCandidates?.length ? cached.masterCandidates : rawMasterUrls();
  // FLEET_PUBLIC_URL makes the self-filter exact; without it (hand deployment)
  // a lone entry may be this node's own advertised URL, while two or more
  // always include at least one foreign node.
  const foreign = (process.env.FLEET_PUBLIC_URL || '').trim() !== ''
    ? stripSelfUrl(fleetWide)
    : (fleetWide.length > 1 ? fleetWide : []);
  if (foreign.length > 0) return foreign;
  return designated.map(d => `node ${d.nodeId.slice(0, 8)}`);
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
 * populated (seeded), when a takeover override appears (a promote restarts
 * this child anyway) or on the operator's brand-new-fleet confirmation, which
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
    invalidateRoleOverrideCache();
    const override = readRoleOverride();
    if (override?.takeover === true || (process.env.FLEET_CONFIRM_TAKEOVER || '').trim() === '1') {
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
      console.error(`[Fleet] EMPTY STORE HOLD: this master's database is ${verdict} while other fleet nodes are configured (${candidates.join(', ')}). It will not mint a term on an empty store while a backup may hold the real data. Provision this machine as a standby of the node that holds the data and let it catch up, or demote this node to rejoin as a co-worker, or confirm a brand-new fleet from the Fleet tab.`);
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

async function initMaster(init: CommonInit & { standalone: boolean }): Promise<FleetContext> {
  const { standalone, nodeId, nodeName, appVersion, capabilities, runtime } = init;
  const ingest = getIngestService();
  const usedFreshConfirm = await runEmptyStoreHold(standalone, nodeId);
  const store = await prepareControlStore(standalone);
  // A control-store fence trip means a second master owns the schema: this
  // master stops granting entirely (the higher-term master is the healthy
  // one). Teardown (assigned once the server exists) drops every worker so
  // their candidate cycle finds the live master, and new registers are
  // refused 'deposed' via the controlFenced check in onRegister. The
  // supersession hook (assigned once the registry exists) turns the fence
  // into a step-down (B4).
  let controlFenced = false;
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
  const takeoverConfirmed = bootOverride?.takeover === true
    || (process.env.FLEET_CONFIRM_TAKEOVER || '').trim() === '1';
  const chainTakeover = !standalone && bootOverride?.chainTakeover === true;
  let previousHolder: { term: number; nodeId: string } | null = null;
  if (store instanceof PostgresControlStore && !standalone) {
    previousHolder = await runTakeoverGuard(store, nodeId, takeoverConfirmed);
  }
  await runStaleMasterFence(store, nodeId, nodeName, standalone, takeoverConfirmed);

  // The boot cleared every gate, so the brand-new-fleet answer has been spent
  // on the store it was given for.
  if (usedFreshConfirm) clearFreshFleetConfirm();
  const term = await store.acquireTerm(nodeId);
  if (bootOverride?.takeover || bootOverride?.chainTakeover) consumeTakeoverFlags();
  // The stamp is this master's own lease (PLAN_STANDBY 3.1): deposed masters
  // learn of it within one interval, and stamp health feeds the fleet-state banner.
  if (store instanceof PostgresControlStore && !standalone) {
    const stampTimer = setInterval(() => void store.stampTerm(), TERM_STAMP_MS);
    stampTimer.unref();
  }

  // Fleet runtime config (PLAN_REPLICATION 20.7, B2): the stored copy owns the
  // topology once it exists; the env list seeds it exactly once, on the first
  // master boot against a store that has none.
  let fleetConfig: PersistedFleetConfig | null = null;
  if (!standalone) {
    fleetConfig = await store.loadFleetConfig();
    if (!fleetConfig) {
      // Seed from the UNFILTERED env list: the stored copy is fleet-wide and
      // must include this master's own URL (workers dial it); the per-node
      // self-filter applies at dial time (effectiveMasterUrls).
      fleetConfig = { revision: 1, masterCandidates: rawMasterUrls(), backupDesignations: [], updatedAt: Date.now() };
      await store.saveFleetConfig(fleetConfig)
        .catch(err => console.warn('[Fleet] Failed to persist the seeded fleet config:', err instanceof Error ? err.message : err));
    }
  }
  const fleetConfigPayload = (): FleetConfigPayload => ({
    revision: fleetConfig!.revision,
    masterCandidates: fleetConfig!.masterCandidates,
    backupDesignations: fleetConfig!.backupDesignations,
    ...(fleetConfig!.witnessChannelId !== undefined ? { witnessChannelId: fleetConfig!.witnessChannelId } : {}),
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

  // Persist + push a fleet-config change (B2). The cache write is synchronous
  // truth for this node; the store write and the per-node pushes are fire-and-
  // forget (a missed push is re-delivered on that node's next register).
  const persistFleetConfig = (why: string): void => {
    if (!fleetConfig) return;
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
  masterConfigSet = async (candidates: string[], witnessChannelId: unknown) => {
    if (!fleetConfig) return { ok: false, error: 'a standalone master holds no fleet config' };
    const valid = validateMasterCandidates(candidates);
    if (!valid.ok) return { ok: false, error: valid.error };
    // Undefined = the caller did not touch the witness field; empty = clear to the owner DM default.
    const witness = witnessChannelId === undefined
      ? { ok: true as const, value: fleetConfig.witnessChannelId }
      : validateWitnessChannelId(witnessChannelId);
    if (!witness.ok) return { ok: false, error: witness.error };
    fleetConfig = {
      ...fleetConfig,
      revision: fleetConfig.revision + 1,
      masterCandidates: valid.urls,
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
  // applies only in FLEET mode. Capacity 0 is a real declaration (a pure
  // standby that serves nothing, PLAN_STANDBY ruling 1); only absent/invalid
  // declarations fall back to 1.
  const targetFor = (node: RegistryNode): number => {
    if (node.isSelf && standalone) return registry.shardCount;
    const declared = node.capabilities?.shardCapacity;
    if (declared === 0) return 0;
    return Math.max(1, declared ?? 1);
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
    const persistSupersession = (steppedDown: boolean): void => {
      if (!supersededBy) return;
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
      persistSupersession(true);
      console.warn(`[Fleet] STEP-DOWN (${reason}): restarting in ${Math.round(STEPDOWN_HANDOVER_DELAY_MS / 1000)}s to rejoin under ${supersededBy.nodeName} (term ${supersededBy.term})`);
      setTimeout(() => requestStepDownRestart(), STEPDOWN_HANDOVER_DELAY_MS).unref();
      // The IPC send is the only way back to a co-worker, and it can be lost
      // (parent mid-restart, detached child), so it repeats until the process
      // is replaced. The override is already on disk either way.
      setInterval(() => requestStepDownRestart(), STEPDOWN_FALLBACK_MS).unref();
    };
    beginSupersession = (by, source): void => {
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
        // on its first registration; from then on the stored list owns it.
        if (fleetConfig && payload.capabilities?.backupMaster === true
            && !fleetConfig.backupDesignations.some(d => d.nodeId === payload.nodeId)) {
          const priority = fleetConfig.backupDesignations.reduce((max, d) => Math.max(max, d.priority), 0) + 1;
          fleetConfig = {
            ...fleetConfig,
            revision: fleetConfig.revision + 1,
            backupDesignations: [...fleetConfig.backupDesignations, { nodeId: payload.nodeId, priority }],
            updatedAt: Date.now(),
          };
          persistFleetConfig(`designated backup ${payload.nodeName || payload.nodeId}`);
        }
        // B4 facts: the node this master superseded learns it here (and
        // whether the owner asked to retire it); designated backups get the
        // copy block a brand-new machine seeds from.
        // Delivered ONCE (marked in afterRegister, once the reply is actually
        // on the wire): a standing retire instruction re-armed on every
        // reconnect would keep a long-retired side flagged forever.
        const promote = readPromoteRecord();
        const superseded = promote && promote.supersededNodeId === payload.nodeId && !promote.supersededDelivered
          ? { byNodeId: nodeId, byNodeName: nodeName, term: registry.term, retireRequested: promote.retireOldMaster, at: Date.now() }
          : null;
        const copyBlock = payload.capabilities?.backupMaster === true ? readCopyBlock() : null;
        return {
          accepted: true,
          term: registry.term,
          budget: ledger?.getBudgetInfo() ?? null,
          dataBackend: buildDataBackendInfo(),
          ...(fleetConfig ? { fleetConfig: fleetConfigPayload() } : {}),
          ...(superseded ? { superseded } : {}),
          ...(copyBlock ? { copyBlock } : {}),
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
    onDeposedTeardown = () => server?.dropAll();

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
      witness = startWitnessLoop({
        token: witnessToken,
        nodeId,
        nodeName,
        role: 'master',
        getTerm: () => registry.term,
        // Published so a backup can tell "the master's database died" from
        // "I cannot reach the master's database" (20.12 c3): only this node
        // knows which one it is. A stamp failing longer than a worker's lease
        // TTL is a dead store, not a blip.
        getStoreHealthy: () => {
          if (!(store instanceof PostgresControlStore) || standalone) return true;
          const failingForMs = store.getStampFailingForMs();
          return failingForMs === null || failingForMs < LEASE_TTL_MS;
        },
        getChannelId: () => fleetConfig?.witnessChannelId ?? null,
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

  const selfHeartbeat = setInterval(() => {
    registry.recordHeartbeat(nodeId, runtime.buildHeartbeat(registry.term));
    healthMonitor?.tick();
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
    termStamp: store instanceof PostgresControlStore && !standalone ? () => store.getStampFailingForMs() : null,
    fleetConfig: () => (fleetConfig ? { revision: fleetConfig.revision, masterCandidates: fleetConfig.masterCandidates, backupDesignations: fleetConfig.backupDesignations, ...(fleetConfig.witnessChannelId !== undefined ? { witnessChannelId: fleetConfig.witnessChannelId } : {}), source: 'runtime' as const } : null),
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

async function initCoWorker(init: CommonInit): Promise<FleetContext> {
  const { nodeId, nodeName, appVersion, capabilities, runtime } = init;
  const ingest = getIngestService();
  const { urls: masterUrls, source: masterUrlsSource } = effectiveMasterUrls();
  const secret = (process.env.CONTROL_SECRET || '').trim();

  console.log(`[Fleet] Role: co-worker node=${nodeName} (${nodeId.slice(0, 8)}) masters=${masterUrls.join(' | ') || 'none'} (${masterUrlsSource}) capacity=${capabilities.shardCapacity}${isBackupMaster() ? ` BACKUP MASTER` : ''}`);
  // A stepped-down old master carries its superseded fact into the co-worker
  // role until the manager retires or decommissions this side (B4).
  const priorSupersession = readSuperseded();
  if (priorSupersession) {
    _setSuperseded({ byNodeId: priorSupersession.byNodeId, byNodeName: priorSupersession.byNodeName, term: priorSupersession.term, source: priorSupersession.source, since: priorSupersession.at, steppedDown: true });
  }

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
        _setSuperseded({ byNodeId: info.byNodeId, byNodeName: info.byNodeName, term: info.term, source, since, steppedDown: true });
        if (info.retireRequested) console.warn(`[Fleet] The owner asked to retire this side after the transfer to ${info.byNodeName}; the manager performs it`);
      },
      onCopyBlock: block => writeCopyBlock(block),
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
            const { changed, recycled } = await applyDeliveredBackend(info);
            // A recycled runtime starts with a driver that knows no shards; the
            // held lease is re-mirrored so it hydrates without waiting for the
            // next grant (which may already have landed). Keyed on the recycle,
            // not on the env change: the two do not always coincide.
            if (recycled) runtime.renotifyDataLayer();
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

  let witness: FleetWitness | null = null;
  if (isBackupMaster()) {
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
