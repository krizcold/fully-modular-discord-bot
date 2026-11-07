// NB9's reshard in a serving bot process: decision 6's start, 7's ask, 8's flip and 11's call-offs at each tick, the
// hand-over (9, 25) and the stop-start leave (12) at the page read that shows them, the asker's answers (33, 49, 65),
// and decision 15's JSON timer. The SQL is reshardStore.ts's and the verdicts are reshardRules.ts's.

import { randomUUID } from 'crypto';
import type { PageRead, WorkClient } from './claimStore';
import {
  attemptOpen, callOffVerdict, chooseMethod, flipVerdict, handOverVerdict, untilSeconds, wantedCount,
  type AskedCallOff, type MethodNode, type ReshardFacts,
} from './reshardRules';
import { callOffReshard, flipReshard, readFacts, startReshard } from './reshardStore';
import { l11Line, l7Line, retryTime } from './shardClaims';

const FIFTEEN_MIN_MS = 15 * 60_000;
const L18_EVERY_MS = 60 * 60_000;
const JSON_TICK_MS = 30_000;

/** NB9 21's reshardWait: a wanted count the bot does not reshard to yet, and why. */
export interface ReshardWait {
  wanted: number;
  source: 'setting' | 'discord';
  reason: string;
  /** L18: no reshard beside the running shards can run, and Discord's recommendation alone starts no other (P4). */
  cannot?: true;
}

export interface ReshardBudget {
  stale: boolean;
  remaining: number;
  /** Wall time the budget resets at. */
  resetAt: number;
}

/** What the driver reads and drives of the process's ShardClaims. */
export interface ReshardClaims {
  readonly processId: string;
  ownCount(): number | null;
  stopServingForReshard(): boolean;
  noteHandOver(from: number, to: number): void;
}

export interface ReshardDeps {
  claims: ReshardClaims;
  withWorkClient: <T>(what: string, fn: (client: WorkClient) => Promise<T>) => Promise<T>;
  me: { nodeId: string; nodeName: string };
  /** Decision 14's fitness: null when fit. */
  fitness: () => string | null;
  /** A web UI process runs that can fork a standby (NB4 decision 10). */
  restartable: boolean;
  startLeave: (reason: string, handOver?: { attempt: string | null }) => void;
  /** IPC to the web UI process; null with no channel. */
  send: ((message: object) => void) | null;
  intents: () => number;
  maxConcurrency: () => number;
  /** The database entry the claims pool is on (27's SMDB_RESHARD_DB). */
  entry: () => string;
  budget: () => ReshardBudget | null;
  /** Discord's recommendation as this process's ledger read it within the last 15 minutes, else null. */
  recommendation: () => number | null;
  newAttempt?: () => string;
  log?: Pick<Console, 'log' | 'warn' | 'error'>;
  now?: () => number;
}

/** Decision 25 needs the page's rows of meta's count named by this process. */
function heldLiveOfMeta(page: PageRead, processId: string): boolean {
  if (page.shardCount === null) return false;
  return page.rows.some(r => r.shardCount === page.shardCount && r.holderProcess === processId && !r.released && r.expiresUpMs > page.upMs);
}


export class Reshard {
  private ended = false;
  private readonly askedLogged = new Set<string>();
  private readonly passingLogged = new Set<string>();
  private readonly endedCount = new Map<string, number>();
  private waitInfo: ReshardWait | null = null;
  private lastL18: { reason: string; at: number } | null = null;
  private readonly log: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly now: () => number;

  constructor(private readonly deps: ReshardDeps) {
    this.log = deps.log ?? console;
    this.now = deps.now ?? Date.now;
  }

  /** NB9 21: the wanted count the start waits for, and why; null when none waits. */
  wait(): ReshardWait | null {
    return this.waitInfo;
  }

  /** True once this process handed over or left for a stop-start reshard. */
  handedOver(): boolean {
    return this.ended;
  }

