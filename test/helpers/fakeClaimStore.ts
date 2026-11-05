import {
  applyRenewal,
  decideShardCount,
  planTake,
  qualifiesAsReceiver,
  nodeRoom,
  uPrime,
  type ClaimRow,
  type ClockRow,
  type NodeRow,
  type Pair,
} from '../../src/bot/internalSetup/fleet/claimRules';
import { ClaimTimeoutError } from '../../src/bot/internalSetup/fleet/claimStore';
import type {
  ClaimStoreApi,
  PageRead,
  ReleaseRequest,
  ReleasedRow,
  RenewAnswer,
  RenewRequest,
  TakeAnswer,
  TakeRequest,
} from '../../src/bot/internalSetup/fleet/claimStore';

// NB4's claims table in memory, over the same pure rules the SQL matches (claimRules.ts). One database clock, moved by
// the test; a lane can be scripted to fail, hang until released, or answer.

export type LaneMode = 'ok' | 'hang' | Error;
const key = (count: number, shard: number) => `${count}:${shard}`;

export class MemClaimStore implements ClaimStoreApi {
  rows = new Map<string, ClaimRow>();
  nodes = new Map<string, NodeRow & { seenAt: number; healthySince: number | null }>();
  clock: ClockRow;
  count: number | null = null;
  seq = 0;
  guildFloor = 0;
  dbNow: () => number;
  renewMode: LaneMode = 'ok';
  takeMode: LaneMode = 'ok';
  releaseMode: LaneMode = 'ok';
  /** A failure before the connection, so the release was never sent. */
  releaseUnsent = false;
  /** Where releaseMode acts: 'statement' in the lock wait or statement, before the COMMIT is sent; 'commit' after it. */
  releaseFailsAt: 'statement' | 'commit' = 'statement';
  readMode: LaneMode = 'ok';
  renewals: RenewRequest[] = [];
  takes: TakeRequest[] = [];
  releases: ReleaseRequest[] = [];
  abandoned = { work: 0, renewal: 0 };
  /** Page reads sent. */
  reads = 0;
  /**
   * The client bounds of the real store: a call still hung at its bound rejects with ClaimTimeoutError and its connection
   * counts as destroyed. Null bounds hang until released.
   */
  bounds: { renewMs: number; workMs: number } | null = null;
  /** A take hung on the wire commits just before its connection is destroyed; otherwise the destroy rolls it back. */
  takeCommitsAtDestroy = false;
  /** The client bound's error; a test that loads the claims modules fresh passes that module's class. */
  timeoutError: (what: string) => Error = what => new ClaimTimeoutError(what);
  private readonly hung: Array<() => void> = [];
  private readonly onWire: Array<{ go: () => void; lane: 'renewal' | 'work'; fail: (error: Error) => void; atDestroy?: () => void }> = [];
  /** The advisory lock a take holds until it commits or rolls back; a release waits for it. */
  private takeLock: Promise<void> | null = null;

  constructor(dbNow: () => number = () => Date.now()) {
    this.dbNow = dbNow;
    this.clock = { upMs: 0, tickedAt: dbNow(), lastGapMs: 0 };
  }

  /** Lets every hung call go on to its answer. */
  releaseHung(): void {
    for (const go of this.hung.splice(0)) go();
  }

  /** Lets the oldest hung call go on to its answer. */
  releaseFirst(): void {
    this.hung.shift()?.();
  }

