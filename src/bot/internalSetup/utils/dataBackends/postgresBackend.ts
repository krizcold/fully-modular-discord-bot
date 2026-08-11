// PostgresBackend - central-database guild storage behind the DataBackend
// contract. Owns the connection pool, self-provisioned DDL, the fenced
// ownership transactions (hydrate/flush/retire/restore), catalog reads, and
// the outage state machine. Coalescing, freeze, byte-stringification and
// metrics live in the facade / Working Set, never here.

import { randomUUID } from 'crypto';
import { Client, Pool } from 'pg';
import type { PoolClient, QueryResult } from 'pg';
import type {
  DataBackend,
  DocKey,
  FenceToken,
  FlushOutcome,
  GuildFlushBatch,
  HydrationOutcome,
  RetireOutcome,
} from './backend';

const SCHEMA_VERSION = 1;
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
    term         bigint NOT NULL,
    epoch        bigint NOT NULL,
    shard_count  integer NOT NULL,
    retired_at   timestamptz,
    updated_at   timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS guild_ownership_node_idx ON smdb_data.guild_ownership (node_id)`,
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

// Equal (term, epoch) across two different nodes is possible by construction
// (grant rounds hand the bumped epoch to the target), so equality only orders
// within one node_id; across nodes the fence is strict <.
const FENCED_OWNERSHIP_UPDATE = `
  UPDATE smdb_data.guild_ownership
     SET node_id = $2, shard_id = $3, term = $4, epoch = $5, shard_count = $6, updated_at = now()
   WHERE guild_id = $1
     AND ((term, epoch) < ($4, $5) OR ((term, epoch) = ($4, $5) AND node_id = $2))`;

const OWNERSHIP_INSERT = `
  INSERT INTO smdb_data.guild_ownership (guild_id, node_id, shard_id, term, epoch, shard_count)
  VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (guild_id) DO NOTHING`;

type AlertEvent = 'outage' | 'recovered' | 'deposed';
type AlertListener = (event: AlertEvent, detail: string) => void;

export class PostgresBackend implements DataBackend {
  readonly kind = 'postgres' as const;

  /** Shared with the PostgresControlStore when no CONTROL_STORE_URL redirects it. */
  getPool(): Pool {
    return this.pool;
  }

  private readonly pool: Pool;
  private state: 'connecting' | 'ready' | 'outage' = 'connecting';
  private outageSince: number | undefined;
  private outageAlertFired = false;
  private outageAlertTimer: NodeJS.Timeout | null = null;
  private schemaMismatch = false;
  private provisioned = false;
  private started = false;
  private stopped = false;
  private probing = false;
  private readonly listeners: AlertListener[] = [];
  private readonly pendingSleeps = new Set<{ timer: NodeJS.Timeout; resolve: () => void }>();

  constructor(opts: { url: string }) {
    this.pool = new Pool({
      connectionString: opts.url,
      max: POOL_MAX,
      min: 0,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
      keepAlive: true,
    });
    this.pool.on('connect', client => {
      // Queued ahead of any caller query on this session (per-client FIFO).
      void client
        .query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}; SET idle_in_transaction_session_timeout = ${IDLE_IN_TX_TIMEOUT_MS}`)
        .catch(() => { /* a dead session surfaces on first use */ });
    });
    this.pool.on('error', error => {
      // Unhandled idle-client errors would crash the process.
      console.error('[PostgresBackend] Idle client error:', error);
    });
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

  connectionState(): { state: 'connecting' | 'ready' | 'outage'; outageSinceMs?: number } {
    if (this.state === 'outage') return { state: 'outage', outageSinceMs: this.outageSince };
    return { state: this.state };
  }

  healthy(): boolean {
    return this.state === 'ready';
  }

  onAlert(cb: AlertListener): void {
    this.listeners.push(cb);
  }

  private async bootstrapLoop(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      try {
        await this.pool.query('SELECT 1');
        await this.provision();
        if (this.schemaMismatch) return;
        this.becomeReady();
        console.log('[PostgresBackend] Connected and provisioned; backend ready');
        return;
      } catch (error) {
        if (this.stopped) return;
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
        } catch { /* still down; keep probing */ }
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
        const versionRes = await client.query(`SELECT value FROM smdb_data.meta WHERE key = 'schema_version'`);
        const rawVersion: string | undefined = versionRes.rows[0]?.value;
        let versionOk = false;
        if (rawVersion !== undefined) {
          try {
            versionOk = (JSON.parse(rawVersion) as { v?: number })?.v === SCHEMA_VERSION;
          } catch {
            versionOk = false;
          }
        }
        if (!versionOk) {
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

  private latchSchemaMismatch(found: string | undefined): void {
    this.schemaMismatch = true;
    this.state = 'outage';
    if (this.outageSince === undefined) this.outageSince = Date.now();
    this.clearOutageAlertTimer();
    const detail = `schema-mismatch: smdb_data.meta schema_version is ${found ?? 'unreadable'}, expected {"v":${SCHEMA_VERSION}}; refusing to serve`;
    console.error(`[PostgresBackend] ${detail}`);
    this.outageAlertFired = true;
    this.fireAlert('outage', detail);
  }

  // ==========================================================================
  // FENCED TRANSACTIONS
  // ==========================================================================

  async hydrateGuild(guildId: string, token: FenceToken): Promise<HydrationOutcome> {
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
      const docsRes = await client.query(
        `SELECT module, filename, doc FROM smdb_data.guild_data WHERE guild_id = $1`, [guildId]);
      const appendRes = await client.query(
        `SELECT DISTINCT module, filename FROM smdb_data.guild_append WHERE guild_id = $1`, [guildId]);
      await client.query('COMMIT');
      this.noteSuccess();
      return {
        ok: true,
        docs: docsRes.rows.map(row => ({ key: { module: row.module, filename: row.filename }, doc: row.doc })),
        appendKeys: appendRes.rows.map(row => ({ module: row.module, filename: row.filename })),
      };
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

  async flushGuild(guildId: string, batch: GuildFlushBatch, token: FenceToken): Promise<FlushOutcome> {
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
        await client.query('ROLLBACK');
        const currentOwner = await this.readOwner(client, guildId);
        this.noteSuccess();
        const ownerText = currentOwner
          ? `${currentOwner.nodeId} (term ${currentOwner.term}, epoch ${currentOwner.epoch})`
          : 'unknown';
        const detail = `deposed: guild ${guildId} owned by ${ownerText}; local token ${token.nodeId} (term ${token.term}, epoch ${token.epoch})`;
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
      return { ok: false, reason: 'unavailable' };
    } finally {
      client.release(destroy ? true : undefined);
    }
  }

  async retireGuild(guildId: string, reason: string, token: FenceToken): Promise<RetireOutcome> {
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
        await client.query('ROLLBACK');
        this.noteSuccess();
        return { ok: false, reason: 'deposed' };
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
    return [guildId, token.nodeId, token.shardId, token.term, token.epoch, token.shardCount];
  }

  private async readOwner(client: PoolClient, guildId: string): Promise<{ nodeId: string; term: number; epoch: number } | undefined> {
    try {
      const res = await client.query(
        `SELECT node_id, term, epoch FROM smdb_data.guild_ownership WHERE guild_id = $1`, [guildId]);
      const row = res.rows[0];
      if (!row) return undefined;
      return { nodeId: row.node_id, term: Number(row.term), epoch: Number(row.epoch) };
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

  async sizeOfGuildData(guildId: string): Promise<number> {
    const res = await this.read(
      `SELECT COALESCE((SELECT SUM(octet_length(doc)) FROM smdb_data.guild_data WHERE guild_id = $1), 0)
            + COALESCE((SELECT SUM(octet_length(chunk)) FROM smdb_data.guild_append WHERE guild_id = $1), 0) AS total`,
      [guildId]);
    return Number(res.rows[0]?.total ?? 0);
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

export interface BackendStateMarker {
  live: 'file' | 'postgres';
  storeId: string | null;
  flippedAt: number;
  transformationId: string | null;
}

/** Thrown when the database cannot be reached, so the recognition guard can
 * tell "no marker" apart from "cannot ask". */
export class PostgresUnreachableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'PostgresUnreachableError';
    this.cause = cause;
  }
}

function isMissingRelation(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === '42P01' || code === '3F000';
}

async function metaClient(url: string): Promise<Client> {
  const client = new Client({
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

/** Meta 'backend_state' marker; null when reachable but absent (incl. an
 * unprovisioned database), PostgresUnreachableError when the DB cannot be asked. */
export async function readBackendState(url: string): Promise<BackendStateMarker | null> {
  const client = await metaClient(url);
  try {
    let res: QueryResult;
    try {
      res = await client.query(`SELECT value FROM smdb_data.meta WHERE key = 'backend_state'`);
    } catch (error) {
      if (isMissingRelation(error)) return null;
      throw new PostgresUnreachableError('backend_state read failed', error);
    }
    if (res.rows.length === 0) return null;
    return JSON.parse(res.rows[0].value) as BackendStateMarker;
  } finally {
    await client.end().catch(() => { /* best effort */ });
  }
}

export async function writeBackendState(url: string, state: BackendStateMarker): Promise<void> {
  const client = await metaClient(url);
  try {
    await client.query(
      `INSERT INTO smdb_data.meta (key, value, updated_at) VALUES ('backend_state', $1, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(state)]);
  } finally {
    await client.end().catch(() => { /* best effort */ });
  }
}

/** Meta 'store_id'; null when reachable but absent, PostgresUnreachableError
 * when the DB cannot be asked. */
export async function readStoreId(url: string): Promise<string | null> {
  const client = await metaClient(url);
  try {
    let res: QueryResult;
    try {
      res = await client.query(`SELECT value FROM smdb_data.meta WHERE key = 'store_id'`);
    } catch (error) {
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

/** TTL sweep: graveyard rows plus retired ownership rows older than the cutoff.
 * Returns the number of rows deleted; idempotent, safe to misfire. */
export async function sweepGraveyardRows(url: string, cutoffMs: number): Promise<number> {
  const client = await metaClient(url);
  try {
    const tombstones = await client.query(
      `DELETE FROM smdb_data.guild_data_graveyard WHERE retired_at < $1`, [cutoffMs]);
    const ownership = await client.query(
      `DELETE FROM smdb_data.guild_ownership
        WHERE retired_at IS NOT NULL AND retired_at < to_timestamp($1::double precision / 1000.0)`,
      [cutoffMs]);
    return (tombstones.rowCount ?? 0) + (ownership.rowCount ?? 0);
  } finally {
    await client.end().catch(() => { /* best effort */ });
  }
}
