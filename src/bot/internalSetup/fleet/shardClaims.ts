// The shard claims of one bot process (NB4): the renewal lane, the work lane (page read, reservation, returns), the
// local deadline, the stop-serving step after a lapse or a loss, and the release at the stop.

import {
  elapsedMs,
  pairKey,
  planReturns,
  planTake,
  type ClaimTimings,
  type HandOver,
  type Me,
  type Pair,
} from './claimRules';
import {
  ClaimFailure,
  ClaimPausedError,
  classifyFailure,
  describeClass,
  type ClaimStoreApi,
  type FailureClass,
  type PageRead,
  type RenewAnswer,
  type RetakeAnswer,
  type TakeAnswer,
} from './claimStore';
import { commitRolledBack } from '../utils/dataBackends/postgresBackend';

export type Clocks = () => { perf: number; wall: number };
const realClocks: Clocks = () => ({ perf: performance.now(), wall: Date.now() });
const FAILURE_LOG_MS = 30_000;
const COPY_LOG_MS = 10 * 60_000;

export interface ShardClaimsDeps {
  store: ClaimStoreApi;
  me: Me;
  timings: ClaimTimings;
  capacity: number;
  takeoverSeconds: number;
  returns: boolean;
  /** A web UI process can restart this one (decision 10). */
  restartable: boolean;
  startedAt: number;
  clocks?: Clocks;
  /** Null when fit, else the fitness key that failed (decision 14). */
  fitness: () => string | null;
  /** The maintenance gate is closed (decision 6's lapse exception). */
  gateClosed: () => boolean;
  /** A stop began (decision 12). */
  isStopping: () => boolean;
  /** Freezes every guild set and empties the lease, which stops the gateway at once (decision 16). */
  stopServingStep: () => void;
  /** After a lapse outside the exit drain: NB2's outage state, so the watcher starts the leave. */
  noteLapsed: (seconds: number) => void;
  /** After a loss: rewrite the shard record and start NB2's leave, in the same step. */
  noteLost: (lost: Pair[], stillHeld: Pair[]) => void;
  /** After a loss in the exit drain: rewrites the shard record only, starting no leave and no restart. */
  noteLostAtStop?: (lost: Pair[], stillHeld: Pair[]) => void;
  /** Decision 15: asks for the restart once fit; true when the request was sent. */
  restartForShards: (reason: string) => boolean;
  /** NB2's leave asked for its own restart. */
  leaveRestartAsked?: () => boolean;
  /** The shard record, read before the boot take: keptAtStop names the shards the last completed release kept for this machine. */
  lastRecord?: () => { shardCount: number; keptAtStop?: number[] } | null;
  /** After a completed release: records the shards it kept for this machine, held and reserved. */
  noteKeptAtStop?: (shardCount: number, shardIds: number[], dropped: number[]) => void;
  /** NB5 C5 (e): the latch's `<why>` while the process does not write to its database, else null; the release is then skipped. */
  releaseRefusal?: () => string | null;
  /** NB5 C4: the working set's sets of the shard save under the claim the move took again. */
  replaceShardClaim?: (shardId: number, claim: number) => void;
  /** NB5 D7: the guilds this process holds a set for in the shard. */
  guildsOfShard?: (shardId: number) => string[];
  log?: Pick<Console, 'log' | 'warn' | 'error'>;
}

/** NB5 decision 12: the database a move writes next, for (c)'s and (d)'s lines and (d)'s generation rule. */
export interface MoveTarget {
  address: string;
  generation: number;
}

export interface ClaimsSnapshot {
  processId: string;
  held: Pair[];
  reserved: Pair[];
  page: PageRead | null;
  pageReadAt: number | null;
  renewalError: FailureClass | null;
  /** The last page read's failure; null once a page read completes. */
  pageReadError: FailureClass | null;
  pendingRestart: string | null;
  /** The fitness key that holds the restart request back; null when the request was sent or none is pending. */
  restartWaiting: string | null;
  returning: number[];
  stopped: 'lapse' | 'loss' | 'database' | null;
  renewMs: number;
}

export class ShardClaims {
  private held: Pair[] = [];
  private reserved: Array<Pair & { at: { perf: number; wall: number } }> = [];
  /** The send of the renewal (or the take's BEGIN) that last returned each pair. */
  private readonly lastReturned = new Map<string, { perf: number; wall: number }>();
  /** The database time of the last completed renewal that returned each pair. */
  private readonly lastReturnedAt = new Map<string, number>();
  private latestFailure: FailureClass | null = null;
  private stopped: 'lapse' | 'loss' | 'database' | null = null;
  private granted = false;
  private closing = false;
  private renewing: Promise<void> | null = null;
  /** NB5 E1: a boot take's renewal, its wait for the lane included. */
  private renewWithRun: Promise<void> | null = null;
  private workRun: Promise<void> | null = null;
  private lanesStopped = false;
  /** NB5 C5 (c): from a latch to the end of the move's (d), and again after an attempt that ended past (d). */
  private lanesPaused = false;
  /** NB5 E2: the latest latch's `<why>`; once set, the boot takes and grants nothing for the rest of the process. */
  private databaseStop: string | null = null;
  /** Reserved pairs the move's renewal did not return, for the loss step at the end of (d). */
  private moveLostReserved: Pair[] = [];
  private lastNotMoving: string | null = null;
  private everSentTake = false;
  /** Pairs found lost during the exit drain: the release asks for them and names them as no longer held. */
  private lostAtStop: Pair[] = [];
  private pageReadError: FailureClass | null = null;
  private restartWaiting: string | null = null;
  private renewTimer: NodeJS.Timeout | null = null;
  private deadlineTimer: NodeJS.Timeout | null = null;
  private wroteHeartbeat = false;
  private lastCopyLog = -Infinity;
  private firstRenewalAt: number | null = null;
  private page: PageRead | null = null;
  private pageReadAt: number | null = null;
  private returnList: HandOver[] = [];
  private pendingRestart: string | null = null;
  private restartSent = false;
  private shardCount: number | null = null;
  private retired = false;
  private finishing: Promise<void> | null = null;
  private readonly clocks: Clocks;
  private readonly log: Pick<Console, 'log' | 'warn' | 'error'>;

