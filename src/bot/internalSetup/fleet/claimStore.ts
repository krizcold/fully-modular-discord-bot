// The shard claims SQL (NB4 decisions 2, 4, 5, 10, 12, 13, 21) on its own small pool, so a busy or hung guild-data
// pool never delays a renewal. Every query has a client bound; a timeout destroys its connection.

import { Pool } from 'pg';
import type { PoolClient, QueryConfig } from 'pg';
import { commitMayHaveLanded, isLoginRefused } from '../utils/dataBackends/postgresBackend';
import {
  CLOCK_GAP_CAP_MS,
  claimState,
  decideShardCount,
  planTake,
  qualifiesAsReceiver,
  nodeRoom,
  type ClaimRow,
  type ClaimTimings,
  type HandOver,
  type Me,
  type NodeRow,
  type Pair,
  type TakePlan,
  type ClaimState,
} from './claimRules';

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
export const RENEWAL_SQL = `
WITH pairs AS (
  SELECT * FROM unnest($1::int[], $2::int[], $3::bigint[]) AS p(shard_count, shard_id, claim)
), tick AS (
  UPDATE smdb_data.claim_clock
     SET last_gap_ms = GREATEST(${ms('now() - ticked_at')}, 0),
         up_ms = up_ms + LEAST(GREATEST(${ms('now() - ticked_at')}, 0), ${CLOCK_GAP_CAP_MS}),
         ticked_at = GREATEST(ticked_at, now())
   WHERE id = 1
  RETURNING up_ms, last_gap_ms, up_ms - LEAST(last_gap_ms, ${CLOCK_GAP_CAP_MS}) AS prev_up_ms
), prior AS (
  SELECT process_id FROM smdb_data.shard_nodes WHERE node_id = $5
), node AS (
  INSERT INTO smdb_data.shard_nodes AS n
    (node_id, node_name, process_id, capacity, takeover_seconds, fit, restartable, returns, started_at, healthy_since, seen_at)
  SELECT $5::text, $6::text, $4::text, $7::int, $8::int, $9::boolean, $10::boolean, $11::boolean,
         to_timestamp($12::float8 / 1000), CASE WHEN $9::boolean THEN now() END, now()
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
    seen_at = now()
  RETURNING 1
), renewed AS (
  UPDATE smdb_data.shard_claims c
     SET expires_up_ms = CASE WHEN ${MINE} THEN t.up_ms + $13::bigint
                              ELSE GREATEST(c.expires_up_ms, t.up_ms + c.ttl_ms) END,
         ttl_ms        = CASE WHEN ${MINE} THEN $13::bigint ELSE c.ttl_ms END,
         renewed_at    = CASE WHEN ${MINE} THEN now() ELSE c.renewed_at END,
         extended      = NOT ${MINE}
    FROM tick t, (SELECT count(*) AS k FROM node) nn
   WHERE ${MINE} OR (t.last_gap_ms > ${CLOCK_GAP_CAP_MS} AND c.expires_up_ms > t.prev_up_ms AND NOT c.extended)
  RETURNING c.shard_count, c.shard_id, c.claim, c.released, ${MINE} AS mine
)
SELECT (extract(epoch FROM now()) * 1000)::float8 AS at,
       (SELECT process_id FROM prior) AS prior_process,
       COALESCE((SELECT json_agg(json_build_object('shardCount', shard_count, 'shardId', shard_id, 'claim', claim::text,
         'released', released, 'mine', mine)) FROM renewed), '[]'::json) AS rows`;

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

/** Decision 5's classes: 28000 refused, a client timeout, a connection that failed or ended, or a server error. */
export function classifyFailure(error: unknown): FailureClass {
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
}

export type TakeAnswer =
  | { kind: 'need-count' }
  | {
      kind: 'done';
      shardCount: number;
      taken: Array<{ pair: Pair; above: 'own' | 'no-room' | null }>;
      plan: TakePlan;
      adopted: { local: number; stored: number } | null;
      /** At boot: the predecessor rows' renewed_at, database ms, for decision 10 (b)'s copy test. */
      predecessorRenewedAt: Map<number, number>;
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
}

/** The whole claims surface the shard layer uses; tests swap in a fake. */
export interface ClaimStoreApi {
  renew(request: RenewRequest): Promise<RenewAnswer>;
  take(request: TakeRequest, onBegin?: () => void): Promise<TakeAnswer>;
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

type Lane = 'renewal' | 'work' | 'release';

export class ClaimStore implements ClaimStoreApi {
  private readonly pool: Pool;
  private readonly onLane = new Map<Lane, PoolClient>();

  constructor(url: string, private readonly timings: ClaimTimings, private readonly onLoginRefused: () => void = () => undefined) {
    this.pool = new Pool({
      connectionString: url,
      max: 2,
      min: 0,
      connectionTimeoutMillis: timings.renewMs,
      idleTimeoutMillis: 30_000,
      keepAlive: true,
      application_name: CLAIMS_APPLICATION_NAME,
      statement_timeout: timings.statementMs,
      lock_timeout: Math.floor(timings.lockMs),
      idle_in_transaction_session_timeout: timings.renewMs,
    } as ConstructorParameters<typeof Pool>[0]);
    this.pool.on('error', error => console.error('[Shards] Idle claims connection error:', error.message));
  }

