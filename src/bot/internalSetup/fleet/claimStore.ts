// The shard claims SQL (NB4 decisions 2, 4, 5, 10, 12, 13, 21) on its own small pool, so a busy or hung guild-data
// pool never delays a renewal. Every query has a client bound; a timeout destroys its connection.

import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import type { PoolClient, QueryConfig } from 'pg';
import { commitMayHaveLanded, isLoginRefused } from '../utils/dataBackends/postgresBackend';
import { pgConfig } from '../../../utils/databaseAddress';
import { guardPoolClients } from '../utils/pgClient';
import {
  CLOCK_GAP_CAP_MS,
  claimState,
  planRetake,
  planTake,
  qualifiesAsReceiver,
  nodeRoom,
  nodeSeen,
  type ClaimRow,
  type ClaimTimings,
  type HandOver,
  type Me,
  type NodeRow,
  type Pair,
  type TakePlan,
  type ClaimState,
} from './claimRules';
import { spread, takeGateVerdict, type GateRead, type GateRow, type GateTake, type ReshardState, type WritesMeta } from './reshardRules';

/** What the holder check (guildRequestSql.ts HOLDER_CHECK_SQL) found: no stored count, or the shard and its row's state. */
export type HolderCheck =
  | { kind: 'no-count' }
  | {
    kind: 'row';
    shardCount: number;
    shardId: number;
    /** 'none': the shard has no claim row. */
    state: ClaimState | 'none';
    holderProcess: string | null;
    holderNode: string | null;
    holderName: string | null;
  };

/** NB4 decision 21's state of the row the holder check read, judged as the fleet page judges it (claimState). */
export function holderStateOf(rows: any[]): HolderCheck {
  const r = rows[0];
  if (!r || r.n === null || r.n === undefined) return { kind: 'no-count' };
  const base = { kind: 'row' as const, shardCount: Number(r.n), shardId: Number(r.shard) };
  if (r.holder_process === null || r.holder_process === undefined) {
    return { ...base, state: 'none', holderProcess: null, holderNode: null, holderName: null };
  }
  const row: ClaimRow = {
    shardCount: base.shardCount, shardId: base.shardId, claim: Number(r.claim), holderProcess: r.holder_process,
    holderNode: r.holder_node, holderName: r.holder_name, homeNode: r.holder_node, released: r.released === true,
    reserved: r.reserved === true, takenAt: 0, renewedAt: 0, ttlMs: Number(r.ttl_ms), expiresUpMs: Number(r.expires_up_ms), extended: false,
  };
  const node: NodeRow | undefined = r.node_process_id === null || r.node_process_id === undefined ? undefined : {
    nodeId: r.holder_node, nodeName: r.holder_name, processId: r.node_process_id, capacity: 0,
    takeoverSeconds: Number(r.node_takeover_seconds), fit: false, restartable: false, returns: false,
    seenAgoMs: Number(r.node_seen_ago_ms), healthyForMs: null,
  };
  const { state } = claimState(row, Number(r.renewed_ago_ms), node, Number(r.up_ms));
  return { ...base, state, holderProcess: r.holder_process, holderNode: r.holder_node, holderName: r.holder_name };
}

export const CLAIMS_APPLICATION_NAME = 'smdb-claims';
const CLAIM_LOCK = `SELECT pg_advisory_xact_lock(hashtext('smdb_data_claim'))`;
/** Decision 12: the release's one client bound, the connect and the transaction together. */
export const RELEASE_BOUND_MS = 2000;
const ms = (expr: string) => `(extract(epoch FROM (${expr})) * 1000)::bigint`;
const U_PRIME = `up_ms + LEAST(GREATEST(${ms('now() - ticked_at')}, 0), ${CLOCK_GAP_CAP_MS})`;

const ROW_COLUMNS = `shard_count, shard_id, claim::text AS claim, holder_process, holder_node, holder_name, home_node,
  released, reserved, (extract(epoch FROM taken_at) * 1000)::float8 AS taken_at,
  (extract(epoch FROM renewed_at) * 1000)::float8 AS renewed_at, ttl_ms::text AS ttl_ms,
  expires_up_ms::text AS expires_up_ms, extended, (extract(epoch FROM (now() - renewed_at)) * 1000)::float8 AS renewed_ago_ms`;

const NODE_COLUMNS = `node_id, node_name, process_id, capacity, takeover_seconds, fit, restartable, returns,
  (extract(epoch FROM (now() - seen_at)) * 1000)::float8 AS seen_ago_ms,
  CASE WHEN healthy_since IS NULL THEN NULL ELSE (extract(epoch FROM (now() - healthy_since)) * 1000)::float8 END AS healthy_for_ms`;

const CLOCK_SELECT = `SELECT up_ms::text AS up_ms, (${U_PRIME})::text AS u_prime,
  (extract(epoch FROM now()) * 1000)::float8 AS now_ms FROM smdb_data.claim_clock WHERE id = 1`;

// Decision 5: the tick, this node's heartbeat (with its row's process id read first) and the renewal, in that lock
// order; after a gap above the cap, the same UPDATE extends every other row live before the tick and not yet extended.
const MINE = `(c.holder_process = $4 AND (c.shard_count, c.shard_id, c.claim) IN (SELECT shard_count, shard_id, claim FROM pairs))`;
const TICK_CTE = `tick AS (
  UPDATE smdb_data.claim_clock
     SET last_gap_ms = GREATEST(${ms('now() - ticked_at')}, 0),
         up_ms = up_ms + LEAST(GREATEST(${ms('now() - ticked_at')}, 0), ${CLOCK_GAP_CAP_MS}),
         ticked_at = GREATEST(ticked_at, now())
   WHERE id = 1
  RETURNING up_ms, last_gap_ms, up_ms - LEAST(last_gap_ms, ${CLOCK_GAP_CAP_MS}) AS prev_up_ms
)`;
const renewedCte = (ttl: string, extraSet: string, from: string) => `renewed AS (
  UPDATE smdb_data.shard_claims c
     SET expires_up_ms = CASE WHEN ${MINE} THEN t.up_ms + ${ttl}
                              ELSE GREATEST(c.expires_up_ms, t.up_ms + c.ttl_ms) END,
         ttl_ms        = CASE WHEN ${MINE} THEN ${ttl} ELSE c.ttl_ms END,
         renewed_at    = CASE WHEN ${MINE} THEN now() ELSE c.renewed_at END,${extraSet}
         extended      = NOT ${MINE}
    FROM ${from}
   WHERE ${MINE} OR (t.last_gap_ms > ${CLOCK_GAP_CAP_MS} AND c.expires_up_ms > t.prev_up_ms AND NOT c.extended)
  RETURNING c.shard_count, c.shard_id, c.claim, c.released, ${MINE} AS mine
)`;
const RENEWED_ROWS = `COALESCE((SELECT json_agg(json_build_object('shardCount', shard_count, 'shardId', shard_id, 'claim', claim::text,
         'released', released, 'mine', mine)) FROM renewed), '[]'::json) AS rows`;

// NB9 31, 37 and 52: the heartbeat also writes count_setting, reshard_overlap and the memory reading; on this process's
// edge, when the pre-read found this node's row with another count_setting, the target CTE, last in the lock order
// (clock, shard_nodes, shard_claims, reshard), writes the target.
export const RENEWAL_SQL = `
WITH pairs AS (
  SELECT * FROM unnest($1::int[], $2::int[], $3::bigint[]) AS p(shard_count, shard_id, claim)
), ${TICK_CTE}, prior AS (
  SELECT process_id, count_setting FROM smdb_data.shard_nodes WHERE node_id = $5
), node AS (
  INSERT INTO smdb_data.shard_nodes AS n
    (node_id, node_name, process_id, capacity, takeover_seconds, fit, restartable, returns, started_at, healthy_since, seen_at,
     count_setting, reshard_overlap, memory_room, memory_free_mb, memory_use_mb, memory_error, memory_at)
  SELECT $5::text, $6::text, $4::text, $7::int, $8::int, $9::boolean, $10::boolean, $11::boolean,
         to_timestamp($12::float8 / 1000), CASE WHEN $9::boolean THEN now() END, now(),
         $14::int, $15::boolean, $16::boolean, $17::int, $18::int, $19::text,
         CASE WHEN $20::float8 IS NULL THEN NULL ELSE now() - make_interval(secs => $20::float8 / 1000) END
    FROM tick
  ON CONFLICT (node_id) DO UPDATE SET
    node_name = EXCLUDED.node_name, process_id = EXCLUDED.process_id, capacity = EXCLUDED.capacity,
    takeover_seconds = EXCLUDED.takeover_seconds, fit = EXCLUDED.fit, restartable = EXCLUDED.restartable,
    returns = EXCLUDED.returns, started_at = EXCLUDED.started_at,
    healthy_since = CASE
      WHEN NOT EXCLUDED.fit THEN NULL
      WHEN NOT n.fit OR n.healthy_since IS NULL OR n.process_id <> EXCLUDED.process_id
        OR n.seen_at <= now() - make_interval(secs => n.takeover_seconds) THEN now()
      ELSE n.healthy_since END,
    seen_at = now(),
    count_setting = EXCLUDED.count_setting, reshard_overlap = EXCLUDED.reshard_overlap, memory_room = EXCLUDED.memory_room,
    memory_free_mb = EXCLUDED.memory_free_mb, memory_use_mb = EXCLUDED.memory_use_mb, memory_error = EXCLUDED.memory_error,
    memory_at = EXCLUDED.memory_at
  RETURNING 1
), ${renewedCte('$13::bigint', '', 'tick t, (SELECT count(*) AS k FROM node) nn')}, target AS (
  UPDATE smdb_data.reshard r
     SET target = $14::int, target_by = $6::text, target_at = now()
    FROM (SELECT count(*) AS k FROM renewed) rr
   WHERE r.id = 1 AND $21::boolean AND EXISTS (SELECT 1 FROM prior)
     AND (SELECT count_setting FROM prior) IS DISTINCT FROM $14::int
  RETURNING 1
)
SELECT (extract(epoch FROM now()) * 1000)::float8 AS at,
       (SELECT process_id FROM prior) AS prior_process,
       (SELECT count_setting FROM prior) AS prior_setting,
       EXISTS (SELECT 1 FROM target) AS target_written,
       ${RENEWED_ROWS}`;

