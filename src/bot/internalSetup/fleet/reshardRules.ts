// NB9's pure verdicts: the take gate (56, 73, 77, C1, D9), the boot's branch (74), what a take does with the gate's
// answer (67, 69, 74, 77), the spread (12), the start, flip, close and call-off (6, 8, 10, 11) and the web UI's
// answer to a standby ask (50, 65).

export type ReshardState = 'standby' | 'flipped' | 'stopping' | 'done' | 'cancelled';

/** Step (1)'s one row: the reshard row (every field null when it holds no attempt, or row 1 is missing) and meta. */
export interface GateRead {
  attempt: string | null;
  state: ReshardState | null;
  fromCount: number | null;
  toCount: number | null;
  metaCount: number | null;
  target?: number | null;
  targetBy?: string | null;
  targetAt?: number | null;
}

/** The take that writes meta, and what it changes from (73): 12's count change or 13's direct change. */
export type WritesMeta = { kind: 'change'; attempt: string } | { kind: 'direct'; from: number };

export interface GateTake {
  /** True only from ShardClaims.bootTake: NB4's boot take and a waiting boot's take (77). */
  boot: boolean;
  /** True only from takeIn: NB4's boot and running takes (D9). */
  firstTake: boolean;
  /** NB4's boot or running take: FLEET_SHARD_COUNT or Discord's recommendation (first take), or the running count. */
  localCount: number | null;
  writesMeta?: WritesMeta;
  /** The redraw's W, or the re-taken pair's count. */
  count?: number;
}

export interface GateRow {
  shardCount: number;
  shardId: number;
  released: boolean;
  expiresUpMs: number;
  holderName: string;
}

export const OPEN_STATES: ReadonlySet<ReshardState> = new Set(['standby', 'flipped', 'stopping']);

export function attemptOpen(read: GateRead): boolean {
  return read.state !== null && OPEN_STATES.has(read.state);
}

export type StepOne =
  | { kind: 'need-count' }
  | { kind: 'count' }
  | { kind: 'on'; n: number; writeMeta: boolean };

/** Step (1): whether the take goes on, its count n, and whether step (0) writes meta = n. */
export function gateStepOne(take: GateTake, read: GateRead): StepOne {
  const meta = read.metaCount;
  if (take.writesMeta) {
    const n = take.localCount;
    if (n === null) return { kind: 'count' };
    if (take.writesMeta.kind === 'change') {
      const ok = read.attempt === take.writesMeta.attempt && read.state === 'stopping' && read.fromCount !== null
        && meta === read.fromCount && read.toCount === n;
      return ok ? { kind: 'on', n, writeMeta: true } : { kind: 'count' };
    }
    const ok = meta === take.writesMeta.from && !attemptOpen(read);
    return ok ? { kind: 'on', n, writeMeta: true } : { kind: 'count' };
  }
  if (take.count !== undefined) return meta === take.count ? { kind: 'on', n: take.count, writeMeta: false } : { kind: 'count' };
  if (meta === null) {
    if (!take.firstTake) return { kind: 'count' };
    if (take.localCount === null) return { kind: 'need-count' };
    return { kind: 'on', n: take.localCount, writeMeta: true };
  }
  if (take.boot) return read.state === 'stopping' ? { kind: 'count' } : { kind: 'on', n: meta, writeMeta: false };
  return take.localCount === meta ? { kind: 'on', n: meta, writeMeta: false } : { kind: 'count' };
}

/** Step (2)'s spare: an open attempt's to_count rows are never deleted. */
export function sparedByAttempt(row: { shardCount: number }, read: GateRead): boolean {
  return row.shardCount === read.toCount && attemptOpen(read);
}

/** Step (3)'s exception: a take of from_count, meta as step (1) read it from_count, ignores the to_count rows. */
export function exceptedRow(row: { shardCount: number }, n: number, read: GateRead): boolean {
  return n === read.fromCount && row.shardCount === read.toCount && read.metaCount === read.fromCount;
}

export type GateVerdict =
  | { kind: 'need-count' }
  | { kind: 'count'; read: GateRead }
  | { kind: 'held'; read: GateRead; rows: GateRow[] }
  | { kind: 'commit'; read: GateRead; n: number; writeMeta: boolean; deleted: GateRow[]; close: boolean };

