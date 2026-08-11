// Data readiness - drives working-set hydration from lease changes and gates
// event dispatch until a guild's working set is ready. Constructed only in
// postgres mode; the fleet layer calls in (fleet may import the data layer,
// never the reverse).

import { DataBackend, FenceToken } from './backend';
import { WorkingSetManager } from './workingSet';
import { setOwnedGuildCatalog } from '../dataManager';

const HYDRATION_FANOUT = 4;
const CATALOG_REFRESH_MS = 60_000;
const HYDRATE_RETRY_BASE_MS = 1000;
const HYDRATE_RETRY_CAP_MS = 30_000;
// Interactions wait inline inside Discord's 3 s ack window, then fail politely.
const INTERACTION_WAIT_MS = 2500;
const EVENT_BUFFER_CAP = 256;

// Local copy of the guild->shard formula (placement.ts) to avoid a fleet import.
function guildIdToShardId(guildId: string, shardCount: number): number {
  try {
    return Number((BigInt(guildId) >> 22n) % BigInt(Math.max(1, shardCount)));
  } catch {
    return 0;
  }
}

export interface LeaseSnapshot {
  nodeId: string;
  term: number;
  epoch: number;
  shardCount: number;
  shardIds: number[];
}

export class DataReadinessDriver {
  private shardIds: number[] = [];
  private shardCount = 0;
  private lease: LeaseSnapshot | null = null;
  private stopped = false;
  // Held = lease deltas are recorded but nothing hydrates (no ownership claims
  // land) until boot releases the driver after the store-identity verdict.
  private held = false;
  private lastCatalog: string[] = [];
  private catalogTimer: NodeJS.Timeout;
  private readonly buffers = new Map<string, Array<() => void>>();
  private bufferDrops = 0;
  private initialResolved = false;
  private resolveInitial: (() => void) | null = null;
  private readonly initialHydration = new Promise<void>(resolve => { this.resolveInitial = resolve; });

