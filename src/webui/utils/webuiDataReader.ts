// WebuiDataReader - READ-ONLY database access for the webui fork parent.
// The parent has no Working Set and must never write postgres or touch
// fencing; postgres-routed guild reads in the routes go through this reader.

import { Pool } from 'pg';
import { loadCredentials } from '../../utils/envLoader';

const READER_ERROR = 'data backend unreachable';

export class WebuiDataReader {
  private pool: Pool | null = null;

  private getPool(): Pool {
    if (!this.pool) {
      const url = (loadCredentials().DATA_BACKEND_URL || '').trim();
      if (!url) {
        throw new Error(READER_ERROR);
      }
      this.pool = new Pool({
        connectionString: url,
        max: 2,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30000
      });
      // An idle client error would otherwise crash the parent process.
      this.pool.on('error', () => {});
    }
    return this.pool;
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

  async readDoc(guildId: string, module: string, filename: string): Promise<string | null> {
    const docRows = await this.query(
      `SELECT doc FROM smdb_data.guild_data
       WHERE guild_id = $1 AND module = $2 AND filename = $3`,
      [guildId, module, filename]
    );
    if (docRows.length > 0) {
      return docRows[0].doc;
    }
    const appendRows = await this.query(
      `SELECT string_agg(chunk, '' ORDER BY seq) AS doc FROM smdb_data.guild_append
       WHERE guild_id = $1 AND module = $2 AND filename = $3`,
      [guildId, module, filename]
    );
    const doc = appendRows[0]?.doc;
    return doc == null ? null : doc;
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
