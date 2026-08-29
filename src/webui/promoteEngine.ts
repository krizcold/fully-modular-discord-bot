// Unified promote engine (PLAN_REPLICATION 20.4, B4): ONE user action makes
// this instance the master side, bot and database together. Runs in the
// webui parent because only the parent can tell a container-pinned database
// URL from the node-local one and only the parent restarts the child.
//
// Verdict (the Section 11 liveness table, plus the witness):
//   old database reachable                     -> TRANSFER: claim the term on
//     it (the old master fences itself), fence it read-only at a known write
//     position, catch the local standby up to that position, promote the
//     standby, restart as master. Zero loss.
//   old database dark, master alive (control   -> refuse: a coasting master
//     channel or a fresh beacon)                   cannot be fenced; forking
//                                                  would split the fleet.
//   everything dark                            -> FAILOVER: promote the standby
//     where replication reached, behind the RPO confirm, restart as master
//     with the takeover chain.
//
// Phases persist in the promote record so a parent restart resumes them;
// failures park at the recorded phase and Continue re-enters it.

import { Client } from 'pg';
import type { BotManager } from './botManager';
import {
  PROMOTE_CATCHUP_POLL_MS,
  PROMOTE_CATCHUP_TIMEOUT_MS,
  PROMOTE_SQL_TIMEOUT_MS,
  REPLICA_LAG_PROMOTE_MAX_MS,
} from '../bot/internalSetup/fleet/constants';
import { isContainerPinned, loadCredentials } from '../utils/envLoader';
import { getNodeId, writeRoleOverride } from '../bot/internalSetup/fleet/nodeIdentity';
import { PromoteRecord, clearPromoteRecord, readPromoteRecord, writePromoteRecord } from '../bot/internalSetup/fleet/promoteRecord';
import {
  ReplicaEndpoints,
  canonicalIsOwnReplica,
  canonicalStoreReachable,
  currentCanonicalUrl,
  persistPromotedUrls,
  probeReplica,
  probeReplicaSettled,
  promoteReplica,
  resolveReplicaEndpoints,
  spliceFleetCredentials,
} from '../bot/internalSetup/fleet/replicaPromotion';
import { clearSuperseded, freshMasterClaim, masterStoreDeadNow } from '../bot/internalSetup/fleet/stepDown';

export interface PromoteStartOptions {
  confirmLag?: boolean;
  retireOldMaster?: boolean;
  /** Provenance for the role override this promote ends up writing. */
  startedBy?: 'webui-promote' | 'manager-promote';
}

export interface PromoteStartResult {
  success: boolean;
  error?: string;
  needsLagConfirm?: boolean;
  lagMs?: number | null;
  record?: PromoteRecord;
}

let phasesRunning = false;

async function withClient<T>(url: string, fn: (client: Client) => Promise<T>, queryTimeoutMs = PROMOTE_SQL_TIMEOUT_MS): Promise<T> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000, query_timeout: queryTimeoutMs });
  try {
    await client.connect();
    return await fn(client);
  } finally {
    await client.end().catch(() => { /* best effort */ });
  }
}

const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms).unref?.(); });

/**
 * The cluster a database belongs to. A streaming standby is a byte copy of its
 * primary and carries the SAME identifier, so this is what proves the copy this
 * node is about to promote really descends from the database it is about to
 * fence. Store ids cannot: a promoted copy keeps the store id of its source.
 */
async function systemIdentifier(url: string): Promise<string | null> {
  try {
    return await withClient(url, async client => {
      const res = await client.query(`SELECT system_identifier::text AS id FROM pg_control_system()`);
      const id = res.rows[0]?.id;
      return typeof id === 'string' && id !== '' ? id : null;
    });
  } catch {
    return null;
  }
}

function splicedEndpoints(endpoints: ReplicaEndpoints): { local: string; public: string } | { error: string } {
  const local = spliceFleetCredentials(endpoints.local);
  if (!local.url) return { error: local.error ?? 'unusable standby endpoint' };
  const publicSpliced = spliceFleetCredentials(endpoints.public);
  if (!publicSpliced.url) return { error: publicSpliced.error ?? 'unusable standby endpoint' };
  return { local: local.url, public: publicSpliced.url };
}

