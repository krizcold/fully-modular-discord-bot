// Stand-in episode record (PLAN_REPLICATION 20.5, B6-j): one stand-in episode
// and how it ended, kept node-local on BOTH sides so an operator can answer
// "did the outage writes survive" after the fact. Written once, at the
// episode's end: by the stand-in when its lane closes, by the returning master
// when its failback completes or it seizes the fleet. The next episode
// overwrites it.

import * as fs from 'fs';
import { dataPath } from '../../../utils/dataRoot';
import { FLEET_DIR } from './constants';
import { atomicWriteFileSync } from './fileControlStore';
import { ArmRecord, readArmRecord, writeArmRecord } from './armRecord';

/**
 * handed-back: the covering master took the fleet back through the stand-in's copy (the failback).
 * promoted-for-good: an operator promoted the stand-in into the true master.
 * demoted: an operator demoted the stand-in.
 * superseded: another node took the fleet at a higher term.
 * seized: the covering master minted past the writes on its own database (FLEET_CONFIRM_TAKEOVER).
 * never-served: the lane ended before it served, or while it served read-only, so no writes were ever at stake.
 */
export type EpisodeEnding = 'handed-back' | 'promoted-for-good' | 'demoted' | 'superseded' | 'seized' | 'never-served';

/**
 * yes: on the fleet database; no: discarded; held: only the stand-in's copy has
 * them; none: no writes were taken; partial: the returning master promoted on
 * what it had replayed from an unreachable copy, so what the stand-in took after
 * that stayed behind (the master side only; the stand-in never judges partial).
 */
export type WritesOutcome = 'yes' | 'no' | 'held' | 'none' | 'partial';

export interface EpisodeRecord {
  side: 'stand-in' | 'master';
  standInNodeId: string;
  standInName: string | null;
  coveringNodeId: string;
  coveringName: string | null;
  /** When the stand-in armed (its own record), or when the master first saw it holding. */
  standInSince: number;
  /** When the stand-in's copy took writes; null when it never did, or when this side cannot know. */
  writesFrom: number | null;
  endedAt: number;
  ending: EpisodeEnding;
  writesSurvived: WritesOutcome;
  detail: string;
  /** The returning master's F31 verdict on its own pre-outage database against the copy, when it was judged. */
  lineageVerdict: string | null;
  /** This node's copy was seen re-seeded after this record closed (stamped once by the replica sampler): whatever it alone held is gone, and any instruction to keep it is moot. */
  copyReseeded?: true;
}

const ENDINGS: EpisodeEnding[] = ['handed-back', 'promoted-for-good', 'demoted', 'superseded', 'seized', 'never-served'];
const OUTCOMES: WritesOutcome[] = ['yes', 'no', 'held', 'none', 'partial'];

const recordFile = (): string => dataPath('global', FLEET_DIR, 'episode.json');

/** The plan's question, answered from two facts the stand-in holds: whether writes were taken, and how the lane ended. */
export function judgeWrites(writesFrom: number | null, ending: EpisodeEnding): WritesOutcome {
  if (writesFrom === null) return 'none';
  if (ending === 'handed-back' || ending === 'promoted-for-good') return 'yes';
  if (ending === 'seized') return 'no';
  return 'held';
}

export function readEpisodeRecord(): EpisodeRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(recordFile(), 'utf-8'));
    if ((parsed?.side !== 'stand-in' && parsed?.side !== 'master') || typeof parsed.standInNodeId !== 'string' || typeof parsed.coveringNodeId !== 'string') return null;
    if (!ENDINGS.includes(parsed.ending) || !OUTCOMES.includes(parsed.writesSurvived)) return null;
    return {
      side: parsed.side,
      standInNodeId: parsed.standInNodeId,
      standInName: typeof parsed.standInName === 'string' ? parsed.standInName : null,
      coveringNodeId: parsed.coveringNodeId,
      coveringName: typeof parsed.coveringName === 'string' ? parsed.coveringName : null,
      standInSince: Number(parsed.standInSince) || 0,
      writesFrom: Number.isFinite(parsed.writesFrom) ? Number(parsed.writesFrom) : null,
      endedAt: Number(parsed.endedAt) || 0,
      ending: parsed.ending,
      writesSurvived: parsed.writesSurvived,
      detail: typeof parsed.detail === 'string' ? parsed.detail : '',
      lineageVerdict: typeof parsed.lineageVerdict === 'string' ? parsed.lineageVerdict : null,
      ...(parsed.copyReseeded === true ? { copyReseeded: true as const } : {}),
    };
  } catch {
    return null;
  }
}