  constructor(private readonly backend: DataBackend, private readonly ws: WorkingSetManager, opts?: { held?: boolean }) {
    this.held = opts?.held ?? false;
    this.catalogTimer = setInterval(() => void this.refreshCatalog(), CATALOG_REFRESH_MS);
    this.catalogTimer.unref();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.catalogTimer);
  }

  /** Boot hook: store identity verified; hydrate whatever leases arrived while held. */
  release(): void {
    if (!this.held) return;
    this.held = false;
    if (this.shardIds.length > 0) {
      void this.hydrateShards([...this.shardIds]);
      void this.refreshCatalog();
    }
  }

  /** Fleet hook: the node's lease set changed (grant adoption). */
  onLeaseChanged(snapshot: LeaseSnapshot): void {
    const prev = new Set(this.shardIds);
    const next = new Set(snapshot.shardIds);
    const added = snapshot.shardIds.filter(s => !prev.has(s));
    const removed = this.shardIds.filter(s => !next.has(s));
    this.shardIds = [...snapshot.shardIds];
    this.shardCount = snapshot.shardCount;
    this.lease = snapshot;
    if (this.held) return;
    // Same-shape re-grant: refresh fences only, never re-hydrate.
    for (const guildId of this.ws.readyGuilds()) {
      this.ws.refreshFence(guildId, this.fenceFor(guildId));
    }
    if (removed.length > 0) void this.unloadShards(removed);
    if (added.length > 0) void this.hydrateShards(added);
    else if (!this.initialResolved && this.shardIds.length > 0) {
      // A re-grant with nothing new still means the initial set is covered.
      this.settleInitialIfReady();
    }
    void this.refreshCatalog();
  }

  /** Fleet hook: every lease is gone (revoke-all or TTL expiry). */
  onLeaseLost(): void {
    const shards = this.shardIds;
    this.shardIds = [];
    this.lease = null;
    if (shards.length > 0) void this.unloadShards(shards);
  }

  /**
   * Startup barrier: resolves when every guild of the initial granted lease
   * set is ready. The caller bounds the wait and logs skipped guilds.
   */
  awaitInitialHydration(boundMs: number): Promise<'ready' | 'timeout'> {
    if (this.initialResolved) return Promise.resolve('ready');
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve('timeout'), boundMs);
      timer.unref();
      void this.initialHydration.then(() => { clearTimeout(timer); resolve('ready'); });
    });
  }

  /**
   * Gate for interactions: wait briefly for the guild's working set, never
   * acknowledge on the handler's behalf. False = caller must politely reject.
   */
  async admitInteraction(guildId: string): Promise<boolean> {
    if (this.isReadyNow(guildId)) return true;
    this.hydrateOnDemand(guildId);
    return this.ws.awaitReady(guildId, INTERACTION_WAIT_MS);
  }

  /**
   * Gate for non-interaction events: true = dispatch now; false = buffered
   * (replayed in order on ready) or dropped (unleased shard / overflow).
   */
  admitEvent(guildId: string, replay: () => void): boolean {
    if (this.isReadyNow(guildId)) return true;
    if (!this.isLeasedHere(guildId)) return false; // mid-teardown straggler: drop
    this.hydrateOnDemand(guildId);
    let queue = this.buffers.get(guildId);
    if (!queue) {
      queue = [];
      this.buffers.set(guildId, queue);
      void this.ws.awaitReady(guildId, 24 * 60 * 60 * 1000).then(ready => this.drainBuffer(guildId, ready));
    }
    if (queue.length >= EVENT_BUFFER_CAP) {
      queue.shift();
      this.bufferDrops += 1;
      if (this.bufferDrops % 50 === 1) {
        console.warn(`[Data] Event buffer overflow for guild ${guildId} (${this.bufferDrops} drop(s) total); oldest dropped`);
      }
    }
    queue.push(replay);
    return false;
  }

  getCounters(): { bufferDrops: number } {
    return { bufferDrops: this.bufferDrops };
  }

  private isReadyNow(guildId: string): boolean {
    const state = this.ws.stateOf(guildId);
    return state === 'ready' || state === 'frozen-retained' || state === 'fenced';
  }

  private isLeasedHere(guildId: string): boolean {
    if (this.shardCount <= 0) return false;
    return this.shardIds.includes(guildIdToShardId(guildId, this.shardCount));
  }

  private fenceFor(guildId: string): FenceToken {
    const lease = this.lease;
    return {
      nodeId: lease?.nodeId ?? 'unknown',
      term: lease?.term ?? 0,
      epoch: lease?.epoch ?? 0,
      shardId: guildIdToShardId(guildId, this.shardCount || 1),
      shardCount: this.shardCount || 1,
    };
  }

  /** A GUILD_CREATE (or first touch) for a leased guild with no working set. */
  private hydrateOnDemand(guildId: string): void {
    if (this.held || !this.isLeasedHere(guildId) || this.ws.has(guildId)) return;
    void this.hydrateWithRetry(guildId);
  }

  private async hydrateShards(shards: number[]): Promise<void> {
    let guilds: string[] = [];
    for (let attempt = 0; !this.stopped; attempt++) {
      try {
        guilds = await this.backend.listOwnedGuilds(shards, this.shardCount);
        break;
      } catch {
        await sleep(backoff(attempt));
        // Shards may have been revoked while we waited.
        const still = shards.filter(s => this.shardIds.includes(s));
        if (still.length === 0) return;
      }
    }
    for (let i = 0; i < guilds.length; i += HYDRATION_FANOUT) {
      await Promise.all(guilds.slice(i, i + HYDRATION_FANOUT).map(g => this.hydrateWithRetry(g)));
    }
    this.settleInitialIfReady();
  }

  private async hydrateWithRetry(guildId: string): Promise<void> {
    for (let attempt = 0; !this.stopped; attempt++) {
      if (!this.isLeasedHere(guildId)) return;
      const outcome = await this.ws.hydrate(guildId, this.fenceFor(guildId));
      if (outcome === 'ready') return;
      if (outcome === 'deposed') {
        // Single-node posture: a deposed claim here means a stale local view;
        // the fleet layer's decline path (multi-node) owns handing the lease
        // back. Log loudly and stop retrying this guild.
        console.error(`[Data] Hydration claim for guild ${guildId} lost to a newer owner; not serving it`);
        return;
      }
      await sleep(backoff(attempt));
    }
  }

  private async unloadShards(shards: number[]): Promise<void> {
    const removed = new Set(shards);
    for (const guildId of this.ws.readyGuilds()) {
      if (removed.has(guildIdToShardId(guildId, this.shardCount || 1))) {
        await this.ws.unloadToFrozenRetained(guildId);
      }
    }
  }

  private drainBuffer(guildId: string, ready: boolean): void {
    const queue = this.buffers.get(guildId);
    this.buffers.delete(guildId);
    if (!queue) return;
    if (!ready) {
      if (queue.length > 0) console.warn(`[Data] Dropping ${queue.length} buffered event(s) for guild ${guildId} (working set never became ready)`);
      return;
    }
    for (const replay of queue) {
      try {
        replay();
      } catch (error) {
        console.error(`[Data] Buffered event replay failed for guild ${guildId}:`, error);
      }
    }
  }

  private settleInitialIfReady(): void {
    if (this.initialResolved) return;
    this.initialResolved = true;
    this.resolveInitial?.();
  }

  /** Owned guilds whose working set is not ready (startup-barrier skip logging). */
  unreadyGuilds(): string[] {
    return this.lastCatalog.filter(g => !this.isReadyNow(g));
  }

  private async refreshCatalog(): Promise<void> {
    if (this.stopped || this.held || this.shardIds.length === 0) {
      this.lastCatalog = [];
      setOwnedGuildCatalog([]);
      return;
    }
    try {
      this.lastCatalog = await this.backend.listOwnedGuilds(this.shardIds, this.shardCount);
      setOwnedGuildCatalog(this.lastCatalog);
    } catch { /* catalog snapshot refresh is best-effort; the next tick retries */ }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms);
    t.unref();
  });
}

function backoff(attempt: number): number {
  const ceiling = Math.min(HYDRATE_RETRY_CAP_MS, HYDRATE_RETRY_BASE_MS * 2 ** attempt);
  return Math.floor(ceiling / 2 + Math.random() * (ceiling / 2));
}

let driver: DataReadinessDriver | null = null;

export function initDataReadiness(backend: DataBackend, ws: WorkingSetManager, opts?: { held?: boolean }): DataReadinessDriver {
  driver = new DataReadinessDriver(backend, ws, opts);
  return driver;
}

export function getDataReadiness(): DataReadinessDriver | null {
  return driver;
}