// NB9 C14 and 7: the standby's renewal. No heartbeat (the machine's row is its serving process's) and no target; the
// clock first, then its rows with `ready` per pair.
export const STANDBY_RENEWAL_SQL = `
WITH pairs AS (
  SELECT * FROM unnest($1::int[], $2::int[], $3::bigint[], $5::boolean[]) AS p(shard_count, shard_id, claim, ready)
), ${TICK_CTE}, ${renewedCte('$6::bigint', `
         ready         = CASE WHEN ${MINE} THEN COALESCE((SELECT p.ready FROM pairs p
                           WHERE p.shard_count = c.shard_count AND p.shard_id = c.shard_id AND p.claim = c.claim LIMIT 1), false)
                         ELSE c.ready END,`, 'tick t')}
SELECT (extract(epoch FROM now()) * 1000)::float8 AS at,
       ${RENEWED_ROWS}`;

export type FailureClass =
  | { kind: 'refused' }
  | { kind: 'timeout' }
  | { kind: 'unreachable'; detail: string }
  /** severity is the server's own word, kept only when the answer may have followed a landed COMMIT. */
  | { kind: 'error'; code: string; message: string; severity?: string };

export class ClaimTimeoutError extends Error {
  constructor(what: string) {
    super(`${what} got no answer in time`);
    this.name = 'ClaimTimeoutError';
  }
}

export class ClaimFailure extends Error {
  constructor(readonly failure: FailureClass, cause?: unknown) {
    super(describeClass(failure));
    this.name = 'ClaimFailure';
    this.cause = cause;
  }
}

/** NB5 D1: the gate dropped a call begun before the latest pause, or one started while paused. */
export class ClaimPausedError extends Error {
  constructor() {
    super('the claims are paused: this process stopped writing to its database');
    this.name = 'ClaimPausedError';
  }
}

/** Decision 5's classes: 28000 refused, a client timeout, a connection that failed or ended, or a server error. */
export function classifyFailure(error: unknown): FailureClass {
  if (error instanceof ClaimPausedError) return { kind: 'unreachable', detail: 'the claims are paused' };
  if (error instanceof ClaimFailure) return error.failure;
  if (isLoginRefused(error)) return { kind: 'refused' };
  if (error instanceof ClaimTimeoutError) return { kind: 'timeout' };
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout/i.test(message) && /query|connection/i.test(message)) return { kind: 'timeout' };
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
    const severity = (error as { severity?: unknown }).severity;
    if (commitMayHaveLanded(error)) return { kind: 'error', code, message, severity: typeof severity === 'string' ? severity : 'none' };
    return { kind: 'error', code, message };
  }
  return { kind: 'unreachable', detail: message };
}

export function describeClass(failure: FailureClass): string {
  switch (failure.kind) {
    case 'refused': return 'refused';
    case 'timeout': return 'timeout';
    case 'unreachable': return `unreachable: ${failure.detail}`;
    default: return `error: SQLSTATE ${failure.code} ${failure.message}`;
  }
}

export interface Heartbeat {
  capacity: number;
  takeoverSeconds: number;
  fit: boolean;
  restartable: boolean;
  returns: boolean;
  startedAt: number;
  /** NB9 4: this machine's FLEET_SHARD_COUNT, null when unset. */
  countSetting?: number | null;
  /** NB9 20: FLEET_RESHARD_OVERLAP; on when absent. */
  reshardOverlap?: boolean;
  /** NB9 37: the memory reading as received, or null with none. */
  memory?: HeartbeatMemory | null;
  /** NB9 52: true until this process's first heartbeat statement completed. */
  targetEdge?: boolean;
}

/** NB9 19 and 37: the manager's memory reading; ageMs is its age when the heartbeat is sent. */
export interface HeartbeatMemory {
  room: boolean | null;
  freeMb: number | null;
  useMb: number | null;
  error: string | null;
  ageMs: number;
}

export interface RenewRequest {
  me: Me;
  pairs: Pair[];
  ttlMs: number;
  heartbeat: Heartbeat;
}

export interface RenewedRow extends Pair {
  released: boolean;
  mine: boolean;
}

export interface RenewAnswer {
  rows: RenewedRow[];
  /** The database time of the renewal, in ms. */
  at: number;
  /** This node's row's process id before the heartbeat, null when it had none. */
  priorProcess: string | null;
  /** NB9 31: the target this heartbeat wrote, from the setting its pre-read found; absent when it wrote none. */
  targetWritten?: { from: number | null; to: number | null } | null;
}

/** NB9 C14: the standby's renewal of its pairs, each with its readiness. */
export interface StandbyRenewRequest {
  me: Me;
  pairs: Array<Pair & { ready: boolean }>;
  ttlMs: number;
}

/** NB9 7 and 61: the standby's one take of rows of count W, while its attempt is open in 'standby'. */
export interface StandbyTakeRequest {
  me: Me;
  capacity: number;
  ttlMs: number;
  attempt: string;
  /** W. */
  shardCount: number;
}

export type StandbyTakeAnswer =
  /** The reshard row no longer holds this attempt in 'standby'; nothing was written. */
  | { kind: 'not-standby'; attempt: string | null; state: ReshardState | null; reason: string | null; toCount?: number | null }
  /** `plan.wait` set: this machine's earlier standby still holds rows of W; nothing was taken. */
  | { kind: 'done'; shardCount: number; taken: Pair[]; plan: TakePlan };

