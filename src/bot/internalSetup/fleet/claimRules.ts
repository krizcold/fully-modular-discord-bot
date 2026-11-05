// The shard claim rules as pure functions over rows: the claims SQL (claimStore.ts) is written to match them, and the
// tests' fake store and property model run them directly.

/** The most a tick adds to the claim clock, whatever time passed since the last one. */
export const CLOCK_GAP_CAP_MS = 7500;
/** A receiver has been healthy this long before a shard returns or moves to it. */
export const HEALTHY_BEFORE_RETURN_MS = 300_000;

export interface ClaimTimings {
  /** The takeover delay (TTL). */
  ttlMs: number;
  /** R: how often the claims are renewed. */
  renewMs: number;
  /** D - T: how long a pair is served after the send of the renewal that last returned it. */
  deadlineMs: number;
  /** S: the server's statement bound on the claims pool. */
  statementMs: number;
  /** The server's lock wait bound on the claims pool. */
  lockMs: number;
}

export function claimTimings(takeoverSeconds: number): ClaimTimings {
  const ttlMs = takeoverSeconds * 1000;
  const renewMs = Math.min(ttlMs / 6, 5000);
  const statementMs = Math.min(renewMs / 2, 1500);
  return { ttlMs, renewMs, deadlineMs: (2 * ttlMs) / 3, statementMs, lockMs: statementMs / 2 };
}

export interface ClockRow {
  upMs: number;
  /** Database time of the last tick, in ms. */
  tickedAt: number;
  lastGapMs: number;
}

/** u': the value the next tick would reach at the database time nowMs. */
export function uPrime(clock: ClockRow, nowMs: number): number {
  return clock.upMs + Math.min(Math.max(nowMs - clock.tickedAt, 0), CLOCK_GAP_CAP_MS);
}

export function tickClock(clock: ClockRow, nowMs: number): { clock: ClockRow; prevUpMs: number } {
  const gap = Math.max(nowMs - clock.tickedAt, 0);
  return {
    clock: { upMs: clock.upMs + Math.min(gap, CLOCK_GAP_CAP_MS), tickedAt: Math.max(clock.tickedAt, nowMs), lastGapMs: gap },
    prevUpMs: clock.upMs,
  };
}

export interface ClaimRow {
  shardCount: number;
  shardId: number;
  claim: number;
  holderProcess: string;
  holderNode: string;
  holderName: string;
  homeNode: string;
  released: boolean;
  reserved: boolean;
  /** Database times in ms. */
  takenAt: number;
  renewedAt: number;
  ttlMs: number;
  expiresUpMs: number;
  extended: boolean;
}

export interface Pair {
  shardCount: number;
  shardId: number;
  claim: number;
}

export const pairKey = (p: Pair): string => `${p.shardCount}:${p.shardId}:${p.claim}`;

export function isExpired(row: ClaimRow, upMs: number): boolean {
  return row.expiresUpMs <= upMs;
}

/**
 * One renewal statement over the rows: the tick, this process's pairs renewed, and after a gap above the cap every
 * other row live at the clock before the tick and not extended since its holder wrote it gets its whole TTL again.
 * Answers the new clock and the rows that came back, mine marked.
 */
export function applyRenewal(
  rows: ClaimRow[],
  clock: ClockRow,
  nowMs: number,
  me: string,
  pairs: Pair[],
  ttlMs: number,
): { clock: ClockRow; returned: Array<{ row: ClaimRow; mine: boolean }> } {
  const { clock: next, prevUpMs } = tickClock(clock, nowMs);
  const asked = new Set(pairs.map(pairKey));
  const returned: Array<{ row: ClaimRow; mine: boolean }> = [];
  for (const row of rows) {
    const mine = row.holderProcess === me && asked.has(pairKey(row));
    if (mine) {
      row.expiresUpMs = next.upMs + ttlMs;
      row.ttlMs = ttlMs;
      row.renewedAt = nowMs;
      row.extended = false;
      returned.push({ row, mine });
    } else if (next.lastGapMs > CLOCK_GAP_CAP_MS && row.expiresUpMs > prevUpMs && !row.extended) {
      row.expiresUpMs = Math.max(row.expiresUpMs, next.upMs + row.ttlMs);
      row.extended = true;
      returned.push({ row, mine });
    }
  }
  return { clock: next, returned };
}