/**
 * Verdict + record creation. Everything that can refuse does so here, before
 * anything irreversible; the phases run in the background afterwards and the
 * UI follows the record through GET /state.
 */
export async function startPromote(botManager: BotManager, opts: PromoteStartOptions): Promise<PromoteStartResult> {
  const existing = readPromoteRecord();
  if (existing && existing.phase !== 'done' && !existing.parked) {
    return { success: false, error: `a promote is already running (phase ${existing.phase}); wait for it to finish` };
  }
  if (phasesRunning) return { success: false, error: 'a promote is already running; wait for it to finish' };
  if (!botManager.isRunning()) return { success: false, error: 'Bot is not running; start it before promoting' };
  const stateResult = await botManager.getFleetState();
  const state: any = stateResult?.success ? stateResult.state : null;
  if (!state || !state.initialized) return { success: false, error: 'Fleet state unavailable (bot still initializing); try again shortly' };

  const refusal = state.role !== 'co-worker' ? 'this node is already a master'
    : state.backupMaster !== true ? 'this node is not the designated backup master (set BOT_NODE_ROLE=backup-master)'
    : state.dataBackend !== 'postgres' ? 'promotion is a postgres-mode feature (file mode has no standby)'
    : state.draining === true ? 'this node is draining; promotion refused'
    : state.migrationWorkActive === true ? 'a migration/transformation is working on this node; wait for it to finish'
    : null;
  if (refusal) return { success: false, error: refusal };

  const endpoints = resolveReplicaEndpoints();
  if (!endpoints) {
    return { success: false, error: 'this instance holds no database standby to promote; seed one first (the manager provisions it from the copy block, or provision it by hand), then promote' };
  }
  const spliced = splicedEndpoints(endpoints);
  if ('error' in spliced) return { success: false, error: spliced.error };

  // Checked HERE, before anything irreversible: the promoted database is
  // adopted by writing /data/.env, which a container-pinned URL silently
  // outranks. Discovering that after the old primary is fenced and the copy
  // promoted would leave the fleet with no writable store at all.
  const pinned = ['DATA_BACKEND_URL', 'DATA_BACKEND_LOCAL_URL', 'DATA_BACKEND_PUBLIC_URL']
    .concat((loadCredentials().CONTROL_STORE_URL || '').trim() !== '' ? ['CONTROL_STORE_URL'] : [])
    .filter(isContainerPinned);
  if (pinned.length > 0) {
    return { success: false, error: `the fleet database URL is pinned by this container environment (${pinned.join(', ')}), so a promoted database could never take effect here. Remove ${pinned.join(' and ')} from this instance's env editor so the node-local data/.env takes effect, then promote.` };
  }

  const probe = await probeReplicaSettled(spliced.local);
  if (!probe.ok) return { success: false, error: `the local database standby is unreachable (${probe.error}); start it, then promote` };
  const canonical = await canonicalStoreReachable();
  // With the fleet database dark, the witness is the only thing that can tell a
  // dead master from an unreachable one, and the c3 unlock turns on a fact that
  // flips within seconds. Ask for a reading NOW rather than judging on the
  // loop's cached snapshot; the cache remains the fallback when the child
  // cannot answer.
  let witnessStatus = state.witness ?? null;
  if (!canonical.ok) {
    const fresh = await botManager.readFleetWitness();
    if (fresh?.success && fresh.witness) witnessStatus = fresh.witness;
    else console.warn('[Fleet] Promote has no fresh witness reading (this node runs no witness, or the read failed); judging on the last cached one, which the freshness windows will reject if it is old');
  }
  const masterAlive = state.masterKnown === true
    || (witnessStatus ? freshMasterClaim(witnessStatus, state.nodeId, Date.now()) !== null : false);
  const lagMs = probe.replayAgeMs ?? null;

  let mode: PromoteRecord['mode'];
  let firstPhase: PromoteRecord['phase'];
  let expectedTerm: number | null = null;
  let expectedHolder: string | null = null;
  if (probe.inRecovery === false) {
    // Retry of an interrupted promote: the database is already ours, so the
    // rest is the repoint and the restart. Never point a fleet that is still
    // running on ANOTHER live database at this one.
    if ((canonical.ok || masterAlive) && !canonicalIsOwnReplica(endpoints)) {
      return { success: false, error: 'this machine\'s database has already left standby mode, but the fleet is still running on another one; pointing the fleet at this database would split it. Re-seed this machine as a standby, or stop the old master and its database first.' };
    }
    mode = 'failover';
    firstPhase = 'promote';
  } else if (canonical.ok) {
    if (probe.receiverStreaming !== true) {
      return { success: false, error: 'the fleet database is reachable but this standby is not following it, so a transfer could not catch up; re-seed the standby from the manager, then promote' };
    }
    // Lineage: the database about to be fenced and the copy about to be
    // promoted must be one cluster. Without this the promote can fence an
    // unrelated instance (a leftover CONTROL_STORE_URL is enough), leaving the
    // real primary writable while the fleet is repointed at a copy of it.
    const canonicalUrl = currentCanonicalUrl();
    const [primaryId, standbyId] = await Promise.all([systemIdentifier(canonicalUrl), systemIdentifier(spliced.local)]);
    if (!primaryId || !standbyId) {
      return { success: false, error: 'could not read the cluster identity of the fleet database and this machine\'s copy, so a transfer cannot prove they are the same database; check both endpoints and retry' };
    }
    if (primaryId !== standbyId) {
      return { success: false, error: `this machine's database copy does not descend from the fleet database this node points at (cluster ${standbyId} vs ${primaryId}); re-seed this machine as a standby of the current master, or correct CONTROL_STORE_URL/DATA_BACKEND_URL, then promote` };
    }
    // The baseline the claim refuses to stack on. A read that FAILS is not the
    // same as "no row": proceeding would silently disable that race guard, so
    // it refuses instead.
    let readFailed = false;
    const row = await withClient(canonicalUrl, async client => {
      const res = await client.query(`SELECT term, node_id FROM smdb_control.term WHERE id = 1`);
      return res.rows.length > 0 ? { term: Number(res.rows[0].term), nodeId: String(res.rows[0].node_id) } : null;
    }).catch(() => { readFailed = true; return null; });
    if (readFailed) {
      return { success: false, error: 'the fleet database answered but its term row could not be read, so this promote cannot tell a racing takeover from a quiet fleet; retry once the database is responsive' };
    }
    expectedTerm = row?.term ?? null;
    expectedHolder = row?.nodeId ?? null;
    mode = 'transfer';
    firstPhase = 'claim';
  } else {
    // A live master whose OWN beacon reports its store unreachable is 20.12's
    // c3: the fleet database really is gone, not merely unreachable from here,
    // and only the master could tell the difference. It cannot be fenced and
    // it cannot fence anyone, so the RPO path is correct and the old master
    // steps down on this node's higher-term beacon.
    const now = Date.now();
    const masterBeacon = witnessStatus ? freshMasterClaim(witnessStatus, state.nodeId, now) : null;
    const masterStoreDead = witnessStatus ? masterStoreDeadNow(masterBeacon, witnessStatus, now) : false;
    if (masterAlive && !masterStoreDead) {
      return { success: false, error: 'the fleet database cannot be reached from this node, but the master is still alive (its control connection is up or its witness beacon is fresh) and reports its own database healthy, so it is coasting on a database this node cannot fence. Promoting would split the fleet into two masters. Restore the database connection, or stop the old master and its database, then promote.' };
    }
    // The c3 branch carries a second risk the replay age never shows: the old
    // master's bot is still up, so if its database came back in the seconds
    // since its last beacon it is writing to a copy this promote abandons.
    const aliveWarning = masterStoreDead
      ? ' The old master\'s bot is still running and reported its own database dead; if that database has recovered since its last beacon, anything it accepted meanwhile stays behind on it.'
      : '';
    if (opts.confirmLag !== true && (masterStoreDead || (lagMs !== null && lagMs > REPLICA_LAG_PROMOTE_MAX_MS))) {
      return {
        success: false,
        needsLagConfirm: true,
        lagMs,
        error: `${lagMs === null ? 'this machine\'s copy has replayed nothing since it started' : `the standby last replayed a transaction ${Math.round(lagMs / 1000)}s ago`}; promoting it accepts losing anything the old primary took after that.${aliveWarning}`,
      };
    }
    mode = 'failover';
    firstPhase = 'promote';
  }

  // The death path never reaches the old master's database, so the node it
  // supersedes is read from the REPLICATED copy this machine already holds:
  // without it the old master would never be told it was superseded, and the
  // owner's retire instruction would have nothing to travel on.
  if (mode === 'failover' && expectedHolder === null) {
    expectedHolder = await withClient(spliced.local, async client => {
      const res = await client.query(`SELECT node_id FROM smdb_control.term WHERE id = 1`);
      const holder = res.rows[0]?.node_id;
      return typeof holder === 'string' && holder !== getNodeId() ? holder : null;
    }).catch(() => null);
  }

  clearSuperseded();
  const record: PromoteRecord = {
    phase: firstPhase,
    mode,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    parked: false,
    lastError: null,
    startedBy: opts.startedBy === 'manager-promote' ? 'manager-promote' : 'webui-promote',
    retireOldMaster: opts.retireOldMaster === true,
    supersededNodeId: expectedHolder,
    supersededTerm: expectedTerm,
    supersededDelivered: false,
    expectedTerm,
    expectedHolder,
    claimedTerm: null,
    fencedLsn: null,
    lagMs,
  };
  writePromoteRecord(record);
  console.warn(`[Fleet] PROMOTE started (${mode}): phase ${firstPhase}${record.retireOldMaster ? ', old master to be retired' : ''}`);
  void runPhases(botManager, record, spliced);
  return { success: true, record };
}