  constructor(private readonly deps: ShardClaimsDeps) {
    this.clocks = deps.clocks ?? realClocks;
    this.log = deps.log ?? console;
  }

  get processId(): string {
    return this.deps.me.processId;
  }

  heldPairs(): Pair[] {
    return [...this.held];
  }

  claimOf(shardId: number): number | null {
    return this.held.find(p => p.shardId === shardId)?.claim ?? null;
  }

  latestFailureClass(): FailureClass | null {
    return this.latestFailure;
  }

  snapshot(): ClaimsSnapshot {
    return {
      processId: this.processId,
      held: [...this.held],
      reserved: this.reserved.map(({ at: _at, ...p }) => p),
      page: this.page,
      pageReadAt: this.pageReadAt,
      renewalError: this.latestFailure,
      pageReadError: this.pageReadError,
      pendingRestart: this.pendingRestart,
      restartWaiting: this.pendingRestart === null ? null : this.waitingKey(),
      returning: this.returnList.map(h => h.shardId),
      stopped: this.stopped,
      renewMs: this.deps.timings.renewMs,
    };
  }

  // A sent shard restart is withdrawn once the process stops serving or its gate closes; the leave then holds it.
  private waitingKey(): string | null {
    if (!this.restartSent || this.closing || this.deps.isStopping()) return this.restartWaiting;
    if (!this.stopped && !this.deps.gateClosed()) return this.restartWaiting;
    if (this.deps.leaveRestartAsked?.()) return null;
    return this.deps.fitness();
  }

  /** Starts the renewal lane: a tick and heartbeat every R, with the pairs held or reserved. */
  start(): void {
    if (this.renewTimer) return;
    this.renewTimer = setInterval(() => { void this.renewOnce(); }, this.deps.timings.renewMs);
    this.renewTimer.unref?.();
  }

  // ---------------------------------------------------------------- deadline

  private earliestReturn(): { perf: number; wall: number } | null {
    let earliest: { perf: number; wall: number } | null = null;
    const now = this.clocks();
    for (const pair of this.held) {
      const at = this.lastReturned.get(pairKey(pair));
      if (!at) continue;
      if (!earliest || elapsedMs(at, now) > elapsedMs(earliest, now)) earliest = at;
    }
    return earliest;
  }

  private pastDeadline(): boolean {
    if (this.held.length === 0) return false;
    const since = this.earliestReturn();
    if (!since) return false;
    if (elapsedMs(since, this.clocks()) < this.deps.timings.deadlineMs) return false;
    return !(this.latestFailure?.kind === 'refused' && this.deps.gateClosed());
  }

  /** Decision 6: true once the stop-serving step ran; before that, runs the lapse step here when D has passed. */
  stoppedServing(): boolean {
    if (this.stopped) return true;
    if (!this.pastDeadline()) return false;
    this.lapse();
    return true;
  }