/** A client on the claims pool's work lane, as reshardStore.ts's functions take it. */
export interface WorkClient {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

export interface TakeRequest {
  me: Me;
  capacity: number;
  ttlMs: number;
  boot: boolean;
  /** The pairs this process holds or reserved. */
  known: Pair[];
  /** FLEET_SHARD_COUNT or Discord's recommendation; null when neither answered. */
  localCount: number | null;
  /** A running process's take: its rows are reservations. */
  reserve: boolean;
  copied?: Set<number>;
  /** 12's count change or 13's direct change: step (0) writes meta = localCount (NB9 73). */
  writesMeta?: WritesMeta;
  /** NB9 4: this machine's FLEET_SHARD_COUNT; the first take on an empty database writes it as the target. */
  countSetting?: number | null;
}

/** NB9 56: what the take gate's step (3) found still live, for L32. */
export interface HeldRow {
  shardCount: number;
  shardId: number;
  holderName: string;
}

/** NB9 56: the close a take wrote, with the old rows it deleted that had expired instead of being released. */
export interface ClosedAttempt {
  fromCount: number;
  toCount: number;
  expired: number[];
}

/** NB9 12 and 36: the rows a count change wrote released and kept for the other machines, for L15. */
export interface SpreadResult {
  /** The count the change left. */
  fromCount: number;
  kept: Array<{ nodeName: string; shardIds: number[]; seconds: number }>;
}

/** NB9 29: the serve's redraw of the standby's rows of W under new claims. */
export interface RedrawRequest {
  me: Me;
  shardCount: number;
  shardIds: number[];
  ttlMs: number;
}

export type RedrawAnswer =
  | { kind: 'count'; read: GateRead }
  | { kind: 'held'; read: GateRead; rows: HeldRow[] }
  | { kind: 'done'; pairs: Pair[]; closed: ClosedAttempt | null };

export type TakeAnswer =
  | { kind: 'need-count' }
  /** NB9 C1, 73, 77, D9: step (1) refused; nothing was written. */
  | { kind: 'count'; read: GateRead }
  /** NB9 56: a live row of another count outside the exception; nothing was written. */
  | { kind: 'held'; read: GateRead; rows: HeldRow[] }
  | {
      kind: 'done';
      shardCount: number;
      taken: Array<{ pair: Pair; above: 'own' | 'no-room' | null }>;
      plan: TakePlan;
      /** At boot: the predecessor rows' renewed_at, database ms, for decision 10 (b)'s copy test. */
      predecessorRenewedAt: Map<number, number>;
      read?: GateRead;
      closed?: ClosedAttempt | null;
      spread?: SpreadResult | null;
    };

export interface ReleaseRequest {
  me: Me;
  /** The reservations still in the renewal list. */
  reserved: Pair[];
  handOvers: HandOver[];
  ttlMs: number;
}

export interface ReleasedRow {
  shardId: number;
  claim: number;
  wasReserved: boolean;
  /** The receiver's name for a row handed over, null for a row kept for this node. */
  handedTo: string | null;
}

export interface PageRow extends ClaimRow {
  renewedAgoMs: number;
}

export interface PageRead {
  shardCount: number | null;
  upMs: number;
  uPrimeMs: number;
  rows: PageRow[];
  nodes: NodeRow[];
  /** NB9 74: the reshard row and meta as the take gate's step (1) reads them, in the same snapshot. */
  reshard?: GateRead;
  /** NB9 21: the rest of the reshard row for the fleet page, in the same snapshot. */
  attempt?: PageAttempt;
}

/** NB9 21: the reshard row's other columns and the counts the page shows; ages and times in ms from the read. */
export interface PageAttempt {
  method: 'overlap' | 'stop-start' | null;
  reason: string | null;
  startedAgoMs: number | null;
  untilMs: number | null;
  endedAgoMs: number | null;
  /** Ready live rows of to_count. */
  connected: number;
  /** The names of the machines with live rows of from_count. */
  waitingFor: string[];
}

/** NB5 D7: the move's re-take of the held pairs its renewal did not return. */
export interface RetakeRequest {
  me: Me;
  shardCount: number;
  pairs: Pair[];
  /** For each of the pairs' shard ids, the guilds this process holds a set for. */
  guildIds: Array<{ shardId: number; guildIds: string[] }>;
  /** The main generation the move targets. */
  generation: number;
  ttlMs: number;
}

export interface RetakeAnswer {
  taken: Array<{ before: Pair; pair: Pair }>;
  /** NB9 58: the gate refused the re-take; nothing was taken. */
  refused?: { kind: 'count'; read: GateRead } | { kind: 'held'; read: GateRead; rows: HeldRow[] };
}

/** The whole claims surface the shard layer uses; tests swap in a fake. */
export interface ClaimStoreApi {
  /** `move`: the move's own renewal, which passes the pause (NB5 D1). */
  renew(request: RenewRequest, opts?: { move?: boolean }): Promise<RenewAnswer>;
  /** NB9 C14: the standby's renewal on the renewal lane. */
  renewStandby?(request: StandbyRenewRequest): Promise<RenewAnswer>;
  /** NB9 7: the standby's take on the work lane; onBegin runs at its BEGIN. */
  standbyTake?(request: StandbyTakeRequest, onBegin?: () => void): Promise<StandbyTakeAnswer>;
  /** NB9 45: one client of the work lane for reshardStore.ts's statements (the standby's poll, the reshard checks). */
  withWorkClient?<T>(what: string, fn: (client: WorkClient) => Promise<T>): Promise<T>;
  /** NB5 D7: one transaction on the work lane that passes the pause; onCommitSent runs right before COMMIT. */
  retake(request: RetakeRequest, onCommitSent?: () => void): Promise<RetakeAnswer>;
  /** NB5 D1: no call starts, and none begun before is sent or applied, until resume(). */
  pause(): void;
  resume(): void;
  /** NB5 C5 (b): the claims pool rebuilt for the database the move writes next. */
  retarget?(entry: string): void;
  take(request: TakeRequest, onBegin?: () => void): Promise<TakeAnswer>;
  /** NB9 29 and 59: the serve's redraw through the take gate; onBegin runs at its BEGIN. */
  redraw?(request: RedrawRequest, onBegin?: () => void): Promise<RedrawAnswer>;
  release(request: ReleaseRequest, onSent?: () => void, onConnected?: () => void): Promise<ReleasedRow[]>;
  readPage(shardCount: number | null): Promise<PageRead>;
  readRow(shardCount: number, shardId: number): Promise<{ row: ClaimRow | null; storedCount: number | null }>;
  /** Destroys the connection of the work lane's query, if one is on the wire. */
  abandonWork(): void;
  /** Destroys the connection of the renewal on the wire, if any. */
  abandonRenewal(): void;
  end(): Promise<void>;
}

export function toClaimRow(r: any): PageRow {
  return {
    shardCount: Number(r.shard_count),
    shardId: Number(r.shard_id),
    claim: Number(r.claim),
    holderProcess: r.holder_process,
    holderNode: r.holder_node,
    holderName: r.holder_name,
    homeNode: r.home_node,
    released: r.released === true,
    reserved: r.reserved === true,
    takenAt: Number(r.taken_at),
    renewedAt: Number(r.renewed_at),
    ttlMs: Number(r.ttl_ms),
    expiresUpMs: Number(r.expires_up_ms),
    extended: r.extended === true,
    renewedAgoMs: Number(r.renewed_ago_ms),
  };
}

export function toNodeRow(r: any): NodeRow {
  return {
    nodeId: r.node_id,
    nodeName: r.node_name,
    processId: r.process_id,
    capacity: Number(r.capacity),
    takeoverSeconds: Number(r.takeover_seconds),
    fit: r.fit === true,
    restartable: r.restartable === true,
    returns: r.returns === true,
    seenAgoMs: Number(r.seen_ago_ms),
    healthyForMs: r.healthy_for_ms === null || r.healthy_for_ms === undefined ? null : Number(r.healthy_for_ms),
  };
}

type Lane = 'renewal' | 'work' | 'release' | 'identify';

export class ClaimStore implements ClaimStoreApi {
  private pool: Pool;
  private readonly onLane = new Map<Lane, PoolClient>();
  private paused = false;
  /** Rises at every pause and never falls, so an answer is matched to the pause count read when its call began. */
  private pauseCount = 0;
  /** NB9 16: the identify lane's one statement at a time. */
  private identifyChain: Promise<unknown> = Promise.resolve();

  /** entry: one DATA_BACKEND_URL entry, the database the process writes (NB5 C5). */
  constructor(entry: string, private readonly timings: ClaimTimings, private readonly onLoginRefused: () => void = () => undefined) {
    this.pool = this.makePool(entry);
  }

  private makePool(entry: string): Pool {
    const timings = this.timings;
    const pool = new Pool({
      max: 3,
      min: 0,
      connectionTimeoutMillis: timings.renewMs,
      idleTimeoutMillis: 30_000,
      keepAlive: true,
      application_name: CLAIMS_APPLICATION_NAME,
      statement_timeout: timings.statementMs,
      lock_timeout: Math.floor(timings.lockMs),
      idle_in_transaction_session_timeout: timings.renewMs,
      ...pgConfig(entry),
    } as ConstructorParameters<typeof Pool>[0]);
    pool.on('error', error => console.error('[Shards] Idle claims connection error:', error.message));
    guardPoolClients(pool, 'the claims pool');
    return pool;
  }

  /**
   * boundMs, when a function, is read after the connect, so a caller can bound the connect and the work together.
   * NB5 D1's gate: a call is refused while paused unless it is the move's; after the connect and at the answer, a pause
   * or a new pool since the call began destroys the client and drops the answer with ClaimPausedError.
   */
  private async withClient<T>(lane: Lane, boundMs: number | (() => number), connectMs: number, what: string, fn: (client: PoolClient) => Promise<T>, move = false): Promise<T> {
    if (this.paused && !move) throw new ClaimPausedError();
    const count = this.pauseCount;
    const pool = this.pool;
    const stale = () => this.pauseCount !== count || this.pool !== pool;
    let client: PoolClient;
    try {
      client = await withBound(pool.connect(), connectMs, what, c => c.release(true));
    } catch (error) {
      if (stale()) throw new ClaimPausedError();
      this.noteRefused(error);
      throw new ClaimFailure(classifyFailure(error), error);
    }
    if (stale()) {
      try { client.release(true); } catch { /* already released */ }
      throw new ClaimPausedError();
    }
    this.onLane.set(lane, client);
    let destroy = false;
    try {
      const bound = typeof boundMs === 'function' ? boundMs() : boundMs;
      let answer: T;
      try {
        answer = await withBound(fn(client), bound, what, undefined, () => { destroy = true; client.release(true); });
      } catch (error) {
        destroy = true;
        if (stale()) throw new ClaimPausedError();
        this.noteRefused(error);
        throw new ClaimFailure(classifyFailure(error), error);
      }
      if (stale()) {
        destroy = true;
        throw new ClaimPausedError();
      }
      return answer;
    } finally {
      if (this.onLane.get(lane) === client) this.onLane.delete(lane);
      try { client.release(destroy ? true : undefined); } catch { /* already released */ }
    }
  }

