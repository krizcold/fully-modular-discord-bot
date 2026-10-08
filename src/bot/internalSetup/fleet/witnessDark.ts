// The dark master (PLAN_REPLICATION Section 21, B6 map F10, RULED 2026-10-08,
// built as A1). In active mode a backup may stand in once the master's beacon
// has aged out, so a master that has not renewed its own beacon for one full
// fresh window acts as if one did: it places no shard a stand-in could also
// place, and it never relaxes the sync posture, whose relax would acknowledge
// commits the stand-in's copy never got. It keeps its workers, so the bot stays
// online, and steps down only to a successor the existing paths prove.

import { WITNESS_FRESH_WINDOW_MS } from './constants';
import type { WitnessStatus } from './witness';

export interface WitnessDarkView {
  /** When the latch was raised. */
  since: number;
  /** The last renew that landed; null when none has since this master started. */
  lastRenewAt: number | null;
  /** Why it has not resumed yet. */
  waitingOn: string;
}

/** One full fresh window without a renew landing, counted from the loop's start while none ever has. */
export function witnessDarkDue(status: WitnessStatus, loopStartedAt: number, now: number): boolean {
  return now - Math.max(status.lastRenewAt ?? 0, loopStartedAt) >= WITNESS_FRESH_WINDOW_MS;
}

/** Why the dark master's own renew is not landing, with the witness's error as the way on. */
export function ownRenewWait(status: WitnessStatus): string {
  return `its own beacon still cannot be renewed${status.lastError ? ` (${status.lastError})` : ''}`;
}

/**
 * Null once the dark master may resume, judged on one tick: its renew landed,
 * the same tick then read the beacon home, and that read shows no claim above
 * its term and none standing in for it, fresh or not (a stand-in that took
 * writes and then went dark is still one), and a fresh beacon from every
 * designated backup, since only a designated backup stands in and one whose
 * beacon aged out could be a stand-in nobody can see. Otherwise why it keeps
 * waiting, with the way on.
 */
export function witnessDarkHold(
  renewOk: boolean,
  status: WitnessStatus,
  selfNodeId: string,
  selfTerm: number,
  backups: Array<{ nodeId: string; nodeName: string }>,
): string | null {
  if (!renewOk || status.lastRenewAt === null) return ownRenewWait(status);
  if (status.lastReadAt === null || status.lastReadAt < status.lastRenewAt) return 'the beacon home could not be read after its renew';
  const readAt = status.lastReadAt;
  const others = status.claims.filter(c => c.nodeId !== selfNodeId);
  const above = others.find(c => c.term > selfTerm);
  if (above) return `${above.nodeName}'s beacon holds term ${above.term}, above this master's ${selfTerm}; if it took the fleet over, demote this node to rejoin under it`;
  const standIn = others.find(c => c.standingInFor === selfNodeId);
  if (standIn) return `${standIn.nodeName}'s beacon says it stands in for this master; it hands back once it reads this master's beacon again`;
  for (const backup of backups) {
    const claim = others.find(c => c.nodeId === backup.nodeId);
    if (!claim || readAt - claim.observedAt > WITNESS_FRESH_WINDOW_MS) {
      return `${backup.nodeName}'s beacon is not fresh, so this master cannot tell whether it stands in; bring ${backup.nodeName} back, or remove its backup designation on the Fleet tab only once you know it is gone and never stood in`;
    }
  }
  return null;
}
