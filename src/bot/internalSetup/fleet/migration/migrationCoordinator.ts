// Migration coordinator (P5): master-only state machine that drives Move, Swap,
// Retire and Redistribute under the joint-commit barrier. It relays CONTROL
// only - all data flows node-to-node through the transfer channel. The record
// is persisted on EVERY transition; COMMITTING is persisted BEFORE the first
// commit message leaves, which is the both-or-neither decision barrier.
//
// It never restructures lease/drain/ledger logic: gateway legs go through the
// injected grantShardsTo (identify metered by the P2 ledger) and revokeLease;
// health comes from registry.healthOf; the data primitives are the Stage 4
// facade, invoked here only via the executor (self-participant) and the control
// channel (remote participants).
//
// Inert in standalone: bootstrap does not construct this class there.

import { performance } from 'perf_hooks';
import { randomBytes, randomUUID } from 'crypto';
import {
  MIGRATION_HISTORY_CAP,
  SPACE_CUSHION_BYTES,
  SPACE_MARGIN,
  XFER_COMMIT_RETRY_MS,
  XFER_DELTA_THRESHOLD_FILES,
  XFER_DRAIN_TIMEOUT_MS,
  XFER_PREPARE_TIMEOUT_MS,
  XFER_STALL_TIMEOUT_MS,
} from '../constants';
import type { ControlStore, MigrationLeg, MigrationRecord, MigrationState, PersistedMigrations } from '../controlStore';
import {
  MSG,
  MigrationKind,
  TransferDirection,
  XferFlushedPayload,
  XferInventoryReply,
  XferInventoryRequest,
  XferPrepareLeg,
  XferPreparePayload,
  XferPreparedPayload,
  XferProgressPayload,
  XferVerifyPayload,
} from '../protocol';
import { routeFor } from '../../utils/dataBackends/routeResolver';
import type { Registry } from '../registry';
import type { HeldShardView, MigrationActiveView, MigrationLegView, MigrationView } from '../state';

export interface StartMovePayload { kind: 'move'; shardId: number; toNodeId: string; }
export interface StartSwapLeg { shardId: number; fromNodeId: string; toNodeId: string; }
export interface StartSwapPayload { kind: 'swap'; legs: StartSwapLeg[]; }
export interface StartRetirePayload { kind: 'retire'; nodeId: string; targets: Record<string, string>; }
export interface StartRedistributePayload { kind: 'redistribute'; }
export type StartPayload = StartMovePayload | StartSwapPayload | StartRetirePayload | StartRedistributePayload;

type OwedLeg = { rec: MigrationRecord; leg: MigrationLeg; nodeId: string };

export interface PrecheckResult {
  ok: boolean;
  error?: string;
  estBytes?: number;
  targetFreeBytes?: number | null;
  direction?: TransferDirection;
  guilds?: string[];
  warnings?: string[];
  /** Redistribute: the computed data-only move set + unreachable holders. */
  moveSet?: { shardId: number; from: string; to: string; guilds: string[] }[];
  unreachable?: { nodeId: string; nodeName: string }[];
}

export interface CoordinatorHooks {
  registry: Registry;
  selfNodeId: string;
  store: ControlStore;
  /** True while the reshard pause marker exists (redistribute is the only pause-time migration). */
  isPaused: () => boolean;
  /** Milliseconds left of the recovery hold-down (0 when elapsed); the fleet is still assembling while > 0. */
  holdDownRemainingMs: () => number;
  /** Grant a node its full shard set (the existing metered grant path). Returns ok/pending. */
  grantShardsTo: (nodeId: string, fullShardIds: number[], epoch: number) => Promise<{ ok: boolean; pending: boolean }>;
  /** Revoke specific leases from a node (source destroys sessions). */
  revokeLease: (nodeId: string, leaseIds: string[], reason: string) => Promise<{ ok: boolean }>;
  /**
   * Every leaseId the node may hold for the given shards: the master's records
   * plus everything the node itself reported (register summary, last renew,
   * drain-raced grants). Mirrors the operator-drain lease-id union so an
   * adoption-invented table leaseId alone cannot make the revoke a no-op.
   */
  drainLeaseIdsForShards: (nodeId: string, shardIds: number[]) => string[];
  /** Persist the plan after a grant round (reuses bootstrap.persist). */
  persistPlan: () => Promise<void>;
  /**
   * Persist the redistribute assignment proposal (shard -> node) alongside the
   * reshard pause so masterResume grants EXACTLY the proposal (the node the
   * data was placed on), not a load-based re-distribute. Null clears it.
   */
  saveRedistributeProposal: (proposal: Record<number, string> | null) => Promise<void>;
  /**
   * Load the persisted redistribute proposal (shard -> node), or null when none
   * is on disk. persistProposal merges into this so a crash-recovery re-persist
   * (empty in-memory proposal) can never clobber the durable full proposal with
   * a moved-shards-only subset.
   */
  loadRedistributeProposal: () => Promise<Record<number, string> | null>;
  /** Send a control request to a remote node; the master self-routes to its own executor. */
  sendControl: (nodeId: string, type: string, data: any) => Promise<any>;
  /** True when the nodeId is this master (self-participant path). */
  isSelf: (nodeId: string) => boolean;
  /** This master's own executor for self-participant legs. */
  selfExecutor: { handle: (type: string, data: any) => Promise<any> };
  /** Advertised transfer endpoint for a node (from its register capabilities), or undefined. */
  transferUrlOf: (nodeId: string) => string | undefined;
  /** Push the fleet status (progress rides the existing bot:fleet:status push). */
  pushStatus: () => void;
  /** Live frozen-write rejection count from the data facade (drain-window backstop). */
  frozenWriteRejections: () => number;
  /** Master-side DB liveness (lease-only prechecks; replaces the statfs gate). */
  dataBackendHealthy: () => boolean;
  /** Node-down hook fired when a participant is declared lost / disconnects mid-migration. */
  onNodeDownDuringMigration?: (nodeId: string) => void;
  /** Migrations are refused while a backend transformation is active (spec 3.3). */
  transformationActive?: () => boolean;
}

interface LegLive {
  leg: MigrationLeg;
  guildsTotal: number;
  guildsDone: number;
  bytesSent: number;
  round: number;
  deltaFiles: number;
  lastProgressAt: number;
  sourceVerify?: XferVerifyPayload;
  targetVerify?: XferVerifyPayload;
  flushed?: XferFlushedPayload;
  error?: string;
}

export class MigrationCoordinator {
  private record: MigrationRecord | null = null;
  private history: MigrationRecord[] = [];
  private recovered = false;
  // The persisted records exist but could not be read: never written over
  // (their repair and a restart bring them back) and no migration starts.
  private recordsUnreadable = false;
  private live = new Map<string, LegLive>(); // legId -> live
  private paused = false; // retire pause (Resume/Abort-remaining)
  // The running leg's abort ends the whole retire instead of pausing it (B4f-4: the planned transfer's Cancel).
  private abortWholeRetire = false;
  private drainRan = false; // true once a drain revoked leases (abort rollback re-grants the source)
  // Shards fenced OFF the free pool for the whole in-flight window (DRAINING
  // through GRANTING or abort-rollback). The free-shard distributor consults
  // migratingShardIds() so a drained shard can never be re-granted mid-flight
  // (which would double-own / dual-identify it against its migration target).
  private migrating = new Set<number>();
  private stallTimer: NodeJS.Timeout | null = null;
  private commitTimer: NodeJS.Timeout | null = null;
  private drainTimer: NodeJS.Timeout | null = null;

  constructor(private readonly hooks: CoordinatorHooks) {}

  // --------------------------------------------------------------------------
  // Boot recovery (called AFTER the P1 plan/registry reload).
  // --------------------------------------------------------------------------
  async recover(): Promise<void> {
    let persisted: PersistedMigrations;
    try {
      persisted = await this.hooks.store.loadMigrations();
    } catch (error) {
      this.recordsUnreadable = true;
      throw error;
    }
    this.history = persisted.history ?? [];
    if (persisted.unreadable) {
      this.recordsUnreadable = true;
      console.warn(`[Migration] ${RECORDS_UNREADABLE}; every node keeps its migration staging until then`);
    } else {
      // A hold whose shard the restored plan places is over: its restore
      // landed, or the Declare Lost never reached the plan.
      for (const rec of [persisted.active, ...this.history]) {
        for (const leg of rec?.legs ?? []) if (leg.heldForChoice && !this.unplaced(leg.shardId)) delete leg.heldForChoice;
        for (const entry of rec?.pendingSourceCleanup ?? []) {
          for (const legId of entry.legIds) this.keepOwingKnown(entry.nodeId, rec!.legs.find(l => l.legId === legId));
        }
      }
      this.recovered = true;
    }
    const rec = persisted.active;
    if (!rec) return;
    this.record = rec;
    console.warn(`[Migration] Recovering ${rec.kind} ${rec.id} in state ${rec.state}`);
    if (rec.kind === 'retire') {
      await this.recoverRetire(rec);
      return;
    }
    if (rec.state === 'COMMITTING') {
      // The decision was persisted; both-or-neither holds. Resume commit retries.
      // Re-fence the moving shards: the source lease was revoked and the shard
      // removed from the table before the crash, so distribute() must not
      // re-place them before GRANTING lands the grant on the target.
      this.fenceShards(rec.legs.map(l => l.shardId));
      this.hydrateLive(rec);
      await this.enterCommitting(true);
    } else if (rec.state === 'GRANTING') {
      this.fenceShards(rec.legs.map(l => l.shardId));
      this.hydrateLive(rec);
      await this.enterGranting();
    } else if (rec.state === 'DONE' || rec.state === 'ABORTED') {
      await this.finish(rec.state);
    } else {
      // Any pre-COMMITTING state: abort. Aborts deliver as participants reconnect.
      this.hydrateLive(rec);
      // DRAINING/VERIFYING already revoked the source lease, as did a drained
      // leg's drain before its abort began, so the abort must re-grant the
      // source (rollback identify). The rollback sets each source's entry
      // itself, whether the plan reload restored it or a plan written since
      // dropped it.
      if (rec.state === 'DRAINING' || rec.state === 'VERIFYING' || rec.legs.some(l => l.drained)) this.drainRan = true;
      await this.enterAborting('master restarted before commit decision');
    }
  }

  // Retire recovery: completed legs (legState DONE) stand; the current leg is
  // re-entered by its persisted phase (COMMITTING -> resume commit, GRANTING ->
  // re-grant, else abort that leg safely). Then runRetire continues the rest.
  private async recoverRetire(rec: MigrationRecord): Promise<void> {
    const idx = rec.currentLegIndex ?? 0;
    const leg = rec.legs[idx];
    if (!leg || leg.legState === 'DONE') {
      // The current leg already finished (or none): resume the sequence.
      rec.currentLegIndex = Math.min(rec.legs.length, idx + (leg?.legState === 'DONE' ? 1 : 0));
      void this.runRetire();
      return;
    }
    const state = leg.legState ?? 'PREPARING';
    // Not awaited: the leg finishes through finishHooks, which runs the rest
    // of the retire; a recovery awaiting it would hold the master's boot
    // while a target is down.
    const parent = rec;
    this.parentRecord = parent;
    const single: MigrationRecord = { ...parent, legs: [leg], state, epoch: parent.epoch };
    this.record = single;
    this.hydrateLive(single);
    // Re-fence a committing/granting leg (shard already off the table) so
    // distribute() cannot re-place it before the grant lands. DRAINING/
    // VERIFYING, or an abort of a drained leg, revoked the source lease, so
    // recovery-abort re-grants it back.
    if (state === 'COMMITTING' || state === 'GRANTING') this.fenceShards([leg.shardId]);
    if (state === 'DRAINING' || state === 'VERIFYING' || leg.drained) this.drainRan = true;
    this.finishHooks = (finalState: 'DONE' | 'ABORTED') => {
      leg.legState = finalState;
      // Finished, its rollback done: a later recovery owes it none.
      delete leg.drained;
      // Same trailing-frame protection as runSingleLegMove's finishHooks.
      this.live.delete(leg.legId);
      if (finalState === 'ABORTED') { leg.error = single.error; parent.error = single.error; }
      for (const entry of single.pendingSourceCleanup ?? []) {
        for (const legId of entry.legIds) this.recordPendingSourceLeg(parent, entry.nodeId, legId);
      }
      parent.legs[idx] = leg;
      this.record = parent;
      this.parentRecord = null;
      this.finishHooks = null;
      if (finalState === 'DONE') void this.runRetire();
      else { this.paused = true; void this.persist().then(() => this.hooks.pushStatus()); }
    };
    if (state === 'COMMITTING') void this.enterCommitting(true);
    else if (state === 'GRANTING') void this.enterGranting();
    else void this.enterAborting('master restarted before commit decision');
  }

  private hydrateLive(rec: MigrationRecord): void {
    this.drainRan = false;
    this.live.clear();
    for (const leg of rec.legs) {
      this.live.set(leg.legId, {
        leg,
        guildsTotal: leg.guilds.length,
        guildsDone: 0,
        bytesSent: 0,
        round: 0,
        deltaFiles: 0,
        lastProgressAt: performance.now(),
      });
    }
  }