export interface FenceKey {
  shardCount: number;
  shardId: number;
  claim: number;
  processId: string;
}

/** Decision 8: a save lands only under the pair the shard's row holds for this process, unreleased, and over no newer guild stamp. */
export function fenceAdmits(row: ClaimRow | undefined, token: FenceKey, guildClaim: number | undefined): boolean {
  if (!row || row.shardCount !== token.shardCount || row.shardId !== token.shardId) return false;
  if (row.claim !== token.claim || row.holderProcess !== token.processId || row.released) return false;
  return guildClaim === undefined || guildClaim <= token.claim;
}

export interface NodeRow {
  nodeId: string;
  nodeName: string;
  processId: string;
  capacity: number;
  takeoverSeconds: number;
  fit: boolean;
  restartable: boolean;
  returns: boolean;
  /** Database ms since its last heartbeat. */
  seenAgoMs: number;
  /** Database ms it has been healthy for; null while not fit. */
  healthyForMs: number | null;
}

export function nodeSeen(node: NodeRow): boolean {
  return node.seenAgoMs < node.takeoverSeconds * 1000;
}

/** The rows held, reserved or kept for a node, live on the clock. */
export function rowsFor(nodeId: string, rows: ClaimRow[], upMs: number): number {
  return rows.filter(r => r.holderNode === nodeId && !isExpired(r, upMs)).length;
}

export function nodeRoom(node: NodeRow, rows: ClaimRow[], upMs: number): number {
  return Math.max(node.capacity - rowsFor(node.nodeId, rows, upMs), 0);
}

/** Decision 11's receiver: fit, restartable, healthy for 5 minutes, seen within its takeover delay, with room. */
export function qualifiesAsReceiver(node: NodeRow, rows: ClaimRow[], upMs: number): boolean {
  return node.fit && node.restartable && node.healthyForMs !== null && node.healthyForMs >= HEALTHY_BEFORE_RETURN_MS
    && nodeSeen(node) && nodeRoom(node, rows, upMs) > 0;
}

export interface Me {
  processId: string;
  nodeId: string;
  nodeName: string;
}

export interface TakeInput {
  me: Me;
  capacity: number;
  boot: boolean;
  /** The pairs this process holds or reserved. */
  known: Pair[];
  shardCount: number;
  /** Every row of the active count. */
  rows: ClaimRow[];
  nodes: NodeRow[];
  /** The stored claim clock, for every expiry test. */
  upMs: number;
  /** u', for remaining times. */
  uPrimeMs: number;
  /** Shards whose predecessor row another process with this node id renews (decision 10 (b)). */
  copied?: Set<number>;
}

export interface PlannedTake {
  shardId: number;
  /** The row it replaces, or none for a shard never taken. */
  row: ClaimRow | null;
  /** Why it lands above the target: one of this machine's own rows, or no other machine has room. */
  above: 'own' | 'no-room' | null;
}

export interface TakePlan {
  takes: PlannedTake[];
  /** At boot: this machine's previous process still holds these; nothing is taken until they expire. */
  wait: { shardIds: number[]; remainingMs: number } | null;
  /** Counts for the boot's "Running none" line: held by other machines, waiting for their own machine, left to machines with room. */
  heldElsewhere: number;
  /** The live rows of other machines, for decision 12's line about a kept shard taken during a restart. */
  elsewhere: Array<{ shardId: number; holderName: string }>;
  waitingForOwner: number;
  leftToOthers: number;
}

