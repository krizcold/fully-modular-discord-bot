// PostgresBackend - central-database guild storage behind the DataBackend
// contract. Owns the connection pool, self-provisioned DDL, the fenced
// ownership transactions (hydrate/flush/retire/restore), catalog reads, and
// the outage state machine. Coalescing, freeze, byte-stringification and
// metrics live in the facade / Working Set, never here.

import { randomUUID } from 'crypto';
import { Client, Pool } from 'pg';
import { guardPoolClients, shortLivedClient } from '../pgClient';
import { FLUSH_STATEMENT_BYTES, FLUSH_WIRE_MAX, flushBoundMs, utf8Pieces } from '../storableData';
import type { PoolClient, QueryConfig, QueryResult } from 'pg';
import {
  checkShape, encodingRefusal, freshPrivilegeRefusal, freshRefusal, gateRefusal, metaGateCause, readFoundList,
  refusalLogLines, relationPrivileges, shapeRefusal, sortDifferences, unversionedRefusal, privilegeDifference,
  freshVersionRefusal, serverRelease, serverVersionRefusal, storeIdRefusal, ScratchBuildFailed, scratchRefusal,
  ddlErrorRetries, schemaDdlRefusal,
} from './storeShape';
import type { FoundList, Refusal, ShapeCheck, ShapeMode } from './storeShape';
import type {
  DataBackend,
  DocKey,
  FenceToken,
  FlushFate,
  FlushOutcome,
  GuildFlushBatch,
  GuildOwner,
  HydrationOutcome,
  RestoreOutcome,
  RestoreStop,
  RetireOutcome,
} from './backend';

export const SCHEMA_VERSION = 5;
const PROVISION_VERDICT_POLL_MS = 250;
const PARTITION_COUNT = 32;
const MAX_ROWS_PER_STATEMENT = 200;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30000;
const OUTAGE_ALERT_AFTER_MS = 10000;
const POOL_MAX = 10;
const CONNECT_TIMEOUT_MS = 5000;
const IDLE_TIMEOUT_MS = 30000;
const STATEMENT_TIMEOUT_MS = 30000;
const IDLE_IN_TX_TIMEOUT_MS = 10000;
/**
 * NB13 decision 3: how long the client waits for a COMMIT's or a save check's answer. A flush's server bound can be
 * longer; a COMMIT given up here is settled by resolveFlush, whose FOR SHARE waits until that transaction ended.
 */
export const ANSWER_BOUND_MS = 40_000;
const KEEPALIVE_DELAY_MS = 30_000;
// Each boot statement's client-side bound: the server's statement_timeout does not end a wait on a vanished server.
const PROVISION_QUERY_TIMEOUT_MS = STATEMENT_TIMEOUT_MS + 5000;
const BOOTSTRAP_LOCK_POLL_MS = 1000;
const BOOTSTRAP_LOCK_WAIT_MS = 300_000;
const MIN_SERVER_VERSION_NUM = 130000;

type Sender = { query(text: string, values?: unknown[]): Promise<QueryResult> };

function boundedSender(client: PoolClient): Sender {
  return { query: (text, values) => client.query({ text, values, query_timeout: PROVISION_QUERY_TIMEOUT_MS } as QueryConfig) };
}

/** The seed rows of provisionDdl: rows, not shape, so neither the scratch copy nor a privilege check needs them. */
export function provisionSeedRows(s: string): string[] {
  return [`INSERT INTO ${s}.claim_clock (id, up_ms, ticked_at) VALUES (1, 0, now()) ON CONFLICT (id) DO NOTHING`];
}

/** provisionDdl without its seed rows: the 17 statements that make the schema. */
export function provisionSchemaDdl(s: string): string[] {
  const seeds = new Set(provisionSeedRows(s));
  return provisionDdl(s).filter(stmt => !seeds.has(stmt));
}

// Any change here bumps SCHEMA_VERSION; the boot refuses a stored schema that differs.
/** The schema's 18 statements, rendered for a schema name (smdb_data, or the scratch copy the boot compares with). */
export function provisionDdl(s: string): string[] {
  return [
  `CREATE SCHEMA IF NOT EXISTS ${s}`,
  `CREATE TABLE IF NOT EXISTS ${s}.meta (
    key        text PRIMARY KEY,
    value      text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS ${s}.guild_ownership (
    guild_id     text PRIMARY KEY,
    node_id      text NOT NULL,
    shard_id     integer NOT NULL,
    claim        bigint NOT NULL,
    shard_count  integer NOT NULL,
    retired_at   timestamptz,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    last_flush   uuid
  )`,
  `CREATE INDEX IF NOT EXISTS guild_ownership_node_idx ON ${s}.guild_ownership (node_id)`,
  `CREATE INDEX IF NOT EXISTS guild_ownership_claim_idx ON ${s}.guild_ownership (claim)`,
  `CREATE SEQUENCE IF NOT EXISTS ${s}.claim_seq`,
  `CREATE TABLE IF NOT EXISTS ${s}.shard_claims (
    shard_count     integer     NOT NULL,
    shard_id        integer     NOT NULL,
    claim           bigint      NOT NULL,
    holder_process  text        NOT NULL,
    holder_node     text        NOT NULL,
    holder_name     text        NOT NULL,
    home_node       text        NOT NULL,
    released        boolean     NOT NULL DEFAULT false,
    reserved        boolean     NOT NULL DEFAULT false,
    taken_at        timestamptz NOT NULL DEFAULT now(),
    renewed_at      timestamptz NOT NULL DEFAULT now(),
    ttl_ms          bigint      NOT NULL,
    expires_up_ms   bigint      NOT NULL,
    extended        boolean     NOT NULL DEFAULT false,
    PRIMARY KEY (shard_count, shard_id)
  )`,
  `CREATE TABLE IF NOT EXISTS ${s}.claim_clock (
    id          integer     PRIMARY KEY CHECK (id = 1),
    up_ms       bigint      NOT NULL,
    ticked_at   timestamptz NOT NULL,
    last_gap_ms bigint      NOT NULL DEFAULT 0
  )`,
  ...provisionSeedRows(s),
  `CREATE TABLE IF NOT EXISTS ${s}.shard_nodes (
    node_id          text PRIMARY KEY,
    node_name        text        NOT NULL,
    process_id       text        NOT NULL,
    capacity         integer     NOT NULL,
    takeover_seconds integer     NOT NULL,
    fit              boolean     NOT NULL,
    restartable      boolean     NOT NULL,
    returns          boolean     NOT NULL,
    started_at       timestamptz NOT NULL,
    healthy_since    timestamptz,
    seen_at          timestamptz NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ${s}.guild_data (
    guild_id   text NOT NULL,
    module     text NOT NULL,
    filename   text NOT NULL,
    doc        text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (guild_id, module, filename)
  ) PARTITION BY HASH (guild_id)`,
  // Identity columns are rejected on partitioned tables before PG17, so seq
  // takes its default from an explicit sequence instead.
  `CREATE SEQUENCE IF NOT EXISTS ${s}.guild_append_seq`,
  `CREATE TABLE IF NOT EXISTS ${s}.guild_append (
    guild_id   text NOT NULL,
    module     text NOT NULL,
    filename   text NOT NULL,
    seq        bigint NOT NULL DEFAULT nextval('${s}.guild_append_seq'),
    chunk      text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (guild_id, module, filename, seq)
  ) PARTITION BY HASH (guild_id)`,
  `CREATE TABLE IF NOT EXISTS ${s}.guild_data_graveyard (
    guild_id   text NOT NULL,
    module     text NOT NULL,
    filename   text NOT NULL,
    kind       text NOT NULL CHECK (kind IN ('doc','append')),
    doc        text NOT NULL,
    retired_at bigint NOT NULL,
    reason     text NOT NULL,
    PRIMARY KEY (guild_id, retired_at, module, filename)
  )`,
  `CREATE INDEX IF NOT EXISTS guild_graveyard_ttl_idx ON ${s}.guild_data_graveyard (retired_at)`,
  `CREATE TABLE IF NOT EXISTS ${s}.guild_requests (
    id            uuid        PRIMARY KEY,
    guild_id      text        NOT NULL,
    shard_count   integer     NOT NULL,
    shard_id      integer     NOT NULL,
    for_process   text        NOT NULL,
    op            text        NOT NULL CHECK (op IN ('write','delete','delete-namespace','restore-graveyard')),
    body          text        NOT NULL,
    requested_by  text        NOT NULL,
    state         text        NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','applying','done','expired')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    claim_by      timestamptz NOT NULL,
    answer_by     timestamptz NOT NULL,
    claim_batch   uuid,
    applier_claim bigint,
    taken_at      timestamptz,
    reply         text,
    done_at       timestamptz
  )`,
  `CREATE INDEX IF NOT EXISTS guild_requests_pending_idx ON ${s}.guild_requests (for_process, created_at) WHERE state = 'pending'`,
  `CREATE INDEX IF NOT EXISTS guild_requests_applying_idx ON ${s}.guild_requests (claim_batch) WHERE state = 'applying'`,
  ];
}