  // --------------------------------------------------------------------------
  // Public API (bootstrap delegates the IPC surface here).
  // --------------------------------------------------------------------------
  hasActive(): boolean {
    return this.record !== null && !isTerminal(this.record.state);
  }

  /**
   * Shards under an active migration's in-flight window (fenced OFF the free
   * pool). The free-shard distributor and manual assign subtract these so a
   * drained-but-not-yet-granted shard is never re-placed onto a data-less node.
   */
  migratingShardIds(): ReadonlySet<number> {
    return this.migrating;
  }

  /** The shards the granting migration still owes nodeId. */
  grantsOwedTo(nodeId: string): number[] {
    return this.grantLegsOwedTo(nodeId).map(l => l.shardId);
  }

  // A retire paused between legs keeps its last leg's state on the parent,
  // so only a running slice of a retire is granting.
  private grantLegsOwedTo(nodeId: string): MigrationLeg[] {
    const rec = this.record;
    if (rec?.state !== 'GRANTING' || (rec.kind === 'retire' && this.parentRecord === null)) return [];
    return rec.legs.filter(l => l.targetNodeId === nodeId && l.targetLostAt === undefined);
  }

  /**
   * Shards with a still-pending source cleanup (a source down at COMMITTING whose
   * originals were deferred). Fenced OFF the free pool so a shard freed by a
   * later Declare Lost is never load-placed back onto its own un-cleaned source
   * (or elsewhere) before the deferred cleanup runs. Released naturally when the
   * leg leaves pendingSourceCleanup (its cleanup acked, or its source's release
   * acked when the shard is back on that source). Empty in standalone and in
   * normal non-migration operation.
   */
  pendingSourceCleanupShardIds(): ReadonlySet<number> {
    const ids = new Set<number>();
    const records = this.cleanupRecords();
    for (const rec of records) {
      if (!rec.pendingSourceCleanup || !this.ofCurrentCount(rec)) continue;
      for (const entry of rec.pendingSourceCleanup) {
        for (const legId of entry.legIds) {
          const leg = rec.legs.find(l => l.legId === legId);
          // A lost node's copy went with it: its note fences the shard only
          // once the node is back, until its cleanup runs.
          if (leg && (leg.sourceLostAt === undefined || this.hooks.registry.nodes.has(entry.nodeId))) ids.add(leg.shardId);
        }
      }
    }
    return ids;
  }

  /** The nodes a deferred source cleanup waits on, with the shards it covers; crossed when one was made before a reshard. */
  pendingSourceCleanups(): { nodeId: string; shardIds: number[]; crossed: boolean }[] {
    const byNode = new Map<string, { ids: Set<number>; crossed: boolean }>();
    const records = this.cleanupRecords();
    for (const rec of records) {
      const current = this.ofCurrentCount(rec);
      for (const entry of rec.pendingSourceCleanup ?? []) {
        for (const legId of entry.legIds) {
          const leg = rec.legs.find(l => l.legId === legId);
          if (!leg) continue;
          const owed = byNode.get(entry.nodeId) ?? { ids: new Set<number>(), crossed: false };
          if (current) owed.ids.add(leg.shardId);
          else owed.crossed = true;
          byNode.set(entry.nodeId, owed);
        }
      }
    }
    return [...byNode.entries()].map(([nodeId, owed]) => ({ nodeId, shardIds: [...owed.ids].sort((a, b) => a - b), crossed: owed.crossed }));
  }

  // A record's legs are numbered under the shard count it was made at. A
  // note of another count (only a node Declared Lost carries one across a
  // reshard) names no current shard: it keeps only its cleanup by guild ids.
  private ofCurrentCount(rec: MigrationRecord): boolean {
    return rec.shardCount === undefined || rec.shardCount === this.hooks.registry.shardCount;
  }

  /** Every owed cleanup of the shard's moves, once each, with the node owing it. */
  private owedLegsOf(shardId: number): OwedLeg[] {
    const found: OwedLeg[] = [];
    for (const rec of this.cleanupRecords()) {
      if (!this.ofCurrentCount(rec)) continue;
      for (const entry of rec.pendingSourceCleanup ?? []) {
        for (const legId of entry.legIds) {
          const leg = rec.legs.find(l => l.legId === legId);
          if (!leg || leg.shardId !== shardId || leg.direction === 'none') continue;
          if (found.some(f => f.leg.legId === legId && f.nodeId === entry.nodeId)) continue;
          found.push({ rec, leg, nodeId: entry.nodeId });
        }
      }
    }
    return found;
  }

  /**
   * A Declare Lost: the copies the lost node still owed cleanups of went
   * with it, and a shard whose newest copy went with it (one it frees, or
   * one left unplaced, by a drain or the reshard pause, whose newest
   * committed move went there) with an older copy surviving on a node
   * owing that move's cleanup (maybe its last copy) has that cleanup held
   * for the operator's choice. Returns the shards now held.
   */
  async onNodeDeclaredLost(lostNodeId: string, lostNodeName: string, freedShardIds: number[]): Promise<number[]> {
    const at = Date.now();
    let changed = false;
    // Its owed grants can never land: the grant round settles them (a
    // retire's slice is not what persist writes, so its parent's leg too).
    const lostLegIds = new Set(this.grantLegsOwedTo(lostNodeId).map(l => l.legId));
    for (const rec of new Set([this.record, this.parentRecord])) {
      for (const leg of rec?.legs ?? []) {
        if (!lostLegIds.has(leg.legId) || leg.targetLostAt !== undefined) continue;
        leg.targetLostAt = at;
        changed = true;
      }
    }
    // A commit under way notes a source's cleanup only when it reaches the
    // source: its committed legs from this node are marked now, so a note
    // written after is a lost node's too.
    for (const rec of new Set([this.record, this.parentRecord])) {
      for (const leg of rec?.legs ?? []) {
        if (leg.sourceNodeId !== lostNodeId || !leg.committed || leg.sourceLostAt !== undefined) continue;
        leg.sourceLostAt = at;
        delete leg.heldForChoice;
        changed = true;
      }
    }
    for (const rec of this.cleanupRecords()) {
      for (const legId of rec.pendingSourceCleanup?.find(e => e.nodeId === lostNodeId)?.legIds ?? []) {
        const leg = rec.legs.find(l => l.legId === legId);
        if (!leg || leg.sourceLostAt !== undefined) continue;
        leg.sourceLostAt = at;
        delete leg.heldForChoice;
        changed = true;
      }
    }
    const lostCopies = new Set(freedShardIds);
    for (const rec of this.cleanupRecords()) {
      if (!this.ofCurrentCount(rec)) continue;
      for (const entry of rec.pendingSourceCleanup ?? []) {
        for (const legId of entry.legIds) {
          const leg = rec.legs.find(l => l.legId === legId);
          if (leg?.targetNodeId === lostNodeId && this.unplaced(leg.shardId) && this.newestCommitOf(leg.shardId)?.leg.targetNodeId === lostNodeId) lostCopies.add(leg.shardId);
        }
      }
    }
    const held = new Set<number>();
    for (const shardId of lostCopies) {
      for (const { leg } of this.owedLegsOf(shardId)) {
        if (leg.sourceLostAt !== undefined) continue;
        if (!leg.heldForChoice) leg.heldForChoice = { lostNodeName, at };
        held.add(shardId);
        changed = true;
      }
    }
    if (changed) await this.persist();
    return [...held].sort((a, b) => a - b);
  }

  /** A held copy's cleanup waits only while its shard is unplaced; a placement (the restore) ends the wait. */
  private awaitsChoice(leg: MigrationLeg): boolean {
    return leg.heldForChoice !== undefined && this.unplaced(leg.shardId) && !this.migrating.has(leg.shardId);
  }

  /** No node serves the shard or awaits its grant. */
  private unplaced(shardId: number): boolean {
    const registry = this.hooks.registry;
    return !registry.shardTable.has(shardId) && !registry.pendingConfirmation?.has(shardId);
  }

  /** The shard's newest committed move (by its commit epoch) among the records kept, with its record. */
  private newestCommitOf(shardId: number): { rec: MigrationRecord; leg: MigrationLeg } | null {
    let newest: { rec: MigrationRecord; leg: MigrationLeg; epoch: number } | null = null;
    for (const rec of this.cleanupRecords()) {
      if (!this.ofCurrentCount(rec)) continue;
      for (const leg of rec.legs) {
        if (leg.shardId !== shardId || !leg.committed) continue;
        if (!newest || leg.committed.epoch > newest.epoch) newest = { rec, leg, epoch: leg.committed.epoch };
      }
    }
    return newest;
  }

  /** The records holding the newest commit of each shard a kept record still owes a cleanup of. */
  private newestOfOwed(): Set<MigrationRecord> {
    const keep = new Set<MigrationRecord>();
    for (const rec of this.cleanupRecords()) {
      if (!this.ofCurrentCount(rec)) continue;
      for (const entry of rec.pendingSourceCleanup ?? []) {
        for (const legId of entry.legIds) {
          const leg = rec.legs.find(l => l.legId === legId);
          const newest = leg ? this.newestCommitOf(leg.shardId) : null;
          if (newest) keep.add(newest.rec);
        }
      }
    }
    return keep;
  }

  /**
   * A held shard's surviving copies: the newest (the highest commit epoch
   * of the leg itself, since a retire's record keeps only its last leg's;
   * one commit decision can leave it split over several nodes) and the
   * older ones.
   */
  private heldCopiesOf(shardId: number): { newest: OwedLeg[]; older: OwedLeg[] } | null {
    const copies = this.owedLegsOf(shardId).filter(c => c.leg.sourceLostAt === undefined && this.awaitsChoice(c.leg));
    if (copies.length === 0) return null;
    const epochOf = (c: OwedLeg): number => c.leg.committed?.epoch ?? c.rec.epoch ?? 0;
    const newest = Math.max(...copies.map(epochOf));
    return { newest: copies.filter(c => epochOf(c) === newest), older: copies.filter(c => epochOf(c) !== newest) };
  }

  /** The shards waiting on the operator's choice, with their newest surviving copy and the nodes holding older ones. */
  heldShards(): HeldShardView[] {
    const nodes = this.hooks.registry.nodes;
    const nameOf = (c: OwedLeg): string => nodes?.get(c.nodeId)?.nodeName ?? c.leg.committed?.sourceName ?? c.nodeId;
    const views: HeldShardView[] = [];
    for (const shardId of new Set(this.pendingSourceCleanups().flatMap(owed => owed.shardIds))) {
      const copies = this.heldCopiesOf(shardId);
      if (!copies) continue;
      const first = copies.newest[0];
      views.push({
        shardId,
        lostNodeName: first.leg.heldForChoice!.lostNodeName,
        heldAt: first.leg.heldForChoice!.at,
        holders: copies.newest.map(c => ({
          nodeId: c.nodeId, nodeName: nameOf(c), connected: nodes?.get(c.nodeId)?.connected === true, draining: nodes?.get(c.nodeId)?.draining === true,
          guilds: c.leg.guilds.length, copyAt: c.leg.committed?.at ?? c.rec.updatedAt,
        })),
        older: [...new Set(copies.older.map(nameOf))],
      });
    }
    return views.sort((a, b) => a.shardId - b.shardId);
  }

  /**
   * How much of its newest copy of a held shard a node still holds: a
   * drain's freeze makes a folder for each of the copy's guilds and a
   * cleanup moves it to the graveyard, so a folder the node still lists is
   * a guild kept; it also says whether a cleanup of them still runs there,
   * and an older node answers without the probe's mark. Null when the node
   * does not answer.
   */
  async heldCopyKept(shardId: number, nodeId: string): Promise<{ kept: number; total: number; cleaning: boolean; probed: boolean } | null> {
    const copies = (this.heldCopiesOf(shardId)?.newest ?? []).filter(c => c.nodeId === nodeId);
    const guilds = new Set(copies.flatMap(c => c.leg.guilds));
    const request: XferInventoryRequest = { term: this.hooks.registry.term, guilds: [...guilds], legIds: copies.map(c => c.leg.legId) };
    let inv: XferInventoryReply | null = null;
    try {
      inv = await this.hooks.sendControl(nodeId, MSG.XFER_INVENTORY, request);
    } catch {
      return null;
    }
    if (!inv?.ok || !Array.isArray(inv.guilds)) return null;
    const listed = new Set(inv.guilds.map(g => g.guildId));
    return { kept: [...guilds].filter(guildId => listed.has(guildId)).length, total: guilds.size, cleaning: inv.cleanupRunning === true, probed: inv.probe === true };
  }

  /**
   * Why a restore of a held shard onto this holder must wait: the migration
   * that left its copy still runs or is paused (the release that lifts the
   * move's freeze waits on it), or a cleanup to that node is in flight.
   */
  restoreBlock(shardId: number, nodeId: string): string | null {
    const live = this.parentRecord ?? this.record;
    const copies = (this.heldCopiesOf(shardId)?.newest ?? []).filter(c => c.nodeId === nodeId);
    if (live !== null && !isTerminal(live.state) && copies.some(c => c.rec.id === live.id)) {
      return `the ${live.kind} that left this copy is still under way; let it finish or abort it, then restore`;
    }
    if (this.cleanupRuns.has(nodeId)) return 'a cleanup on that node is under way; ask again shortly';
    return null;
  }

