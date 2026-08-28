// Promote-the-pair (PLAN_REPLICATION Stage 3): the bot side of a manager-
// provisioned streaming replica.
//
// The fleet deposes an old master with ONE mechanism: a CAS on the shared term
// row (postgresControlStore.stampTerm). That mechanism only works while there
// is one database. So promoting the standby is not something to do whenever a
// standby exists - it FORKS the store, and a forked store cannot fence
// anything. The database is promoted only when the primary is provably gone:
//
//   receiver streaming | canonical store reachable | action
//   -------------------|---------------------------|----------------------------
//   yes                | yes                       | role-only takeover (the CAS
//                      |                           | fences the old master; zero
//                      |                           | RPO, no fork)
//   yes                | no                        | refuse: the primary is alive
//                      |                           | and we cannot reach it
//   no                 | yes                       | role-only takeover, warn that
//                      |                           | replication is broken
//   no                 | no                        | promote the pair, but ONLY if
//                      |                           | masterAlive is false
//
// Those two columns are NOT independent: the standby streams from the very
// host:port the canonical URL names, so one blocked route or one dead sidecar
// darkens both at once while the master keeps serving on the C1 window. The
// master's control channel (masterKnown) runs on a different port and protocol
// and is the only path-independent liveness signal in the system, so the
// irreversible lane is gated on it too.
//
// PARENT PROCESS ONLY. The webui parent owns the promote lane because it owns
// /data/.env precedence: a
// URL the container environment pins cannot be overridden from the file, and
// the parent is the process whose loadCredentials() can tell the two apart.

import { Client } from 'pg';
import { loadCredentials, upsertCredentials } from '../../../utils/envLoader';
import { REPLICA_CATCHUP_POLL_MS, REPLICA_CATCHUP_WAIT_MS, REPLICA_LAG_PROMOTE_MAX_MS } from './constants';

export interface ReplicaEndpoints {
  /** Local container-network URL: what this node probes and promotes. */
  local: string;
  /** Host-reachable URL: what the whole fleet dials once this pair is the primary. */
  public: string;
}

/**
 * Both endpoints arrive credential-less from the manager (the standby's auth
 * is byte-copied from the primary, so this node's own fleet credentials are
 * valid on it). A replica without its public endpoint is unusable: promoting
 * it would hand cross-host workers a container name they cannot resolve.
 */
export function resolveReplicaEndpoints(): ReplicaEndpoints | null {
  const local = (process.env.FLEET_DB_REPLICA_URL || '').trim();
  const publicUrl = (process.env.FLEET_DB_REPLICA_PUBLIC_URL || '').trim();
  if (local === '' || publicUrl === '') return null;
  return { local, public: publicUrl };
}

/** True when this node carries a manager-provisioned standby of the fleet database. */
export function hasDbReplica(): boolean {
  return resolveReplicaEndpoints() !== null;
}

/** Splice this node's fleet credentials into a credential-less replica endpoint. */
export function spliceFleetCredentials(replicaUrl: string): { url?: string; error?: string } {
  const creds = loadCredentials();
  const base = (creds.DATA_BACKEND_URL || '').trim() || (creds.CONTROL_STORE_URL || '').trim();
  if (!base) return { error: 'no DATA_BACKEND_URL/CONTROL_STORE_URL known to take the fleet credentials from (delivered on the first register)' };
  try {
    const replica = new URL(replicaUrl);
    const source = new URL(base);
    if (!source.username) return { error: 'the fleet database URL carries no credentials to splice into the replica endpoint' };
    // Getters return the percent-encoded serialization; re-embed verbatim.
    const cred = `${source.username}${source.password ? `:${source.password}` : ''}@`;
    return { url: `postgresql://${cred}${replica.host}${replica.pathname}${replica.search}` };
  } catch (error) {
    return { error: `unparseable database URL (${error instanceof Error ? error.message : String(error)})` };
  }
}

/**
 * Reachability only (SELECT 1, not the term row): shared by the promote route
 * and the rung. A reachable virgin store is a deliberate first
 * promotion, and the boot provisions its own schema.
 */
export async function storeReachable(url: string): Promise<{ ok: boolean; error?: string }> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await client.end().catch(() => { /* best effort */ });
  }
}

/** The URL this node currently believes is the fleet's store. */
export function currentCanonicalUrl(): string {
  const creds = loadCredentials();
  return (creds.CONTROL_STORE_URL || '').trim() || (creds.DATA_BACKEND_URL || '').trim();
}

