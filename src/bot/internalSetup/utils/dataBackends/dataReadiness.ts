// Data readiness - drives working-set hydration from lease changes and gates
// event dispatch until a guild's working set is ready. Constructed only in
// postgres mode; the fleet layer calls in (fleet may import the data layer,
// never the reverse).

import { DataBackend, FenceToken } from './backend';
import { resolveDataBackend } from '../../../../utils/envLoader';
import { WorkingSetManager } from './workingSet';
import { setOwnedGuildCatalog } from '../dataManager';

const HYDRATION_FANOUT = 4;
const CATALOG_REFRESH_MS = 60_000;
const HYDRATE_RETRY_BASE_MS = 1000;
const HYDRATE_RETRY_CAP_MS = 30_000;
// The operator data route's wait for a guild's set (Discord interactions hold in boot.ts).
const INTERACTION_WAIT_MS = 2500;
const EVENT_BUFFER_CAP = 256;

// Discord's guild->shard formula; dataManager.ts holds the same copy.
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
  // When each guild's last claim here was deposed (performance.now()); a hold counts only one made since it began.
  private readonly deposedAt = new Map<string, number>();
  private readonly loops = new Map<string, RetryLoop>();
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
    // Same-shape re-grant: refresh the leased guilds' fences only, never re-hydrate.
    for (const guildId of this.ws.readyGuilds()) {
      if (this.isLeasedHere(guildId)) this.ws.refreshFence(guildId, this.fenceFor(guildId));
    }
    if (removed.length > 0) void this.unloadShards(removed);
    if (added.length > 0) void this.hydrateShards(added);
    else if (!this.initialResolved && this.shardIds.length > 0) {
      // A re-grant with nothing new still means the initial set is covered.
      this.settleInitialIfReady();
    }
    void this.refreshCatalog();
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
   * The operator data route's gate (boot.ts awaitGuildDataReady): wait briefly
   * for the guild's working set. False = the route refuses.
   */
  async admitInteraction(guildId: string): Promise<boolean> {
    const until = performance.now() + INTERACTION_WAIT_MS;
    for (;;) {
      if (this.isReadyNow(guildId)) return true;
      this.hydrateOnDemand(guildId);
      const waited = await this.ws.awaitReady(guildId, Math.max(0, until - performance.now()));
      if (waited !== 'gone') return waited === 'ready';
      // The set it waited on was evicted with none hydrating in its place: the backend that serves the guild now decides.
      if (resolveDataBackend() === 'file') return true;
    }
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
      void this.ws.awaitReady(guildId, 24 * 60 * 60 * 1000).then(waited => this.drainBuffer(guildId, waited));
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

  /**
   * The dispatch gate's reading of a guild on this driver (R1-J2; boot.ts reads the exit drain and a refused layer
   * first). since is the hold's start: 'moved' only for a claim deposed since then. A leased guild with no set gets
   * one claim, as admitInteraction kicks today; a hold that finds it hydrating kicks none. A set frozen as its shard
   * left, with the shard leased here again, waits for the re-grant's hydrate.
   */
  causeOf(guildId: string, since: number): 'admit' | 'moved' | 'not-served' | 'loading' {
    const state = this.ws.stateOf(guildId);
    if (state === 'ready') return 'admit';
    if (state === 'fenced') return 'moved';
    if (!this.isLeasedHere(guildId)) return 'not-served';
    if (state === null) {
      if ((this.deposedAt.get(guildId) ?? -Infinity) >= since) return 'moved';
      this.hydrateOnDemand(guildId);
    }
    return 'loading';
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

  /**
   * One retry loop per guild: a second caller shares the running one and wakes it, from its backoff or, once the
   * attempt on the wire ends, before it sleeps. A loop whose set was evicted is replaced by a new one, which reads
   * the guild at once, so a caller gated on that new set finds it hydrating.
   */
  private hydrateWithRetry(guildId: string): Promise<void> {
    const running = this.loops.get(guildId);
    if (running && this.ws.has(guildId)) {
      running.woken = true;
      running.resume?.();
      return running.done;
    }
    if (running) {
      running.replaced = true;
      running.resume?.();
    }
    const loop: RetryLoop = { woken: false, replaced: false, resume: null, done: Promise.resolve() };
    this.loops.set(guildId, loop);
    loop.done = this.retryHydrate(guildId, loop).finally(() => { if (this.loops.get(guildId) === loop) this.loops.delete(guildId); });
    return loop.done;
  }

  private async retryHydrate(guildId: string, loop: RetryLoop): Promise<void> {
    for (let attempt = 0; !this.stopped && !loop.replaced; attempt++) {
      if (!this.isLeasedHere(guildId)) return;
      loop.woken = false;
      const outcome = await this.ws.hydrate(guildId, this.fenceFor(guildId));
      if (loop.replaced) return;
      // Evicted as it read, with nothing in its place: its next access reads it again.
      if (outcome === 'evicted') return;
      if (outcome === 'ready') {
        // Its lease moved while it hydrated: a re-grant renews the fence, a
        // revoke keeps it frozen, never served unleased.
        if (this.isLeasedHere(guildId)) {
          // Frozen under an older grant meanwhile (its shard left and came
          // back): hydrated again, it serves.
          if (this.ws.frozenBefore(guildId, this.fenceFor(guildId))) continue;
          this.ws.refreshFence(guildId, this.fenceFor(guildId));
        } else await this.ws.unloadToFrozenRetained(guildId, () => !this.isLeasedHere(guildId));
        return;
      }
      // A caller joined while this attempt was on the wire, under a fresh grant or the same one: it claims again at
      // once, from the first backoff, under the grant held now; a deposed answer stops it only when no caller joined while it was on the wire.
      if (loop.woken) {
        attempt = -1;
        continue;
      }
      if (outcome === 'deposed') {
        // A 0-row claim: a newer owner holds this guild.
        this.deposedAt.set(guildId, performance.now());
        console.error(`[Data] Hydration claim for guild ${guildId} lost to a newer owner; not serving it`);
        this.ws.dropWaiters(guildId);
        return;
      }
      await Promise.race([sleep(backoff(attempt)), new Promise<void>(resolve => { loop.resume = resolve; })]);
      loop.resume = null;
      // A joining caller woke it: its next wait starts from the first backoff again, as a new loop's would.
      if (loop.woken) attempt = -1;
    }
  }

  private async unloadShards(shards: number[]): Promise<void> {
    const removed = new Set(shards);
    for (const guildId of this.ws.readyGuilds()) {
      if (removed.has(guildIdToShardId(guildId, this.shardCount || 1))) {
        await this.ws.unloadToFrozenRetained(guildId, () => !this.isLeasedHere(guildId));
      }
    }
  }

  private drainBuffer(guildId: string, waited: 'ready' | 'gone' | 'not-ready'): void {
    const queue = this.buffers.get(guildId);
    this.buffers.delete(guildId);
    if (!queue) return;
    let dropped = waited === 'not-ready' ? queue.length : 0;
    if (waited !== 'not-ready') {
      for (const replay of queue) {
        // 'gone': the set they waited on was evicted with none hydrating in its place, so each goes back through the gate.
        if (waited === 'ready' || resolveDataBackend() === 'file' || this.isReadyNow(guildId)) this.replay(guildId, replay);
        else if (this.isLeasedHere(guildId)) this.admitEvent(guildId, replay);
        else dropped += 1;
      }
    }
    if (dropped > 0) console.warn(`[Data] Dropping ${dropped} buffered event(s) for guild ${guildId} (working set never became ready)`);
  }

  private replay(guildId: string, replay: () => void): void {
    try {
      replay();
    } catch (error) {
      console.error(`[Data] Buffered event replay failed for guild ${guildId}:`, error);
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

/** A guild's hydrate retry loop; woken by a caller that joined it, resume ends its backoff, replaced ends it. */
interface RetryLoop {
  woken: boolean;
  replaced: boolean;
  resume: (() => void) | null;
  done: Promise<void>;
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