  /** The operator chose for a held shard: its copies' cleanups run again. Returns the nodes owing them. */
  async releaseHeld(shardId: number): Promise<string[]> {
    const owing = new Set<string>();
    for (const { leg, nodeId } of this.owedLegsOf(shardId)) {
      delete leg.heldForChoice;
      owing.add(nodeId);
    }
    await this.persist();
    return [...owing];
  }

  /** The records a deferred source cleanup lives on: a retire's parent and its running slice, or the active one, and the history. */
  private cleanupRecords(): MigrationRecord[] {
    const records: MigrationRecord[] = [];
    if (this.parentRecord) records.push(this.parentRecord);
    if (this.record && this.record !== this.parentRecord) records.push(this.record);
    for (const h of this.history) records.push(h);
    return records;
  }

  private fenceShards(shardIds: number[]): void {
    for (const id of shardIds) this.migrating.add(id);
  }

  private unfenceShards(shardIds: number[]): void {
    for (const id of shardIds) this.migrating.delete(id);
  }

  /**
   * Boot _incoming resolution verdict for a staged migration id: 'committing'
   * carries the (term, epoch) for the staged rename; 'aborted' when the record
   * is aborting/aborted; 'unknown' when the coordinator has no live record and
   * history shows it finished (staging is stale and safe to delete). Null when
   * the migration is still live in a non-commit state (defer to the broadcast),
   * and until recover() loaded readable records (an unknown then would delete
   * staging the recovered record still commits).
   */
  dispositionOf(migrationId: string): { verdict: 'aborted' | 'unknown' } | { verdict: 'committing'; term: number; epoch: number } | null {
    if (!this.recovered) return null;
    const active = this.parentRecord ?? this.record;
    if (active && active.id === migrationId) {
      if (active.state === 'COMMITTING' || active.state === 'GRANTING') {
        return { verdict: 'committing', term: active.term, epoch: active.epoch ?? this.hooks.registry.epoch };
      }
      if (active.state === 'ABORTING' || active.state === 'ABORTED') return { verdict: 'aborted' };
      return null; // still live pre-commit; the abort/commit broadcast resolves it
    }
    if (this.history.some(h => h.id === migrationId)) {
      const h = this.history.find(r => r.id === migrationId)!;
      if (h.state === 'DONE') return { verdict: 'committing', term: h.term, epoch: h.epoch ?? this.hooks.registry.epoch };
      return { verdict: 'aborted' };
    }
    return { verdict: 'unknown' };
  }

  /** Why no migration, transformation, reshard Resume, transfer, Declare Lost, Assign or Drain may run and no free shard is placed, while the records cannot be read; null otherwise. */
  recordsBlock(): string | null {
    return this.recordsUnreadable ? RECORDS_UNREADABLE : null;
  }

  getView(): MigrationView {
    const historyView = this.history.slice(-MIGRATION_HISTORY_CAP).map(r => ({
      id: r.id, kind: r.kind, state: r.state, error: r.error, updatedAt: r.updatedAt,
    }));
    const heldShards = this.heldShards();
    if (!this.record || isTerminal(this.record.state)) return { active: null, history: historyView, heldShards };
    const legs: MigrationLegView[] = this.record.legs.map(leg => {
      const l = this.live.get(leg.legId);
      return {
        legId: leg.legId,
        shardId: leg.shardId,
        from: leg.sourceNodeId,
        to: leg.targetNodeId,
        guildsDone: l?.guildsDone ?? 0,
        guildsTotal: l?.guildsTotal ?? leg.guilds.length,
        bytesSent: l?.bytesSent ?? 0,
        round: l?.round ?? 0,
        deltaFiles: l?.deltaFiles ?? 0,
        legState: leg.legState,
      };
    });
    const active: MigrationActiveView = {
      id: this.record.id,
      kind: this.record.kind,
      state: this.record.state,
      currentLegIndex: this.record.currentLegIndex,
      legs,
      frozenWriteRejections: this.hooks.frozenWriteRejections(),
      paused: this.paused || undefined,
      error: this.record.error,
    };
    return { active, history: historyView, heldShards };
  }

  // --------------------------------------------------------------------------
  // Precheck (dry-run; never persisted).
  // --------------------------------------------------------------------------
  async precheck(payload: StartPayload): Promise<PrecheckResult> {
    if (payload.kind === 'redistribute') return this.precheckRedistribute();
    const base = this.validateCommon(payload);
    if (!base.ok) return base;
    // Estimate the first leg's size + direction for the confirm dialog.
    const legs = this.buildLegs(payload);
    if ('error' in legs) return { ok: false, error: legs.error };
    if (legs.legs.length === 0) return { ok: false, error: 'no shards to move' };
    const first = legs.legs[0];
    // buildLegs already refused a route-less transfer leg; lease-only legs
    // carry 'none' and need the database up on the master instead of a route.
    const direction = first.direction;
    if (direction === 'none' && !this.hooks.dataBackendHealthy()) {
      return { ok: false, error: 'database unreachable from the master; cannot start a lease-only migration' };
    }
    let estBytes = 0;
    const guilds: string[] = [];
    for (const leg of legs.legs) { for (const g of leg.guilds) guilds.push(g); }
    const warnings: string[] = [];
    // Explicit targets may exceed a node's declared capacity (deliberate
    // operator override - the grant is honored); surface it in the confirm
    // dialog instead of refusing. Net delta per node so a swap (one in, one
    // out) never warns.
    const delta = new Map<string, number>();
    for (const leg of legs.legs) {
      delta.set(leg.targetNodeId, (delta.get(leg.targetNodeId) ?? 0) + 1);
      delta.set(leg.sourceNodeId, (delta.get(leg.sourceNodeId) ?? 0) - 1);
    }
    for (const [nodeId, d] of delta) {
      if (d <= 0) continue;
      const node = this.hooks.registry.nodes.get(nodeId);
      if (!node) continue;
      const cap = Math.max(1, node.capabilities?.shardCapacity ?? 1);
      // Pending-confirmation grants book capacity like held leases do in the
      // placement headroom math.
      let pending = 0;
      for (const p of this.hooks.registry.pendingConfirmation.values()) {
        if (p.nodeId === nodeId) pending += 1;
      }
      const projected = this.hooks.registry.shardIdsOf(nodeId).length + pending + d;
      if (projected > cap) {
        warnings.push(`target ${node.nodeName} will exceed its declared capacity (${projected}/${cap})`);
      }
    }
    return { ok: true, estBytes, direction, guilds, warnings };
  }

  private validateCommon(payload: StartPayload): PrecheckResult {
    if (this.recordsUnreadable) return { ok: false, error: RECORDS_UNREADABLE };
    if (this.hooks.isPaused() && payload.kind !== 'redistribute') {
      return { ok: false, error: 'reshard pause active; only Redistribute runs during the pause' };
    }
    if (this.hooks.transformationActive?.()) {
      return { ok: false, error: 'a backend transformation is active; migrations are locked until it finishes' };
    }
    if (this.hasActive()) return { ok: false, error: 'migration-in-progress' };
    return { ok: true };
  }

  // --------------------------------------------------------------------------
  // Start.
  // --------------------------------------------------------------------------
  async start(payload: StartPayload): Promise<{ ok: boolean; error?: string; migrationId?: string }> {
    const common = this.validateCommon(payload);
    if (!common.ok) return { ok: false, error: common.error };

    if (payload.kind === 'redistribute') return this.startRedistribute();

    const built = this.buildLegs(payload);
    if ('error' in built) return { ok: false, error: built.error };
    if (built.legs.length === 0) return { ok: false, error: 'no shards to move' };

    // PRECHECK gate: connectivity, health, ownership, route (or DB probe).
    for (const leg of built.legs) {
      const gate = this.precheckLeg(leg);
      if (!gate.ok) return { ok: false, error: gate.error };
    }

    const rec: MigrationRecord = {
      id: randomUUID(),
      kind: payload.kind,
      legs: built.legs,
      state: 'PREPARING',
      term: this.hooks.registry.term,
      shardCount: this.hooks.registry.shardCount,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    if (payload.kind === 'retire') { rec.currentLegIndex = 0; rec.state = 'PRECHECK'; }
    this.record = rec;
    this.paused = false;

    if (payload.kind === 'retire') {
      // Legs run sequentially, each a full independent Move.
      void this.runRetire();
      return { ok: true, migrationId: rec.id };
    }

    this.hydrateLive(rec);
    await this.persist();
    void this.enterPreparing();
    return { ok: true, migrationId: rec.id };
  }

  async abort(migrationId: string, wholeRetire = false): Promise<{ ok: boolean; error?: string }> {
    if (!this.record || this.record.id !== migrationId) return { ok: false, error: 'no such active migration' };
    if (this.record.state === 'COMMITTING' || this.record.state === 'GRANTING') {
      return { ok: false, error: 'commit already decided' };
    }
    if (this.record.kind === 'retire' && this.paused) {
      // Abort-remaining: mark done; completed legs stand.
      await this.finish('ABORTED', 'retire aborted; completed legs stand');
      return { ok: true };
    }
    if (wholeRetire && this.parentRecord && this.parentRecord.kind === 'retire') this.abortWholeRetire = true;
    await this.enterAborting('operator abort');
    return { ok: true };
  }

  /**
   * The active retire read across its single-leg slices (B4f-4: the planned
   * transfer follows the master's retire of itself): the parent record's
   * legs and pause, the running leg's state.
   */
  activeRetire(): { id: string; state: string; paused: boolean; legs: { shardId: number; from: string; to: string; done: boolean }[]; currentLegIndex: number; error?: string } | null {
    const parent = this.parentRecord ?? this.record;
    if (!parent || parent.kind !== 'retire' || isTerminal(parent.state)) return null;
    const running = this.record && this.record !== parent ? this.record : null;
    const error = running?.error ?? parent.error;
    return {
      id: parent.id,
      state: running ? running.state : parent.state,
      paused: this.paused,
      legs: parent.legs.map(l => ({ shardId: l.shardId, from: l.sourceNodeId, to: l.targetNodeId, done: l.legState === 'DONE' })),
      currentLegIndex: parent.currentLegIndex ?? 0,
      ...(error ? { error } : {}),
    };
  }

  async resume(migrationId: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.record || this.record.id !== migrationId) return { ok: false, error: 'no such active migration' };
    if (this.record.kind !== 'retire' || !this.paused) return { ok: false, error: 'not a paused retire' };
    this.paused = false;
    this.record.error = undefined;
    void this.runRetire();
    return { ok: true };
  }

  // --------------------------------------------------------------------------
  // Control-frame hooks (from controlServer switch, or master self-routing).
  // --------------------------------------------------------------------------
  onProgress(fromNodeId: string, payload: XferProgressPayload): void {
    if (!this.record || this.record.id !== payload.migrationId) return;
    const l = this.live.get(payload.legId);
    if (!l) return;
    // Authenticate the sender: only the leg's own source or target may report
    // progress/error on it, so a non-participant cannot force-abort the leg or
    // fake convergence on a leg it does not own.
    if (fromNodeId !== l.leg.sourceNodeId && fromNodeId !== l.leg.targetNodeId) return;
    l.round = payload.round;
    l.bytesSent += payload.bytesSent;
    l.deltaFiles = payload.deltaFiles;
    l.guildsDone = payload.guildsDone;
    l.lastProgressAt = performance.now();
    if (payload.error) {
      // Same commit-decided fence as abort()/onNodeDown: once COMMITTING or
      // GRANTING, a late transfer error must not abort (retries continue at
      // reconnect). A paused retire has no leg in flight either.
      if (this.record.state === 'COMMITTING' || this.record.state === 'GRANTING') return;
      if (this.record.kind === 'retire' && this.paused) return;
      l.error = payload.error;
      void this.enterAborting(`progress error on leg ${payload.legId}: ${payload.error}`);
      return;
    }
    this.throttledPush();
  }

  onVerify(fromNodeId: string, payload: XferVerifyPayload): void {
    if (!this.record || this.record.id !== payload.migrationId) return;
    if (this.record.state !== 'DRAINING' && this.record.state !== 'VERIFYING') return;
    const l = this.live.get(payload.legId);
    if (!l) return;
    // Authenticate the sender against the side it claims: the source-verify must
    // come from the leg's sourceNodeId and the target-verify from targetNodeId.
    // Without this a compromised source could forge the target-verify with a
    // matching hash and pass the joint-commit barrier over empty/partial staging.
    if (payload.side === 'source') {
      if (fromNodeId !== l.leg.sourceNodeId) return;
      l.sourceVerify = payload;
    } else {
      if (fromNodeId !== l.leg.targetNodeId) return;
      l.targetVerify = payload;
    }
    this.maybeAllVerified();
  }