/** The fleet's current canonical store (the primary, until a pair promotion moves it). */
export function canonicalStoreReachable(): Promise<{ ok: boolean; error?: string }> {
  const url = currentCanonicalUrl();
  if (!url) return Promise.resolve({ ok: false, error: 'no CONTROL_STORE_URL/DATA_BACKEND_URL known yet (delivered on the first register)' });
  return storeReachable(url);
}

/** True when the fleet's canonical URL already names this machine's own database endpoint. */
function canonicalIsOwnReplica(endpoints: ReplicaEndpoints): boolean {
  try {
    const canonical = new URL(currentCanonicalUrl()).host;
    return canonical === new URL(endpoints.public).host || canonical === new URL(endpoints.local).host;
  } catch {
    return false;
  }
}

export interface ReplicaProbe {
  ok: boolean;
  /** False once promoted; a standby already out of recovery needs no pg_promote. */
  inRecovery?: boolean;
  /** Everything received has been applied (received-vs-replayed LSN equality). */
  applyComplete?: boolean;
  /** The WAL receiver is connected to the primary right now: the primary lives. */
  receiverStreaming?: boolean;
  /**
   * Age of the last replayed transaction. Once the primary is gone this grows
   * with wall time by definition (nothing left to replay), which is exactly
   * what makes it the RPO to show an operator promoting after a host death.
   */
  replayAgeMs?: number | null;
  error?: string;
}

const PROBE_SQL = `
  SELECT pg_is_in_recovery() AS in_recovery,
         pg_last_wal_receive_lsn() IS NOT DISTINCT FROM pg_last_wal_replay_lsn() AS apply_complete,
         EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) * 1000 AS replay_age_ms,
         (SELECT status FROM pg_stat_wal_receiver LIMIT 1) AS receiver_status`;

export async function probeReplica(splicedLocalUrl: string): Promise<ReplicaProbe> {
  const client = new Client({ connectionString: splicedLocalUrl, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  try {
    await client.connect();
    const row = (await client.query(PROBE_SQL)).rows[0] ?? {};
    return {
      ok: true,
      inRecovery: row.in_recovery === true,
      applyComplete: row.apply_complete !== false,
      receiverStreaming: String(row.receiver_status || '') === 'streaming',
      replayAgeMs: row.replay_age_ms === null || row.replay_age_ms === undefined ? null : Number(row.replay_age_ms),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await client.end().catch(() => { /* best effort */ });
  }
}

const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms).unref?.(); });

/**
 * Received WAL that is not applied yet drains in seconds. Waiting for it buys
 * an honest RPO reading for the dialog; it is never a refusal, because
 * pg_promote replays everything on disk before it ends recovery anyway, and a
 * standby whose primary is already gone can sit apply-incomplete forever (its
 * receive position is seeded at startup and then nothing arrives).
 */
export async function probeReplicaSettled(splicedLocalUrl: string): Promise<ReplicaProbe> {
  const deadline = Date.now() + REPLICA_CATCHUP_WAIT_MS;
  let probe = await probeReplica(splicedLocalUrl);
  while (probe.ok && probe.inRecovery === true && probe.applyComplete === false && Date.now() < deadline) {
    await sleep(REPLICA_CATCHUP_POLL_MS);
    probe = await probeReplica(splicedLocalUrl);
  }
  return probe;
}

/**
 * pg_promote(wait := true) and verify recovery actually ended. The fleet role
 * is the sidecar's bootstrap superuser (POSTGRES_USER), so no extra grant is
 * needed. A standby already out of recovery counts as promoted: a previous
 * attempt got this far and only the URL repoint remains.
 */
export async function promoteReplica(splicedLocalUrl: string): Promise<{ success: boolean; error?: string }> {
  const client = new Client({ connectionString: splicedLocalUrl, connectionTimeoutMillis: 5000, query_timeout: 90000 });
  try {
    await client.connect();
    const state = await client.query(`SELECT pg_is_in_recovery() AS in_recovery`);
    if (state.rows[0]?.in_recovery !== true) {
      console.warn('[Fleet] Local database replica is already out of recovery (earlier promotion attempt); continuing with the takeover');
      return { success: true };
    }
    const res = await client.query(`SELECT pg_promote(wait := true, wait_seconds := 60) AS promoted`);
    if (res.rows[0]?.promoted !== true) return { success: false, error: 'pg_promote timed out before recovery ended' };
    const verify = await client.query(`SELECT pg_is_in_recovery() AS in_recovery`);
    if (verify.rows[0]?.in_recovery === true) return { success: false, error: 'the replica still reports in-recovery after pg_promote' };
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await client.end().catch(() => { /* best effort */ });
  }
}