/** Decision 10: which rows a take takes, in the order it writes them. */
export function planTake(input: TakeInput): TakePlan {
  const { me, upMs } = input;
  const known = new Set(input.known.map(pairKey));
  const byShard = new Map(input.rows.map(r => [r.shardId, r]));
  const nodes = new Map(input.nodes.map(n => [n.nodeId, n]));
  const own: Array<{ shardId: number; row: ClaimRow | null }> = [];
  const others: Array<{ shardId: number; row: ClaimRow | null }> = [];
  const waitIds: number[] = [];
  let waitMs = 0;
  let heldElsewhere = 0;
  const elsewhere: Array<{ shardId: number; holderName: string }> = [];
  let waitingForOwner = 0;
  for (let shardId = 0; shardId < input.shardCount; shardId++) {
    const row = byShard.get(shardId) ?? null;
    if (!row) {
      others.push({ shardId, row });
      continue;
    }
    if (row.holderProcess === me.processId && known.has(pairKey(row))) continue;
    if (row.released && row.holderNode === me.nodeId) {
      own.push({ shardId, row });
      continue;
    }
    if (row.holderProcess === me.processId) {
      own.push({ shardId, row });
      continue;
    }
    const expired = isExpired(row, upMs);
    if (input.boot && row.holderNode === me.nodeId && !row.released) {
      if (expired) own.push({ shardId, row });
      else if (input.copied?.has(shardId)) heldElsewhere += 1;
      else {
        waitIds.push(shardId);
        waitMs = Math.max(waitMs, Math.max(row.expiresUpMs - input.uPrimeMs, 0));
      }
      continue;
    }
    if (!expired) {
      heldElsewhere += 1;
      if (row.holderNode !== me.nodeId) elsewhere.push({ shardId, holderName: row.holderName });
      continue;
    }
    if (row.holderNode !== me.nodeId) {
      const holder = nodes.get(row.holderNode);
      const expiredFor = upMs - row.expiresUpMs;
      if (holder && holder.processId !== row.holderProcess && nodeSeen(holder) && expiredFor < holder.takeoverSeconds * 1000) {
        waitingForOwner += 1;
        continue;
      }
      if (input.boot && row.homeNode !== me.nodeId) {
        const home = nodes.get(row.homeNode);
        if (expiredFor < (home?.takeoverSeconds ?? 0) * 1000) {
          waitingForOwner += 1;
          continue;
        }
      }
    }
    others.push({ shardId, row });
  }
  if (input.boot && waitIds.length > 0) {
    return { takes: [], wait: { shardIds: waitIds, remainingMs: waitMs }, heldElsewhere, elsewhere, waitingForOwner, leftToOthers: 0 };
  }

  const takes: PlannedTake[] = [];
  let count = input.rows.filter(r => r.holderProcess === me.processId && known.has(pairKey(r))).length;
  for (const pick of own) {
    count += 1;
    takes.push({ ...pick, above: count > input.capacity ? 'own' : null });
  }
  const room = Math.max(input.capacity - count, 0);
  others.sort((a, b) => {
    const aHome = a.row?.homeNode === me.nodeId ? 0 : 1;
    const bHome = b.row?.homeNode === me.nodeId ? 0 : 1;
    return aHome - bHome || a.shardId - b.shardId;
  });
  const inRoom = others.slice(0, room);
  for (const pick of inRoom) takes.push({ ...pick, above: null });
  const rest = others.slice(room).sort((a, b) => a.shardId - b.shardId);
  let m = 0;
  for (const node of input.nodes) {
    if (node.nodeId === me.nodeId || !node.fit || !node.restartable || !nodeSeen(node)) continue;
    m += nodeRoom(node, input.rows, upMs);
  }
  const extra = Math.max(rest.length - m, 0);
  for (const pick of rest.slice(0, extra)) takes.push({ ...pick, above: 'no-room' });
  return { takes, wait: null, heldElsewhere, elsewhere, waitingForOwner, leftToOthers: rest.length - extra };
}

export type CountDecision =
  | { kind: 'need-count' }
  | { kind: 'use'; count: number; write: boolean; deleteOthers: boolean; adopted: { local: number } | null };

/** Decision 13: the count every process takes under, and when a take may change it. */
export function decideShardCount(stored: number | null, local: number | null, storedRows: ClaimRow[], upMs: number): CountDecision {
  if (stored === null) {
    if (local === null) return { kind: 'need-count' };
    return { kind: 'use', count: local, write: true, deleteOthers: true, adopted: null };
  }
  if (local === null || local === stored) return { kind: 'use', count: stored, write: false, deleteOthers: false, adopted: null };
  const live = storedRows.some(r => !r.released && !isExpired(r, upMs));
  if (!live) return { kind: 'use', count: local, write: true, deleteOthers: true, adopted: null };
  return { kind: 'use', count: stored, write: false, deleteOthers: false, adopted: { local } };
}

export interface HandOver {
  shardId: number;
  receiver: string;
  move: boolean;
}

