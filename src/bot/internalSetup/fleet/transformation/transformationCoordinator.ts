// TransformationCoordinator - master-side state machine for the live backend
// transformation (spec 3.2): PLANNING snapshot -> CONVERTING (nodes parallel,
// one guild at a time per node) -> FLIPPING (both-or-neither barrier) ->
// RETIRING -> DONE, with PAUSED/ABORTING around it. Every failure lands in
// PAUSED; abort reverses the converted prefix with the same engine.

import { randomUUID } from 'crypto';
import {
  MSG,
  TransformGuildPayload,
  TransformGuildAckPayload,
  BackendFlipPayload,
} from '../protocol';
import type {
  ControlStore,
  TransformationRecord,
  TransformationNodePlan,
  TransformationState,
  TransformDirection,
} from '../controlStore';
import type { Registry } from '../registry';
import {
  SPACE_MARGIN,
  SPACE_CUSHION_BYTES,
  TRANSFORM_GUILD_TIMEOUT_MS,
  TRANSFORM_FLIP_TIMEOUT_MS,
  TRANSFORM_DEST_PROBE_WAIT_MS,
} from '../constants';
import { guildIdToShardId } from '../placement';
import { DataBackendKind, loadCredentials, resolveDataBackend } from '../../../../utils/envLoader';
import { currentRouteDefault, applyRouteOverrides } from '../../utils/dataBackends/routeResolver';
import { ensureTransformationRuntime } from '../../utils/dataBackends/boot';
import { getGuildDataBackend } from '../../utils/dataManager';
import { PostgresBackend, writeBackendState, readStoreId } from '../../utils/dataBackends/postgresBackend';

const FAILED_GUILDS_CAP = 50;

export interface TransformationHooks {
  registry: Registry;
  store: ControlStore;
  /** Reshard pause marker active. */
  isPaused: () => boolean;
  holdDownRemainingMs: () => number;
  migrationActive: () => boolean;
  refusedRegistrationsPending: () => boolean;
  /** Route a control request to a node (self -> local executor). */
  sendControl: (targetNodeId: string, type: string, data: any, timeoutMs: number) => Promise<any>;
  pushStatus: () => void;
  /** Persist DATA_BACKEND=<dest> into the master's credential lane at FLIPPING (idempotent). */
  persistEnvBackend: (backend: DataBackendKind) => void;
}

export interface TransformationView {
  id: string;
  direction: TransformDirection;
  state: TransformationState;
  pausedFrom?: TransformationState;
  error?: string;
  failedGuilds: { guildId: string; reason: string }[];
  nodes: { nodeId: string; nodeName: string; converted: number; total: number; retired: number }[];
  updatedAt: number;
}

function isTerminal(state: TransformationState): boolean {
  return state === 'DONE' || state === 'ABORTED';
}

function destOf(direction: TransformDirection): DataBackendKind {
  return direction === 'file-to-postgres' ? 'postgres' : 'file';
}

function sourceOf(direction: TransformDirection): DataBackendKind {
  return direction === 'file-to-postgres' ? 'file' : 'postgres';
}

function entriesOf(plan: TransformationNodePlan): string[] {
  return plan.guilds.concat(plan.joined);
}

export class TransformationCoordinator {
  private record: TransformationRecord | null = null;
  private driving = false;
  private pauseRequested = false;

  constructor(private readonly hooks: TransformationHooks) { }

  hasActive(): boolean {
    return this.record !== null && !isTerminal(this.record.state);
  }

  activeId(): string | null {
    return this.hasActive() ? this.record!.id : null;
  }

  /** Post-flip cleanup phase: the one window Declare Lost stays allowed (skips the lost node's retires). */
  isRetiring(): boolean {
    const rec = this.record;
    if (!rec) return false;
    return rec.state === 'RETIRING' || (rec.state === 'PAUSED' && rec.pausedFrom === 'RETIRING');
  }

  /**
   * Per-guild routing overrides the window needs: the converted prefix routes
   * to the destination (during ABORTING, the not-yet-reverted slice). Empty
   * after FLIPPING - the flipped default covers everything.
   */
  routesView(): { guildId: string; backend: DataBackendKind }[] {
    const rec = this.record;
    if (!rec || isTerminal(rec.state) || rec.state === 'RETIRING') return [];
    const dest = destOf(rec.direction);
    const routes: { guildId: string; backend: DataBackendKind }[] = [];
    const aborting = rec.state === 'ABORTING' || (rec.state === 'PAUSED' && rec.pausedFrom === 'ABORTING');
    for (const plan of rec.nodes) {
      const list = entriesOf(plan);
      if (aborting) {
        for (let i = plan.cursor; i < (plan.abortLimit ?? 0); i++) routes.push({ guildId: list[i], backend: dest });
      } else {
        for (let i = 0; i < Math.min(plan.cursor, list.length); i++) routes.push({ guildId: list[i], backend: dest });
      }
    }
    return routes;
  }