  /** At each page read of a serving process (its bootShards resolved, 48). */
  async onPage(page: PageRead): Promise<void> {
    if (this.ended) return;
    const read = page.reshard;
    const { claims } = this.deps;
    const own = claims.ownCount();
    if (handOverVerdict({ granted: true, ownCount: own, metaCount: page.shardCount, heldLiveOfMeta: heldLiveOfMeta(page, claims.processId) })) {
      this.handOver(own!, page.shardCount!, read?.attempt ?? null);
      return;
    }
    if (!read) return;
    if (read.state === 'stopping' && read.attempt !== null && read.fromCount === own && read.toCount !== null) {
      // 12: the stop-serving step and NB2's leave, which ends in the restart (or NB4's stop with no web UI process).
      this.ended = true;
      claims.stopServingForReshard();
      this.deps.startLeave(l26Reason(read.toCount));
      return;
    }
    if (read.state === 'standby' && read.attempt !== null) {
      await this.duringStandby(read.attempt);
      return;
    }
    if (!attemptOpen(read)) await this.maybeStart(page);
  }

  /** 9 and 25: in one synchronous step, NB4's stop-serving step and NB2's leave with L8, ending in the retire. */
  private handOver(from: number, to: number, attempt: string | null): void {
    this.ended = true;
    this.waitInfo = null;
    this.deps.claims.stopServingForReshard();
    this.deps.claims.noteHandOver(from, to);
    this.deps.startLeave(l8Reason(to), { attempt });
  }

  private async duringStandby(attempt: string): Promise<void> {
    this.waitInfo = null;
    const work = this.deps.withWorkClient;
    const facts = await work('the reshard check', client => readFacts(client));
    if (facts.row.attempt !== attempt || facts.row.state !== 'standby') return;
    if (flipVerdict(facts, attempt)) {
      const flip = await work('the flip', client => flipReshard(client, attempt));
      if (flip.kind === 'flipped') this.log.log(l7Line(flip.toCount, flip.fromCount));
      return;
    }
    if (callOffVerdict(facts) !== null) {
      await this.callOff(attempt);
      return;
    }
    if (this.deps.fitness() !== null || !this.deps.restartable || !this.deps.send) return;
    this.deps.send({
      type: 'control:reshard-standby',
      data: { attempt, to: facts.row.toCount, intents: this.deps.intents(), maxConcurrency: this.deps.maxConcurrency(), entry: this.deps.entry() },
    });
    if (!this.askedLogged.has(attempt)) {
      this.askedLogged.add(attempt);
      this.log.log(l3Line());
    }
  }

  private async callOff(attempt: string, asked?: AskedCallOff): Promise<void> {
    const off = await this.deps.withWorkClient('the call-off', client => callOffReshard(client, attempt, asked));
    if (off.kind === 'called-off') this.log.warn(l11Line(off.toCount, off.reason, off.fromCount, off.retryNow ? null : off.retryAfterMs));
  }

