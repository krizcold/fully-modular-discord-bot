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
import { getNodeId, invalidateRoleOverrideCache, readRoleOverride, writeRoleOverride } from '../bot/internalSetup/fleet/nodeIdentity';
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
import { StandInWriteRequest, clearSuperseded, freshMasterClaim, masterStoreDeadNow } from '../bot/internalSetup/fleet/stepDown';
import { readArmRecord, writeArmRecord } from '../bot/internalSetup/fleet/armRecord';
import { backupsAhead, readSlotStatus, sourceMatchesAny } from '../bot/internalSetup/fleet/slotStatus';
import { watchForSyncWaitCancel } from '../bot/internalSetup/utils/syncWaitCancel';

export interface PromoteStartOptions {
  confirmLag?: boolean;
  /** The operator has seen that another designated backup received further than this copy (20.19 F14). */
  confirmLineage?: boolean;
  retireOldMaster?: boolean;
  /** Provenance for the role override this promote ends up writing. */
  startedBy?: 'webui-promote' | 'manager-promote';
}

export interface PromoteStartResult {
  success: boolean;
  error?: string;
  needsLagConfirm?: boolean;
  needsLineageConfirm?: boolean;
  /** Bytes of WAL the furthest other backup holds beyond this copy; 0 when level and outranked, null when this copy has no position at all. */
  aheadBy?: number | null;
  lagMs?: number | null;
  record?: PromoteRecord;
}

let phasesRunning = false;