/** The 64 partition statements of guild_data and guild_append, p00 to p31. */
export function partitionDdl(s: string, ifNotExists: boolean): string[] {
  const create = ifNotExists ? 'CREATE TABLE IF NOT EXISTS' : 'CREATE TABLE';
  const out: string[] = [];
  for (let i = 0; i < PARTITION_COUNT; i++) {
    const suffix = `p${String(i).padStart(2, '0')}`;
    out.push(`${create} ${s}.guild_data_${suffix} PARTITION OF ${s}.guild_data FOR VALUES WITH (MODULUS ${PARTITION_COUNT}, REMAINDER ${i})`);
    out.push(`${create} ${s}.guild_append_${suffix} PARTITION OF ${s}.guild_append FOR VALUES WITH (MODULUS ${PARTITION_COUNT}, REMAINDER ${i})`);
  }
  return out;
}

/**
 * Provisions a new store on a client inside its open transaction and answers its store id. The caller holds the
 * bootstrap advisory lock as a transaction lock; CREATE SCHEMA has no IF NOT EXISTS here, so a schema made since the
 * caller looked fails the transaction (42P06).
 */
export async function provisionStoreInTransaction(client: { query(text: string, params?: unknown[]): Promise<unknown> }): Promise<string> {
  await client.query('CREATE SCHEMA smdb_data');
  for (const stmt of provisionDdl('smdb_data').slice(1)) await client.query(stmt);
  for (const stmt of partitionDdl('smdb_data', false)) await client.query(stmt);
  await client.query(`INSERT INTO smdb_data.meta (key, value) VALUES ('schema_version', $1)`, [JSON.stringify({ v: SCHEMA_VERSION })]);
  const storeId = randomUUID();
  await client.query(`INSERT INTO smdb_data.meta (key, value) VALUES ('store_id', $1)`, [JSON.stringify(storeId)]);
  return storeId;
}

// NB4 decision 8: a stamp lands only while the shard's claim row holds this claim for this process, unreleased. One
// upsert, so a new holder's stamp waits for an old holder's uncommitted insert and then checks the committed row. A
// guild served again after a retire is listed again.
const SHARD_CLAIM_HELD = `EXISTS (SELECT 1 FROM smdb_data.shard_claims c
   WHERE c.shard_count = $5 AND c.shard_id = $3 AND c.claim = $4 AND c.holder_process = $6 AND NOT c.released)`;

export const FENCED_OWNERSHIP_UPSERT = `
  INSERT INTO smdb_data.guild_ownership AS o (guild_id, node_id, shard_id, claim, shard_count)
  SELECT $1::text, $2::text, $3::int, $4::bigint, $5::int
   WHERE ${SHARD_CLAIM_HELD}
  ON CONFLICT (guild_id) DO UPDATE
     SET node_id = EXCLUDED.node_id, shard_id = EXCLUDED.shard_id, claim = EXCLUDED.claim,
         shard_count = EXCLUDED.shard_count, retired_at = NULL, updated_at = now()
   WHERE o.claim <= EXCLUDED.claim`;

/** The flush's own fence: FENCED_OWNERSHIP_UPSERT that also writes the batch's id as the guild's last flush. */
export const FENCED_FLUSH_UPSERT = `
  INSERT INTO smdb_data.guild_ownership AS o (guild_id, node_id, shard_id, claim, shard_count, last_flush)
  SELECT $1::text, $2::text, $3::int, $4::bigint, $5::int, $7::uuid
   WHERE ${SHARD_CLAIM_HELD}
  ON CONFLICT (guild_id) DO UPDATE
     SET node_id = EXCLUDED.node_id, shard_id = EXCLUDED.shard_id, claim = EXCLUDED.claim,
         shard_count = EXCLUDED.shard_count, retired_at = NULL, updated_at = now(), last_flush = EXCLUDED.last_flush
   WHERE o.claim <= EXCLUDED.claim`;

const FLUSH_MARK_SELECT = `SELECT claim, last_flush, node_id FROM smdb_data.guild_ownership WHERE guild_id = $1 FOR SHARE`;

// No claims test: the insert must wait on a concurrent insert of the key, and the check's rollback removes its row.
const CHECK_OWNERSHIP_INSERT = `INSERT INTO smdb_data.guild_ownership (guild_id, node_id, shard_id, claim, shard_count)
  VALUES ($1::text, $2::text, $3::int, $4::bigint, $5::int) ON CONFLICT (guild_id) DO NOTHING`;

const OWNER_SELECT = `SELECT node_id, claim FROM smdb_data.guild_ownership WHERE guild_id = $1`;

export const OWNERSHIP_RECLAIM = `
  UPDATE smdb_data.guild_ownership
     SET shard_id = $3::int, claim = $4::bigint, shard_count = $5::int, updated_at = now()
   WHERE guild_id = $1::text AND node_id = $2::text AND claim <= $4::bigint AND ${SHARD_CLAIM_HELD}`;

const OWNERSHIP_RECLAIM_INSERT = `
  INSERT INTO smdb_data.guild_ownership (guild_id, node_id, shard_id, claim, shard_count)
  SELECT $1::text, $2::text, $3::int, $4::bigint, $5::int
   WHERE ${SHARD_CLAIM_HELD}
  ON CONFLICT (guild_id) DO NOTHING`;

/** Decision 9: the shard part of a refusal line, worded by the claim row's state. */
export function describeShardRow(shardId: number, shardCount: number, row: { claim: number; holder_name: string; released: boolean; reserved: boolean } | undefined): string {
  if (!row) return `shard ${shardId} of ${shardCount} has no claim row`;
  if (!row.released) return `shard ${shardId} of ${shardCount} is held by claim ${row.claim} (${row.holder_name})`;
  if (row.reserved) return `shard ${shardId} of ${shardCount} is reserved by claim ${row.claim} (${row.holder_name}) for its restart`;
  return `shard ${shardId} of ${shardCount} was released by claim ${row.claim} (kept for ${row.holder_name})`;
}

/** A claim the database can hold and a fence can compare: a positive safe integer. */
function usableClaim(claim: unknown): claim is number {
  return typeof claim === 'number' && Number.isSafeInteger(claim) && claim > 0;
}

function matchesSchemaVersion(raw: string): boolean {
  try {
    return (JSON.parse(raw) as { v?: number } | null)?.v === SCHEMA_VERSION;
  } catch {
    return false;
  }
}

/**
 * How provisioning ended: the schema is this bot's, the database holds another version (found), the store was refused
 * for its shape, the role's privileges or the database's encoding (the reason and fix line the boot shows), or the
 * backend stopped.
 */
export type ProvisionVerdict = { state: 'provisioned' } | { state: 'mismatch'; found: string } | { state: 'shape'; reason: string; fix: string } | { state: 'stopped' };

export type MismatchCause = 'version' | 'shape' | 'privileges' | 'encoding' | 'server' | 'identity' | 'scratch' | 'provision';

/** What a refused check does after its ROLLBACK, on the same connection, outside any transaction. */
type Latch = (client: Sender) => void | Promise<void>;

type AlertEvent = 'outage' | 'recovered' | 'deposed';
const ASK_DATABASE_TIMEOUT_MS = 5_000;

/** An error as the held log names it: its SQLSTATE when it has one, then its message. */
function describeFailure(error: unknown): { detail: string; code?: string } {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? { detail: `SQLSTATE ${code}: ${message}`, code } : { detail: message };
}

/**
 * Whether a failed COMMIT may have landed: no SQLSTATE answered it, or the answer ended the session. The severity word
 * is localized by the server's lc_messages, so the code's class counts too: 57 (operator intervention), 08 (connection
 * exception) and XX (internal error). Counting an answered failure here costs one check; missing an unanswered one
 * sends its batch twice.
 */
export function commitMayHaveLanded(error: unknown): boolean {
  const { code, severity } = (error && typeof error === 'object' ? error : {}) as { code?: unknown; severity?: unknown };
  if (typeof code !== 'string' || !/^[0-9A-Z]{5}$/.test(code)) return true;
  return severity === 'FATAL' || severity === 'PANIC' || /^(57|08|XX)/.test(code);
}