/**
 * Repoint this node's canonical store URLs at the promoted database and PROVE
 * the write took effect. On a node whose container environment pins
 * DATA_BACKEND_URL, /data/.env cannot override it (genuine compose env wins by
 * design) and the takeover would boot against the dead primary and park
 * forever. CONTROL_STORE_URL is repointed only when it was in use.
 */
export function persistPromotedUrls(splicedLocalUrl: string, splicedPublicUrl: string): { success: boolean; error?: string } {
  const hadControlUrl = (loadCredentials().CONTROL_STORE_URL || '').trim() !== '';
  // This node dials its own database by the LOCAL form (F1: the public form
  // cannot hairpin from beside the sidecar); the public form is recorded for
  // delivery to remote workers on their next register.
  const patch: Record<string, string> = {
    DATA_BACKEND_URL: splicedLocalUrl,
    DATA_BACKEND_LOCAL_URL: splicedLocalUrl,
    DATA_BACKEND_PUBLIC_URL: splicedPublicUrl,
  };
  if (hadControlUrl) patch.CONTROL_STORE_URL = splicedLocalUrl;
  const result = upsertCredentials(patch);
  if (!result.success) return { success: false, error: `could not persist the promoted database URL: ${result.error}` };
  const creds = loadCredentials();
  const effective = (creds.DATA_BACKEND_URL || '').trim();
  const controlEffective = (creds.CONTROL_STORE_URL || '').trim();
  if (effective !== splicedLocalUrl || (hadControlUrl && controlEffective !== splicedLocalUrl)) {
    return { success: false, error: 'the fleet database URL is pinned by this container environment, so the promoted database cannot take effect; REMOVE DATA_BACKEND_URL (and CONTROL_STORE_URL, if set) from the instance env editor so the node-local data/.env takes effect, then promote again' };
  }
  return { success: true };
}

export interface PairPromotionResult {
  success: boolean;
  error?: string;
  /** False when the fleet database was alive and only the role moved. */
  promotedDatabase?: boolean;
  /** Manual lane: the operator must acknowledge the measured RPO and retry. */
  needsLagConfirm?: boolean;
  /** Age of the last replayed transaction (the RPO), when known. */
  lagMs?: number | null;
}

/**
 * The replica rung, called by the promote route. It decides whether this promotion
 * needs the database at all (see the table at the top of this file) and, when
 * it does, makes the standby the fleet's store before the role moves.
 *
 * `masterAlive` is the control channel's verdict and is required, not inferred:
 * the route knows it from live fleet state.
 * `confirmLag` is the operator's acknowledgement of the measured RPO (R3).
 */
