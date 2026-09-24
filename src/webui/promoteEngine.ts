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
  CONTROL_PORT_DEFAULT,
  PROMOTE_SQL_TIMEOUT_MS,
  REPLICA_LAG_PROMOTE_MAX_MS,
} from '../bot/internalSetup/fleet/constants';
import { isContainerPinned, loadCredentials } from '../utils/envLoader';
import { clearRoleOverride, getNodeId, getNodeName, invalidateRoleOverrideCache, readRoleOverride, writeRoleOverride } from '../bot/internalSetup/fleet/nodeIdentity';
import { promoteReachabilityWarning } from '../bot/internalSetup/fleet/armLane';
import { fleetMasterCandidates } from '../bot/internalSetup/fleet/fleetConfig';
import { judgeReachability } from '../bot/internalSetup/fleet/reachability';
import { PromoteRecord, clearPromoteRecord, readPromoteRecord, writePromoteRecord } from '../bot/internalSetup/fleet/promoteRecord';
import { HolderSighting, readHolderSighting } from '../bot/internalSetup/fleet/holderSighting';
import {
  ReplicaEndpoints,
  canonicalIsOwnReplica,
  currentCanonicalUrl,
  persistPromotedUrls,
  probeReplica,
  probeReplicaSettled,
  promoteReplica,
  readTermRow,
  resolveReplicaEndpoints,
  spliceFleetCredentials,
  storeReachable,
  stripUrlCredentials,
} from '../bot/internalSetup/fleet/replicaPromotion';
import { StandInWriteRequest, clearSuperseded, freshMasterClaim, masterStoreDeadNow } from '../bot/internalSetup/fleet/stepDown';
import { readArmRecord, writeArmRecord } from '../bot/internalSetup/fleet/armRecord';
import { closeStandInEpisodeOrWarn, failbackEpisode, promoteClosesEpisode, readEpisodeRecord, recallLineageVerdict, writeEpisodeRecordOrWarn } from '../bot/internalSetup/fleet/episodeRecord';
import { backupsAhead, readSlotStatus, sourceMatchesAny } from '../bot/internalSetup/fleet/slotStatus';
import { watchForSyncWaitCancel } from '../bot/internalSetup/utils/syncWaitCancel';

export interface PromoteStartOptions {
  confirmLag?: boolean;
  /** The operator has seen that another designated backup received further than this copy (20.19 F14). */
  confirmLineage?: boolean;
  /** The operator has seen that no other instance can connect to this node as master (B7-F18). */
  confirmReachability?: boolean;
  retireOldMaster?: boolean;
  /** Provenance for the role override this promote ends up writing. */
  startedBy?: 'webui-promote' | 'manager-promote';
}

