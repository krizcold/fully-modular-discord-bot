// WebuiDataReader - READ-ONLY database access for the webui fork parent.
// The parent has no Working Set and must never write postgres or touch
// fencing; postgres-routed guild reads in the routes go through this reader.

import { Pool } from 'pg';
import type { PoolClient, QueryConfig } from 'pg';
import { guardPoolClients } from '../../bot/internalSetup/utils/pgClient';
import { loadCredentials } from '../../utils/envLoader';
import { canonicalGuildKey } from '../../bot/internalSetup/utils/dataKeys';
import { HOLDER_CHECK_SQL } from '../../bot/internalSetup/utils/dataBackends/guildRequestSql';

const READER_ERROR = 'data backend unreachable';
const READER_MAX = 2;
const QUERY_BOUND_MS = 5000;

let reportedUrl: string | null = null;
let generation = 0;

/**
 * The store the running bot child serves (its DATA_BACKEND_URL), reported over
 * IPC at every install of its postgres runtime. Null while no child serves one:
 * the reader then opens the node's own database.
 */
export function setWebuiDataStoreUrl(url: string | null): void {
  const next = url && url.trim() ? url.trim() : null;
  if (next === reportedUrl) return;
  reportedUrl = next;
  generation += 1;
}

/** The database the web UI's pools open: the store the bot child reported, else this node's DATA_BACKEND_URL; null for none. */
export function resolveWebuiDatabaseUrl(): string | null {
  const url = (reportedUrl ?? (loadCredentials().DATA_BACKEND_URL || '')).trim();
  return url || null;
}