  private armDeadline(): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
    if (this.stopped || this.held.length === 0) return;
    const since = this.earliestReturn();
    if (!since) return;
    const left = Math.max(this.deps.timings.deadlineMs - elapsedMs(since, this.clocks()), 0);
    this.deadlineTimer = setTimeout(() => {
      this.deadlineTimer = null;
      if (this.stoppedServing()) return;
      // A timer can fire a few ms before D on the measured clocks: wait out the rest, not R.
      const at = this.earliestReturn();
      if (at && elapsedMs(at, this.clocks()) < this.deps.timings.deadlineMs) this.armDeadline();
      else this.rearmLater();
    }, left);
    this.deadlineTimer.unref?.();
  }

  // The lapse exception held at the deadline: asked again every R.
  private rearmLater(): void {
    if (this.stopped || this.deadlineTimer) return;
    this.deadlineTimer = setTimeout(() => {
      this.deadlineTimer = null;
      if (!this.stoppedServing()) this.rearmLater();
    }, this.deps.timings.renewMs);
    this.deadlineTimer.unref?.();
  }

  private lapse(): void {
    if (this.stopped) return;
    this.stopped = 'lapse';
    const since = this.earliestReturn();
    const seconds = since ? Math.round(elapsedMs(since, this.clocks()) / 1000) : 0;
    this.runStopStep();
    if (this.deps.isStopping()) {
      this.log.warn(`[Shards] No claim renewal for ${seconds} s during the exit drain; every guild set is frozen`);
      return;
    }
    const earlier = this.restartSent ? '; a restart this process asked for earlier may still stop it, which drops them' : '';
    this.log.error(`[Shards] No claim renewal for ${seconds} s; every shard leaves Discord and the unsaved changes are kept until a renewal completes${earlier}`);
    try { this.deps.noteLapsed(seconds); } catch (error) { this.log.error('[Shards] Could not report the lapse:', error); }
  }

  private runStopStep(): void {
    if (this.deadlineTimer) { clearTimeout(this.deadlineTimer); this.deadlineTimer = null; }
    if (!this.restartSent) { this.pendingRestart = null; this.restartWaiting = null; }
    try { this.deps.stopServingStep(); } catch (error) { this.log.error('[Shards] The stop-serving step failed:', error); }
  }

  private loss(lost: Pair[]): void {
    const lostKeys = new Set(lost.map(pairKey));
    this.held = this.held.filter(p => !lostKeys.has(pairKey(p)));
    this.reserved = this.reserved.filter(p => !lostKeys.has(pairKey(p)));
    if (!this.stopped) {
      this.stopped = 'loss';
      this.runStopStep();
    }
    if (this.closing || this.deps.isStopping()) {
      // In the exit drain the process is already ending: the record is rewritten, but no leave and no restart request.
      this.lostAtStop.push(...lost);
      try { this.deps.noteLostAtStop?.(lost, [...this.held]); } catch (error) { this.log.error('[Shards] Could not rewrite the shard record:', error instanceof Error ? error.message : error); }
    } else {
      try { this.deps.noteLost(lost, [...this.held]); } catch (error) { this.log.error('[Shards] Could not start the leave after a loss:', error); }
    }
    void this.onWorkLane(() => this.explainLoss(lost));
  }

  /** Decision 16's loss lines, read after the leave started; one retry. */
  private async explainLoss(lost: Pair[]): Promise<void> {
    for (const pair of lost) {
      let read: Awaited<ReturnType<ClaimStoreApi['readRow']>> | null = null;
      let cause = '';
      for (let attempt = 0; attempt < 2 && !read && !this.lanesStopped; attempt++) {
        try {
          read = await this.deps.store.readRow(pair.shardCount, pair.shardId);
        } catch (error) {
          if (error instanceof ClaimPausedError) {
            cause = 'not read: the claims are paused since this process stopped writing to its database';
            break;
          }
          cause = this.lanesStopped ? 'not read: this process is stopping' : describeFailureClass(classifyFailure(error));
        }
      }
      if (!read && !cause) cause = 'not read: this process is stopping';
      this.log.error(lossLine(pair, read, cause, this.processId, this.lastReturnedAt.get(pairKey(pair)) ?? null));
    }
  }

  /** The work lane: one query at a time on at most one connection; a caller waits for the run before it. */
  private async onWorkLane(fn: () => Promise<void>): Promise<void> {
    while (this.workRun) await this.workRun;
    const run = fn().catch(() => undefined);
    this.workRun = run;
    try { await run; } finally { if (this.workRun === run) this.workRun = null; }
  }

  // ---------------------------------------------------------------- renewal lane

  /** One renewal; a second call while one is on the wire waits for it. */
  renewOnce(): Promise<void> {
    if (this.renewing) return this.renewing;
    if (this.lanesPaused) return Promise.resolve();
    this.renewing = this.renewCycle().finally(() => { this.renewing = null; });
    return this.renewing;
  }

  private heartbeat() {
    return {
      capacity: this.deps.capacity,
      takeoverSeconds: this.deps.takeoverSeconds,
      fit: !this.retired && !this.stopped && !this.restartSent && this.deps.fitness() === null,
      restartable: this.deps.restartable,
      returns: this.deps.returns,
      startedAt: this.deps.startedAt,
    };
  }

  private async renewCycle(): Promise<void> {
    const sent = this.clocks();
    const pairs: Pair[] = [...this.held, ...this.reserved.map(({ at: _at, ...p }) => p)];
    let answer: RenewAnswer;
    try {
      answer = await this.deps.store.renew({ me: this.deps.me, pairs, ttlMs: this.deps.timings.ttlMs, heartbeat: this.heartbeat() });
    } catch (error) {
      if (!(error instanceof ClaimPausedError)) this.latestFailure = classifyFailure(error);
      return;
    }
    this.latestFailure = null;
    this.noteHeartbeat(answer);
    this.firstRenewalAt ??= answer.at;
    this.applyRenewal(answer, sent, new Set(pairs.map(pairKey)));
    if (this.granted) void this.work();
  }

  private noteHeartbeat(answer: RenewAnswer): void {
    const copied = this.wroteHeartbeat && answer.priorProcess !== null && answer.priorProcess !== this.processId;
    this.wroteHeartbeat = true;
    const now = this.clocks().wall;
    if (copied && now - this.lastCopyLog >= COPY_LOG_MS) {
      this.lastCopyLog = now;
      this.log.error(copiedIdLine(this.deps.me.nodeId));
    }
  }

  /** Judges only the pairs this renewal carried: a pair taken or reserved while it was on the wire waits for the next one. */
  private applyRenewal(answer: RenewAnswer, sent: { perf: number; wall: number }, carried: Set<string>): void {
    const mine = new Map(answer.rows.filter(r => r.mine).map(r => [pairKey(r), r]));
    const lost: Pair[] = [];
    for (const pair of this.held) {
      if (!carried.has(pairKey(pair))) continue;
      const row = mine.get(pairKey(pair));
      if (!row || row.released) lost.push(pair);
      else {
        this.lastReturned.set(pairKey(pair), sent);
        this.lastReturnedAt.set(pairKey(pair), answer.at);
      }
    }
    for (const pair of this.reserved) {
      if (!carried.has(pairKey(pair))) continue;
      const row = mine.get(pairKey(pair));
      if (!row || !row.released) lost.push(pair);
    }
    if (lost.length > 0) {
      this.loss(lost);
      return;
    }
    if (!this.stopped) this.armDeadline();
  }

  /** Boot: the first renewal statement completed (a tick and the heartbeat), retried every R, logged at the first failure and every 30 s. */
  async firstRenewal(): Promise<boolean> {
    let lastLog = -Infinity;
    for (;;) {
      if (this.deps.isStopping() || this.databaseStop !== null) return false;
      await this.renewOnce();
      if (this.databaseStop !== null) return false;
      if (this.firstRenewalAt !== null) return true;
      const now = this.clocks().wall;
      if (this.latestFailure && now - lastLog >= FAILURE_LOG_MS) {
        lastLog = now;
        this.log.warn(`[Shards] Cannot take shards yet: the claim renewal failed (${describeFailureClass(this.latestFailure)}); retrying every ${seconds(this.deps.timings.renewMs)} s`);
      }
      await sleep(this.deps.timings.renewMs);
    }
  }

  // ---------------------------------------------------------------- boot take

  /**
   * Decision 10's boot take, retried every R until a take answers: waits for this machine's previous process's rows,
   * tells a copy of this node id by its renewals, and renews a take acknowledged after its deadline before granting.
   * Answers null when a stop began first (the boot then grants nothing), or once giveUp answers true (decision 13's
   * HTTP 401 while resolving the count).
   */
  async bootTake(localCount: () => Promise<number | null>, giveUp: () => boolean = () => false): Promise<{ shardCount: number; pairs: Pair[]; answer: Extract<TakeAnswer, { kind: 'done' }> } | null> {
    let lastFailureLog = -Infinity;
    let waitLine: { at: number; remainingMs: number } | null = null;
    let lastRenewedAt = new Map<number, number>();
    const copied = new Set<number>();
    const record = this.deps.lastRecord?.() ?? null;
    let count = await localCount();
    for (;;) {
      if (this.deps.isStopping() || giveUp() || this.databaseStop !== null) return null;
      let began: { perf: number; wall: number } | null = null;
      let answer: TakeAnswer;
      try {
        this.everSentTake = true;
        answer = await this.deps.store.take({
          me: this.deps.me, capacity: this.deps.capacity, ttlMs: this.deps.timings.ttlMs, boot: true, known: [],
          localCount: count, reserve: false, copied,
        }, () => { began = this.clocks(); });
      } catch (error) {
        if (this.databaseStop !== null || this.lanesStopped || this.deps.isStopping()) return null;
        const now = this.clocks().wall;
        if (now - lastFailureLog >= FAILURE_LOG_MS) {
          lastFailureLog = now;
          this.log.warn(`[Shards] Cannot take shards yet: the take failed (${describeFailureClass(classifyFailure(error))}); retrying every ${seconds(this.deps.timings.renewMs)} s`);
        }
        await sleep(this.deps.timings.renewMs);
        continue;
      }
      if (answer.kind === 'need-count') {
        await sleep(this.deps.timings.renewMs);
        count = await localCount();
        continue;
      }
      if (answer.plan.wait) {
        const now = this.clocks().wall;
        for (const [shardId, renewedAt] of answer.predecessorRenewedAt) {
          const before = lastRenewedAt.get(shardId);
          if (before !== undefined && renewedAt > before && this.firstRenewalAt !== null && renewedAt > this.firstRenewalAt && !copied.has(shardId)) {
            copied.add(shardId);
            this.log.error(copiedIdLine(this.deps.me.nodeId));
          }
        }
        lastRenewedAt = answer.predecessorRenewedAt;
        const { shardIds, remainingMs } = answer.plan.wait;
        const predicted = waitLine ? waitLine.remainingMs - (now - waitLine.at) : null;
        if (predicted === null || Math.abs(predicted - remainingMs) > this.deps.timings.renewMs) {
          waitLine = { at: now, remainingMs };
          this.log.warn(`[Shards] Shards ${shardIds.join(', ')} are still claimed by this machine's previous bot process, which stopped without releasing them; taking them in ${Math.ceil(remainingMs / 1000)} s`);
        }
        if (copied.size > 0 && shardIds.every(id => copied.has(id))) continue;
        await sleep(this.deps.timings.renewMs);
        continue;
      }
      if (answer.adopted) {
        this.log.warn(`[Shards] This machine resolves ${answer.adopted.local} shards; the database runs ${answer.adopted.stored}, and the count changes only when no machine holds a shard under ${answer.adopted.stored}: stop the bot on the other machines, then restart this one`);
      }
      for (const t of answer.taken) {
        if (t.above === 'no-room') this.log.warn(`[Shards] Taking shard ${t.pair.shardId} above this machine's target (FLEET_SHARD_CAPACITY ${this.deps.capacity}): no other machine has room for it`);
        else if (t.above === 'own') this.log.warn(`[Shards] Taking shard ${t.pair.shardId} above this machine's target (FLEET_SHARD_CAPACITY ${this.deps.capacity}): it was this machine's shard`);
      }
      if (record?.keptAtStop && record.shardCount === answer.shardCount) {
        const kept = record.keptAtStop;
        const taken = new Set(answer.taken.map(t => t.pair.shardId));
        for (const other of answer.plan.elsewhere) {
          if (kept.includes(other.shardId) && !taken.has(other.shardId)) {
            this.log.warn(`[Shards] Shard ${other.shardId} kept for this machine was taken by ${other.holderName} while it restarted`);
          }
        }
      }
      this.shardCount = answer.shardCount;
      const at = began ?? this.clocks();
      const pairs = answer.taken.map(t => t.pair);
      this.held = pairs;
      for (const p of pairs) this.lastReturned.set(pairKey(p), at);
      if (this.deps.isStopping() || this.databaseStop !== null) return null;
      if (pairs.length > 0 && elapsedMs(at, this.clocks()) >= this.deps.timings.deadlineMs) {
        // Acknowledged after its deadline: renewed at once, and a pair the renewal does not return leaves the set.
        const held = this.held;
        this.held = [];
        await this.renewWith(held);
        if (this.databaseStop !== null) return null;
      }
      return { shardCount: answer.shardCount, pairs: [...this.held], answer };
    }
  }

  /** On the renewal lane: waits for the renewal on the wire, then renews exactly these pairs, and interval ticks wait for it. */
  private renewWith(pairs: Pair[]): Promise<void> {
    const run = (async () => {
      while (this.renewing) await this.renewing;
      const cycle = this.renewWithCycle(pairs);
      this.renewing = cycle;
      try { await cycle; } finally { if (this.renewing === cycle) this.renewing = null; }
    })();
    this.renewWithRun = run;
    return run.finally(() => { if (this.renewWithRun === run) this.renewWithRun = null; });
  }

  private async renewWithCycle(pairs: Pair[]): Promise<void> {
    const sent = this.clocks();
    try {
      const answer = await this.deps.store.renew({ me: this.deps.me, pairs, ttlMs: this.deps.timings.ttlMs, heartbeat: this.heartbeat() });
      this.latestFailure = null;
      const mine = new Set(answer.rows.filter(r => r.mine && !r.released).map(pairKey));
      this.held = pairs.filter(p => mine.has(pairKey(p)));
      for (const p of this.held) {
        this.lastReturned.set(pairKey(p), sent);
        this.lastReturnedAt.set(pairKey(p), answer.at);
      }
    } catch (error) {
      if (error instanceof ClaimPausedError) {
        // NB5 E1: the pairs stay for the move's renewal and re-take; the database stop already ended serving.
        this.held = pairs;
        return;
      }
      this.latestFailure = classifyFailure(error);
      this.held = [];
    }
  }

  // ---------------------------------------------------------------- the database stop and the move (NB5)

  /** The latest latch's `<why>`, set by stopServingForDatabase and never cleared; null before any. */
  databaseStopWhy(): string | null {
    return this.databaseStop;
  }

  /**
   * NB5 decision 11 and C5 (c): the process stopped writing to its database. In one synchronous run: the stop-serving
   * step once, the lanes paused and the store's gate raised, so nothing begun before is sent or applied.
   */
  stopServingForDatabase(why: string): void {
    this.databaseStop = why;
    if (this.stopped === null) {
      this.stopped = 'database';
      this.runStopStep();
    }
    this.lanesPaused = true;
    this.deps.store.pause();
  }

  /**
   * Step (c): one renewal on the pool (b) built, sent while paused, after the renewal lane and a boot take's renewal
   * settled (E1). Records the pairs returned; never runs the loss step. Rejects on a failure.
   */
  async moveRenewal(): Promise<{ returned: Pair[]; missing: Pair[] }> {
    for (;;) {
      if (this.renewWithRun) { await this.renewWithRun.catch(() => undefined); continue; }
      if (this.renewing) { await this.renewing.catch(() => undefined); continue; }
      break;
    }
    let done: () => void = () => undefined;
    const run = new Promise<void>(resolve => { done = resolve; });
    this.renewing = run;
    try {
      const sent = this.clocks();
      const held = [...this.held];
      const reserved = this.reserved.map(({ at: _at, ...p }) => p);
      const answer = await this.deps.store.renew(
        { me: this.deps.me, pairs: [...held, ...reserved], ttlMs: this.deps.timings.ttlMs, heartbeat: this.heartbeat() },
        { move: true },
      );
      this.latestFailure = null;
      const mine = new Map(answer.rows.filter(r => r.mine).map(r => [pairKey(r), r]));
      const returned: Pair[] = [];
      const missing: Pair[] = [];
      for (const pair of held) {
        const row = mine.get(pairKey(pair));
        if (row && !row.released) {
          returned.push(pair);
          this.lastReturned.set(pairKey(pair), sent);
          this.lastReturnedAt.set(pairKey(pair), answer.at);
        } else missing.push(pair);
      }
      this.moveLostReserved = reserved.filter(pair => !mine.get(pairKey(pair))?.released);
      return { returned, missing };
    } finally {
      done();
      if (this.renewing === run) this.renewing = null;
    }
  }

  /**
   * Steps (c) and (d) of a move to the target, and the end of (d) in one synchronous run: the re-taken claims in the
   * fence, the lanes resumed, then the loss step for the pairs neither returned nor taken. False ends this attempt with
   * its line; the lanes stay paused and nothing is dropped.
   */
  async moveClaims(target: MoveTarget): Promise<boolean> {
    let renewal: { returned: Pair[]; missing: Pair[] };
    try {
      renewal = await this.moveRenewal();
    } catch (error) {
      this.notMoving(`[Database] Not moving to ${target.address} yet: the claim renewal there failed (${this.moveCause(error)}); this process keeps its unsaved changes and stays stopped`);
      return false;
    }
    const missing = renewal.missing;
    let taken: RetakeAnswer['taken'] = [];
    if (missing.length > 0) {
      const ids = missing.map(p => p.shardId);
      const guildIds = [...new Set(ids)].map(shardId => ({ shardId, guildIds: this.deps.guildsOfShard?.(shardId) ?? [] }));
      let commitSent = false;
      try {
        taken = (await this.deps.store.retake({
          me: this.deps.me, shardCount: missing[0].shardCount, pairs: missing, guildIds, generation: target.generation,
          ttlMs: this.deps.timings.ttlMs,
        }, () => { commitSent = true; })).taken;
      } catch (error) {
        const cause = error instanceof ClaimFailure ? error.cause : error;
        const one = new Set(ids).size === 1;
        const shards = one ? `shard ${ids[0]}` : `shards ${idList([...new Set(ids)])}`;
        if (!commitSent || (!(error instanceof ClaimPausedError) && commitRolledBack(cause))) {
          this.notMoving(`[Database] Not moving to ${target.address} yet: the re-take of ${shards} failed there (${this.moveCause(error)}); this process keeps its unsaved changes and stays stopped`);
        } else {
          const tail = one
            ? `takes ${shards} again if its claim row there still names this process`
            : `takes ${shards} again if their claim rows there still name this process`;
          this.notMoving(`[Database] Not moving to ${target.address} yet: can't confirm whether the re-take of ${shards} reached it (${this.moveCause(error)}); this process keeps its unsaved changes and stays stopped, and the next attempt on ${target.address} ${tail}`);
        }
        return false;
      }
    }
    for (const t of taken) this.replaceClaim(t.before, t.pair.claim);
    this.lanesPaused = false;
    this.deps.store.resume();
    this.lastNotMoving = null;
    const retaken = new Set(taken.map(t => pairKey(t.before)));
    const lost = [...missing.filter(p => !retaken.has(pairKey(p))), ...this.moveLostReserved];
    this.moveLostReserved = [];
    if (lost.length > 0) this.loss(lost);
    return true;
  }

  /** An attempt that ended after (d): the lanes pause again until the next attempt's (d). */
  moveAttemptEnded(): void {
    if (this.lanesPaused) return;
    this.lanesPaused = true;
    this.deps.store.pause();
  }

  /** C4: the pair taken again holds its new claim, and the shard's sets save under it. */
  replaceClaim(before: Pair, claim: number): void {
    const at = this.clocks();
    this.held = this.held.map(p => {
      if (pairKey(p) !== pairKey(before)) return p;
      const next = { ...p, claim };
      this.lastReturned.set(pairKey(next), at);
      return next;
    });
    try { this.deps.replaceShardClaim?.(before.shardId, claim); } catch (error) { this.log.error('[Shards] Could not put the new claim in the fence:', error); }
  }

  private moveCause(error: unknown): string {
    if (error instanceof ClaimPausedError) return `the move stopped while it waited: ${this.databaseStop ?? 'no cause recorded'}`;
    return describeFailureClass(classifyFailure(error));
  }

  private notMoving(line: string): void {
    if (line === this.lastNotMoving) return;
    this.lastNotMoving = line;
    this.log.error(line);
  }

  /** The boot granted its set: the deadline is armed and the work lane may run. */
  noteGranted(): void {
    this.granted = true;
    this.armDeadline();
    if (!this.deps.restartable) this.log.log('[Shards] No web UI process runs to restart this bot process, so it takes shards only when it starts');
  }

  // ---------------------------------------------------------------- work lane

  // The page read goes on after a lapse, a loss and the start of a stop (it takes no lock), so the fleet page stays
  // current; a reservation, a return and a restart request need a serving process outside a stop.
  private async work(): Promise<void> {
    if (this.workRun || this.lanesStopped || this.lanesPaused) return;
    await this.onWorkLane(() => this.workCycle());
  }

  private mayRestart(): boolean {
    return this.deps.restartable && !this.closing && !this.stopped && !this.deps.isStopping();
  }

  private async workCycle(): Promise<void> {
    let page: PageRead;
    try {
      page = await this.deps.store.readPage(this.shardCount);
    } catch (error) {
      if (error instanceof ClaimPausedError) return;
      this.pageReadError = classifyFailure(error);
      // Decision 15's TTL bound and the reservations' restart need no page; a return or move waits for a page read that decides it.
      if (this.mayRestart()) {
        this.askRestart(false);
        this.giveUpStaleReservations(false);
      }
      return;
    }
    this.page = page;
    this.pageReadAt = this.clocks().perf;
    this.pageReadError = null;
    if (!this.mayRestart()) return;
    const unfit = this.deps.fitness();
    if (unfit === null && !this.restartSent) {
      try {
        await this.maybeReserve(page);
      } catch { /* the reservation failed; the next tick tries again */ }
      if (!this.mayRestart()) return;
      if (this.deps.returns) this.decideReturns(page);
    }
    this.askRestart();
    this.giveUpStaleReservations();
  }

  private known(): Pair[] {
    return [...this.held, ...this.reserved.map(({ at: _at, ...p }) => p)];
  }

  private async maybeReserve(page: PageRead): Promise<void> {
    const count = page.shardCount ?? this.shardCount;
    if (count === null) return;
    const plan = planTake({
      me: this.deps.me, capacity: this.deps.capacity, boot: false, known: this.known(), shardCount: count,
      rows: page.rows, nodes: page.nodes, upMs: page.upMs, uPrimeMs: page.uPrimeMs,
    });
    if (plan.takes.length === 0 && count === this.shardCount) return;
    this.everSentTake = true;
    let began = this.clocks();
    const answer = await this.deps.store.take({
      me: this.deps.me, capacity: this.deps.capacity, ttlMs: this.deps.timings.ttlMs, boot: false, known: this.known(),
      localCount: this.shardCount, reserve: true,
    }, () => { began = this.clocks(); });
    if (answer.kind !== 'done') return;
    for (const t of answer.taken) this.reserved.push({ ...t.pair, at: began });
  }

  private decideReturns(page: PageRead): void {
    this.returnList = planReturns({
      me: this.deps.me, capacity: this.deps.capacity, held: this.held, rows: page.rows, nodes: page.nodes, upMs: page.upMs,
    });
  }

  // Runs after askRestart, so the reason is the one that held back the request just tried, never a later fitness read.
  private giveUpStaleReservations(withReturns = true): void {
    if (this.restartSent) return;
    const now = this.clocks();
    const failure = this.pageReadError ?? this.latestFailure;
    const why = this.restartWaiting
      ?? (failure ? `the claims could not be read: ${describeClass(failure)}` : 'the restart request was not sent');
    const keep: typeof this.reserved = [];
    for (const r of this.reserved) {
      if (elapsedMs(r.at, now) >= this.deps.timings.ttlMs) {
        this.log.warn(`[Shards] Gave up the reservation of shard ${r.shardId}: this process could not restart for ${Math.round(elapsedMs(r.at, now) / 1000)} s (${why})`);
      } else keep.push(r);
    }
    if (keep.length === this.reserved.length) return;
    this.reserved = keep;
    const reasons = this.restartReasons(withReturns);
    if (reasons.length === 0) { this.pendingRestart = null; this.restartWaiting = null; }
    else this.pendingRestart = reasons.join('; ');
  }

  private restartReasons(withReturns: boolean): string[] {
    const reasons: string[] = [];
    if (this.reserved.length > 0) reasons.push(`take shard${this.reserved.length > 1 ? 's' : ''} ${this.reserved.map(r => r.shardId).join(', ')}`);
    for (const h of withReturns ? this.returnList : []) {
      const name = this.page?.nodes.find(n => n.nodeId === h.receiver)?.nodeName ?? h.receiver;
      reasons.push(`${h.move ? 'move' : 'return'} shard ${h.shardId} to ${name}`);
    }
    return reasons;
  }

  private askRestart(withReturns = true): void {
    if (this.restartSent || this.closing || this.stopped) return;
    const reasons = this.restartReasons(withReturns);
    if (reasons.length === 0) {
      this.pendingRestart = null;
      this.restartWaiting = null;
      return;
    }
    this.pendingRestart = reasons.join('; ');
    if (this.deps.restartForShards(this.pendingRestart)) {
      this.restartSent = true;
      this.restartWaiting = null;
    } else {
      this.restartWaiting = this.deps.fitness() ?? 'the restart request was not sent';
    }
  }

  // ---------------------------------------------------------------- stop

  /** A stop began: no take, no reservation and no return from now on; the renewal lane goes on through the drain. */
  beginStop(): void {
    this.closing = true;
    if (!this.restartSent) { this.pendingRestart = null; this.restartWaiting = null; }
  }

  /**
   * Decision 13's HTTP 401 after the claims were built: the boot takes nothing, so one last heartbeat says unfit (no
   * other machine counts this one's room), then both lanes stop and the release runs.
   */
  async retire(): Promise<void> {
    this.retired = true;
    this.closing = true;
    if (this.renewing) await this.renewing;
    await this.renewOnce();
    await this.finishStop();
  }

  /**
   * After the exit drain (decision 12): both lanes stop, the work lane's query is destroyed, a renewal on the wire gets
   * up to 2 s, then the release (only when a take or reservation was ever sent) and its lines. A second call waits for
   * the first.
   */
  finishStop(): Promise<void> {
    this.finishing ??= this.runFinishStop();
    return this.finishing;
  }

  private async runFinishStop(): Promise<void> {
    this.closing = true;
    this.lanesStopped = true;
    if (this.renewTimer) { clearInterval(this.renewTimer); this.renewTimer = null; }
    if (this.deadlineTimer) { clearTimeout(this.deadlineTimer); this.deadlineTimer = null; }
    this.deps.store.abandonWork();
    if (this.renewing) {
      const settled = await Promise.race([this.renewing.then(() => true), sleep(2000).then(() => false)]);
      if (!settled) this.deps.store.abandonRenewal();
    }
    if (!this.everSentTake) return;
    const asked = [...this.known(), ...this.lostAtStop];
    const reserved = this.reserved.map(({ at: _at, ...p }) => p);
    const heldShards = new Set(this.held.map(p => p.shardId));
    const handOvers = this.returnList.filter(h => heldShards.has(h.shardId));
    let sent = false;
    let connected = false;
    const refusal = this.deps.releaseRefusal?.() ?? null;
    if (refusal !== null) {
      this.log.warn(notReleasedLine(asked, refusal, this.deps.timings.ttlMs));
      this.held = [];
      this.reserved = [];
      return;
    }
    try {
      const rows = await this.deps.store.release(
        { me: this.deps.me, reserved, handOvers, ttlMs: this.deps.timings.ttlMs },
        () => { sent = true; },
        () => { connected = true; },
      );
      for (const line of releaseLines(asked, reserved, rows, this.deps.timings.ttlMs)) this.log.log(line);
      if (this.shardCount !== null && this.deps.noteKeptAtStop) {
        try {
          const returned = new Set(rows.map(r => `${r.shardId}:${r.claim}`));
          const dropped = [...new Set([...asked.filter(p => !returned.has(`${p.shardId}:${p.claim}`)).map(p => p.shardId), ...rows.filter(r => r.handedTo !== null).map(r => r.shardId)])];
          this.deps.noteKeptAtStop(this.shardCount, rows.filter(r => r.handedTo === null).map(r => r.shardId), dropped);
        } catch (error) {
          this.log.error('[Shards] Could not record the shards the release kept for this machine:', error instanceof Error ? error.message : error);
        }
      }
    } catch (error) {
      if (error instanceof ClaimPausedError) this.log.error(releaseFailureLine(asked, classifyFailure(error), sent, connected, this.databaseStop));
      else this.log.error(releaseFailureLine(this.known(), classifyFailure(error), sent, connected));
    }
    this.held = [];
    this.reserved = [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { const t = setTimeout(resolve, ms); t.unref?.(); });
}

