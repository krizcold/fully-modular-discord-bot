// The stand-in arm decision (PLAN_REPLICATION 20.5, B6 map F19/F22/F26/F37/F39/F40).
//
// Everything here is a pure function over values the caller gathered, for one
// reason: this is the only lane in the fleet that takes over WITHOUT a human
// reading the verdict first, so its decision has to be drivable and provable in
// isolation. The gathering lives in bootstrap where the connections are.
//
// The whole set is a CONJUNCTION and every term is required. A missing term is
// never "probably fine": the no-verdict rule says an absent fact produces no
// arm, because the failure this lane guards against (two nodes serving the same
// Discord identity) is exactly what a hopeful default produces.

import { ARM_MAX_ATTEMPTS, ARM_SPACING_MS, STANDIN_WRITE_REQUEST_STALE_MS, WITNESS_FRESH_WINDOW_MS } from './constants';
import { ArmRecord } from './armRecord';
import type { SyncPostureVerdict } from './syncPostureFact';

/**
 * The six-term conjunction. Each is stated so that TRUE means "consistent with
 * the master being gone", so the arm condition is simply all six.
 */
export interface ArmEvidenceInputs {
  /** (a) No fresh master or stand-in beacon inside the witness window. */
  masterBeaconDark: boolean;
  /** (b) THIS node's own beacon renew succeeded in the same tick: the darkness is the master's, not ours. */
  ownRenewOk: boolean;
  /** (c) This node's control connection to the master is down. */
  masterUnreachable: boolean;
  /** (d) This node's WAL receiver is not streaming, read on demand. */
  receiverStopped: boolean;
  /** (e) The canonical store is unreachable from here. */
  storeUnreachable: boolean;
  /** (f) No fresh peer backup reports that it can still see the master. */
  noPeerSeesMaster: boolean;
}

export type ArmVerdict = { arm: true } | { arm: false; reason: string };

const TERMS: Array<{ key: keyof ArmEvidenceInputs; missing: string }> = [
  { key: 'ownRenewOk', missing: 'this node could not renew its own beacon, so the darkness may be this node' },
  { key: 'masterUnreachable', missing: 'this node still holds a control connection to the master' },
  { key: 'masterBeaconDark', missing: 'a fresh master beacon is still being published' },
  { key: 'noPeerSeesMaster', missing: 'another backup reports it can still see the master' },
  { key: 'storeUnreachable', missing: 'the canonical store still answers from here' },
  { key: 'receiverStopped', missing: 'this node is still streaming from the master' },
];

/**
 * Ordered cheapest-first so a caller can gather lazily: the two terms that cost
 * a database connection sit last and are only reached when the free ones agree.
 */
export function evaluateArmEvidence(inputs: ArmEvidenceInputs): ArmVerdict {
  for (const term of TERMS) {
    if (inputs[term.key] !== true) return { arm: false, reason: term.missing };
  }
  return { arm: true };
}

export interface PreArmInputs {
  /** The stored designation says this node may stand in, and its own env consented (B6-a). */
  activeMode: boolean;
  dataBackendIsPostgres: boolean;
  draining: boolean;
  migrationWorkActive: boolean;
  /** resolveReplicaEndpoints() found a local standby to serve from. */
  hasStandbyEndpoint: boolean;
  /** A promote record that is neither done nor parked: a human is already driving this. */
  promoteInFlight: boolean;
  /**
   * The local standby actually holds this fleet's state: its replayed control
   * store answers with a term row.
   *
   * This is F37's exclusion done from the side that can see it. The manager's
   * copyCleared flag never reaches the bot, and a wiped copy is INDISTINGUISHABLE
   * from a healthy one on the streaming terms alone: a volume that was just
   * erased has stopped streaming, which is exactly what term (d) asks for. The
   * term row is the difference, and reading it is the same read that names the
   * master this node would be covering.
   */
  standbyHoldsFleetState: boolean;
  /** A reshard pause would assign nothing at all, so the stand-in would serve LESS than the dark master (F26). */
  reshardPending: boolean;
  /**
   * CONTROL_STORE_URL names a different cluster than the data backend. Every
   * replication fact keys on the DATA cluster, so on a split store the rows that
   * decide who is master live somewhere with no standby at all (F38).
   */
  splitControlStore: boolean;
  /** A fresh beacon at or above our term from any other serving node (F22). */
  contestedTerm: boolean;
}

/** The refusal set evaluated BEFORE the irreversible step, never at arm time (F26). */
export function preArmRefusal(inputs: PreArmInputs): string | null {
  if (!inputs.activeMode) return 'this node is not an enabled active-mode backup';
  if (!inputs.dataBackendIsPostgres) return 'standing in is a postgres-mode feature (file mode has no standby)';
  if (!inputs.hasStandbyEndpoint) return 'this node holds no database standby to serve from';
  if (!inputs.standbyHoldsFleetState) return 'the local standby holds no readable fleet term row, so it has nothing to serve';
  if (inputs.draining) return 'this node is draining';
  if (inputs.migrationWorkActive) return 'a migration or transformation is working on this node';
  if (inputs.promoteInFlight) return 'a promote is already running on this node';
  if (inputs.reshardPending) return 'the fleet is paused on a reshard, which a stand-in cannot resolve';
  if (inputs.splitControlStore) return 'CONTROL_STORE_URL names an endpoint other than the data backend, so its rows carry no replication of their own';
  if (inputs.contestedTerm) return 'another node holds an equal or higher term and is still fresh';
  return null;
}

/**
 * The re-arm bound (F40). The caller counts an attempt at each serve-only BOOT
 * and resets it once the node actually serves, because the failure being bounded
 * is a node that reboots into a master role and cannot get there: counting only
 * successful stand-ins would never increment in exactly the loop that needs
 * stopping, and counting at the arm would spend the budget before the boot.
 */
