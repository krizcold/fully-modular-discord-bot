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
const CLEAR_RECORD_RETRY_MS = 5000;
const CLEAR_RECORD_NOTE_EVERY = 12;

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

/** The term row this cluster holds: term 0 and no holder when there is none, null when the read failed (which records nothing). */
async function readRow(client: Client): Promise<{ term: number; nodeId: string | null } | null> {
  try {
    const present = await client.query(`SELECT to_regclass('smdb_control.term') IS NOT NULL AS present`);
    if (present.rows[0]?.present !== true) return { term: 0, nodeId: null };
    const res = await client.query('SELECT term, node_id FROM smdb_control.term WHERE id = 1');
    if (res.rows.length === 0) return { term: 0, nodeId: null };
    const term = Number(res.rows[0].term);
    if (!Number.isFinite(term)) return null;
    return { term, nodeId: typeof res.rows[0].node_id === 'string' && res.rows[0].node_id !== '' ? res.rows[0].node_id : null };
  } catch {
    return null;
  }
}

export interface PostureClear {
  /** Relaxed, or there was nothing armed to relax. */
  ok: boolean;
  error?: string;
  /** Left armed with a copy streaming in sync: writes go through and the watchdog relaxes it under the same rule. */
  leftArmed?: boolean;
  /** Left armed because its term row names this other node, whose own watchdog owns the posture. */
  foreign?: string;
}

/**
 * Relax the posture on the database this url names. An armed cluster is
 * released only once recordRelax, handed the term row the cluster holds, has
 * recorded the relax on the witness, the rule every relax keeps (B7-F23's
 * full partition); while it cannot, this waits, unless a copy is streaming in
 * sync, which lets the boot's writes through with the posture left armed for
 * the watchdog to relax under the same rule. A cluster whose row names
 * another node is that node's to relax, so it is left armed unless the
 * caller has been let past that node (foreignAllowed).
 */
export async function clearSyncPosture(url: string, recordRelax?: (rowTerm: number) => Promise<boolean>, opts: { selfNodeId?: string; foreignAllowed?: boolean } = {}): Promise<PostureClear> {
  const open = async (): Promise<Client | null> => {
    const fresh = shortLivedClient({
      connectionString: url,
      connectionTimeoutMillis: CLEAR_CONNECT_TIMEOUT_MS,
      query_timeout: CLEAR_QUERY_TIMEOUT_MS,
    });
    try {
      await fresh.connect();
      return fresh;
    } catch {
      await fresh.end().catch(() => { /* never connected */ });
      return null;
    }
  };
  let client = await open();
  if (!client) return { ok: false, error: 'the database could not be reached' };
  try {
    const names = String((await client.query(`SELECT current_setting('synchronous_standby_names') AS names`)).rows[0]?.names ?? '').trim();
    if (names !== '' && recordRelax) {
      for (let attempt = 0; ; attempt++) {
        const row = client ? await readRow(client) : null;
        if (row && row.nodeId !== null && opts.selfNodeId && row.nodeId !== opts.selfNodeId && !opts.foreignAllowed) {
          return { ok: false, foreign: row.nodeId };
        }
        if (row && await recordRelax(row.term).catch(() => false)) break;
        // A read that failed can be a connection that died under it (the
        // database restarted during the wait): a fresh one is dialed.
        if (!row) {
          await client?.end().catch(() => { /* already gone */ });
          client = await open();
        }
        const inSync = client
          ? await client.query(`SELECT count(*) AS n FROM pg_stat_replication WHERE sync_state = 'sync'`).then(r => Number(r.rows[0]?.n) > 0).catch(() => false)
          : false;
        if (inSync) return { ok: false, leftArmed: true };
        if (attempt % CLEAR_RECORD_NOTE_EVERY === 0) {
          console.error(row
            ? `[Fleet] The database came back armed (${names}) with no copy in sync, and the relax cannot be recorded on the witness yet, so the boot waits rather than release writes that copy may never have received; retrying every ${CLEAR_RECORD_RETRY_MS / 1000} s`
            : `[Fleet] The database came back armed (${names}), and its term row cannot be read, so the boot waits rather than release writes unrecorded; retrying every ${CLEAR_RECORD_RETRY_MS / 1000} s`);
        }
        await new Promise(resolve => setTimeout(resolve, CLEAR_RECORD_RETRY_MS));
      }
    }
    await client!.query('ALTER SYSTEM RESET synchronous_standby_names');
    await client!.query('SELECT pg_reload_conf()');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await client?.end().catch(() => { /* best effort */ });
  }
}

/**
 * The master's own boot clear. A file-mode fleet has no cluster to relax, and a
 * node with no backend url yet cannot be reached, so both are silent no-ops.
 * Its ok is true only when the cluster was actually relaxed, which is what the
 * boot attestation rests on.
 */
export async function clearOwnSyncPosture(recordRelax?: (rowTerm: number) => Promise<boolean>, opts: { selfNodeId?: string; foreignAllowed?: boolean } = {}): Promise<PostureClear> {
  // Keyed on the backend KIND, not on the url alone: a url left over from a
  // postgres phase outlives the flip back to file, and dialing it would relax
  // a cluster this node no longer serves from.
  if (resolveDataBackend() !== 'postgres') return { ok: false };
  const url = (loadCredentials().DATA_BACKEND_URL || '').trim();
  if (!url) return { ok: false };
  const cleared = await clearSyncPosture(url, recordRelax, opts);
  if (cleared.foreign) {
    console.warn(`[Fleet] The database is armed, and its term row names node ${cleared.foreign.slice(0, 8)}: the boot leaves the posture to that master's watchdog, and relaxes it under the same rule only once the takeover guard lets this boot past that master`);
  } else if (cleared.leftArmed) {
    console.warn('[Fleet] The database came back armed with a copy streaming in sync, so the boot leaves the posture to the watchdog, which relaxes it once the relax is recorded on the witness');
  } else if (!cleared.ok && cleared.error) {
    console.warn(`[Fleet] Could not relax the synchronous posture at boot (a database that came back armed would hang its first write): ${cleared.error}`);
  }
  return cleared;
}