export function writeEpisodeRecord(record: EpisodeRecord): void {
  atomicWriteFileSync(recordFile(), JSON.stringify(record, null, 2));
}

/**
 * The returning master's failback outcome (B6-j), from its promote record
 * alone: only a transfer that claimed and fenced the copy hands the writes
 * back whole; the failover shape promoted this database on what it had
 * replayed, so what the stand-in took after that stayed behind. Null when the
 * record is not a returning master's failback (a stand-in's own write step, a
 * promote of this node's own database, a lane that superseded nobody).
 */
export function failbackOutcome(record: { mode: string; canonicalEndpoint: string | null; supersededNodeId: string | null; claimedTerm: number | null; fencedLsn: string | null; lagMs: number | null }): { ending: EpisodeEnding; writesSurvived: WritesOutcome; detail: string } | null {
  if (record.mode === 'stand-in' || record.canonicalEndpoint === null || !record.supersededNodeId) return null;
  const fenced = record.mode === 'transfer' && record.claimedTerm !== null && record.fencedLsn !== null;
  return {
    ending: 'handed-back',
    writesSurvived: fenced ? 'yes' : 'partial',
    detail: fenced
      ? `the failback fenced that copy at ${record.fencedLsn}, this database was re-seeded from it, and this node was promoted back at term ${record.claimedTerm}`
      : `that copy could not be reached to fence, so this node was promoted on what it had already replayed from it${record.lagMs === null ? ' (its replay age was never measured)' : ` (its last replay was ${Math.round(record.lagMs / 1000)}s old)`}: anything the stand-in took after that stayed behind`,
  };
}

/**
 * Whether a promote's takeover restart closes this node's stand-in episode
 * (B6-j): a lane still live past claimed, or an ended lane whose last record is
 * this node's own and whose copy this promote really promotes (the decision
 * found it out of recovery, and its term row named nobody else: a replaced
 * database carries another lineage), confirming a held verdict or reversing a
 * no (the fleet moved on without those writes; promoting this copy puts them
 * back). A record already reading yes or none, or another node's, stands.
 */
export function promoteClosesEpisode(armPhase: string, decision: { promotedCopy: boolean; supersededNodeId: string | null }, last: EpisodeRecord | null, selfNodeId: string): boolean {
  if (armPhase === 'claimed') return false;
  if (armPhase !== 'disarmed') return true;
  if (!last || last.side !== 'stand-in' || last.standInNodeId !== selfNodeId) return false;
  return decision.promotedCopy && !decision.supersededNodeId && !last.copyReseeded && (last.writesSurvived === 'held' || last.writesSurvived === 'no');
}

/**
 * The stand-in side's ending (B6-j), from two facts: whether the lane took
 * writes, and whether the superseding claim landed on this copy. A lane with
 * no writes has nothing at stake; a claim on this copy means the new master's
 * database was built from it, whoever claimed; a claim elsewhere by the
 * covering master minted past the writes, by any other node moved the fleet
 * on without them.
 */
export function standInEnding(arm: { promotedAt: number | null; coveringNodeId: string }, by: { nodeId: string; onCopy: boolean }): EpisodeEnding {
  if (arm.promotedAt === null) return 'never-served';
  if (by.onCopy) return 'handed-back';
  return by.nodeId === arm.coveringNodeId ? 'seized' : 'superseded';
}

