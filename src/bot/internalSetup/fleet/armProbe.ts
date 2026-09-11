// The reads the stand-in arm decision needs from the LOCAL standby (B6-f).
//
// Raw one-shot connections, like emptyStore's, and for the same reason: the
// control store's own accessors provision DDL on first touch, and DDL on a
// cluster in recovery is refused outright (SQLSTATE 25006) even in its
// IF NOT EXISTS form. These reads must work on a replica, so they never go
// through an accessor that might try to write.
//
// Every function answers null for "could not establish it". The arm lane treats
// null as a refusal, never as a permissive default: an unreadable standby is
// exactly the state in which standing in would serve nothing.

import { Client } from 'pg';
import { PROMOTE_SQL_TIMEOUT_MS } from './constants';

async function withReadOnlyClient<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T | null> {
  if (!url) return null;
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000, query_timeout: PROMOTE_SQL_TIMEOUT_MS });
  // A socket fault emits OUTSIDE the query promise; without a listener it would
  // reach the process as an unhandled 'error' event and take the bot down.
  client.on('error', () => { /* the awaited call below reports the failure */ });
  try {
    await client.connect();
    return await fn(client);
  } catch {
    return null;
  } finally {
    await client.end().catch(() => { /* best effort */ });
  }
}

export interface StandbyTermRow {
  term: number;
  nodeId: string;
}

/**
 * The replayed term row: who the fleet's master is and at what term. This is
 * both the identity a stand-in would cover and the proof that this copy still
 * holds the fleet's state at all.
 */
export function readStandbyTermRow(url: string): Promise<StandbyTermRow | null> {
  return withReadOnlyClient(url, async client => {
    const res = await client.query(`SELECT term, node_id FROM smdb_control.term WHERE id = 1`);
    const row = res.rows[0];
    if (!row) return null;
    const term = Number(row.term);
    const nodeId = typeof row.node_id === 'string' ? row.node_id : '';
    return Number.isFinite(term) && term > 0 && nodeId !== '' ? { term, nodeId } : null;
  });
}

/**
 * Whether the fleet is paused on a reshard. A stand-in can read this marker but
 * can never resolve it, and a master booting into a pause assigns nothing at
 * all, so standing in would serve LESS than the dark master did (F26).
 */
export function readReshardPending(url: string): Promise<boolean | null> {
  return withReadOnlyClient(url, async client => {
    const res = await client.query(`SELECT body FROM smdb_control.docs WHERE name = 'reshard-pending'`);
    return res.rows.length > 0 && res.rows[0].body != null;
  });
}