export async function promoteReplicaPair(
  endpoints: ReplicaEndpoints,
  opts: { confirmLag?: boolean; masterAlive: boolean },
): Promise<PairPromotionResult> {
  const local = spliceFleetCredentials(endpoints.local);
  if (!local.url) return { success: false, error: local.error };
  const publicSpliced = spliceFleetCredentials(endpoints.public);
  if (!publicSpliced.url) return { success: false, error: publicSpliced.error };

  const probe = await probeReplicaSettled(local.url);
  if (!probe.ok) {
    // Every row above except the last takes the role without touching the
    // database, so a standby this node cannot reach only blocks the one row
    // that needed it. A stopped or mid-reseed sidecar must not veto a takeover.
    const canonicalNow = await canonicalStoreReachable();
    if (canonicalNow.ok) {
      console.warn(`[Fleet] The local database standby is unreachable (${probe.error}) but the fleet database is live; taking the master role only. Have the manager re-provision the standby.`);
      return { success: true, promotedDatabase: false };
    }
    return { success: false, error: `neither this machine's database standby (${probe.error}) nor the fleet database (${canonicalNow.error}) can be reached from this node, so there is nothing to take over. Start the standby from the manager, or restore the fleet database, then promote.` };
  }

  // Retry of a half-finished pair promotion: the database is already ours, so
  // all that is left is the repoint the previous attempt did not reach. The
  // liveness test below cannot judge this case (an out-of-recovery database
  // has no WAL receiver), so guard it here instead: a fleet still running on
  // SOMEONE ELSE'S live database must not be told to follow this one.
  if (probe.inRecovery === false) {
    const canonicalNow = await canonicalStoreReachable();
    if ((canonicalNow.ok || opts.masterAlive) && !canonicalIsOwnReplica(endpoints)) {
      return {
        success: false,
        error: 'this machine\'s database has already left standby mode, but the fleet is still running on another one; pointing the fleet at this database would split it. Re-seed this machine as a standby, or stop the old master and its database first.',
      };
    }
    const persisted = persistPromotedUrls(local.url!, publicSpliced.url!);
    return persisted.success
      ? { success: true, promotedDatabase: true, lagMs: probe.replayAgeMs ?? null }
      : { success: false, error: persisted.error };
  }

  const canonical = await canonicalStoreReachable();
  if (probe.receiverStreaming === true || canonical.ok) {
    if (!canonical.ok) {
      return {
        success: false,
        error: 'the fleet database is alive (this machine\'s standby is still streaming from it) but this node cannot reach it; promoting would split the fleet across two databases. Restore connectivity, or stop the old master and its database, then promote.',
      };
    }
    // The store is shared and live: the ordinary takeover fences the old
    // master through the term row. Touching the database here would break
    // exactly that fence.
    if (probe.receiverStreaming !== true) {
      console.warn('[Fleet] Replication link is DOWN but the fleet database is reachable; taking the master role only. The standby is not following - have the manager re-seed it.');
    }
    return { success: true, promotedDatabase: false };
  }

  // Both database channels are dark. They share one route, so that alone only
  // proves the primary's DATABASE is unreachable from here; the master may
  // still be serving on the C1 write-acceptance window with its own store
  // intact, and promoting under it is the unfenceable fork.
  if (opts.masterAlive) {
    return {
      success: false,
      error: 'the fleet database cannot be reached from this node, but the master\'s control connection is still up, so the master is alive and coasting. Promoting this standby would split the fleet into two masters that can never fence each other. Restore the database connection, or stop the old master and its database, then promote.',
    };
  }

  // Nothing answers on any channel: this is the host-death failover.
  const lagMs = probe.replayAgeMs ?? null;
  if (lagMs !== null && lagMs > REPLICA_LAG_PROMOTE_MAX_MS && opts.confirmLag !== true) {
    return {
      success: false,
      needsLagConfirm: true,
      lagMs,
      error: `the standby last replayed a transaction ${Math.round(lagMs / 1000)}s ago; promoting it accepts losing anything the old primary took after that`,
    };
  }
  // The published endpoint cannot be PROVEN from here: this node sits beside
  // the standby sidecar, exactly the vantage where the public form cannot
  // hairpin (F1), and after promotion this node dials the LOCAL form anyway.
  // A dead public endpoint only delays REMOTE workers (they retry until it
  // opens), so it warns instead of vetoing the host-death failover.
  const reachable = await storeReachable(publicSpliced.url);
  if (!reachable.ok) {
    console.warn(`[Fleet] The standby's published endpoint did not answer from this node (${reachable.error}); remote workers cannot follow this database until that host port is reachable for them. Proceeding - this vantage cannot prove the public endpoint either way (NAT hairpin).`);
  }

  // Last look before the point of no return: the operator may have spent the
  // confirm dialogs deciding while the old machine rebooted, and a primary
  // that came back must not be forked.
  const canonicalAgain = await canonicalStoreReachable();
  if (canonicalAgain.ok) {
    return { success: false, lagMs, error: 'the fleet database answered again just before the promotion; it is alive after all, so promoting this standby would split the fleet. Promote again to take the master role on it.' };
  }

  console.warn(`[Fleet] PAIR PROMOTION: the primary is gone on both channels; promoting the local standby (last replay ${lagMs === null ? 'unknown' : Math.round(lagMs / 1000) + 's ago'})`);
  const promoted = await promoteReplica(local.url);
  if (!promoted.success) return { success: false, error: `promoting the local database replica failed: ${promoted.error}`, lagMs };
  const persisted = persistPromotedUrls(local.url!, publicSpliced.url!);
  if (!persisted.success) return { success: false, error: persisted.error, lagMs };
  console.warn('[Fleet] Pair promotion complete: the local database is out of recovery and is now this fleet\'s canonical store');
  return { success: true, promotedDatabase: true, lagMs };
}
