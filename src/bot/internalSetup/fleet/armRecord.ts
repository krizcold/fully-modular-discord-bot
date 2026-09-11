// Arm record (PLAN_REPLICATION 20.5, B6-f): the stand-in lane's own persisted
// state, node-local for the same reason the promote record is - the decision is
// made when the control store is a read-only replica and cannot be written to.
//
// It exists mainly to survive the restart the arm itself performs: the role
// override alone says "boot as master" but not why, at which term, or how many
// times this node has already tried. The attempt ledger is the part that must
// outlive a reboot, because the failure it bounds IS a reboot loop (F40).

import * as fs from 'fs';
import { dataPath } from '../../../utils/dataRoot';
import { FLEET_DIR } from './constants';
import { atomicWriteFileSync } from './fileControlStore';

export type ArmPhase = 'claimed' | 'serving' | 'disarmed';

const PHASES: ArmPhase[] = ['claimed', 'serving', 'disarmed'];

/** The six-term conjunction as observed at the instant the lane armed (F19). */
export interface ArmEvidence {
  masterBeaconDark: boolean;
  ownRenewOk: boolean;
  masterUnreachable: boolean;
  receiverStopped: boolean;
  storeUnreachable: boolean;
  noPeerSeesMaster: boolean;
  observedAt: number;
}

export interface ArmRecord {
  phase: ArmPhase;
  /** The master this node stands in for; published as standingInFor and read by the failback lane. */
  coveringNodeId: string;
  armedAt: number;
  updatedAt: number;
  /** Term read from the replayed row rather than minted, and re-proved at the serve-only boot. */
  inheritedTerm: number | null;
  inheritedFrom: string | null;
  evidence: ArmEvidence | null;
  /** Counted at each serve-only BOOT and cleared once the node actually serves. */
  attempts: number;
  lastAttemptAt: number;
  disarmedAt: number | null;
  disarmReason: string | null;
}

const recordFile = (): string => dataPath('global', FLEET_DIR, 'arm.json');

function readEvidence(raw: unknown): ArmEvidence | null {
  const e = raw as Record<string, unknown> | null;
  if (!e || typeof e !== 'object') return null;
  return {
    masterBeaconDark: e.masterBeaconDark === true,
    ownRenewOk: e.ownRenewOk === true,
    masterUnreachable: e.masterUnreachable === true,
    receiverStopped: e.receiverStopped === true,
    storeUnreachable: e.storeUnreachable === true,
    noPeerSeesMaster: e.noPeerSeesMaster === true,
    observedAt: Number(e.observedAt) || 0,
  };
}

export function readArmRecord(): ArmRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(recordFile(), 'utf-8'));
    // The covering node id is what the whole record is about: without it the
    // stand-in cannot publish who it covers, and a beacon with no standingInFor
    // is read by every peer as an ordinary backup.
    if (!PHASES.includes(parsed?.phase) || typeof parsed?.coveringNodeId !== 'string' || parsed.coveringNodeId === '') return null;
    return {
      phase: parsed.phase,
      coveringNodeId: parsed.coveringNodeId,
      armedAt: Number(parsed.armedAt) || 0,
      updatedAt: Number(parsed.updatedAt) || 0,
      inheritedTerm: Number.isFinite(parsed.inheritedTerm) ? Number(parsed.inheritedTerm) : null,
      inheritedFrom: typeof parsed.inheritedFrom === 'string' ? parsed.inheritedFrom : null,
      evidence: readEvidence(parsed.evidence),
      attempts: Number(parsed.attempts) || 0,
      lastAttemptAt: Number(parsed.lastAttemptAt) || 0,
      disarmedAt: Number.isFinite(parsed.disarmedAt) ? Number(parsed.disarmedAt) : null,
      disarmReason: typeof parsed.disarmReason === 'string' ? parsed.disarmReason : null,
    };
  } catch {
    return null;
  }
}

export function writeArmRecord(record: ArmRecord): void {
  atomicWriteFileSync(recordFile(), JSON.stringify({ ...record, updatedAt: Date.now() }, null, 2));
}