/** Re-enter a parked record at its recorded phase. */
export async function continuePromote(botManager: BotManager): Promise<{ success: boolean; error?: string; record?: PromoteRecord }> {
  const record = readPromoteRecord();
  if (!record) return { success: false, error: 'no promote to continue' };
  if (record.phase === 'done') return { success: false, error: 'the last promote already finished' };
  if (!record.parked) return { success: false, error: `the promote is running (phase ${record.phase})` };
  if (phasesRunning) return { success: false, error: 'a promote is already running' };
  const endpoints = resolveReplicaEndpoints();
  if (!endpoints) return { success: false, error: 'this instance no longer reports a database standby' };
  const spliced = splicedEndpoints(endpoints);
  if ('error' in spliced) return { success: false, error: spliced.error };
  record.parked = false;
  record.lastError = null;
  writePromoteRecord(record);
  void runPhases(botManager, record, spliced);
  return { success: true, record };
}

/**
 * Cancel is possible only while nothing irreversible happened: a parked claim
 * (the CAS either landed or it did not; parked means it did not) or a finished
 * record being cleared. Past the claim the old master is already deposed and
 * the only safe direction is forward.
 */
export function cancelPromote(): { success: boolean; error?: string } {
  const record = readPromoteRecord();
  if (!record) return { success: false, error: 'no promote to cancel' };
  // A parked claim never landed (the phase advances only on success), so it is
  // the one point where nothing has happened yet. Past it the record is the
  // only carrier of the superseded and retire facts and the role override is
  // staged, so dismissing it would strand both: Continue is the way forward.
  if (record.phase === 'done' || (record.parked && record.phase === 'claim')) {
    clearPromoteRecord();
    return { success: true };
  }
  return { success: false, error: `the promote is past the point of cancellation (phase ${record.phase}); Continue it instead` };
}

