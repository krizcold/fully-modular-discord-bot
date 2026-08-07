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
  INCOMING_RETENTION_MS,
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
  XferInventoryReply,
  XferPrepareLeg,
  XferPreparePayload,
  XferPreparedPayload,
  XferProgressPayload,
  XferVerifyPayload,
} from '../protocol';
import type { Registry } from '../registry';
import type { MigrationActiveView, MigrationLegView, MigrationView } from '../state';

export interface StartMovePayload { kind: 'move'; shardId: number; toNodeId: string; }
export interface StartSwapLeg { shardId: number; fromNodeId: string; toNodeId: string; }
export interface StartSwapPayload { kind: 'swap'; legs: StartSwapLeg[]; }
export interface StartRetirePayload { kind: 'retire'; nodeId: string; targets: Record<string, string>; }
export interface StartRedistributePayload { kind: 'redistribute'; }
export type StartPayload = StartMovePayload | StartSwapPayload | StartRetirePayload | StartRedistributePayload;

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
  /** Node-down hook fired when a participant is declared lost / disconnects mid-migration. */
  onNodeDownDuringMigration?: (nodeId: string) => void;
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
  error?: string;
}

export class MigrationCoordinator {
  private record: MigrationRecord | null = null;
  private history: MigrationRecord[] = [];
  private live = new Map<string, LegLive>(); // legId -> live
  private paused = false; // retire pause (Resume/Abort-remaining)
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
    const persisted = await this.hooks.store.loadMigrations();
    this.history = persisted.history ?? [];
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
      // DRAINING/VERIFYING already revoked the source lease, so the abort must
      // re-grant the source (rollback identify). The plan reload restored the
      // source's table entry, so rollback is a same-shape re-grant.
      if (rec.state === 'DRAINING' || rec.state === 'VERIFYING') this.drainRan = true;
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
    await new Promise<void>(resolve => {
      const parent = rec;
      this.parentRecord = parent;
      const single: MigrationRecord = { ...parent, legs: [leg], state, epoch: parent.epoch };
      this.record = single;
      this.hydrateLive(single);
      // Re-fence a committing/granting leg (shard already off the table) so
      // distribute() cannot re-place it before the grant lands. DRAINING/
      // VERIFYING revoked the source lease, so recovery-abort re-grants it back.
      if (state === 'COMMITTING' || state === 'GRANTING') this.fenceShards([leg.shardId]);
      if (state === 'DRAINING' || state === 'VERIFYING') this.drainRan = true;
      this.finishHooks = (finalState: 'DONE' | 'ABORTED') => {
        leg.legState = finalState;
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
        resolve();
        if (finalState === 'DONE') void this.runRetire();
        else { this.paused = true; void this.persist().then(() => this.hooks.pushStatus()); }
      };
      if (state === 'COMMITTING') void this.enterCommitting(true);
      else if (state === 'GRANTING') void this.enterGranting();
      else void this.enterAborting('master restarted before commit decision');
    });
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