  /** Lease-only drain confirmation (replaces the dual-hash verify). */
  onFlushed(fromNodeId: string, payload: XferFlushedPayload): void {
    if (!this.record || this.record.id !== payload.migrationId) return;
    if (this.record.state !== 'DRAINING' && this.record.state !== 'VERIFYING') return;
    if (payload.term !== this.record.term) return;
    const l = this.live.get(payload.legId);
    if (!l) return;
    // Only the leg's own source drains; anyone else cannot confirm its flush.
    if (fromNodeId !== l.leg.sourceNodeId) return;
    l.flushed = payload;
    this.maybeAllFlushed();
  }

  private maybeAllFlushed(): void {
    if (!this.record || this.record.state !== 'DRAINING' || !this.recordIsLeaseOnly()) return;
    const all = this.record.legs.every(leg => this.live.get(leg.legId)?.flushed);
    if (all) void this.enterVerifying();
  }

  onNodeDown(nodeId: string): void {
    if (!this.record || isTerminal(this.record.state)) return;
    // A paused retire has no leg in flight; nothing to abort. The pause holds
    // and Resume's precheck rejects a still-down participant.
    if (this.record.kind === 'retire' && this.paused) return;
    if (!this.record.legs.some(leg => leg.sourceNodeId === nodeId || leg.targetNodeId === nodeId)) return;
    // A down TARGET blocks the commit (its data is the product); a down SOURCE
    // before commit aborts safely (originals intact). Pre-commit: abort.
    if (this.record.state === 'COMMITTING' || this.record.state === 'GRANTING') {
      // Commit already decided; retries continue at reconnect (do not abort).
      return;
    }
    this.hooks.onNodeDownDuringMigration?.(nodeId);
    void this.enterAborting(`participant ${nodeId} went down mid-migration`);
  }

  // --------------------------------------------------------------------------
  // State transitions.
  // --------------------------------------------------------------------------
  private async transition(state: MigrationState): Promise<void> {
    if (!this.record) return;
    this.record.state = state;
    this.record.updatedAt = Date.now();
    // Retire: mirror the running leg's state onto the persisted parent record so
    // crash recovery sees the current leg's phase (parent.state) and per-leg
    // progress (legState). Completed legs keep their DONE legState.
    if (this.parentRecord) {
      const idx = this.parentRecord.currentLegIndex ?? 0;
      this.parentRecord.state = state;
      if (this.parentRecord.legs[idx]) this.parentRecord.legs[idx].legState = state;
      this.parentRecord.epoch = this.record.epoch;
      this.parentRecord.updatedAt = Date.now();
    }
    await this.persist();
    this.hooks.pushStatus();
  }

  private async enterPreparing(): Promise<void> {
    if (!this.record) return;
    await this.transition('PREPARING');
    const leaseOnly = this.recordIsLeaseOnly();
    try {
      const acks = await this.sendPrepareToAll();
      for (const [nodeId, ack] of acks) {
        if (!ack.ok) throw new Error(`prepare nack from ${nodeId}: ${ack.reason ?? 'unknown'}`);
      }
      if (!leaseOnly) {
        // Space check: every target's free space must exceed the total source
        // estimate * margin + cushion (statfs "unknown" is tolerated - no gate).
        const totalEst = [...acks.values()].reduce((s, a) => s + (a.estBytes ?? 0), 0);
        const needed = totalEst * SPACE_MARGIN + SPACE_CUSHION_BYTES;
        for (const [nodeId, ack] of acks) {
          if (ack.freeBytes !== undefined && ack.freeBytes < needed) {
            throw new Error(`target ${nodeId} lacks space (free ${ack.freeBytes}, need ~${Math.round(needed)})`);
          }
        }
      }
      // Lease-only: no copy rounds exist; the drain is the whole data phase.
      await (leaseOnly ? this.enterDraining() : this.enterCopying());
    } catch (error) {
      await this.enterAborting(error instanceof Error ? error.message : String(error));
    }
  }

  /** True when every leg is a lease-only hand-off (data lives in the central DB). */
  private recordIsLeaseOnly(): boolean {
    return this.record != null && this.record.legs.length > 0 && this.record.legs.every(l => l.direction === 'none');
  }

  private legIsLeaseOnly(guilds: string[]): boolean {
    // No per-guild routing overrides exist yet (Stage 4); the first guild's
    // route answers for the shard, '0' probes the deployment default.
    return routeFor(guilds[0] ?? '0') === 'postgres';
  }

  private async enterCopying(): Promise<void> {
    await this.transition('COPYING');
    this.armStallWatchdog();
    // The source executors are already streaming (prepare kicked off round 0).
    // Convergence is detected source-side; the coordinator drives the drain once
    // sources have shipped their converged delta. We conservatively move to
    // drain after a short settle so serve-while-copying keeps running until the
    // operator or convergence triggers it. Here convergence is signalled by the
    // source's low-delta rounds; drive drain on the stall/settle tick.
    this.scheduleDrainWhenConverged();
  }

  private scheduleDrainWhenConverged(): void {
    // Poll live progress: when every source leg has done at least one delta
    // round at/under the threshold (executor breaks its loop), proceed to drain.
    const tick = setInterval(() => {
      if (!this.record || this.record.state !== 'COPYING') { clearInterval(tick); return; }
      const converged = this.record.legs.every(leg => {
        const l = this.live.get(leg.legId);
        return l && l.round >= 1 && l.deltaFiles <= XFER_DELTA_THRESHOLD_FILES;
      });
      if (converged) {
        clearInterval(tick);
        void this.enterDraining();
      }
    }, 1000);
    tick.unref();
  }

  private async enterDraining(): Promise<void> {
    if (!this.record) return;
    this.drainRan = true;
    for (const leg of this.record.legs) leg.drained = true;
    await this.transition('DRAINING');
    this.armDrainTimeout();
    try {
      // Per source leg, in order: revoke the moving lease (bounded gap starts),
      // then XFER_DRAIN so the source freezes + flushes + ships the final delta
      // + hashes + verifies. Swap: both legs drain concurrently (verify set).
      const byNode = new Map<string, MigrationLeg[]>();
      for (const leg of this.record.legs) {
        const arr = byNode.get(leg.sourceNodeId) ?? [];
        arr.push(leg);
        byNode.set(leg.sourceNodeId, arr);
      }
      for (const [sourceNodeId, legs] of byNode) {
        const shardIds = legs.map(l => l.shardId);
        // Fence the moving shards OFF the free pool for the whole in-flight
        // window BEFORE removing them from the table: the background distribute()
        // (self-heartbeat tick, onDisconnect, afterRegister) must never see a
        // drained shard as free and re-grant it (double-ownership / dual-identify).
        this.fenceShards(shardIds);
        // Revoke the moving leases from the source, mirroring the operator-drain
        // interlock: the lease-id union (table + pending + heldLeases + last
        // renew + drain-raced grants) so an adoption-invented table leaseId
        // alone cannot make the revoke a no-op. The source's real sessions MUST
        // be provably destroyed before the target ever identifies.
        const leaseIds = this.hooks.drainLeaseIdsForShards(sourceNodeId, shardIds);
        if (leaseIds.length > 0) {
          const ok = await this.confirmRevoke(sourceNodeId, leaseIds);
          if (!ok) {
            await this.enterAborting(`drain revoke to ${sourceNodeId} not confirmed`);
            return;
          }
        }
        // Free the shards in the table so the later grant re-assigns them; the
        // fence keeps them off the free pool until GRANTING (or abort rollback).
        for (const leg of legs) this.hooks.registry.shardTable.delete(leg.shardId);
        await this.hooks.sendControl(sourceNodeId, MSG.XFER_DRAIN, {
          migrationId: this.record.id,
          term: this.record.term,
          legIds: legs.map(l => l.legId),
        });
      }
    } catch (error) {
      await this.enterAborting(error instanceof Error ? error.message : String(error));
    }
  }

  // Bounded revoke with confirmation (mirrors masterDrainNode's retry loop):
  // the source's sessions must be provably destroyed before the target ever
  // identifies. A lost/no-op revoke returns ok:false, so we retry a few rounds
  // (recomputing the lease-id union each time so a mid-drain grant is caught)
  // before giving up so the caller can abort.
  private async confirmRevoke(sourceNodeId: string, initialLeaseIds: string[]): Promise<boolean> {
    let leaseIds = initialLeaseIds;
    for (let round = 0; round < 3; round++) {
      const shardIds = [...this.migrating];
      const { ok } = await this.hooks.revokeLease(sourceNodeId, leaseIds, `migration ${this.record?.id ?? ''} drain`);
      if (ok) return true;
      // Recompute the union: a grant that settled mid-drain adds new lease ids.
      leaseIds = this.hooks.drainLeaseIdsForShards(sourceNodeId, shardIds);
      if (leaseIds.length === 0) return true;
    }
    return false;
  }

  private recordPendingSourceLeg(rec: MigrationRecord, nodeId: string, legId: string): void {
    const list = rec.pendingSourceCleanup ?? (rec.pendingSourceCleanup = []);
    let entry = list.find(e => e.nodeId === nodeId);
    if (!entry) { entry = { nodeId, legIds: [] }; list.push(entry); }
    if (!entry.legIds.includes(legId)) entry.legIds.push(legId);
    this.keepOwingKnown(nodeId, rec.legs.find(l => l.legId === legId));
  }

  // A node owing a note it was not Declared Lost for stays known (not
  // connected) though it holds no lease, so the Fleet tab lists it, Declare
  // Lost can settle it and the planned transfer's refusal finds it.
  private keepOwingKnown(nodeId: string, leg: MigrationLeg | undefined): void {
    const registry = this.hooks.registry;
    if (!leg || leg.sourceLostAt !== undefined || nodeId === this.hooks.selfNodeId || registry.nodes.has(nodeId)) return;
    registry.restoreNode({ nodeId, nodeName: leg.committed?.sourceName ?? nodeId, appVersion: '', capabilities: { shardCapacity: 1, dataBackend: 'unknown' } });
  }

  private clearPendingSourceLeg(rec: MigrationRecord, nodeId: string, legId: string): void {
    if (!rec.pendingSourceCleanup) return;
    for (const entry of rec.pendingSourceCleanup) {
      if (entry.nodeId !== nodeId) continue;
      entry.legIds = entry.legIds.filter(id => id !== legId);
    }
    rec.pendingSourceCleanup = rec.pendingSourceCleanup.filter(e => e.legIds.length > 0);
    if (rec.pendingSourceCleanup.length === 0) rec.pendingSourceCleanup = undefined;
  }

  /**
   * An aborted record's abort its nodes have not had yet (one a promote's
   * pin ended): sent to each that answers, this master's own executor
   * included, after the recovery and at the node's register, until acked.
   */
  async deliverOwedAborts(nodeId?: string): Promise<void> {
    let changed = false;
    for (const rec of this.history) {
      for (const owed of [...(rec.abortUndelivered ?? [])]) {
        if (nodeId !== undefined && owed !== nodeId) continue;
        if (owed !== this.hooks.selfNodeId && !this.hooks.registry.nodes?.get(owed)?.connected) continue;
        try {
          const ack = await this.hooks.sendControl(owed, MSG.XFER_ABORT, { migrationId: rec.id, term: rec.term, reason: rec.error ?? 'aborted' });
          if (!ack?.ok) continue;
          rec.abortUndelivered = (rec.abortUndelivered ?? []).filter(id => id !== owed);
          if (rec.abortUndelivered.length === 0) delete rec.abortUndelivered;
          changed = true;
        } catch {
          // Unanswered: asked again at its register.
        }
      }
    }
    if (changed) await this.persist();
  }

  /**
   * A source that missed its cleanup at COMMITTING (down then, or its commit
   * outran the ack): re-send the idempotent XFER_COMMIT so its originals are
   * graveyarded. Scans the records a cleanup lives on (cleanupRecords) for this
   * node's owed legs. Called at the node's register, by the retry tick while it
   * stays connected and owing, by a planned transfer's refusal, and for the
   * master's own debt after its recovery.
   */
  retrySourceCleanup(nodeId: string): Promise<void> {
    // One at a time per node (a register's and a transfer refusal's would
    // race one entry): each runs after the one before it settles.
    const run = (this.cleanupRuns.get(nodeId) ?? Promise.resolve()).then(() => this.runSourceCleanup(nodeId)).finally(() => this.rearmCleanup(nodeId));
    const settled: Promise<void> = run.catch(() => undefined).then(() => {
      if (this.cleanupRuns.get(nodeId) === settled) this.cleanupRuns.delete(nodeId);
    });
    this.cleanupRuns.set(nodeId, settled);
    return run;
  }

  private readonly cleanupRuns = new Map<string, Promise<void>>();
  private readonly releaseWarned = new Set<string>();