function seconds(ms: number): string {
  return String(Math.round(ms / 100) / 10);
}

export function copiedIdLine(nodeId: string): string {
  return `[Shards] Another bot process with this machine's id (${nodeId}) writes this machine's row; a copied /data/global/fleet/node.json gives two machines one id`;
}

/** Decision 5's classes in the operator's words, for the log lines. */
export function describeFailureClass(failure: FailureClass): string {
  switch (failure.kind) {
    case 'refused': return 'refused';
    case 'timeout': return 'timeout';
    case 'unreachable': return 'unreachable';
    default: return `error: SQLSTATE ${failure.code} ${failure.message}`;
  }
}

const idList = (ids: number[]): string => [...ids].sort((a, b) => a - b).join(', ');

/** Decision 12's completed lines, built from what the release statement returned. */
export function releaseLines(asked: Pair[], reserved: Pair[], rows: Array<{ shardId: number; claim: number; wasReserved: boolean; handedTo: string | null }>, ttlMs: number): string[] {
  const lines: string[] = [];
  const ttl = Math.round(ttlMs / 1000);
  const kept = rows.filter(r => !r.wasReserved && r.handedTo === null).map(r => r.shardId);
  const keptReserved = rows.filter(r => r.wasReserved).map(r => r.shardId);
  if (kept.length > 0) lines.push(`[Shards] Released shards ${idList(kept)}: kept for this machine's next start for ${ttl} s, then free to any machine with room`);
  if (keptReserved.length > 0) lines.push(`[Shards] Reserved shards ${idList(keptReserved)} stay kept for this machine's next start for ${ttl} s, then free to any machine with room`);
  for (const r of rows) if (r.handedTo !== null && !r.wasReserved) lines.push(`[Shards] Handed shard ${r.shardId} to ${r.handedTo}`);
  const returned = new Set(rows.map(r => `${r.shardId}:${r.claim}`));
  void reserved;
  for (const pair of asked) {
    if (!returned.has(`${pair.shardId}:${pair.claim}`)) lines.push(`[Shards] Shard ${pair.shardId} was no longer held by this process at the release`);
  }
  return lines;
}

