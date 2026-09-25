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
 * the first statement of a master's boot. It touches only the one setting this
 * project owns; the lowered wal_sender_timeout that rides along with an arm is
 * reset by the arm's own relax, because only there is it known to be ours.
 */
import { Client } from 'pg';
import { shortLivedClient } from '../utils/pgClient';
import { loadCredentials, resolveDataBackend } from '../../../utils/envLoader';

const CLEAR_CONNECT_TIMEOUT_MS = 5000;
const CLEAR_QUERY_TIMEOUT_MS = 10000;

/**
 * Exactly what postgres accepts as a slot name, and therefore as the
 * application_name a seeded standby streams under. The armed value is a GUC
 * LITERAL that no parameter can carry (ALTER SYSTEM takes none), so the name
 * is checked against this before it is ever interpolated (B6 map F13).
 */
const ARMABLE_SLOT_NAME = /^[a-z0-9_]{1,63}$/;

export function isArmableSlotName(name: string): boolean {
  return ARMABLE_SLOT_NAME.test(name);
}

/**
 * Arm on ONE named copy (B6 map F14: FIRST 1, never a bare name and never a
 * wildcard, which would sweep in the rescue walsender and the seed's own
 * basebackup connection). wal_sender_timeout is lowered with it so a standby
 * whose MACHINE vanishes loses its walsender in seconds rather than the
 * default minute, which is what makes the watchdog's row-is-gone signal timely
 * (F16). It does NOT bound the stall itself: a commit waiting on a named copy
 * with no walsender at all waits forever. Each statement is its own round
 * trip: ALTER SYSTEM is refused inside the implicit transaction a
 * multi-statement string makes.
 */
export async function armSyncPosture(client: Client, slotName: string, walSenderTimeoutMs: number): Promise<void> {
  if (!isArmableSlotName(slotName)) throw new Error(`refusing to arm on an unusable slot name: ${JSON.stringify(slotName)}`);
  await client.query(`ALTER SYSTEM SET synchronous_standby_names = 'FIRST 1 ("${slotName}")'`);
  await client.query(`ALTER SYSTEM SET wal_sender_timeout = '${Math.round(walSenderTimeoutMs)}ms'`);
  await client.query('SELECT pg_reload_conf()');
}

/** Relax over a connection the caller owns. Writes no WAL, so it returns even against a backend every write is stalled behind. */
export async function relaxSyncPosture(client: Client): Promise<void> {
  await client.query('ALTER SYSTEM RESET synchronous_standby_names');
  await client.query('ALTER SYSTEM RESET wal_sender_timeout');
  await client.query('SELECT pg_reload_conf()');
}

/** Relax the posture on the database this url names. Best effort by contract: the caller boots either way. */
export async function clearSyncPosture(url: string): Promise<{ ok: boolean; error?: string }> {
  const client = shortLivedClient({
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
 * Resolves true only when the cluster was actually relaxed, which is what the
 * boot attestation rests on.
 */
export async function clearOwnSyncPosture(): Promise<boolean> {
  // Keyed on the backend KIND, not on the url alone: a url left over from a
  // postgres phase outlives the flip back to file, and dialing it would relax
  // a cluster this node no longer serves from.
  if (resolveDataBackend() !== 'postgres') return false;
  const url = (loadCredentials().DATA_BACKEND_URL || '').trim();
  if (!url) return false;
  const cleared = await clearSyncPosture(url);
  if (!cleared.ok) {
    console.warn(`[Fleet] Could not relax the synchronous posture at boot (a database that came back armed would hang its first write): ${cleared.error}`);
  }
  return cleared.ok;
}