  pause(): void {
    this.paused = true;
    this.pauseCount += 1;
    this.abandonRenewal();
    this.abandonWork();
    this.abandonIdentify();
  }

  resume(): void {
    this.paused = false;
  }

  retarget(entry: string): void {
    this.abandonRenewal();
    this.abandonWork();
    this.abandonIdentify();
    const old = this.pool;
    this.pool = this.makePool(entry);
    void old.end().catch(error => console.error('[Shards] The claims pool of the database this process left did not end cleanly:', error instanceof Error ? error.message : error));
  }

  private noteRefused(error: unknown): void {
    if (isLoginRefused(error)) {
      try { this.onLoginRefused(); } catch (listenerError) { console.error('[Shards] A login-refused listener threw:', listenerError); }
    }
  }

  private q(client: PoolClient, text: string, values: unknown[] = []) {
    return client.query({ text, values, query_timeout: this.timings.renewMs } as QueryConfig);
  }

  async renew(request: RenewRequest, opts: { move?: boolean } = {}): Promise<RenewAnswer> {
    const { me, pairs, heartbeat } = request;
    const memory = heartbeat.memory ?? null;
    const countSetting = heartbeat.countSetting ?? null;
    return this.withClient('renewal', this.timings.renewMs, this.timings.renewMs, 'the claim renewal', async client => {
      const res = await this.q(client, RENEWAL_SQL, [
        pairs.map(p => p.shardCount), pairs.map(p => p.shardId), pairs.map(p => p.claim), me.processId,
        me.nodeId, me.nodeName, heartbeat.capacity, heartbeat.takeoverSeconds, heartbeat.fit, heartbeat.restartable,
        heartbeat.returns, heartbeat.startedAt, request.ttlMs,
        countSetting, heartbeat.reshardOverlap ?? true, memory?.room ?? null, memory?.freeMb ?? null, memory?.useMb ?? null,
        memory === null || memory.error === null ? null : memory.error.slice(0, 200), memory === null ? null : Math.max(memory.ageMs, 0),
        heartbeat.targetEdge === true,
      ]);
      const row = res.rows[0];
      const answer = renewedAnswer(row);
      if (row.target_written === true) {
        const prior = row.prior_setting;
        answer.targetWritten = { from: prior === null || prior === undefined ? null : Number(prior), to: countSetting };
      }
      return { ...answer, priorProcess: row.prior_process ?? null };
    }, opts.move === true);
  }

  async renewStandby(request: StandbyRenewRequest): Promise<RenewAnswer> {
    const { me, pairs } = request;
    return this.withClient('renewal', this.timings.renewMs, this.timings.renewMs, 'the claim renewal', async client => {
      const res = await this.q(client, STANDBY_RENEWAL_SQL, [
        pairs.map(p => p.shardCount), pairs.map(p => p.shardId), pairs.map(p => p.claim), me.processId,
        pairs.map(p => p.ready), request.ttlMs,
      ]);
      return { ...renewedAnswer(res.rows[0]), priorProcess: null };
    });
  }

