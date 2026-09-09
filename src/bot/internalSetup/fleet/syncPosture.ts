/**
 * The synchronous replication posture, and the one rule that governs it today:
 * it is strictly EPHEMERAL (PLAN_REPLICATION 20.5, B6 map F18).
 *
 * ALTER SYSTEM writes synchronous_standby_names into postgresql.auto.conf inside
 * PGDATA, on the named volume, where it survives container recreation AND is
 * copied byte for byte into every standby seeded from that volume. A cluster
 * that comes back carrying it names standbys it does not have, so every WAL
 * write hangs while pg_isready still answers and docker still calls the
 * container healthy. Nothing in this project may rely on the setting
 * persisting; every lane that starts or repoints a database clears it first.
 *
 * The clear is always safe to run: relaxing the posture writes no WAL, so it
 * cannot itself hang behind a wedged backend, which is what makes it usable as
 * the first statement of a master's boot.
 */
import { Client } from 'pg';
import { loadCredentials, resolveDataBackend } from '../../../utils/envLoader';

const CLEAR_CONNECT_TIMEOUT_MS = 5000;
const CLEAR_QUERY_TIMEOUT_MS = 10000;

/** Relax the posture on the database this url names. Best effort by contract: the caller boots either way. */
export async function clearSyncPosture(url: string): Promise<{ ok: boolean; error?: string }> {
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: CLEAR_CONNECT_TIMEOUT_MS,
    query_timeout: CLEAR_QUERY_TIMEOUT_MS,
  });
  try {
    await client.connect();
    await client.query('ALTER SYSTEM RESET synchronous_standby_names');
    await client.query('SELECT pg_reload_conf()');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await client.end().catch(() => { /* best effort */ });
  }
}

/**
 * The master's own boot clear. A file-mode fleet has no cluster to relax, and a
 * node with no backend url yet cannot be reached, so both are silent no-ops:
 * this runs before the control store exists and must never hold up a boot.
 */
export async function clearOwnSyncPosture(): Promise<void> {
  // Keyed on the backend KIND, not on the url alone: a url left over from a
  // postgres phase outlives the flip back to file, and dialing it would relax
  // a cluster this node no longer serves from.
  if (resolveDataBackend() !== 'postgres') return;
  const url = (loadCredentials().DATA_BACKEND_URL || '').trim();
  if (!url) return;
  const cleared = await clearSyncPosture(url);
  if (!cleared.ok) {
    console.warn(`[Fleet] Could not relax the synchronous posture at boot (a database that came back armed would hang its first write): ${cleared.error}`);
  }
}