export function ledgerAllowsArm(record: ArmRecord | null, now: number): ArmVerdict {
  if (!record) return { arm: true };
  if (record.attempts >= ARM_MAX_ATTEMPTS) {
    return { arm: false, reason: `this node has already tried to stand in ${record.attempts} times; failing over now needs a manual promote` };
  }
  // Measured from whichever came last: the attempt's start, or the disarm that
  // ended it (a fence trip, a step-down, an operator's demote). A stand-in that
  // served for longer than the spacing would otherwise be eligible again on the
  // very next tick after the operator demoted it, which turns F9's ruled exit
  // into a 45 s pause; counting from the exit gives the operator the same room
  // F40 gives every attempt to reach the mode toggle.
  const last = Math.max(record.lastAttemptAt, record.disarmedAt ?? 0);
  const since = now - last;
  if (last > 0 && since < ARM_SPACING_MS) {
    return { arm: false, reason: `the last stand-in ${record.disarmedAt !== null && record.disarmedAt >= record.lastAttemptAt ? 'ended' : 'attempt was'} ${Math.round(since / 1000)}s ago; the lane waits ${Math.round(ARM_SPACING_MS / 1000)}s between attempts` };
  }
  return { arm: true };
}

/**
 * Arming a node no co-worker can reach is LEGAL (20.9 blesses a solo home PC),
 * so this warns and never refuses. Silence is not a verdict either: with no
 * advertised URL the condition cannot be computed, and saying nothing would let
 * an unreachable node look identical to a reachable one.
 */
export function reachabilityWarning(publicUrl: string, rawMasterCandidates: string[]): string | null {
  const mine = publicUrl.trim();
  if (mine === '') {
    return 'this node advertises no FLEET_PUBLIC_URL, so whether co-workers can reach it cannot be determined here';
  }
  const listed = rawMasterCandidates.some(url => url.trim() === mine);
  if (!listed) {
    return 'this node is not in the fleet master candidate list, so no co-worker can dial it: while it stands in, only this machine serves';
  }
  return null;
}

/**
 * F22's ranking, as ruled: a lower-ranked backup WAITS rather than asks
 * permission.
 *
 * Two designated active backups see identical evidence at the same instant, and
 * nothing can separate them afterwards - both inherit the SAME term, and every
 * comparison that would fence one of them is strictly-greater, so an equal term
 * is invisible to all of them. The ordering therefore has to happen before the
 * arm, and it has to be decidable by each node ALONE: any handshake would need
 * the peer's answer to arrive between two ticks of a loop whose whole premise is
 * that the network is broken.
 *
 * The step is a full FRESH window rather than one renew period because the
 * higher-ranked node must arm, restart, boot and publish its standingInFor
 * beacon before the next node decides. It is a DELAY and never a veto: if that
 * node is dead, unfit or capped, nothing appears and the wait simply expires.
 */
export function armDeferral(rank: number, evidenceHeldSince: number, now: number): { defer: boolean; waitMs: number } {
  const waitMs = Math.max(0, rank - 1) * WITNESS_FRESH_WINDOW_MS;
  if (waitMs === 0 || evidenceHeldSince <= 0) return { defer: false, waitMs };
  return { defer: now - evidenceHeldSince < waitMs, waitMs };
}

export type WriteStepTiming =
  | { step: 'hold'; remainingMs: number }
  | { step: 'requested' }
  | { step: 'stale-request' }
  | { step: 'after-refusal'; remainingMs: number }
  | { step: 'check' };

/**
 * When a serving stand-in may ask to take writes (F2's second gate, 20.6's
 * post-claim hold). Reads are served from the instant the arm fires; writes wait
 * one full staleness window after the claim, which is what makes the hold cheap
 * enough to keep as ruled (F4). A request already out waits for the parent's
 * answer, but not forever: the parent answers by rewriting the record, and a
 * parent mid-restart or a lost IPC message would otherwise leave the lane
 * waiting on a request nobody holds. A refusal waits out the arm spacing before
 * the lane asks again, so a permanent one surfaces every spacing and never
 * spins, while a transient one recovers.
 */
export function writeStepTiming(record: ArmRecord, now: number): WriteStepTiming {
  if (record.phase === 'promoting') {
    const since = now - (record.writeRequestedAt ?? record.updatedAt);
    return since < STANDIN_WRITE_REQUEST_STALE_MS ? { step: 'requested' } : { step: 'stale-request' };
  }
  const holdRemaining = record.armedAt + WITNESS_FRESH_WINDOW_MS - now;
  if (holdRemaining > 0) return { step: 'hold', remainingMs: holdRemaining };
  if (record.writeRefusedAt !== null) {
    const again = record.writeRefusedAt + ARM_SPACING_MS - now;
    if (again > 0) return { step: 'after-refusal', remainingMs: again };
  }
  return { step: 'check' };
}

/**
 * Taking writes needs everything the arm needed, re-proven now, plus the one
 * fact serve-only never needed: the replicated in-sync row naming this copy as
 * the one the master was synchronously waiting for. That row replaces the
 * operator's RPO confirm; without it the lane keeps serving read-only and the
 * manual promote with its confirm stays the exit (20.5, F9).
 */
export function writeStepVerdict(evidence: ArmEvidenceInputs, sync: SyncPostureVerdict): ArmVerdict {
  const gone = evaluateArmEvidence(evidence);
  if (!gone.arm) return gone;
  if (!sync.inSync) {
    return { arm: false, reason: `this copy was not provably in sync when the master died (${sync.reason}), so taking writes needs a manual promote with its RPO confirm` };
  }
  return { arm: true };
}