/**
 * This node's own record, on either side, is stamped once when its copy is
 * seen back in recovery after writes were at stake: the copy was re-seeded.
 * A held verdict turns to no (whatever the copy alone held is gone) and a
 * seized lane says so; every other verdict stands, only the instruction to
 * keep the copy lapses. The stamp outlives the copy's later recovery state.
 */
export function expireHeldEpisodeIfReseeded(selfNodeId: string): boolean {
  const last = readEpisodeRecord();
  if (!last || last.copyReseeded || last.writesSurvived === 'none') return false;
  const own = last.side === 'stand-in' ? last.standInNodeId === selfNodeId : last.coveringNodeId === selfNodeId;
  if (!own) return false;
  if (last.side === 'stand-in' && last.writesSurvived === 'held') {
    writeEpisodeRecord({ ...last, writesSurvived: 'no', copyReseeded: true, detail: `${last.detail}; the copy was then re-seeded as a standby, so the writes it alone held are gone` });
    return true;
  }
  if (last.side === 'stand-in' && last.ending === 'seized') {
    writeEpisodeRecord({ ...last, copyReseeded: true, detail: `${last.detail}; the copy was then re-seeded as a standby, so the writes it took are gone` });
    return true;
  }
  writeEpisodeRecord({ ...last, copyReseeded: true });
  return true;
}

/** When the stand-in's window opened, as the master side knows it: the promote's own hold time, else when this node first saw a holder, else the fallback. */
export function episodeWindowStart(holdSince: number | null, sighting: { firstSeenAt: number } | null, fallback: number): number {
  return holdSince ?? sighting?.firstSeenAt ?? fallback;
}

/** The master side's record of a seizure (B6-j): the confirm ended the stand-in seen holding, discarding whatever it accepted. */
export function seizedEpisode(seen: { nodeId: string; term: number; seenAt: number; firstSeenAt: number }, selfNodeId: string, selfNodeName: string): EpisodeRecord {
  return {
    side: 'master',
    standInNodeId: seen.nodeId,
    standInName: null,
    coveringNodeId: selfNodeId,
    coveringName: selfNodeName,
    standInSince: episodeWindowStart(null, seen, seen.seenAt),
    writesFrom: null,
    endedAt: Date.now(),
    ending: 'seized',
    writesSurvived: 'no',
    detail: `FLEET_CONFIRM_TAKEOVER on this node seized the fleet back onto this database past term ${seen.term}, discarding whatever node ${seen.nodeId.slice(0, 8)} accepted while standing in`,
    lineageVerdict: null,
  };
}

/** The returning master's record of its failback (B6-j); null when the promote was no failback. */
export function failbackEpisode(
  record: { mode: string; canonicalEndpoint: string | null; supersededNodeId: string | null; claimedTerm: number | null; fencedLsn: string | null; lagMs: number | null; holdSince: number | null; startedAt: number; lineageVerdict: string | null },
  sighting: { firstSeenAt: number } | null,
  selfNodeId: string,
  selfNodeName: string,
): EpisodeRecord | null {
  const outcome = failbackOutcome(record);
  if (!outcome || !record.supersededNodeId) return null;
  return {
    side: 'master',
    standInNodeId: record.supersededNodeId,
    standInName: null,
    coveringNodeId: selfNodeId,
    coveringName: selfNodeName,
    standInSince: episodeWindowStart(record.holdSince, sighting, record.startedAt),
    writesFrom: null,
    endedAt: Date.now(),
    ...outcome,
    lineageVerdict: record.lineageVerdict,
  };
}