/** Parent boot: a promote interrupted by a restart resumes at its recorded phase. */
export async function resumePromote(botManager: BotManager): Promise<void> {
  const record = readPromoteRecord();
  if (!record || record.phase === 'done' || record.parked) return;
  const endpoints = resolveReplicaEndpoints();
  if (!endpoints) return;
  const spliced = splicedEndpoints(endpoints);
  if ('error' in spliced) return;
  console.warn(`[Fleet] Resuming the interrupted promote at phase ${record.phase}`);
  void runPhases(botManager, record, spliced);
}

async function runPhases(botManager: BotManager, record: PromoteRecord, spliced: { local: string; public: string }): Promise<void> {
  if (phasesRunning) return;
  phasesRunning = true;
  const save = (): void => writePromoteRecord(record);
  try {
    while (record.phase !== 'done') {
      try {
        switch (record.phase) {
          case 'verdict':
          case 'claim':
            await phaseClaim(record);
            record.phase = 'fence';
            break;
          case 'fence':
            await phaseFence(record);
            record.phase = 'catchup';
            break;
          case 'catchup':
            await phaseCatchup(record, spliced.local);
            record.phase = 'promote';
            break;
          case 'promote':
            await phasePromote(spliced);
            record.phase = 'restart';
            break;
          case 'restart':
            // 'done' only after the restart actually took: parking at 'done'
            // would leave a record Continue refuses to re-enter. The superseded
            // fact is keyed on the node id, not the phase, so the record does
            // not need to be finished for the new master to deliver it.
            await phaseRestart(botManager, record);
            record.phase = 'done';
            break;
        }
        save();
      } catch (error) {
        record.parked = true;
        record.lastError = error instanceof Error ? error.message : String(error);
        save();
        console.error(`[Fleet] PROMOTE parked at phase ${record.phase}: ${record.lastError}`);
        return;
      }
    }
    console.warn(`[Fleet] PROMOTE complete (${record.mode}): this node restarts as master`);
  } finally {
    phasesRunning = false;
  }
}