  /** boundMs, when a function, is read after the connect, so a caller can bound the connect and the work together. */
  private async withClient<T>(lane: Lane, boundMs: number | (() => number), connectMs: number, what: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    let client: PoolClient;
    try {
      client = await withBound(this.pool.connect(), connectMs, what, c => c.release(true));
    } catch (error) {
      this.noteRefused(error);
      throw new ClaimFailure(classifyFailure(error), error);
    }
    this.onLane.set(lane, client);
    let destroy = false;
    try {
      const bound = typeof boundMs === 'function' ? boundMs() : boundMs;
      return await withBound(fn(client), bound, what, undefined, () => { destroy = true; client.release(true); });
    } catch (error) {
      destroy = true;
      this.noteRefused(error);
      throw new ClaimFailure(classifyFailure(error), error);
    } finally {
      if (this.onLane.get(lane) === client) this.onLane.delete(lane);
      try { client.release(destroy ? true : undefined); } catch { /* already released */ }
    }
  }

  private noteRefused(error: unknown): void {
    if (isLoginRefused(error)) {
      try { this.onLoginRefused(); } catch (listenerError) { console.error('[Shards] A login-refused listener threw:', listenerError); }
    }
  }

  private q(client: PoolClient, text: string, values: unknown[] = []) {
    return client.query({ text, values, query_timeout: this.timings.renewMs } as QueryConfig);
  }

  async renew(request: RenewRequest): Promise<RenewAnswer> {
    const { me, pairs, heartbeat } = request;
    return this.withClient('renewal', this.timings.renewMs, this.timings.renewMs, 'the claim renewal', async client => {
      const res = await this.q(client, RENEWAL_SQL, [
        pairs.map(p => p.shardCount), pairs.map(p => p.shardId), pairs.map(p => p.claim), me.processId,
        me.nodeId, me.nodeName, heartbeat.capacity, heartbeat.takeoverSeconds, heartbeat.fit, heartbeat.restartable,
        heartbeat.returns, heartbeat.startedAt, request.ttlMs,
      ]);
      const row = res.rows[0];
      const rows = (typeof row.rows === 'string' ? JSON.parse(row.rows) : row.rows) as any[];
      return {
        at: Number(row.at),
        priorProcess: row.prior_process ?? null,
        rows: rows.map(r => ({ shardCount: Number(r.shardCount), shardId: Number(r.shardId), claim: Number(r.claim), released: r.released === true, mine: r.mine === true })),
      };
    });
  }

  async take(request: TakeRequest, onBegin?: () => void): Promise<TakeAnswer> {
    return this.withClient('work', 2 * this.timings.renewMs, this.timings.renewMs, 'the shard take', async client => {
      onBegin?.();
      await this.q(client, 'BEGIN');
      try {
        const answer = await this.takeIn(client, request);
        await this.q(client, 'COMMIT');
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
    const meta = (await this.q(client, `SELECT value FROM smdb_data.meta WHERE key = 'shard_count'`)).rows[0];
    const stored = meta ? parseCount(meta.value) : null;
    const all = (await this.q(client, `SELECT ${ROW_COLUMNS} FROM smdb_data.shard_claims`)).rows.map(toClaimRow);
    const nodes = (await this.q(client, `SELECT ${NODE_COLUMNS} FROM smdb_data.shard_nodes`)).rows.map(toNodeRow);
    const decision = decideShardCount(stored, request.localCount, all.filter(r => r.shardCount === stored), upMs);
    if (decision.kind === 'need-count') return decision;
    const shardCount = decision.count;
    if (decision.write) {
      await this.q(client, `INSERT INTO smdb_data.meta (key, value) VALUES ('shard_count', $1)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify({ count: shardCount })]);
    }
    if (decision.deleteOthers) await this.q(client, `DELETE FROM smdb_data.shard_claims WHERE shard_count <> $1`, [shardCount]);
    const rows = all.filter(r => r.shardCount === shardCount);
    const plan = planTake({
      me, capacity: request.capacity, boot: request.boot, known: request.known, shardCount, rows, nodes, upMs, uPrimeMs,
      copied: request.copied,
    });
    const predecessorRenewedAt = new Map<number, number>();
    if (request.boot) {
      for (const r of rows) if (r.holderNode === me.nodeId && r.holderProcess !== me.processId && !r.released) predecessorRenewedAt.set(r.shardId, r.renewedAt);
    }
    const taken: Array<{ pair: Pair; above: 'own' | 'no-room' | null }> = [];
    if (plan.takes.length > 0) {
      const claims = await this.drawClaims(client, plan.takes.length);
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
    return {
      kind: 'done', shardCount, taken, plan,
      adopted: decision.adopted ? { local: decision.adopted.local, stored: shardCount } : null,
      predecessorRenewedAt,
    };
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
        await this.q(client, 'COMMIT');
        return { shardCount: stored, upMs: Number(clock.up_ms), uPrimeMs: Number(clock.u_prime), rows, nodes };
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

  async end(): Promise<void> {
    await this.pool.end().catch(() => undefined);
  }
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
       ttl_ms = $8::bigint, expires_up_ms = $9::bigint, extended = false
  FROM unnest($2::int[], $3::bigint[], $10::bigint[], $11::text[]) AS p(shard_id, claim, old_claim, old_holder)
 WHERE c.shard_count = $1::int AND c.shard_id = p.shard_id AND c.claim = p.old_claim AND c.holder_process = p.old_holder
   AND (c.expires_up_ms <= $12::bigint OR (c.released AND c.holder_node = $5::text) OR c.holder_process = $4::text)
RETURNING c.shard_id, c.claim::text AS claim`;

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