  /** 6: the start, judged on a read with no lock, then in its own transaction under the lock. */
  private async maybeStart(page: PageRead): Promise<void> {
    const read = page.reshard!;
    const n = page.shardCount;
    if (n === null || this.deps.claims.ownCount() !== n) { this.waitInfo = null; return; }
    const target = read.target ?? null;
    const wanted = wantedCount(target, n, this.deps.recommendation());
    if (wanted === null || wanted === n) { this.waitInfo = null; return; }
    const source: 'setting' | 'discord' = target !== null ? 'setting' : 'discord';
    const unfit = this.deps.fitness();
    if (unfit !== null) { this.waitInfo = { wanted, source, reason: `${this.deps.me.nodeName} is not healthy` }; return; }
    const facts = await this.deps.withWorkClient('the reshard check', client => readFacts(client));
    const reason = this.startWaits(facts, n, wanted);
    // The read shows an attempt or a count the page read did not: the next page read decides.
    if (reason === 'changed') return;
    if (reason !== null) { this.waitInfo = { wanted, source, reason }; return; }
    const live = facts.nodes.filter(m => m.seenAgoMs < m.takeoverSeconds * 1000);
    const failures = facts.row.toCount === wanted ? facts.row.failures : 0;
    const choice = chooseMethod(live.map(toMethodNode).sort((a, b) => (a.nodeName < b.nodeName ? -1 : a.nodeName > b.nodeName ? 1 : 0)), failures, source);
    if ('wait' in choice) { this.waitInfo = { wanted, source, reason: choice.reason }; return; }
    if (choice.method === null) {
      this.waitInfo = { wanted, source, reason: choice.reason, cannot: true };
      this.lastL18 = logL18(this.log, this.lastL18, this.now(), l18Line(wanted, n, choice.reason, false), choice.reason);
      return;
    }
    const budget = this.deps.budget();
    // 17: no start on a stale or missing ledger; the ledger reads /gateway/bot again within 300 s.
    if (!budget || budget.stale) { this.waitInfo = null; return; }
    if (budget.remaining < 2 * wanted) {
      const why = budgetClause(wanted, budget);
      if (this.waitInfo?.reason !== why) this.log.warn(l19Line(wanted, budget.remaining, budget.resetAt));
      this.waitInfo = { wanted, source, reason: why };
      return;
    }
    const attempt = (this.deps.newAttempt ?? randomUUID)();
    const method = choice.method;
    const started = await this.deps.withWorkClient('the reshard start', client => startReshard(client, {
      attempt, wanted, method, reason: method === 'stop-start' ? choice.reason : null, startedBy: this.deps.me.nodeName,
      maxConcurrency: this.deps.maxConcurrency(),
    }));
    if (started.kind !== 'started') return;
    this.waitInfo = null;
    const m = Math.round(started.untilSeconds / 60);
    if (method === 'overlap') this.log.log(l1Line(started.fromCount, started.toCount, m));
    else this.log.warn(l2Line(started.fromCount, started.toCount, choice.reason, live.filter(x => !x.restartable).map(x => x.nodeName).sort()));
  }

  /** 6's conditions before the method: a call-off's retry time, an unfit machine, a live row of another count. */
  private startWaits(f: ReshardFacts, n: number, wanted: number): string | null | 'changed' {
    if (f.metaCount !== n || (f.row.state !== null && attemptOpen({ ...f.row, metaCount: f.metaCount }))) return 'changed';
    if (f.row.retryAfterMs !== null && f.row.retryAfterMs > f.nowMs) {
      return `the last try was called off (${f.row.reason ?? 'no reason recorded'}); the next try is after ${retryTime(this.now() + (f.row.retryAfterMs - f.nowMs))}`;
    }
    const unfit = f.nodes.find(m => m.seenAgoMs < m.takeoverSeconds * 1000 && !m.fit);
    if (unfit) return `${unfit.nodeName} is not healthy`;
    const held = f.rows.find(r => r.shardCount !== n && !r.released && r.expiresUpMs > f.upMs);
    if (held) return `${held.holderName} still holds shards of another count`;
    void wanted;
    return null;
  }

  /** The web UI's answers to the ask (33, 49, 65): 'reshard:standby-state'. */
  async onMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') return;
    const { type, data } = message as { type?: unknown; data?: any };
    if (type !== 'reshard:standby-state' || !data || typeof data.attempt !== 'string') return;
    const attempt: string = data.attempt;
    const reason = typeof data.reason === 'string' ? data.reason : '';
    if (data.state === 'refused') {
      if (data.kind === 'memory') {
        this.log.warn(l4Line(reason));
        await this.callOff(attempt, { reason: `${this.deps.me.nodeName} could not start its new shards: ${reason}`, countsFailure: true });
      } else {
        const key = `${attempt}/${reason}`;
        if (!this.passingLogged.has(key)) {
          this.passingLogged.add(key);
          this.log.warn(l4bLine(reason));
        }
      }
      return;
    }
    if (data.state === 'ended') {
      const ends = (this.endedCount.get(attempt) ?? 0) + 1;
      this.endedCount.set(attempt, ends);
      if (ends >= 2) {
        await this.callOff(attempt, { reason: `the second bot process on ${this.deps.me.nodeName} ended twice before the switch (last: ${reason})`, countsFailure: true });
      }
    }
  }
}