/** The database refused the login itself (SQLSTATE 28000, a role blocked from logging in); 28P01, a wrong password, is not this. */
export function isLoginRefused(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth++) {
    if ((current as { code?: unknown }).code === '28000') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
type AlertListener = (event: AlertEvent, detail: string) => void;

/** The host's monotonic clock (process.hrtime), which a wall-clock step does not move. */
export function monoNow(): bigint {
  return process.hrtime.bigint();
}

export function deadlineIn(ms: number): bigint {
  return monoNow() + BigInt(Math.round(ms)) * 1_000_000n;
}

/** Milliseconds left to a deadline read on monoNow; negative once it passed. */
export function msLeft(deadline: bigint): number {
  return Number(deadline - monoNow()) / 1e6;
}

const STATEMENT_FLOOR_MS = 1000;
const COMMIT_FLOOR_MS = 2000;
// pg's own error for a statement that outlived its query_timeout.
const QUERY_TIMEOUT_MESSAGE = 'Query read timeout';

class OutOfTime extends Error {}

type TxFailure = { kind: 'timeout' } | { kind: 'connection'; detail: string } | { kind: 'answered'; detail: string; code: string };

/** How the outage line names an error: a server error on a live session by its SQLSTATE, even in a connection class. */
function outageLine(error: unknown): string {
  if (error instanceof Error && error.message === QUERY_TIMEOUT_MESSAGE) return '[PostgresBackend] Database did not answer in time; entering outage:';
  const severity = error && typeof error === 'object' ? (error as { severity?: unknown }).severity : undefined;
  const code = describeFailure(error).code;
  const sessionLost = severity === 'FATAL' || severity === 'PANIC' || (!!code && /^(08|57P0[123])/.test(code));
  if (typeof severity === 'string' && code && !sessionLost) return `[PostgresBackend] Database operation failed (SQLSTATE ${code}); entering outage:`;
  return '[PostgresBackend] Database connection failed; entering outage:';
}

/**
 * Where an error came from: the call's own timeout, no answer (no server error, a FATAL or PANIC that ended the session,
 * class 08, or class 53, 58 or XX under a severity other than ERROR, which a FATAL or PANIC carries when
 * the server localizes it), or an answer. Only a server error (pg's DatabaseError, which carries a severity) has a
 * SQLSTATE; a socket errno such as EPIPE has the same shape and is no answer.
 */
function classifyFailure(error: unknown): TxFailure {
  if (error instanceof Error && error.message === QUERY_TIMEOUT_MESSAGE) return { kind: 'timeout' };
  const fromServer = !!error && typeof error === 'object' && typeof (error as { severity?: unknown }).severity === 'string';
  if (!fromServer) return { kind: 'connection', detail: error instanceof Error ? error.message : String(error) };
  const described = describeFailure(error);
  const code = described.code;
  const severity = (error as { severity: string }).severity;
  const sessionEnded = severity === 'FATAL' || severity === 'PANIC';
  const english = severity === 'ERROR' || sessionEnded;
  const lostSession = sessionEnded || (!english && !!code && /^(53|58|XX)/.test(code));
  if (code && !lostSession && !/^08/.test(code) && code !== '57P01' && code !== '57P02' && code !== '57P03') {
    return { kind: 'answered', detail: described.detail, code };
  }
  return { kind: 'connection', detail: described.detail };
}

/**
 * One client's statements bounded by a deadline (none when null): each carries the time left as its query_timeout; a
 * forward statement is not sent below its floor; after an error nothing more is sent and the client is destroyed.
 */
class BoundedClient {
  destroy = false;

  constructor(private readonly client: PoolClient, private readonly deadline: bigint | null) {}

  left(): number {
    return this.deadline === null ? Infinity : msLeft(this.deadline);
  }

  async send(text: string, values: unknown[] = [], floorMs = STATEMENT_FLOOR_MS): Promise<QueryResult> {
    const left = this.left();
    if (left < floorMs) throw new OutOfTime();
    try {
      return await this.client.query(this.config(text, values, left));
    } catch (error) {
      this.destroy = true;
      throw error;
    }
  }

  /** A closing statement (a ROLLBACK, the owner read), sent only with the statement floor left; null when skipped or failed. */
  async close(text: string, values: unknown[] = []): Promise<QueryResult | null> {
    const left = this.left();
    if (this.destroy || left < STATEMENT_FLOOR_MS) {
      this.destroy = true;
      return null;
    }
    try {
      return await this.client.query(this.config(text, values, left));
    } catch {
      this.destroy = true;
      return null;
    }
  }

  private config(text: string, values: unknown[], left: number): QueryConfig {
    return { text, values, ...(Number.isFinite(left) ? { query_timeout: Math.max(1, Math.floor(left)) } : {}) } as QueryConfig;
  }
}

const LIVE_CHECK = `SELECT EXISTS (SELECT 1 FROM smdb_data.guild_data WHERE guild_id = $1) OR EXISTS (SELECT 1 FROM smdb_data.guild_append WHERE guild_id = $1) AS present`;

// The rows put back are exactly the rows the DELETE took out: a row a concurrent sweep removed is skipped by both.
const STORE_ID_INSERT = `INSERT INTO smdb_data.meta (key, value) VALUES ('store_id', $1) ON CONFLICT (key) DO NOTHING`;

const RESTORE_MOVE = `WITH moved AS (
    DELETE FROM smdb_data.guild_data_graveyard WHERE guild_id = $1 AND retired_at = $2
    RETURNING guild_id, module, filename, kind, doc, reason),
  d AS (INSERT INTO smdb_data.guild_data (guild_id, module, filename, doc)
        SELECT guild_id, module, filename, doc FROM moved WHERE kind = 'doc' RETURNING 1),
  a AS (INSERT INTO smdb_data.guild_append (guild_id, module, filename, chunk)
        SELECT guild_id, module, filename, doc FROM moved WHERE kind = 'append' RETURNING 1)
  SELECT (SELECT count(*) FROM moved) AS taken, (SELECT count(*) FROM d) + (SELECT count(*) FROM a) AS put,
         (SELECT min(reason) FROM moved) AS reason`;

export class PostgresBackend implements DataBackend {
  readonly kind = 'postgres' as const;

  getPool(): Pool {
    return this.pool;
  }

  private readonly pool: Pool;
  private state: 'connecting' | 'ready' | 'outage' = 'connecting';
  private outageSince: number | undefined;
  private outageAlertFired = false;
  private outageAlertTimer: NodeJS.Timeout | null = null;
  private schemaMismatch = false;
  private mismatchFound = 'unreadable';
  private mismatchCause: MismatchCause = 'version';
  private refusal: Refusal | null = null;
  private provisioned = false;
  private started = false;
  private stopped = false;
  private probing = false;
  private readonly listeners: AlertListener[] = [];
  private readonly loginRefusedListeners: Array<() => void> = [];
  private readonly pendingSleeps = new Set<{ timer: NodeJS.Timeout; resolve: () => void }>();
  // The flush gate: at most FLUSH_WIRE_MAX flushes hold a client at once, the rest wait first in, first out.
  private flushesOnWire = 0;
  private readonly flushWaiters: Array<() => void> = [];

  private readonly markerStoreId: () => string | null;

  /**
   * markerStoreId answers the store id this machine's marker records (null for none), read when a store lacks one; it
   * throws when the marker can't be read, and the attempt then fails for bootstrapLoop to retry.
   */
  constructor(opts: { url: string; markerStoreId?: () => string | null }) {
    this.markerStoreId = opts.markerStoreId ?? (() => null);
    this.pool = new Pool({
      connectionString: opts.url,
      max: POOL_MAX,
      min: 0,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
      keepAlive: true,
      keepAliveInitialDelayMillis: KEEPALIVE_DELAY_MS,
      // Applied in the startup packet: a connect-event SET would race the
      // caller's first query on the same session (deprecated queueing, pg@9 throws).
      statement_timeout: STATEMENT_TIMEOUT_MS,
      idle_in_transaction_session_timeout: IDLE_IN_TX_TIMEOUT_MS,
    });
    this.pool.on('error', error => {
      // Unhandled idle-client errors would crash the process.
      console.error('[PostgresBackend] Idle client error:', error);
    });
    guardPoolClients(this.pool, 'the guild-data pool');
  }

  // ==========================================================================
  // LIFECYCLE + OUTAGE MACHINERY
  // ==========================================================================

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.bootstrapLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearOutageAlertTimer();
    for (const entry of this.pendingSleeps) {
      clearTimeout(entry.timer);
      entry.resolve();
    }
    this.pendingSleeps.clear();
    try {
      await this.pool.end();
    } catch { /* already ended */ }
  }

  /** Waits until provisioning has passed, has refused the store, or the backend stopped. */
  async provisionVerdict(): Promise<ProvisionVerdict> {
    for (;;) {
      if (this.stopped) return { state: 'stopped' };
      if (this.schemaMismatch && this.refusal) return { state: 'shape', reason: this.refusal.reason, fix: this.refusal.fix };
      if (this.schemaMismatch) return { state: 'mismatch', found: this.mismatchFound };
      if (this.provisioned) return { state: 'provisioned' };
      await this.sleep(PROVISION_VERDICT_POLL_MS);
    }
  }

  /** TTL sweep of graveyard rows older than the cutoff; guild_ownership rows are the claim fence and are never deleted.
   * Returns the number of rows deleted; idempotent, safe to misfire. */
  async sweepGraveyard(cutoffMs: number): Promise<number> {
    const tombstones = await this.pool.query(
      `DELETE FROM smdb_data.guild_data_graveyard WHERE retired_at < $1`, [cutoffMs]);
    return tombstones.rowCount ?? 0;
  }

  /** True while the backend may write: provisioned at this bot's schema version and not stopped. */
  servesData(): boolean {
    return this.provisioned && !this.schemaMismatch && !this.stopped;
  }

  connectionState(): { state: 'connecting' | 'ready' | 'outage'; outageSinceMs?: number } {
    if (this.state === 'outage') return { state: 'outage', outageSinceMs: this.outageSince };
    return { state: this.state };
  }

  onAlert(cb: AlertListener): void {
    this.listeners.push(cb);
  }

  /** Called each time an operation fails because the database refused the login (isLoginRefused). */
  onLoginRefused(cb: () => void): void {
    this.loginRefusedListeners.push(cb);
  }

  private noteLoginRefused(error: unknown): void {
    if (isLoginRefused(error)) this.notifyLoginRefused();
  }

  /** Another pool of this bot (the shard claims) was refused the login: the same listeners hear it. */
  notifyLoginRefused(): void {
    for (const listener of this.loginRefusedListeners) {
      try { listener(); } catch (listenerError) { console.error('[PostgresBackend] A login-refused listener threw:', listenerError); }
    }
  }

  /** SELECT 1 through the guild-data pool: the database answers, refuses the login (isLoginRefused), or neither. */
  async askDatabase(): Promise<'answers' | 'refused' | 'unreachable'> {
    try {
      await this.pool.query({ text: 'SELECT 1', query_timeout: ASK_DATABASE_TIMEOUT_MS } as QueryConfig);
      this.noteSuccess();
      return 'answers';
    } catch (error) {
      return isLoginRefused(error) ? 'refused' : 'unreachable';
    }
  }

  private async bootstrapLoop(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      try {
        await this.pool.query('SELECT 1');
        const recovery = await this.pool.query('SELECT pg_is_in_recovery() AS in_recovery');
        if (recovery.rows[0]?.in_recovery === true) {
          throw new Error('the database is in recovery (read-only); the bot serves only from a database that takes writes');
        }
        await this.provision();
        if (this.stopped || this.schemaMismatch) return;
        this.becomeReady();
        console.log('[PostgresBackend] Connected and provisioned; backend ready');
        return;
      } catch (error) {
        if (this.stopped) return;
        this.noteLoginRefused(error);
        console.warn(`[PostgresBackend] Bootstrap attempt ${attempt + 1} failed (retrying):`, error);
        await this.sleep(backoffDelay(attempt++));
      }
    }
  }

  private async outageProbeLoop(): Promise<void> {
    if (this.probing) return;
    this.probing = true;
    try {
      let attempt = 0;
      while (!this.stopped && this.state === 'outage' && !this.schemaMismatch) {
        await this.sleep(backoffDelay(attempt++));
        if (this.stopped || this.state !== 'outage' || this.schemaMismatch) return;
        try {
          await this.pool.query('SELECT 1');
          this.becomeReady();
          console.log('[PostgresBackend] Probe succeeded; backend ready');
          return;
        } catch (error) {
          this.noteLoginRefused(error);
        }
      }
    } finally {
      this.probing = false;
    }
  }

  private becomeReady(): void {
    const wasOutage = this.state === 'outage';
    this.state = 'ready';
    this.outageSince = undefined;
    this.clearOutageAlertTimer();
    if (wasOutage && this.outageAlertFired) {
      console.log('[PostgresBackend] Recovered from outage');
      this.fireAlert('recovered', 'connection to the data backend restored');
    }
    this.outageAlertFired = false;
  }

  private noteSuccess(): void {
    if (this.schemaMismatch || this.stopped) return;
    if (this.state === 'outage') this.becomeReady();
  }

  private noteFailure(error: unknown): void {
    if (this.schemaMismatch || this.stopped) return;
    this.noteLoginRefused(error);
    if (this.state !== 'ready') return; // connecting: bootstrap loop owns retries; outage: probe loop running
    this.state = 'outage';
    this.outageSince = Date.now();
    console.error(outageLine(error), error);
    this.armOutageAlert();
    void this.outageProbeLoop();
  }

  private armOutageAlert(): void {
    if (this.outageAlertFired || this.outageAlertTimer) return;
    this.outageAlertTimer = setTimeout(() => {
      this.outageAlertTimer = null;
      if (this.state === 'outage' && !this.outageAlertFired) {
        this.outageAlertFired = true;
        const sinceMs = Date.now() - (this.outageSince ?? Date.now());
        this.fireAlert('outage', `data backend unreachable for ${Math.round(sinceMs / 1000)}s`);
      }
    }, OUTAGE_ALERT_AFTER_MS);
    this.outageAlertTimer.unref();
  }

  private clearOutageAlertTimer(): void {
    if (this.outageAlertTimer) {
      clearTimeout(this.outageAlertTimer);
      this.outageAlertTimer = null;
    }
  }

  private fireAlert(event: AlertEvent, detail: string): void {
    for (const listener of this.listeners) {
      try {
        listener(event, detail);
      } catch (error) {
        console.error('[PostgresBackend] Alert listener threw:', error);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pendingSleeps.delete(entry);
        resolve();
      }, ms);
      timer.unref();
      const entry = { timer, resolve };
      this.pendingSleeps.add(entry);
    });
  }

  // ==========================================================================
  // SELF-PROVISIONING
  // ==========================================================================

  /**
   * NB16 decision 7: one transaction under the bootstrap advisory lock. The encoding, the privilege gate and the version
   * are read first; a store that holds relations is compared with a scratch copy of the schema and gets nothing but the
   * claim_clock row and the store id; an empty one is provisioned and compared before its COMMIT. A refusal rolls back
   * and latches; an error rolls back and is rethrown for bootstrapLoop to retry.
   */
  private async provision(): Promise<void> {
    if (this.provisioned) return;
    const pooled = await this.pool.connect();
    const client = boundedSender(pooled);
    let destroy = false;
    try {
      await client.query('BEGIN');
      // Each read after the lock wait sees what the lock holder committed, whatever default_transaction_isolation says.
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      if (!(await this.takeBootstrapLock(client))) {
        await client.query('ROLLBACK');
        return;
      }
      const outcome = await this.checkStore(client);
      if (outcome === 'commit') {
        await client.query('COMMIT');
        this.provisioned = true;
        return;
      }
      await client.query('ROLLBACK');
      await outcome(client);
    } catch (error) {
      destroy = true;
      await this.rollbackQuiet(client);
      throw error;
    } finally {
      pooled.release(destroy ? true : undefined);
    }
  }

  /**
   * The bootstrap lock, held until this transaction ends (NB3's migration takes the same one). Polled, so a wait behind
   * other processes' checks is not cut by statement_timeout; false when the backend stopped while waiting.
   */
  private async takeBootstrapLock(client: Sender): Promise<boolean> {
    const started = Date.now();
    let logged = false;
    for (;;) {
      const res = await client.query(`SELECT pg_try_advisory_xact_lock(hashtext('smdb_data_bootstrap')) AS locked`);
      if (res.rows[0]?.locked === true) return true;
      if (this.stopped) return false;
      if (Date.now() - started >= BOOTSTRAP_LOCK_WAIT_MS) {
        throw new Error(`the bootstrap lock stayed held for ${BOOTSTRAP_LOCK_WAIT_MS / 1000} s by another bot process's schema check or a data migration`);
      }
      if (!logged) {
        logged = true;
        console.log("[PostgresBackend] Waiting for the bootstrap lock, held by another bot process's schema check or a data migration");
      }
      await this.sleep(BOOTSTRAP_LOCK_POLL_MS);
      if (this.stopped) return false;
    }
  }

  /** Steps 1 to 8 inside the open transaction: 'commit', or the latch to set after the ROLLBACK. */
  private async checkStore(client: Sender): Promise<'commit' | Latch> {
    const versionNum = Number((await client.query('SHOW server_version_num')).rows[0]?.server_version_num);
    if (Number.isInteger(versionNum) && versionNum > 0 && versionNum < MIN_SERVER_VERSION_NUM) {
      const release = serverRelease(versionNum);
      return () => this.latchRefusal('server', serverVersionRefusal(release), release);
    }
    await client.query('SET LOCAL search_path = pg_catalog');
    await client.query('SET LOCAL quote_all_identifiers = off');
    await client.query('SET LOCAL default_table_access_method = heap');
    const encoding = String((await client.query('SHOW server_encoding')).rows[0]?.server_encoding ?? '');
    if (encoding !== 'UTF8') return () => this.latchRefusal('encoding', encodingRefusal(encoding), encoding);
    const found = await readFoundList(client);
    const gate = gateRefusal(found);
    if (gate) return () => this.latchRefusal('privileges', gate);
    let version: string | undefined;
    let unreadable: string | undefined;
    if (found.meta) {
      unreadable = metaGateCause(found.meta) ?? undefined;
      if (unreadable === undefined) {
        const read = await this.readVersion(client);
        if ('cause' in read) unreadable = read.cause;
        else version = read.value;
      }
    }
    if (version !== undefined && !matchesSchemaVersion(version)) {
      const other = version;
      return () => this.latchSchemaMismatch(other);
    }
    if (found.relations.length === 0) return this.provisionFresh(client, found);
    if (version === undefined) {
      const result = await this.compare(client, 'unversioned', found);
      if (typeof result === 'function') return result;
      return () => this.latchRefusal('shape', unversionedRefusal(found, result, unreadable));
    }
    const result = await this.compare(client, 'provisioned', found);
    if (typeof result === 'function') return result;
    const privileges = relationPrivileges(found, result.reference);
    if (result.differences.length || privileges.length) {
      const refusal = shapeRefusal(sortDifferences([...result.differences, ...privileges]));
      return () => this.latchRefusal(result.differences.length ? 'shape' : 'privileges', refusal);
    }
    const storeId = await client.query(`SELECT 1 FROM ONLY smdb_data.meta WHERE key = 'store_id'`);
    if (storeId.rows.length === 0) {
      // A new id would be refused by every machine whose marker records the old one, so with one recorded nothing is written.
      const recorded = this.markerStoreId();
      if (recorded) return () => this.latchRefusal('identity', storeIdRefusal(recorded));
      await client.query(STORE_ID_INSERT, [JSON.stringify(randomUUID())]);
    }
    for (const stmt of provisionSeedRows('smdb_data')) await client.query(stmt);
    return 'commit';
  }

  /**
   * Step 8: a smdb_data with no relation gets the schema, compared and its privileges read before any row is written;
   * then the seed rows, the version row and its reread, and the store id, all before the COMMIT.
   */
  private async provisionFresh(client: Sender, found: FoundList): Promise<'commit' | Latch> {
    try {
      for (const stmt of provisionSchemaDdl('smdb_data')) await client.query(stmt);
      for (const stmt of partitionDdl('smdb_data', true)) await client.query(stmt);
    } catch (error) {
      if (ddlErrorRetries(error)) throw error;
      const e = error as { code: string; message?: unknown };
      return this.ddlRefusal('provision', e.code, String(e.message ?? ''), found);
    }
    const result = await this.compare(client, 'provisioned', found);
    if (typeof result === 'function') return result;
    if (result.differences.length) return () => this.latchRefusal('shape', freshRefusal(result.differences));
    const again = await readFoundList(client);
    const lacking = relationPrivileges(again, result.reference);
    if (again.schemaUsage === false) {
      lacking.push(privilegeDifference(again.role, again.db, { scope: 'schema', target: 'smdb_data', privilege: 'USAGE' }));
    }
    if (lacking.length) return () => this.latchRefusal('privileges', freshPrivilegeRefusal(again.role, sortDifferences(lacking)));
    for (const stmt of provisionSeedRows('smdb_data')) await client.query(stmt);
    await client.query(
      `INSERT INTO smdb_data.meta (key, value) VALUES ('schema_version', $1) ON CONFLICT (key) DO NOTHING`,
      [JSON.stringify({ v: SCHEMA_VERSION })]);
    const reread = await this.readVersion(client);
    if (!('value' in reread) || reread.value === undefined || !matchesSchemaVersion(reread.value)) {
      const cause = 'cause' in reread
        ? reread.cause
        : reread.value === undefined ? 'smdb_data.meta holds no schema_version row' : `smdb_data.meta's schema_version reads ${reread.value}`;
      return () => this.latchRefusal('shape', freshVersionRefusal(cause));
    }
    await client.query(STORE_ID_INSERT, [JSON.stringify(randomUUID())]);
    return 'commit';
  }

  /** checkShape, or the refusal's latch when the scratch could not be built for a cause that repeats at every boot. */
  private async compare(client: Sender, mode: ShapeMode, found: FoundList): Promise<ShapeCheck | Latch> {
    try {
      return await checkShape(client, mode);
    } catch (error) {
      if (!(error instanceof ScratchBuildFailed)) throw error;
      return this.ddlRefusal('scratch', error.code, error.serverMessage, found);
    }
  }

  /** The latch for a server error from the bot's schema DDL. */
  private ddlRefusal(cause: 'scratch' | 'provision', code: string, message: string, found: FoundList): Latch {
    return async () => {
      const refusal = cause === 'scratch'
        ? scratchRefusal(code, message, found.role, found.db)
        : schemaDdlRefusal(code, message, found.role, found.db);
      this.latchRefusal(cause, refusal);
    };
  }

  /** The schema_version row of a meta that passed the gate: its value, none, or why it can't be read. */
  private async readVersion(client: Sender): Promise<{ value: string | undefined } | { cause: string }> {
    const res = await client.query(`SELECT value::text FROM ONLY smdb_data.meta WHERE key = 'schema_version'`);
    if (res.rows.length > 1) return { cause: `smdb_data.meta holds ${res.rows.length} schema_version rows` };
    if (res.rows.length === 0) return { value: undefined };
    const value = res.rows[0]?.value;
    if (value === null || value === undefined) return { cause: 'smdb_data.meta holds a schema_version row with no value' };
    return { value: String(value) };
  }

  private latchSchemaMismatch(found: string | undefined): void {
    this.schemaMismatch = true;
    this.mismatchCause = 'version';
    this.mismatchFound = found ?? 'unreadable';
    this.state = 'outage';
    if (this.outageSince === undefined) this.outageSince = Date.now();
    this.clearOutageAlertTimer();
    const detail = `schema-mismatch: smdb_data.meta schema_version is ${found ?? 'unreadable'}, expected {"v":${SCHEMA_VERSION}}; refusing to serve`;
    console.error(`[PostgresBackend] ${detail}`);
    this.outageAlertFired = true;
    this.fireAlert('outage', detail);
  }

  /** The same latch for a refusal of the store's shape, the role's privileges or the encoding, with its composed texts. */
  private latchRefusal(cause: Exclude<MismatchCause, 'version'>, refusal: Refusal, found?: string): void {
    this.schemaMismatch = true;
    this.mismatchCause = cause;
    this.refusal = refusal;
    if (found !== undefined) this.mismatchFound = found;
    this.state = 'outage';
    if (this.outageSince === undefined) this.outageSince = Date.now();
    this.clearOutageAlertTimer();
    for (const line of refusalLogLines(refusal)) console.error(line);
    this.outageAlertFired = true;
    this.fireAlert('outage', refusal.header);
  }

  /** The cause of the latch as a refused restore names it. */
  private mismatchText(): string {
    switch (this.mismatchCause) {
      case 'shape': return "the database's smdb_data differs from this bot's schema";
      case 'privileges': return "this bot's database role lacks privileges on smdb_data";
      case 'encoding': return `the database's server_encoding is ${this.mismatchFound}, not UTF8`;
      case 'server': return `the database server is PostgreSQL ${this.mismatchFound}, older than 13`;
      case 'identity': return "the database's smdb_data.meta holds no store_id";
      case 'scratch': return 'the bot could not build its copy of its schema to compare with';
      case 'provision': return 'the bot could not make its schema in the database';
      default: return `the database holds schema version ${this.mismatchFound}`;
    }
  }

  /** A fenced call with no usable claim touches no row and leaves the outage state alone. */
  private refusedWithoutClaim(op: 'hydrate' | 'flush' | 'retire' | 'reclaim' | 'restore' | 'save check', guildId: string, token: FenceToken): boolean {
    if (usableClaim(token.claim) && typeof token.processId === 'string' && token.processId) return false;
    console.error(`[PostgresBackend] Refused ${op} for guild ${guildId}: this process holds no shard claim`);
    return true;
  }

  // ==========================================================================
  // FENCED TRANSACTIONS
  // ==========================================================================

  async hydrateGuild(guildId: string, token: FenceToken): Promise<HydrationOutcome> {
    if (this.refusedWithoutClaim('hydrate', guildId, token)) return { ok: false, reason: 'unavailable' };
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      this.noteFailure(error);
      return { ok: false, reason: 'unavailable' };
    }
    let destroy = false;
    try {
      await client.query('BEGIN');
      const claim = await client.query(FENCED_OWNERSHIP_UPSERT, this.fenceParams(guildId, token));
      if ((claim.rowCount ?? 0) !== 1) {
        await client.query('ROLLBACK');
        const currentOwner = await this.readOwner(client, guildId);
        this.noteSuccess();
        return { ok: false, reason: 'deposed', currentOwner };
      }
      const read = await this.readGuildDocs(client, guildId);
      await client.query('COMMIT');
      this.noteSuccess();
      return { ok: true, ...read };
    } catch (error) {
      destroy = true;
      await this.rollbackQuiet(client);
      this.noteFailure(error);
      console.error(`[PostgresBackend] hydrateGuild failed for ${guildId}:`, error);
      return { ok: false, reason: 'unavailable' };
    } finally {
      client.release(destroy ? true : undefined);
    }
  }

  /**
   * A working set kept since its lease left, asked for again: the stamp
   * moves to the new token only while it still names this process (or the
   * guild has none), so a claim another bot process made since is never passed
   * over.
   */
  async reclaimGuild(guildId: string, token: FenceToken): Promise<'kept' | 'lost' | null> {
    if (this.refusedWithoutClaim('reclaim', guildId, token)) return null;
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      this.noteFailure(error);
      return null;
    }
    let destroy = false;
    try {
      const params = this.fenceParams(guildId, token);
      let kept = ((await client.query(OWNERSHIP_RECLAIM, params)).rowCount ?? 0) === 1;
      if (!kept) kept = ((await client.query(OWNERSHIP_RECLAIM_INSERT, params)).rowCount ?? 0) === 1;
      this.noteSuccess();
      return kept ? 'kept' : 'lost';
    } catch (error) {
      destroy = true;
      this.noteFailure(error);
      return null;
    } finally {
      client.release(destroy ? true : undefined);
    }
  }

  private async readGuildDocs(client: PoolClient, guildId: string): Promise<{ docs: { key: { module: string; filename: string }; doc: string }[]; appendKeys: { module: string; filename: string }[] }> {
    const docsRes = await client.query(
      `SELECT module, filename, doc FROM smdb_data.guild_data WHERE guild_id = $1`, [guildId]);
    const appendRes = await client.query(
      `SELECT DISTINCT module, filename FROM smdb_data.guild_append WHERE guild_id = $1`, [guildId]);
    return {
      docs: docsRes.rows.map(row => ({ key: { module: row.module, filename: row.filename }, doc: row.doc })),
      appendKeys: appendRes.rows.map(row => ({ module: row.module, filename: row.filename })),
    };
  }

  async flushGuild(guildId: string, batch: GuildFlushBatch, token: FenceToken): Promise<FlushOutcome> {
    if (this.refusedWithoutClaim('flush', guildId, token)) return { ok: false, reason: 'unavailable' };
    await this.takeFlushPlace();
    try {
      return await this.flushOnWire(guildId, batch, token);
    } finally {
      this.giveFlushPlace();
    }
  }

  /** A flush waits here, holding no client, while FLUSH_WIRE_MAX flushes are on the wire; first in, first out. */
  private takeFlushPlace(): Promise<void> {
    if (this.flushesOnWire < FLUSH_WIRE_MAX && this.flushWaiters.length === 0) {
      this.flushesOnWire += 1;
      return Promise.resolve();
    }
    return new Promise<void>(resolve => { this.flushWaiters.push(resolve); });
  }

  private giveFlushPlace(): void {
    const next = this.flushWaiters.shift();
    if (next) next();
    else this.flushesOnWire -= 1;
  }

  private async flushOnWire(guildId: string, batch: GuildFlushBatch, token: FenceToken): Promise<FlushOutcome> {
    let fence: unknown[];
    let statements: Statement[];
    let boundMs: number;
    try {
      fence = [...this.fenceParams(guildId, token), batch.flushId ?? null];
      statements = flushStatements(guildId, batch);
      let largest = statementBytes(FENCED_FLUSH_UPSERT, fence);
      for (const st of statements) if (st.bytes > largest) largest = st.bytes;
      boundMs = flushBoundMs(largest);
    } catch (error) {
      console.error(`[PostgresBackend] flushGuild for ${guildId} could not build its statements; nothing was sent (caller retries):`, error);
      return { ok: false, reason: 'unavailable' };
    }
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      this.noteFailure(error);
      return { ok: false, reason: 'unavailable', ...describeFailure(error) };
    }
    let destroy = false;
    batch.commitSent = false;
    // The query on the wire: when it was sent, its size and the server bound in force for it.
    let sent = { at: performance.now(), bytes: 0, bound: STATEMENT_TIMEOUT_MS };
    const send = (text: string, values?: unknown[], bound = boundMs) => {
      sent = { at: performance.now(), bytes: statementBytes(text, values ?? []), bound };
      return values ? client.query(text, values) : client.query(text);
    };
    try {
      await send(`BEGIN; SET LOCAL statement_timeout = ${boundMs}`, undefined, STATEMENT_TIMEOUT_MS);
      const claim = await send(FENCED_FLUSH_UPSERT, fence);
      if ((claim.rowCount ?? 0) !== 1) {
        await client.query('ROLLBACK');
        const currentOwner = await this.readOwner(client, guildId);
        const shardRow = await this.readShardRow(client, token);
        this.noteSuccess();
        const guildPart = currentOwner ? `guild ${guildId} is held by claim ${currentOwner.claim} (${currentOwner.nodeId})` : `guild ${guildId} has no ownership row`;
        const shardPart = shardRow === null ? `shard ${token.shardId} of ${token.shardCount}'s claim row could not be read` : describeShardRow(token.shardId, token.shardCount, shardRow);
        const detail = `deposed: ${guildPart}; ${shardPart}; local claim ${token.claim}`;
        console.error(`[PostgresBackend] Flush rejected: ${detail}`);
        this.fireAlert('deposed', detail);
        return { ok: false, reason: 'deposed', currentOwner };
      }
      for (const st of statements) await send(st.text, st.values);
      batch.commitSent = true;
      sent = { at: performance.now(), bytes: statementBytes('COMMIT', []), bound: boundMs };
      await client.query({ text: 'COMMIT', query_timeout: ANSWER_BOUND_MS } as QueryConfig);
      this.noteSuccess();
      return { ok: true };
    } catch (error) {
      const failedAt = performance.now();
      destroy = true;
      const failure = describeFailure(error);
      // A ROLLBACK after a sent COMMIT changes nothing, and after the client bound node-pg would queue it behind the COMMIT.
      const unanswered = batch.commitSent === true && commitMayHaveLanded(error);
      if (!unanswered) await this.rollbackQuiet(client);
      this.noteFailure(error);
      if ((error as { code?: unknown } | null)?.code === '57014') {
        const kib = Math.ceil(sent.bytes / 1024);
        const elapsed = failedAt - sent.at;
        const boundS = Math.round(sent.bound / 1000);
        console.error(elapsed >= sent.bound
          ? `[PostgresBackend] flushGuild for ${guildId}: a statement of ${kib} KiB did not finish within the flush's ${boundS} s bound (SQLSTATE 57014); a slow link to the database, a slow database or a lock held by another transaction can cause this (caller retries)`
          : `[PostgresBackend] flushGuild for ${guildId}: a statement of ${kib} KiB was cancelled after ${Math.floor(elapsed / 1000)} s, before the flush's ${boundS} s bound (SQLSTATE 57014); a cancel request from outside the bot, such as pg_cancel_backend, ends a statement this way (caller retries)`);
      } else {
        console.error(`[PostgresBackend] flushGuild failed for ${guildId} (caller retries):`, error);
      }
      return { ok: false, reason: 'unavailable', ...failure, ...(unanswered ? { commitUnanswered: true } : {}) };
    } finally {
      client.release(destroy ? true : undefined);
    }
  }

  /**
   * NB13 decision 4: whether the flush with this id landed. FOR SHARE waits on the row lock the unanswered
   * transaction took at its fence, so the row is read only once that transaction ended. The answer is taken from the
   * row as soon as it is read; the check changes nothing, so its ROLLBACK is not awaited. A check holds a place of
   * the flush gate until its client is released, so checks and flushes together leave two clients of the pool free.
   */
  async resolveFlush(guildId: string, flushId: string, sentClaim: number, token: FenceToken): Promise<FlushFate> {
    if (this.refusedWithoutClaim('save check', guildId, token)) return { fate: 'unknown', detail: 'this process holds no shard claim' };
    await this.takeFlushPlace();
    let given = false;
    const give = () => {
      if (given) return;
      given = true;
      this.giveFlushPlace();
    };
    try {
      return await this.checkOnWire(guildId, flushId, sentClaim, token, give);
    } catch (error) {
      give();
      throw error;
    }
  }

  private async checkOnWire(guildId: string, flushId: string, sentClaim: number, token: FenceToken, give: () => void): Promise<FlushFate> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      give();
      this.noteFailure(error);
      return { fate: 'unknown', ...describeFailure(error) };
    }
    const ask = (text: string, values?: unknown[]) => client.query({ text, values, query_timeout: ANSWER_BOUND_MS } as QueryConfig);
    let row: { claim: string | number; last_flush: string | null; node_id?: string } | undefined;
    try {
      await ask('BEGIN');
      row = (await ask(FLUSH_MARK_SELECT, [guildId])).rows[0];
      if (!row) {
        const inserted = await ask(CHECK_OWNERSHIP_INSERT, [guildId, token.nodeId, token.shardId, token.claim, token.shardCount]);
        if ((inserted.rowCount ?? 0) === 1) {
          this.endCheck(client, ask, give);
          this.noteSuccess();
          return { fate: 'not-landed' };
        }
        row = (await ask(FLUSH_MARK_SELECT, [guildId])).rows[0];
      }
    } catch (error) {
      client.release(true);
      give();
      this.noteFailure(error);
      return { fate: 'unknown', ...describeFailure(error) };
    }
    this.endCheck(client, ask, give);
    this.noteSuccess();
    if (!row) return { fate: 'unknown', detail: "the guild's ownership row was not found after an insert conflicted on it" };
    const claim = Number(row.claim);
    const marked = row.last_flush === flushId;
    if (claim > (token.claim ?? 0)) {
      const currentOwner = typeof row.node_id === 'string' ? { nodeId: row.node_id, claim } : undefined;
      this.fireAlert('deposed', `deposed: guild ${guildId} is held by claim ${claim}; local claim ${token.claim}`);
      return { fate: 'deposed', landed: marked ? true : null, ...(currentOwner ? { currentOwner } : {}) };
    }
    if (marked) return { fate: 'landed' };
    if (claim > sentClaim) {
      console.warn(`[Data] Guild ${guildId}: a save sent under claim ${sentClaim} got no answer, and the guild's ownership row now holds claim ${claim}; can't confirm whether it landed, so it is sent again, and lines it appended may be stored twice`);
    }
    return { fate: 'not-landed' };
  }

  /** Ends a check's read-only transaction without awaiting it: the client goes back on success, else is destroyed. */
  private endCheck(client: PoolClient, ask: (text: string) => Promise<unknown>, give: () => void): void {
    ask('ROLLBACK').then(() => client.release(), () => client.release(true)).finally(give);
  }

  async retireGuild(guildId: string, reason: string, token: FenceToken, deadline: bigint | null = null): Promise<RetireOutcome> {
    if (this.refusedWithoutClaim('retire', guildId, token)) return { ok: false, reason: 'no-claim' };
    if (deadline !== null && msLeft(deadline) < STATEMENT_FLOOR_MS) return { ok: false, reason: 'out-of-time' };
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      this.noteFailure(error);
      return { ok: false, reason: 'unavailable', detail: describeFailure(error).detail };
    }
    const tx = new BoundedClient(client, deadline);
    let began = false;
    let commitSent = false;
    try {
      await tx.send('BEGIN');
      began = true;
      const claim = await tx.send(FENCED_OWNERSHIP_UPSERT, this.fenceParams(guildId, token));
      if ((claim.rowCount ?? 0) !== 1) {
        await tx.close('ROLLBACK');
        this.noteSuccess();
        return { ok: false, reason: 'deposed' };
      }
      const retiredAt = Date.now();
      const docsMoved = await tx.send(
        `INSERT INTO smdb_data.guild_data_graveyard (guild_id, module, filename, kind, doc, retired_at, reason)
         SELECT guild_id, module, filename, 'doc', doc, $2, $3
           FROM smdb_data.guild_data WHERE guild_id = $1`,
        [guildId, retiredAt, reason]);
      const streamsMoved = await tx.send(
        `INSERT INTO smdb_data.guild_data_graveyard (guild_id, module, filename, kind, doc, retired_at, reason)
         SELECT guild_id, module, filename, 'append', string_agg(chunk, '' ORDER BY seq), $2, $3
           FROM smdb_data.guild_append WHERE guild_id = $1
          GROUP BY guild_id, module, filename`,
        [guildId, retiredAt, reason]);
      await tx.send(`DELETE FROM smdb_data.guild_data WHERE guild_id = $1`, [guildId]);
      await tx.send(`DELETE FROM smdb_data.guild_append WHERE guild_id = $1`, [guildId]);
      await tx.send(`UPDATE smdb_data.guild_ownership SET retired_at = now() WHERE guild_id = $1`, [guildId]);
      if (tx.left() < COMMIT_FLOOR_MS) {
        await tx.close('ROLLBACK');
        return { ok: false, reason: 'out-of-time' };
      }
      commitSent = true;
      await tx.send('COMMIT', [], COMMIT_FLOOR_MS);
      this.noteSuccess();
      const moved = (docsMoved.rowCount ?? 0) + (streamsMoved.rowCount ?? 0);
      console.log(`[PostgresBackend] Guild ${guildId} retired to graveyard (${reason}); ${moved} row(s) moved`);
      return { ok: true, moved };
    } catch (error) {
      if (began) tx.destroy = true;
      if (error instanceof OutOfTime) return { ok: false, reason: 'out-of-time' };
      const failure = this.noteTxFailure('retireGuild', guildId, error, commitSent);
      if (failure.kind === 'answered') return { ok: false, reason: 'refused', detail: failure.detail };
      if (commitSent) return { ok: false, reason: 'unknown' };
      return failure.kind === 'timeout' ? { ok: false, reason: 'unavailable', timedOut: true } : { ok: false, reason: 'unavailable', detail: failure.detail };
    } finally {
      client.release(tx.destroy ? true : undefined);
    }
  }

  /**
   * Moves one graveyard batch back (the given retiredAt, else the newest) in one transaction fenced like a flush: the
   * fenced update locks the guild's ownership row, the restore is refused while the guild has any live row, and the
   * batch leaves the graveyard in the statement that puts it back. Every statement is bounded by deadline.
   */
  async restoreGuild(guildId: string, retiredAt: number | null, token: FenceToken, beforeCommit: () => RestoreStop | null, deadline: bigint): Promise<RestoreOutcome> {
    if (this.schemaMismatch || !this.provisioned) {
      const reason = this.schemaMismatch ? 'schema-mismatch' : 'not-provisioned';
      console.error(`[PostgresBackend] Refused restore for guild ${guildId}: ${this.schemaMismatch
        ? this.mismatchText()
        : 'the database is not provisioned yet'}`);
      return { ok: false, reason };
    }
    if (this.refusedWithoutClaim('restore', guildId, token)) return { ok: false, reason: 'no-claim' };
    if (msLeft(deadline) < STATEMENT_FLOOR_MS) return { ok: false, reason: 'out-of-time' };
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      this.noteFailure(error);
      return { ok: false, reason: 'unavailable', detail: describeFailure(error).detail };
    }
    const tx = new BoundedClient(client, deadline);
    let began = false;
    let commitSent = false;
    let batch = retiredAt;
    const decided = async (answer: RestoreOutcome): Promise<RestoreOutcome> => {
      await tx.close('ROLLBACK');
      this.noteSuccess();
      return answer;
    };
    try {
      await tx.send('BEGIN');
      began = true;
      const params = this.fenceParams(guildId, token);
      const claimed = ((await tx.send(FENCED_OWNERSHIP_UPSERT, params)).rowCount ?? 0) === 1;
      if (!claimed) {
        const rolledBack = await tx.close('ROLLBACK');
        const row = rolledBack ? (await tx.close(OWNER_SELECT, [guildId]))?.rows[0] : undefined;
        this.noteSuccess();
        return row ? { ok: false, reason: 'deposed', currentOwner: { nodeId: row.node_id, claim: Number(row.claim) } } : { ok: false, reason: 'deposed' };
      }
      if (batch === null) {
        const newest = (await tx.send(`SELECT max(retired_at) AS retired_at FROM smdb_data.guild_data_graveyard WHERE guild_id = $1`, [guildId])).rows[0]?.retired_at;
        if (newest === null || newest === undefined) return await decided({ ok: false, reason: 'no-entry' });
        batch = Number(newest);
      } else {
        const found = (await tx.send(`SELECT 1 FROM smdb_data.guild_data_graveyard WHERE guild_id = $1 AND retired_at = $2 LIMIT 1`, [guildId, batch])).rowCount ?? 0;
        if (found === 0) return await decided({ ok: false, reason: 'no-entry' });
      }
      const live = await tx.send(LIVE_CHECK, [guildId]);
      if (live.rows[0]?.present === true) return await decided({ ok: false, reason: 'live-rows', retiredAt: batch });
      const moved = (await tx.send(RESTORE_MOVE, [guildId, batch])).rows[0] ?? {};
      const taken = Number(moved.taken ?? 0);
      const put = Number(moved.put ?? 0);
      if (taken === 0) return await decided({ ok: false, reason: 'no-entry', retiredAt: batch });
      if (taken !== put) return await decided({ ok: false, reason: 'refused', detail: `the batch holds ${taken - put} row(s) of an unknown kind` });
      const stop = beforeCommit() ?? (tx.left() < COMMIT_FLOOR_MS ? 'out-of-time' : null);
      if (stop) return await decided({ ok: false, reason: stop });
      commitSent = true;
      await tx.send('COMMIT', [], COMMIT_FLOOR_MS);
      this.noteSuccess();
      console.log(`[PostgresBackend] Guild ${guildId} restored from graveyard batch ${batch}; ${taken} row(s) moved back`);
      return { ok: true, moved: taken, retiredAt: batch, reason: typeof moved.reason === 'string' ? moved.reason : '' };
    } catch (error) {
      if (began) tx.destroy = true;
      if (error instanceof OutOfTime) return { ok: false, reason: 'out-of-time' };
      const failure = this.noteTxFailure('restoreGuild', guildId, error, commitSent);
      if (failure.kind === 'answered') return { ok: false, reason: 'refused', detail: failure.detail, code: failure.code };
      const at = batch === null ? {} : { retiredAt: batch };
      if (commitSent) return { ok: false, reason: 'unknown', ...at };
      return failure.kind === 'timeout'
        ? { ok: false, reason: 'unavailable', detail: "the database did not answer within the restore's 40 s", timedOut: true }
        : { ok: false, reason: 'unavailable', detail: failure.detail };
    } finally {
      client.release(tx.destroy ? true : undefined);
    }
  }

  /** Logs a failed bounded transaction; an error with no answer notes an outage, the call's own timeout does not. */
  private noteTxFailure(op: string, guildId: string, error: unknown, commitSent: boolean): TxFailure {
    const failure = classifyFailure(error);
    if (failure.kind === 'connection') this.noteFailure(error);
    else if (failure.kind === 'answered') this.noteSuccess();
    if (commitSent && failure.kind !== 'answered') {
      console.error(`[PostgresBackend] ${op} of guild ${guildId}: COMMIT got no answer (${error instanceof Error ? error.message : String(error)}); can't confirm whether it committed`);
    } else {
      console.error(`[PostgresBackend] ${op} failed for ${guildId}:`, error);
    }
    return failure;
  }

  private fenceParams(guildId: string, token: FenceToken): unknown[] {
    return [guildId, token.nodeId, token.shardId, token.claim, token.shardCount, token.processId];
  }

  /** The claim row of the token's shard for the refusal line; undefined for no row, null when it could not be read. */
  private async readShardRow(client: PoolClient, token: FenceToken): Promise<{ claim: number; holder_name: string; released: boolean; reserved: boolean } | undefined | null> {
    try {
      const res = await client.query(
        `SELECT claim::text AS claim, holder_name, released, reserved FROM smdb_data.shard_claims WHERE shard_count = $1 AND shard_id = $2`,
        [token.shardCount, token.shardId]);
      const row = res.rows[0];
      return row ? { claim: Number(row.claim), holder_name: row.holder_name, released: row.released === true, reserved: row.reserved === true } : undefined;
    } catch {
      return null;
    }
  }

  private async readOwner(client: PoolClient, guildId: string): Promise<GuildOwner | undefined> {
    try {
      const res = await client.query(OWNER_SELECT, [guildId]);
      const row = res.rows[0];
      if (!row) return undefined;
      return { nodeId: row.node_id, claim: Number(row.claim) };
    } catch {
      return undefined;
    }
  }

  private async rollbackQuiet(client: Pick<PoolClient, 'query'> | Sender): Promise<void> {
    try {
      await client.query('ROLLBACK');
    } catch { /* connection already gone */ }
  }

  // ==========================================================================
  // READS + CATALOG
  // ==========================================================================

  async loadDoc(guildId: string, key: DocKey): Promise<string | null> {
    const res = await this.read(
      `SELECT doc FROM smdb_data.guild_data WHERE guild_id = $1 AND module = $2 AND filename = $3`,
      [guildId, key.module, key.filename]);
    return res.rows[0]?.doc ?? null;
  }

  async listGuilds(): Promise<string[]> {
    const res = await this.read(
      `SELECT guild_id FROM smdb_data.guild_ownership WHERE retired_at IS NULL`, []);
    return res.rows.map(row => row.guild_id);
  }

  async listOwnedGuilds(shardIds: number[], shardCount: number): Promise<string[]> {
    const res = await this.read(
      `SELECT guild_id FROM smdb_data.guild_ownership
        WHERE retired_at IS NULL AND ((guild_id::bigint >> 22) % $1) = ANY($2)`,
      [shardCount, shardIds]);
    return res.rows.map(row => row.guild_id);
  }

  async listGuildFiles(guildId: string, module?: string): Promise<string[]> {
    // Non-recursive top-level .json parity with fileBackend.listGuildDataFiles;
    // no module means the guild namespace root ('').
    const res = await this.read(
      `SELECT filename FROM smdb_data.guild_data
        WHERE guild_id = $1 AND module = $2 AND filename NOT LIKE '%/%' AND filename LIKE '%.json'
       UNION
       SELECT filename FROM smdb_data.guild_append
        WHERE guild_id = $1 AND module = $2 AND filename NOT LIKE '%/%' AND filename LIKE '%.json'
        GROUP BY filename`,
      [guildId, module ?? '']);
    return res.rows.map(row => row.filename);
  }

  async guildFileExists(guildId: string, key: DocKey): Promise<boolean> {
    const res = await this.read(
      `SELECT EXISTS (SELECT 1 FROM smdb_data.guild_data WHERE guild_id = $1 AND module = $2 AND filename = $3)
           OR EXISTS (SELECT 1 FROM smdb_data.guild_append WHERE guild_id = $1 AND module = $2 AND filename = $3) AS present`,
      [guildId, key.module, key.filename]);
    return res.rows[0]?.present === true;
  }

  private async read(text: string, values: unknown[]): Promise<QueryResult> {
    try {
      const res = await this.pool.query(text, values);
      this.noteSuccess();
      return res;
    } catch (error) {
      this.noteFailure(error);
      throw error;
    }
  }
}