  private async lane(mode: LaneMode, which?: 'renewal' | 'work', opts: { boundMs?: number; atDestroy?: () => void } = {}): Promise<void> {
    if (mode instanceof Error) throw mode;
    if (mode !== 'hang') return;
    const bound = which && this.bounds ? (opts.boundMs ?? (which === 'renewal' ? this.bounds.renewMs : this.bounds.workMs)) : null;
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const forget = () => {
        if (timer) clearTimeout(timer);
        const at = this.hung.indexOf(go);
        if (at >= 0) this.hung.splice(at, 1);
        const wire = this.onWire.findIndex(e => e.go === go);
        if (wire >= 0) this.onWire.splice(wire, 1);
      };
      const go = () => { forget(); resolve(); };
      this.hung.push(go);
      if (which) this.onWire.push({ go, lane: which, fail: error => { forget(); reject(error); }, atDestroy: opts.atDestroy });
      if (bound !== null && which) {
        timer = setTimeout(() => {
          forget();
          this.abandoned[which] += 1;
          reject(this.timeoutError(which === 'renewal' ? 'the claim renewal' : 'the work lane'));
        }, bound);
      }
    });
  }

  /** As node-pg's release(true): the lane's query on the wire rejects, and the server commits or rolls it back. */
  private destroy(which: 'renewal' | 'work'): void {
    for (const entry of this.onWire.filter(e => e.lane === which)) {
      entry.atDestroy?.();
      entry.fail(new Error('Connection terminated'));
    }
  }

  activeRows(): ClaimRow[] {
    return [...this.rows.values()].filter(r => r.shardCount === this.count);
  }

  nodeRows(now: number): NodeRow[] {
    return [...this.nodes.values()].map(n => ({ ...n, seenAgoMs: now - n.seenAt, healthyForMs: n.healthySince === null ? null : now - n.healthySince }));
  }

  async renew(request: RenewRequest): Promise<RenewAnswer> {
    this.renewals.push(structuredClone(request));
    await this.lane(this.renewMode, 'renewal');
    const now = this.dbNow();
    const prior = this.nodes.get(request.me.nodeId);
    const hb = request.heartbeat;
    const healthySince = !hb.fit ? null
      : !prior || !prior.fit || prior.healthySince === null || prior.processId !== request.me.processId || prior.seenAt <= now - prior.takeoverSeconds * 1000
        ? now : prior.healthySince;
    const { clock, returned } = applyRenewal([...this.rows.values()], this.clock, now, request.me.processId, request.pairs, request.ttlMs);
    this.clock = clock;
    this.nodes.set(request.me.nodeId, {
      nodeId: request.me.nodeId, nodeName: request.me.nodeName, processId: request.me.processId, capacity: hb.capacity,
      takeoverSeconds: hb.takeoverSeconds, fit: hb.fit, restartable: hb.restartable, returns: hb.returns, seenAgoMs: 0,
      healthyForMs: null, seenAt: now, healthySince,
    });
    return {
      at: now,
      priorProcess: prior?.processId ?? null,
      rows: returned.map(({ row, mine }) => ({ shardCount: row.shardCount, shardId: row.shardId, claim: row.claim, released: row.released, mine })),
    };
  }

  async take(request: TakeRequest, onBegin?: () => void): Promise<TakeAnswer> {
    this.takes.push({ ...request, copied: request.copied ? new Set(request.copied) : undefined });
    onBegin?.();
    while (this.takeLock) await this.takeLock;
    let unlock: () => void = () => undefined;
    const lock = new Promise<void>(resolve => { unlock = resolve; });
    this.takeLock = lock;
    try {
      await this.lane(this.takeMode, 'work', { atDestroy: () => { if (this.takeCommitsAtDestroy) this.commitTake(request); } });
      return this.commitTake(request);
    } finally {
      if (this.takeLock === lock) this.takeLock = null;
      unlock();
    }
  }

  private commitTake(request: TakeRequest): TakeAnswer {
    const now = this.dbNow();
    const upMs = this.clock.upMs;
    const uPrimeMs = uPrime(this.clock, now);
    const stored = this.count;
    const decision = decideShardCount(stored, request.localCount, [...this.rows.values()].filter(r => r.shardCount === stored), upMs);
    if (decision.kind === 'need-count') return decision;
    if (decision.write) this.count = decision.count;
    if (decision.deleteOthers) for (const [k, r] of this.rows) if (r.shardCount !== decision.count) this.rows.delete(k);
    const rows = this.activeRows();
    const plan = planTake({
      me: request.me, capacity: request.capacity, boot: request.boot, known: request.known, shardCount: decision.count,
      rows, nodes: this.nodeRows(now), upMs, uPrimeMs, copied: request.copied,
    });
    const predecessorRenewedAt = new Map<number, number>();
    if (request.boot) for (const r of rows) if (r.holderNode === request.me.nodeId && r.holderProcess !== request.me.processId && !r.released) predecessorRenewedAt.set(r.shardId, r.renewedAt);
    const taken: Array<{ pair: Pair; above: 'own' | 'no-room' | null }> = [];
    let floor = Math.max(this.guildFloor, ...[...this.rows.values()].map(r => r.claim), 0);
    for (const pick of plan.takes) {
      let claim = ++this.seq;
      if (claim <= floor) { claim = floor + 1; this.seq = claim; }
      floor = claim;
      const prev = pick.row;
      this.rows.set(key(decision.count, pick.shardId), {
        shardCount: decision.count, shardId: pick.shardId, claim, holderProcess: request.me.processId,
        holderNode: request.me.nodeId, holderName: request.me.nodeName, homeNode: prev?.homeNode ?? request.me.nodeId,
        released: request.reserve, reserved: request.reserve, takenAt: now, renewedAt: now, ttlMs: request.ttlMs,
        expiresUpMs: uPrimeMs + request.ttlMs, extended: false,
      });
      taken.push({ pair: { shardCount: decision.count, shardId: pick.shardId, claim }, above: pick.above });
    }
    return { kind: 'done', shardCount: decision.count, taken, plan, adopted: decision.adopted ? { local: decision.adopted.local, stored: decision.count } : null, predecessorRenewedAt };
  }

  async release(request: ReleaseRequest, onSent?: () => void, onConnected?: () => void): Promise<ReleasedRow[]> {
    this.releases.push(structuredClone(request));
    if (this.releaseUnsent && this.releaseMode instanceof Error) throw this.releaseMode;
    onConnected?.();
    while (this.takeLock) await this.takeLock;
    if (this.releaseFailsAt === 'statement') await this.lane(this.releaseMode);
    onSent?.();
    if (this.releaseFailsAt === 'commit') await this.lane(this.releaseMode);
    const now = this.dbNow();
    const u = uPrime(this.clock, now);
    const all = [...this.rows.values()];
    const nodes = this.nodeRows(now);
    const room = new Map<string, number>();
    for (const n of nodes) if (qualifiesAsReceiver(n, all, this.clock.upMs)) room.set(n.nodeId, nodeRoom(n, all, this.clock.upMs));
    const reserved = new Set(request.reserved.map(p => key(p.shardCount, p.shardId) + ':' + p.claim));
    const out: ReleasedRow[] = [];
    for (const row of all) {
      if (row.holderProcess !== request.me.processId) continue;
      const wasReleased = row.released;
      if (wasReleased && !reserved.has(key(row.shardCount, row.shardId) + ':' + row.claim)) continue;
      const hand = wasReleased ? undefined : request.handOvers.find(h => h.shardId === row.shardId && (room.get(h.receiver) ?? 0) > 0);
      const receiver = hand ? nodes.find(n => n.nodeId === hand.receiver)! : null;
      if (hand) room.set(hand.receiver, room.get(hand.receiver)! - 1);
      const ttl = receiver ? receiver.takeoverSeconds * 1000 : request.ttlMs;
      Object.assign(row, {
        released: true, reserved: false, extended: false,
        holderNode: receiver?.nodeId ?? request.me.nodeId, holderName: receiver?.nodeName ?? request.me.nodeName,
        homeNode: hand?.move ? receiver!.nodeId : row.homeNode, ttlMs: ttl, expiresUpMs: u + ttl,
      });
      out.push({ shardId: row.shardId, claim: row.claim, wasReserved: wasReleased, handedTo: receiver?.nodeName ?? null });
    }
    return out;
  }

  async readPage(): Promise<PageRead> {
    this.reads += 1;
    await this.lane(this.readMode, 'work');
    const now = this.dbNow();
    return {
      shardCount: this.count, upMs: this.clock.upMs, uPrimeMs: uPrime(this.clock, now),
      rows: this.activeRows().map(r => ({ ...r, renewedAgoMs: now - r.renewedAt })), nodes: this.nodeRows(now),
    };
  }

  async readRow(shardCount: number, shardId: number) {
    await this.lane(this.readMode, 'work', { boundMs: this.bounds?.renewMs });
    const row = this.rows.get(key(shardCount, shardId));
    return { row: row ? { ...row } : null, storedCount: this.count };
  }

  abandonWork(): void { this.abandoned.work += 1; this.destroy('work'); }
  abandonRenewal(): void { this.abandoned.renewal += 1; this.destroy('renewal'); }
  async end(): Promise<void> { /* nothing to close */ }
}