async function withClient<T>(url: string, fn: (client: Client) => Promise<T>, queryTimeoutMs = PROMOTE_SQL_TIMEOUT_MS): Promise<T> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000, query_timeout: queryTimeoutMs });
  // This connection writes the term row, and the fence it runs terminates
  // every other client backend on the old primary, which is what turns a
  // waiting commit into an acknowledged one (B6 map F24).
  watchForSyncWaitCancel(client, 'the promote connection');
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

  // A SERVING stand-in may be promoted by hand: it is one of F9's two ruled
  // exits, and the only way a stand-in ever becomes the true master (20.5).
  const servingStandIn = state.role === 'master' && state.standIn?.live === true;
  const refusal = state.role !== 'co-worker' && !servingStandIn ? 'this node is already a master'
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
  // A serving stand-in reports masterKnown for ITSELF (it runs the master path),
  // which must not read as "the master is alive": the witness half still
  // catches a returning master's fresh beacon.
  const masterAlive = (state.masterKnown === true && !servingStandIn)
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
    // The copy must follow the database about to be fenced. A standby of a
    // FORMER primary shares its cluster identity (byte copies do), so the
    // identity check below cannot tell them apart; only its source can.
    if (probe.sourceHost) {
      const creds = loadCredentials();
      const stores = [currentCanonicalUrl(), creds.DATA_BACKEND_URL, creds.DATA_BACKEND_PUBLIC_URL, creds.DATA_BACKEND_LOCAL_URL]
        .map(url => (url || '').trim())
        .filter(url => url !== '');
      if (!sourceMatchesAny({ sourceHost: probe.sourceHost, sourcePort: probe.sourcePort ?? null }, stores)) {
        return { success: false, error: `this machine's copy follows ${probe.sourceHost}:${probe.sourcePort ?? 5432}, which is not the fleet database this node points at; re-seed this standby from the current master, then promote` };
      }
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
      // A STALLED master needs the opposite remedy from a healthy one, and
      // saying "healthy" would point the operator at stopping a database that
      // holds the newest committed writes (B6 map F20).
      return masterBeacon?.storeState === 'stalled'
        ? { success: false, error: 'the fleet database cannot be reached from this node, and the master reports its writes STALLED waiting on a synchronous standby that left. Its database is alive and holds the newest committed writes, so promoting this copy would lose them and split the fleet into two masters. Restore or release that standby and the master frees itself within seconds; stopping the master database is the one thing not to do here.' }
        : { success: false, error: 'the fleet database cannot be reached from this node, but the master is still alive (its control connection is up or its witness beacon is fresh) and reports its own database healthy, so it is coasting on a database this node cannot fence. Promoting would split the fleet into two masters. Restore the database connection, or stop the old master and its database, then promote.' };
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
    // Lineage (20.9 "freshest lineage wins; priority breaks ties", 20.19 F14):
    // the last slot table the master pushed before it died is the final word on
    // how far each standby received. A copy that is behind another backup's can
    // still be promoted, but never unknowingly: what that one holds beyond this
    // point is what promoting here abandons.
    if (opts.confirmLineage !== true) {
      const designations: { nodeId: string; priority: number }[] = state.fleetConfig?.backupDesignations ?? [];
      const priorityOf = (id: string): number => designations.find(d => d.nodeId === id)?.priority ?? Number.MAX_SAFE_INTEGER;
      const ahead = backupsAhead(readSlotStatus(), priorityOf(state.nodeId), priorityOf);
      if (ahead.length > 0) {
        const first = ahead[0];
        const who = `backup ${first.nodeId.slice(0, 8)}`;
        const how = first.bytesAhead === null
          ? 'still holds a replication position on the primary while this copy holds none (its slot was invalidated, or it never attached), so there is no reading in which this copy is the fresher one'
          : first.bytesAhead > 0
            ? `is ahead of this copy by ${first.bytesAhead} bytes of WAL`
            : 'received exactly as far as this copy and ranks above it in the backup order';
        return {
          success: false,
          needsLineageConfirm: true,
          aheadBy: first.bytesAhead,
          error: `${who} ${how}, as of the last slot table the master pushed before it went quiet; promoting here makes THIS copy the fleet database and abandons whatever that one received beyond it.`,
        };
      }
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

/**
 * The stand-in lane's write step (20.5, B6 map F2), run HERE because the bot
 * child asked for it and cannot run it itself: inside a forked child every set
 * key reads container-pinned, so the one refusal that matters most (a pinned
 * URL means the promoted copy could never take effect) is only decidable in
 * the parent. Every refusal is written back into the arm record, which is how
 * the child learns the answer and how the Fleet tab says why.
 */
export async function startStandInWrites(botManager: BotManager, req: StandInWriteRequest): Promise<void> {
  const refuse = (reason: string): void => {
    const arm = readArmRecord();
    if (arm && arm.phase === 'promoting') {
      writeArmRecord({ ...arm, phase: 'serving', writeRequestedAt: null, writeRefusal: reason, writeRefusedAt: Date.now() });
    }
    console.error(`[Fleet] Stand-in NOT taking writes: ${reason}`);
  };
  const existing = readPromoteRecord();
  if (existing && existing.phase !== 'done') {
    // Parked included, whatever its mode: a parked record is an operator's
    // unfinished act (its claimed term, fence position and retire request
    // live nowhere else), and the only two ways out of it are theirs.
    return refuse(existing.parked
      ? `a promote is parked at phase ${existing.phase} (${existing.lastError ?? 'no error recorded'}); Continue or Cancel it from the Fleet tab`
      : `a promote is already running (phase ${existing.phase})`);
  }
  if (phasesRunning) return refuse('a promote is already running');
  if (!botManager.isRunning()) return refuse('the bot is not running');
  const arm = readArmRecord();
  if (!arm || arm.phase !== 'promoting' || arm.coveringNodeId !== req.coveringNodeId) {
    return refuse('the arm record shows no pending request to take writes');
  }
  const endpoints = resolveReplicaEndpoints();
  if (!endpoints) return refuse('this instance holds no database standby to promote');
  const spliced = splicedEndpoints(endpoints);
  if ('error' in spliced) return refuse(spliced.error);
  const pinned = ['DATA_BACKEND_URL', 'DATA_BACKEND_LOCAL_URL', 'DATA_BACKEND_PUBLIC_URL']
    .concat((loadCredentials().CONTROL_STORE_URL || '').trim() !== '' ? ['CONTROL_STORE_URL'] : [])
    .filter(isContainerPinned);
  if (pinned.length > 0) {
    return refuse(`the fleet database URL is pinned by this container environment (${pinned.join(', ')}), so a promoted copy could never take effect here; remove ${pinned.join(' and ')} from this instance's env editor, then promote by hand`);
  }
  const probe = await probeReplicaSettled(spliced.local);
  if (!probe.ok) return refuse(`the local database standby is unreachable (${probe.error})`);

  const record: PromoteRecord = {
    phase: 'promote',
    mode: 'stand-in',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    parked: false,
    lastError: null,
    startedBy: 'stand-in',
    retireOldMaster: false,
    supersededNodeId: req.coveringNodeId,
    supersededTerm: req.inheritedTerm,
    supersededDelivered: false,
    expectedTerm: null,
    expectedHolder: null,
    claimedTerm: null,
    fencedLsn: null,
    lagMs: probe.replayAgeMs ?? null,
  };
  writePromoteRecord(record);
  console.warn(`[Fleet] STAND-IN WRITE STEP started for ${req.coveringNodeId.slice(0, 8)} (held to ${req.heldToLsn ?? 'unknown'}): promoting this machine's copy`);
  void runPhases(botManager, record, spliced);
}

/** The stand-in lane still wants the writes: its record has asked for them or already holds them. */
function standInLaneLive(): boolean {
  const arm = readArmRecord();
  return !!arm && (arm.phase === 'promoting' || arm.phase === 'promoted');
}

/** Why the lane is not live, for a refusal an operator reads. */
function describeStandInLane(): string {
  const arm = readArmRecord();
  if (!arm) return 'its record is gone';
  if (arm.phase === 'disarmed') return arm.disarmReason ?? 'it was disarmed';
  return `its record now reads ${arm.phase}`;
}

/** Re-enter a parked record at its recorded phase. */
export async function continuePromote(botManager: BotManager): Promise<{ success: boolean; error?: string; record?: PromoteRecord }> {
  const record = readPromoteRecord();
  if (!record) return { success: false, error: 'no promote to continue' };
  if (record.phase === 'done') return { success: false, error: 'the last promote already finished' };
  if (!record.parked) return { success: false, error: `the promote is running (phase ${record.phase})` };
  if (phasesRunning) return { success: false, error: 'a promote is already running' };
  // Checked BEFORE the phases run, because the promote phase's first act is
  // pg_promote: a guard in the restart phase alone would let a Continue on a
  // demoted or stepped-down stand-in take its copy out of recovery and only
  // then park again.
  if (record.mode === 'stand-in' && !standInLaneLive()) {
    return { success: false, error: `the stand-in lane no longer asks for the writes (${describeStandInLane()}), so this write step cannot continue; Cancel it, and re-seed this machine as a standby if its copy has left recovery` };
  }
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
export async function cancelPromote(): Promise<{ success: boolean; error?: string }> {
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
  // A parked stand-in write step carries nothing the record alone must keep:
  // the override is written by its restart phase and the covered master rides
  // the arm record. Dismissing it hands the lane back its refusal spacing, and
  // manual promote stays open.
  if (record.mode === 'stand-in' && record.parked) {
    // Allowed while the copy is still a standby, or once the lane has ENDED
    // (the stand-in stepped down or was disarmed: the copy's fate is then the
    // manager's re-seed or adopt, and the record has nothing left to stage).
    // Refused in between: promoteReplica runs FIRST in its phase, so a park
    // after it has already taken the irreversible step, and dismissing it
    // would hide that from the lane and the operator alike. An unreadable copy
    // is not a yes.
    // Read as disarmed, never merely unreadable: an absent record is not a yes.
    const laneEnded = readArmRecord()?.phase === 'disarmed';
    const endpoints = resolveReplicaEndpoints();
    const spliced = endpoints ? splicedEndpoints(endpoints) : { error: 'no standby endpoint' };
    const copy = 'error' in spliced ? null : await probeReplica(spliced.local);
    // Re-read after the probe, on both branches: a Continue clicked meanwhile
    // has restarted the phases, and clearing under them would only be undone
    // by their next save.
    const again = readPromoteRecord();
    if (phasesRunning || !again || !again.parked || again.startedAt !== record.startedAt) {
      return { success: false, error: 'the promote changed while the cancel was being checked; look at its current phase and retry' };
    }
    if (laneEnded) {
      // The asymmetry with the branch below is deliberate: with the lane still
      // serving, Continue is the exit and cancel must not hide a promoted copy;
      // with the lane ended, Continue can never succeed (its restart phase
      // refuses a disarmed lane), so cancel IS the exit, and the copy's fate
      // is the manager's adopt-or-re-seed verdict. Said out loud, because this
      // record was the only thing saying the copy may have been promoted.
      console.error(`[Fleet] STAND-IN WRITE STEP dismissed after the lane ended (parked at phase ${record.phase}: ${record.lastError ?? 'no error recorded'}); this machine's copy ${copy && copy.ok ? (copy.inRecovery === false ? 'HAS LEFT RECOVERY and may hold the fleet database URL' : 'is still a standby') : 'could not be read'}; the manager's replica verdict decides its fate`);
    } else if (!copy || !copy.ok || copy.inRecovery !== true) {
      return { success: false, error: `this machine's copy ${copy && copy.ok ? 'has already left recovery' : 'cannot be read right now'}; Continue the write step so the fleet's database URL is persisted, or re-seed this machine as a standby` };
    }
    const arm = readArmRecord();
    if (arm && arm.phase === 'promoting') {
      writeArmRecord({ ...arm, phase: 'serving', writeRequestedAt: null, writeRefusal: 'the write step was cancelled by the operator', writeRefusedAt: Date.now() });
    }
    clearPromoteRecord();
    return { success: true };
  }
  return { success: false, error: `the promote is past the point of cancellation (phase ${record.phase}); Continue it instead` };
}

/** Parent boot: a promote interrupted by a restart resumes at its recorded phase. */
export async function resumePromote(botManager: BotManager): Promise<void> {
  const record = readPromoteRecord();
  if (!record || record.phase === 'done' || record.parked) return;
  if (record.mode === 'stand-in') {
    // The evidence this step was decided on is as old as the parent's outage,
    // and the lane's own state is the only fresh fact. If the child has since
    // disarmed (its boot fence found the master alive) or the override no
    // longer says stand-in, promoting now would take a copy nobody serves
    // from out of recovery. Parked, not run: the operator decides.
    invalidateRoleOverrideCache();
    const arm = readArmRecord();
    const override = readRoleOverride();
    if (!arm || (arm.phase !== 'promoting' && arm.phase !== 'promoted') || override?.standIn !== true) {
      record.parked = true;
      record.lastError = `the parent restarted mid-step and the stand-in lane has since changed state (record ${arm?.phase ?? 'absent'}, override ${override?.standIn === true ? 'stand-in' : override?.role ?? 'none'}); Continue only if this node should still take the writes`;
      writePromoteRecord(record);
      console.error(`[Fleet] STAND-IN WRITE STEP parked at resume: ${record.lastError}`);
      return;
    }
    // The restart phase had already done its work when the parent died in it:
    // the override is staged, the record says promoted, and this parent's own
    // start forked the child onto the writes path. Restarting again would only
    // cost the fleet a second outage and a second term.
    if (record.phase === 'restart' && arm.phase === 'promoted') {
      record.phase = 'done';
      writePromoteRecord(record);
      console.warn('[Fleet] STAND-IN WRITE STEP complete: the restart it was interrupted in has already taken');
      return;
    }
  }
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
            // The same guard as continuePromote, for the resume path and for a
            // lane that ends while an earlier phase of this run is executing.
            if (record.mode === 'stand-in' && !standInLaneLive()) {
              throw new Error(`the stand-in lane stopped asking for the writes before the copy was promoted (${describeStandInLane()}); Cancel this step`);
            }
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
  if (record.mode === 'stand-in') {
    // The lane can have changed state while the copy was promoted (the child
    // steps down on a fresh higher term at any time). The copy is already out
    // of recovery, so this is not undone here: it parks with the facts and
    // the operator decides.
    const arm = readArmRecord();
    if (!arm || (arm.phase !== 'promoting' && arm.phase !== 'promoted')) {
      throw new Error(`the stand-in lane changed state while the copy was being promoted (its record is now ${arm ? arm.phase : 'absent'}); the copy has left recovery, so decide by hand: Cancel this step and re-seed this machine as a standby, or promote this node by hand to serve from the copy`);
    }
    // Still a stand-in (20.5: the backup KEEPS its identity), so no takeover
    // and no chain: the boot runs the full fence and mints one term above the
    // inherited one, and it never Declares Lost the master it covers (F8).
    writeRoleOverride({ role: 'master', standIn: true, setAt: Date.now(), setBy: 'stand-in' });
    writeArmRecord({ ...arm, phase: 'promoted', promotedAt: arm.promotedAt ?? Date.now(), writeRequestedAt: null, writeGate: null });
  } else {
    // A manual promote from a serving stand-in makes it the TRUE master for
    // good (20.5): the stand-in identity ends here, and its record says so,
    // written once the restart below has succeeded, so a promote parked at
    // its restart leaves the record still saying what the copy holds (the
    // manager reads the ended lane from it). Over an ALREADY disarmed record
    // too: a lane that ended earlier (a demote, a step-down) leaves a record
    // that says the copy may hold writes nothing else has, and this promote
    // is what makes them the fleet's for good.
    writeRoleOverride({
      role: 'master',
      takeover: true,
      ...(record.mode === 'failover' ? { chainTakeover: true } : {}),
      setAt: Date.now(),
      setBy: record.startedBy,
    });
  }
  for (let attempt = 0; ; attempt++) {
    const restart = await botManager.restart();
    if (restart.success) {
      if (record.mode !== 'stand-in') {
        // Only a lane that is live, or that ended holding the writes, is
        // ended BY this promote; an old record that never took writes keeps
        // its own reason, or the tab would blame this promote for it.
        const arm = readArmRecord();
        if (arm && arm.phase !== 'claimed' && (arm.phase !== 'disarmed' || arm.promotedAt !== null)) {
          writeArmRecord({ ...arm, phase: 'disarmed', disarmedAt: Date.now(), disarmReason: 'promoted by hand into the true master' });
        }
      }
      return;
    }
    if (restart.reason !== 'operation_in_progress' || attempt >= 5) {
      throw new Error(restart.error ?? 'restart failed; the role override is staged and the next start boots as master');
    }
    await sleep(5000);
  }
}
