// Standby primitives for the unified promote (PLAN_REPLICATION 20.4): endpoint
// resolution, credential splice, the settled probe, pg_promote and the URL
// persist. The verdict and the phases live in the webui parent's
// promoteEngine; this file only knows how to ask and tell the database.
//
// PARENT PROCESS ONLY. The webui parent owns the promote lane because it owns
// /data/.env precedence: a URL the container environment pins cannot be
// overridden from the file, and the parent is the process whose
// loadCredentials() can tell the two apart.

import { Client } from 'pg';
import { loadCredentials, upsertCredentials } from '../../../utils/envLoader';
import { REPLICA_CATCHUP_POLL_MS, REPLICA_CATCHUP_WAIT_MS } from './constants';

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
export function canonicalIsOwnReplica(endpoints: ReplicaEndpoints): boolean {
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