// ============================================================================
// MODULE-PRIVATE SQL BUILDERS
// ============================================================================

/** The UTF-8 size of a statement's text and values, as it goes over the wire. */
function statementBytes(text: string, values: unknown[]): number {
  let bytes = Buffer.byteLength(text);
  for (const v of values) if (v !== null && v !== undefined) bytes += Buffer.byteLength(String(v));
  return bytes;
}

interface Statement {
  text: string;
  values: unknown[];
  bytes: number;
}

/**
 * The flush's statements after its fenced claim: upserts of at most MAX_ROWS_PER_STATEMENT rows and
 * FLUSH_STATEMENT_BYTES of document and key text (a larger row alone), the deletes, and each append buffer as rows of
 * at most FLUSH_STATEMENT_BYTES, in order.
 */
function flushStatements(guildId: string, batch: GuildFlushBatch): Statement[] {
  const out: Statement[] = [];
  const add = (st: { text: string; values: unknown[] }) => out.push({ ...st, bytes: statementBytes(st.text, st.values) });
  let rows: { key: DocKey; doc: string }[] = [];
  let rowBytes = 0;
  for (const row of batch.upserts) {
    const size = Buffer.byteLength(row.doc) + Buffer.byteLength(row.key.module) + Buffer.byteLength(row.key.filename);
    if (rows.length > 0 && (rows.length >= MAX_ROWS_PER_STATEMENT || rowBytes + size > FLUSH_STATEMENT_BYTES)) {
      add(buildUpsert(guildId, rows));
      rows = [];
      rowBytes = 0;
    }
    rows.push(row);
    rowBytes += size;
  }
  if (rows.length > 0) add(buildUpsert(guildId, rows));
  for (const keys of chunk(batch.deletes, MAX_ROWS_PER_STATEMENT)) {
    const tuples = buildKeyTuples(guildId, keys);
    add({ text: `DELETE FROM smdb_data.guild_data WHERE guild_id = $1 AND (module, filename) IN (${tuples.list})`, values: tuples.values });
    add({ text: `DELETE FROM smdb_data.guild_append WHERE guild_id = $1 AND (module, filename) IN (${tuples.list})`, values: tuples.values });
  }
  for (const append of batch.appends) {
    for (const piece of utf8Pieces(append.chunk, FLUSH_STATEMENT_BYTES)) {
      add({
        text: 'INSERT INTO smdb_data.guild_append (guild_id, module, filename, chunk) VALUES ($1, $2, $3, $4)',
        values: [guildId, append.key.module, append.key.filename, piece],
      });
    }
  }
  return out;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function buildUpsert(guildId: string, rows: { key: DocKey; doc: string }[]): { text: string; values: unknown[] } {
  const values: unknown[] = [guildId];
  const tuples = rows.map(row => {
    const m = values.push(row.key.module);
    const f = values.push(row.key.filename);
    const d = values.push(row.doc);
    return `($1, $${m}, $${f}, $${d})`;
  });
  return {
    text: `INSERT INTO smdb_data.guild_data (guild_id, module, filename, doc) VALUES ${tuples.join(', ')} ` +
      `ON CONFLICT (guild_id, module, filename) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()`,
    values,
  };
}

function buildKeyTuples(guildId: string, keys: DocKey[]): { list: string; values: unknown[] } {
  const values: unknown[] = [guildId];
  const tuples = keys.map(key => {
    const m = values.push(key.module);
    const f = values.push(key.filename);
    return `($${m}, $${f})`;
  });
  return { list: tuples.join(', '), values };
}

function backoffDelay(attempt: number): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.floor(Math.random() * ceiling);
}

