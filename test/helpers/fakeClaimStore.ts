import { randomUUID } from 'crypto';
import {
  applyRenewal,
  planRetake,
  planTake,
  qualifiesAsReceiver,
  nodeRoom,
  nodeSeen,
  uPrime,
  type ClaimRow,
  type ClockRow,
  type NodeRow,
  type Pair,
} from '../../src/bot/internalSetup/fleet/claimRules';
import { ClaimPausedError, ClaimTimeoutError } from '../../src/bot/internalSetup/fleet/claimStore';
import type {
  ClaimStoreApi,
  PageRead,
  RedrawAnswer,
  RedrawRequest,
  ReleaseRequest,
  ReleasedRow,
  RenewAnswer,
  RenewRequest,
  RetakeAnswer,
  RetakeRequest,
  StandbyRenewRequest,
  StandbyTakeAnswer,
  StandbyTakeRequest,
  TakeAnswer,
  TakeRequest,
  WorkClient,
} from '../../src/bot/internalSetup/fleet/claimStore';

// NB4's claims table in memory, over the same pure rules the SQL matches (claimRules.ts). One database clock, moved by
// the test; a lane can be scripted to fail, hang until released, or answer.

export type LaneMode = 'ok' | 'hang' | Error;
const key = (count: number, shard: number) => `${count}:${shard}`;
import { spread, takeGateVerdict, type GateRead } from '../../src/bot/internalSetup/fleet/reshardRules';

export class MemClaimStore implements ClaimStoreApi {
  rows = new Map<string, ClaimRow>();
  nodes = new Map<string, NodeRow & { seenAt: number; healthySince: number | null; countSetting?: number | null }>();
  clock: ClockRow;
  count: number | null = null;
  /** The reshard row as step (1) of NB9's take gate reads it; provisioning's seed holds no attempt. */
  reshard: Omit<GateRead, 'metaCount'> = { attempt: null, state: null, fromCount: null, toCount: null };
  seq = 0;
  guildFloor = 0;
  dbNow: () => number;
  renewMode: LaneMode = 'ok';
  /** Where renewMode acts: before the statement applies ('statement'), or after it committed, a lost reply ('reply'). */
  renewFailsAt: 'statement' | 'reply' = 'statement';
  /** NB9 31 and 52: each target the renewal's CTE wrote, with the process whose heartbeat wrote it. */
  targetWrites: Array<{ processId: string; target: number | null }> = [];
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
  /** NB5 D1's gate, as the real store's: the pause count read when a call began, compared after its connect and at its answer. */
  paused = false;
  pauseCount = 0;
  /** 'hang' holds every connect (not yet on a lane) until releaseConnects(). */
  connectMode: 'ok' | 'hang' = 'ok';
  /** The pause error; a test that loads the claims modules fresh passes that module's class. */
  pausedError: () => Error = () => new ClaimPausedError();
  retakeMode: LaneMode = 'ok';
  /** Where retakeMode acts: before onCommitSent ('statement') or after it ('commit'). */
  retakeFailsAt: 'statement' | 'commit' = 'commit';
  retakes: RetakeRequest[] = [];
  redraws: RedrawRequest[] = [];
  /** The generation table's rows; null holds exactly the generation a re-take targets (none at 0). */
  generations: number[] | null = null;
  /** smdb_data.guild_ownership's claims, for the re-take's rule. */
  guildClaims: Array<{ guildId: string; shardCount: number; shardId: number; claim: number }> = [];
  private readonly connects: Array<() => void> = [];
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

  /** Lets every held connect go on. */
  releaseConnects(): void {
    for (const go of this.connects.splice(0)) go();
  }

  /** The real store's gate around one call: refused while paused unless it is the move's, dropped once the count moved. */
  private async gated<T>(move: boolean, fn: () => Promise<T>): Promise<T> {
    if (this.paused && !move) throw this.pausedError();
    const count = this.pauseCount;
    if (this.connectMode === 'hang') await new Promise<void>(resolve => { this.connects.push(resolve); });
    if (this.pauseCount !== count) throw this.pausedError();
    let answer: T;
    try {
      answer = await fn();
    } catch (error) {
      if (this.pauseCount !== count) throw this.pausedError();
      throw error;
    }
    if (this.pauseCount !== count) throw this.pausedError();
    return answer;
  }

  pause(): void {
    this.paused = true;
    this.pauseCount += 1;
    this.destroy('renewal');
    this.destroy('work');
  }