  private async runSourceCleanup(nodeId: string): Promise<void> {
    const records = this.cleanupRecords();
    let changed = false;
    for (const rec of records) {
      const entry = rec.pendingSourceCleanup?.find(e => e.nodeId === nodeId);
      if (!entry || entry.legIds.length === 0) continue;
      // A note from before a reshard names no current shard: only its
      // cleanup by guild ids runs.
      const current = this.ofCurrentCount(rec);
      // Only the legs this pass settles leave the entry: one recorded
      // meanwhile (by a commit round, while a send here was awaited) stays.
      const cleared = new Set<string>();
      for (const legId of entry.legIds) {
        // Thread the leg's guilds + the source-cleanup marker so a RESTARTED
        // source (empty in-memory legs Map, no _incoming staging) can still run
        // its graveyard + unfreeze from the payload. onCommit acks ok ONLY when
        // that source cleanup genuinely completed, so a bare no-op cannot clear
        // the leg here (it stays pending and is retried).
        const leg = rec.legs.find(l => l.legId === legId);
        if (!leg) {
          // No leg in the record to name the guilds: cannot verify the cleanup,
          // so keep it pending rather than clearing it on a guild-less no-op.
          continue;
        }
        // A migration fences the shard, or a grant of it to this node awaits
        // confirmation: what the node holds may be what that brought back, so
        // the cleanup stays owed, unsent, until the shard settles.
        if (current && (this.migrating.has(leg.shardId) || this.hooks.registry.pendingConfirmation?.get(leg.shardId)?.nodeId === nodeId)) continue;
        // Maybe the last copy of a shard a Declare Lost left unplaced: kept
        // until the operator restores it or starts the shard empty.
        if (current && this.awaitsChoice(leg)) continue;
        // Ownership guard: the shard is back on this same source, so in file
        // mode its originals are the live copies again and graveyarding them
        // would serve the guilds empty. The source is released instead: the
        // abort a source takes keeps them and lifts its drain's freeze. It waits
        // while a transformation runs (its own freeze) and while that
        // migration still runs, since the node's abort is migration-wide and
        // would stop a later leg of the same retire there.
        const back = current && this.hooks.registry.shardTable.get(leg.shardId)?.nodeId === nodeId;
        const live = this.parentRecord ?? this.record;
        if (back && (this.hooks.transformationActive?.() || (live !== null && live.id === rec.id && !isTerminal(live.state)))) continue;
        try {
          const ack = back
            ? await this.hooks.sendControl(nodeId, MSG.XFER_ABORT, {
              migrationId: rec.id, term: rec.term, reason: `shard ${leg.shardId} is back on its source`, guilds: leg.guilds, legIds: [legId],
            })
            : await this.hooks.sendControl(nodeId, MSG.XFER_COMMIT, {
              migrationId: rec.id, term: rec.term, epoch: rec.epoch ?? this.hooks.registry.epoch,
              legIds: [legId], sourceCleanup: true, guilds: leg.guilds,
            });
          // A release counts only when the node reports the freeze and any
          // armed graveyard gone (an older executor does not report it).
          if (ack?.ok && (!back || ack.released === true)) {
            if (!back && current && this.awaitsChoice(leg)) {
              console.warn(`[Migration] Shard ${leg.shardId}: the copy on ${this.hooks.registry.nodes?.get(nodeId)?.nodeName ?? nodeId} went to its graveyard by a cleanup sent before the shard's node was declared lost, so it is not offered`);
            }
            cleared.add(legId);
            this.releaseWarned.delete(legId);
          } else if (back && ack?.ok && !this.releaseWarned.has(legId)) {
            this.releaseWarned.add(legId);
            console.warn(`[Migration] Shard ${leg.shardId} is back on ${this.hooks.registry.nodes?.get(nodeId)?.nodeName ?? nodeId}, whose release from its owed cleanup is not complete (${ack.reason ?? 'it reports none; it may run an older version'}); retried every ${Math.round(XFER_COMMIT_RETRY_MS / 1000)}s`);
          }
        } catch {
          // Unanswered: still owed, and asked again.
        }
      }
      entry.legIds = entry.legIds.filter(id => !cleared.has(id));
      rec.pendingSourceCleanup = (rec.pendingSourceCleanup ?? []).filter(e => e.legIds.length > 0);
      if (rec.pendingSourceCleanup.length === 0) rec.pendingSourceCleanup = undefined;
      if (cleared.size > 0) changed = true;
    }
    if (changed) await this.persist();
  }

  // Still owed by a node that is connected (answered not done while its
  // commit ran, held while the shard settles, or the ask failed or threw):
  // asked again after a retry tick.
  private rearmCleanup(nodeId: string): void {
    if (this.owesUnheld(nodeId) && this.hooks.registry.nodes?.get(nodeId)?.connected) this.scheduleCleanupRetry(nodeId);
  }

  /** A cleanup the node owes that does not wait on the operator's choice (the choice asks the held ones again). */
  private owesUnheld(nodeId: string): boolean {
    return this.cleanupRecords().some(rec => (rec.pendingSourceCleanup ?? []).some(entry => entry.nodeId === nodeId
      && entry.legIds.some(legId => {
        const leg = rec.legs.find(l => l.legId === legId);
        return !leg || !this.ofCurrentCount(rec) || !this.awaitsChoice(leg);
      })));
  }

  private readonly cleanupTimers = new Map<string, NodeJS.Timeout>();