function toMethodNode(m: ReshardFacts['nodes'][number]): MethodNode {
  return {
    nodeName: m.nodeName,
    restartable: m.restartable,
    reshardOverlap: m.reshardOverlap,
    memoryRoom: m.memoryRoom ?? null,
    memoryFreeMb: m.memoryFreeMb ?? null,
    memoryUseMb: m.memoryUseMb ?? null,
    memoryError: m.memoryError ?? null,
    memoryAgoMs: m.memoryAgoMs ?? null,
    startedAgoMs: m.startedAgoMs ?? Number.MAX_SAFE_INTEGER,
  };
}

// ---------------------------------------------------------------- the JSON bot (15)

export interface JsonReshardDeps {
  nodeName: string;
  /** FLEET_SHARD_COUNT, null when unset. */
  countSetting: () => number | null;
  /** Discord's recommendation read within the last 15 minutes, else null. */
  recommendation: () => number | null;
  runningCount: () => number;
  /** The fitness key that fails (maintenance, the gate, leaving, stopping, the backend's health), null when fit. */
  fitness: () => string | null;
  overlap: () => boolean;
  /** The web UI's last memory reading with its age; null with none. */
  memory: () => { room: boolean | null; freeMb: number | null; useMb: number | null; error: string | null; ageMs: number } | null;
  /** Ms since this process started, for 5's wait for a first reading. */
  startedAgoMs: () => number;
  budget: () => ReshardBudget | null;
  send: ((message: object) => void) | null;
  intents: () => number;
  maxConcurrency: () => number;
  /** 9's hand-over: the gateway stopped and NB2's leave with L8, ending in the retire. */
  handOver: (reason: string, attempt: string) => void;
  newAttempt?: () => string;
  log?: Pick<Console, 'log' | 'warn' | 'error'>;
  now?: () => number;
  /** A promoted standby's: the reshard it finished, shown as the last one. */
  finished?: { from: number; to: number };
}

/** Decision 15: a JSON bot reshards beside its shards on Discord's recommendation only, from a 30 s timer. */
export class JsonReshard {
  private timer: NodeJS.Timeout | null = null;
  private open: { attempt: string; from: number; to: number; startedAt: number } | null = null;
  private last: { from: number; to: number; state: 'done' | 'cancelled'; endedAt: number; reason: string | null } | null = null;
  private retryAt = 0;
  private readonly callOffs = new Map<number, number>();
  private lastL18: { reason: string; at: number } | null = null;
  private waitInfo: ReshardWait | null = null;
  private handedOver = false;
  private readonly log: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly now: () => number;

  constructor(private readonly deps: JsonReshardDeps) {
    this.log = deps.log ?? console;
    this.now = deps.now ?? Date.now;
    if (deps.finished) this.last = { ...deps.finished, state: 'done', endedAt: this.now(), reason: null };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), JSON_TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  wait(): ReshardWait | null {
    return this.waitInfo;
  }

  /** NB9 21 for a JSON bot, from this process's memory. */
  fields(): { reshard: { attempt: string; from: number; to: number; method: 'overlap'; state: 'standby'; startedAgoMs: number; untilMs: null; reason: null; connected: number; waitingFor: string[] } | null; lastReshard: { from: number; to: number; method: 'overlap'; state: 'done' | 'cancelled'; endedAt: number; reason: string | null } | null } {
    const now = this.now();
    return {
      reshard: this.open ? { attempt: this.open.attempt, from: this.open.from, to: this.open.to, method: 'overlap', state: 'standby', startedAgoMs: now - this.open.startedAt, untilMs: null, reason: null, connected: 0, waitingFor: [] } : null,
      lastReshard: this.last ? { ...this.last, method: 'overlap' } : null,
    };
  }