  resume(): void {
    this.paused = false;
  }

  private async lane(mode: LaneMode, which?: 'renewal' | 'work', opts: { boundMs?: number; atDestroy?: () => void; destroyAtBound?: boolean } = {}): Promise<void> {
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
          if (opts.destroyAtBound) opts.atDestroy?.();
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

  renew(request: RenewRequest, opts: { move?: boolean } = {}): Promise<RenewAnswer> {
    return this.gated(opts.move === true, () => this.renewIn(request));
  }

  private async renewIn(request: RenewRequest): Promise<RenewAnswer> {
    this.renewals.push(structuredClone(request));
    if (this.renewFailsAt === 'statement') await this.lane(this.renewMode, 'renewal');
    const now = this.dbNow();
    const prior = this.nodes.get(request.me.nodeId);
    const hb = request.heartbeat;
    const healthySince = !hb.fit ? null
      : !prior || !prior.fit || prior.healthySince === null || prior.processId !== request.me.processId || prior.seenAt <= now - prior.takeoverSeconds * 1000
        ? now : prior.healthySince;
    const { clock, returned } = applyRenewal([...this.rows.values()], this.clock, now, request.me.processId, request.pairs, request.ttlMs);
    this.clock = clock;
    const setting = hb.countSetting ?? null;
    this.nodes.set(request.me.nodeId, {
      nodeId: request.me.nodeId, nodeName: request.me.nodeName, processId: request.me.processId, capacity: hb.capacity,
      takeoverSeconds: hb.takeoverSeconds, fit: hb.fit, restartable: hb.restartable, returns: hb.returns, seenAgoMs: 0,
      healthyForMs: null, seenAt: now, healthySince, countSetting: setting,
    });
    // NB9 31 and 52: the target CTE, on this process's edge, when the pre-read found the row with another setting.
    let targetWritten: RenewAnswer['targetWritten'] = null;
    if (hb.targetEdge === true && prior && (prior.countSetting ?? null) !== setting) {
      this.reshard = { ...this.reshard, target: setting, targetBy: request.me.nodeName, targetAt: now };
      this.targetWrites.push({ processId: request.me.processId, target: setting });
      targetWritten = { from: prior.countSetting ?? null, to: setting };
    }
    if (this.renewFailsAt === 'reply') await this.lane(this.renewMode, 'renewal');
    return {
      at: now,
      priorProcess: prior?.processId ?? null,
      rows: returned.map(({ row, mine }) => ({ shardCount: row.shardCount, shardId: row.shardId, claim: row.claim, released: row.released, mine })),
      ...(targetWritten ? { targetWritten } : {}),
    };
  }

  take(request: TakeRequest, onBegin?: () => void): Promise<TakeAnswer> {
    return this.gated(false, () => this.takeIn(request, onBegin));
  }

  /** NB9 29 and 59: the redraw through the gate, over the rows as the real statement matches them; takeMode acts on it. */
  redraw(request: RedrawRequest, onBegin?: () => void): Promise<RedrawAnswer> {
    return this.gated(false, async () => {
      this.redraws.push(structuredClone(request));
      onBegin?.();
      while (this.takeLock) await this.takeLock;
      let unlock: () => void = () => undefined;
      const lock = new Promise<void>(resolve => { unlock = resolve; });
      this.takeLock = lock;
      try {
        await this.lane(this.takeMode, 'work');
        return this.commitRedraw(request);
      } finally {
        if (this.takeLock === lock) this.takeLock = null;
        unlock();
      }
    });
  }

  private commitRedraw(request: RedrawRequest): RedrawAnswer {
    const now = this.dbNow();
    const upMs = this.clock.upMs;
    const read: GateRead = { ...this.reshard, metaCount: this.count };
    const verdict = takeGateVerdict(
      { boot: false, firstTake: false, localCount: null, count: request.shardCount },
      read,
      [...this.rows.values()].map(r => ({ shardCount: r.shardCount, shardId: r.shardId, released: r.released, expiresUpMs: r.expiresUpMs, holderName: r.holderName })),
      upMs,
    );
    if (verdict.kind === 'need-count' || verdict.kind === 'count') return { kind: 'count', read };
    if (verdict.kind === 'held') return { kind: 'held', read, rows: verdict.rows.map(r => ({ shardCount: r.shardCount, shardId: r.shardId, holderName: r.holderName })) };
    for (const d of verdict.deleted) this.rows.delete(key(d.shardCount, d.shardId));
    let floor = Math.max(this.guildFloor, ...[...this.rows.values()].map(r => r.claim), 0);
    const pairs: Pair[] = [];
    for (const shardId of request.shardIds) {
      let claim = ++this.seq;
      if (claim <= floor) { claim = floor + 1; this.seq = claim; }
      floor = claim;
      const row = this.rows.get(key(request.shardCount, shardId));
      if (!row || row.holderProcess !== request.me.processId || row.released || row.expiresUpMs <= upMs) continue;
      Object.assign(row, { claim, takenAt: now, renewedAt: now, ttlMs: request.ttlMs, expiresUpMs: uPrime(this.clock, now) + request.ttlMs, extended: false });
      pairs.push({ shardCount: request.shardCount, shardId, claim });
    }
    let closed: { fromCount: number; toCount: number; expired: number[] } | null = null;
    if (verdict.close) {
      closed = { fromCount: read.fromCount ?? 0, toCount: verdict.n, expired: verdict.deleted.filter(d => !d.released && d.shardCount === read.fromCount).map(d => d.shardId) };
      this.reshard = { ...this.reshard, state: 'done' };
    }
    return { kind: 'done', pairs, closed };
  }

  /** NB5 D7: the move's re-take of the pairs its renewal did not return, by planRetake over these rows. */
  retake(request: RetakeRequest, onCommitSent?: () => void): Promise<RetakeAnswer> {
    return this.gated(true, async () => {
      this.retakes.push(structuredClone(request));
      while (this.takeLock) await this.takeLock;
      let unlock: () => void = () => undefined;
      const lock = new Promise<void>(resolve => { unlock = resolve; });
      this.takeLock = lock;
      try {
        if (this.retakeFailsAt === 'statement') await this.lane(this.retakeMode, 'work');
        onCommitSent?.();
        let committed: RetakeAnswer | null = null;
        const commit = () => { committed ??= this.commitRetake(request); return committed; };
        if (this.retakeFailsAt === 'commit') {
          await this.lane(this.retakeMode, 'work', { destroyAtBound: true, atDestroy: () => { if (this.takeCommitsAtDestroy) commit(); } });
        }
        return commit();
      } finally {
        if (this.takeLock === lock) this.takeLock = null;
        unlock();
      }
    });
  }

  private commitRetake(request: RetakeRequest): RetakeAnswer {
    const now = this.dbNow();
    const uPrimeMs = uPrime(this.clock, now);
    const shardIds = new Set(request.pairs.map(p => p.shardId));
    // NB9 58 and D9: the re-take through the take gate, as the real store sends it.
    const read: GateRead = { ...this.reshard, metaCount: this.count };
    const verdict = takeGateVerdict(
      { boot: false, firstTake: false, localCount: null, count: request.shardCount },
      read,
      [...this.rows.values()].map(r => ({ shardCount: r.shardCount, shardId: r.shardId, released: r.released, expiresUpMs: r.expiresUpMs, holderName: r.holderName })),
      this.clock.upMs,
    );
    if (verdict.kind === 'need-count' || verdict.kind === 'count') return { taken: [], refused: { kind: 'count', read } };
    if (verdict.kind === 'held') return { taken: [], refused: { kind: 'held', read, rows: verdict.rows.map(r => ({ shardCount: r.shardCount, shardId: r.shardId, holderName: r.holderName })) } };
    for (const d of verdict.deleted) this.rows.delete(key(d.shardCount, d.shardId));
    if (verdict.close) this.reshard = { ...this.reshard, state: 'done' };
    const all = [...this.rows.values()];
    const picks = planRetake({
      me: request.me, pairs: request.pairs, guildIds: request.guildIds, generation: request.generation,
      generations: this.generations ?? (request.generation === 0 ? [] : [request.generation]),
      rows: all.filter(r => shardIds.has(r.shardId)), counts: [request.shardCount], guildClaims: this.guildClaims,
    });
    let floor = Math.max(this.guildFloor, ...all.map(r => r.claim), ...this.guildClaims.map(g => g.claim), 0);
    const taken: RetakeAnswer['taken'] = [];
    for (const { pair, row } of picks) {
      let claim = ++this.seq;
      if (claim <= floor) { claim = floor + 1; this.seq = claim; }
      floor = claim;
      this.rows.set(key(pair.shardCount, pair.shardId), {
        shardCount: pair.shardCount, shardId: pair.shardId, claim, holderProcess: request.me.processId,
        holderNode: request.me.nodeId, holderName: request.me.nodeName, homeNode: row?.homeNode ?? request.me.nodeId,
        released: false, reserved: false, takenAt: now, renewedAt: now, ttlMs: request.ttlMs,
        expiresUpMs: uPrimeMs + request.ttlMs, extended: false,
      });
      taken.push({ before: pair, pair: { ...pair, claim } });
    }
    return { taken };
  }

  private async takeIn(request: TakeRequest, onBegin?: () => void): Promise<TakeAnswer> {
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
    const read: GateRead = { ...this.reshard, metaCount: this.count };
    const verdict = takeGateVerdict(
      { boot: request.boot, firstTake: true, localCount: request.localCount, writesMeta: request.writesMeta },
      read,
      [...this.rows.values()].map(r => ({ shardCount: r.shardCount, shardId: r.shardId, released: r.released, expiresUpMs: r.expiresUpMs, holderName: r.holderName })),
      upMs,
    );
    if (verdict.kind === 'need-count' || verdict.kind === 'count') return verdict;
    if (verdict.kind === 'held') return { kind: 'held', read, rows: verdict.rows.map(r => ({ shardCount: r.shardCount, shardId: r.shardId, holderName: r.holderName })) };
    const decision = { count: verdict.n };
    if (verdict.writeMeta) this.count = verdict.n;
    if (verdict.writeMeta && !request.writesMeta && request.countSetting !== undefined && request.countSetting !== null) {
      this.reshard = { ...this.reshard, target: request.countSetting, targetBy: request.me.nodeName, targetAt: now };
    }
    for (const d of verdict.deleted) this.rows.delete(key(d.shardCount, d.shardId));
    if (request.writesMeta) this.reshard = { ...this.reshard, state: 'done', fromCount: request.writesMeta.kind === 'direct' ? request.writesMeta.from : this.reshard.fromCount, toCount: verdict.n };
    let closed: { fromCount: number; toCount: number; expired: number[] } | null = null;
    if (verdict.close) {
      closed = { fromCount: read.fromCount ?? 0, toCount: verdict.n, expired: verdict.deleted.filter(d => !d.released && d.shardCount === read.fromCount).map(d => d.shardId) };
      this.reshard = { ...this.reshard, state: 'done' };
    }
    const rows = this.activeRows();
    const nodes = this.nodeRows(now);
    let plan = planTake({
      me: request.me, capacity: request.capacity, boot: request.boot, known: request.known, shardCount: decision.count,
      rows, nodes, upMs, uPrimeMs, copied: request.copied,
    });
    let spreadResult: Extract<TakeAnswer, { kind: 'done' }>['spread'] = null;
    if (request.writesMeta) {
      // NB9 12 and 36, as the real store writes them: this machine's share taken, the rest released and kept.
      const others = nodes.filter(n => n.nodeId !== request.me.nodeId && n.restartable && nodeSeen(n));
      const mine = { nodeId: request.me.nodeId, nodeName: request.me.nodeName, capacity: request.capacity, takeoverSeconds: 0 };
      const owners = spread(decision.count, mine, others);
      const byShard = new Map(rows.map(r => [r.shardId, r]));
      const takes = owners.flatMap((id, s) => (id === request.me.nodeId ? [{ shardId: s, row: byShard.get(s) ?? null, above: null }] : []));
      plan = { takes, wait: null, heldElsewhere: 0, elsewhere: [], waitingForOwner: 0, leftToOthers: owners.length - takes.length };
      const attempt = request.writesMeta.kind === 'change' ? request.writesMeta.attempt : randomUUID();
      const kept = new Map<string, { nodeName: string; shardIds: number[]; seconds: number }>();
      let floorKept = Math.max(this.guildFloor, ...[...this.rows.values()].map(r => r.claim), 0);
      owners.forEach((nodeId, shardId) => {
        if (nodeId === request.me.nodeId) return;
        const node = others.find(n => n.nodeId === nodeId)!;
        let claim = ++this.seq;
        if (claim <= floorKept) { claim = floorKept + 1; this.seq = claim; }
        floorKept = claim;
        this.rows.set(key(decision.count, shardId), {
          shardCount: decision.count, shardId, claim, holderProcess: `spread:${attempt}`, holderNode: nodeId, holderName: node.nodeName,
          homeNode: nodeId, released: true, reserved: false, takenAt: now, renewedAt: now, ttlMs: node.takeoverSeconds * 1000,
          expiresUpMs: uPrimeMs + node.takeoverSeconds * 1000, extended: false,
        });
        const entry = kept.get(nodeId) ?? { nodeName: node.nodeName, shardIds: [], seconds: node.takeoverSeconds };
        entry.shardIds.push(shardId);
        kept.set(nodeId, entry);
      });
      spreadResult = { fromCount: request.writesMeta.kind === 'direct' ? request.writesMeta.from : read.fromCount ?? 0, kept: [...kept.values()] };
    }
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
    return { kind: 'done', shardCount: decision.count, taken, plan, predecessorRenewedAt, read, closed, spread: spreadResult };
  }

  release(request: ReleaseRequest, onSent?: () => void, onConnected?: () => void): Promise<ReleasedRow[]> {
    return this.gated(false, () => this.releaseIn(request, onSent, onConnected));
  }

  private async releaseIn(request: ReleaseRequest, onSent?: () => void, onConnected?: () => void): Promise<ReleasedRow[]> {
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

  readPage(): Promise<PageRead> {
    return this.gated(false, () => this.readPageIn());
  }

  private async readPageIn(): Promise<PageRead> {
    this.reads += 1;
    await this.lane(this.readMode, 'work');
    const now = this.dbNow();
    return {
      shardCount: this.count, upMs: this.clock.upMs, uPrimeMs: uPrime(this.clock, now),
      rows: this.activeRows().map(r => ({ ...r, renewedAgoMs: now - r.renewedAt })), nodes: this.nodeRows(now),
      reshard: { ...this.reshard, metaCount: this.count },
    };
  }

  readRow(shardCount: number, shardId: number) {
    return this.gated(false, () => this.readRowIn(shardCount, shardId));
  }

  private async readRowIn(shardCount: number, shardId: number) {
    await this.lane(this.readMode, 'work', { boundMs: this.bounds?.renewMs });
    const row = this.rows.get(key(shardCount, shardId));
    return { row: row ? { ...row } : null, storedCount: this.count };
  }

  abandonWork(): void { this.abandoned.work += 1; this.destroy('work'); }
  abandonRenewal(): void { this.abandoned.renewal += 1; this.destroy('renewal'); }
  async end(): Promise<void> { /* nothing to close */ }

  /** NB9 7 and 61: each row's `ready`, as the standby's take (false) and renewals write it. */
  ready = new Map<string, boolean>();
  /** The reshard row's other columns, as reshardStore.ts reads and writes them; times in database ms. */
  attemptRow: { method: 'overlap' | 'stop-start' | null; startedAt: number | null; untilAt: number | null; retryAfter: number | null; failures: number; reason: string | null } = {
    method: null, startedAt: null, untilAt: null, retryAfter: null, failures: 0, reason: null,
  };
  standbyTakes: StandbyTakeRequest[] = [];
  standbyRenewals: StandbyRenewRequest[] = [];
  /** NB9 37: each node's memory reading as the heartbeat wrote it; absent: room true, taken just now. */
  nodeMemory = new Map<string, { room: boolean | null; freeMb: number | null; useMb: number | null; error: string | null; agoMs: number | null }>();
  /** NB9 20: each node's reshard_overlap; absent: true. */
  nodeOverlap = new Map<string, boolean>();
  /** NB9 6: the starts reshardStore.ts wrote through a work-lane client. */
  starts: Array<{ attempt: string; from: number; to: number; method: string; reason: string | null }> = [];
  /** The first line of each statement sent on a work-lane client (the standby's poll). */
  workStatements: string[] = [];

  /** NB9 6's start as reshardStore.ts writes it, for fixtures: the attempt open in 'standby' from `from` to `to`. */
  startAttempt(attempt: string, from: number, to: number, untilMs = 660_000): void {
    const now = this.dbNow();
    this.reshard = { ...this.reshard, attempt, state: 'standby', fromCount: from, toCount: to };
    this.attemptRow = { method: 'overlap', startedAt: now, untilAt: now + untilMs, retryAfter: null, failures: this.attemptRow.failures, reason: null };
  }

  standbyTake(request: StandbyTakeRequest, onBegin?: () => void): Promise<StandbyTakeAnswer> {
    return this.gated(false, async () => {
      this.standbyTakes.push(structuredClone(request));
      onBegin?.();
      while (this.takeLock) await this.takeLock;
      let unlock: () => void = () => undefined;
      const lock = new Promise<void>(resolve => { unlock = resolve; });
      this.takeLock = lock;
      try {
        await this.lane(this.takeMode, 'work');
        return this.commitStandbyTake(request);
      } finally {
        if (this.takeLock === lock) this.takeLock = null;
        unlock();
      }
    });
  }

  private commitStandbyTake(request: StandbyTakeRequest): StandbyTakeAnswer {
    if (this.reshard.attempt !== request.attempt || this.reshard.state !== 'standby') {
      return { kind: 'not-standby', attempt: this.reshard.attempt, state: this.reshard.state, reason: this.attemptRow.reason, toCount: this.reshard.toCount };
    }
    const now = this.dbNow();
    const w = request.shardCount;
    const rows = [...this.rows.values()].filter(r => r.shardCount === w);
    const plan = planTake({
      me: request.me, capacity: request.capacity, boot: true, known: [], shardCount: w, rows, nodes: this.nodeRows(now),
      upMs: this.clock.upMs, uPrimeMs: uPrime(this.clock, now),
    });
    const taken: Pair[] = [];
    let floor = Math.max(this.guildFloor, ...[...this.rows.values()].map(r => r.claim), 0);
    for (const pick of plan.takes) {
      let claim = ++this.seq;
      if (claim <= floor) { claim = floor + 1; this.seq = claim; }
      floor = claim;
      this.rows.set(key(w, pick.shardId), {
        shardCount: w, shardId: pick.shardId, claim, holderProcess: request.me.processId, holderNode: request.me.nodeId,
        holderName: request.me.nodeName, homeNode: pick.row?.homeNode ?? request.me.nodeId, released: false, reserved: false,
        takenAt: now, renewedAt: now, ttlMs: request.ttlMs, expiresUpMs: uPrime(this.clock, now) + request.ttlMs, extended: false,
      });
      this.ready.set(key(w, pick.shardId), false);
      taken.push({ shardCount: w, shardId: pick.shardId, claim });
    }
    return { kind: 'done', shardCount: w, taken, plan };
  }

  renewStandby(request: StandbyRenewRequest): Promise<RenewAnswer> {
    return this.gated(false, async () => {
      this.standbyRenewals.push(structuredClone(request));
      if (this.renewFailsAt === 'statement') await this.lane(this.renewMode, 'renewal');
      const now = this.dbNow();
      const { clock, returned } = applyRenewal([...this.rows.values()], this.clock, now, request.me.processId, request.pairs, request.ttlMs);
      this.clock = clock;
      for (const { row, mine } of returned) {
        if (!mine) continue;
        const asked = request.pairs.find(p => p.shardCount === row.shardCount && p.shardId === row.shardId && p.claim === row.claim);
        this.ready.set(key(row.shardCount, row.shardId), asked?.ready ?? false);
      }
      if (this.renewFailsAt === 'reply') await this.lane(this.renewMode, 'renewal');
      return { at: now, priorProcess: null, rows: returned.map(({ row, mine }) => ({ shardCount: row.shardCount, shardId: row.shardId, claim: row.claim, released: row.released, mine })) };
    });
  }

  withWorkClient<T>(_what: string, fn: (client: WorkClient) => Promise<T>): Promise<T> {
    return this.gated(false, async () => {
      await this.lane(this.readMode, 'work');
      return fn({ query: async (text: string, values: unknown[] = []) => this.answerSql(text, values) });
    });
  }

  /** reshardStore.ts's statements as Postgres answers them over this store's rows. */
  private answerSql(text: string, v: unknown[]): { rows: any[] } {
    this.workStatements.push(text.trim().split('\n')[0]);
    const now = this.dbNow();
    const a = this.attemptRow;
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(text) || /pg_advisory_xact_lock|FOR UPDATE|^\s*INSERT INTO smdb_data\.reshard/.test(text)) return { rows: [] };
    if (/LEFT JOIN smdb_data\.reshard/.test(text)) {
      const r = this.reshard;
      return {
        rows: [{
          attempt: r.attempt, state: r.state, method: a.method, from_count: r.fromCount, to_count: r.toCount, target: r.target ?? null,
          target_by: r.targetBy ?? null, target_at: r.targetAt ?? null, started_at: a.startedAt, until_at: a.untilAt,
          retry_after: a.retryAfter, failures: a.failures, reason: a.reason, meta_count: this.count, up_ms: String(this.clock.upMs), now_ms: now,
        }],
      };
    }
    if (/FROM smdb_data\.shard_nodes/.test(text)) {
      return {
        rows: this.nodeRows(now).map(n => {
          const m = this.nodeMemory.get(n.nodeId) ?? { room: true, freeMb: 2000, useMb: 500, error: null, agoMs: 0 };
          return {
            node_id: n.nodeId, node_name: n.nodeName, process_id: n.processId, fit: n.fit, restartable: n.restartable,
            reshard_overlap: this.nodeOverlap.get(n.nodeId) ?? true, takeover_seconds: n.takeoverSeconds, seen_ago_ms: n.seenAgoMs,
            started_ago_ms: 3_600_000, memory_room: m.room, memory_free_mb: m.freeMb, memory_use_mb: m.useMb, memory_error: m.error,
            memory_ago_ms: m.agoMs,
          };
        }),
      };
    }
    if (/^\s*DELETE FROM smdb_data\.shard_claims\s+WHERE shard_count <> \$1::int AND \(released OR/.test(text)) {
      let n = 0;
      for (const [k, r] of [...this.rows]) if (r.shardCount !== Number(v[0]) && (r.released || r.expiresUpMs <= Number(v[1]))) { this.rows.delete(k); n += 1; }
      return { rows: Array.from({ length: n }, () => ({ '?column?': 1 })) };
    }
    if (/^\s*UPDATE smdb_data\.reshard SET attempt = \$1::uuid/.test(text)) {
      this.reshard = { ...this.reshard, attempt: String(v[0]), fromCount: Number(v[1]), toCount: Number(v[2]), state: String(v[4]) as never };
      this.attemptRow = { ...a, method: String(v[3]) as never, startedAt: now, untilAt: now + Number(v[6]) * 1000, reason: (v[7] as string | null) ?? null, failures: Number(v[8]) };
      this.starts.push({ attempt: String(v[0]), from: Number(v[1]), to: Number(v[2]), method: String(v[3]), reason: (v[7] as string | null) ?? null });
      return { rows: [] };
    }
    if (/^\s*SELECT shard_count, shard_id, released/.test(text)) {
      return {
        rows: [...this.rows.values()].map(r => ({
          shard_count: r.shardCount, shard_id: r.shardId, released: r.released, expires_up_ms: String(r.expiresUpMs),
          ready: this.ready.get(key(r.shardCount, r.shardId)) ?? false, ttl_ms: String(r.ttlMs), renewed_ago_ms: now - r.renewedAt,
          holder_process: r.holderProcess, holder_node: r.holderNode, holder_name: r.holderName,
        })),
      };
    }
    if (/^\s*UPDATE smdb_data\.meta SET value/.test(text)) {
      this.count = (JSON.parse(String(v[0])) as { count: number }).count;
      return { rows: [] };
    }
    if (/SET state = 'flipped'/.test(text)) {
      if (this.reshard.attempt === v[0] && this.reshard.state === 'standby') this.reshard = { ...this.reshard, state: 'flipped' };
      return { rows: [] };
    }
    if (/^\s*DELETE FROM smdb_data\.shard_claims WHERE shard_count = \$1::int\s*$/.test(text)) {
      for (const [k, r] of [...this.rows]) if (r.shardCount === Number(v[0])) this.rows.delete(k);
      return { rows: [] };
    }
    if (/SET state = 'done'/.test(text)) {
      if (this.reshard.attempt === v[0] && this.reshard.state === 'flipped') {
        this.reshard = { ...this.reshard, state: 'done' };
        this.attemptRow = { ...a, failures: 0, retryAfter: null };
      }
      return { rows: [] };
    }
    if (/SET state = 'cancelled'/.test(text)) {
      if (this.reshard.attempt !== v[0] || (this.reshard.state !== 'standby' && this.reshard.state !== 'stopping')) return { rows: [] };
      const retryAfter = now + Number(v[2]) * 1000;
      this.reshard = { ...this.reshard, state: 'cancelled' };
      this.attemptRow = { ...a, reason: String(v[1]), retryAfter, failures: a.failures + Number(v[3]) };
      return { rows: [{ retry_after: retryAfter }] };
    }
    throw new Error(`the fake work client has no answer for: ${text.trim().split('\n')[0]}`);
  }
}