/** The whole gate over step (1)'s read and every claim row of another count, against u. */
export function takeGateVerdict(take: GateTake, read: GateRead, rows: GateRow[], upMs: number): GateVerdict {
  const one = gateStepOne(take, read);
  if (one.kind === 'need-count') return one;
  if (one.kind === 'count') return { kind: 'count', read };
  const { n } = one;
  const others = rows.filter(r => r.shardCount !== n);
  const dead = (r: GateRow) => r.released || r.expiresUpMs <= upMs;
  const deleted = others.filter(r => dead(r) && !sparedByAttempt(r, read));
  const blocking = others.filter(r => !dead(r) && !exceptedRow(r, n, read));
  if (blocking.length > 0) return { kind: 'held', read, rows: blocking };
  const close = read.state === 'flipped' && read.toCount === n && read.attempt !== null;
  return { kind: 'commit', read, n, writeMeta: one.writeMeta, deleted, close };
}

export type BootBranch = 'first-take' | 'count-change' | 'boot-take' | 'direct-change';

/**
 * 74: the boot's branch for a read and its W. `liveOfMeta` is whether a live row of meta's count is known; null when
 * no read showed the rows (the boot take then goes under meta).
 */
export function waitingBootVerdict(read: GateRead, wanted: number | null, liveOfMeta: boolean | null): BootBranch {
  if (read.state === 'stopping') return 'count-change';
  if (read.metaCount === null) return 'first-take';
  if (attemptOpen(read)) return 'boot-take';
  if (wanted === null || wanted === read.metaCount) return 'boot-take';
  return liveOfMeta === false ? 'direct-change' : 'boot-take';
}

/** Decision 4: W is the target when set, else the larger of the stored count and the recommendation. */
export function wantedCount(target: number | null, stored: number | null, recommendation: number | null): number | null {
  if (target !== null) return target;
  if (stored === null) return recommendation;
  return recommendation === null ? stored : Math.max(stored, recommendation);
}

export type TakeKind = 'boot' | 'running' | 'redraw' | 'retake' | 'count-writing';
export type TakeResult = 'count' | 'held' | 'failed';

export interface TakeAction {
  /** 'retry': the boot's next try after R; 'next-tick': the work lane's next tick; 'loss': NB4's loss for every pair;
   *  'next-pass': the move decides nothing and its next pass runs again; 'retry-until-d': the redraw again after R. */
  then: 'retry' | 'next-tick' | 'loss' | 'next-pass' | 'retry-until-d';
  /** The line to log: L32's take, redraw or re-take form, L13, NB4's take-error line, or none. */
  line: 'L32' | 'L13' | 'take-error' | null;
}

/** 67, 69, 74 and 77: what a take does with a refusal or a failed gate statement. */
export function takeOutcome(kind: TakeKind, result: TakeResult, read?: GateRead, n?: number, storedCountHeld = false): TakeAction {
  if (result === 'failed') {
    if (kind === 'running') return { then: 'next-tick', line: null };
    if (kind === 'redraw') return { then: 'retry-until-d', line: null };
    if (kind === 'retake') return { then: 'next-pass', line: null };
    return { then: 'retry', line: 'take-error' };
  }
  if (result === 'count') {
    if (kind === 'running') return { then: 'next-tick', line: null };
    if (kind === 'redraw' || kind === 'retake') return { then: 'loss', line: null };
    return { then: 'retry', line: null };
  }
  if (kind === 'running') return { then: 'next-tick', line: 'L32' };
  if (kind === 'redraw') return { then: 'loss', line: 'L32' };
  if (kind === 'retake') return { then: 'next-pass', line: 'L32' };
  if (kind === 'count-writing') return { then: 'retry', line: storedCountHeld ? null : 'L32' };
  const flipped = read?.state === 'flipped' && read.toCount === n;
  return { then: 'retry', line: flipped ? 'L13' : 'L32' };
}

/** A machine the stop-start count change spreads rows over (12): its target is its capacity. */
export interface SpreadMachine {
  nodeId: string;
  nodeName: string;
  capacity: number;
  takeoverSeconds: number;
}

/**
 * 12: shards 0 to W-1 in order fill this machine up to its target, then each other machine in node_name order up to
 * its target; the rest go round-robin in that same order. The answer holds each shard's node id.
 */
export function spread(w: number, me: SpreadMachine, others: SpreadMachine[]): string[] {
  const order = [me, ...[...others].sort((a, b) => (a.nodeName < b.nodeName ? -1 : a.nodeName > b.nodeName ? 1 : 0))];
  const got = new Map<string, number>(order.map(m => [m.nodeId, 0]));
  const owner: string[] = [];
  let next = 0;
  for (let shard = 0; shard < w; shard++) {
    let machine = order.find(m => got.get(m.nodeId)! < m.capacity);
    if (!machine) {
      machine = order[next % order.length];
      next += 1;
    }
    got.set(machine.nodeId, got.get(machine.nodeId)! + 1);
    owner.push(machine.nodeId);
  }
  return owner;
}