export interface PromoteStartResult {
  success: boolean;
  error?: string;
  needsLagConfirm?: boolean;
  needsLineageConfirm?: boolean;
  needsReachabilityConfirm?: boolean;
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

function splicedEndpoints(endpoints: ReplicaEndpoints, base?: string): { local: string; public: string } | { error: string } {
  const local = spliceFleetCredentials(endpoints.local, base);
  if (!local.url) return { error: local.error ?? 'unusable standby endpoint' };
  const publicSpliced = spliceFleetCredentials(endpoints.public, base);
  if (!publicSpliced.url) return { error: publicSpliced.error ?? 'unusable standby endpoint' };
  return { local: local.url, public: publicSpliced.url };
}

/**
 * The database a returning master's promote fences and claims (B6 map F28):
 * the one it follows, read WITH credentials from the child that installed it,
 * because the hold persists nothing and the manager's re-seed may have
 * retired every URL the node owned. Null while the child is not serving from
 * a verified delivered database.
 */
async function readFollowed(botManager: BotManager): Promise<{ url: string; forms: string[] } | null> {
  const res = await botManager.readFollowedBackend();
  const followed = res?.success ? res.followed : null;
  if (!followed || typeof followed.url !== 'string' || followed.url === '') return null;
  return { url: followed.url, forms: Array.isArray(followed.forms) ? followed.forms.filter((f: unknown): f is string => typeof f === 'string') : [] };
}

type HoldForms = { following: string | null; followingForms: string[] };

/**
 * The child's fleet state as far as the promote gates need it (B6 map F28):
 * null when the child is not running or did not answer, which is UNKNOWN and
 * never read as "no hold".
 */
async function readChildState(botManager: BotManager): Promise<{ initialized: boolean; hold: HoldForms | null; park: { at: number; peerUrl: string; observedTerm: number } | null } | null> {
  if (!botManager.isRunning()) return null;
  const res = await botManager.getFleetState().catch(() => null);
  if (!res?.success || !res.state) return null;
  const hold = res.state.followerHold;
  const park = res.state.staleMasterPark;
  return {
    initialized: res.state.initialized === true,
    hold: hold ? { following: typeof hold.following === 'string' ? hold.following : null, followingForms: Array.isArray(hold.followingForms) ? hold.followingForms.filter((f: unknown): f is string => typeof f === 'string') : [] } : null,
    // A boot parked on a live holder: a foreign node answered at or above this
    // node's term at `at`, which is evidence against any record decided before.
    park: park && Number.isFinite(park.at) ? { at: Number(park.at), peerUrl: String(park.peerUrl ?? ''), observedTerm: Number(park.observedTerm) || 0 } : null,
  };
}

/**
 * False only on evidence: a record decided on this node's OWN database (it
 * names no followed endpoint) predates any hold; one naming a database other
 * than the ones the hold delivered is foreign. A hold that has delivered
 * nothing yet is no evidence either way and is not judged.
 */
function recordOfHold(record: PromoteRecord, hold: HoldForms): boolean {
  if (record.canonicalEndpoint === null) return false;
  const forms = [hold.following, ...hold.followingForms].filter((f): f is string => f !== null);
  return forms.length === 0 || forms.includes(record.canonicalEndpoint);
}

/**
 * Another node has held the fleet since this promote was decided (B6 map F28):
 * the record's restart phase would boot this node as master past the fence
 * onto a fleet somebody else holds. Read from the sighting the child persists,
 * so it outlives the hold, a demote, a re-designation and a step-down, and
 * needs no running child.
 */
export function promoteSupersededBy(record: PromoteRecord): HolderSighting | null {
  if (record.mode === 'stand-in' || record.phase === 'done') return null;
  const seen = readHolderSighting();
  return seen && seen.nodeId !== getNodeId() && seen.seenAt >= record.startedAt ? seen : null;
}

/**
 * 20.12 c3, carried to the restart: the master a failover supersedes while
 * its bot is alive and its database dead keeps answering the boot fence at
 * the term its dead store froze on, and this node's higher beacon is what
 * steps it down. A stand-in that took writes is such a master too (its
 * standby's failover is decided the same way); the fence re-proves the fact
 * on that node's own fresh beacon before letting it answer.
 */
export function c3SupersededPeer(masterAlive: boolean, masterStoreDead: boolean, masterBeacon: { nodeId: string } | null): string | null {
  return masterAlive && masterStoreDead && masterBeacon ? masterBeacon.nodeId : null;
}

/** A phase is running a promote in this parent; an unparked record no phase owns is an orphan of a parent restart. */
export function promoteInFlight(): boolean {
  return phasesRunning;
}

const supersededText = (seen: HolderSighting): string =>
  `node ${seen.nodeId.slice(0, 8)} has held the fleet at term ${seen.term} since this promote was decided (seen ${new Date(seen.seenAt).toISOString()}, via ${seen.via})`;

/**
 * Dismisses a record the fleet has moved past. What its restart phase staged
 * goes with it: a takeover override written at or after its start (phaseRestart
 * is that shape's only writer) would boot this node as master past the fence
 * on the next start, with the record that said so gone.
 */
function dismissSupersededRecord(record: PromoteRecord): void {
  invalidateRoleOverrideCache();
  const staged = readRoleOverride();
  if (staged?.takeover === true && staged.setAt >= record.startedAt) {
    clearRoleOverride();
    console.warn('[Fleet] PROMOTE dismissed: the takeover override its restart phase staged is cleared, so the next start boots this node in its configured role (a master through the fence, a designated backup as a co-worker)');
  }
  if (record.phase === 'promote' || record.phase === 'restart') {
    console.error(`[Fleet] PROMOTE dismissed past its promote phase (${record.mode}, ${record.parked ? 'parked' : 'stopped'} at ${record.phase}: ${record.lastError ?? 'no error recorded'}); this machine's copy may have left recovery and /data/.env may already name it; the manager's replica verdict decides its fate`);
  }
  if (record.claimedTerm !== null || record.fencedLsn) {
    console.error(`[Fleet] PROMOTE dismissed past its claim (${record.mode}, ${record.parked ? 'parked' : 'stopped'} at ${record.phase}: ${record.lastError ?? 'no error recorded'}); its claimed term${record.claimedTerm !== null ? ` ${record.claimedTerm}` : ''} and fence position${record.fencedLsn ? ` ${record.fencedLsn}` : ''} go with it, for a database the lane left read-only; the fleet is on the node that superseded it`);
  }
  clearPromoteRecord();
}

/** The URL a phase fences and claims: the followed database when the record names one, else this node's own canonical URL. */
async function canonicalForRecord(botManager: BotManager, record: PromoteRecord): Promise<string> {
  if (!record.canonicalEndpoint) return currentCanonicalUrl();
  const followed = await readFollowed(botManager);
  if (followed && stripUrlCredentials(followed.url) === record.canonicalEndpoint) return followed.url;
  // Past the claim the node no longer follows that database (the claim
  // deposed it), and its own credentials, persisted at the claim, open it:
  // one lineage.
  const own = spliceFleetCredentials(record.canonicalEndpoint).url;
  if (own) return own;
  throw new Error(`this node is not following the database this promote was decided on (${record.canonicalEndpoint}) and holds no credentials of its own yet; Continue once the Fleet tab shows it following, or Cancel`);
}

/**
 * Verdict + record creation. Everything that can refuse does so here, before
 * anything irreversible; the phases run in the background afterwards and the
 * UI follows the record through GET /state.
 */
export async function startPromote(botManager: BotManager, opts: PromoteStartOptions): Promise<PromoteStartResult> {
  const existing = readPromoteRecord();
  // Liveness is the engine's (see continuePromote): an unparked record no
  // phase owns may be replaced like a parked one.
  const existingIdle = !!existing && (existing.parked || !phasesRunning);
  if (existing && existing.phase !== 'done' && !existingIdle) {
    return { success: false, error: `a promote is already running (phase ${existing.phase}); wait for it to finish` };
  }
  if (phasesRunning) return { success: false, error: 'a promote is already running; wait for it to finish' };
  // A record the fleet has moved past is dismissed before anything is decided
  // over it: Cancel clears it and the takeover its restart phase may have
  // staged, where a fresh verdict over the same copy would take the
  // already-promoted shortcut below onto a fleet another node holds.
  if (existing && existing.phase !== 'done') {
    const seen = promoteSupersededBy(existing);
    if (seen) return { success: false, error: `${supersededText(seen)}; Cancel that promote first from this instance's Fleet tab (${existing.phase === 'restart' ? 'it dismisses the record and clears the takeover its restart phase staged' : existing.claimedTerm !== null || existing.fencedLsn ? 'it dismisses the record, discarding this lane\'s claimed term and fence position for a database it left read-only' : 'it dismisses the record'}), then decide again on what is reachable now` };
  }
  if (!botManager.isRunning()) return { success: false, error: 'Bot is not running; start it before promoting' };
  const stateResult = await botManager.getFleetState();
  const state: any = stateResult?.success ? stateResult.state : null;
  if (!state || !state.initialized) return { success: false, error: 'Fleet state unavailable (bot still initializing); try again shortly' };

  // A SERVING stand-in may be promoted by hand: it is one of F9's two ruled
  // exits, and the only way a stand-in ever becomes the true master (20.5).
  const servingStandIn = state.role === 'master' && state.standIn?.live === true;
  // A returning master holding behind its stand-in is eligible by what it IS
  // (B6 map D8, F28): the node it follows says it stands in for THIS node, so
  // this node's database is the one behind the fleet's. No env designation
  // is asked for; once that node stops naming it (promoted by hand, or the
  // lane ended) there is no failback to run and the plain gate applies.
  const hold = state.followerHold ?? null;
  const returningMaster = hold?.namesThisNode === true;
  const refusal = state.role !== 'co-worker' && !servingStandIn ? 'this node is already a master'
    : state.backupMaster !== true && !returningMaster ? (
      hold && hold.namesThisNode === null ? 'this node is the fleet\'s master by configuration and holds behind the node that took the fleet while it was down, but it is not registered with that node yet, so the failback cannot start; wait for the registration, or demote this node to stay a co-worker'
      : hold ? 'this node is the fleet\'s master by configuration, but the node it follows no longer stands in for it (it was promoted by hand, or the lane ended), so there is no failback to run; demote this node to stay a co-worker, or set BOT_NODE_ROLE=backup-master to make it a designated backup'
      : 'this node is not the designated backup master (set BOT_NODE_ROLE=backup-master)')
    : state.dataBackend !== 'postgres' ? 'promotion is a postgres-mode feature (file mode has no standby)'
    : state.draining === true ? 'this node is draining; promotion refused'
    : state.migrationWorkActive === true ? 'a migration/transformation is working on this node; wait for it to finish'
    : null;
  if (refusal) return { success: false, error: refusal };

  // The fleet database this promote fences and claims, and the credentials
  // the local copy takes. A returning master's own URL names ITS database,
  // the copy that is behind, or nothing at all once the manager retired the
  // primary's pins; the fleet's is the one it follows.
  const followed = returningMaster ? await readFollowed(botManager) : null;
  if (returningMaster && !followed) {
    return { success: false, error: 'the database the node this one follows delivered is not installed here yet (not dialable from this machine, or its identity did not verify), so the failback cannot fence it; the Fleet tab\'s hold notice says which' };
  }
  const endpoints = resolveReplicaEndpoints();
  if (!endpoints) {
    return { success: false, error: 'this instance holds no database standby to promote; seed one first (the manager provisions it from the copy block, or provision it by hand), then promote' };
  }
  const spliced = splicedEndpoints(endpoints, followed?.url);
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
  const canonicalEndpoint = followed ? stripUrlCredentials(followed.url) : null;
  const canonicalUrl = followed ? followed.url : currentCanonicalUrl();
  const canonical = canonicalUrl ? await storeReachable(canonicalUrl) : { ok: false, error: 'no CONTROL_STORE_URL/DATA_BACKEND_URL known yet (delivered on the first register)' };
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
  let supersededStoreDead: string | null = null;
  if (probe.inRecovery === false) {
    // Retry of an interrupted promote: the database is already ours, so the
    // rest is the repoint and the restart. Never point a fleet that is still
    // running on ANOTHER live database at this one: a master that is alive is
    // that by itself (the interrupted promote's own master is dead or deposed,
    // and this node's canonical URL already names this copy once the promote
    // phase persisted it, so the URL alone cannot tell the two apart).
    if (masterAlive || (canonical.ok && !canonicalIsOwnReplica(endpoints, canonicalUrl))) {
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
      // A returning master's own forms name the database that is BEHIND, so
      // they are not the fleet's; the forms the stand-in delivered are, and
      // the copy may follow either of them.
      const stores = followed ? [canonicalUrl, ...followed.forms] : [canonicalUrl, creds.DATA_BACKEND_URL, creds.DATA_BACKEND_PUBLIC_URL, creds.DATA_BACKEND_LOCAL_URL]
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
    // A returning master's own standby copies the database that is BEHIND
    // (20.19 F7 puts one beside its primary): promoting it would seize the
    // fleet onto pre-outage data with no refusal. The copy must follow the
    // database the node it follows delivered, as the transfer branch demands.
    if (followed && probe.sourceHost && !sourceMatchesAny({ sourceHost: probe.sourceHost, sourcePort: probe.sourcePort ?? null }, [canonicalUrl, ...followed.forms])) {
      return { success: false, error: `this machine's copy follows ${probe.sourceHost}:${probe.sourcePort ?? 5432}, which is not the fleet database this node follows, so the failback cannot promote it. If the node holding the fleet is gone for good, FLEET_CONFIRM_TAKEOVER=1 on this node plus a restart seizes the fleet back onto this node's own database, losing what that node accepted during the outage` };
    }
    // A live master whose OWN beacon reports its store unreachable is 20.12's
    // c3: the fleet database really is gone, not merely unreachable from here,
    // and only the master could tell the difference. It cannot be fenced and
    // it cannot fence anyone, so the RPO path is correct and the old master
    // steps down on this node's higher-term beacon.
    const now = Date.now();
    const masterBeacon = witnessStatus ? freshMasterClaim(witnessStatus, state.nodeId, now) : null;
    const masterStoreDead = witnessStatus ? masterStoreDeadNow(masterBeacon, witnessStatus, now) : false;
    supersededStoreDead = c3SupersededPeer(masterAlive, masterStoreDead, masterBeacon);
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
    // An unmeasured age is not a small one: a copy that replayed nothing
    // since it started has an RPO nobody measured, which 20.4 says the
    // operator confirms (the refusal below already words that case).
    if (opts.confirmLag !== true && (masterStoreDead || lagMs === null || lagMs > REPLICA_LAG_PROMOTE_MAX_MS)) {
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

  // Asked last, once nothing refuses. The configured master reclaiming its
  // own role is exempt: it is what the operator set up to be dialed, and its
  // failback runs unattended.
  if (!returningMaster && opts.confirmReachability !== true) {
    const publicUrl = process.env.FLEET_PUBLIC_URL || '';
    const candidates = fleetMasterCandidates();
    const reach = await judgeReachability(publicUrl, candidates, Number(process.env.CONTROL_PORT) || CONTROL_PORT_DEFAULT);
    const warning = promoteReachabilityWarning(reach, publicUrl, candidates);
    if (warning) return { success: false, needsReachabilityConfirm: true, error: warning };
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

  // A node with no database of its own (the manager's re-seed retired every
  // pin) takes the copy's credentials the moment the failback is decided:
  // nothing is overwritten, and every later phase, resume and cancel can then
  // reach the copy without the follow the lane may end.
  if (followed && currentCanonicalUrl() === '') {
    const persisted = persistPromotedUrls(spliced.local, spliced.public);
    if (!persisted.success) return { success: false, error: persisted.error ?? 'could not persist the copy\'s URL' };
  }
  // Only a transfer record can hold a landed claim (a failover starts at
  // 'promote'; the write step's record is written there too).
  const priorClaim = existing && existingIdle && existing.mode === 'transfer' && existing.phase !== 'done' ? existing : null;
  // A transfer re-decided over its OWN landed claim resumes that lane rather
  // than resetting it: the old database is already claimed (and, past the
  // fence, read-only), so a fresh claim on it can only fail, and the fence
  // position the catch-up needs lives nowhere but in the parked record.
  const resume = mode === 'transfer' && expectedHolder === getNodeId() && priorClaim && priorClaim.claimedTerm !== null && priorClaim.canonicalEndpoint === canonicalEndpoint ? priorClaim : null;
  // The gate above was read before every await of this verdict; a Continue
  // clicked meanwhile has started the parked lane, and writing over its record
  // would be undone by its next save while this run silently did nothing.
  const still = readPromoteRecord();
  if (phasesRunning || (still && still.phase !== 'done' && (still.parked !== existing?.parked || still.updatedAt !== existing?.updatedAt))) {
    return { success: false, error: 'a promote is already running or was restarted while this one was being decided; look at its current phase and retry' };
  }
  clearSuperseded();
  const record: PromoteRecord = {
    phase: resume ? resume.phase : firstPhase,
    mode,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    parked: false,
    lastError: null,
    startedBy: opts.startedBy === 'manager-promote' ? 'manager-promote' : 'webui-promote',
    retireOldMaster: opts.retireOldMaster === true,
    // A term row that already names this node is this node's OWN landed claim
    // (the record parked past it, or its acknowledgement was lost), not a
    // holder to supersede: the parked record carries the real one.
    supersededNodeId: expectedHolder && expectedHolder !== getNodeId() ? expectedHolder : priorClaim?.supersededNodeId ?? null,
    supersededTerm: expectedHolder && expectedHolder !== getNodeId() ? expectedTerm : priorClaim?.supersededTerm ?? null,
    supersededDelivered: resume ? resume.supersededDelivered : false,
    expectedTerm,
    expectedHolder,
    supersededStoreDead,
    claimedTerm: resume?.claimedTerm ?? null,
    fencedLsn: resume?.fencedLsn ?? null,
    lagMs,
    canonicalEndpoint,
    lineageVerdict: hold?.lineage?.verdict ?? null,
    holdSince: hold ? (readHolderSighting()?.firstSeenAt ?? hold.since) : null,
    promotedCopy: probe.inRecovery === false,
  };
  // The behind hold's verdict was judged in the process before the re-seed (B6-j).
  if (record.lineageVerdict === null) record.lineageVerdict = recallLineageVerdict(record.supersededNodeId, record.holdSince);
  writePromoteRecord(record);
  console.warn(`[Fleet] PROMOTE started (${mode}): ${resume ? 'resumed at' : 'phase'} ${record.phase}${record.retireOldMaster ? ', old master to be retired' : ''}`);
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
    // A stand-in supersedes nobody (20.5, F8: a partial takeover): the covered
    // master registering here for the failback must not be told to retire.
    supersededNodeId: null,
    supersededTerm: null,
    supersededDelivered: false,
    expectedTerm: null,
    expectedHolder: null,
    supersededStoreDead: null,
    claimedTerm: null,
    fencedLsn: null,
    lagMs: probe.replayAgeMs ?? null,
    canonicalEndpoint: null,
    lineageVerdict: null,
    holdSince: null,
    promotedCopy: false,
  };
  writePromoteRecord(record);
  console.warn(`[Fleet] STAND-IN WRITE STEP started for ${req.coveringNodeId.slice(0, 8)} (held to ${req.heldToLsn ?? 'unknown'}): promoting this machine's copy`);
  void runPhases(botManager, record, spliced);
}

const PROMOTED_BY_HAND = 'promoted by hand into the true master';

/**
 * The stand-in lane a takeover promote ends (B6-j), from the restart and from
 * the resume that finds the restart already taken. Only a lane that is live,
 * or that ended holding the writes, is ended BY this promote; an old record
 * that never took writes keeps its own reason, or the tab would blame this
 * promote for it. The arm record's reason is written first and either way:
 * the manager recognises this exit by it. Whether the lane's episode closes
 * is the episode module's rule, and its write never fails the promote.
 */
function closeTakeoverLane(record: PromoteRecord): void {
  if (record.mode === 'stand-in') return;
  const arm = readArmRecord();
  if (!arm || arm.phase === 'claimed' || (arm.phase === 'disarmed' && arm.promotedAt === null)) return;
  writeArmRecord({ ...arm, phase: 'disarmed', disarmedAt: Date.now(), disarmReason: PROMOTED_BY_HAND });
  if (promoteClosesEpisode(arm.phase, record, readEpisodeRecord(), getNodeId())) {
    closeStandInEpisodeOrWarn(arm, getNodeId(), getNodeName(), null, 'promoted-for-good', PROMOTED_BY_HAND);
  }
}

/** A returning master's failback that finished (B6-j): the outcome is the episode module's verdict on the record. */
function noteFailbackDone(record: PromoteRecord): void {
  const episode = failbackEpisode(record, readHolderSighting(), getNodeId(), getNodeName());
  if (episode) writeEpisodeRecordOrWarn(episode);
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
  // Liveness is the engine's, not the record's: an unparked record no phase
  // owns (a parent restart in safe mode, a resume that could not start) is
  // continued like a parked one.
  if (phasesRunning) return { success: false, error: record.parked ? 'a promote is already running' : `the promote is running (phase ${record.phase})` };
  // Checked BEFORE the phases run, because the promote phase's first act is
  // pg_promote: a guard in the restart phase alone would let a Continue on a
  // demoted or stepped-down stand-in take its copy out of recovery and only
  // then park again.
  if (record.mode === 'stand-in' && !standInLaneLive()) {
    return { success: false, error: `the stand-in lane no longer asks for the writes (${describeStandInLane()}), so this write step cannot continue; Cancel it, and re-seed this machine as a standby if its copy has left recovery` };
  }
  // A record from before the hold this node is in names no database the node
  // follows; its restart phase would write a takeover override and boot this
  // node as master on its own stale database, past the fence.
  // An unreadable or still-initializing child is unknown, never "no hold":
  // the restart phase stages a takeover override that boots this node as
  // master past the fence, so the phases run only on a child that answered.
  if (record.mode !== 'stand-in') {
    const seen = promoteSupersededBy(record);
    if (seen) {
      return { success: false, error: `${supersededText(seen)}, so continuing it would restart this node as master past the fence onto a fleet that node holds; Cancel it, and Promote again on what is reachable now` };
    }
    const child = await readChildState(botManager);
    if (child?.park && child.park.at >= record.startedAt) {
      return { success: false, error: `the boot is parked on a live holder (${child.park.peerUrl} answers at term ${child.park.observedTerm}) since this promote was decided, and the park is terminal: its takeover restart is what the fence parks. Cancel this promote (it dismisses the record and clears any takeover it staged) and demote this node from the Fleet tab; to seize the fleet deliberately instead, leave this promote on record and set FLEET_CONFIRM_TAKEOVER=1 plus a restart (the override it staged is what puts this node on the master path where that confirm is read)` };
    }
    if (!child || !child.initialized) {
      return { success: false, error: `the bot is not running or still initializing, so this node's fleet state cannot be read; start it and let it initialize, then Continue (${record.phase === 'restart' ? 'a takeover override this promote staged boots the node as master by itself' : 'the gates that protect the takeover restart need its fleet state'})` };
    }
    if (child.hold && !recordOfHold(record, child.hold)) {
      return { success: false, error: 'this promote predates the follower hold this node is in (it names no database the node follows), so continuing it would restart this node as master on its own stale database; Cancel it, and use Promote on the Returning master card for the failback' };
    }
  }
  const endpoints = resolveReplicaEndpoints();
  if (!endpoints) return { success: false, error: 'this instance no longer reports a database standby' };
  const base = record.canonicalEndpoint ? (await readFollowed(botManager))?.url : undefined;
  const spliced = splicedEndpoints(endpoints, base);
  if ('error' in spliced) {
    return { success: false, error: record.canonicalEndpoint ? 'this node is not following the database this promote was decided on and holds no credentials of its own yet; Continue once the Fleet tab shows it following' : spliced.error };
  }
  // Re-read after the awaits above, as every cancel branch does: a Cancel that
  // cleared the record meanwhile, or a Promote that replaced it, must not be
  // undone by writing this snapshot back and running its phases.
  const moved = readPromoteRecord();
  if (phasesRunning || !moved || moved.parked !== record.parked || moved.startedAt !== record.startedAt || moved.updatedAt !== record.updatedAt) {
    return { success: false, error: 'the promote changed while the continue was being checked; look at its current phase and retry' };
  }
  moved.parked = false;
  moved.lastError = null;
  writePromoteRecord(moved);
  void runPhases(botManager, moved, spliced);
  return { success: true, record: moved };
}

/**
 * Cancel is possible only while nothing irreversible happened: a parked claim
 * (the CAS either landed or it did not; parked means it did not) or a finished
 * record being cleared. Past the claim the old master is already deposed and
 * the only safe direction is forward.
 */
export async function cancelPromote(botManager?: BotManager): Promise<{ success: boolean; error?: string }> {
  const record = readPromoteRecord();
  if (!record) return { success: false, error: 'no promote to cancel' };
  // Liveness is the engine's, not the record's (see continuePromote).
  const idle = record.parked || !phasesRunning;
  // Held by another node since it was decided: nothing it could still do is
  // safe (its restart phase is a takeover past the fence) and the fleet is that
  // node's. Dismissed whatever its phase, from the persisted sighting, so it
  // needs no running child.
  if (record.mode !== 'stand-in' && idle && promoteSupersededBy(record)) {
    dismissSupersededRecord(record);
    return { success: true };
  }
  // A record from before the follower hold this node is in has nothing left
  // pending: the node is no longer the master it was, and the only thing
  // continuing it could do is the takeover restart above. Dismissed whatever
  // its phase.
  if (botManager && record.mode !== 'stand-in' && idle) {
    const child = await readChildState(botManager);
    // A boot parked on a live holder since this record was decided is evidence
    // the sighting cannot carry (a holder already sighted at that term is the
    // same holding): a foreign node answers at or above this node's term, so
    // the record's one remaining act, the takeover restart, is what the fence
    // parks. Judged ahead of the initialized gate, because a park never
    // initializes.
    if (child?.park && child.park.at >= record.startedAt) {
      const moved = readPromoteRecord();
      if (phasesRunning || !moved || moved.parked !== record.parked || moved.startedAt !== record.startedAt || moved.updatedAt !== record.updatedAt) {
        return { success: false, error: 'the promote changed while the cancel was being checked; look at its current phase and retry' };
      }
      dismissSupersededRecord(record);
      return { success: true };
    }
    if (child?.initialized && child.hold && !recordOfHold(record, child.hold)) {
      // Re-read after the await, as every cancel branch does.
      const moved = readPromoteRecord();
      if (phasesRunning || !moved || moved.parked !== record.parked || moved.startedAt !== record.startedAt || moved.updatedAt !== record.updatedAt) {
        return { success: false, error: 'the promote changed while the cancel was being checked; look at its current phase and retry' };
      }
      dismissSupersededRecord(record);
      return { success: true };
    }
  }
  // A parked claim whose term never landed is the one point where nothing has
  // happened yet (claimedTerm is written only after the COMMIT, so the phase
  // alone cannot say). Past it the record is the only carrier of the
  // superseded and retire facts and the role override is staged, so
  // dismissing it would strand both: Continue is the way forward.
  if (record.phase === 'done') {
    clearPromoteRecord();
    return { success: true };
  }
  if (idle && record.phase === 'claim' && record.claimedTerm === null) {
    // A null claimedTerm is not proof the COMMIT never landed (a lost
    // acknowledgement leaves it null too), so the row itself is asked: one
    // that names this node, or cannot be read, refuses.
    const url = record.canonicalEndpoint ? spliceFleetCredentials(record.canonicalEndpoint).url ?? '' : currentCanonicalUrl();
    const row = url ? await readTermRow(url) : null;
    // Re-read after the await, as the branches below do: a Continue clicked
    // meanwhile has restarted the phases, and clearing under them would only
    // be undone by their next save.
    // ANY intervening write refuses, not only a new record: a Continue that ran
    // and re-parked keeps startedAt, and the row read above may predate its
    // COMMIT (stale in the permissive direction).
    const moved = readPromoteRecord();
    if (phasesRunning || !moved || moved.parked !== record.parked || moved.startedAt !== record.startedAt || moved.updatedAt !== record.updatedAt || moved.claimedTerm !== null) {
      return { success: false, error: 'the promote changed while the cancel was being checked; look at its current phase and retry' };
    }
    if (!row) return { success: false, error: 'the fleet database\'s term row cannot be read right now, so this cancel cannot prove the claim never landed; Continue the promote, retry once it answers, or press Promote to decide again on what is reachable now (with that database gone for good this takes the failover path, behind the data-loss confirm)' };
    if (row.nodeId === getNodeId()) return { success: false, error: 'the claim landed (the fleet database\'s term row names this node), so the promote is past the point of cancellation; Continue it instead' };
    clearPromoteRecord();
    return { success: true };
  }
  // A failover parked before its copy left recovery took no irreversible step
  // either; an unreadable copy is not a yes.
  if (record.mode === 'failover' && idle && record.phase === 'promote') {
    const endpoints = resolveReplicaEndpoints();
    const spliced = endpoints ? splicedEndpoints(endpoints) : { error: 'no standby endpoint' };
    const copy = 'error' in spliced ? null : await probeReplica(spliced.local);
    const again = readPromoteRecord();
    if (phasesRunning || !again || again.parked !== record.parked || again.startedAt !== record.startedAt) {
      return { success: false, error: 'the promote changed while the cancel was being checked; look at its current phase and retry' };
    }
    if (!copy || !copy.ok || copy.inRecovery !== true) {
      return { success: false, error: `this machine's copy ${copy && copy.ok ? 'has already left recovery' : 'cannot be read right now'}; Continue the promote instead` };
    }
    clearPromoteRecord();
    return { success: true };
  }
  // A parked stand-in write step carries nothing the record alone must keep:
  // the override is written by its restart phase and the covered master rides
  // the arm record. Dismissing it hands the lane back its refusal spacing, and
  // manual promote stays open.
  if (record.mode === 'stand-in' && idle) {
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
    if (phasesRunning || !again || again.parked !== record.parked || again.startedAt !== record.startedAt) {
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
  // Another node has held the fleet since this record was decided (the child
  // saw it while the lane ran, or while the parent was down): its remaining
  // phases end in the takeover restart, so it is parked instead, judged
  // BEFORE the restart shortcut below. A boot that really took the fleet
  // cleared the sighting first, so a finished restart still reads as done;
  // one the boot refused (the same sighting) keeps its record for Cancel.
  const seen = promoteSupersededBy(record);
  if (seen) {
    record.parked = true;
    record.lastError = `${supersededText(seen)}; its takeover restart would seize the fleet from that node, so it is parked: Cancel it, and Promote again on what is reachable now`;
    writePromoteRecord(record);
    console.error(`[Fleet] PROMOTE parked at resume: ${record.lastError}`);
    return;
  }
  // A restart phase the parent died inside: phaseRestart is the only writer
  // of a master override at or after this record's start, so one present
  // means the boot the parent's own start just forked takes it (staged) or
  // already took it (consumed), and the record is finished. Without it the
  // takeover was never staged, and running it blind would boot this node as
  // master past the fence: parked for the operator, and a follower hold
  // refuses the Continue.
  if (record.mode !== 'stand-in' && record.phase === 'restart') {
    invalidateRoleOverrideCache();
    const override = readRoleOverride();
    if (override?.role === 'master' && override.setAt >= record.startedAt) {
      record.phase = 'done';
      closeTakeoverLane(record);
      noteFailbackDone(record);
      writePromoteRecord(record);
      console.warn('[Fleet] PROMOTE complete: the restart it was interrupted in has already taken');
      return;
    }
    record.parked = true;
    record.lastError = 'the parent restarted inside the restart phase; Continue re-runs the takeover restart, which skips the boot fence, so continue only if this node still holds the fleet\'s newest data';
    writePromoteRecord(record);
    console.error(`[Fleet] PROMOTE parked at resume: ${record.lastError}`);
    return;
  }
  const endpoints = resolveReplicaEndpoints();
  if (!endpoints) return;
  // The child's follow is the preferred credential source; past the claim
  // the node's own credentials, persisted there, carry every later phase, so
  // a node that no longer follows (the claim deposed that database) finishes.
  const followed = record.canonicalEndpoint && botManager.isRunning() ? await readFollowed(botManager) : null;
  const spliced = splicedEndpoints(endpoints, followed?.url);
  if ('error' in spliced) {
    if (!record.canonicalEndpoint) return;
    record.parked = true;
    record.lastError = 'the parent restarted before this promote had persisted the copy\'s credentials, and the bot is not following the database it was decided on; Continue once the Fleet tab shows it following, or Cancel';
    writePromoteRecord(record);
    console.error(`[Fleet] PROMOTE parked at resume: ${record.lastError}`);
    return;
  }
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
            await phaseClaim(botManager, record, spliced);
            record.phase = 'fence';
            break;
          case 'fence':
            await phaseFence(botManager, record);
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
            // Judged here too, ahead of the irreversible step: the sighting can
            // land while the catch-up runs, and pg_promote is what a park at
            // the restart phase can no longer undo.
            if (record.mode !== 'stand-in') {
              const seen = promoteSupersededBy(record);
              if (seen) throw new Error(`${supersededText(seen)}; the copy is left a standby${record.claimedTerm !== null || record.fencedLsn ? `, but this lane already claimed term ${record.claimedTerm ?? '?'} on ${record.canonicalEndpoint ?? 'the fleet database'} and left it read-only${record.fencedLsn ? ` at ${record.fencedLsn}` : ''}, and a Cancel discards those facts` : ', so nothing here is spent'}: Cancel this promote, and Promote again on what is reachable now`);
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
            noteFailbackDone(record);
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
async function phaseClaim(botManager: BotManager, record: PromoteRecord, spliced: { local: string; public: string }): Promise<void> {
  const url = await canonicalForRecord(botManager, record);
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
  // A returning master's point of no return: the claim deposed the database
  // it followed, so from here its own credentials (one lineage's) open that
  // database and its copy; written now so a restart of either process can
  // finish without the follow the claim ended.
  if (record.canonicalEndpoint) {
    const persisted = persistPromotedUrls(spliced.local, spliced.public);
    if (!persisted.success) throw new Error(persisted.error ?? 'could not persist the copy\'s URL after the claim');
  }
  console.warn(`[Fleet] PROMOTE claim: term ${record.claimedTerm} taken on the old master's database (held by ${record.supersededNodeId?.slice(0, 8) ?? 'nobody'} at term ${record.supersededTerm ?? 0})`);
}

/**
 * Fence the old database read-only at a known write position. Replication is
 * untouched (walsenders are not client backends), so the standby can reach
 * exactly this position; every later client write is refused loudly instead
 * of silently lost.
 */
async function phaseFence(botManager: BotManager, record: PromoteRecord): Promise<void> {
  const url = await canonicalForRecord(botManager, record);
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
    // Judged here too, not only at Continue: the sighting can arrive while the
    // earlier phases run (the child registers with a master that took the fleet
    // meanwhile), and this is the last point before the fence is skipped.
    const seen = promoteSupersededBy(record);
    if (seen) throw new Error(`${supersededText(seen)}; the takeover restart is not staged. This machine's copy has already left recovery and /data/.env names it${record.claimedTerm !== null ? `, and this lane claimed term ${record.claimedTerm} on ${record.canonicalEndpoint ?? 'the fleet database'}` : ''}${record.fencedLsn ? ` and left it read-only at ${record.fencedLsn}` : ''}, so there is no Promote left to run here: Cancel this promote, then re-seed this machine as a standby of the node that took the fleet and promote it once it has caught up, or demote this node to stay a co-worker; if that node is gone for good, Cancel this promote and, where this node's Fleet tab still offers Promote (a designated backup, or a hold that still names this node), press it again (this copy is already out of recovery, so the lane left is the repoint and the restart); otherwise seize the fleet onto this copy with FLEET_CONFIRM_TAKEOVER=1 plus a restart on a node whose configured role is master`);
    writeRoleOverride({
      role: 'master',
      takeover: true,
      ...(record.mode === 'failover' ? { chainTakeover: true } : {}),
      ...(record.supersededStoreDead ? { supersededStoreDead: record.supersededStoreDead } : {}),
      setAt: Date.now(),
      setBy: record.startedBy,
    });
  }
  for (let attempt = 0; ; attempt++) {
    const restart = await botManager.restart();
    if (restart.success) {
      closeTakeoverLane(record);
      return;
    }
    if (restart.reason !== 'operation_in_progress' || attempt >= 5) {
      throw new Error(restart.error ?? 'restart failed; the role override is staged and the next start boots as master');
    }
    await sleep(5000);
  }
}