  /**
   * NB9 7 and 61: one transaction under the advisory lock that requires the reshard row to hold this attempt in
   * 'standby', then takes rows of count W by NB4's take rules (the room counted over rows of W), each with ready false.
   * Outside the take gate (56). COMMIT only when it took rows.
   */
  async standbyTake(request: StandbyTakeRequest, onBegin?: () => void): Promise<StandbyTakeAnswer> {
    return this.withClient('work', 2 * this.timings.renewMs, this.timings.renewMs, 'the standby take', async client => {
      onBegin?.();
      await this.q(client, 'BEGIN');
      try {
        const answer = await this.standbyTakeIn(client, request);
        await this.q(client, answer.kind === 'done' && answer.taken.length > 0 ? 'COMMIT' : 'ROLLBACK');
        return answer;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }

  private async standbyTakeIn(client: PoolClient, request: StandbyTakeRequest): Promise<StandbyTakeAnswer> {
    const { me } = request;
    await this.q(client, CLAIM_LOCK);
    const clock = (await this.q(client, CLOCK_SELECT)).rows[0];
    const upMs = Number(clock.up_ms);
    const uPrimeMs = Number(clock.u_prime);
    const r = (await this.q(client, `SELECT attempt::text AS attempt, state, reason, to_count FROM smdb_data.reshard WHERE id = 1`)).rows[0];
    if (!r || r.attempt !== request.attempt || r.state !== 'standby') {
      return {
        kind: 'not-standby', attempt: r?.attempt ?? null, state: (r?.state ?? null) as ReshardState | null, reason: r?.reason ?? null,
        toCount: r?.to_count === null || r?.to_count === undefined ? null : Number(r.to_count),
      };
    }
    const w = request.shardCount;
    const rows = (await this.q(client, `SELECT ${ROW_COLUMNS} FROM smdb_data.shard_claims WHERE shard_count = $1`, [w])).rows.map(toClaimRow);
    const nodes = (await this.q(client, `SELECT ${NODE_COLUMNS} FROM smdb_data.shard_nodes`)).rows.map(toNodeRow);
    const plan = planTake({ me, capacity: request.capacity, boot: true, known: [], shardCount: w, rows, nodes, upMs, uPrimeMs });
    if (plan.takes.length === 0) return { kind: 'done', shardCount: w, taken: [], plan };
    const claims = await this.drawClaims(client, plan.takes.length);
    const picks = plan.takes.map((pick, i) => ({ pick, claim: claims[i] }));
    const fresh = picks.filter(t => t.pick.row === null);
    const retaken = picks.filter(t => t.pick.row !== null);
    const written = new Map<number, number>();
    if (fresh.length > 0) {
      const res = await this.q(client, TAKE_INSERT_SQL, [
        w, fresh.map(t => t.pick.shardId), fresh.map(t => t.claim), me.processId, me.nodeId, me.nodeName, false,
        request.ttlMs, uPrimeMs + request.ttlMs,
      ]);
      for (const row of res.rows) written.set(Number(row.shard_id), Number(row.claim));
    }
    if (retaken.length > 0) {
      const res = await this.q(client, TAKE_UPDATE_SQL, [
        w, retaken.map(t => t.pick.shardId), retaken.map(t => t.claim), me.processId, me.nodeId, me.nodeName, false,
        request.ttlMs, uPrimeMs + request.ttlMs, retaken.map(t => t.pick.row!.claim), retaken.map(t => t.pick.row!.holderProcess), upMs,
      ]);
      for (const row of res.rows) written.set(Number(row.shard_id), Number(row.claim));
    }
    const taken: Pair[] = [];
    for (const { pick } of picks) {
      const claim = written.get(pick.shardId);
      if (claim !== undefined) taken.push({ shardCount: w, shardId: pick.shardId, claim });
    }
    return { kind: 'done', shardCount: w, taken, plan };
  }

  /** NB9 45: reshardStore.ts's statements on the work lane, under its bounds; fn runs its own transaction. */
  async withWorkClient<T>(what: string, fn: (client: WorkClient) => Promise<T>): Promise<T> {
    return this.withClient('work', 2 * this.timings.renewMs, this.timings.renewMs, what, client =>
      fn({ query: (text: string, values: unknown[] = []) => this.q(client, text, values) }));
  }

  async retake(request: RetakeRequest, onCommitSent?: () => void): Promise<RetakeAnswer> {
    return this.withClient('work', 2 * this.timings.renewMs, this.timings.renewMs, 'the re-take', async client => {
      await this.q(client, 'BEGIN');
      try {
        const answer = await this.retakeIn(client, request);
        if (answer.refused) {
          await this.q(client, 'ROLLBACK');
          return answer;
        }
        onCommitSent?.();
        await this.q(client, 'COMMIT');
        return answer;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    }, true);
  }

  private async retakeIn(client: PoolClient, request: RetakeRequest): Promise<RetakeAnswer> {
    const { me } = request;
    const shardIds = [...new Set(request.pairs.map(p => p.shardId))];
    const guildIds = [...new Set(request.guildIds.flatMap(g => g.guildIds))];
    await this.q(client, CLAIM_LOCK);
    const clock = (await this.q(client, CLOCK_SELECT)).rows[0];
    const upMs = Number(clock.up_ms);
    const uPrimeMs = Number(clock.u_prime);
    const table = (await this.q(client, `SELECT to_regclass('smdb_manager.generation') IS NOT NULL AS present`)).rows[0];
    const generations = table?.present === true
      ? (await this.q(client, 'SELECT generation::text AS generation FROM smdb_manager.generation')).rows.map((r: any) => Number(r.generation))
      : [];
    const rows = (await this.q(client, `SELECT ${ROW_COLUMNS} FROM smdb_data.shard_claims WHERE shard_id = ANY($1::int[])`, [shardIds])).rows.map(toClaimRow);
    const gate = await this.takeGate(client, { boot: false, firstTake: false, localCount: null, count: request.shardCount }, upMs);
    if (gate.kind === 'count') return { taken: [], refused: { kind: 'count', read: gate.read } };
    if (gate.kind === 'held') return { taken: [], refused: { kind: 'held', read: gate.read, rows: gate.rows } };
    if (gate.kind !== 'commit') throw new Error('the re-take carries its count');
    const counts = [request.shardCount];
    const guildClaims = (await this.q(client, `SELECT guild_id, shard_count, shard_id, claim::text AS claim FROM smdb_data.guild_ownership
      WHERE (shard_count = $1 AND shard_id = ANY($2::int[])) OR guild_id = ANY($3::text[])`, [request.shardCount, shardIds, guildIds]))
      .rows.map((r: any) => ({ guildId: r.guild_id, shardCount: Number(r.shard_count), shardId: Number(r.shard_id), claim: Number(r.claim) }));
    const picks = planRetake({ me, pairs: request.pairs, guildIds: request.guildIds, generation: request.generation, generations, rows, counts, guildClaims });
    if (picks.length === 0) {
      await this.closeIfFlipped(client, gate.read, request.shardCount);
      return { taken: [] };
    }
    const claims = await this.drawClaims(client, picks.length);
    const drawn = picks.map((pick, i) => ({ pick, claim: claims[i] }));
    const fresh = drawn.filter(t => t.pick.row === null);
    const again = drawn.filter(t => t.pick.row !== null);
    const written = new Map<number, number>();
    if (fresh.length > 0) {
      const res = await this.q(client, TAKE_INSERT_SQL, [
        request.shardCount, fresh.map(t => t.pick.pair.shardId), fresh.map(t => t.claim), me.processId, me.nodeId, me.nodeName,
        false, request.ttlMs, uPrimeMs + request.ttlMs,
      ]);
      for (const r of res.rows) written.set(Number(r.shard_id), Number(r.claim));
    }
    if (again.length > 0) {
      const res = await this.q(client, TAKE_UPDATE_SQL, [
        request.shardCount, again.map(t => t.pick.pair.shardId), again.map(t => t.claim), me.processId, me.nodeId, me.nodeName,
        false, request.ttlMs, uPrimeMs + request.ttlMs, again.map(t => t.pick.row!.claim),
        again.map(t => t.pick.row!.holderProcess), upMs,
      ]);
      for (const r of res.rows) written.set(Number(r.shard_id), Number(r.claim));
    }
    const taken: RetakeAnswer['taken'] = [];
    for (const { pick } of drawn) {
      const claim = written.get(pick.pair.shardId);
      if (claim !== undefined) taken.push({ before: pick.pair, pair: { ...pick.pair, claim } });
    }
    await this.closeIfFlipped(client, gate.read, request.shardCount);
    return { taken };
  }

  async take(request: TakeRequest, onBegin?: () => void): Promise<TakeAnswer> {
    return this.withClient('work', 2 * this.timings.renewMs, this.timings.renewMs, 'the shard take', async client => {
      onBegin?.();
      await this.q(client, 'BEGIN');
      try {
        const answer = await this.takeIn(client, request);
        await this.q(client, answer.kind === 'done' ? 'COMMIT' : 'ROLLBACK');
        return answer;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }

  private async takeIn(client: PoolClient, request: TakeRequest): Promise<TakeAnswer> {
    const { me } = request;
    await this.q(client, CLAIM_LOCK);
    const clock = (await this.q(client, CLOCK_SELECT)).rows[0];
    const upMs = Number(clock.up_ms);
    const uPrimeMs = Number(clock.u_prime);
    const gate = await this.takeGate(client, {
      boot: request.boot, firstTake: true, localCount: request.localCount, writesMeta: request.writesMeta,
    }, upMs);
    if (gate.kind !== 'commit') return gate;
    const shardCount = gate.n;
    const rows = (await this.q(client, `SELECT ${ROW_COLUMNS} FROM smdb_data.shard_claims WHERE shard_count = $1`, [shardCount])).rows.map(toClaimRow);
    const nodes = (await this.q(client, `SELECT ${NODE_COLUMNS} FROM smdb_data.shard_nodes`)).rows.map(toNodeRow);
    const attempt = request.writesMeta?.kind === 'change' ? request.writesMeta.attempt : randomUUID();
    const spreadTo = request.writesMeta ? spreadOwners(shardCount, me, request.capacity, nodes) : null;
    const plan = spreadTo ? spreadPlan(me, spreadTo, rows) : planTake({
      me, capacity: request.capacity, boot: request.boot, known: request.known, shardCount, rows, nodes, upMs, uPrimeMs,
      copied: request.copied,
    });
    const kept = spreadTo ? spreadTo.filter(s => s.node.nodeId !== me.nodeId) : [];
    const predecessorRenewedAt = new Map<number, number>();
    if (request.boot) {
      for (const r of rows) if (r.holderNode === me.nodeId && r.holderProcess !== me.processId && !r.released) predecessorRenewedAt.set(r.shardId, r.renewedAt);
    }
    const taken: Array<{ pair: Pair; above: 'own' | 'no-room' | null }> = [];
    const drawnAll = plan.takes.length + kept.length > 0 ? await this.drawClaims(client, plan.takes.length + kept.length) : [];
    if (plan.takes.length > 0) {
      const claims = drawnAll.slice(0, plan.takes.length);
      const written = new Map<number, number>();
      const fresh = plan.takes.map((pick, i) => ({ pick, claim: claims[i] })).filter(t => t.pick.row === null);
      const retaken = plan.takes.map((pick, i) => ({ pick, claim: claims[i] })).filter(t => t.pick.row !== null);
      if (fresh.length > 0) {
        const res = await this.q(client, TAKE_INSERT_SQL, [
          shardCount, fresh.map(t => t.pick.shardId), fresh.map(t => t.claim), me.processId, me.nodeId, me.nodeName,
          request.reserve, request.ttlMs, uPrimeMs + request.ttlMs,
        ]);
        for (const r of res.rows) written.set(Number(r.shard_id), Number(r.claim));
      }
      if (retaken.length > 0) {
        const res = await this.q(client, TAKE_UPDATE_SQL, [
          shardCount, retaken.map(t => t.pick.shardId), retaken.map(t => t.claim), me.processId, me.nodeId, me.nodeName,
          request.reserve, request.ttlMs, uPrimeMs + request.ttlMs, retaken.map(t => t.pick.row!.claim),
          retaken.map(t => t.pick.row!.holderProcess), upMs,
        ]);
        for (const r of res.rows) written.set(Number(r.shard_id), Number(r.claim));
      }
      for (const pick of plan.takes) {
        const claim = written.get(pick.shardId);
        if (claim !== undefined) taken.push({ pair: { shardCount, shardId: pick.shardId, claim }, above: pick.above });
      }
    }
    let spreadResult: SpreadResult | null = null;
    if (request.writesMeta) {
      const keptRows = kept.length === 0 ? [] : (await this.q(client, SPREAD_SQL, [
        shardCount, `spread:${attempt}`, uPrimeMs, kept.map(k => k.shardId), drawnAll.slice(plan.takes.length),
        kept.map(k => k.node.nodeId), kept.map(k => k.node.nodeName), kept.map(k => k.node.takeoverSeconds * 1000), upMs,
      ])).rows.map((r: any) => Number(r.shard_id));
      const fromCount = request.writesMeta.kind === 'direct' ? request.writesMeta.from : gate.read.fromCount ?? 0;
      spreadResult = { fromCount, kept: keptLines(kept.filter(k => keptRows.includes(k.shardId))) };
      await this.endCountChange(client, request.writesMeta, shardCount, me, attempt);
    } else if (gate.wroteMeta && request.countSetting !== undefined && request.countSetting !== null) {
      // NB9 4: the first take on an empty database writes the target from FLEET_SHARD_COUNT, after the claim rows.
      await this.q(client, `INSERT INTO smdb_data.reshard (id, target, target_by, target_at) VALUES (1, $1, $2, now())
        ON CONFLICT (id) DO UPDATE SET target = EXCLUDED.target, target_by = EXCLUDED.target_by, target_at = EXCLUDED.target_at`,
      [request.countSetting, me.nodeName]);
    }
    const closed = await this.closeIfFlipped(client, gate.read, shardCount, gate.deleted);
    return { kind: 'done', shardCount, taken, plan, predecessorRenewedAt, read: gate.read, closed, spread: spreadResult };
  }

  /** NB9 29 and 59: one transaction on the work lane; COMMIT only for 'done'. */
  async redraw(request: RedrawRequest, onBegin?: () => void): Promise<RedrawAnswer> {
    return this.withClient('work', 2 * this.timings.renewMs, this.timings.renewMs, 'the claim redraw', async client => {
      onBegin?.();
      await this.q(client, 'BEGIN');
      try {
        const answer = await this.redrawIn(client, request);
        await this.q(client, answer.kind === 'done' ? 'COMMIT' : 'ROLLBACK');
        return answer;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }

  private async redrawIn(client: PoolClient, request: RedrawRequest): Promise<RedrawAnswer> {
    await this.q(client, CLAIM_LOCK);
    const clock = (await this.q(client, CLOCK_SELECT)).rows[0];
    const upMs = Number(clock.up_ms);
    const uPrimeMs = Number(clock.u_prime);
    const gate = await this.takeGate(client, { boot: false, firstTake: false, localCount: null, count: request.shardCount }, upMs);
    if (gate.kind === 'count' || gate.kind === 'held') return gate;
    if (gate.kind !== 'commit') throw new Error('the redraw carries its count');
    const claims = await this.drawClaims(client, request.shardIds.length);
    const res = await this.q(client, REDRAW_SQL, [
      request.me.processId, request.shardIds, claims, request.ttlMs, uPrimeMs + request.ttlMs, request.shardCount, upMs,
    ]);
    const pairs: Pair[] = res.rows
      .map((r: any) => ({ shardCount: request.shardCount, shardId: Number(r.shard_id), claim: Number(r.claim) }))
      .sort((a: Pair, b: Pair) => a.shardId - b.shardId);
    const closed = await this.closeIfFlipped(client, gate.read, request.shardCount, gate.deleted);
    return { kind: 'done', pairs, closed };
  }

  /**
   * NB9's take gate (56, 73, 77, C1, D9) in the take's transaction, after the advisory lock and the clock read: step
   * (1) reads the reshard row and meta, step (0) writes meta for a take that writes it, step (2) deletes the dead rows
   * of other counts, step (3) reads what is left. Step (5), the close, runs after the take's own statements.
   */
  private async takeGate(client: PoolClient, take: GateTake, upMs: number): Promise<
    | { kind: 'need-count' }
    | { kind: 'count'; read: GateRead }
    | { kind: 'held'; read: GateRead; rows: HeldRow[] }
    | { kind: 'commit'; read: GateRead; n: number; deleted: GateRow[]; wroteMeta: boolean }> {
    const read = toGateRead((await this.q(client, GATE_READ_SQL)).rows[0]);
    const one = takeGateVerdict(take, read, [], upMs);
    if (one.kind === 'need-count') return one;
    if (one.kind === 'count') return { kind: 'count', read };
    if (one.kind !== 'commit') throw new Error('the gate read no rows yet');
    const n = one.n;
    if (one.writeMeta) {
      await this.q(client, `INSERT INTO smdb_data.meta (key, value) VALUES ('shard_count', $1)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify({ count: n })]);
    }
    const deleted = (await this.q(client, GATE_DELETE_SQL, [n, upMs, read.toCount, read.state])).rows
      .map((r: any) => ({ shardCount: Number(r.shard_count), shardId: Number(r.shard_id), released: r.released === true, expiresUpMs: 0, holderName: '' }));
    const held = (await this.q(client, GATE_HELD_SQL, [n, upMs, read.fromCount, read.toCount, read.metaCount])).rows
      .map((r: any) => ({ shardCount: Number(r.shard_count), shardId: Number(r.shard_id), holderName: r.holder_name }));
    if (held.length > 0) return { kind: 'held', read, rows: held };
    return { kind: 'commit', read, n, deleted, wroteMeta: one.writeMeta };
  }

  /** Step (5): the close when the attempt is 'flipped' toward n, the transaction's last statement. */
  private async closeIfFlipped(client: PoolClient, read: GateRead, n: number, deleted: GateRow[] = []): Promise<ClosedAttempt | null> {
    if (read.state !== 'flipped' || read.toCount !== n || read.attempt === null) return null;
    const res = await this.q(client, CLOSE_SQL, [read.attempt, n]);
    if (res.rows.length === 0) return null;
    return {
      fromCount: read.fromCount ?? 0,
      toCount: n,
      expired: deleted.filter(r => !r.released && r.shardCount === read.fromCount).map(r => r.shardId).sort((a, b) => a - b),
    };
  }

  /** Step (4)'s rest for 12 and 13: the reshard row records the change as 'done' (NB9 12, 13). */
  private async endCountChange(client: PoolClient, writes: WritesMeta, n: number, me: Me, attempt: string): Promise<void> {
    if (writes.kind === 'change') {
      await this.q(client, `UPDATE smdb_data.reshard SET state = 'done', ended_at = now(), failures = 0, retry_after = NULL
        WHERE id = 1 AND attempt = $1::uuid AND state = 'stopping'`, [writes.attempt]);
      return;
    }
    await this.q(client, `INSERT INTO smdb_data.reshard (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
    await this.q(client, `UPDATE smdb_data.reshard SET attempt = $4::uuid, from_count = $1, to_count = $2,
        method = 'stop-start', state = 'done', started_by = $3, started_at = now(), until_at = NULL, flipped_at = NULL,
        ended_at = now(), reason = NULL, retry_after = NULL, failures = 0
      WHERE id = 1`, [writes.from, n, me.nodeName, attempt]);
  }

  /** k new claim numbers in one draw, every one above the highest number either table holds (decision 2). */
  private async drawClaims(client: PoolClient, k: number): Promise<number[]> {
    const floor = Number((await this.q(client, `SELECT GREATEST(
      COALESCE((SELECT max(claim) FROM smdb_data.guild_ownership), 0),
      COALESCE((SELECT max(claim) FROM smdb_data.shard_claims), 0))::text AS floor`)).rows[0].floor);
    const drawn = (await this.q(client, `SELECT nextval('smdb_data.claim_seq')::text AS n FROM generate_series(1, $1::int)`, [k]))
      .rows.map((r: any) => Number(r.n));
    let claims = drawn;
    if (drawn.length !== k) throw new Error(`drew ${drawn.length} claim numbers for ${k} shards`);
    if (Math.min(...drawn) <= floor) {
      const base = Math.max(floor, ...drawn);
      claims = drawn.map((_, i) => base + 1 + i);
      if (Number.isSafeInteger(claims[k - 1])) await this.q(client, `SELECT setval('smdb_data.claim_seq', $1)`, [claims[k - 1]]);
    }
    for (const claim of claims) if (!Number.isSafeInteger(claim) || claim <= 0) throw new Error(`unusable claim number ${claim}`);
    return claims;
  }

  async release(request: ReleaseRequest, onSent?: () => void, onConnected?: () => void): Promise<ReleasedRow[]> {
    const { me } = request;
    const start = performance.now();
    const left = () => Math.max(RELEASE_BOUND_MS - (performance.now() - start), 1);
    return this.withClient('release', left, RELEASE_BOUND_MS, 'the release', async client => {
      onConnected?.();
      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL lock_timeout = ${Math.max(1, Math.floor(this.timings.statementMs))}`);
        await client.query(CLAIM_LOCK);
        const clock = (await client.query(CLOCK_SELECT)).rows[0];
        const upMs = Number(clock.up_ms);
        const rows = (await client.query(`SELECT ${ROW_COLUMNS} FROM smdb_data.shard_claims`)).rows.map(toClaimRow);
        const nodes = (await client.query(`SELECT ${NODE_COLUMNS} FROM smdb_data.shard_nodes`)).rows.map(toNodeRow);
        const hand = assignReceivers(request.handOvers, nodes, rows, upMs);
        const res = await client.query(RELEASE_SQL, [
          me.processId, me.nodeId, me.nodeName, request.ttlMs,
          request.reserved.map(p => p.shardCount), request.reserved.map(p => p.shardId), request.reserved.map(p => p.claim),
          hand.map(h => h.shardId), hand.map(h => h.receiver), hand.map(h => h.move),
        ]);
        onSent?.();
        await client.query('COMMIT');
        return res.rows.map((r: any) => ({ shardId: Number(r.shard_id), claim: Number(r.claim), wasReserved: r.was_released === true, handedTo: r.handed_to ?? null }));
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }

  async readPage(shardCount: number | null): Promise<PageRead> {
    return this.withClient('work', 2 * this.timings.renewMs, this.timings.renewMs, 'the claims read', async client => {
      await this.q(client, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const clock = (await this.q(client, CLOCK_SELECT)).rows[0];
        const meta = (await this.q(client, `SELECT value FROM smdb_data.meta WHERE key = 'shard_count'`)).rows[0];
        const stored = meta ? parseCount(meta.value) : null;
        const count = stored ?? shardCount;
        const rows = count === null ? [] : (await this.q(client, `SELECT ${ROW_COLUMNS} FROM smdb_data.shard_claims WHERE shard_count = $1 ORDER BY shard_id`, [count])).rows.map(toClaimRow);
        const nodes = (await this.q(client, `SELECT ${NODE_COLUMNS} FROM smdb_data.shard_nodes ORDER BY node_name`)).rows.map(toNodeRow);
        const r = (await this.q(client, PAGE_RESHARD_SQL)).rows[0];
        const counted = r?.attempt === null || r?.attempt === undefined || r.from_count === null || r.to_count === null ? null
          : (await this.q(client, PAGE_ATTEMPT_ROWS_SQL, [r.from_count, r.to_count])).rows[0];
        await this.q(client, 'COMMIT');
        return { shardCount: stored, upMs: Number(clock.up_ms), uPrimeMs: Number(clock.u_prime), rows, nodes, reshard: toGateRead(r), attempt: toPageAttempt({ ...r, ...counted }) };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }

  async readRow(shardCount: number, shardId: number): Promise<{ row: ClaimRow | null; storedCount: number | null }> {
    return this.withClient('work', this.timings.renewMs, this.timings.renewMs, 'the claim row read', async client => {
      const row = (await this.q(client, `SELECT ${ROW_COLUMNS} FROM smdb_data.shard_claims WHERE shard_count = $1 AND shard_id = $2`, [shardCount, shardId])).rows[0];
      const meta = (await this.q(client, `SELECT value FROM smdb_data.meta WHERE key = 'shard_count'`)).rows[0];
      return { row: row ? toClaimRow(row) : null, storedCount: meta ? parseCount(meta.value) : null };
    });
  }

  abandonWork(): void {
    this.onLane.get('work')?.release(true);
    this.onLane.delete('work');
  }

  abandonRenewal(): void {
    this.onLane.get('renewal')?.release(true);
    this.onLane.delete('renewal');
  }

  abandonIdentify(): void {
    this.onLane.get('identify')?.release(true);
    this.onLane.delete('identify');
  }

  /** NB9 16 and C10: one bucket's identify slot on the 'identify' lane; true when this process may identify now. */
  reserveIdentifySlot(bucket: number, processId: string, signal?: AbortSignal): Promise<{ granted: true } | { granted: false; waitMs: number }> {
    const run = this.identifyChain.then(() => signal?.aborted ? Promise.reject(identifyAborted()) : this.reserveOnLane(bucket, processId));
    this.identifyChain = run.catch(() => undefined);
    return run;
  }

  private reserveOnLane(bucket: number, processId: string): Promise<{ granted: true } | { granted: false; waitMs: number }> {
    return this.withClient('identify',this.timings.renewMs, this.timings.renewMs, 'the identify slot', async client => {
      const won = await this.q(client, IDENTIFY_SLOT_SQL, [bucket, processId]);
      if (won.rows.length > 0) return { granted: true as const };
      const wait = (await this.q(client, IDENTIFY_WAIT_SQL, [bucket])).rows[0];
      return { granted: false as const, waitMs: wait ? Number(wait.wait_ms) : 0 };
    });
  }

  async end(): Promise<void> {
    await this.pool.end().catch(() => undefined);
  }
}

export function identifyAborted(): Error {
  const error = new Error('The identify wait was aborted');
  error.name = 'AbortError';
  return error;
}

// NB9 56, 73 and C1: step (1), one row whatever the reshard table holds.
export const GATE_READ_SQL = `
SELECT r.attempt::text AS attempt, r.state, r.from_count, r.to_count, r.target, r.target_by,
       (extract(epoch FROM r.target_at) * 1000)::float8 AS target_at,
       (SELECT (m.value::jsonb ->> 'count')::int FROM smdb_data.meta m WHERE m.key = 'shard_count') AS meta_count
  FROM (SELECT 1) one LEFT JOIN smdb_data.reshard r ON r.id = 1`;

// NB9 21: step (1)'s columns and the rest of the row the fleet page shows, for the page read.
export const PAGE_RESHARD_SQL = `
SELECT r.attempt::text AS attempt, r.state, r.from_count, r.to_count, r.target, r.target_by,
       (extract(epoch FROM r.target_at) * 1000)::float8 AS target_at,
       (SELECT (m.value::jsonb ->> 'count')::int FROM smdb_data.meta m WHERE m.key = 'shard_count') AS meta_count,
       r.method, r.reason,
       (extract(epoch FROM (now() - r.started_at)) * 1000)::float8 AS started_ago_ms,
       (extract(epoch FROM (r.until_at - now())) * 1000)::float8 AS until_ms,
       (extract(epoch FROM (now() - r.ended_at)) * 1000)::float8 AS ended_ago_ms
  FROM (SELECT 1) one LEFT JOIN smdb_data.reshard r ON r.id = 1`;

// NB9 21: with an attempt in the row, the ready live rows of to_count and the machines holding live rows of from_count.
export const PAGE_ATTEMPT_ROWS_SQL = `
SELECT (SELECT count(*) FROM smdb_data.shard_claims c
         WHERE c.shard_count = $2::int AND c.ready AND NOT c.released AND c.expires_up_ms > k.up_ms)::int AS connected,
       (SELECT array_agg(DISTINCT c.holder_name ORDER BY c.holder_name) FROM smdb_data.shard_claims c
         WHERE c.shard_count = $1::int AND NOT c.released AND c.expires_up_ms > k.up_ms) AS waiting_for
  FROM smdb_data.claim_clock k WHERE k.id = 1`;

// Step (2): the dead rows of other counts, but not the rows of an open attempt's to_count.
export const GATE_DELETE_SQL = `
DELETE FROM smdb_data.shard_claims c
 WHERE c.shard_count <> $1::int AND (c.released OR c.expires_up_ms <= $2::bigint)
   AND NOT COALESCE(c.shard_count = $3::int AND $4::text IN ('standby', 'flipped', 'stopping'), false)
RETURNING c.shard_count, c.shard_id, c.released`;

// Step (3): what is left that may block.
export const GATE_HELD_SQL = `
SELECT c.shard_count, c.shard_id, c.holder_name
  FROM smdb_data.shard_claims c
 WHERE c.shard_count <> $1::int AND NOT c.released AND c.expires_up_ms > $2::bigint
   AND NOT COALESCE($1::int = $3::int AND c.shard_count = $4::int AND $5::int = $3::int, false)
 ORDER BY c.shard_count, c.shard_id`;

// Step (5).
export const CLOSE_SQL = `
UPDATE smdb_data.reshard SET state = 'done', ended_at = now(), failures = 0, retry_after = NULL
 WHERE id = 1 AND attempt = $1::uuid AND state = 'flipped' AND to_count = $2::int
RETURNING 1`;

// NB9 16: one identify per 5.5 s per bucket across every process, on the database's clock.
export const IDENTIFY_SLOT_SQL = `
INSERT INTO smdb_data.identify_slots AS s (bucket, last_at, process_id) VALUES ($1::int, clock_timestamp(), $2::text)
ON CONFLICT (bucket) DO UPDATE SET last_at = clock_timestamp(), process_id = $2::text
 WHERE s.last_at <= clock_timestamp() - interval '5500 milliseconds'
RETURNING 1`;

export const IDENTIFY_WAIT_SQL = `
SELECT GREATEST((extract(epoch FROM s.last_at + interval '5500 milliseconds' - clock_timestamp()) * 1000)::bigint, 0)::text AS wait_ms
  FROM smdb_data.identify_slots s WHERE bucket = $1::int`;

function renewedAnswer(row: any): Omit<RenewAnswer, 'priorProcess'> {
  const rows = (typeof row.rows === 'string' ? JSON.parse(row.rows) : row.rows) as any[];
  return {
    at: Number(row.at),
    rows: rows.map(r => ({ shardCount: Number(r.shardCount), shardId: Number(r.shardId), claim: Number(r.claim), released: r.released === true, mine: r.mine === true })),
  };
}

function toGateRead(r: any): GateRead {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    attempt: r?.attempt ?? null,
    state: (r?.state ?? null) as ReshardState | null,
    fromCount: num(r?.from_count),
    toCount: num(r?.to_count),
    metaCount: num(r?.meta_count),
    target: num(r?.target),
    targetBy: r?.target_by ?? null,
    targetAt: num(r?.target_at),
  };
}

function toPageAttempt(r: any): PageAttempt {
  const num = (v: unknown) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
  const method = r?.method === 'overlap' || r?.method === 'stop-start' ? r.method : null;
  return {
    method,
    reason: typeof r?.reason === 'string' ? r.reason : null,
    startedAgoMs: num(r?.started_ago_ms),
    untilMs: num(r?.until_ms),
    endedAgoMs: num(r?.ended_ago_ms),
    connected: num(r?.connected) ?? 0,
    waitingFor: Array.isArray(r?.waiting_for) ? r.waiting_for.filter((n: unknown) => typeof n === 'string') : [],
  };
}

// Decision 10's take writes, one statement each whatever the number of shards: new rows, and rows re-taken with their
// claim and holder pinned to the row as read and the takeable test repeated, so a renewal committed in between wins.
export const TAKE_INSERT_SQL = `
INSERT INTO smdb_data.shard_claims
  (shard_count, shard_id, claim, holder_process, holder_node, holder_name, home_node, released, reserved,
   taken_at, renewed_at, ttl_ms, expires_up_ms, extended)
SELECT $1::int, p.shard_id, p.claim, $4::text, $5::text, $6::text, $5::text, $7::boolean, $7::boolean,
       now(), now(), $8::bigint, $9::bigint, false
  FROM unnest($2::int[], $3::bigint[]) AS p(shard_id, claim)
ON CONFLICT (shard_count, shard_id) DO NOTHING
RETURNING shard_id, claim::text AS claim`;

export const TAKE_UPDATE_SQL = `
UPDATE smdb_data.shard_claims c
   SET claim = p.claim, holder_process = $4::text, holder_node = $5::text, holder_name = $6::text,
       released = $7::boolean, reserved = $7::boolean, taken_at = now(), renewed_at = now(),
       ttl_ms = $8::bigint, expires_up_ms = $9::bigint, extended = false, ready = false
  FROM unnest($2::int[], $3::bigint[], $10::bigint[], $11::text[]) AS p(shard_id, claim, old_claim, old_holder)
 WHERE c.shard_count = $1::int AND c.shard_id = p.shard_id AND c.claim = p.old_claim AND c.holder_process = p.old_holder
   AND (c.expires_up_ms <= $12::bigint OR (c.released AND c.holder_node = $5::text) OR c.holder_process = $4::text)
RETURNING c.shard_id, c.claim::text AS claim`;

// NB9 12 and 36: the count change's rows for the other machines, written released and kept for each, every one with
// its own claim and the holder 'spread:<attempt>', which no process id equals. A dead row of the count is replaced.
export const SPREAD_SQL = `
INSERT INTO smdb_data.shard_claims AS c
  (shard_count, shard_id, claim, holder_process, holder_node, holder_name, home_node, released, reserved,
   taken_at, renewed_at, ttl_ms, expires_up_ms, extended)
SELECT $1::int, p.shard_id, p.claim, $2::text, p.node_id, p.node_name, p.node_id, true, false,
       now(), now(), p.ttl_ms, $3::bigint + p.ttl_ms, false
  FROM unnest($4::int[], $5::bigint[], $6::text[], $7::text[], $8::bigint[]) AS p(shard_id, claim, node_id, node_name, ttl_ms)
ON CONFLICT (shard_count, shard_id) DO UPDATE SET
  claim = EXCLUDED.claim, holder_process = EXCLUDED.holder_process, holder_node = EXCLUDED.holder_node,
  holder_name = EXCLUDED.holder_name, home_node = EXCLUDED.home_node, released = true, reserved = false,
  taken_at = now(), renewed_at = now(), ttl_ms = EXCLUDED.ttl_ms, expires_up_ms = EXCLUDED.expires_up_ms, extended = false
  WHERE c.released OR c.expires_up_ms <= $9::bigint
RETURNING c.shard_id`;

// NB9 29: the serve's redraw, step (4) of the gate with n = W; it does not test the old claim, so a retry after a lost
// reply draws again and returns the rows.
export const REDRAW_SQL = `
UPDATE smdb_data.shard_claims c
   SET claim = p.claim, taken_at = now(), renewed_at = now(), ttl_ms = $4::bigint, expires_up_ms = $5::bigint,
       extended = false
  FROM unnest($2::int[], $3::bigint[]) AS p(shard_id, claim)
 WHERE c.holder_process = $1::text AND c.shard_count = $6::int AND c.shard_id = p.shard_id
   AND NOT c.released AND c.expires_up_ms > $7::bigint
   AND (SELECT (m.value::jsonb ->> 'count')::int FROM smdb_data.meta m WHERE m.key = 'shard_count') = $6::int
RETURNING c.shard_id, c.claim::text AS claim`;

/** NB9 12: each shard's machine among this one and the live restartable machines (any fitness, they are restarting). */
function spreadOwners(w: number, me: Me, capacity: number, nodes: NodeRow[]): Array<{ shardId: number; node: NodeRow }> {
  const others = nodes.filter(n => n.nodeId !== me.nodeId && n.restartable && nodeSeen(n));
  const mine: NodeRow = {
    nodeId: me.nodeId, nodeName: me.nodeName, processId: me.processId, capacity, takeoverSeconds: 0, fit: true,
    restartable: true, returns: false, seenAgoMs: 0, healthyForMs: null,
  };
  const byId = new Map([mine, ...others].map(n => [n.nodeId, n]));
  return spread(w, mine, others).map((nodeId, shardId) => ({ shardId, node: byId.get(nodeId)! }));
}

/** This machine's share of the spread, taken as NB4's boot take writes rows. */
function spreadPlan(me: Me, owners: Array<{ shardId: number; node: NodeRow }>, rows: ClaimRow[]): TakePlan {
  const byShard = new Map(rows.map(r => [r.shardId, r]));
  const takes = owners.filter(o => o.node.nodeId === me.nodeId).map(o => ({ shardId: o.shardId, row: byShard.get(o.shardId) ?? null, above: null }));
  return { takes, wait: null, heldElsewhere: 0, elsewhere: [], waitingForOwner: 0, leftToOthers: owners.length - takes.length };
}

function keptLines(kept: Array<{ shardId: number; node: NodeRow }>): SpreadResult['kept'] {
  const by = new Map<string, { nodeName: string; shardIds: number[]; seconds: number }>();
  for (const k of kept) {
    const entry = by.get(k.node.nodeId) ?? { nodeName: k.node.nodeName, shardIds: [], seconds: k.node.takeoverSeconds };
    entry.shardIds.push(k.shardId);
    by.set(k.node.nodeId, entry);
  }
  return [...by.values()];
}

// Decision 12: every unreleased row naming this process and its reservations still listed, kept for this node with a
// fresh expiry from u', or a held pair handed to a receiver that still qualifies at this statement.
export const RELEASE_SQL = `
WITH clk AS (
  SELECT ${U_PRIME} AS u FROM smdb_data.claim_clock WHERE id = 1
), reserved AS (
  SELECT * FROM unnest($5::int[], $6::int[], $7::bigint[]) AS r(shard_count, shard_id, claim)
), hand AS (
  SELECT * FROM unnest($8::int[], $9::text[], $10::boolean[]) AS h(shard_id, receiver, move)
), recv AS (
  SELECT h.shard_id, h.move, n.node_id, n.node_name, n.takeover_seconds
    FROM hand h JOIN smdb_data.shard_nodes n ON n.node_id = h.receiver
   WHERE n.fit AND n.restartable AND n.healthy_since <= now() - interval '300 seconds'
     AND n.seen_at > now() - make_interval(secs => n.takeover_seconds)
), target AS (
  SELECT c.shard_count, c.shard_id, c.released AS was_released, r.node_id, r.node_name, r.move, r.takeover_seconds
    FROM smdb_data.shard_claims c
    LEFT JOIN recv r ON r.shard_id = c.shard_id AND NOT c.released
   WHERE c.holder_process = $1
     AND (NOT c.released OR (c.shard_count, c.shard_id, c.claim) IN (SELECT shard_count, shard_id, claim FROM reserved))
)
UPDATE smdb_data.shard_claims c
   SET released = true, reserved = false, extended = false,
       holder_node = COALESCE(t.node_id, $2), holder_name = COALESCE(t.node_name, $3),
       home_node = CASE WHEN t.move IS TRUE THEN t.node_id ELSE c.home_node END,
       ttl_ms = CASE WHEN t.node_id IS NULL THEN $4::bigint ELSE t.takeover_seconds::bigint * 1000 END,
       expires_up_ms = (SELECT u FROM clk) + CASE WHEN t.node_id IS NULL THEN $4::bigint ELSE t.takeover_seconds::bigint * 1000 END
  FROM target t
 WHERE c.shard_count = t.shard_count AND c.shard_id = t.shard_id
RETURNING c.shard_id, c.claim::text AS claim, t.was_released, t.node_name AS handed_to`;

/** Counted under the take's lock: each receiver gets at most its room, counting what this release already gave it. */
function assignReceivers(handOvers: HandOver[], nodes: NodeRow[], rows: ClaimRow[], upMs: number): HandOver[] {
  const room = new Map<string, number>();
  for (const node of nodes) if (qualifiesAsReceiver(node, rows, upMs)) room.set(node.nodeId, nodeRoom(node, rows, upMs));
  const out: HandOver[] = [];
  for (const h of handOvers) {
    const left = room.get(h.receiver) ?? 0;
    if (left <= 0) continue;
    room.set(h.receiver, left - 1);
    out.push(h);
  }
  return out;
}

function parseCount(raw: string): number | null {
  try {
    const count = (JSON.parse(raw) as { count?: unknown } | null)?.count;
    return typeof count === 'number' && Number.isInteger(count) && count > 0 ? count : null;
  } catch {
    return null;
  }
}

function withBound<T>(work: Promise<T>, boundMs: number, what: string, lateValue?: (value: T) => void, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      onTimeout?.();
      reject(new ClaimTimeoutError(what));
    }, boundMs);
    timer.unref?.();
    work.then(value => {
      clearTimeout(timer);
      if (settled) { lateValue?.(value); return; }
      settled = true;
      resolve(value);
    }, error => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}