/**
 * Decision 12's failure lines: a COMMIT sent with no answer (or answered in a way that ends the session: commitMayHaveLanded),
 * a server error (a rolled-back transaction), no connection, or a connection that failed before its COMMIT was sent.
 */
export function releaseFailureLine(asked: Pair[], failure: FailureClass, sent: boolean, connected = false, pausedWhy?: string | null): string {
  if (pausedWhy !== undefined) return pausedReleaseLine(asked, sent, pausedWhy);
  if (asked.length === 0) return `[Shards] The release did not complete (${describeFailureClass(failure)}); any shard row still naming this process frees once its claim expires`;
  const ids = `shards ${idList(asked.map(p => p.shardId))}`;
  const tail = 'any machine with room may take them once their claims expire';
  if (sent && failure.kind === 'error' && failure.severity !== undefined) return `[Shards] The release of ${ids} was answered by an error that may follow a landed COMMIT (${describeFailureClass(failure)}); it may still have applied, and otherwise ${tail}`;
  if (sent && (failure.kind === 'timeout' || failure.kind === 'unreachable')) return `[Shards] The release of ${ids} got no answer within 2 s (${describeFailureClass(failure)}); it may still have applied, and otherwise ${tail}`;
  if (failure.kind === 'error') return `[Shards] Could not release ${ids} (SQLSTATE ${failure.code} ${failure.message}); ${tail}`;
  if (failure.kind === 'refused') return `[Shards] Could not release ${ids} (the database refused the login); ${tail}`;
  if (!sent && !connected) return `[Shards] Could not reach the database to release ${ids} (${describeFailureClass(failure)}); ${tail}`;
  return `[Shards] The release of ${ids} got no answer before its COMMIT was sent (${describeFailureClass(failure)}), so it did not apply; ${tail}`;
}