  private scheduleCleanupRetry(nodeId: string): void {
    if (this.cleanupTimers.has(nodeId)) return;
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(nodeId);
      void this.retrySourceCleanup(nodeId).catch(() => undefined);
    }, XFER_COMMIT_RETRY_MS);
    timer.unref();
    this.cleanupTimers.set(nodeId, timer);
  }

  private maybeAllVerified(): void {
    if (!this.record || (this.record.state !== 'DRAINING' && this.record.state !== 'VERIFYING')) return;
    const all = this.record.legs.every(leg => {
      const l = this.live.get(leg.legId);
      return l?.sourceVerify && l?.targetVerify;
    });
    if (all) void this.enterVerifying();
  }

  private async enterVerifying(): Promise<void> {
    if (!this.record) return;
    this.clearDrainTimeout();
    await this.transition('VERIFYING');
    if (this.recordIsLeaseOnly()) {
      // Verify = drain confirmation: every source flushed everything durable
      // into the database (data-commit strictly before the gateway swap).
      for (const leg of this.record.legs) {
        const f = this.live.get(leg.legId)?.flushed;
        if (!f || !f.ok || f.pendingOps > 0 || f.flushFailures > 0) {
          await this.enterAborting(`drain flush not confirmed on leg ${leg.legId}${f?.reason ? `: ${f.reason}` : ''}`);
          return;
        }
      }
    } else {
      for (const leg of this.record.legs) {
        const l = this.live.get(leg.legId)!;
        if (!l.sourceVerify || !l.targetVerify || l.sourceVerify.hash !== l.targetVerify.hash) {
          // Per-guild diff logged on mismatch.
          this.logHashDiff(leg, l);
          await this.enterAborting(`hash mismatch on leg ${leg.legId}`);
          return;
        }
      }
    }
    // The plan on disk stops naming each drained source before the decision
    // is written, so no boot hands a committed shard back to its source,
    // its records readable or not.
    const rec = this.record;
    let failed: string | null = null;
    try {
      await this.hooks.persistPlan();
    } catch (error) {
      failed = error instanceof Error ? error.message : String(error);
    }
    // An abort that landed meanwhile stands.
    if (this.record !== rec || rec.state !== 'VERIFYING' || this.abortInProgress) return;
    if (failed !== null) {
      await this.enterAborting(`the plan could not be written before the commit decision: ${failed}`);
      return;
    }
    // All match: bump the epoch, persist COMMITTING BEFORE the first commit.
    this.hooks.registry.epoch += 1;
    this.record.epoch = this.hooks.registry.epoch;
    const committedAt = Date.now();
    for (const leg of this.record.legs) {
      leg.committed = { epoch: this.record.epoch, at: committedAt, sourceName: this.hooks.registry.nodes?.get(leg.sourceNodeId)?.nodeName ?? leg.sourceNodeId };
    }
    await this.enterCommitting(false);
  }

  private logHashDiff(leg: MigrationLeg, l: LegLive): void {
    const src = l.sourceVerify?.guildHashes ?? {};
    const tgt = l.targetVerify?.guildHashes ?? {};
    for (const guildId of leg.guilds) {
      if (src[guildId] !== tgt[guildId]) {
        console.warn(`[Migration] Hash diff on leg ${leg.legId} guild ${guildId}: source ${src[guildId] ?? '(missing)'} vs target ${tgt[guildId] ?? '(missing)'}`);
      }
    }
  }

  // COMMITTING: the record is already on disk (transition persisted it) - that
  // IS the joint-commit barrier. Commit targets first (their staging is the
  // product), then sources (graveyard originals). All idempotent + retried.
  private async enterCommitting(resuming: boolean): Promise<void> {
    if (!this.record) return;
    if (!resuming) await this.transition('COMMITTING');
    else this.hooks.pushStatus();
    this.runCommitRound();
    if (!this.commitTimer) {
      this.commitTimer = setInterval(() => this.runCommitRound(), XFER_COMMIT_RETRY_MS);
      this.commitTimer.unref();
    }
  }

  private runCommitRound(): void {
    if (!this.record || this.record.state !== 'COMMITTING') { this.clearCommitTimer(); return; }
    // One round per record at a time: a round outliving the retry tick (a
    // slow commit) would ack beside the next, and both would enter GRANTING.
    const rec = this.record;
    if (this.commitRoundFor === rec) return;
    this.commitRoundFor = rec;
    void this.commitRound(rec).finally(() => { if (this.commitRoundFor === rec) this.commitRoundFor = null; });
  }

  private commitRoundFor: MigrationRecord | null = null;

  private async commitRound(rec: MigrationRecord): Promise<void> {
    let allTargets = true;
    let allSources = true;
    // Targets first.
    for (const leg of rec.legs) {
      if ((leg as any)._targetAcked) continue;
      try {
        const ack = await this.hooks.sendControl(leg.targetNodeId, MSG.XFER_COMMIT, {
          migrationId: rec.id, term: rec.term, epoch: rec.epoch ?? this.hooks.registry.epoch, legIds: [leg.legId],
        });
        if (ack?.ok) (leg as any)._targetAcked = true;
        else allTargets = false;
      } catch {
        // A down TARGET blocks here (its data is the product); retry next tick.
        allTargets = false;
      }
    }
    if (!allTargets) return; // wait for the next retry; targets must all ack
    // Sources next (graveyard originals). A down source does not block: it is
    // recorded durably as pendingSourceCleanup and retried when it reconnects.
    for (const leg of rec.legs) {
      if ((leg as any)._sourceAcked) continue;
      try {
        const ack = await this.hooks.sendControl(leg.sourceNodeId, MSG.XFER_COMMIT, {
          migrationId: rec.id, term: rec.term, epoch: rec.epoch ?? this.hooks.registry.epoch,
          legIds: [leg.legId], sourceCleanup: true, guilds: leg.guilds,
        });
        if (ack?.ok) {
          (leg as any)._sourceAcked = true;
          this.clearPendingSourceLeg(rec, leg.sourceNodeId, leg.legId);
          if (this.parentRecord && this.parentRecord !== rec) this.clearPendingSourceLeg(this.parentRecord, leg.sourceNodeId, leg.legId);
        }
        else allSources = false;
      } catch {
        // Down source: record pendingSourceCleanup durably (survives the move
        // to history), retried at reconnect; fencing keeps it from serving
        // meanwhile. Do NOT block the grant.
        (leg as any)._sourcePending = true;
        this.recordPendingSourceLeg(rec, leg.sourceNodeId, leg.legId);
        // A retire's slice is not what persist writes: its parent carries it too.
        if (this.parentRecord && this.parentRecord !== rec) this.recordPendingSourceLeg(this.parentRecord, leg.sourceNodeId, leg.legId);
        // A source still connected (its commit outran the ack) has no
        // reconnect to retry it: it is asked again after a retry tick.
        if (this.hooks.registry.nodes?.get(leg.sourceNodeId)?.connected) this.scheduleCleanupRetry(leg.sourceNodeId);
      }
    }
    const sourcesSettled = rec.legs.every(l => (l as any)._sourceAcked || (l as any)._sourcePending);
    if (allTargets && sourcesSettled) {
      this.clearCommitTimer();
      if ((rec.pendingSourceCleanup?.length ?? 0) > 0) await this.persist();
      void this.enterGranting();
    }
    void allSources;
  }

  // GRANTING: data commit is done - now the gateway swap. Grant the moved
  // shard(s) to the new owners via the metered grant path; Swap ordered
  // remote-first/self-last per execOrder; identifies metered by the ledger.
  private async enterGranting(): Promise<void> {
    // One pass per record at a time: the grant retry tick or a second entry
    // must not run beside a slow pass, or both would finish the migration.
    const rec = this.record;
    if (!rec || this.grantingFor === rec) return;
    this.grantingFor = rec;
    try {
      await this.runGranting();
    } finally {
      if (this.grantingFor === rec) this.grantingFor = null;
    }
  }

  private grantingFor: MigrationRecord | null = null;

  private async runGranting(): Promise<void> {
    if (!this.record) return;
    // Redistribute is data-only and pause-time: nothing serves, so it never
    // grants here. Data is placed (COMMITTING done); the operator's Resume
    // (PLAN_P1) grants exactly the proposal. End the migration DONE.
    if (this.record.kind === 'redistribute') {
      if (this.record.state !== 'GRANTING') await this.transition('GRANTING');
      // The full proposal was persisted at startRedistribute; persistProposal
      // MERGES the moved-shard targets onto the durable on-disk proposal (never
      // clobbers the unmoved-shard entries), so after a crash recovery (where
      // this.proposal is empty) Resume still grants EXACTLY the full proposal.
      await this.persistProposal();
      await this.finish('DONE');
      return;
    }
    // The retry timer re-enters here while already GRANTING; only persist the
    // transition on the first entry (from COMMITTING or crash recovery).
    if (this.record.state !== 'GRANTING') await this.transition('GRANTING');
    const rec = this.record;
    const byTarget = new Map<string, number[]>();
    for (const leg of rec.legs) {
      if (leg.targetLostAt !== undefined) continue;
      const arr = byTarget.get(leg.targetNodeId) ?? [];
      arr.push(leg.shardId);
      byTarget.set(leg.targetNodeId, arr);
    }
    const order = [...byTarget.keys()].sort((a, b) => {
      const aSelf = this.hooks.isSelf(a) ? 1 : 0;
      const bSelf = this.hooks.isSelf(b) ? 1 : 0;
      return aSelf - bSelf;
    });
    // Re-stamp when a concurrent grant round advanced the epoch past the
    // commit-time stamp: re-sending the stale stamp is refused forever, and
    // merely matching the newer epoch would TIE with that round's in-flight
    // grants (equal epochs are last-writer-wins on the node). A fresh bump
    // makes this round strictly dominant; stamping it back on the record keeps
    // retries and crash recovery ordered.
    let epoch = rec.epoch ?? this.hooks.registry.epoch;
    if (this.hooks.registry.epoch > epoch) {
      this.hooks.registry.epoch += 1;
      epoch = this.hooks.registry.epoch;
      rec.epoch = epoch;
      if (this.parentRecord) this.parentRecord.epoch = epoch;
      await this.persist();
    }
    // The data is committed to each target; the grant is safe + idempotent to
    // retry. A hard grant refusal (ledger floor, target draining) must NEVER
    // finish DONE with the shard stranded off the free pool it would fall into,
    // so the migrating fence is held until every target's grant lands and the
    // grant is retried on a timer. An unacked grant lands only where the
    // table records the target's lease for each moved shard (the hook holds a
    // target not connected its stamps as its frozen leases): a connected
    // target's stamp is freed by its first heartbeat without the shard.
    let allGranted = true;
    for (const targetNodeId of order) {
      const moved = byTarget.get(targetNodeId) ?? [];
      const fullSet = [...new Set([...this.hooks.registry.shardIdsOf(targetNodeId), ...moved])].sort((a, b) => a - b);
      const res = await this.hooks.grantShardsTo(targetNodeId, fullSet, epoch);
      const held = res.pending && moved.every(shardId => this.hooks.registry.shardTable.get(shardId)?.nodeId === targetNodeId);
      if (!res.ok && !held) allGranted = false;
    }
    await this.hooks.persistPlan();
    if (!allGranted) {
      // Keep the migration in GRANTING (fence held) and retry the grant round;
      // do NOT finish DONE with a committed-but-ungranted shard in limbo.
      this.scheduleGrantRetry();
      return;
    }
    this.clearGrantRetry();
    // All targets granted (or held as their leases): release the fence.
    this.unfenceShards(rec.legs.map(l => l.shardId));
    await this.finish('DONE');
  }

  private grantTimer: NodeJS.Timeout | null = null;
  private scheduleGrantRetry(): void {
    if (this.grantTimer) return;
    this.grantTimer = setInterval(() => {
      if (!this.record || this.record.state !== 'GRANTING') { this.clearGrantRetry(); return; }
      void this.enterGranting();
    }, XFER_COMMIT_RETRY_MS);
    this.grantTimer.unref();
  }

  private clearGrantRetry(): void {
    if (this.grantTimer) { clearInterval(this.grantTimer); this.grantTimer = null; }
  }

  // ABORTING: XFER_ABORT to both sides (idempotent, retried while connected);
  // if the drain revoked the lease, re-grant the shard back to the source.
  // Guarded by an in-progress flag, not a state check: a second trigger firing
  // during the first abort's awaits (trailing error frame, duplicate node-down)
  // would otherwise finish() again after finishHooks restored the retire
  // parent, terminally aborting a pausable retire. recoverRetire legitimately
  // re-enters with a leg already persisted as ABORTING, which a bare state
  // check would break.
  private abortInProgress = false;
  private async enterAborting(reason: string): Promise<void> {
    if (!this.record || this.abortInProgress) return;
    // A paused retire has no leg in flight: a pipeline straggler from the
    // aborted leg (timed-out prepare/drain rejection landing after the pause)
    // must not terminally abort it. Operator Abort-remaining goes via abort().
    if (this.record.kind === 'retire' && this.paused) return;
    this.abortInProgress = true;
    try {
      await this.enterAbortingImpl(reason);
    } finally {
      this.abortInProgress = false;
    }
  }

  private async enterAbortingImpl(reason: string): Promise<void> {
    if (!this.record) return;
    this.clearStallWatchdog();
    this.clearDrainTimeout();
    this.clearCommitTimer();
    this.clearGrantRetry();
    this.record.error = reason;
    // A redistribute abort invalidates the persisted proposal: Resume must not
    // grant a proposal whose data placement did not complete.
    if (this.record.kind === 'redistribute') await this.hooks.saveRedistributeProposal(null);
    await this.transition('ABORTING');
    console.warn(`[Migration] Aborting ${this.record.id}: ${reason}`);
    const rec = this.record;
    // Committed legs stand: their data lives on the target and the source's
    // copy is graveyarded, so rolling them back would serve stale/empty state.
    // Only legs that did not reach DONE participate in the abort rollback.
    const abortLegs = rec.legs.filter(l => l.legState !== 'DONE');
    const nodes = new Set<string>();
    for (const leg of abortLegs) { nodes.add(leg.sourceNodeId); nodes.add(leg.targetNodeId); }
    for (const nodeId of nodes) {
      try {
        await this.hooks.sendControl(nodeId, MSG.XFER_ABORT, { migrationId: rec.id, term: rec.term, reason });
      } catch { /* delivered on reconnect for a disconnected participant */ }
    }
    // Rollback identify: if the lease was revoked (drain started), restore the
    // source as the sole owner of every moving shard AUTHORITATIVELY. The fence
    // makes a mid-flight re-grant impossible, but abort must be deterministic
    // even against a stray holder: revoke any wrongful holder, delete its table
    // entry, then set the source entry unconditionally and re-grant its set.
    if (this.drainRan) {
      const bySource = new Map<string, number[]>();
      for (const leg of abortLegs) {
        const arr = bySource.get(leg.sourceNodeId) ?? [];
        arr.push(leg.shardId);
        bySource.set(leg.sourceNodeId, arr);
      }
      this.hooks.registry.epoch += 1;
      const epoch = this.hooks.registry.epoch;
      for (const [sourceNodeId, shardIds] of bySource) {
        for (const shardId of shardIds) {
          const held = this.hooks.registry.shardTable.get(shardId);
          if (held && held.nodeId !== sourceNodeId) {
            // A stray grant landed the shard on another node without the data:
            // revoke that holder's session before reclaiming the shard.
            const strayLeaseIds = this.hooks.drainLeaseIdsForShards(held.nodeId, [shardId]);
            if (strayLeaseIds.length > 0) {
              await this.hooks.revokeLease(held.nodeId, strayLeaseIds, `migration ${rec.id} abort rollback`);
            }
            this.hooks.registry.shardTable.delete(shardId);
          }
          this.hooks.registry.shardTable.set(shardId, {
            shardId, nodeId: sourceNodeId, leaseId: randomUUID(), term: this.hooks.registry.term, epoch,
          });
        }
        const fullSet = this.hooks.registry.shardIdsOf(sourceNodeId);
        await this.hooks.grantShardsTo(sourceNodeId, fullSet, epoch);
      }
      await this.hooks.persistPlan();
    }
    // Release the fence: the shards are back on the source (drain path) or were
    // never drained (pre-drain abort keeps the source's original table entry).
    this.unfenceShards(abortLegs.map(l => l.shardId));
    await this.finish('ABORTED', reason);
  }

  private async finish(state: 'DONE' | 'ABORTED', error?: string): Promise<void> {
    if (!this.record) return;
    this.clearStallWatchdog();
    this.clearDrainTimeout();
    this.clearCommitTimer();
    this.clearGrantRetry();
    // Defensive: any shard still fenced for this record is released here (the
    // GRANTING/ABORTING paths already unfence on the happy path).
    this.unfenceShards(this.record.legs.map(l => l.shardId));
    // Retire single-leg completion: hand control back to runRetire, which
    // decides whether more legs remain. The parent record stays active.
    if (this.finishHooks) {
      const cb = this.finishHooks;
      cb(state);
      return;
    }
    this.record.state = state;
    if (error) this.record.error = error;
    this.record.updatedAt = Date.now();
    this.history.push(this.record);
    if (this.history.length > MIGRATION_HISTORY_CAP) {
      // A record still owing a source cleanup or an abort stays: the debt
      // lives on it; so does the newest commit of a shard owed (a hold reads
      // where that shard's newest copy went).
      const keep = this.newestOfOwed();
      const evict = this.history.findIndex(r => !r.pendingSourceCleanup && !r.abortUndelivered && !keep.has(r));
      if (evict >= 0) this.history.splice(evict, 1);
    }
    const finished = this.record;
    this.record = null;
    this.live.clear();
    this.paused = false;
    await this.persist();
    this.hooks.pushStatus();
    console.log(`[Migration] ${finished.kind} ${finished.id} -> ${state}${error ? ` (${error})` : ''}`);
  }

  // --------------------------------------------------------------------------
  // Retire: sequential legs, each a complete Move with its own barrier.
  // --------------------------------------------------------------------------
  private async runRetire(): Promise<void> {
    if (!this.record || this.record.kind !== 'retire') return;
    const rec = this.record;
    for (let idx = rec.currentLegIndex ?? 0; idx < rec.legs.length; idx++) {
      if (this.paused) return;
      rec.currentLegIndex = idx;
      const leg = rec.legs[idx];
      // Completed legs stand (crash-recovery / resume path).
      if (leg.legState === 'DONE') continue;
      // Re-run PRECHECK for this leg.
      const gate = this.precheckLeg(leg);
      if (!gate.ok) {
        rec.error = `retire leg ${idx} (shard ${leg.shardId}): ${gate.error}`;
        this.paused = true;
        await this.persist();
        this.hooks.pushStatus();
        return;
      }
      const ok = await this.runSingleLegMove(leg, idx);
      if (!ok && this.abortWholeRetire) {
        this.abortWholeRetire = false;
        await this.finish('ABORTED', 'retire aborted; completed legs stand');
        return;
      }
      if (!ok) {
        // The single-leg move aborted safely (data intact on source). Pause.
        this.paused = true;
        await this.persist();
        this.hooks.pushStatus();
        return;
      }
    }
    // All legs done.
    await this.finish('DONE');
  }

  // Run one retire leg as a full, independent Move to completion. Resolves true
  // on DONE, false if it aborted (leaving the source untouched). The PARENT
  // record (all legs + currentLegIndex + per-leg legState) stays the persisted
  // active record throughout, so a crash mid-leg recovers the whole retire.
  private runSingleLegMove(leg: MigrationLeg, idx: number): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      const parent = this.record!;
      this.parentRecord = parent;
      // A leg starts under this master's term: the one the retire began under
      // may predate a master restart, and the control server drops frames
      // below the current term as stale.
      parent.term = this.hooks.registry.term;
      // The pipeline operates on this.record; give it a one-leg slice while
      // persistence keeps writing the parent (parentRecord set).
      const single: MigrationRecord = { ...parent, legs: [leg], state: 'PREPARING', epoch: undefined };
      this.record = single;
      leg.legState = 'PREPARING';
      delete leg.drained;
      this.hydrateLive(single);
      this.finishHooks = (state: 'DONE' | 'ABORTED') => {
        leg.legState = state;
        // Finished, its rollback done: a later recovery owes it none.
        delete leg.drained;
        // Drop the finished leg from the live map: a trailing progress/error
        // frame from its dying transfer must not resolve against the restored
        // parent record and abort a paused retire.
        this.live.delete(leg.legId);
        // Carry the failing leg's error up to the parent so the paused retire
        // surfaces why (the slice's error was set on `single`, not parent).
        if (state === 'ABORTED') { leg.error = single.error; parent.error = single.error; }
        // Carry any deferred source cleanup (down source at commit) onto the
        // parent so a reconnect retry finds it on the persisted retire record.
        for (const entry of single.pendingSourceCleanup ?? []) {
          for (const legId of entry.legIds) this.recordPendingSourceLeg(parent, entry.nodeId, legId);
        }
        parent.legs[idx] = leg;
        this.record = parent;
        this.parentRecord = null;
        this.finishHooks = null;
        resolve(state === 'DONE');
      };
      void this.persist().then(() => this.enterPreparing());
    });
  }

  // Retire single-leg completion is routed through finishHooks; when set, finish
  // resolves the running leg instead of clearing the whole record.
  private finishHooks: ((state: 'DONE' | 'ABORTED') => void) | null = null;
  // When set, persist writes THIS (the retire parent) instead of this.record.
  private parentRecord: MigrationRecord | null = null;

  // --------------------------------------------------------------------------
  // Redistribute (pause-time, data-only; DRAINING/freeze skipped).
  // --------------------------------------------------------------------------
  private async precheckRedistribute(): Promise<PrecheckResult> {
    if (this.recordsUnreadable) return { ok: false, error: RECORDS_UNREADABLE };
    if (!this.hooks.isPaused()) return { ok: false, error: 'redistribute runs only during the reshard pause' };
    const assembling = this.assemblingError();
    if (assembling) return { ok: false, error: assembling };
    if (this.hasActive()) return { ok: false, error: 'migration-in-progress' };
    const { moveSet, unreachable, totalBytes } = await this.computeRedistribute();
    return { ok: true, moveSet, unreachable, estBytes: totalBytes, warnings: this.proposalWarnings(unreachable) };
  }

  private async startRedistribute(): Promise<{ ok: boolean; error?: string; migrationId?: string }> {
    if (!this.hooks.isPaused()) return { ok: false, error: 'redistribute runs only during the reshard pause' };
    const assembling = this.assemblingError();
    if (assembling) return { ok: false, error: assembling };
    const { moveSet, unreachable } = await this.computeRedistribute();
    // Persist the FULL proposal (all shards, built by computeRedistribute) up
    // front so Resume grants EXACTLY the proposal even if the master crashes
    // mid-redistribute or there is nothing to move (data already on the proposal
    // owners). The proposal covers every shard, not just the moved ones.
    await this.persistProposal();
    // Resume grants this proposal verbatim, so an operator who skipped the
    // precheck still needs to see what it commits them to.
    for (const warning of this.proposalWarnings(unreachable)) console.warn(`[Migration] Redistribute: ${warning}`);
    if (moveSet.length === 0) {
      if (this.legIsLeaseOnly([])) {
        // Postgres deployment: guild data lives in the central database, so
        // there are no per-node files to place. The proposal is persisted and
        // Resume grants it verbatim; that IS the whole redistribute.
        console.log('[Migration] Redistribute: no node-local data to move (database backend); proposal persisted for Resume');
        return { ok: true };
      }
      const missing = unreachable.length > 0 ? `; ${unreachable.map(n => n.nodeName).join(', ')} unreachable` : '';
      return { ok: false, error: `nothing to redistribute (all data already placed)${missing}` };
    }
    const legs: MigrationLeg[] = moveSet.map(m => {
      const direction = this.resolveDirection(m.from, m.to) ?? 'push';
      return { legId: randomUUID(), shardId: m.shardId, sourceNodeId: m.from, targetNodeId: m.to, direction, guilds: m.guilds };
    });
    const rec: MigrationRecord = {
      id: randomUUID(), kind: 'redistribute', legs, state: 'PREPARING', shardCount: this.hooks.registry.shardCount,
      term: this.hooks.registry.term, createdAt: Date.now(), updatedAt: Date.now(),
    };
    this.record = rec;
    this.hydrateLive(rec);
    await this.persist();
    // Data-only: PREPARING -> COPYING -> (skip DRAINING) -> VERIFYING via a
    // final round trigger -> COMMITTING per batch. Sources freeze nothing (the
    // pause means nothing serves), so drive the drain-equivalent directly.
    void this.enterPreparingRedistribute();
    return { ok: true, migrationId: rec.id };
  }

  private async enterPreparingRedistribute(): Promise<void> {
    if (!this.record) return;
    await this.transition('PREPARING');
    try {
      const acks = await this.sendPrepareToAll();
      for (const [nodeId, ack] of acks) if (!ack.ok) throw new Error(`prepare nack from ${nodeId}: ${ack.reason ?? 'unknown'}`);
      await this.transition('COPYING');
      this.armStallWatchdog();
      // No freeze/drain: ask sources to run their final hashed round now (they
      // are not serving during the pause). Reuse XFER_DRAIN, which freezes a
      // non-serving guild harmlessly and ships the final hashed round.
      const byNode = new Map<string, MigrationLeg[]>();
      for (const leg of this.record.legs) {
        const arr = byNode.get(leg.sourceNodeId) ?? [];
        arr.push(leg);
        byNode.set(leg.sourceNodeId, arr);
      }
      await this.transition('DRAINING');
      this.armDrainTimeout();
      for (const [sourceNodeId, legs] of byNode) {
        await this.hooks.sendControl(sourceNodeId, MSG.XFER_DRAIN, {
          migrationId: this.record.id, term: this.record.term, legIds: legs.map(l => l.legId),
        });
      }
    } catch (error) {
      await this.enterAborting(error instanceof Error ? error.message : String(error));
    }
  }

  private async computeRedistribute(): Promise<{ moveSet: { shardId: number; from: string; to: string; guilds: string[] }[]; unreachable: { nodeId: string; nodeName: string }[]; totalBytes: number }> {
    const moveSet: { shardId: number; from: string; to: string; guilds: string[] }[] = [];
    const unreachable: { nodeId: string; nodeName: string }[] = [];
    let totalBytes = 0;
    const shardCount = this.hooks.registry.shardCount;
    // Build the assignment proposal (shard -> node) once for this computation so
    // every guild's new-count shard maps to a stable owner (no per-guild drift).
    // A copy its node still owes the cleanup of is stale (the move put the
    // newer one elsewhere): never moved, and its node never owns the shard,
    // or the cleanup would graveyard what the redistribute brings there.
    const owed = new Map<string, Set<string>>();
    for (const rec of this.cleanupRecords()) {
      for (const entry of rec.pendingSourceCleanup ?? []) {
        const guilds = owed.get(entry.nodeId) ?? new Set<string>();
        for (const legId of entry.legIds) for (const guildId of rec.legs.find(l => l.legId === legId)?.guilds ?? []) guilds.add(guildId);
        owed.set(entry.nodeId, guilds);
      }
    }
    this.buildProposal(shardCount, owed);
    // Collect per-node inventories over the control channel.
    const byPair = new Map<string, { shardId: number; from: string; to: string; guilds: string[] }>();
    for (const node of this.hooks.registry.nodes.values()) {
      if (!node.connected) {
        if (!node.isSelf) unreachable.push({ nodeId: node.nodeId, nodeName: node.nodeName });
        continue;
      }
      let inv: XferInventoryReply | null = null;
      try {
        inv = await this.hooks.sendControl(node.nodeId, MSG.XFER_INVENTORY, { term: this.hooks.registry.term });
      } catch { unreachable.push({ nodeId: node.nodeId, nodeName: node.nodeName }); continue; }
      if (!inv?.ok) continue;
      for (const g of inv.guilds) {
        if (owed.get(node.nodeId)?.has(g.guildId)) continue;
        const newShard = guildToShard(g.guildId, shardCount);
        const targetNodeId = this.ownerOfShard(newShard);
        if (!targetNodeId || targetNodeId === node.nodeId) continue;
        const key = `${node.nodeId}->${targetNodeId}:${newShard}`;
        const entry = byPair.get(key) ?? { shardId: newShard, from: node.nodeId, to: targetNodeId, guilds: [] };
        entry.guilds.push(g.guildId);
        byPair.set(key, entry);
        totalBytes += g.bytes;
      }
    }
    for (const entry of byPair.values()) moveSet.push(entry);
    return { moveSet, unreachable, totalBytes };
  }

  // Auto-proposal for Redistribute (shard -> node), rebuilt each computation.
  // Capacity-balanced round-robin over ALL connected nodes, the master
  // included, deterministic by nodeId; a shard already held in the table keeps
  // its holder. An operator override UI can replace this map without touching
  // the mechanism.
  private proposal = new Map<number, string>();
  // Proposal owners Declared Lost since this proposal was built.
  private readonly lostOwners = new Set<string>();
  private proposalWrites: Promise<unknown> = Promise.resolve();

  // The stored proposal is read and written one pass at a time, so a
  // Declare Lost's trim and a redistribute's re-persist never undo each other.
  private serialProposal<T>(pass: () => Promise<T>): Promise<T> {
    const run = this.proposalWrites.then(pass, pass);
    this.proposalWrites = run.catch(() => undefined);
    return run;
  }

  /** A proposal owner Declared Lost in the reshard pause: its Resume grants can never land, so its shards leave the stored proposal (returned). */
  dropProposalOwner(nodeId: string): Promise<number[]> {
    this.lostOwners.add(nodeId);
    for (const [shardId, owner] of this.proposal) if (owner === nodeId) this.proposal.delete(shardId);
    return this.serialProposal(async () => {
      const stored: Record<number, string> = await this.hooks.loadRedistributeProposal().catch(() => null) ?? {};
      const dropped = Object.entries(stored).filter(([, owner]) => owner === nodeId).map(([shardKey]) => Number(shardKey));
      if (dropped.length > 0) {
        await this.hooks.saveRedistributeProposal(Object.fromEntries(Object.entries(stored).filter(([, owner]) => owner !== nodeId)))
          .catch(error => console.warn('[Migration] Writing the redistribute proposal without a lost owner failed:', error instanceof Error ? error.message : error));
      }
      return dropped.filter(shardId => Number.isInteger(shardId));
    });
  }

  private buildProposal(shardCount: number, owed: Map<string, Set<string>>): void {
    this.proposal.clear();
    this.lostOwners.clear();
    const owing = new Map<number, Set<string>>();
    for (const [nodeId, guilds] of owed) {
      for (const guildId of guilds) {
        const shardId = guildToShard(guildId, shardCount);
        owing.set(shardId, (owing.get(shardId) ?? new Set<string>()).add(nodeId));
      }
    }
    const connected = [...this.hooks.registry.nodes.values()]
      .filter(n => n.connected)
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId));
    if (connected.length === 0) return;
    // Every connected node is a placement candidate, the master included: the
    // master holds data like any node (bounded by its capacity), and after a
    // reshard the empty plan means it has nothing in the `existing` branch, so
    // excluding it here would stack the whole fleet onto the workers.
    const candidates = connected;
    const capOf = (nodeId: string) => {
      const n = this.hooks.registry.nodes.get(nodeId);
      return Math.max(1, n?.capabilities?.shardCapacity ?? 1);
    };
    const held = new Map<string, number>();
    for (const n of connected) held.set(n.nodeId, 0);
    for (let shardId = 0; shardId < shardCount; shardId++) {
      const existing = this.hooks.registry.shardTable.get(shardId);
      if (existing && held.has(existing.nodeId)) {
        this.proposal.set(shardId, existing.nodeId);
        held.set(existing.nodeId, (held.get(existing.nodeId) ?? 0) + 1);
        continue;
      }
      // Least-loaded candidate by held/capacity ratio (capacity-balanced).
      let best: string | null = null;
      let bestScore = Infinity;
      for (const n of candidates) {
        if (owing.get(shardId)?.has(n.nodeId)) continue;
        const has = held.get(n.nodeId) ?? 0;
        const cap = capOf(n.nodeId);
        const score = has / cap;
        if (score < bestScore) { bestScore = score; best = n.nodeId; }
      }
      if (best) {
        this.proposal.set(shardId, best);
        held.set(best, (held.get(best) ?? 0) + 1);
      }
    }
  }

  // Redistribute placement is computed from the CONNECTED set, and Resume grants
  // exactly that proposal. A reshard-pause boot restores no worker entries, so
  // during the hold-down the registry holds only the master: a redistribute
  // started then bakes a master-only proposal (behind the benign "nothing to
  // redistribute") and Resume hands it the whole fleet, past its capacity.
  // Refuse until the fleet has assembled, the same gate Resume and manual assign
  // already apply. A worker that registered and then dropped is still visible as
  // `unreachable`, so the deliberate offline-holder redistribute is unaffected.
  private assemblingError(): string | null {
    const remainingMs = this.hooks.holdDownRemainingMs();
    if (remainingMs <= 0) return null;
    return `waiting for stale-holder leases to expire, ${Math.ceil(remainingMs / 1000)}s remaining`;
  }

  // Capacity is a soft placement hint, not a safety invariant: Resume grants the
  // proposal verbatim so that every guild is served by the node holding its data,
  // which deliberately outranks the declared cap (the same override retire's
  // explicit targets get). Capping here instead would leave surplus shards with
  // no owner at all, since distribute() only places onto nodes under capacity.
  // So warn rather than refuse, and name the nodes the proposal could not consult.
  private proposalWarnings(unreachable: { nodeId: string; nodeName: string }[]): string[] {
    const warnings: string[] = [];
    const load = new Map<string, number>();
    for (const nodeId of this.proposal.values()) load.set(nodeId, (load.get(nodeId) ?? 0) + 1);
    for (const [nodeId, count] of load) {
      const node = this.hooks.registry.nodes.get(nodeId);
      if (!node) continue;
      const cap = Math.max(1, node.capabilities?.shardCapacity ?? 1);
      if (count > cap) warnings.push(`${node.nodeName} will exceed its declared capacity (${count}/${cap})`);
    }
    if (unreachable.length > 0) {
      warnings.push(`${unreachable.map(n => n.nodeName).join(', ')} unreachable; their shards are placed on the nodes that are up and those guilds start fresh`);
    }
    return warnings;
  }

  // The node the proposal assigns a shard to.
  private ownerOfShard(shardId: number): string | null {
    return this.proposal.get(shardId) ?? null;
  }

  // Persist the redistribute proposal (shard -> node) for masterResume. The
  // in-memory proposal (full, all shards) is authoritative when present; after a
  // crash it is empty, so the record's legs (moved-shard targets) are overlaid
  // as a best-effort fallback for at least the shards that were being moved.
  private persistProposal(): Promise<void> {
    // Start from the durable on-disk proposal so a crash-recovery re-persist
    // (this.proposal empty; record.legs holds ONLY the moved shards) can never
    // drop the unmoved-shard entries the full proposal from startRedistribute
    // carries. Only ADD moved-shard targets on top (never a lost owner's: a
    // Declare Lost's trim alone removes its entries); never remove an entry.
    return this.serialProposal(async () => {
      const proposalMap: Record<number, string> = { ...(await this.hooks.loadRedistributeProposal() ?? {}) };
      for (const [shardId, targetNodeId] of this.proposal) proposalMap[shardId] = targetNodeId;
      for (const leg of this.record?.legs ?? []) {
        if (proposalMap[leg.shardId] === undefined && !this.lostOwners.has(leg.targetNodeId)) proposalMap[leg.shardId] = leg.targetNodeId;
      }
      await this.hooks.saveRedistributeProposal(proposalMap);
    });
  }

  // --------------------------------------------------------------------------
  // Leg building + precheck + direction.
  // --------------------------------------------------------------------------
  private buildLegs(payload: StartPayload): { legs: MigrationLeg[] } | { error: string } {
    const reg = this.hooks.registry;
    const legOf = (shardId: number, fromNodeId: string, toNodeId: string): { leg: MigrationLeg } | { error: string } => {
      const guilds = this.guildsOnShard(shardId);
      if (this.legIsLeaseOnly(guilds)) {
        return { leg: { legId: randomUUID(), shardId, sourceNodeId: fromNodeId, targetNodeId: toNodeId, direction: 'none', guilds } };
      }
      const direction = this.resolveDirection(fromNodeId, toNodeId);
      if (!direction) return { error: 'No transfer route: set TRANSFER_URL (and expose TRANSFER_PORT) on the source or the target node.' };
      return { leg: { legId: randomUUID(), shardId, sourceNodeId: fromNodeId, targetNodeId: toNodeId, direction, guilds } };
    };
    if (payload.kind === 'move') {
      const held = reg.shardTable.get(payload.shardId);
      if (!held) return { error: `shard ${payload.shardId} is not owned by any node` };
      const result = legOf(payload.shardId, held.nodeId, payload.toNodeId);
      if ('error' in result) return result;
      return { legs: [result.leg] };
    }
    if (payload.kind === 'swap') {
      const legs: MigrationLeg[] = [];
      for (const s of payload.legs) {
        const result = legOf(s.shardId, s.fromNodeId, s.toNodeId);
        if ('error' in result) return result;
        legs.push(result.leg);
      }
      return { legs };
    }
    if (payload.kind === 'retire') {
      const legs: MigrationLeg[] = [];
      const owned = reg.shardIdsOf(payload.nodeId);
      for (const shardId of owned) {
        const toNodeId = payload.targets[String(shardId)];
        if (!toNodeId) return { error: `no target chosen for shard ${shardId}` };
        const result = legOf(shardId, payload.nodeId, toNodeId);
        if ('error' in result) return result;
        legs.push(result.leg);
      }
      return { legs };
    }
    return { error: 'unsupported kind' };
  }

  private precheckLeg(leg: MigrationLeg): { ok: boolean; error?: string } {
    const { shardId, sourceNodeId, targetNodeId } = leg;
    const reg = this.hooks.registry;
    if (targetNodeId === sourceNodeId) return { ok: false, error: 'target equals source' };
    const source = reg.nodes.get(sourceNodeId);
    const target = reg.nodes.get(targetNodeId);
    if (!source) return { ok: false, error: `source ${sourceNodeId} unknown` };
    if (!target) return { ok: false, error: `target ${targetNodeId} unknown` };
    if (!source.connected && !source.isSelf) return { ok: false, error: `source ${source.nodeName} not connected` };
    if (!target.connected && !target.isSelf) return { ok: false, error: `target ${target.nodeName} not connected` };
    if (reg.healthOf(source) !== 'up') return { ok: false, error: `source ${source.nodeName} is not healthy` };
    if (reg.healthOf(target) !== 'up') return { ok: false, error: `target ${target.nodeName} is not healthy` };
    const held = reg.shardTable.get(shardId);
    if (!held || held.nodeId !== sourceNodeId) return { ok: false, error: `shard ${shardId} is not owned by ${source.nodeName}` };
    // A side still owing this shard's cleanup from an earlier move: data
    // brought back to the target is what that cleanup would graveyard, and
    // the source's release (the shard back on it) would lift a freeze its
    // drain takes, so the move waits until the cleanup has run.
    const owing = [target, source].find(node => this.pendingSourceCleanups().some(owed => owed.nodeId === node.nodeId && owed.shardIds.includes(shardId)));
    if (owing) {
      return { ok: false, error: `${owing.nodeName} still owes the cleanup of shard ${shardId} from an earlier move (it missed that commit); the move waits until the cleanup has run` };
    }
    // A cleanup from before a reshard names its guilds, not a current shard:
    // a node owing one takes no move until it has run.
    const crossed = [target, source].find(node => this.pendingSourceCleanups().some(owed => owed.nodeId === node.nodeId && owed.crossed));
    if (crossed) {
      return { ok: false, error: `${crossed.nodeName} still owes the cleanup of a move made before the last reshard (it missed that commit); the move waits until the cleanup has run` };
    }
    if (leg.direction === 'none') {
      // Defense-in-depth for the lease-only hand-off: both participants must
      // advertise the postgres backend (a runtime backend apply refreshes the
      // capability, 5.2), and the database must be reachable from the master.
      for (const node of [source, target]) {
        const backend = node.capabilities?.dataBackend ?? 'unknown';
        if (backend !== 'postgres') return { ok: false, error: `backend-skew: ${node.nodeName} reports ${backend}` };
      }
      if (!this.hooks.dataBackendHealthy()) {
        return { ok: false, error: 'database unreachable from the master; cannot start a lease-only migration' };
      }
    } else if (!this.resolveDirection(sourceNodeId, targetNodeId)) {
      return { ok: false, error: 'No transfer route: set TRANSFER_URL (and expose TRANSFER_PORT) on the source or the target node.' };
    }
    return { ok: true };
  }

  // Direction by reachability: target advertises -> push; else source advertises
  // -> pull; neither -> null (PRECHECK refusal).
  private resolveDirection(sourceNodeId: string, targetNodeId: string): TransferDirection | null {
    if (this.hooks.transferUrlOf(targetNodeId)) return 'push';
    if (this.hooks.transferUrlOf(sourceNodeId)) return 'pull';
    return null;
  }

  private guildsOnShard(shardId: number): string[] {
    const guilds: string[] = [];
    for (const [guildId, sid] of this.hooks.registry.guildMap) if (sid === shardId) guilds.push(guildId);
    // Overlay the REST-derived map so unconnected-shard guilds are included too.
    for (const [guildId, sid] of this.hooks.registry.restGuildShards) if (sid === shardId && !guilds.includes(guildId)) guilds.push(guildId);
    return guilds;
  }

  // --------------------------------------------------------------------------
  // Prepare fan-out (self-participant calls the executor directly).
  // --------------------------------------------------------------------------
  private async sendPrepareToAll(): Promise<Map<string, XferPreparedPayload>> {
    if (!this.record) return new Map();
    // Group legs per node with this node's role + peerUrl + token.
    const byNode = new Map<string, XferPrepareLeg[]>();
    const mint = () => randomBytes(32).toString('hex');
    for (const leg of this.record.legs) {
      const token = mint();
      const targetUrl = this.hooks.transferUrlOf(leg.targetNodeId);
      const sourceUrl = this.hooks.transferUrlOf(leg.sourceNodeId);
      // push: source dials target -> source gets target's peerUrl; target listens.
      // pull: target dials source -> target gets source's peerUrl; source listens.
      const sourcePeer = leg.direction === 'push' ? targetUrl : undefined;
      const targetPeer = leg.direction === 'pull' ? sourceUrl : undefined;
      const sourceLeg: XferPrepareLeg = { legId: leg.legId, shardId: leg.shardId, role: 'source', token, direction: leg.direction, peerUrl: sourcePeer, guilds: leg.guilds };
      const targetLeg: XferPrepareLeg = { legId: leg.legId, shardId: leg.shardId, role: 'target', token, direction: leg.direction, peerUrl: targetPeer, guilds: leg.guilds };
      pushInto(byNode, leg.sourceNodeId, sourceLeg);
      pushInto(byNode, leg.targetNodeId, targetLeg);
    }
    const acks = new Map<string, XferPreparedPayload>();
    await Promise.all([...byNode.entries()].map(async ([nodeId, legs]) => {
      const payload: XferPreparePayload = {
        migrationId: this.record!.id,
        kind: this.record!.kind,
        legs,
        term: this.record!.term,
        epoch: this.hooks.registry.epoch,
      };
      try {
        const ack = await this.withTimeout(this.hooks.sendControl(nodeId, MSG.XFER_PREPARE, payload), XFER_PREPARE_TIMEOUT_MS);
        acks.set(nodeId, ack as XferPreparedPayload);
      } catch (error) {
        acks.set(nodeId, { ok: false, reason: error instanceof Error ? error.message : String(error) });
      }
    }));
    return acks;
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('prepare timed out')), ms);
      t.unref();
      p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
    });
  }

  // --------------------------------------------------------------------------
  // Watchdogs + persistence.
  // --------------------------------------------------------------------------
  private armStallWatchdog(): void {
    this.clearStallWatchdog();
    this.stallTimer = setInterval(() => {
      if (!this.record || this.record.state !== 'COPYING') { this.clearStallWatchdog(); return; }
      const now = performance.now();
      for (const l of this.live.values()) {
        if (now - l.lastProgressAt > XFER_STALL_TIMEOUT_MS) {
          void this.enterAborting(`transfer stalled on leg ${l.leg.legId}`);
          return;
        }
      }
    }, Math.min(XFER_STALL_TIMEOUT_MS, 10000));
    this.stallTimer.unref();
  }

  private clearStallWatchdog(): void {
    if (this.stallTimer) { clearInterval(this.stallTimer); this.stallTimer = null; }
  }

  private armDrainTimeout(): void {
    this.clearDrainTimeout();
    this.drainTimer = setTimeout(() => {
      if (this.record && (this.record.state === 'DRAINING')) {
        void this.enterAborting('drain/verify timed out (one-sided verify)');
      }
    }, XFER_DRAIN_TIMEOUT_MS);
    this.drainTimer.unref();
  }

  private clearDrainTimeout(): void {
    if (this.drainTimer) { clearTimeout(this.drainTimer); this.drainTimer = null; }
  }

  private clearCommitTimer(): void {
    if (this.commitTimer) { clearInterval(this.commitTimer); this.commitTimer = null; }
  }

  private lastPush = 0;
  private throttledPush(): void {
    const now = Date.now();
    if (now - this.lastPush < 1000) return;
    this.lastPush = now;
    this.hooks.pushStatus();
  }

  private async persist(): Promise<void> {
    // During a retire leg the parent record (all legs + currentLegIndex + per-leg
    // legState) is the crash-recovery unit, not the running one-leg slice.
    if (this.recordsUnreadable) return;
    const active = this.parentRecord ?? this.record;
    const state: PersistedMigrations = {
      active: active && !isTerminal(active.state) ? active : null,
      history: this.history,
      updatedAt: Date.now(),
    };
    await this.hooks.store.saveMigrations(state);
  }
}

const RECORDS_UNREADABLE = 'The persisted migration records (migrations.json, or the control store\'s migrations document) cannot be read, so a migration may be under way unseen; no migration, backend transformation, reshard Resume, planned transfer, Declare Lost, Assign or Drain runs, and no free shard is placed, until the master restarts with them readable';

function isTerminal(state: MigrationState): boolean {
  return state === 'DONE' || state === 'ABORTED';
}

function guildToShard(guildId: string, shardCount: number): number {
  try {
    return Number((BigInt(guildId) >> 22n) % BigInt(Math.max(1, shardCount)));
  } catch {
    return 0;
  }
}

function pushInto<T>(map: Map<string, T[]>, key: string, value: T): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}