  /**
   * Shards whose window guilds currently route to file are pinned to their
   * holders (spec 3.3): moving one would separate a guild from its bytes and
   * later convert (or serve) it empty.
   */
  pinnedShardIds(): ReadonlySet<number> {
    const pinned = new Set<number>();
    const rec = this.record;
    if (!rec || isTerminal(rec.state)) return pinned;
    const overridden = new Map(this.routesView().map(r => [r.guildId, r.backend]));
    const fallback = currentRouteDefault();
    const shardCount = this.hooks.registry.shardCount;
    for (const plan of rec.nodes) {
      for (const guildId of entriesOf(plan)) {
        if ((overridden.get(guildId) ?? fallback) === 'file') {
          pinned.add(guildIdToShardId(guildId, shardCount));
        }
      }
    }
    return pinned;
  }

  getView(): TransformationView | null {
    const rec = this.record;
    if (!rec) return null;
    return {
      id: rec.id,
      direction: rec.direction,
      state: rec.state,
      ...(rec.pausedFrom ? { pausedFrom: rec.pausedFrom } : {}),
      ...(rec.error ? { error: rec.error } : {}),
      failedGuilds: rec.failedGuilds ?? [],
      nodes: rec.nodes.map(plan => ({
        nodeId: plan.nodeId,
        nodeName: this.hooks.registry.nodes.get(plan.nodeId)?.nodeName ?? plan.nodeId,
        converted: Math.min(plan.cursor, entriesOf(plan).length),
        total: entriesOf(plan).length,
        retired: Math.min(plan.retireCursor ?? 0, entriesOf(plan).length),
      })),
      updatedAt: rec.updatedAt,
    };
  }

  async recover(): Promise<void> {
    const rec = await this.hooks.store.loadTransformation();
    if (!rec) return;
    this.record = rec;
    if (isTerminal(rec.state)) return;
    // The restarted master minted a fresh term; nodes validate against it.
    rec.term = this.hooks.registry.term;
    if (rec.state === 'FLIPPING') {
      // The flip was decided (both-or-neither); finish it, then hold RETIRING
      // paused for the operator.
      await this.persist();
      this.applyMasterRoutes();
      void this.completeFlip()
        .then(() => this.transition('RETIRING'))
        .then(() => this.enterPaused('master restarted mid-flip; flip completed, resume to retire the source data'));
      return;
    }
    if (rec.state === 'CONVERTING' || rec.state === 'ABORTING' || rec.state === 'RETIRING') {
      rec.pausedFrom = rec.state;
      rec.state = 'PAUSED';
      rec.error = 'master restarted; resume to continue';
    } else if (rec.state === 'PLANNING') {
      rec.state = 'ABORTED';
      rec.error = 'master restarted during PLANNING';
    }
    await this.persist();
    this.applyMasterRoutes();
    this.hooks.pushStatus();
  }

