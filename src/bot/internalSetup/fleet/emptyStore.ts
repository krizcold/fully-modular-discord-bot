// Empty-store probe for the boot hold (PLAN_REPLICATION 20.14). Raw one-shot
// connections on purpose: the control store's own accessors provision DDL and
// seed from local files on first touch, which is exactly what must NOT happen
// to a store that may still need seeding from a backup.

import { Client } from 'pg';
import { PROMOTE_SQL_TIMEOUT_MS } from './constants';

export type StoreEmptiness = 'empty' | 'populated' | 'unreachable';

async function countRows(url: string, relation: string, where: string): Promise<number | 'unreachable'> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000, query_timeout: PROMOTE_SQL_TIMEOUT_MS });
  try {
    await client.connect();
    const exists = await client.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [relation]);
    if (exists.rows[0]?.present !== true) return 0;
    const res = await client.query(`SELECT count(*)::int AS n FROM ${relation}${where ? ` WHERE ${where}` : ''}`);
    return Number(res.rows[0]?.n) || 0;
  } catch {
    return 'unreachable';
  } finally {
    await client.end().catch(() => { /* best effort */ });
  }
}

/**
 * Empty = no term row on the control store AND no live guild ownership on the
 * data store (they are the same database unless CONTROL_STORE_URL splits them).
 * Unreachable is its own verdict: an empty store that is merely late to start
 * must keep holding, not slip through as "not proven empty".
 */
export async function probeStoreEmpty(controlUrl: string, dataUrl: string): Promise<StoreEmptiness> {
  if (!controlUrl || !dataUrl) return 'unreachable';
  const term = await countRows(controlUrl, 'smdb_control.term', '');
  if (term === 'unreachable') return 'unreachable';
  const ownership = await countRows(dataUrl, 'smdb_data.guild_ownership', 'retired_at IS NULL');
  if (ownership === 'unreachable') return 'unreachable';
  return term === 0 && ownership === 0 ? 'empty' : 'populated';
}
