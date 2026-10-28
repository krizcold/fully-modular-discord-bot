// PostgresBackend - central-database guild storage behind the DataBackend
// contract. Owns the connection pool, self-provisioned DDL, the fenced
// ownership transactions (hydrate/flush/retire/restore), catalog reads, and
// the outage state machine. Coalescing, freeze, byte-stringification and
// metrics live in the facade / Working Set, never here.

import { randomUUID } from 'crypto';
import { Client, Pool } from 'pg';
import { guardPoolClients, shortLivedClient } from '../pgClient';
import type { PoolClient, QueryConfig, QueryResult } from 'pg';
import type {
  DataBackend,
  DocKey,
  FenceToken,
  FlushOutcome,
  GuildFlushBatch,
  GuildOwner,
  HydrationOutcome,
  RetireOutcome,
} from './backend';

export const SCHEMA_VERSION = 2;
const CLAIM_PROVISION_POLL_MS = 5000;
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
    updated_at   timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS guild_ownership_node_idx ON smdb_data.guild_ownership (node_id)`,
  `CREATE SEQUENCE IF NOT EXISTS smdb_data.claim_seq`,
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
];

// One process holds one claim and claims never repeat, so an equal claim is the same process. A guild served again
// after a retire is listed again.
const FENCED_OWNERSHIP_UPDATE = `
  UPDATE smdb_data.guild_ownership
     SET node_id = $2, shard_id = $3, claim = $4, shard_count = $5, retired_at = NULL, updated_at = now()
   WHERE guild_id = $1 AND claim <= $4`;

const OWNER_SELECT = `SELECT node_id, claim FROM smdb_data.guild_ownership WHERE guild_id = $1`;

const OWNERSHIP_RECLAIM = `
  UPDATE smdb_data.guild_ownership
     SET shard_id = $3, claim = $4, shard_count = $5, updated_at = now()
   WHERE guild_id = $1 AND node_id = $2 AND claim <= $4`;

const OWNERSHIP_INSERT = `
  INSERT INTO smdb_data.guild_ownership (guild_id, node_id, shard_id, claim, shard_count)
  VALUES ($1, $2, $3, $4, $5) ON CONFLICT (guild_id) DO NOTHING`;

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

function parseStoredClaim(raw: unknown): number {
  const claim = Number(raw);
  if (!Number.isSafeInteger(claim) || claim < 0) throw new Error(`unusable claim number ${String(raw)}`);
  return claim;
}

export type ClaimAnswer = { outcome: 'claimed'; claim: number } | { outcome: 'mismatch' } | { outcome: 'stopped' };

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
  private provisioned = false;
  private started = false;
  private stopped = false;
  private probing = false;
  private readonly listeners: AlertListener[] = [];
  private readonly loginRefusedListeners: Array<() => void> = [];
  private readonly pendingSleeps = new Set<{ timer: NodeJS.Timeout; resolve: () => void }>();

  constructor(opts: { url: string }) {
    this.pool = new Pool({
      connectionString: opts.url,
      max: POOL_MAX,
      min: 0,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
      keepAlive: true,
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
    if (!isLoginRefused(error)) return;
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
        if (this.schemaMismatch) return;
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
    console.error('[PostgresBackend] Operation failed; entering outage:', error);
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

  private async provision(): Promise<void> {
    if (this.provisioned) return;
    const client = await this.pool.connect();
    try {
      await client.query(`SELECT pg_advisory_lock(hashtext('smdb_data_bootstrap'))`);
      try {
        const existing = await this.readSchemaVersion(client);
        if (existing !== undefined && !matchesSchemaVersion(existing)) {
          this.latchSchemaMismatch(existing);
          return;
        }
        for (const stmt of PROVISION_DDL) await client.query(stmt);
        for (let i = 0; i < PARTITION_COUNT; i++) {
          const suffix = `p${String(i).padStart(2, '0')}`;
          await client.query(
            `CREATE TABLE IF NOT EXISTS smdb_data.guild_data_${suffix} PARTITION OF smdb_data.guild_data FOR VALUES WITH (MODULUS ${PARTITION_COUNT}, REMAINDER ${i})`);
          await client.query(
            `CREATE TABLE IF NOT EXISTS smdb_data.guild_append_${suffix} PARTITION OF smdb_data.guild_append FOR VALUES WITH (MODULUS ${PARTITION_COUNT}, REMAINDER ${i})`);
        }
        await client.query(
          `INSERT INTO smdb_data.meta (key, value) VALUES ('schema_version', $1) ON CONFLICT (key) DO NOTHING`,
          [JSON.stringify({ v: SCHEMA_VERSION })]);
        const rawVersion = await this.readSchemaVersion(client);
        if (rawVersion === undefined || !matchesSchemaVersion(rawVersion)) {
          this.latchSchemaMismatch(rawVersion);
          return;
        }
        await client.query(
          `INSERT INTO smdb_data.meta (key, value) VALUES ('store_id', $1) ON CONFLICT (key) DO NOTHING`,
          [JSON.stringify(randomUUID())]);
        this.provisioned = true;
      } finally {
        try {
          await client.query(`SELECT pg_advisory_unlock(hashtext('smdb_data_bootstrap'))`);
        } catch { /* session gone; the lock dies with it */ }
      }
    } finally {
      client.release();
    }
  }

  /** The stored schema_version value; undefined when the meta table or its row does not exist yet. */
  private async readSchemaVersion(client: PoolClient): Promise<string | undefined> {
    try {
      const res = await client.query(`SELECT value FROM smdb_data.meta WHERE key = 'schema_version'`);
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

  // ==========================================================================
  // CLAIM NUMBERS
  // ==========================================================================

  /**
   * This process's claim number, once provisioning has passed: the next value of smdb_data.claim_seq, raised above
   * every claim a guild_ownership row holds (a restore can bring rows back without the sequence's value). Answers
   * 'mismatch' when the database's schema version is not this bot's and 'stopped' once the backend stopped. Throws
   * while the database cannot answer.
   */
  async takeClaim(): Promise<ClaimAnswer> {
    for (;;) {
      if (this.stopped) return { outcome: 'stopped' };
      if (this.provisioned) break;
      if (this.schemaMismatch) return { outcome: 'mismatch' };
      await this.sleep(CLAIM_PROVISION_POLL_MS);
    }
    const client = await this.pool.connect();
    let destroy = false;
    try {
      await client.query('BEGIN');
      // Every taker holds this lock, so a setval never moves the sequence back under another taker.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('smdb_data_claim'))`);
      let claim = parseStoredClaim((await client.query(`SELECT nextval('smdb_data.claim_seq') AS claim`)).rows[0]?.claim);
      const highest = (await client.query(`SELECT max(claim) AS claim FROM smdb_data.guild_ownership`)).rows[0]?.claim;
      const floor = highest === null || highest === undefined ? 0 : parseStoredClaim(highest);
      if (claim <= floor) {
        claim = floor + 1;
        await client.query(`SELECT setval('smdb_data.claim_seq', $1)`, [claim]);
      }
      if (!usableClaim(claim)) throw new Error(`unusable claim number ${claim}`);
      await client.query('COMMIT');
      return { outcome: 'claimed', claim };
    } catch (error) {
      destroy = true;
      await this.rollbackQuiet(client);
      throw error;
    } finally {
      client.release(destroy ? true : undefined);
    }
  }

  /** A fenced call with no usable claim touches no row and leaves the outage state alone. */
  private refusedWithoutClaim(op: 'hydrate' | 'flush' | 'retire' | 'reclaim', guildId: string, token: FenceToken): boolean {
    if (usableClaim(token.claim)) return false;
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
      const claim = await client.query(FENCED_OWNERSHIP_UPDATE, this.fenceParams(guildId, token));
      let claimed = (claim.rowCount ?? 0) === 1;
      if (!claimed) {
        const inserted = await client.query(OWNERSHIP_INSERT, this.fenceParams(guildId, token));
        claimed = (inserted.rowCount ?? 0) === 1;
      }
      if (!claimed) {
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
      if (!kept) kept = ((await client.query(OWNERSHIP_INSERT, params)).rowCount ?? 0) === 1;
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
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      this.noteFailure(error);
      return { ok: false, reason: 'unavailable', ...describeFailure(error) };
    }
    let destroy = false;
    try {
      await client.query('BEGIN');
      const claim = await client.query(FENCED_OWNERSHIP_UPDATE, this.fenceParams(guildId, token));
      let claimed = (claim.rowCount ?? 0) === 1;
      if (!claimed) {
        // A guild whose row was swept or never written has none; absent is not deposed.
        const inserted = await client.query(OWNERSHIP_INSERT, this.fenceParams(guildId, token));
        claimed = (inserted.rowCount ?? 0) === 1;
      }
      if (!claimed) {
        await client.query('ROLLBACK');
        const currentOwner = await this.readOwner(client, guildId);
        this.noteSuccess();
        const ownerText = currentOwner ? `${currentOwner.nodeId} (claim ${currentOwner.claim})` : 'unknown';
        const detail = `deposed: guild ${guildId} owned by ${ownerText}; local token ${token.nodeId} (claim ${token.claim})`;
        console.error(`[PostgresBackend] Flush rejected: ${detail}`);
        this.fireAlert('deposed', detail);
        return { ok: false, reason: 'deposed', currentOwner };
      }
      for (const rows of chunk(batch.upserts, MAX_ROWS_PER_STATEMENT)) {
        const upsert = buildUpsert(guildId, rows);
        await client.query(upsert.text, upsert.values);
      }
      for (const keys of chunk(batch.deletes, MAX_ROWS_PER_STATEMENT)) {
        const tuples = buildKeyTuples(guildId, keys);
        await client.query(
          `DELETE FROM smdb_data.guild_data WHERE guild_id = $1 AND (module, filename) IN (${tuples.list})`,
          tuples.values);
        await client.query(
          `DELETE FROM smdb_data.guild_append WHERE guild_id = $1 AND (module, filename) IN (${tuples.list})`,
          tuples.values);
      }
      for (const append of batch.appends) {
        await client.query(
          `INSERT INTO smdb_data.guild_append (guild_id, module, filename, chunk) VALUES ($1, $2, $3, $4)`,
          [guildId, append.key.module, append.key.filename, append.chunk]);
      }
      await client.query('COMMIT');
      this.noteSuccess();
      return { ok: true };
    } catch (error) {
      destroy = true;
      await this.rollbackQuiet(client);
      this.noteFailure(error);
      console.error(`[PostgresBackend] flushGuild failed for ${guildId} (caller retries):`, error);
      return { ok: false, reason: 'unavailable', ...describeFailure(error) };
    } finally {
      client.release(destroy ? true : undefined);
    }
  }

  async retireGuild(guildId: string, reason: string, token: FenceToken): Promise<RetireOutcome> {
    if (this.refusedWithoutClaim('retire', guildId, token)) return { ok: false, reason: 'unavailable' };
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
      const claim = await client.query(FENCED_OWNERSHIP_UPDATE, this.fenceParams(guildId, token));
      if ((claim.rowCount ?? 0) !== 1) {
        // No row is not a competitor: a guild that never wrote has no
        // ownership row; claim it so the retire can tombstone it.
        const inserted = await client.query(OWNERSHIP_INSERT, this.fenceParams(guildId, token));
        if ((inserted.rowCount ?? 0) !== 1) {
          await client.query('ROLLBACK');
          this.noteSuccess();
          return { ok: false, reason: 'deposed' };
        }
      }
      const retiredAt = Date.now();
      const docsMoved = await client.query(
        `INSERT INTO smdb_data.guild_data_graveyard (guild_id, module, filename, kind, doc, retired_at, reason)
         SELECT guild_id, module, filename, 'doc', doc, $2, $3
           FROM smdb_data.guild_data WHERE guild_id = $1`,
        [guildId, retiredAt, reason]);
      const streamsMoved = await client.query(
        `INSERT INTO smdb_data.guild_data_graveyard (guild_id, module, filename, kind, doc, retired_at, reason)
         SELECT guild_id, module, filename, 'append', string_agg(chunk, '' ORDER BY seq), $2, $3
           FROM smdb_data.guild_append WHERE guild_id = $1
          GROUP BY guild_id, module, filename`,
        [guildId, retiredAt, reason]);
      await client.query(`DELETE FROM smdb_data.guild_data WHERE guild_id = $1`, [guildId]);
      await client.query(`DELETE FROM smdb_data.guild_append WHERE guild_id = $1`, [guildId]);
      await client.query(`UPDATE smdb_data.guild_ownership SET retired_at = now() WHERE guild_id = $1`, [guildId]);
      await client.query('COMMIT');
      this.noteSuccess();
      const moved = (docsMoved.rowCount ?? 0) + (streamsMoved.rowCount ?? 0);
      console.log(`[PostgresBackend] Guild ${guildId} retired to graveyard (${reason}); ${moved} row(s) moved`);
      return { ok: true, moved };
    } catch (error) {
      destroy = true;
      await this.rollbackQuiet(client);
      this.noteFailure(error);
      console.error(`[PostgresBackend] retireGuild failed for ${guildId}:`, error);
      return { ok: false, reason: 'unavailable' };
    } finally {
      client.release(destroy ? true : undefined);
    }
  }

  async restoreGuild(guildId: string, retiredAt: number, _token: FenceToken): Promise<{ ok: true; moved: number } | { ok: false; reason: string }> {
    if (this.schemaMismatch || !this.provisioned) {
      const reason = this.schemaMismatch ? 'schema-mismatch' : 'not-provisioned';
      console.error(`[PostgresBackend] Refused restore for guild ${guildId}: ${this.schemaMismatch
        ? `the database holds schema version ${this.mismatchFound}`
        : 'the database is not provisioned yet'}`);
      return { ok: false, reason };
    }
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
      const live = await client.query(
        `SELECT EXISTS (SELECT 1 FROM smdb_data.guild_data WHERE guild_id = $1) AS present`, [guildId]);
      if (live.rows[0]?.present === true) {
        await client.query('ROLLBACK');
        this.noteSuccess();
        return { ok: false, reason: 'live-rows' };
      }
      const docs = await client.query(
        `INSERT INTO smdb_data.guild_data (guild_id, module, filename, doc)
         SELECT guild_id, module, filename, doc
           FROM smdb_data.guild_data_graveyard
          WHERE guild_id = $1 AND retired_at = $2 AND kind = 'doc'
         ON CONFLICT (guild_id, module, filename) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()`,
        [guildId, retiredAt]);
      const appends = await client.query(
        `INSERT INTO smdb_data.guild_append (guild_id, module, filename, chunk)
         SELECT guild_id, module, filename, doc
           FROM smdb_data.guild_data_graveyard
          WHERE guild_id = $1 AND retired_at = $2 AND kind = 'append'`,
        [guildId, retiredAt]);
      await client.query(
        `DELETE FROM smdb_data.guild_data_graveyard WHERE guild_id = $1 AND retired_at = $2`,
        [guildId, retiredAt]);
      await client.query(`UPDATE smdb_data.guild_ownership SET retired_at = NULL WHERE guild_id = $1`, [guildId]);
      await client.query('COMMIT');
      this.noteSuccess();
      const moved = (docs.rowCount ?? 0) + (appends.rowCount ?? 0);
      console.log(`[PostgresBackend] Guild ${guildId} restored from graveyard batch ${retiredAt}; ${moved} row(s) moved back`);
      return { ok: true, moved };
    } catch (error) {
      destroy = true;
      await this.rollbackQuiet(client);
      this.noteFailure(error);
      console.error(`[PostgresBackend] restoreGuild failed for ${guildId}:`, error);
      return { ok: false, reason: 'unavailable' };
    } finally {
      client.release(destroy ? true : undefined);
    }
  }

  private fenceParams(guildId: string, token: FenceToken): unknown[] {
    return [guildId, token.nodeId, token.shardId, token.claim, token.shardCount];
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

  private async rollbackQuiet(client: PoolClient): Promise<void> {
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

  /** Newest graveyard batch (retired_at ms) for a guild; null when none exist. */
  async latestGraveyardBatch(guildId: string): Promise<number | null> {
    const res = await this.read(
      `SELECT MAX(retired_at) AS retired_at FROM smdb_data.guild_data_graveyard WHERE guild_id = $1`,
      [guildId]);
    const value = res.rows[0]?.retired_at;
    return value == null ? null : Number(value);
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