  /** The 30 s check. */
  tick(): void {
    if (this.open || this.handedOver) return;
    const n = this.deps.runningCount();
    const rec = this.deps.recommendation();
    if (this.deps.countSetting() !== null || rec === null || rec <= n) { this.waitInfo = null; return; }
    const wanted = rec;
    const name = this.deps.nodeName;
    const wait = (reason: string) => { this.waitInfo = { wanted, source: 'discord', reason }; };
    if (this.deps.fitness() !== null) return wait(`${name} is not healthy`);
    if (this.now() < this.retryAt && this.last) return wait(`the last try was called off (${this.last.reason ?? 'no reason recorded'}); the next try is after ${retryTime(this.retryAt)}`);
    const memory = this.deps.memory();
    const choice = chooseMethod([{
      nodeName: name, restartable: this.deps.send !== null, reshardOverlap: this.deps.overlap(),
      memoryRoom: memory?.room ?? null, memoryFreeMb: memory?.freeMb ?? null, memoryUseMb: memory?.useMb ?? null,
      memoryError: memory?.error ?? null, memoryAgoMs: memory?.ageMs ?? null, startedAgoMs: this.deps.startedAgoMs(),
    }], this.callOffs.get(wanted) ?? 0, 'discord');
    if ('wait' in choice) return wait(choice.reason);
    if (choice.method !== 'overlap') {
      this.lastL18 = logL18(this.log, this.lastL18, this.now(), l18Line(wanted, n, choice.reason, true), choice.reason);
      this.waitInfo = { wanted, source: 'discord', reason: choice.reason, cannot: true };
      return;
    }
    const budget = this.deps.budget();
    if (!budget || budget.stale) { this.waitInfo = null; return; }
    if (budget.remaining < 2 * wanted) {
      const why = budgetClause(wanted, budget);
      if (this.waitInfo?.reason !== why) this.log.warn(l19Line(wanted, budget.remaining, budget.resetAt));
      return wait(why);
    }
    this.waitInfo = null;
    const attempt = (this.deps.newAttempt ?? randomUUID)();
    this.open = { attempt, from: n, to: wanted, startedAt: this.now() };
    this.deps.send!({ type: 'control:reshard-standby', data: { attempt, from: n, to: wanted, intents: this.deps.intents(), maxConcurrency: this.deps.maxConcurrency(), json: true } });
    this.log.log(l27Line(n, wanted, Math.round(untilSeconds('overlap', wanted, this.deps.maxConcurrency()) / 60)));
  }

  private calledOff(reason: string | null): void {
    if (!this.open) return;
    const { from, to } = this.open;
    this.callOffs.set(to, (this.callOffs.get(to) ?? 0) + 1);
    this.retryAt = this.now() + FIFTEEN_MIN_MS;
    this.last = { from, to, state: 'cancelled', endedAt: this.now(), reason };
    this.open = null;
  }

  /** 'reshard:retire' answers { accepted }; 'reshard:standby-state' 'refused' or 'ended' calls the attempt off. */
  onMessage(message: unknown): { accepted: boolean; key?: string } | null {
    if (!message || typeof message !== 'object') return null;
    const { type, data } = message as { type?: unknown; data?: any };
    if (!this.open || data?.attempt !== this.open.attempt) return null;
    if (type === 'reshard:retire') {
      const key = this.deps.fitness();
      if (key !== null) {
        const { from, to } = this.open;
        this.calledOff(`this process was not healthy (${key})`);
        this.log.warn(l28Line(to, key, from, this.retryAt));
        return { accepted: false, key };
      }
      const { to, attempt } = this.open;
      this.handedOver = true;
      this.last = { from: this.open.from, to, state: 'done', endedAt: this.now(), reason: null };
      this.deps.handOver(l8Reason(to), attempt);
      return { accepted: true };
    }
    if (type === 'reshard:standby-state' && (data.state === 'refused' || data.state === 'ended')) {
      if (this.handedOver) return null;
      const reason = typeof data.reason === 'string' ? data.reason : null;
      if (data.state === 'refused' && data.kind === 'passing') {
        this.log.warn(l4bLine(reason ?? 'no reason recorded'));
        this.open = null;
        return null;
      }
      if (data.state === 'refused') {
        if (reason) this.log.warn(l4Line(reason));
        this.calledOff(reason);
        return null;
      }
      const { from, to } = this.open;
      this.calledOff(reason);
      this.log.warn(l11Line(to, reason ?? 'no reason recorded', from, this.retryAt));
    }
    return null;
  }
}