/** Decision 11: the shards this process gives away at its next stop, each to a receiver with room. */
export function planReturns(input: {
  me: Me;
  capacity: number;
  held: Pair[];
  rows: ClaimRow[];
  nodes: NodeRow[];
  upMs: number;
}): HandOver[] {
  const { me, rows, upMs } = input;
  const room = new Map<string, number>();
  for (const node of input.nodes) {
    if (node.nodeId !== me.nodeId && qualifiesAsReceiver(node, rows, upMs)) room.set(node.nodeId, nodeRoom(node, rows, upMs));
  }
  const byShard = new Map(rows.map(r => [r.shardId, r]));
  const out: HandOver[] = [];
  const given = new Set<number>();
  for (const pair of [...input.held].sort((a, b) => a.shardId - b.shardId)) {
    const home = byShard.get(pair.shardId)?.homeNode;
    if (!home || home === me.nodeId) continue;
    const left = room.get(home) ?? 0;
    if (left <= 0) continue;
    room.set(home, left - 1);
    out.push({ shardId: pair.shardId, receiver: home, move: false });
    given.add(pair.shardId);
  }
  let over = input.held.length - given.size - input.capacity;
  if (over > 0) {
    const order = input.held.filter(p => !given.has(p.shardId)).sort((a, b) => {
      const aAway = byShard.get(a.shardId)?.homeNode !== me.nodeId ? 0 : 1;
      const bAway = byShard.get(b.shardId)?.homeNode !== me.nodeId ? 0 : 1;
      return aAway - bAway || b.shardId - a.shardId;
    });
    for (const pair of order) {
      if (over <= 0) break;
      const receiver = [...room.entries()].find(([, left]) => left > 0)?.[0];
      if (!receiver) break;
      room.set(receiver, room.get(receiver)! - 1);
      out.push({ shardId: pair.shardId, receiver, move: true });
      over -= 1;
    }
  }
  return out;
}

export type ClaimState = 'held' | 'reserved' | 'kept' | 'expired' | 'expired-deferred';

/** Decision 21's state of one row, from database times only (renewedAgoMs and the node's seenAgoMs are database deltas). */
/** The state is judged on the stored clock upMs; the deferral's rest is shown from u' when given (decision 21). */
export function claimState(row: ClaimRow, renewedAgoMs: number, holder: NodeRow | undefined, upMs: number, uPrimeMs: number = upMs): { state: ClaimState; deferredMs?: number } {
  if (isExpired(row, upMs)) {
    const expiredFor = upMs - row.expiresUpMs;
    if (holder && holder.processId !== row.holderProcess && nodeSeen(holder) && expiredFor < holder.takeoverSeconds * 1000) {
      return { state: 'expired-deferred', deferredMs: Math.max(holder.takeoverSeconds * 1000 - (uPrimeMs - row.expiresUpMs), 0) };
    }
    return { state: 'expired' };
  }
  if (!row.released) return { state: 'held' };
  const renewMs = Math.min(row.ttlMs / 6, 5000);
  if (row.reserved && renewedAgoMs < 3 * renewMs) return { state: 'reserved' };
  return { state: 'kept' };
}

export type AboveReason =
  | { kind: 'no-web-ui' }
  | { kind: 'returns-off' }
  | { kind: 'moving'; to: string }
  | { kind: 'waiting-healthy'; name: string; leftMs: number }
  | { kind: 'no-room' };

/** Decision 21: why a node stays above its target, the first that applies. */
export function aboveReason(node: NodeRow, nodes: NodeRow[], rows: ClaimRow[], upMs: number): AboveReason {
  if (!node.restartable) return { kind: 'no-web-ui' };
  if (!node.returns) return { kind: 'returns-off' };
  const others = nodes.filter(n => n.nodeId !== node.nodeId);
  const receiver = others.find(n => qualifiesAsReceiver(n, rows, upMs));
  if (receiver) return { kind: 'moving', to: receiver.nodeName };
  const waiting = others.find(n => n.fit && n.restartable && nodeSeen(n) && nodeRoom(n, rows, upMs) > 0);
  if (waiting) return { kind: 'waiting-healthy', name: waiting.nodeName, leftMs: Math.max(HEALTHY_BEFORE_RETURN_MS - (waiting.healthyForMs ?? 0), 0) };
  return { kind: 'no-room' };
}

/** Elapsed time by the larger of two clocks: the monotonic one stops while a host sleeps or a VM is paused. */
export function elapsedMs(since: { perf: number; wall: number }, now: { perf: number; wall: number }): number {
  return Math.max(now.perf - since.perf, now.wall - since.wall);
}