/** The reshard row as the start, the flip, the close and the call-offs read it, times in database ms. */
export interface ReshardRow {
  attempt: string | null;
  state: ReshardState | null;
  method: 'overlap' | 'stop-start' | null;
  fromCount: number | null;
  toCount: number | null;
  target: number | null;
  targetBy: string | null;
  targetAtMs: number | null;
  startedAtMs: number | null;
  untilAtMs: number | null;
  retryAfterMs: number | null;
  failures: number;
  /** Why stop-start was chosen, or why the attempt was called off; absent where a caller built the row without it. */
  reason?: string | null;
}

export interface FactRow {
  shardCount: number;
  shardId: number;
  released: boolean;
  expiresUpMs: number;
  ready: boolean;
  renewedAgoMs: number;
  ttlMs: number;
  holderProcess: string;
  holderNode: string;
  holderName: string;
}

export interface FactNode {
  nodeId: string;
  nodeName: string;
  processId: string;
  fit: boolean;
  restartable: boolean;
  reshardOverlap: boolean;
  seenAgoMs: number;
  takeoverSeconds: number;
  /** 37: the heartbeat's memory reading; absent where a caller built the node without it. */
  memoryRoom?: boolean | null;
  memoryFreeMb?: number | null;
  memoryUseMb?: number | null;
  memoryError?: string | null;
  /** Database ms since memory_at; null with no reading. */
  memoryAgoMs?: number | null;
  /** Database ms since this machine's bot process started. */
  startedAgoMs?: number;
}

/** What one transaction under the advisory lock read: the row, meta, the stored clock u, every claim row and machine. */
export interface ReshardFacts {
  row: ReshardRow;
  metaCount: number | null;
  upMs: number;
  nowMs: number;
  rows: FactRow[];
  nodes: FactNode[];
}

const liveRow = (r: FactRow, upMs: number) => !r.released && r.expiresUpMs > upMs;
const liveNode = (n: FactNode) => n.seenAgoMs < n.takeoverSeconds * 1000;
/** 8's ready test: ready, and renewed within 3 x LEAST(ttl_ms / 6, 5000) ms. */
const freshReady = (r: FactRow) => r.ready && r.renewedAgoMs < 3 * Math.min(r.ttlMs / 6, 5000);

/** 61: the live rows of W that pass 8's ready test. */
export function readyNewCount(f: ReshardFacts, w: number): number {
  return f.rows.filter(r => r.shardCount === w && liveRow(r, f.upMs) && freshReady(r)).length;
}

/** 6's U in seconds: 600 s plus 11 s per bucket round of W for overlap, 600 s for stop-start. */
export function untilSeconds(method: 'overlap' | 'stop-start', w: number, maxConcurrency: number): number {
  return method === 'overlap' ? 600 + 11 * Math.ceil(w / Math.max(maxConcurrency, 1)) : 600;
}

/** The failures a start toward W carries: kept when to_count is the last one, else 0 (6). */
export function keptFailures(row: ReshardRow, w: number): number {
  return row.toCount === w ? row.failures : 0;
}

export type StartRefusal = 'count' | 'open' | 'retry' | 'unfit' | 'held' | 'failures';

/** 6's conditions as the start re-reads them under the lock; null when the start may commit. */
export function startVerdict(f: ReshardFacts, w: number, method: 'overlap' | 'stop-start'): StartRefusal | null {
  const n = f.metaCount;
  if (n === null || w === n) return 'count';
  if (f.row.state !== null && OPEN_STATES.has(f.row.state)) return 'open';
  if (f.row.retryAfterMs !== null && f.row.retryAfterMs > f.nowMs) return 'retry';
  if (f.nodes.some(m => liveNode(m) && !m.fit)) return 'unfit';
  if (f.rows.some(r => r.shardCount !== n && liveRow(r, f.upMs))) return 'held';
  if (method === 'overlap' && keptFailures(f.row, w) >= 2) return 'failures';
  return null;
}

/** 8: the flip commits only on every condition, read in its own transaction. */
export function flipVerdict(f: ReshardFacts, attempt: string): boolean {
  const { row } = f;
  if (row.attempt !== attempt || row.state !== 'standby' || row.fromCount === null || row.toCount === null) return false;
  if (f.metaCount !== row.fromCount) return false;
  for (let shard = 0; shard < row.toCount; shard++) {
    if (!f.rows.some(r => r.shardCount === row.toCount && r.shardId === shard && liveRow(r, f.upMs) && freshReady(r))) return false;
  }
  return f.rows.filter(r => r.shardCount === row.fromCount && liveRow(r, f.upMs)).every(r => {
    const m = f.nodes.find(x => x.nodeId === r.holderNode);
    return m !== undefined && m.fit && m.restartable && m.processId === r.holderProcess && liveNode(m);
  });
}