/** Waits for a pooled connection at most boundMs; one handed out later goes back to the pool. */
export async function connectWithin(pool: Pool, boundMs: number, poolWords: string, max: number): Promise<PoolClient> {
  const pending = pool.connect();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const busy = pool.totalCount >= max && pool.idleCount === 0;
      const seconds = Math.round(boundMs / 100) / 10;
      reject(new Error(busy
        ? `every connection of ${poolWords} was in use for ${seconds} s`
        : `the database did not take a connection within ${seconds} s`));
    }, Math.max(0, boundMs));
  });
  try {
    return await Promise.race([pending, timeout]);
  } catch (error) {
    void pending.then(client => client.release(), () => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export class WebuiDataReader {
  private pool: Pool | null = null;
  private poolGeneration = -1;
  private poolUrl: string | null = null;

  private getPool(): Pool {
    if (this.pool && this.poolGeneration !== generation) {
      void this.pool.end().catch(() => {});
      this.pool = null;
    }
    if (!this.pool) {
      const url = resolveWebuiDatabaseUrl();
      if (!url) {
        throw new Error(READER_ERROR);
      }
      this.poolGeneration = generation;
      this.poolUrl = url;
      this.pool = new Pool({
        connectionString: url,
        max: READER_MAX,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30000,
        // A data migration leaves this reader's sessions out of its count of other sessions: they only read.
        application_name: 'smdb-webui-reader'
      });
      // An idle client error would otherwise crash the parent process.
      this.pool.on('error', () => {});
      guardPoolClients(this.pool, 'the web UI reader');
    }
    return this.pool;
  }

  /**
   * One statement under its own client bound, its hand-out bounded too: an error keeps its SQLSTATE, and a client
   * whose query got no answer is destroyed.
   */
  private async boundedQuery(text: string, params: unknown[], boundMs: number): Promise<{ rows: any[]; url: string }> {
    const pool = this.getPool();
    const url = this.poolUrl!;
    const started = Date.now();
    const client = await connectWithin(pool, Math.min(QUERY_BOUND_MS, boundMs), "the web UI's reader pool", READER_MAX);
    let destroy = false;
    try {
      const left = Math.max(1, Math.min(QUERY_BOUND_MS, boundMs - (Date.now() - started)));
      const result = await client.query({ text, values: params, query_timeout: left } as QueryConfig);
      return { rows: result.rows, url };
    } catch (error) {
      destroy = typeof (error as { code?: unknown })?.code !== 'string';
      throw error;
    } finally {
      client.release(destroy ? true : undefined);
    }
  }

  /**
   * NB7 decision 4: the shard of a guild and the claim row serving it, read-only (claimStore.ts holderStateOf judges it),
   * with the database URL the pool that read it was built on.
   */
  async holderOf(guildId: string, boundMs = QUERY_BOUND_MS): Promise<{ rows: any[]; url: string }> {
    return this.boundedQuery(HOLDER_CHECK_SQL, [guildId], boundMs);
  }

  private async query(text: string, params: any[]): Promise<any[]> {
    try {
      const result = await this.getPool().query(text, params);
      return result.rows;
    } catch {
      throw new Error(READER_ERROR);
    }
  }

  async listGuilds(): Promise<string[]> {
    const rows = await this.query(
      `SELECT guild_id FROM smdb_data.guild_data
       UNION
       SELECT guild_id FROM smdb_data.guild_append`,
      []
    );
    return rows.map(row => row.guild_id);
  }

  async listFiles(guildId: string, category?: string): Promise<string[]> {
    // Mirrors fileBackend.listGuildDataFiles: non-recursive, .json files only.
    const rows = category === undefined
      ? await this.query(
          `SELECT filename FROM smdb_data.guild_data
           WHERE guild_id = $1 AND module = '' AND filename NOT LIKE '%/%' AND filename LIKE '%.json'
           UNION
           SELECT filename FROM smdb_data.guild_append
           WHERE guild_id = $1 AND module = '' AND filename NOT LIKE '%/%' AND filename LIKE '%.json'`,
          [guildId]
        )
      : await this.query(
          `SELECT filename FROM smdb_data.guild_data
           WHERE guild_id = $1 AND module = $2 AND filename LIKE '%.json'
           UNION
           SELECT filename FROM smdb_data.guild_append
           WHERE guild_id = $1 AND module = $2 AND filename LIKE '%.json'`,
          [guildId, category]
        );
    return rows.map(row => row.filename);
  }

  async listModules(guildId: string): Promise<string[]> {
    const rows = await this.query(
      `SELECT module FROM smdb_data.guild_data
       WHERE guild_id = $1 AND module <> ''
       UNION
       SELECT module FROM smdb_data.guild_append
       WHERE guild_id = $1 AND module <> ''`,
      [guildId]
    );
    return rows.map(row => row.module);
  }

  async exists(guildId: string, module: string, filename: string): Promise<boolean> {
    const rows = await this.query(
      `SELECT (
         EXISTS (SELECT 1 FROM smdb_data.guild_data
                 WHERE guild_id = $1 AND module = $2 AND filename = $3)
         OR EXISTS (SELECT 1 FROM smdb_data.guild_append
                    WHERE guild_id = $1 AND module = $2 AND filename = $3)
       ) AS present`,
      [guildId, module, filename]
    );
    return rows[0]?.present === true;
  }

  async listGraveyard(): Promise<Array<{ guildId: string; retiredAt: number; reason: string; rows: number }>> {
    const rows = await this.query(
      `SELECT guild_id, retired_at, reason, COUNT(*)::int AS row_count
       FROM smdb_data.guild_data_graveyard
       GROUP BY guild_id, retired_at, reason
       ORDER BY retired_at DESC`,
      []
    );
    return rows.map(row => ({
      guildId: row.guild_id,
      retiredAt: Number(row.retired_at),
      reason: row.reason,
      rows: Number(row.row_count)
    }));
  }

  /**
   * A guild document as the bot's own read gives it (NB7 decision 10): the guild_data row under the canonical key; a
   * key that holds only appended lines reads as absent. An error keeps its SQLSTATE.
   */
  async readDoc(guildId: string, module: string, filename: string, boundMs = QUERY_BOUND_MS): Promise<string | null> {
    const key = canonicalGuildKey(module, filename);
    const { rows } = await this.boundedQuery(
      `SELECT doc FROM smdb_data.guild_data
       WHERE guild_id = $1 AND module = $2 AND filename = $3`,
      [guildId, key.module, key.filename],
      boundMs
    );
    return rows.length > 0 ? rows[0].doc : null;
  }
}

export function isDataBackendUnreachable(error: unknown): boolean {
  return error instanceof Error && error.message === READER_ERROR;
}

let instance: WebuiDataReader | null = null;

export function getWebuiDataReader(): WebuiDataReader {
  if (!instance) {
    instance = new WebuiDataReader();
  }
  return instance;
}