/**
 * Claim the term on the OLD master's database while it is still the single
 * store: its next liveness stamp fails and it steps down. The row is locked and
 * checked against what the verdict saw, so a second promote racing this one
 * parks instead of stacking a second claim nothing can distinguish.
 */
async function phaseClaim(record: PromoteRecord): Promise<void> {
  const url = currentCanonicalUrl();
  if (!url) throw new Error('no fleet database URL is known on this node');
  const nodeId = getNodeId();
  await withClient(url, async client => {
    // Read outside the transaction: a missing data schema (a separate control
    // instance) raises, and an aborted transaction cannot be continued.
    let floor = 0;
    try {
      const f = await client.query(`SELECT COALESCE(MAX(term), 0) AS floor FROM smdb_data.guild_ownership`);
      floor = Number(f.rows[0]?.floor) || 0;
    } catch { /* separate control instance: no data schema beside it */ }
    await client.query('BEGIN');
    try {
      const row = await client.query(`SELECT term, node_id FROM smdb_control.term WHERE id = 1 FOR UPDATE`);
      const holder = row.rows.length > 0 ? String(row.rows[0].node_id) : null;
      const observed = row.rows.length > 0 ? Number(row.rows[0].term) : null;
      // This node already holding the row is THIS promote's own claim landing
      // twice (the parent died between the commit and the record write), not a
      // rival: continue instead of parking on a claim that already succeeded.
      const alreadyOurs = holder === nodeId;
      if (!alreadyOurs && record.expectedTerm !== null && (observed !== record.expectedTerm || holder !== record.expectedHolder)) {
        throw new Error(`the term row moved since this promote was decided (now term ${observed ?? 'none'} held by ${holder ? holder.slice(0, 8) : 'nobody'}, expected term ${record.expectedTerm} held by ${record.expectedHolder?.slice(0, 8) ?? 'nobody'}); another takeover is in flight, so this one stops here`);
      }
      if (!alreadyOurs) {
        record.supersededNodeId = holder;
        record.supersededTerm = observed;
      }
      const next = Math.max(observed ?? 0, floor) + 1;
      if (observed === null) {
        await client.query(`INSERT INTO smdb_control.term (id, term, node_id, updated_at) VALUES (1, $1, $2, $3)`, [next, nodeId, Date.now()]);
      } else {
        await client.query(`UPDATE smdb_control.term SET term = $1, node_id = $2, updated_at = $3 WHERE id = 1`, [next, nodeId, Date.now()]);
      }
      await client.query('COMMIT');
      record.claimedTerm = next;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => { /* connection is closing anyway */ });
      throw error;
    }
  });
  console.warn(`[Fleet] PROMOTE claim: term ${record.claimedTerm} taken on the old master's database (held by ${record.supersededNodeId?.slice(0, 8) ?? 'nobody'} at term ${record.supersededTerm ?? 0})`);
}