/** 10: the close when the attempt is 'flipped' and no from_count row is live; `expired` names the old rows not released. */
export function closeVerdict(f: ReshardFacts, attempt: string | null): { close: boolean; expired: number[] } {
  const { row } = f;
  const no = { close: false, expired: [] };
  if (row.state !== 'flipped' || row.attempt === null || (attempt !== null && row.attempt !== attempt)) return no;
  const old = f.rows.filter(r => r.shardCount === row.fromCount);
  if (old.some(r => liveRow(r, f.upMs))) return no;
  return { close: true, expired: old.filter(r => !r.released).map(r => r.shardId).sort((a, b) => a - b) };
}

/** A call-off a process asks for: a refused fork (33, 65), the second standby end (49) or the login budget (34, 61). */
export interface AskedCallOff {
  reason: string;
  countsFailure: boolean;
}

export interface CallOff {
  reason: string;
  /** Added to `failures` (33, 66). */
  failures: 0 | 1;
  /** retry_after = now (the two setting reasons and the changed count), else now + 15 min. */
  retryNow: boolean;
}

/** 11 with 32, 33 and 66: the first reason that calls the open attempt off, in 11's order; a 'flipped' one never. */
export function callOffVerdict(f: ReshardFacts, asked?: AskedCallOff): CallOff | null {
  const { row } = f;
  if (row.state !== 'standby' && row.state !== 'stopping') return null;
  const w = row.toCount ?? 0;
  const old = f.rows.filter(r => r.shardCount === row.fromCount);
  const liveOld = old.filter(r => liveRow(r, f.upMs));
  const passed = row.untilAtMs !== null && row.untilAtMs <= f.nowMs;
  if (row.state === 'stopping') {
    if (passed && liveOld.length > 0) return { reason: `${liveOld[0].holderName} did not stop within 10 min`, failures: 0, retryNow: false };
    return countChange(row);
  }
  if (passed) {
    const minutes = Math.round(((row.untilAtMs ?? 0) - (row.startedAtMs ?? 0)) / 60_000);
    let connected = 0;
    for (let shard = 0; shard < w; shard++) {
      if (f.rows.some(r => r.shardCount === w && r.shardId === shard && liveRow(r, f.upMs) && freshReady(r))) connected += 1;
    }
    return { reason: `not all ${w} new shards were connected within ${minutes} min (${connected} were)`, failures: 1, retryNow: false };
  }
  const gone = old.find(r => !r.released && r.expiresUpMs <= f.upMs);
  if (gone) return { reason: `shard ${gone.shardId} of ${gone.holderName} is no longer renewed`, failures: 1, retryNow: false };
  for (const r of liveOld) {
    const m = f.nodes.find(x => x.nodeId === r.holderNode);
    const name = m?.nodeName ?? r.holderName;
    if (!m || !m.fit) return { reason: `${name} is not healthy`, failures: 0, retryNow: false };
    if (!m.restartable) return { reason: `${name} has no web UI process to start a second bot process`, failures: 0, retryNow: true };
    if (!m.reshardOverlap) return { reason: `resharding beside the running shards was turned off on ${name}`, failures: 0, retryNow: true };
  }
  const changed = countChange(row);
  if (changed) return changed;
  if (asked) return { reason: asked.reason, failures: asked.countsFailure ? 1 : 0, retryNow: false };
  return null;
}

/** 32: the stored edge, target_at after started_at with target NULL or other than to_count. */
function countChange(row: ReshardRow): CallOff | null {
  if (row.targetAtMs === null || row.startedAtMs === null || row.targetAtMs <= row.startedAtMs) return null;
  if (row.target !== null && row.target === row.toCount) return null;
  const by = row.targetBy ?? '';
  const reason = row.target === null
    ? `FLEET_SHARD_COUNT was removed on ${by} after this reshard started`
    : `FLEET_SHARD_COUNT was changed to ${row.target} on ${by} after this reshard started`;
  return { reason, failures: 0, retryNow: true };
}

/** One live machine as decision 5's method choice reads it. */
export interface MethodNode {
  nodeName: string;
  restartable: boolean;
  reshardOverlap: boolean;
  memoryRoom: boolean | null;
  memoryFreeMb: number | null;
  memoryUseMb: number | null;
  memoryError: string | null;
  /** Ms since the reading was taken; null with none. */
  memoryAgoMs: number | null;
  startedAgoMs: number;
}