  async start(payload?: { direction?: TransformDirection }): Promise<{ ok: boolean; error?: string; transformationId?: string }> {
    if (this.hasActive()) return { ok: false, error: 'transformation-in-progress' };
    if (this.hooks.migrationActive()) return { ok: false, error: 'a migration is active; finish or abort it first' };
    if (this.hooks.isPaused()) return { ok: false, error: 'reshard pause active' };
    if (this.hooks.holdDownRemainingMs() > 0) return { ok: false, error: 'recovery hold-down running; retry shortly' };
    if (this.hooks.refusedRegistrationsPending()) return { ok: false, error: 'refused registrations pending; resolve the version skew first' };

    const source = currentRouteDefault();
    const direction: TransformDirection = source === 'file' ? 'file-to-postgres' : 'postgres-to-file';
    const dest = destOf(direction);
    let configured: DataBackendKind;
    try {
      configured = resolveDataBackend();
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (configured === source) return { ok: false, error: `DATA_BACKEND already matches the live backend (${source}); set it to ${dest} first` };
    if (payload?.direction && payload.direction !== direction) {
      return { ok: false, error: `data lives in ${source}; only ${direction} is possible` };
    }

    for (const node of this.hooks.registry.nodes.values()) {
      if (!node.connected) return { ok: false, error: `node ${node.nodeName} is not connected` };
    }

    // Both directions involve the database (destination or source).
    const ensure = ensureTransformationRuntime();
    if (!ensure.ok) return { ok: false, error: ensure.error };
    if (!(await this.waitBackendHealthy(TRANSFORM_DEST_PROBE_WAIT_MS))) {
      return { ok: false, error: 'database not reachable yet; retry shortly' };
    }

    const snapshot = this.snapshotNodes();
    if ('error' in snapshot) return { ok: false, error: snapshot.error };

    if (direction === 'postgres-to-file') {
      const spaceError = await this.precheckSpace(snapshot.nodes);
      if (spaceError) return { ok: false, error: spaceError };
    }

    const record: TransformationRecord = {
      id: randomUUID(),
      direction,
      state: 'PLANNING',
      term: this.hooks.registry.term,
      nodes: snapshot.nodes,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.record = record;
    await this.persist();
    await this.transition('CONVERTING');
    void this.driveConverting();
    return { ok: true, transformationId: record.id };
  }

  pause(): { ok: boolean; error?: string } {
    const rec = this.record;
    if (!rec || isTerminal(rec.state)) return { ok: false, error: 'no active transformation' };
    if (rec.state === 'PAUSED') return { ok: true };
    if (rec.state === 'FLIPPING') return { ok: false, error: 'flip already decided; it completes on its own' };
    this.pauseRequested = true;
    return { ok: true };
  }

  async resume(): Promise<{ ok: boolean; error?: string }> {
    const rec = this.record;
    if (!rec || rec.state !== 'PAUSED') return { ok: false, error: 'no paused transformation' };
    if (this.driving) return { ok: false, error: 'still finishing the in-flight guild' };
    for (const node of this.hooks.registry.nodes.values()) {
      if (!node.connected) return { ok: false, error: `node ${node.nodeName} is not connected` };
    }
    this.pauseRequested = false;
    const target = rec.pausedFrom ?? 'CONVERTING';
    rec.pausedFrom = undefined;
    rec.error = undefined;
    rec.state = target;
    await this.persist();
    this.hooks.pushStatus();
    if (target === 'CONVERTING') void this.driveConverting();
    else if (target === 'ABORTING') void this.driveAborting();
    else if (target === 'RETIRING') void this.driveRetiring();
    return { ok: true };
  }

  /** Allowed until FLIPPING persists: reverses the converted prefix with the same engine, direction flipped. */
  async abort(): Promise<{ ok: boolean; error?: string }> {
    const rec = this.record;
    if (!rec || isTerminal(rec.state)) return { ok: false, error: 'no active transformation' };
    if (rec.state === 'FLIPPING' || rec.state === 'RETIRING' || (rec.state === 'PAUSED' && rec.pausedFrom === 'RETIRING')) {
      return { ok: false, error: 'the flip is decided; the transformation can only complete now' };
    }
    if (rec.state === 'ABORTING' || (rec.state === 'PAUSED' && rec.pausedFrom === 'ABORTING')) return { ok: true };
    if (this.driving) {
      // Let the in-flight guild finish first; the operator aborts from PAUSED.
      this.pauseRequested = true;
      return { ok: false, error: 'still converting a guild; pause completes first, then abort' };
    }
    for (const plan of rec.nodes) {
      plan.abortLimit = Math.min(plan.cursor, entriesOf(plan).length);
      plan.cursor = 0;
    }
    rec.pausedFrom = undefined;
    rec.error = undefined;
    rec.state = 'ABORTING';
    await this.persist();
    this.applyMasterRoutes();
    this.hooks.pushStatus();
    void this.driveAborting();
    return { ok: true };
  }

  /** Health-loss auto-pause (spec 3.3). FLIPPING completes regardless; PAUSED stays paused. */
  onNodeDown(nodeId: string): void {
    const rec = this.record;
    if (!rec || isTerminal(rec.state) || rec.state === 'PAUSED' || rec.state === 'FLIPPING') return;
    void this.enterPaused(`node ${nodeId} went down mid-transformation`);
  }

  /**
   * Operator removed a node (Declare Lost is allowed only during RETIRING):
   * its unretired source residue is unreachable - record and skip it.
   */
  onNodeRemoved(nodeId: string): void {
    const rec = this.record;
    if (!rec || (rec.state !== 'RETIRING' && !(rec.state === 'PAUSED' && rec.pausedFrom === 'RETIRING'))) return;
    const plan = rec.nodes.find(p => p.nodeId === nodeId);
    if (!plan) return;
    const list = entriesOf(plan);
    for (let i = plan.retireCursor ?? 0; i < list.length; i++) {
      this.failGuild(list[i], 'node-lost-before-source-retire');
    }
    plan.retireCursor = list.length;
    void this.persist().then(() => this.hooks.pushStatus());
  }

  // ==========================================================================
  // DRIVE LOOPS
  // ==========================================================================

  private async driveConverting(): Promise<void> {
    if (this.driving) return;
    this.driving = true;
    let converged = false;
    try {
      while (this.record !== null && this.record.state === 'CONVERTING') {
        await Promise.all(this.record.nodes.map(plan => this.driveNodeConvert(plan)));
        if (this.record.state !== 'CONVERTING') return;
        const appended = this.appendJoinedGuilds();
        if (appended === 'blocked') return;
        if (!appended) break;
      }
      converged = this.record !== null && this.record.state === 'CONVERTING';
    } finally {
      this.driving = false;
    }
    // Outside the driving guard so the RETIRING loop can take it over.
    if (converged) await this.enterFlipping();
  }

  private async driveNodeConvert(plan: TransformationNodePlan): Promise<void> {
    const rec = this.record!;
    while (rec.state === 'CONVERTING') {
      const list = entriesOf(plan);
      if (plan.cursor >= list.length) return;
      const guildId = list[plan.cursor];
      const owner = this.ownerOf(guildId);
      if (!owner) {
        this.failGuild(guildId, 'no owner (shard unassigned)');
        await this.enterPaused(`guild ${guildId} has no owner; assign its shard, then resume`);
        return;
      }
      const ack = await this.sendTransform(owner, {
        transformationId: rec.id,
        term: rec.term,
        guildId,
        direction: rec.direction,
      });
      if (rec.state !== 'CONVERTING') return;
      if (!ack.ok) {
        this.failGuild(guildId, ack.reason ?? 'convert failed');
        await this.enterPaused(`guild ${guildId}: ${ack.reason ?? 'convert failed'}`);
        return;
      }
      plan.cursor += 1;
      this.applyMasterRoutes();
      await this.persist();
      this.hooks.pushStatus();
      if (this.pauseRequested) {
        await this.enterPaused('paused by operator');
        return;
      }
    }
  }

  private async driveAborting(): Promise<void> {
    if (this.driving) return;
    this.driving = true;
    try {
      const rec = this.record!;
      const reverse: TransformDirection = rec.direction === 'file-to-postgres' ? 'postgres-to-file' : 'file-to-postgres';
      await Promise.all(rec.nodes.map(async plan => {
        while (rec.state === 'ABORTING') {
          const list = entriesOf(plan);
          const limit = Math.min(plan.abortLimit ?? 0, list.length);
          if (plan.cursor >= limit) return;
          const guildId = list[plan.cursor];
          const owner = this.ownerOf(guildId);
          if (!owner) {
            this.failGuild(guildId, 'no owner during abort');
            await this.enterPaused(`abort: guild ${guildId} has no owner; assign its shard, then resume`);
            return;
          }
          const ack = await this.sendTransform(owner, {
            transformationId: rec.id,
            term: rec.term,
            guildId,
            direction: reverse,
          });
          if (rec.state !== 'ABORTING') return;
          if (!ack.ok) {
            this.failGuild(guildId, `abort-revert: ${ack.reason ?? 'failed'}`);
            await this.enterPaused(`abort: guild ${guildId}: ${ack.reason ?? 'revert failed'}`);
            return;
          }
          plan.cursor += 1;
          this.applyMasterRoutes();
          await this.persist();
          this.hooks.pushStatus();
          if (this.pauseRequested) {
            await this.enterPaused('paused by operator');
            return;
          }
        }
      }));
      if (this.record?.state === 'ABORTING') {
        this.record.state = 'ABORTED';
        this.record.updatedAt = Date.now();
        await this.persist();
        this.applyMasterRoutes();
        this.hooks.pushStatus();
        console.log(`[Transform] Aborted: converted guilds reverted to ${sourceOf(this.record.direction)}`);
      }
    } finally {
      this.driving = false;
    }
  }

  private async driveRetiring(): Promise<void> {
    if (this.driving) return;
    this.driving = true;
    try {
      const rec = this.record!;
      await Promise.all(rec.nodes.map(async plan => {
        while (rec.state === 'RETIRING') {
          const list = entriesOf(plan);
          if ((plan.retireCursor ?? 0) >= list.length) return;
          const guildId = list[plan.retireCursor ?? 0];
          // Source residue lives on the node that converted the guild, not the
          // guild's (possibly re-placed) current owner.
          const ack = await this.sendTransform(plan.nodeId, {
            transformationId: rec.id,
            term: rec.term,
            guildId,
            direction: rec.direction,
            phase: 'retire-source',
          });
          if (rec.state !== 'RETIRING') return;
          if (!ack.ok) {
            this.failGuild(guildId, `retire: ${ack.reason ?? 'failed'}`);
            await this.enterPaused(`retire: guild ${guildId} on ${plan.nodeId}: ${ack.reason ?? 'failed'}`);
            return;
          }
          plan.retireCursor = (plan.retireCursor ?? 0) + 1;
          await this.persist();
          this.hooks.pushStatus();
          if (this.pauseRequested) {
            await this.enterPaused('paused by operator');
            return;
          }
        }
      }));
      if (this.record?.state === 'RETIRING') {
        this.record.state = 'DONE';
        this.record.updatedAt = Date.now();
        await this.persist();
        this.hooks.pushStatus();
        console.log('[Transform] DONE: source data retired (graveyard TTL applies)');
      }
    } finally {
      this.driving = false;
    }
  }

  // ==========================================================================
  // FLIPPING
  // ==========================================================================

  private async enterFlipping(): Promise<void> {
    await this.transition('FLIPPING');
    await this.completeFlip();
    await this.transition('RETIRING');
    void this.driveRetiring();
  }

  /** Idempotent: safe to re-run after a master crash mid-flip. */
  private async completeFlip(): Promise<void> {
    const rec = this.record!;
    const dest = destOf(rec.direction);
    const url = (loadCredentials().DATA_BACKEND_URL || '').trim();
    if (url) {
      try {
        const storeId = await readStoreId(url);
        await writeBackendState(url, { live: dest, storeId, flippedAt: Date.now(), transformationId: null });
      } catch (error) {
        console.warn('[Transform] Could not write the database-side backend marker (informational):', error instanceof Error ? error.message : error);
      }
    }
    const flip: BackendFlipPayload = { backend: dest, transformationId: rec.id, term: rec.term, ...(url ? { url } : {}) };
    for (const node of this.hooks.registry.nodes.values()) {
      if (!node.connected) continue;
      try {
        const ack = await this.hooks.sendControl(node.nodeId, MSG.BACKEND_FLIP, flip, TRANSFORM_FLIP_TIMEOUT_MS);
        if (!ack?.ok) console.warn(`[Transform] ${node.nodeName} did not ack the flip; its register reply re-delivers it`);
      } catch (error) {
        console.warn(`[Transform] Flip to ${node.nodeName} failed (re-delivered at its next register):`, error instanceof Error ? error.message : error);
      }
    }
    try {
      this.hooks.persistEnvBackend(dest);
    } catch (error) {
      console.warn('[Transform] Could not persist DATA_BACKEND after the flip:', error instanceof Error ? error.message : error);
    }
    this.applyMasterRoutes();
  }

  // ==========================================================================
  // INTERNALS
  // ==========================================================================

  private async sendTransform(nodeId: string, payload: TransformGuildPayload): Promise<TransformGuildAckPayload> {
    try {
      const url = (loadCredentials().DATA_BACKEND_URL || '').trim();
      if (url) payload = { ...payload, url };
      const ack = await this.hooks.sendControl(nodeId, MSG.TRANSFORM_GUILD, payload, TRANSFORM_GUILD_TIMEOUT_MS);
      if (ack && typeof ack.ok === 'boolean') return ack as TransformGuildAckPayload;
      return { ok: false, reason: 'malformed ack' };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  private ownerOf(guildId: string): string | null {
    const shardId = guildIdToShardId(guildId, this.hooks.registry.shardCount);
    return this.hooks.registry.shardTable.get(shardId)?.nodeId ?? null;
  }

  private snapshotNodes(): { nodes: TransformationNodePlan[] } | { error: string } {
    const registry = this.hooks.registry;
    const merged = new Map<string, number>([...registry.restGuildShards, ...registry.guildMap]);
    const byNode = new Map<string, string[]>();
    for (const [guildId] of merged) {
      const owner = this.ownerOf(guildId);
      if (!owner) return { error: `guild ${guildId} has no owner (shard unassigned); assign all shards first` };
      const list = byNode.get(owner) ?? [];
      list.push(guildId);
      byNode.set(owner, list);
    }
    const nodes: TransformationNodePlan[] = [];
    for (const [nodeId, guilds] of byNode) {
      guilds.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : a === b ? 0 : 1));
      nodes.push({ nodeId, guilds, joined: [], cursor: 0 });
    }
    return { nodes };
  }

  /** Guilds that appeared during the window; source-routed until they convert. Returns 'blocked' after pausing. */
  private appendJoinedGuilds(): boolean | 'blocked' {
    const rec = this.record!;
    const known = new Set<string>();
    for (const plan of rec.nodes) for (const guildId of entriesOf(plan)) known.add(guildId);
    const registry = this.hooks.registry;
    const merged = new Map<string, number>([...registry.restGuildShards, ...registry.guildMap]);
    let appended = false;
    for (const [guildId] of merged) {
      if (known.has(guildId)) continue;
      const owner = this.ownerOf(guildId);
      if (!owner) {
        this.failGuild(guildId, 'joined mid-window with no owner');
        void this.enterPaused(`guild ${guildId} joined mid-window with no owner; assign its shard, then resume`);
        return 'blocked';
      }
      let plan = rec.nodes.find(p => p.nodeId === owner);
      if (!plan) {
        plan = { nodeId: owner, guilds: [], joined: [], cursor: 0 };
        rec.nodes.push(plan);
      }
      plan.joined.push(guildId);
      appended = true;
      console.log(`[Transform] Guild ${guildId} joined mid-window; queued on ${owner}`);
    }
    return appended;
  }

  private async precheckSpace(nodes: TransformationNodePlan[]): Promise<string | null> {
    const backend = getGuildDataBackend() as PostgresBackend | null;
    if (!backend) return 'postgres runtime not ready';
    let sizes: Map<string, number>;
    try {
      sizes = await backend.sizeOfAllGuilds();
    } catch (error) {
      return `could not size the database: ${error instanceof Error ? error.message : String(error)}`;
    }
    for (const plan of nodes) {
      const est = plan.guilds.reduce((sum, guildId) => sum + (sizes.get(guildId) ?? 0), 0);
      const needed = est * SPACE_MARGIN + SPACE_CUSHION_BYTES;
      const node = this.hooks.registry.nodes.get(plan.nodeId);
      const free = node?.freeDiskBytes ?? null;
      if (free === null) return `${node?.nodeName ?? plan.nodeId} has not reported free disk space yet; retry shortly`;
      if (free < needed) {
        return `${node?.nodeName ?? plan.nodeId} lacks space (free ${free}, need ~${Math.round(needed)})`;
      }
    }
    return null;
  }

  private async waitBackendHealthy(boundMs: number): Promise<boolean> {
    const deadline = Date.now() + boundMs;
    for (; ;) {
      if (getGuildDataBackend()?.healthy()) return true;
      if (Date.now() >= deadline) return false;
      await new Promise(resolve => setTimeout(resolve, 250).unref());
    }
  }

  private applyMasterRoutes(): void {
    applyRouteOverrides(this.hasActive() ? this.routesView().map(r => ({ guildId: r.guildId, backend: r.backend })) : null);
  }

  private failGuild(guildId: string, reason: string): void {
    const rec = this.record!;
    rec.failedGuilds = rec.failedGuilds ?? [];
    if (rec.failedGuilds.length >= FAILED_GUILDS_CAP) return;
    rec.failedGuilds.push({ guildId, reason });
  }

  private async enterPaused(error: string): Promise<void> {
    const rec = this.record;
    if (!rec || isTerminal(rec.state) || rec.state === 'PAUSED') return;
    this.pauseRequested = false;
    rec.pausedFrom = rec.state;
    rec.state = 'PAUSED';
    rec.error = error;
    rec.updatedAt = Date.now();
    await this.persist();
    this.hooks.pushStatus();
    console.warn(`[Transform] PAUSED: ${error}`);
  }

  private async transition(state: TransformationState): Promise<void> {
    const rec = this.record!;
    rec.state = state;
    rec.updatedAt = Date.now();
    await this.persist();
    this.hooks.pushStatus();
    console.log(`[Transform] -> ${state}`);
  }

  private async persist(): Promise<void> {
    if (!this.record) return;
    this.record.updatedAt = Date.now();
    try {
      await this.hooks.store.saveTransformation(this.record);
    } catch (error) {
      console.error('[Transform] Persist failed:', error instanceof Error ? error.message : error);
    }
  }
}