/** A record is a surface fact: a write that fails is warned, never thrown, so it withholds no exit it decorates. */
export function writeEpisodeRecordOrWarn(record: EpisodeRecord): void {
  try {
    writeEpisodeRecord(record);
  } catch (err) {
    console.warn(`[Fleet] The episode record could not be written: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The lane's exits must complete whatever the record does: a record write that fails is warned, never thrown. */
export function closeStandInEpisodeOrWarn(...args: Parameters<typeof closeStandInEpisode>): void {
  try {
    closeStandInEpisode(...args);
  } catch (err) {
    console.warn(`[Fleet] The stand-in episode record could not be written: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** A stand-in lane's exit: the lane's state first, then its episode, so the record can never withhold the exit. */
export function closeStandInLane(arm: ArmRecord, selfNodeId: string, selfName: string | null, coveringName: string | null, ending: EpisodeEnding, detail: string, disarmReason: string): void {
  writeArmRecord({ ...arm, phase: 'disarmed', disarmedAt: Date.now(), disarmReason });
  closeStandInEpisodeOrWarn(arm, selfNodeId, selfName, coveringName, ending, detail);
}

const lineageVerdictFile = () => dataPath('global', FLEET_DIR, 'lineage-verdict.json');

/**
 * The returning master's verdict on its own database against the stand-in's
 * copy is judged during the behind hold, but the failback re-seeds this
 * database and restarts the process before the promote that records the
 * episode, so the judged fact is kept node-local, keyed on the stand-in it was
 * judged against.
 */
export function rememberLineageVerdict(verdict: string, standInNodeId: string | null): void {
  try {
    atomicWriteFileSync(lineageVerdictFile(), JSON.stringify({ verdict, standInNodeId, at: Date.now() }, null, 2));
  } catch (err) {
    console.warn(`[Fleet] The lineage verdict could not be kept: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function readLineageVerdict(): { verdict: string; standInNodeId: string | null; at: number } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lineageVerdictFile(), 'utf-8'));
    if (typeof parsed?.verdict !== 'string' || !Number.isFinite(parsed.at)) return null;
    return { verdict: parsed.verdict, standInNodeId: typeof parsed.standInNodeId === 'string' ? parsed.standInNodeId : null, at: Number(parsed.at) };
  } catch {
    return null;
  }
}

/** The kept verdict, when it was judged against this stand-in and inside this outage (at or after the hold began). */
export function recallLineageVerdict(standInNodeId: string | null, since: number | null): string | null {
  const kept = readLineageVerdict();
  if (!kept || !standInNodeId || kept.standInNodeId !== standInNodeId) return null;
  if (since !== null && kept.at < since) return null;
  return kept.verdict;
}

/**
 * A lane that took writes and left no record of its own (the write faulted, or
 * the process died between the two writes) has no record the sampler's stamp
 * can expire, so when the copy is seen back in recovery the arm record itself
 * is stamped once and the surfaces stop asking to keep the copy. The lane's
 * record is its own when it is this node's stand-in side with the arm's
 * since-when; anything that closed before the lane armed is an older one.
 */
export function stampUnrecordedLaneReseeded(selfNodeId: string): boolean {
  const arm = readArmRecord();
  if (!arm || arm.phase !== 'disarmed' || arm.promotedAt === null || arm.copyReseededAt !== null) return false;
  const last = readEpisodeRecord();
  const ownRecord = !!last && last.side === 'stand-in' && last.standInNodeId === selfNodeId && last.standInSince === arm.armedAt;
  if (last && (ownRecord || last.endedAt >= arm.armedAt)) return false;
  writeArmRecord({ ...arm, copyReseededAt: Date.now() });
  return true;
}

/** The stand-in side: the arm record is the episode, and closing the lane stamps how it ended and what became of the writes. */
export function closeStandInEpisode(
  arm: { coveringNodeId: string; armedAt: number; promotedAt: number | null },
  selfNodeId: string,
  selfName: string | null,
  coveringName: string | null,
  ending: EpisodeEnding,
  detail: string,
): void {
  writeEpisodeRecord({
    side: 'stand-in',
    standInNodeId: selfNodeId,
    standInName: selfName,
    coveringNodeId: arm.coveringNodeId,
    coveringName,
    standInSince: arm.armedAt,
    writesFrom: arm.promotedAt,
    endedAt: Date.now(),
    ending,
    writesSurvived: judgeWrites(arm.promotedAt, ending),
    detail,
    lineageVerdict: null,
  });
}