/** NB5 E3: a release the claims' pause met, chosen by whether COMMIT was sent; the failure class is not read. */
function pausedReleaseLine(asked: Pair[], sent: boolean, why: string | null): string {
  const cause = why === null ? '' : ` (${why})`;
  const ids = asked.length === 0 ? null : `shards ${idList([...new Set(asked.map(p => p.shardId))])}`;
  const freed = 'any shard row still naming this process frees once its claim expires';
  if (sent) {
    return ids === null
      ? `[Shards] Can't confirm whether the release applied: this process stopped writing to its database while the release waited for its answer${cause}; ${freed}`
      : `[Shards] Can't confirm whether the release of ${ids} applied: this process stopped writing to its database while the release waited for its answer${cause}; if it did not apply, any machine with room may take them once their claims expire`;
  }
  return ids === null
    ? `[Shards] The release did not apply: this process stopped writing to its database before the release sent its COMMIT${cause}; ${freed}`
    : `[Shards] The release of ${ids} did not apply: this process stopped writing to its database before the release sent its COMMIT${cause}; any machine with room may take them once their claims expire`;
}

/** NB5 decision 11 and D6: the release skipped because the process does not write to its database. */
export function notReleasedLine(asked: Pair[], why: string, ttlMs: number): string {
  const ids = [...new Set(asked.map(p => p.shardId))].sort((a, b) => a - b);
  const ttl = Math.round(ttlMs / 1000);
  if (ids.length === 0) return `[Shards] The release was not sent: ${why}; any shard row still naming this process frees once its claim expires`;
  if (ids.length === 1) return `[Shards] Shard ${ids[0]} was not released: ${why}; its claim expires after ${ttl} s`;
  return `[Shards] Shards ${idList(ids)} were not released: ${why}; their claims expire after ${ttl} s`;
}

/** Decision 16's loss line for one pair, from the row read after the leave started. */
export function lossLine(
  pair: Pair,
  read: { row: { claim: number; holderName: string; holderProcess: string; takenAt: number } | null; storedCount: number | null } | null,
  cause: string,
  processId: string,
  lastReturnedAt: number | null,
): string {
  if (!read) return `[Shards] Shard ${pair.shardId} is no longer held by this process; its claim row could not be read (${cause || 'no answer'})`;
  if (!read.row) return `[Shards] Shard ${pair.shardId} has no claim row under ${pair.shardCount} shards (the database now runs ${read.storedCount ?? 'no count'}); this process's claim ${pair.claim} is gone`;
  const row = read.row;
  const taken = row.holderProcess !== processId && lastReturnedAt !== null && row.takenAt > lastReturnedAt;
  return `[Shards] Shard ${pair.shardId}'s claim row holds claim ${row.claim} of ${row.holderName} (process ${row.holderProcess}), not this process's claim ${pair.claim}${taken ? '; it was taken while this process could not renew it' : ''}`;
}
