// PostgresBackend - central-database guild storage behind the DataBackend
// contract. Owns the connection pool, self-provisioned DDL, the fenced
// ownership transactions (hydrate/flush/retire/restore), catalog reads, and
// the outage state machine. Coalescing, freeze, byte-stringification and
// metrics live in the facade / Working Set, never here.

import { randomUUID } from 'crypto';
import { Client, Pool } from 'pg';
import { guardPoolClients, shortLivedClient } from '../pgClient';
import { FLUSH_STATEMENT_BYTES, FLUSH_WIRE_MAX, flushBoundMs, utf8Pieces } from '../storableData';
import { pgConfig, showEntry } from '../../../../utils/databaseAddress';
import type { ClientConfig, PoolClient, PoolConfig, QueryConfig, QueryResult } from 'pg';
import type {
  DataBackend,
  DocKey,
  FenceToken,
  FlushFate,
  FlushOutcome,
  GuildFlushBatch,
  GuildOwner,
  HydrationOutcome,
  LateCommit,
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

const PROVISION_DDL: string[] = [
  `CREATE SCHEMA IF NOT EXISTS smdb_data`,
  `CREATE TABLE IF NOT EXISTS smdb_data.meta (
    key        text PRIMARY KEY,
    value      text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS smdb_data.guild_ownership (
    guild_id     text PRIMARY KEY,
    node_id      text NOT NULL,
    shard_id     integer NOT NULL,
    claim        bigint NOT NULL,
    shard_count  integer NOT NULL,
    retired_at   timestamptz,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    last_flush   uuid
  )`,
  `CREATE INDEX IF NOT EXISTS guild_ownership_node_idx ON smdb_data.guild_ownership (node_id)`,
  `CREATE INDEX IF NOT EXISTS guild_ownership_claim_idx ON smdb_data.guild_ownership (claim)`,
  `CREATE INDEX IF NOT EXISTS guild_ownership_shard_idx ON smdb_data.guild_ownership (shard_count, shard_id)`,
  `CREATE SEQUENCE IF NOT EXISTS smdb_data.claim_seq`,
  `CREATE TABLE IF NOT EXISTS smdb_data.shard_claims (
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
  `CREATE TABLE IF NOT EXISTS smdb_data.claim_clock (
    id          integer     PRIMARY KEY CHECK (id = 1),
    up_ms       bigint      NOT NULL,
    ticked_at   timestamptz NOT NULL,
    last_gap_ms bigint      NOT NULL DEFAULT 0
  )`,
  `INSERT INTO smdb_data.claim_clock (id, up_ms, ticked_at) VALUES (1, 0, now()) ON CONFLICT (id) DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS smdb_data.shard_nodes (
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
  `CREATE TABLE IF NOT EXISTS smdb_data.guild_data (
    guild_id   text NOT NULL,
    module     text NOT NULL,
    filename   text NOT NULL,
    doc        text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (guild_id, module, filename)
  ) PARTITION BY HASH (guild_id)`,
  // Identity columns are rejected on partitioned tables before PG17, so seq
  // takes its default from an explicit sequence instead.
  `CREATE SEQUENCE IF NOT EXISTS smdb_data.guild_append_seq`,
  `CREATE TABLE IF NOT EXISTS smdb_data.guild_append (
    guild_id   text NOT NULL,
    module     text NOT NULL,
    filename   text NOT NULL,
    seq        bigint NOT NULL DEFAULT nextval('smdb_data.guild_append_seq'),
    chunk      text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (guild_id, module, filename, seq)
  ) PARTITION BY HASH (guild_id)`,
  `CREATE TABLE IF NOT EXISTS smdb_data.guild_data_graveyard (
    guild_id   text NOT NULL,
    module     text NOT NULL,
    filename   text NOT NULL,
    kind       text NOT NULL CHECK (kind IN ('doc','append')),
    doc        text NOT NULL,
    retired_at bigint NOT NULL,
    reason     text NOT NULL,
    PRIMARY KEY (guild_id, retired_at, module, filename)
  )`,
  `CREATE INDEX IF NOT EXISTS guild_graveyard_ttl_idx ON smdb_data.guild_data_graveyard (retired_at)`,
  `CREATE TABLE IF NOT EXISTS smdb_data.guild_requests (
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
  `CREATE INDEX IF NOT EXISTS guild_requests_pending_idx ON smdb_data.guild_requests (for_process, created_at) WHERE state = 'pending'`,
  `CREATE INDEX IF NOT EXISTS guild_requests_applying_idx ON smdb_data.guild_requests (claim_batch) WHERE state = 'applying'`,
];

/**
 * Provisions a new store on a client inside its open transaction and answers its store id. The caller holds the
 * bootstrap advisory lock as a transaction lock; CREATE SCHEMA has no IF NOT EXISTS here, so a schema made since the
 * caller looked fails the transaction (42P06).
 */
export async function provisionStoreInTransaction(client: { query(text: string, params?: unknown[]): Promise<unknown> }): Promise<string> {
  await client.query('CREATE SCHEMA smdb_data');
  for (const stmt of PROVISION_DDL.slice(1)) await client.query(stmt);
  for (let i = 0; i < PARTITION_COUNT; i++) {
    const suffix = `p${String(i).padStart(2, '0')}`;
    await client.query(
      `CREATE TABLE smdb_data.guild_data_${suffix} PARTITION OF smdb_data.guild_data FOR VALUES WITH (MODULUS ${PARTITION_COUNT}, REMAINDER ${i})`);
    await client.query(
      `CREATE TABLE smdb_data.guild_append_${suffix} PARTITION OF smdb_data.guild_append FOR VALUES WITH (MODULUS ${PARTITION_COUNT}, REMAINDER ${i})`);
  }
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

/** How provisioning ended: the schema is this bot's, the database holds another version (found), or the backend stopped. */
export type ProvisionVerdict = { state: 'provisioned' } | { state: 'mismatch'; found: string } | { state: 'stopped' };

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
// pg-pool's error for a request queued while every client of the pool is busy.
const POOL_FULL_MESSAGE = 'timeout exceeded when trying to connect';
const DID_NOT_ANSWER = 'the database did not answer';

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
 * NB5 D8 and G2: a retire's or a restore's COMMIT error shows that the transaction rolled back only when the database
 * answered it, NB13's test does not read it as landed, and its class is not 53.
 */
export function commitRolledBack(error: unknown): boolean {
  if (classifyFailure(error).kind !== 'answered' || commitMayHaveLanded(error)) return false;
  return !/^53/.test(describeFailure(error).code ?? '');
}

const CERT_CODE = /^(CERT_|ERR_TLS_CERT|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|UNABLE_TO_(GET_ISSUER_CERT|VERIFY_LEAF_SIGNATURE|DECRYPT_CERT_SIGNATURE))/;
/**
 * NB5 decision 13: the hold's entry cause for a failure that starts it, null for one that does not. A failure is no
 * answer as classifyFailure reads it (no SQLSTATE, a session the server ended, class 08, a client timeout); an answer,
 * pg-pool's full-pool error and a FATAL that refused a new client at its login (atLogin) start nothing.
 */
function holdCause(error: unknown, atLogin = false): string | null {
  const { code, severity, message } = (isObject(error) ? error : {}) as { code?: unknown; severity?: unknown; message?: unknown };
  const sqlstate = typeof code === 'string' ? code : undefined;
  if (sqlstate && CERT_CODE.test(sqlstate)) return `the database's certificate was refused (${sqlstate})`;
  if (sqlstate === '28000') return 'the database refused the login (SQLSTATE 28000)';
  if (message === POOL_FULL_MESSAGE || classifyFailure(error).kind === 'answered') return null;
  if (atLogin && typeof severity === 'string' && sqlstate && !/^(08|57P0[123])/.test(sqlstate)) return null;
  if (sqlstate === '57P01' || sqlstate === '57P02') return `the database ended this process's sessions (SQLSTATE ${sqlstate})`;
  if (sqlstate === '57P03') return 'the database is not accepting connections yet (SQLSTATE 57P03)';
  return DID_NOT_ANSWER;
}

/** NB5 decision 13: whether a failure is an observation that the chosen database did not answer. */
export function isSilence(error: unknown): boolean {
  return holdCause(error) !== null;
}

/** NB5 decision 11: what made this process stop writing to its database. */
export type LatchCause =
  | { kind: 'replaced'; machine: string; generation: number }
  | { kind: 'tie'; generation: number }
  | { kind: 'behind-notice'; machine: string; generation: number };

/** NB5 decision 11's `<why>` for a latch of the database at this address. */
export function latchWords(cause: LatchCause, address: string): string {
  switch (cause.kind) {
    case 'replaced': return `${address} was replaced by ${cause.machine} (generation ${cause.generation})`;
    case 'tie': return `can't confirm that ${address} is still the main (another database accepts writes at generation ${cause.generation})`;
    case 'behind-notice': return `can't confirm that ${address} is still the main (generation ${cause.generation} was announced for ${cause.machine})`;
  }
}

/** The backend's own state refused a statement before it was sent: latched (its `<why>`) or held (`holdWords()`). */
class OwnStateRefusal extends Error {
  constructor(readonly phase: 'latched' | 'held', readonly detail: string) {
    super(detail);
    this.name = 'OwnStateRefusal';
  }
}

/** The detail an operation answers for a refusal: the latch's adds that this process does not write there. */
function operationDetail(refusal: OwnStateRefusal): string {
  return refusal.phase === 'latched' ? `${refusal.detail}; this process does not write to it` : refusal.detail;
}

/** Client timeouts of statements whose caller's own deadline was at most their answer bound (I5 case (a)). */
const deadlineCuts = new WeakSet<object>();

const isObject = (value: unknown): value is object => !!value && typeof value === 'object';

/**
 * NB5 I1: a client checked out of the data pool. The latch cuts every lease whose COMMIT was not let through; a
 * statement that was refused or got no answer spoils the lease, which then sends nothing more and is destroyed.
 */
class DataLease {
  commitPassed = false;
  cut = false;
  spoiled = false;
  spoiledBy: unknown = undefined;

  constructor(readonly client: PoolClient, readonly epoch: number, readonly entry: string, readonly move: boolean) {}
}

/**
 * NB5 decision 9's chooser as the backend sees it: the boot wait chooses the entry, and the watch probes it while the
 * backend is held and confirms through `noteEntryAnswered`, `noteConfirmingCause` and `confirmHold`.
 */
export interface DatabaseChooser {
  /** The entry chosen already, or null while the boot wait runs. */
  chosen(): string | null;
  /** Resolves once a pass chose an entry; null when the chooser stopped first. */
  awaitChoice(): Promise<string | null>;
  /** What askDatabase answers before the choice: 'refused' after a pass in which every address refused the login. */
  lastPassLogin(): 'refused' | 'unreachable';
  /** The backend entered its hold under this epoch. */
  holdStarted(backend: PostgresBackend, epoch: number): void;
  /** A drain waits on the hold: the next attempt starts without the wait before it. */
  confirmNow(): void;
  stop(): void;
}

/** The steps of a move that other layers own (decision 12): (a)'s check, (c) and (d), (e) and (f)'s report. */
export interface MoveSteps {
  /** (a): null when the target may be written, else the reason it may not. */
  checkTarget(entry: string): Promise<string | null>;
  /** (c) and (d): the renewal and the re-take on the claims pool (b) built; false ends this attempt. */
  claims(entry: string): Promise<boolean>;
  /** (e): the retires sent before the latch, settled against the target; false ends this attempt. */
  settleRetires(epoch: number, entry: string): Promise<boolean>;
  /** (f): the new entry is in use. */
  moved(entry: string): void;
  /** An attempt that passed (c) and (d) ended before (f). */
  attemptEnded?(): void;
}

/**
 * One client's statements bounded by a deadline (none when null): each carries the smaller of the answer bound and the
 * time left as its query_timeout; a forward statement is not sent below its floor; after an error nothing more is sent
 * and the client is destroyed.
 */
class BoundedClient {
  destroy = false;

  constructor(
    readonly lease: DataLease,
    private readonly deadline: bigint | null,
    private readonly sendOn: (lease: DataLease, text: string, values: unknown[], boundMs: number | null, callerMs?: number, onPass?: () => void) => Promise<QueryResult>,
  ) {}

  left(): number {
    return this.deadline === null ? Infinity : msLeft(this.deadline);
  }

  async send(text: string, values: unknown[] = [], floorMs = STATEMENT_FLOOR_MS, onPass?: () => void): Promise<QueryResult> {
    const left = this.left();
    if (left < floorMs) throw new OutOfTime();
    try {
      return await this.sendOn(this.lease, text, values, ANSWER_BOUND_MS, left, onPass);
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
      return await this.sendOn(this.lease, text, values, ANSWER_BOUND_MS, left);
    } catch {
      this.destroy = true;
      return null;
    }
  }
}

const LIVE_CHECK = `SELECT EXISTS (SELECT 1 FROM smdb_data.guild_data WHERE guild_id = $1) OR EXISTS (SELECT 1 FROM smdb_data.guild_append WHERE guild_id = $1) AS present`;

// The rows put back are exactly the rows the DELETE took out: a row a concurrent sweep removed is skipped by both.
const RESTORE_MOVE = `WITH moved AS (
    DELETE FROM smdb_data.guild_data_graveyard WHERE guild_id = $1 AND retired_at = $2
    RETURNING guild_id, module, filename, kind, doc, reason),
  d AS (INSERT INTO smdb_data.guild_data (guild_id, module, filename, doc)
        SELECT guild_id, module, filename, doc FROM moved WHERE kind = 'doc' RETURNING 1),
  a AS (INSERT INTO smdb_data.guild_append (guild_id, module, filename, chunk)
        SELECT guild_id, module, filename, doc FROM moved WHERE kind = 'append' RETURNING 1)
  SELECT (SELECT count(*) FROM moved) AS taken, (SELECT count(*) FROM d) + (SELECT count(*) FROM a) AS put,
         (SELECT min(reason) FROM moved) AS reason`;

// Decision 12 (e) and J2: whether a retire's batch is on the target, as one row.
const BATCH_PRESENT = `SELECT EXISTS (SELECT 1 FROM smdb_data.guild_data_graveyard WHERE guild_id = $1 AND retired_at = $2) AS present`;

const NO_MOVE_STEPS: MoveSteps = {
  checkTarget: entry => checkMoveTarget(entry, null),
  claims: async () => true,
  settleRetires: async () => true,
  moved: () => undefined,
};

export class PostgresBackend implements DataBackend {
  readonly kind = 'postgres' as const;

  getPool(): Pool {
    if (!this.pool) throw new Error('no database is chosen yet');
    return this.pool;
  }

  private pool: Pool | null = null;
  private entry: string | null = null;
  private poolEpoch = 0;
  private epoch = 0;
  private readonly chooser: DatabaseChooser;
  private state: 'connecting' | 'ready' | 'outage' | 'confirming' = 'connecting';
  private stateBeforeHold: 'connecting' | 'ready' = 'connecting';
  private holdEntryCause = DID_NOT_ANSWER;
  private confirmingCause = 'checking';
  private confirmedAt: number | null = null;
  private reportedHold: string | null = null;
  private latchWhy: string | null = null;
  private lastWhy: string | null = null;
  private moving: number | null = null;
  private moveSteps: MoveSteps = NO_MOVE_STEPS;
  private readonly moveRefusalsLogged = new Set<string>();
  private outageSince: number | undefined;
  private outageAlertFired = false;
  private outageAlertTimer: NodeJS.Timeout | null = null;
  private schemaMismatch = false;
  private mismatchFound = 'unreadable';
  private provisioned = false;
  private started = false;
  private stopped = false;
  private readonly listeners: AlertListener[] = [];
  private readonly loginRefusedListeners: Array<() => void> = [];
  private readonly databaseListeners: Array<(entry: string) => void> = [];
  private readonly holdListeners: Array<(words: string | null) => void> = [];
  private readonly pendingSleeps = new Set<{ timer: NodeJS.Timeout; resolve: () => void }>();
  private readonly leases = new Set<DataLease>();
  // The epoch each failure was observed under: its pool's, or a watch pass's.
  private readonly observed = new WeakMap<object, number>();
  // Failures of a new client's connect, whose FATAL refused only that client.
  private readonly loginFailures = new WeakSet<object>();
  // The flush gate: at most FLUSH_WIRE_MAX flushes hold a client at once, the rest wait first in, first out.
  private flushesOnWire = 0;
  private readonly flushWaiters: Array<() => void> = [];

  constructor(opts: { chooser: DatabaseChooser }) {
    this.chooser = opts.chooser;
    const entry = this.chooser.chosen();
    if (entry !== null) this.useEntry(entry);
  }

  /** Raises the epoch and builds the data pool for the entry under it (the choice, or step (b) of a move). */
  private useEntry(entry: string): void {
    this.epoch += 1;
    const epoch = this.epoch;
    const pool = this.makePool({
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
      ...pgConfig(entry),
    });
    pool.on('error', error => {
      // Unhandled idle-client errors would crash the process.
      console.error('[PostgresBackend] Idle client error:', error);
      this.observedUnder(error, epoch);
      this.noteFailure(error);
    });
    guardPoolClients(pool, 'the guild-data pool');
    this.pool = pool;
    this.poolEpoch = epoch;
    this.entry = entry;
  }

  private makePool(config: PoolConfig): Pool {
    return new Pool(config);
  }

  private observedUnder(error: unknown, epoch: number): void {
    if (isObject(error) && !this.observed.has(error)) this.observed.set(error, epoch);
  }

  /** The entry the data pool is built from, or null before the choice. */
  chosenEntry(): string | null {
    return this.entry;
  }

  /** Decision 13's database epoch: raised at the choice, at every latch and at step (b) of every move. */
  databaseEpoch(): number {
    return this.epoch;
  }

  private address(entry: string | null = this.entry): string {
    return showEntry(entry ?? '');
  }

  // ==========================================================================
  // LIFECYCLE, THE LATCH AND THE HOLD
  // ==========================================================================

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.bootstrapLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.chooser.stop();
    this.clearOutageAlertTimer();
    for (const entry of this.pendingSleeps) {
      clearTimeout(entry.timer);
      entry.resolve();
    }
    this.pendingSleeps.clear();
    try {
      await this.pool?.end();
    } catch { /* already ended */ }
  }

  /** Waits until provisioning has passed, has found another schema version, or the backend stopped. */
  async provisionVerdict(): Promise<ProvisionVerdict> {
    for (;;) {
      if (this.stopped) return { state: 'stopped' };
      if (this.schemaMismatch) return { state: 'mismatch', found: this.mismatchFound };
      if (this.provisioned) return { state: 'provisioned' };
      await this.sleep(PROVISION_VERDICT_POLL_MS);
    }
  }

  /** TTL sweep of graveyard rows older than the cutoff; guild_ownership rows are the claim fence and are never deleted.
   * Returns the number of rows deleted; idempotent, safe to misfire. */
  async sweepGraveyard(cutoffMs: number): Promise<number> {
    try {
      const tombstones = await this.leaseQuery(`DELETE FROM smdb_data.guild_data_graveyard WHERE retired_at < $1`, [cutoffMs], ANSWER_BOUND_MS);
      return tombstones.rowCount ?? 0;
    } catch (error) {
      if (classifyFailure(error).kind !== 'answered') this.noteFailure(error);
      throw error;
    }
  }

  /** True while the backend may write: provisioned at this bot's schema version, not stopped, latched or held. */
  servesData(): boolean {
    return this.provisioned && !this.schemaMismatch && !this.stopped && this.latchWhy === null && !this.isHeld();
  }

  /** A move's attempt is past (b) and has not ended (decision 19's 'moving'). */
  isMoving(): boolean {
    return this.moving !== null && this.moving === this.epoch;
  }

  connectionState(): { state: 'connecting' | 'ready' | 'outage' | 'confirming' | 'latched'; outageSinceMs?: number } {
    if (this.latchWhy !== null) return { state: 'latched' };
    if (this.state === 'outage' || this.state === 'confirming') return { state: this.state, outageSinceMs: this.outageSince };
    return { state: this.state };
  }

  private isHeld(): boolean {
    return (this.state === 'outage' || this.state === 'confirming') && !this.schemaMismatch;
  }

  /** Decision 13's hold detail, from its phase; null while not held. */
  holdWords(): string | null {
    if (!this.isHeld()) return null;
    const address = this.address();
    return this.state === 'outage'
      ? `${this.holdEntryCause}; this process checks that ${address} is still the main before writing to it`
      : `the database answers again, but this process can't confirm yet that ${address} is still the main (${this.confirmingCause})`;
  }

  /** Decision 13's confirming cause while the hold is in 'confirming', else null. */
  confirmingWords(): string | null {
    return this.isHeld() && this.state === 'confirming' ? this.confirmingCause : null;
  }

  /** The latch's `<why>` while latched, else null. */
  latchReason(): string | null {
    return this.latchWhy;
  }

  /** G9: why this backend refuses every statement now (the latched detail or `holdWords()`), else null. */
  refusalDetail(): string | null {
    if (this.latchWhy !== null) return `${this.latchWhy}; this process does not write to it`;
    return this.holdWords();
  }

  /** Decision 11: the backend itself holds the saves back (latched, or held while the database answers). */
  refusesByOwnState(): boolean {
    return this.latchWhy !== null || (this.isHeld() && this.state === 'confirming');
  }

  /** Decision 13: now while held, else when the last hold ended with a confirmation (null before any). */
  heldUntil(): number | null {
    return this.isHeld() ? Date.now() : this.confirmedAt;
  }

  /** Decision 13: a drain waits on the hold, so the chooser's next attempt starts without the wait before it. */
  confirmNow(): void {
    if (this.isHeld()) this.chooser.confirmNow();
  }

  onAlert(cb: AlertListener): void {
    this.listeners.push(cb);
  }

  /** Called each time an observation of the database in use shows that it refused the login (isLoginRefused). */
  onLoginRefused(cb: () => void): void {
    this.loginRefusedListeners.push(cb);
  }

  /** Decision 12 (b): called with the new entry when a move builds its pools. */
  onDatabaseChanged(cb: (entry: string) => void): void {
    this.databaseListeners.push(cb);
  }

  /** Decision 13: called with `holdWords()` whenever it changes, and with null when the hold ends. */
  onHoldChanged(cb: (words: string | null) => void): void {
    this.holdListeners.push(cb);
  }

  /** The steps of a move that the shard layer and the data manager own. */
  setMoveSteps(steps: MoveSteps): void {
    this.moveSteps = steps;
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
    if (!this.pool) return this.chooser.lastPassLogin();
    try {
      await this.leaseQuery('SELECT 1', [], ASK_DATABASE_TIMEOUT_MS);
      this.noteSuccess();
      return 'answers';
    } catch (error) {
      if (error instanceof OwnStateRefusal) return 'unreachable';
      this.noteFailure(error);
      return isLoginRefused(error) ? 'refused' : 'unreachable';
    }
  }

  private async bootstrapLoop(): Promise<void> {
    if (!this.pool) {
      const entry = await this.chooser.awaitChoice();
      if (entry === null || this.stopped) return;
      if (!this.pool) this.useEntry(entry);
    }
    let attempt = 0;
    while (!this.stopped) {
      try {
        await this.poolQuery('SELECT 1', [], ANSWER_BOUND_MS);
        const recovery = await this.poolQuery('SELECT pg_is_in_recovery() AS in_recovery', [], ANSWER_BOUND_MS);
        if (recovery.rows[0]?.in_recovery === true) {
          throw new Error('the database is in recovery (read-only); the bot serves only from a database that takes writes');
        }
        await this.provision();
        if (this.schemaMismatch) return;
        if (this.isHeld()) this.stateBeforeHold = 'ready';
        else if (this.latchWhy === null) this.state = 'ready';
        console.log('[PostgresBackend] Connected and provisioned; backend ready');
        return;
      } catch (error) {
        if (this.stopped) return;
        if (!(error instanceof OwnStateRefusal) && this.observedNow(error)) this.noteLoginRefused(error);
        console.warn(`[PostgresBackend] Bootstrap attempt ${attempt + 1} failed (retrying):`, error);
        await this.sleep(backoffDelay(attempt++));
      }
    }
  }

  /** Whether a failure was observed under the current epoch (one with no record was observed now). */
  private observedNow(error: unknown): boolean {
    return (isObject(error) ? this.observed.get(error) ?? this.epoch : this.epoch) === this.epoch;
  }

  /** An answer ends nothing: only the chooser's confirmation ends a hold (decision 13). */
  private noteSuccess(): void {
    // Kept as the one place every answered operation reports to.
  }

  /**
   * Decision 13's one entry rule. A refusal and a deadline cut are no observation; an observation of an earlier epoch,
   * or made while latched, changes nothing; a failure `isSilence` accepts starts the hold.
   */
  private noteFailure(error: unknown): void {
    if (error instanceof OwnStateRefusal) return;
    if (isObject(error) && deadlineCuts.has(error)) return;
    if (this.schemaMismatch || this.stopped || this.entry === null || this.latchWhy !== null) return;
    if (!this.observedNow(error)) return;
    this.noteLoginRefused(error);
    const cause = holdCause(error, isObject(error) && this.loginFailures.has(error));
    if (cause !== null) this.enterHold(cause, error);
  }

  /** A watch pass's failed probe of the chosen entry, made under the given epoch (decision 10). */
  noteObservation(error: unknown, epoch: number, atLogin = false): void {
    this.observedUnder(error, epoch);
    if (atLogin && isObject(error)) this.loginFailures.add(error);
    this.noteFailure(error);
  }

  /** NB4's lapse puts the backend in its hold. */
  noteLapse(): void {
    if (this.schemaMismatch || this.stopped || this.entry === null || this.latchWhy !== null) return;
    this.enterHold("this process's shard claims lapsed");
  }

  private enterHold(cause: string, error?: unknown): void {
    if (this.state === 'outage') return;
    if (this.state !== 'confirming') {
      this.stateBeforeHold = this.state;
      this.outageSince = Date.now();
      if (error !== undefined) console.error(outageLine(error), error);
      this.armOutageAlert();
    }
    this.state = 'outage';
    this.holdEntryCause = cause;
    this.reportHold();
    this.chooser.holdStarted(this, this.epoch);
  }

  /** The watch saw the chosen entry answer under this epoch: the hold waits for its confirmation. */
  noteEntryAnswered(epoch: number): void {
    if (epoch !== this.epoch || this.latchWhy !== null || this.state !== 'outage' || this.schemaMismatch) return;
    this.state = 'confirming';
    this.confirmingCause = 'checking';
    this.reportHold();
  }

  /** The latest attempt to confirm did not (decision 13's confirming causes). */
  noteConfirmingCause(cause: string, epoch: number): void {
    if (epoch !== this.epoch || this.latchWhy !== null || this.state !== 'confirming') return;
    this.confirmingCause = cause;
    this.reportHold();
  }

  /** The chooser confirmed the entry in use under this epoch: the hold ends. */
  confirmHold(epoch: number): void {
    if (epoch !== this.epoch || this.latchWhy !== null || !this.isHeld()) return;
    this.state = this.stateBeforeHold;
    this.outageSince = undefined;
    this.confirmedAt = Date.now();
    this.clearOutageAlertTimer();
    if (this.outageAlertFired) {
      console.log('[PostgresBackend] Recovered from outage');
      this.fireAlert('recovered', 'connection to the data backend restored');
    }
    this.outageAlertFired = false;
    this.reportHold();
  }

  private reportHold(): void {
    const words = this.holdWords();
    if (words === this.reportedHold) return;
    this.reportedHold = words;
    for (const listener of this.holdListeners) {
      try { listener(words); } catch (listenerError) { console.error('[PostgresBackend] A hold listener threw:', listenerError); }
    }
  }

  /**
   * Decision 11's latch, in one synchronous step: the epoch rises, no statement starts on the database again, and every
   * operation that has not sent COMMIT is cut through its client's end().
   */
  latch(cause: LatchCause): void {
    this.epoch += 1;
    this.latchWhy = latchWords(cause, this.address());
    this.lastWhy = this.latchWhy;
    this.moving = null;
    if (this.isHeld()) this.state = this.stateBeforeHold;
    this.outageSince = undefined;
    this.clearOutageAlertTimer();
    this.outageAlertFired = false;
    this.reportedHold = null;
    for (const lease of this.leases) {
      if (lease.commitPassed || lease.cut) continue;
      lease.cut = true;
      try {
        void Promise.resolve(lease.client.end()).catch(() => undefined);
      } catch { /* already ended */ }
    }
  }

  /**
   * Decision 12: moves this process to the entry while latched. (a) the target's check; (b) the epoch raised and the
   * pools built under it; (c) and (d) the claims; (e) the retires sent before the latch; (f) ready and the latch lifted.
   * False when this attempt ended before (f); the latch and everything held stay.
   */
  async useDatabase(entry: string, steps: MoveSteps = this.moveSteps): Promise<boolean> {
    if (this.latchWhy === null || this.stopped) return false;
    const target = this.address(entry);
    const startedUnder = this.epoch;
    const refusal = await steps.checkTarget(entry);
    if (refusal !== null) {
      const line = `[Database] Not moving to ${target}: ${refusal}; this process keeps its unsaved changes and stays stopped`;
      if (!this.moveRefusalsLogged.has(line)) {
        this.moveRefusalsLogged.add(line);
        console.error(line);
      }
      return false;
    }
    if (this.epoch !== startedUnder || this.latchWhy === null || this.stopped) return false;
    const old = this.pool;
    this.useEntry(entry);
    const epoch = this.epoch;
    this.moving = epoch;
    if (old) void old.end().catch(error => console.error('[PostgresBackend] The pool of the database this process left did not end cleanly:', error));
    for (const listener of this.databaseListeners) {
      try { listener(entry); } catch (listenerError) { console.error('[PostgresBackend] A database listener threw:', listenerError); }
    }
    if (!(await steps.claims(entry)) || this.epoch !== epoch) return this.endAttempt(epoch);
    if (!(await steps.settleRetires(epoch, entry)) || this.epoch !== epoch) {
      steps.attemptEnded?.();
      return this.endAttempt(epoch);
    }
    this.moving = null;
    this.latchWhy = null;
    this.moveRefusalsLogged.clear();
    this.state = 'ready';
    steps.moved(entry);
    return true;
  }

  private endAttempt(epoch: number): false {
    if (this.moving === epoch) this.moving = null;
    return false;
  }

  private armOutageAlert(): void {
    if (this.outageAlertFired || this.outageAlertTimer) return;
    this.outageAlertTimer = setTimeout(() => {
      this.outageAlertTimer = null;
      if (this.isHeld() && !this.outageAlertFired) {
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
  // THE STATEMENT HELPER (decision 13, G5, G6, I1, I5)
  // ==========================================================================

  /** The state and epoch check every statement passes right before it is sent; a move's own statements pass the latch. */
  private refusalFor(epoch: number, move = false): OwnStateRefusal | null {
    if (this.latchWhy !== null && !(move && this.moving === epoch && epoch === this.epoch)) return new OwnStateRefusal('latched', this.latchWhy);
    const words = this.holdWords();
    if (words !== null && !move) return new OwnStateRefusal('held', words);
    if (epoch !== this.epoch) return new OwnStateRefusal('latched', this.lastWhy ?? 'this process stopped writing to that database');
    return null;
  }

  private async checkout(move = false): Promise<DataLease> {
    const refusal = this.refusalFor(this.poolEpoch, move);
    if (refusal) throw refusal;
    const pool = this.getPool();
    const epoch = this.poolEpoch;
    const entry = this.entry ?? '';
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch (error) {
      this.observedUnder(error, epoch);
      if (isObject(error)) this.loginFailures.add(error);
      throw error;
    }
    const lease = new DataLease(client, epoch, entry, move);
    this.leases.add(lease);
    return lease;
  }

  /**
   * Sends one statement on a lease. A spoiled lease sends nothing; a refusal spoils it; COMMIT is marked as let through
   * before it goes out; a failure that is not an answer spoils it. boundMs null sends no client bound; callerMs is the
   * time left to the caller's deadline.
   */
  private async sendOn(lease: DataLease, text: string, values: unknown[], boundMs: number | null, callerMs = Infinity, onPass?: () => void): Promise<QueryResult> {
    if (lease.spoiled) throw lease.spoiledBy;
    const refusal = this.refusalFor(lease.epoch, lease.move);
    if (refusal) {
      lease.spoiled = true;
      lease.spoiledBy = refusal;
      throw refusal;
    }
    if (text === 'COMMIT') lease.commitPassed = true;
    onPass?.();
    const timeout = boundMs === null ? undefined : Number.isFinite(callerMs) ? Math.max(1, Math.floor(Math.min(boundMs, callerMs))) : boundMs;
    try {
      if (timeout !== undefined) return await lease.client.query({ text, values, query_timeout: timeout } as QueryConfig);
      return await (values.length > 0 ? lease.client.query(text, values) : lease.client.query(text));
    } catch (error) {
      this.observedUnder(error, lease.epoch);
      if (classifyFailure(error).kind !== 'answered') {
        if (isObject(error) && error instanceof Error && error.message === QUERY_TIMEOUT_MESSAGE && boundMs !== null && callerMs <= boundMs) deadlineCuts.add(error);
        lease.spoiled = true;
        if (lease.spoiledBy === undefined) lease.spoiledBy = error;
      }
      throw error;
    }
  }

  private releaseLease(lease: DataLease, destroy: boolean): void {
    this.leases.delete(lease);
    lease.client.release(destroy || lease.spoiled || lease.cut ? true : undefined);
  }

  /** The pool form of the helper, for one autocommit statement with no lease. */
  private async poolQuery(text: string, values: unknown[], boundMs: number): Promise<QueryResult> {
    const refusal = this.refusalFor(this.poolEpoch);
    if (refusal) throw refusal;
    const epoch = this.poolEpoch;
    try {
      return await this.getPool().query({ text, values, query_timeout: boundMs } as QueryConfig);
    } catch (error) {
      this.observedUnder(error, epoch);
      throw error;
    }
  }

  /** One autocommit statement on a lease, so a failed connect is a failed login (decision 13). */
  private async leaseQuery(text: string, values: unknown[], boundMs: number): Promise<QueryResult> {
    const lease = await this.checkout();
    try {
      return await this.sendOn(lease, text, values, boundMs);
    } catch (error) {
      if (lease.cut) throw new OwnStateRefusal('latched', this.lastWhy ?? 'this process stopped writing to that database');
      throw error;
    } finally {
      this.releaseLease(lease, false);
    }
  }

  /** The refusal a failed operation answers: its own, or the latch's when the latch cut its client. */
  private ownRefusal(lease: DataLease | undefined, error: unknown): OwnStateRefusal | null {
    if (error instanceof OwnStateRefusal) return error;
    if (lease?.cut) return new OwnStateRefusal('latched', this.lastWhy ?? 'this process stopped writing to that database');
    return null;
  }

  /** I4: a close that swallowed its failure still reports what it saw. */
  private noteClosed(lease: DataLease): void {
    if (!lease.spoiled) {
      this.noteSuccess();
      return;
    }
    if (lease.spoiledBy instanceof OwnStateRefusal) return;
    this.noteFailure(lease.spoiledBy);
  }

  // ==========================================================================
  // SELF-PROVISIONING
  // ==========================================================================

  private async provision(): Promise<void> {
    if (this.provisioned) return;
    const lease = await this.checkout();
    let unlocked = false;
    const send = (text: string, values: unknown[] = []) => this.sendOn(lease, text, values, ANSWER_BOUND_MS);
    try {
      await send(`SELECT pg_advisory_lock(hashtext('smdb_data_bootstrap'))`);
      try {
        const existing = await this.readSchemaVersion(lease);
        if (existing !== undefined && !matchesSchemaVersion(existing)) {
          this.latchSchemaMismatch(existing);
          return;
        }
        for (const stmt of PROVISION_DDL) await send(stmt);
        for (let i = 0; i < PARTITION_COUNT; i++) {
          const suffix = `p${String(i).padStart(2, '0')}`;
          await send(
            `CREATE TABLE IF NOT EXISTS smdb_data.guild_data_${suffix} PARTITION OF smdb_data.guild_data FOR VALUES WITH (MODULUS ${PARTITION_COUNT}, REMAINDER ${i})`);
          await send(
            `CREATE TABLE IF NOT EXISTS smdb_data.guild_append_${suffix} PARTITION OF smdb_data.guild_append FOR VALUES WITH (MODULUS ${PARTITION_COUNT}, REMAINDER ${i})`);
        }
        await send(
          `INSERT INTO smdb_data.meta (key, value) VALUES ('schema_version', $1) ON CONFLICT (key) DO NOTHING`,
          [JSON.stringify({ v: SCHEMA_VERSION })]);
        const rawVersion = await this.readSchemaVersion(lease);
        if (rawVersion === undefined || !matchesSchemaVersion(rawVersion)) {
          this.latchSchemaMismatch(rawVersion);
          return;
        }
        await send(
          `INSERT INTO smdb_data.meta (key, value) VALUES ('store_id', $1) ON CONFLICT (key) DO NOTHING`,
          [JSON.stringify(randomUUID())]);
        this.provisioned = true;
      } finally {
        try {
          await send(`SELECT pg_advisory_unlock(hashtext('smdb_data_bootstrap'))`);
          unlocked = true;
        } catch { /* the client ends below, and the lock with its session */ }
      }
    } finally {
      this.releaseLease(lease, !unlocked);
    }
  }

  /** The stored schema_version value; undefined when the meta table or its row does not exist yet. */
  private async readSchemaVersion(lease: DataLease): Promise<string | undefined> {
    try {
      const res = await this.sendOn(lease, `SELECT value FROM smdb_data.meta WHERE key = 'schema_version'`, [], ANSWER_BOUND_MS);
      return res.rows[0]?.value;
    } catch (error) {
      if (isMissingRelation(error)) return undefined;
      throw error;
    }
  }

  private latchSchemaMismatch(found: string | undefined): void {
    this.schemaMismatch = true;
    this.mismatchFound = found ?? 'unreadable';
    this.state = 'outage';
    if (this.outageSince === undefined) this.outageSince = Date.now();
    this.clearOutageAlertTimer();
    const detail = `schema-mismatch: smdb_data.meta schema_version is ${found ?? 'unreadable'}, expected {"v":${SCHEMA_VERSION}}; refusing to serve`;
    console.error(`[PostgresBackend] ${detail}`);
    this.outageAlertFired = true;
    this.fireAlert('outage', detail);
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
    let lease: DataLease;
    try {
      lease = await this.checkout();
    } catch (error) {
      if (error instanceof OwnStateRefusal) return { ok: false, reason: 'unavailable', detail: operationDetail(error) };
      this.noteFailure(error);
      return { ok: false, reason: 'unavailable' };
    }
    let destroy = false;
    const send = (text: string, values: unknown[] = []) => this.sendOn(lease, text, values, ANSWER_BOUND_MS);
    try {
      await send('BEGIN');
      const claim = await send(FENCED_OWNERSHIP_UPSERT, this.fenceParams(guildId, token));
      if ((claim.rowCount ?? 0) !== 1) {
        await send('ROLLBACK');
        const currentOwner = await this.readOwner(lease, guildId);
        this.noteSuccess();
        return { ok: false, reason: 'deposed', currentOwner: currentOwner ?? undefined };
      }
      const read = await this.readGuildDocs(lease, guildId);
      await send('COMMIT');
      // J1: documents read from a database this process stopped writing to serve nothing; the set hydrates again.
      if (lease.epoch !== this.epoch) return { ok: false, reason: 'unavailable' };
      this.noteSuccess();
      return { ok: true, ...read };
    } catch (error) {
      destroy = true;
      const refusal = this.ownRefusal(lease, error);
      if (refusal) return { ok: false, reason: 'unavailable', detail: operationDetail(refusal) };
      await this.rollbackQuiet(lease, error);
      this.noteFailure(error);
      console.error(`[PostgresBackend] hydrateGuild failed for ${guildId}:`, error);
      return { ok: false, reason: 'unavailable' };
    } finally {
      this.releaseLease(lease, destroy);
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
    let lease: DataLease;
    try {
      lease = await this.checkout();
    } catch (error) {
      this.noteFailure(error);
      return null;
    }
    let destroy = false;
    try {
      const params = this.fenceParams(guildId, token);
      let kept = ((await this.sendOn(lease, OWNERSHIP_RECLAIM, params, ANSWER_BOUND_MS)).rowCount ?? 0) === 1;
      if (!kept) kept = ((await this.sendOn(lease, OWNERSHIP_RECLAIM_INSERT, params, ANSWER_BOUND_MS)).rowCount ?? 0) === 1;
      this.noteSuccess();
      return kept ? 'kept' : 'lost';
    } catch (error) {
      destroy = true;
      this.noteFailure(error);
      return null;
    } finally {
      this.releaseLease(lease, destroy);
    }
  }

  /** J2: the guild's documents and append keys, with no client bound (an answer can be large). */
  private async readGuildDocs(lease: DataLease, guildId: string): Promise<{ docs: { key: { module: string; filename: string }; doc: string }[]; appendKeys: { module: string; filename: string }[] }> {
    const docsRes = await this.sendOn(lease,
      `SELECT module, filename, doc FROM smdb_data.guild_data WHERE guild_id = $1`, [guildId], null);
    const appendRes = await this.sendOn(lease,
      `SELECT DISTINCT module, filename FROM smdb_data.guild_append WHERE guild_id = $1`, [guildId], null);
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
    batch.commitSent = false;
    let lease: DataLease;
    try {
      lease = await this.checkout();
    } catch (error) {
      if (error instanceof OwnStateRefusal) return { ok: false, reason: 'unavailable', detail: operationDetail(error) };
      this.noteFailure(error);
      return { ok: false, reason: 'unavailable', ...describeFailure(error) };
    }
    let destroy = false;
    // The query on the wire: when it was sent, its size and the server bound in force for it.
    let sent = { at: performance.now(), bytes: 0, bound: STATEMENT_TIMEOUT_MS };
    const send = (text: string, values: unknown[] = [], bound = boundMs) => {
      sent = { at: performance.now(), bytes: statementBytes(text, values), bound };
      return this.sendOn(lease, text, values, null);
    };
    let copied: { moved: number; retiredAt: number } | null = null;
    try {
      await send(`BEGIN; SET LOCAL statement_timeout = ${boundMs}`, [], STATEMENT_TIMEOUT_MS);
      const claim = await send(FENCED_FLUSH_UPSERT, fence);
      if ((claim.rowCount ?? 0) !== 1) {
        await this.sendOn(lease, 'ROLLBACK', [], ANSWER_BOUND_MS);
        const currentOwner = await this.readOwner(lease, guildId);
        const shardRow = await this.readShardRow(lease, token);
        this.noteSuccess();
        const guildPart = currentOwner
          ? `guild ${guildId} is held by claim ${currentOwner.claim} (${currentOwner.nodeId})`
          : currentOwner === null ? `guild ${guildId}'s ownership row could not be read` : `guild ${guildId} has no ownership row`;
        const shardPart = shardRow === null ? `shard ${token.shardId} of ${token.shardCount}'s claim row could not be read` : describeShardRow(token.shardId, token.shardCount, shardRow);
        const detail = `deposed: ${guildPart}; ${shardPart}; local claim ${token.claim}`;
        console.error(`[PostgresBackend] Flush rejected: ${detail}`);
        this.fireAlert('deposed', detail);
        return { ok: false, reason: 'deposed', currentOwner: currentOwner ?? undefined };
      }
      for (const st of statements) {
        const res = await send(st.text, st.values);
        if (st.copy) copied = { moved: Number(res.rows[0]?.moved ?? 0), retiredAt: Number(res.rows[0]?.retired_at ?? 0) };
      }
      sent = { at: performance.now(), bytes: statementBytes('COMMIT', []), bound: boundMs };
      await this.sendOn(lease, 'COMMIT', [], ANSWER_BOUND_MS, Infinity, () => { batch.commitSent = true; });
      if (lease.epoch !== this.epoch) {
        // Decision 12: a batch answered after this process stopped writing there is checked on the next database.
        return { ok: false, reason: 'unavailable', commitUnanswered: true, landedOn: this.address(lease.entry) };
      }
      this.noteSuccess();
      if (copied && copied.moved > 0) {
        console.log(`[Data] Guild ${guildId}: the re-save on ${this.address(lease.entry)} moved ${copied.moved} row(s) this process did not hold to the graveyard (batch ${copied.retiredAt})`);
      }
      return { ok: true };
    } catch (error) {
      const failedAt = performance.now();
      destroy = true;
      // Set by the COMMIT's onPass, which the compiler does not follow.
      const commitSent = (batch.commitSent as boolean | undefined) === true;
      const refusal = this.ownRefusal(lease, error);
      if (refusal && !commitSent) return { ok: false, reason: 'unavailable', detail: operationDetail(refusal) };
      const failure = describeFailure(error);
      // A ROLLBACK after a sent COMMIT changes nothing, and after the client bound node-pg would queue it behind the COMMIT.
      const unanswered = commitSent && commitMayHaveLanded(error);
      if (!unanswered) await this.rollbackQuiet(lease, error);
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
      this.releaseLease(lease, destroy);
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
    let lease: DataLease;
    try {
      lease = await this.checkout();
    } catch (error) {
      give();
      if (error instanceof OwnStateRefusal) return { fate: 'unknown', detail: operationDetail(error) };
      this.noteFailure(error);
      return { fate: 'unknown', ...describeFailure(error) };
    }
    const ask = (text: string, values: unknown[] = []) => this.sendOn(lease, text, values, ANSWER_BOUND_MS);
    let row: { claim: string | number; last_flush: string | null; node_id?: string } | undefined;
    try {
      await ask('BEGIN');
      row = (await ask(FLUSH_MARK_SELECT, [guildId])).rows[0];
      if (!row) {
        const inserted = await ask(CHECK_OWNERSHIP_INSERT, [guildId, token.nodeId, token.shardId, token.claim, token.shardCount]);
        if ((inserted.rowCount ?? 0) === 1) {
          this.endCheck(lease, give);
          this.noteSuccess();
          return { fate: 'not-landed' };
        }
        row = (await ask(FLUSH_MARK_SELECT, [guildId])).rows[0];
      }
    } catch (error) {
      this.releaseLease(lease, true);
      give();
      const refusal = this.ownRefusal(lease, error);
      if (refusal) return { fate: 'unknown', detail: operationDetail(refusal) };
      this.noteFailure(error);
      return { fate: 'unknown', ...describeFailure(error) };
    }
    this.endCheck(lease, give);
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
  private endCheck(lease: DataLease, give: () => void): void {
    this.sendOn(lease, 'ROLLBACK', [], ANSWER_BOUND_MS).then(
      () => this.releaseLease(lease, false),
      error => {
        if (!(error instanceof OwnStateRefusal) && classifyFailure(error).kind !== 'answered') this.noteFailure(error);
        this.releaseLease(lease, true);
      },
    ).finally(give);
  }

  async retireGuild(guildId: string, reason: string, token: FenceToken, deadline: bigint | null = null): Promise<RetireOutcome> {
    if (this.refusedWithoutClaim('retire', guildId, token)) return { ok: false, reason: 'no-claim' };
    if (deadline !== null && msLeft(deadline) < STATEMENT_FLOOR_MS) return { ok: false, reason: 'out-of-time' };
    let lease: DataLease;
    try {
      lease = await this.checkout();
    } catch (error) {
      if (error instanceof OwnStateRefusal) return this.stoppedBeforeCommit('retireGuild', guildId, error);
      this.noteFailure(error);
      return { ok: false, reason: 'unavailable', detail: describeFailure(error).detail };
    }
    const tx = new BoundedClient(lease, deadline, this.sendOn.bind(this));
    let began = false;
    let commitSent = false;
    let moved = 0;
    const retiredAt = Date.now();
    try {
      await tx.send('BEGIN');
      began = true;
      const claim = await tx.send(FENCED_OWNERSHIP_UPSERT, this.fenceParams(guildId, token));
      if ((claim.rowCount ?? 0) !== 1) {
        await tx.close('ROLLBACK');
        this.noteClosed(lease);
        return { ok: false, reason: 'deposed' };
      }
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
      moved = (docsMoved.rowCount ?? 0) + (streamsMoved.rowCount ?? 0);
      await tx.send(`DELETE FROM smdb_data.guild_data WHERE guild_id = $1`, [guildId]);
      await tx.send(`DELETE FROM smdb_data.guild_append WHERE guild_id = $1`, [guildId]);
      await tx.send(`UPDATE smdb_data.guild_ownership SET retired_at = now() WHERE guild_id = $1`, [guildId]);
      if (tx.left() < COMMIT_FLOOR_MS) {
        await tx.close('ROLLBACK');
        this.noteClosed(lease);
        return { ok: false, reason: 'out-of-time' };
      }
      await tx.send('COMMIT', [], COMMIT_FLOOR_MS, () => { commitSent = true; });
      if (lease.epoch !== this.epoch) return { ok: false, reason: 'unknown', retiredAt, moved, ...this.lateCommit(lease, true) };
      this.noteSuccess();
      console.log(`[PostgresBackend] Guild ${guildId} retired to graveyard (${reason}); ${moved} row(s) moved`);
      return { ok: true, moved, retiredAt };
    } catch (error) {
      if (began) tx.destroy = true;
      if (error instanceof OutOfTime) return { ok: false, reason: 'out-of-time' };
      const refusal = commitSent ? null : this.ownRefusal(lease, error);
      if (refusal) {
        tx.destroy = true;
        return this.stoppedBeforeCommit('retireGuild', guildId, refusal);
      }
      const failure = this.noteTxFailure('retireGuild', guildId, error, commitSent);
      if (commitSent) {
        if (commitRolledBack(error)) return { ok: false, reason: 'refused', detail: describeFailure(error).detail };
        return { ok: false, reason: 'unknown', retiredAt, moved, ...(lease.epoch !== this.epoch ? this.lateCommit(lease, false) : {}) };
      }
      if (failure.kind === 'answered') return { ok: false, reason: 'refused', detail: failure.detail };
      return failure.kind === 'timeout' ? { ok: false, reason: 'unavailable', timedOut: true } : { ok: false, reason: 'unavailable', detail: failure.detail };
    } finally {
      this.releaseLease(lease, tx.destroy);
    }
  }

  /** C7: a retire's or a restore's COMMIT answered after the epoch moved; committed when it answered ok. */
  private lateCommit(lease: DataLease, committed: boolean): { afterLatch: true; late: LateCommit } {
    return { afterLatch: true, late: { committed, old: this.address(lease.entry), why: this.lastWhy ?? 'this process stopped writing there' } };
  }

  /** G12 and H6: the backend's own state stopped a retire or a restore before its COMMIT. */
  private stoppedBeforeCommit(op: 'retireGuild' | 'restoreGuild', guildId: string, refusal: OwnStateRefusal): { ok: false; reason: 'latched' | 'held'; detail: string } {
    console.error(`[PostgresBackend] ${op} of guild ${guildId} stopped before COMMIT (${refusal.detail}); nothing was committed`);
    return { ok: false, reason: refusal.phase, detail: refusal.detail };
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
        ? `the database holds schema version ${this.mismatchFound}`
        : 'the database is not provisioned yet'}`);
      return { ok: false, reason };
    }
    if (this.refusedWithoutClaim('restore', guildId, token)) return { ok: false, reason: 'no-claim' };
    if (msLeft(deadline) < STATEMENT_FLOOR_MS) return { ok: false, reason: 'out-of-time' };
    let lease: DataLease;
    try {
      lease = await this.checkout();
    } catch (error) {
      if (error instanceof OwnStateRefusal) return this.stoppedBeforeCommit('restoreGuild', guildId, error);
      this.noteFailure(error);
      return { ok: false, reason: 'unavailable', detail: describeFailure(error).detail };
    }
    const tx = new BoundedClient(lease, deadline, this.sendOn.bind(this));
    let began = false;
    let commitSent = false;
    let batch = retiredAt;
    const decided = async (answer: RestoreOutcome): Promise<RestoreOutcome> => {
      await tx.close('ROLLBACK');
      this.noteClosed(lease);
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
        this.noteClosed(lease);
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
      await tx.send('COMMIT', [], COMMIT_FLOOR_MS, () => { commitSent = true; });
      if (lease.epoch !== this.epoch) return { ok: false, reason: 'unknown', retiredAt: batch, ...this.lateCommit(lease, true) };
      this.noteSuccess();
      console.log(`[PostgresBackend] Guild ${guildId} restored from graveyard batch ${batch}; ${taken} row(s) moved back`);
      return { ok: true, moved: taken, retiredAt: batch, reason: typeof moved.reason === 'string' ? moved.reason : '' };
    } catch (error) {
      if (began) tx.destroy = true;
      if (error instanceof OutOfTime) return { ok: false, reason: 'out-of-time' };
      const refusal = commitSent ? null : this.ownRefusal(lease, error);
      if (refusal) {
        tx.destroy = true;
        return this.stoppedBeforeCommit('restoreGuild', guildId, refusal);
      }
      const failure = this.noteTxFailure('restoreGuild', guildId, error, commitSent);
      const at = batch === null ? {} : { retiredAt: batch };
      if (commitSent) {
        if (commitRolledBack(error)) return { ok: false, reason: 'refused', detail: describeFailure(error).detail, code: describeFailure(error).code };
        return { ok: false, reason: 'unknown', ...at, ...(lease.epoch !== this.epoch ? this.lateCommit(lease, false) : {}) };
      }
      if (failure.kind === 'answered') return { ok: false, reason: 'refused', detail: failure.detail, code: failure.code };
      return failure.kind === 'timeout'
        ? { ok: false, reason: 'unavailable', detail: "the database did not answer within the restore's 40 s", timedOut: true }
        : { ok: false, reason: 'unavailable', detail: failure.detail };
    } finally {
      this.releaseLease(lease, tx.destroy);
    }
  }

  /**
   * Logs a failed bounded transaction. A failure that is not an answer is an observation (a deadline cut is ignored
   * there); an answer that shows the transaction rolled back counts as one.
   */
  private noteTxFailure(op: string, guildId: string, error: unknown, commitSent: boolean): TxFailure {
    const failure = classifyFailure(error);
    if (failure.kind === 'connection' || failure.kind === 'timeout') this.noteFailure(error);
    const refused = commitSent ? commitRolledBack(error) : failure.kind === 'answered';
    if (refused) this.noteSuccess();
    if (commitSent && !refused && failure.kind === 'answered') {
      console.error(`[PostgresBackend] ${op} of guild ${guildId}: COMMIT answered ${describeFailure(error).detail}, which does not show that it rolled back; can't confirm whether it committed`);
    } else if (commitSent && !refused) {
      console.error(`[PostgresBackend] ${op} of guild ${guildId}: COMMIT got no answer (${error instanceof Error ? error.message : String(error)}); can't confirm whether it committed`);
    } else {
      console.error(`[PostgresBackend] ${op} failed for ${guildId}:`, error);
    }
    return failure;
  }

  /**
   * Decision 12 (e): whether the retire's batch is on the move's target, read on the pool (b) built while the latch is
   * up. Throws when the read fails or no move runs under the current epoch.
   */
  async retireReached(guildId: string, retiredAt: number): Promise<boolean> {
    const lease = await this.checkout(true);
    try {
      const res = await this.sendOn(lease, BATCH_PRESENT, [guildId, retiredAt], ANSWER_BOUND_MS);
      return res.rows[0]?.present === true;
    } finally {
      this.releaseLease(lease, false);
    }
  }

  private fenceParams(guildId: string, token: FenceToken): unknown[] {
    return [guildId, token.nodeId, token.shardId, token.claim, token.shardCount, token.processId];
  }

  /**
   * The claim row of the token's shard for the refusal line; undefined for no row, null when the read was answered
   * with an error. A read that got no answer, or was refused, throws.
   */
  private async readShardRow(lease: DataLease, token: FenceToken): Promise<{ claim: number; holder_name: string; released: boolean; reserved: boolean } | undefined | null> {
    try {
      const res = await this.sendOn(lease,
        `SELECT claim::text AS claim, holder_name, released, reserved FROM smdb_data.shard_claims WHERE shard_count = $1 AND shard_id = $2`,
        [token.shardCount, token.shardId], ANSWER_BOUND_MS);
      const row = res.rows[0];
      return row ? { claim: Number(row.claim), holder_name: row.holder_name, released: row.released === true, reserved: row.reserved === true } : undefined;
    } catch (error) {
      if (lease.spoiled) throw error;
      return null;
    }
  }

  /** The guild's owner; undefined for no row, null when the read was answered with an error; throws on no answer. */
  private async readOwner(lease: DataLease, guildId: string): Promise<GuildOwner | undefined | null> {
    try {
      const res = await this.sendOn(lease, OWNER_SELECT, [guildId], ANSWER_BOUND_MS);
      const row = res.rows[0];
      if (!row) return undefined;
      return { nodeId: row.node_id, claim: Number(row.claim) };
    } catch (error) {
      if (lease.spoiled) throw error;
      return null;
    }
  }

  /**
   * H2: the ROLLBACK after a failed hydrate or flush, sent only on a lease that is not spoiled. Its failure is noted
   * only when the operation's own error was an answer, since the caller notes any other error itself.
   */
  private async rollbackQuiet(lease: DataLease, error: unknown): Promise<void> {
    if (lease.spoiled) return;
    try {
      await this.sendOn(lease, 'ROLLBACK', [], ANSWER_BOUND_MS);
    } catch (rollbackError) {
      if (classifyFailure(error).kind === 'answered') this.noteFailure(rollbackError);
    }
  }

  // ==========================================================================
  // READS + CATALOG
  // ==========================================================================

  async loadDoc(guildId: string, key: DocKey): Promise<string | null> {
    const res = await this.readLong(
      `SELECT doc FROM smdb_data.guild_data WHERE guild_id = $1 AND module = $2 AND filename = $3`,
      [guildId, key.module, key.filename]);
    return res.rows[0]?.doc ?? null;
  }

  async listGuilds(): Promise<string[]> {
    const res = await this.readLong(
      `SELECT guild_id FROM smdb_data.guild_ownership WHERE retired_at IS NULL`, []);
    return res.rows.map(row => row.guild_id);
  }

  async listOwnedGuilds(shardIds: number[], shardCount: number): Promise<string[]> {
    const res = await this.readLong(
      `SELECT guild_id FROM smdb_data.guild_ownership
        WHERE retired_at IS NULL AND ((guild_id::bigint >> 22) % $1) = ANY($2)`,
      [shardCount, shardIds]);
    return res.rows.map(row => row.guild_id);
  }

  async listGuildFiles(guildId: string, module?: string): Promise<string[]> {
    // Non-recursive top-level .json parity with fileBackend.listGuildDataFiles;
    // no module means the guild namespace root ('').
    const res = await this.readLong(
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
      const res = await this.leaseQuery(text, values, ANSWER_BOUND_MS);
      this.noteSuccess();
      return res;
    } catch (error) {
      this.noteFailure(error);
      throw error;
    }
  }

  /** J2: a read whose answer can be large, on a lease the latch can cut, with no client bound. */
  private async readLong(text: string, values: unknown[]): Promise<QueryResult> {
    let lease: DataLease | undefined;
    try {
      lease = await this.checkout();
      const res = await this.sendOn(lease, text, values, null);
      this.noteSuccess();
      return res;
    } catch (error) {
      if (lease?.cut) throw new OwnStateRefusal('latched', this.lastWhy ?? 'this process stopped writing to that database');
      if (error instanceof OwnStateRefusal) throw error;
      this.noteFailure(error);
      throw error;
    } finally {
      if (lease) this.releaseLease(lease, false);
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
  /** The replace mode's graveyard copy, whose answer the flush keeps for its line. */
  copy?: boolean;
}

/**
 * NB5 decision 12 and G7: copies the guild's live rows whose keys the set does not hold into one graveyard batch of its
 * own, numbered above the guild's newest batch, and answers the rows copied and the batch.
 */
const REPLACE_COPY = `WITH batch AS (
    SELECT GREATEST($2::bigint, COALESCE((SELECT max(retired_at) FROM smdb_data.guild_data_graveyard WHERE guild_id = $1), 0) + 1) AS at),
  docs AS (INSERT INTO smdb_data.guild_data_graveyard (guild_id, module, filename, kind, doc, retired_at, reason)
    SELECT d.guild_id, d.module, d.filename, 'doc', d.doc, (SELECT at FROM batch), $7
      FROM smdb_data.guild_data d
     WHERE d.guild_id = $1 AND (d.module, d.filename) NOT IN (SELECT * FROM unnest($3::text[], $4::text[]))
    RETURNING 1),
  appends AS (INSERT INTO smdb_data.guild_data_graveyard (guild_id, module, filename, kind, doc, retired_at, reason)
    SELECT a.guild_id, a.module, a.filename, 'append', string_agg(a.chunk, '' ORDER BY a.seq), (SELECT at FROM batch), $7
      FROM smdb_data.guild_append a
     WHERE a.guild_id = $1 AND (a.module, a.filename) NOT IN (SELECT * FROM unnest($5::text[], $6::text[]))
     GROUP BY a.guild_id, a.module, a.filename
    RETURNING 1)
  SELECT (SELECT count(*) FROM docs) + (SELECT count(*) FROM appends) AS moved, (SELECT at FROM batch) AS retired_at`;

const REPLACE_DELETE_DATA = `DELETE FROM smdb_data.guild_data WHERE guild_id = $1 AND (module, filename) NOT IN (SELECT * FROM unnest($2::text[], $3::text[]))`;
const REPLACE_DELETE_APPEND = `DELETE FROM smdb_data.guild_append WHERE guild_id = $1 AND (module, filename) NOT IN (SELECT * FROM unnest($2::text[], $3::text[]))`;

/**
 * The flush's statements after its fenced claim: upserts of at most MAX_ROWS_PER_STATEMENT rows and
 * FLUSH_STATEMENT_BYTES of document and key text (a larger row alone), the deletes, and each append buffer as rows of
 * at most FLUSH_STATEMENT_BYTES, in order.
 */
function flushStatements(guildId: string, batch: GuildFlushBatch): Statement[] {
  const out: Statement[] = [];
  const add = (st: { text: string; values: unknown[]; copy?: boolean }) => out.push({ ...st, bytes: statementBytes(st.text, st.values) });
  if (batch.replace) {
    const docModules = batch.replace.docKeys.map(k => k.module);
    const docFiles = batch.replace.docKeys.map(k => k.filename);
    const appendModules = batch.replace.appendKeys.map(k => k.module);
    const appendFiles = batch.replace.appendKeys.map(k => k.filename);
    add({ text: REPLACE_COPY, values: [guildId, Date.now(), docModules, docFiles, appendModules, appendFiles, batch.replace.reason], copy: true });
    add({ text: REPLACE_DELETE_DATA, values: [guildId, docModules, docFiles] });
    add({ text: REPLACE_DELETE_APPEND, values: [guildId, appendModules, appendFiles] });
  }
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

async function metaClient(config: ClientConfig, bounds: { connectMs: number; statementMs: number } = { connectMs: CONNECT_TIMEOUT_MS, statementMs: STATEMENT_TIMEOUT_MS }): Promise<Client> {
  const client = shortLivedClient({
    connectionTimeoutMillis: bounds.connectMs,
    statement_timeout: bounds.statementMs,
    keepAlive: true,
    ...config,
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
export async function readStoreId(config: ClientConfig): Promise<string | null> {
  const client = await metaClient(config);
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

const MOVE_CHECK_MS = 5_000;

/**
 * Decision 12 (a): on one short-lived session with the probe's bounds, the target's store id must equal the one this
 * machine records (when it records one) and its schema version this bot's. Null when it may be written, else why not.
 */
export async function checkMoveTarget(entry: string, recordedStoreId: string | null): Promise<string | null> {
  let client: Client;
  try {
    client = await metaClient(pgConfig(entry), { connectMs: MOVE_CHECK_MS, statementMs: MOVE_CHECK_MS });
  } catch (error) {
    return `its store id and schema version could not be read (${describeFailure((error as { cause?: unknown }).cause ?? error).detail})`;
  }
  try {
    const ask = (text: string) => client.query({ text, query_timeout: MOVE_CHECK_MS } as QueryConfig);
    const version = (await ask(`SELECT value FROM smdb_data.meta WHERE key = 'schema_version'`)).rows[0]?.value;
    if (typeof version !== 'string' || !matchesSchemaVersion(version)) {
      return `the database holds schema version ${version ?? 'unreadable'}, and this bot reads only version ${SCHEMA_VERSION}`;
    }
    const raw = (await ask(`SELECT value FROM smdb_data.meta WHERE key = 'store_id'`)).rows[0]?.value;
    const storeId: unknown = typeof raw === 'string' ? JSON.parse(raw) : null;
    if (recordedStoreId !== null && storeId !== recordedStoreId) {
      return `the configured database is not the one this deployment's data lives in (store ${String(storeId)} vs recorded ${recordedStoreId})`;
    }
    return null;
  } catch (error) {
    return `its store id and schema version could not be read (${describeFailure(error).detail})`;
  } finally {
    await client.end().catch(() => { /* best effort */ });
  }
}