// ---------------------------------------------------------------- texts

/** L18 when the reason changes, and at most once an hour. */
function logL18(log: Pick<Console, 'warn'>, last: { reason: string; at: number } | null, at: number, line: string, reason: string): { reason: string; at: number } {
  if (last && last.reason === reason && at - last.at < L18_EVERY_MS) return last;
  log.warn(line);
  return { reason, at };
}

/** L19's budget clause, P3's reason. */
function budgetClause(w: number, budget: ReshardBudget): string {
  return `Discord allows ${budget.remaining} more gateway logins until ${retryTime(budget.resetAt)}, and a reshard needs ${2 * w}`;
}

export function l1Line(n: number, w: number, m: number): string {
  return `[Shards] Resharding from ${n} to ${w} shards beside the running ones: each machine connects its new shards in a second bot process, and the bot switches once all ${w} are connected (called off if not done in ${m} min)`;
}

export function l2Line(n: number, w: number, reason: string, noWebUi: string[]): string {
  const tail = noWebUi.length > 0 ? `; ${noWebUi.join(', ')} run without the web UI and stay stopped until started by hand` : '';
  return `[Shards] Resharding from ${n} to ${w} shards by stopping and starting every machine (${reason}): the bot's shards are offline until the machines start again under ${w}${tail}`;
}

export function l3Line(): string {
  return '[Shards] Asked the web UI to start a second bot process for the new shards';
}

export function l4Line(reason: string): string {
  return `[Shards] The web UI could not start a second bot process for the new shards: ${reason}`;
}

export function l4bLine(reason: string): string {
  return `[Shards] The web UI cannot start the second bot process for the new shards now (${reason}); asking again at the next check`;
}

/** L8, NB2's leave reason at a hand-over. */
export function l8Reason(w: number): string {
  return `Resharding to ${w} shards: this process hands its shards to the new ones`;
}

export function l18Line(r: number, n: number, reason: string, json: boolean): string {
  const tail = json
    ? `Set FLEET_SHARD_COUNT to ${r} and restart the bot to reshard by restarting it`
    : `Set FLEET_SHARD_COUNT to ${r} on one machine to reshard by stopping and starting every machine`;
  return `[Shards] Discord recommends ${r} shards (the bot runs ${n}), and a reshard beside the running shards cannot run: ${reason}. ${tail}`;
}

export function l19Line(w: number, remaining: number, resetAt: number): string {
  return `[Shards] Resharding to ${w} shards waits: Discord allows ${remaining} more gateway logins until ${retryTime(resetAt)}, and a reshard needs ${2 * w}`;
}

/** L26, NB2's leave reason for a stop-start reshard. */
export function l26Reason(w: number): string {
  return `Resharding to ${w} shards by stopping and starting every machine`;
}

export function l27Line(n: number, w: number, m: number): string {
  return `[Shards] Resharding from ${n} to ${w} shards beside the running ones: a second bot process connects the new shards, and the bot switches once all ${w} are connected (called off if not done in ${m} min)`;
}

export function l28Line(w: number, key: string, n: number, retryAt: number): string {
  return `[Shards] Called off the reshard to ${w} shards: this process was not healthy (${key}) when the new shards were ready; the bot keeps ${n} shards; the next try is after ${retryTime(retryAt)}`;
}