/**
 * Fence the old database read-only at a known write position. Replication is
 * untouched (walsenders are not client backends), so the standby can reach
 * exactly this position; every later client write is refused loudly instead
 * of silently lost.
 */
async function phaseFence(record: PromoteRecord): Promise<void> {
  const url = currentCanonicalUrl();
  if (!url) throw new Error('no fleet database URL is known on this node');
  await withClient(url, async client => {
    await client.query(`ALTER SYSTEM SET default_transaction_read_only = on`);
    await client.query(`SELECT pg_reload_conf()`);
    await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'`,
    );
    const lsn = await client.query(`SELECT pg_current_wal_lsn()::text AS lsn`);
    record.fencedLsn = String(lsn.rows[0]?.lsn ?? '');
  });
  if (!record.fencedLsn) throw new Error('could not read the fenced write position');
  console.warn(`[Fleet] PROMOTE fence: old database read-only at ${record.fencedLsn}`);
}

/** Wait for the local standby to replay up to the fenced position. */
async function phaseCatchup(record: PromoteRecord, localUrl: string): Promise<void> {
  if (!record.fencedLsn) throw new Error('no fenced write position recorded');
  const deadline = Date.now() + PROMOTE_CATCHUP_TIMEOUT_MS;
  for (;;) {
    const behind = await withClient(localUrl, async client => {
      const state = await client.query(`SELECT pg_is_in_recovery() AS in_recovery`);
      if (state.rows[0]?.in_recovery !== true) return 0;
      const res = await client.query(`SELECT pg_wal_lsn_diff($1::pg_lsn, pg_last_wal_replay_lsn()) AS behind`, [record.fencedLsn]);
      return Number(res.rows[0]?.behind ?? 0);
    });
    if (behind <= 0) break;
    if (Date.now() >= deadline) throw new Error(`the standby is still ${behind} bytes behind the fenced position after ${Math.round(PROMOTE_CATCHUP_TIMEOUT_MS / 1000)}s; check replication, then Continue`);
    await sleep(PROMOTE_CATCHUP_POLL_MS);
  }
  console.warn('[Fleet] PROMOTE catch-up: the standby holds everything the old database took');
}

async function phasePromote(spliced: { local: string; public: string }): Promise<void> {
  const promoted = await promoteReplica(spliced.local);
  if (!promoted.success) throw new Error(`promoting the local database replica failed: ${promoted.error}`);
  const persisted = persistPromotedUrls(spliced.local, spliced.public);
  if (!persisted.success) throw new Error(persisted.error ?? 'could not persist the promoted database URL');
  const verify = await probeReplica(spliced.local);
  // A probe that could not run proves nothing; restarting the fleet onto a
  // database this node cannot confirm left recovery is not a risk worth taking.
  if (!verify.ok || verify.inRecovery === true) {
    throw new Error(`could not confirm the promoted database left recovery (${verify.ok ? 'it still reports in-recovery' : verify.error}); Continue once it answers`);
  }
  console.warn('[Fleet] PROMOTE database: the local copy is out of recovery and is now this fleet\'s store');
}

async function phaseRestart(botManager: BotManager, record: PromoteRecord): Promise<void> {
  writeRoleOverride({
    role: 'master',
    takeover: true,
    ...(record.mode === 'failover' ? { chainTakeover: true } : {}),
    setAt: Date.now(),
    setBy: record.startedBy,
  });
  for (let attempt = 0; ; attempt++) {
    const restart = await botManager.restart();
    if (restart.success) return;
    if (restart.reason !== 'operation_in_progress' || attempt >= 5) {
      throw new Error(restart.error ?? 'restart failed; the role override is staged and the next start boots as master');
    }
    await sleep(5000);
  }
}