  /**
   * Shards with a still-pending source cleanup (a source down at COMMITTING whose
   * originals were deferred). Fenced OFF the free pool so a shard freed by a
   * later Declare Lost is never load-placed back onto its own un-cleaned source
   * (or elsewhere) before the deferred cleanup runs. Released naturally when the
   * leg leaves pendingSourceCleanup (cleanup acked or the ownership guard drops
   * it). Empty in standalone and in normal non-migration operation.
   */
  pendingSourceCleanupShardIds(): ReadonlySet<number> {
    const ids = new Set<number>();
    const records: MigrationRecord[] = [];
    const active = this.parentRecord ?? this.record;
    if (active) records.push(active);
    for (const h of this.history) records.push(h);
    for (const rec of records) {
      if (!rec.pendingSourceCleanup) continue;
      for (const entry of rec.pendingSourceCleanup) {
        for (const legId of entry.legIds) {
          const leg = rec.legs.find(l => l.legId === legId);
          if (leg) ids.add(leg.shardId);
        }
      }
    }
    return ids;
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
   * the migration is still live in a non-commit state (defer to the broadcast).
   */
  dispositionOf(migrationId: string): { verdict: 'aborted' | 'unknown' } | { verdict: 'committing'; term: number; epoch: number } | null {
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

  getView(): MigrationView {
    const historyView = this.history.slice(-MIGRATION_HISTORY_CAP).map(r => ({
      id: r.id, kind: r.kind, state: r.state, error: r.error, updatedAt: r.updatedAt,
    }));
    if (!this.record || isTerminal(this.record.state)) return { active: null, history: historyView };
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
    return { active, history: historyView };
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
    const direction = this.resolveDirection(first.sourceNodeId, first.targetNodeId);
    if (!direction) {
      return { ok: false, error: 'No transfer route: set TRANSFER_URL (and expose TRANSFER_PORT) on the source or the target node.' };
    }
    let estBytes = 0;
    const guilds: string[] = [];
    for (const leg of legs.legs) { for (const g of leg.guilds) guilds.push(g); }
    const warnings: string[] = [];
    return { ok: true, estBytes, direction, guilds, warnings };
  }

  private validateCommon(payload: StartPayload): PrecheckResult {
    if (this.hooks.isPaused() && payload.kind !== 'redistribute') {
      return { ok: false, error: 'reshard pause active; only Redistribute runs during the pause' };
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

    // PRECHECK gate: connectivity, health, ownership, route.
    for (const leg of built.legs) {
      const gate = this.precheckLeg(leg.shardId, leg.sourceNodeId, leg.targetNodeId);
      if (!gate.ok) return { ok: false, error: gate.error };
    }

    const rec: MigrationRecord = {
      id: randomUUID(),
      kind: payload.kind,
      legs: built.legs,
      state: 'PREPARING',
      term: this.hooks.registry.term,
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

  async abort(migrationId: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.record || this.record.id !== migrationId) return { ok: false, error: 'no such active migration' };
    if (this.record.state === 'COMMITTING' || this.record.state === 'GRANTING') {
      return { ok: false, error: 'commit already decided' };
    }
    if (this.record.kind === 'retire' && this.paused) {
      // Abort-remaining: mark done; completed legs stand.
      await this.finish('ABORTED', 'retire aborted; completed legs stand');
      return { ok: true };
    }
    await this.enterAborting('operator abort');
    return { ok: true };
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
    try {
      const acks = await this.sendPrepareToAll();
      // Space check: every target's free space must exceed the total source
      // estimate * margin + cushion (statfs "unknown" is tolerated - no gate).
      for (const [nodeId, ack] of acks) {
        if (!ack.ok) throw new Error(`prepare nack from ${nodeId}: ${ack.reason ?? 'unknown'}`);
      }
      const totalEst = [...acks.values()].reduce((s, a) => s + (a.estBytes ?? 0), 0);
      const needed = totalEst * SPACE_MARGIN + SPACE_CUSHION_BYTES;
      for (const [nodeId, ack] of acks) {
        if (ack.freeBytes !== undefined && ack.freeBytes < needed) {
          throw new Error(`target ${nodeId} lacks space (free ${ack.freeBytes}, need ~${Math.round(needed)})`);
        }
      }
      await this.enterCopying();
    } catch (error) {
      await this.enterAborting(error instanceof Error ? error.message : String(error));
    }
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
   * A source that was unreachable at COMMITTING has reconnected: re-send the
   * idempotent XFER_COMMIT so its originals are graveyarded. Scans the active
   * record and history for a pending source matching this node. Called from the
   * register/reconnect path.
   */
  async retrySourceCleanup(nodeId: string): Promise<void> {
    const records: MigrationRecord[] = [];
    const active = this.parentRecord ?? this.record;
    if (active) records.push(active);
    for (const h of this.history) records.push(h);
    let changed = false;
    for (const rec of records) {
      const entry = rec.pendingSourceCleanup?.find(e => e.nodeId === nodeId);
      if (!entry || entry.legIds.length === 0) continue;
      const stillPending: string[] = [];
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
          stillPending.push(legId);
          continue;
        }
        // Ownership guard: if the shard was re-granted back to this same source
        // (e.g. the migration target was Declared Lost and distribute() re-placed
        // the freed shard onto its old source), the source's /data copies are now
        // the live authoritative copies. Graveyarding them here would serve the
        // guild empty. Drop the pending leg silently WITHOUT graveyarding.
        if (this.hooks.registry.shardTable.get(leg.shardId)?.nodeId === nodeId) continue;
        try {
          const ack = await this.hooks.sendControl(nodeId, MSG.XFER_COMMIT, {
            migrationId: rec.id, term: rec.term, epoch: rec.epoch ?? this.hooks.registry.epoch,
            legIds: [legId], sourceCleanup: true, guilds: leg.guilds,
          });
          if (!ack?.ok) stillPending.push(legId);
        } catch {
          stillPending.push(legId);
        }
      }
      entry.legIds = stillPending;
      rec.pendingSourceCleanup = rec.pendingSourceCleanup!.filter(e => e.legIds.length > 0);
      if (rec.pendingSourceCleanup.length === 0) rec.pendingSourceCleanup = undefined;
      changed = true;
    }
    if (changed) await this.persist();
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
    for (const leg of this.record.legs) {
      const l = this.live.get(leg.legId)!;
      if (!l.sourceVerify || !l.targetVerify || l.sourceVerify.hash !== l.targetVerify.hash) {
        // Per-guild diff logged on mismatch.
        this.logHashDiff(leg, l);
        await this.enterAborting(`hash mismatch on leg ${leg.legId}`);
        return;
      }
    }
    // All match: bump the epoch, persist COMMITTING BEFORE the first commit.
    this.hooks.registry.epoch += 1;
    this.record.epoch = this.hooks.registry.epoch;
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
    const rec = this.record;
    void (async () => {
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
          if (ack?.ok) { (leg as any)._sourceAcked = true; this.clearPendingSourceLeg(rec, leg.sourceNodeId, leg.legId); }
          else allSources = false;
        } catch {
          // Down source: record pendingSourceCleanup durably (survives the move
          // to history), retried at reconnect; fencing keeps it from serving
          // meanwhile. Do NOT block the grant.
          (leg as any)._sourcePending = true;
          this.recordPendingSourceLeg(rec, leg.sourceNodeId, leg.legId);
        }
      }
      const sourcesSettled = rec.legs.every(l => (l as any)._sourceAcked || (l as any)._sourcePending);
      if (allTargets && sourcesSettled) {
        this.clearCommitTimer();
        if ((rec.pendingSourceCleanup?.length ?? 0) > 0) await this.persist();
        void this.enterGranting();
      }
      void allSources;
    })();
  }

  // GRANTING: data commit is done - now the gateway swap. Grant the moved
  // shard(s) to the new owners via the metered grant path; Swap ordered
  // remote-first/self-last per execOrder; identifies metered by the ledger.
  private async enterGranting(): Promise<void> {
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
      const arr = byTarget.get(leg.targetNodeId) ?? [];
      arr.push(leg.shardId);
      byTarget.set(leg.targetNodeId, arr);
    }
    const order = [...byTarget.keys()].sort((a, b) => {
      const aSelf = this.hooks.isSelf(a) ? 1 : 0;
      const bSelf = this.hooks.isSelf(b) ? 1 : 0;
      return aSelf - bSelf;
    });
    const epoch = rec.epoch ?? this.hooks.registry.epoch;
    // The data is committed to each target; the grant is safe + idempotent to
    // retry. A hard grant refusal (ledger floor, target draining) must NEVER
    // finish DONE with the shard stranded off the free pool it would fall into,
    // so the migrating fence is held until every target's grant lands and the
    // grant is retried on a timer. An unacked grant is pending-confirmation
    // fenced by grantShardsTo; that counts as landed here.
    let allGranted = true;
    for (const targetNodeId of order) {
      const moved = byTarget.get(targetNodeId) ?? [];
      const fullSet = [...new Set([...this.hooks.registry.shardIdsOf(targetNodeId), ...moved])].sort((a, b) => a - b);
      const res = await this.hooks.grantShardsTo(targetNodeId, fullSet, epoch);
      if (!res.ok && !res.pending) allGranted = false;
    }
    await this.hooks.persistPlan();
    if (!allGranted) {
      // Keep the migration in GRANTING (fence held) and retry the grant round;
      // do NOT finish DONE with a committed-but-ungranted shard in limbo.
      this.scheduleGrantRetry();
      return;
    }
    this.clearGrantRetry();
    // All targets granted (or pending-confirmation fenced): release the fence.
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
    if (this.history.length > MIGRATION_HISTORY_CAP) this.history.shift();
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
      const gate = this.precheckLeg(leg.shardId, leg.sourceNodeId, leg.targetNodeId);
      if (!gate.ok) {
        rec.error = `retire leg ${idx} (shard ${leg.shardId}): ${gate.error}`;
        this.paused = true;
        await this.persist();
        this.hooks.pushStatus();
        return;
      }
      const ok = await this.runSingleLegMove(leg, idx);
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
      // The pipeline operates on this.record; give it a one-leg slice while
      // persistence keeps writing the parent (parentRecord set).
      const single: MigrationRecord = { ...parent, legs: [leg], state: 'PREPARING', epoch: undefined };
      this.record = single;
      leg.legState = 'PREPARING';
      this.hydrateLive(single);
      this.finishHooks = (state: 'DONE' | 'ABORTED') => {
        leg.legState = state;
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
    if (!this.hooks.isPaused()) return { ok: false, error: 'redistribute runs only during the reshard pause' };
    if (this.hasActive()) return { ok: false, error: 'migration-in-progress' };
    const { moveSet, unreachable, totalBytes } = await this.computeRedistribute();
    return { ok: true, moveSet, unreachable, estBytes: totalBytes };
  }

  private async startRedistribute(): Promise<{ ok: boolean; error?: string; migrationId?: string }> {
    if (!this.hooks.isPaused()) return { ok: false, error: 'redistribute runs only during the reshard pause' };
    const { moveSet } = await this.computeRedistribute();
    // Persist the FULL proposal (all shards, built by computeRedistribute) up
    // front so Resume grants EXACTLY the proposal even if the master crashes
    // mid-redistribute or there is nothing to move (data already on the proposal
    // owners). The proposal covers every shard, not just the moved ones.
    await this.persistProposal();
    if (moveSet.length === 0) return { ok: false, error: 'nothing to redistribute (all data already placed)' };
    const legs: MigrationLeg[] = moveSet.map(m => {
      const direction = this.resolveDirection(m.from, m.to) ?? 'push';
      return { legId: randomUUID(), shardId: m.shardId, sourceNodeId: m.from, targetNodeId: m.to, direction, guilds: m.guilds };
    });
    const rec: MigrationRecord = {
      id: randomUUID(), kind: 'redistribute', legs, state: 'PREPARING',
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
    this.buildProposal(shardCount);
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
  // Capacity-balanced round-robin over the connected NON-master nodes,
  // deterministic by nodeId; a shard already held in the table keeps its holder
  // (including one already on the master - that is not an auto-move). The auto
  // assignment never TARGETS the master (no-auto-move-to-master invariant); an
  // operator override UI can replace this map without touching the mechanism.
  private proposal = new Map<number, string>();
  private buildProposal(shardCount: number): void {
    this.proposal.clear();
    const connected = [...this.hooks.registry.nodes.values()]
      .filter(n => n.connected)
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId));
    if (connected.length === 0) return;
    // Auto-placement candidates exclude the master; the master only keeps shards
    // it already holds (the `existing` branch), never receives a moved one.
    const candidates = connected.filter(n => n.nodeId !== this.hooks.selfNodeId);
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
      // Least-loaded non-master node under its capacity (capacity-balanced).
      let best: string | null = null;
      let bestScore = Infinity;
      for (const n of candidates) {
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

  // The node the proposal assigns a shard to.
  private ownerOfShard(shardId: number): string | null {
    return this.proposal.get(shardId) ?? null;
  }

  // Persist the redistribute proposal (shard -> node) for masterResume. The
  // in-memory proposal (full, all shards) is authoritative when present; after a
  // crash it is empty, so the record's legs (moved-shard targets) are overlaid
  // as a best-effort fallback for at least the shards that were being moved.
  private async persistProposal(): Promise<void> {
    // Start from the durable on-disk proposal so a crash-recovery re-persist
    // (this.proposal empty; record.legs holds ONLY the moved shards) can never
    // drop the unmoved-shard entries the full proposal from startRedistribute
    // carries. Only ADD moved-shard targets on top; never remove an entry.
    const proposalMap: Record<number, string> = { ...(await this.hooks.loadRedistributeProposal() ?? {}) };
    for (const [shardId, targetNodeId] of this.proposal) proposalMap[shardId] = targetNodeId;
    for (const leg of this.record?.legs ?? []) {
      if (proposalMap[leg.shardId] === undefined) proposalMap[leg.shardId] = leg.targetNodeId;
    }
    await this.hooks.saveRedistributeProposal(proposalMap);
  }

  // --------------------------------------------------------------------------
  // Leg building + precheck + direction.
  // --------------------------------------------------------------------------
  private buildLegs(payload: StartPayload): { legs: MigrationLeg[] } | { error: string } {
    const reg = this.hooks.registry;
    const legOf = (shardId: number, fromNodeId: string, toNodeId: string): { leg: MigrationLeg } | { error: string } => {
      const direction = this.resolveDirection(fromNodeId, toNodeId);
      if (!direction) return { error: 'No transfer route: set TRANSFER_URL (and expose TRANSFER_PORT) on the source or the target node.' };
      const guilds = this.guildsOnShard(shardId);
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

  private precheckLeg(shardId: number, sourceNodeId: string, targetNodeId: string): { ok: boolean; error?: string } {
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
    if (!this.resolveDirection(sourceNodeId, targetNodeId)) {
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
    const active = this.parentRecord ?? this.record;
    const state: PersistedMigrations = {
      active: active && !isTerminal(active.state) ? active : null,
      history: this.history.slice(-MIGRATION_HISTORY_CAP),
      updatedAt: Date.now(),
    };
    await this.hooks.store.saveMigrations(state);
  }
}

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

export { INCOMING_RETENTION_MS };