// ============================================================================
// BOOT-TIME RECOGNITION HELPERS + TTL SWEEP (one-shot connections)
// ============================================================================

/** Thrown when the database cannot be reached, so the recognition guard can
 * tell "no marker" apart from "cannot ask". */
export class PostgresUnreachableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'PostgresUnreachableError';
    this.cause = cause;
  }
}

/** Thrown when the database answers but is a read-only standby in recovery. */
export class PostgresInRecoveryError extends Error {
  constructor() {
    super('the configured database is in recovery (a read-only standby); point DATA_BACKEND_URL at the primary');
    this.name = 'PostgresInRecoveryError';
  }
}

function isMissingRelation(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === '42P01' || code === '3F000';
}

async function metaClient(url: string): Promise<Client> {
  const client = shortLivedClient({
    connectionString: url,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    keepAlive: true,
  });
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => { /* never connected */ });
    throw new PostgresUnreachableError('cannot reach the data backend', error);
  }
  return client;
}

/** Meta 'store_id'; null when reachable but absent, PostgresUnreachableError
 * when the DB cannot be asked, PostgresInRecoveryError from a standby. */
export async function readStoreId(url: string): Promise<string | null> {
  const client = await metaClient(url);
  try {
    let res: QueryResult;
    try {
      const recovery = await client.query('SELECT pg_is_in_recovery() AS in_recovery');
      if (recovery.rows[0]?.in_recovery === true) throw new PostgresInRecoveryError();
      res = await client.query(`SELECT value FROM smdb_data.meta WHERE key = 'store_id'`);
    } catch (error) {
      if (error instanceof PostgresInRecoveryError) throw error;
      if (isMissingRelation(error)) return null;
      throw new PostgresUnreachableError('store_id read failed', error);
    }
    if (res.rows.length === 0) return null;
    const parsed: unknown = JSON.parse(res.rows[0].value);
    return typeof parsed === 'string' ? parsed : null;
  } finally {
    await client.end().catch(() => { /* best effort */ });
  }
}