export type MethodChoice =
  | { method: 'overlap' }
  | { method: 'stop-start'; reason: string }
  | { method: null; reason: string }
  | { wait: true; reason: string };

const READING_FRESH_MS = 15 * 60_000;
const FIRST_READING_MS = 6 * 60_000;
const minutesText = (ms: number) => `${Math.max(Math.ceil(ms / 60_000), 0)} min`;

/**
 * 5, 33 and 37: overlap when every live machine has a web UI, allows it and reports room under 15 minutes old, and
 * fewer than two overlap tries toward W were called off. Otherwise stop-start when W comes from the setting, and no
 * reshard (L18) when it comes from Discord. A machine with no reading that started under 6 minutes ago delays the
 * choice, unless another machine already rules overlap out. The reasons are L18's, the first machine by name first.
 */
export function chooseMethod(nodes: MethodNode[], failures: number, source: 'setting' | 'discord'): MethodChoice {
  let reason: string | null = null;
  let wait: string | null = null;
  for (const m of nodes) {
    let why: string | null = null;
    if (!m.restartable) why = `${m.nodeName} runs without the web UI`;
    else if (!m.reshardOverlap) why = `resharding beside the running shards is off on ${m.nodeName} (FLEET_RESHARD_OVERLAP=false)`;
    else if (m.memoryAgoMs === null) {
      if (m.startedAgoMs < FIRST_READING_MS) wait ??= `waiting up to ${minutesText(FIRST_READING_MS - m.startedAgoMs)} for ${m.nodeName}'s first memory reading`;
      else why = `${m.nodeName} has no memory reading from its manager`;
    } else if (m.memoryAgoMs > READING_FRESH_MS) why = `${m.nodeName}'s memory reading is ${Math.floor(m.memoryAgoMs / 60_000)} min old`;
    else if (m.memoryRoom === null) why = `can't confirm that ${m.nodeName} has room in memory: its manager could not take the reading (${m.memoryError ?? 'no error given'})`;
    else if (m.memoryRoom === false) why = `${m.nodeName} has no room in memory (${m.memoryFreeMb ?? '?'} MB free, ${m.memoryUseMb ?? '?'} MB used)`;
    if (why !== null) { reason = why; break; }
  }
  if (reason === null && wait !== null) return { wait: true, reason: wait };
  if (reason === null && failures >= 2) reason = 'two tries beside the running shards were called off';
  if (reason === null) return { method: 'overlap' };
  return source === 'setting' ? { method: 'stop-start', reason } : { method: null, reason };
}

/**
 * 25 and 48: a serving process hands over when meta's count differs from its own and it holds no live row of meta's
 * count, whatever the attempt reads; a boot whose bootShards has not resolved never does.
 */
export function handOverVerdict(input: { granted: boolean; ownCount: number | null; metaCount: number | null; heldLiveOfMeta: boolean }): boolean {
  return input.granted && input.ownCount !== null && input.metaCount !== null && input.ownCount !== input.metaCount && !input.heldLiveOfMeta;
}

export interface StandbyAsk {
  attempt: string;
  exiting: boolean;
  /** 65's mark: the attempt of the last exit nobody asked for while a standby lived, with its code and signal. */
  overlapEnded: { attempt: string; code: number | null; signal: string | null } | null;
  /** A living standby of this attempt. */
  standbyOfAttempt: boolean;
  busy: boolean;
  /** B2's passing reason for busy; another operation by default. */
  busyReason?: string;
  forkedFor: string | null;
  /** B2's memory reason, or null when the reading shows room. */
  memoryReason: string | null;
}

export type StandbyAnswer =
  | { state: 'refused'; kind: 'passing' | 'memory'; reason: string }
  | { state: 'running' }
  | { state: 'started' };

/** 50 as 65 orders it. */
export function standbyAskVerdict(ask: StandbyAsk): StandbyAnswer {
  if (ask.exiting) return { state: 'refused', kind: 'passing', reason: 'the web UI is shutting down' };
  if (ask.overlapEnded?.attempt === ask.attempt) {
    const { code, signal } = ask.overlapEnded;
    return { state: 'refused', kind: 'memory', reason: `the previous bot process ended (code ${code}, signal ${signal}) while the second bot process ran, so room for both can't be confirmed` };
  }
  if (ask.standbyOfAttempt) return { state: 'running' };
  if (ask.busy) return { state: 'refused', kind: 'passing', reason: ask.busyReason ?? 'another operation is in progress' };
  if (ask.forkedFor !== ask.attempt && ask.memoryReason !== null) return { state: 'refused', kind: 'memory', reason: ask.memoryReason };
  return { state: 'started' };
}
