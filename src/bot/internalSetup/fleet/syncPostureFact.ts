/**
 * The in-sync fact (PLAN_REPLICATION 20.5, B6 map F23).
 *
 * A stand-in may only claim its data IS every acknowledged write if the master
 * was synchronously waiting for this copy when it died. The instant that
 * matters is the instant the master is gone, so no primary-side evidence can
 * be read then: the backup can only know what it was last told, and anything
 * it was told is by construction older than the death it is evidence about.
 * The trap this exists to close is the unilateral degrade, where the master
 * relaxes at T, dies at T+1s, and the backup arms on a guarantee already gone.
 *
 * TWO CARRIERS, with different jobs:
 *
 *  - THE REPLAYED ROW is the evidence, because it is the only carrier that
 *    SURVIVES the master's death. The master writes the posture, and the
 *    position it was held to, into the control store, which lives in the same
 *    cluster the standby replays, so it arrives with no protocol at all. What
 *    makes it evidence rather than gossip: while the posture is ARMED, that
 *    row's own write is itself synchronous (measured: writing it while armed
 *    with the copy gone hangs until the posture is relaxed), so a row the
 *    standby has replayed is proof the guarantee was live at that position.
 *  - THE PUSHED COPY is for display and for disarming FAST. It is never
 *    required to reach a positive verdict, and it could not be: its freshness
 *    window is deliberately shorter than the witness dead-master window, so by
 *    the time anything could conclude the master is dead it has expired by
 *    design. What it can do is CONTRADICT: a fresh contradiction wins, and so
 *    does one the master attested LATER than the row this copy replayed, at
 *    any age (B7-F23).
 *
 * THE RULE THAT CLOSES THE DEGRADE is F23's own: "my last replayed posture row
 * is older than my last streaming observation" is no verdict. Implemented as
 * pg_last_xact_replay_timestamp() against the row's updatedAt. Both of those
 * are the MASTER's clock (a replayed commit timestamp is the origin's), so the
 * comparison never crosses a machine boundary, and both come out of ONE read,
 * so a cached read cannot skew it either. If WAL kept arriving after the last
 * attestation, the tail of this copy is unattested and nothing is claimed.
 *
 * WHAT REMAINS UNCLOSED, stated rather than papered over: if the master
 * relaxes while this node's control connection is down as well, then
 * acknowledges writes this copy never receives, then dies, this copy sees
 * neither those writes nor the relax on either carrier, and reads as
 * consistent. No fact reaching this machine can distinguish that (only the
 * master's beacon could carry it), which is one reason the arming conjunction
 * is not this file's to make. Where the control connection outlived the
 * stream, the pushed relax IS that fact, and the verdict honours it above.
 *
 * Fail-closed throughout, on the slot signal's precedent (B6 map D16): a
 * missing, stale, or not-from-this-master fact is no verdict at all, never a
 * negative one and never a positive one.
 */

import * as fs from 'fs';
import { Client } from 'pg';
import { shortLivedClient } from '../utils/pgClient';
import { dataPath } from '../../../utils/dataRoot';
import { FLEET_DIR } from './constants';
import { atomicWriteFileSync } from './fileControlStore';
import type { SyncPosturePayload } from './protocol';

/**
 * A pushed fact older than this can no longer contradict. It is stamped once
 * per ATTESTATION rather than on every delivery, so this measures the age of
 * what the master last said, not of the last packet that carried it.
 */
export const SYNC_POSTURE_FRESH_MS = 45_000;

/**
 * How far this copy may have replayed past the last attestation, in the
 * master's own clock, before the tail counts as unattested. Two publish
 * refreshes: one for the refresh that should have arrived, one for slack.
 */
export const REPLAY_LAG_TOLERANCE_MS = 60_000;

/** A cached read older than this is not evidence; a decision-time caller re-reads rather than trusting it. */
export const REPLAYED_READ_FRESH_MS = 5 * 60_000;

/** What the master attests. Both carriers move exactly the wire object (protocol.ts). */
export type SyncPostureFact = SyncPosturePayload;

/** The pushed fact as this node filed it. */
export interface SyncPostureRecord extends SyncPostureFact {
  /** This node's clock at receipt; freshness is judged against it, never against a foreign clock. */
  receivedAt: number;
  /** Whether this copy streams from the master that sent it; null when the source could not be read (slot-signal precedent). */
  sourceIsCurrentMaster: boolean | null;
}

/** The row this node replayed out of its own copy, with what that copy had replayed at the same instant. */
export interface ReplayedSyncPosture {
  fact: SyncPostureFact;
  /**
   * The commit timestamp of the last transaction this copy replayed, in the
   * MASTER's clock, which is what makes it comparable with the row's
   * updatedAt. Null on a copy that has replayed nothing since it started,
   * which is not a signal of staleness.
   */
  lastReplayedXactAt: number | null;
  /** This node's clock when the row was read. */
  readAt: number;
}

const recordFile = () => dataPath('global', FLEET_DIR, 'sync-posture.json');

function parseFact(parsed: any): SyncPostureFact | null {
  if (!parsed || (parsed.state !== 'armed' && parsed.state !== 'relaxed')) return null;
  if (typeof parsed.masterNodeId !== 'string' || parsed.masterNodeId === '') return null;
  // Not coerced to 0: updatedAt is what every staleness judgement rests on, and
  // a silent zero would read as an attestation from 1970 that never ages out.
  if (!Number.isFinite(parsed.updatedAt)) return null;
  return {
    state: parsed.state,
    slotName: typeof parsed.slotName === 'string' && parsed.slotName !== '' ? parsed.slotName : null,
    nodeId: typeof parsed.nodeId === 'string' && parsed.nodeId !== '' ? parsed.nodeId : null,
    heldToLsn: typeof parsed.heldToLsn === 'string' && parsed.heldToLsn !== '' ? parsed.heldToLsn : null,
    updatedAt: Number(parsed.updatedAt),
    masterNodeId: parsed.masterNodeId,
    term: Number(parsed.term) || 0,
    seq: Number(parsed.seq) || 0,
  };
}

export function readSyncPostureRecord(): SyncPostureRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(recordFile(), 'utf-8'));
    const fact = parseFact(parsed);
    if (!fact || !Number.isFinite(parsed?.receivedAt)) return null;
    return {
      ...fact,
      receivedAt: Number(parsed.receivedAt),
      sourceIsCurrentMaster: parsed.sourceIsCurrentMaster === true ? true : parsed.sourceIsCurrentMaster === false ? false : null,
    };
  } catch {
    return null;
  }
}

export function writeSyncPostureRecord(record: SyncPostureRecord): void {
  atomicWriteFileSync(recordFile(), JSON.stringify(record, null, 2));
}

/** Drop the record when this node no longer hosts a standby, so nothing reads a verdict about a copy that is gone. */
export function clearSyncPostureRecord(): void {
  try { fs.unlinkSync(recordFile()); } catch { /* already absent */ }
}

/** File a pushed fact against this node's own clock, with the same source verdict the slot lane stamps. */
export function recordFromPosturePush(payload: SyncPosturePayload, sourceIsCurrentMaster: boolean | null): SyncPostureRecord | null {
  const fact = parseFact(payload);
  if (!fact) return null;
  return { ...fact, receivedAt: Date.now(), sourceIsCurrentMaster };
}

// The row and this copy's own replay position come out of ONE read, so their
// relationship is a snapshot that no later caching can distort.
const REPLAYED_SQL = `
  SELECT (SELECT body FROM smdb_control.docs WHERE name = 'sync-posture') AS body,
         EXTRACT(EPOCH FROM pg_last_xact_replay_timestamp()) * 1000 AS last_xact_ms`;
const READ_CONNECT_TIMEOUT_MS = 5000;
const READ_QUERY_TIMEOUT_MS = 5000;

/**
 * The row this copy has replayed, read from the copy ITSELF. Null covers every
 * not-yet and every fault alike: an unprovisioned control schema, a copy that
 * has not replayed the row, an unreachable local database. None of those is
 * evidence of anything, which is the whole discipline here.
 */
export async function readReplayedSyncPosture(url: string): Promise<ReplayedSyncPosture | null> {
  const client = shortLivedClient({
    connectionString: url,
    connectionTimeoutMillis: READ_CONNECT_TIMEOUT_MS,
    query_timeout: READ_QUERY_TIMEOUT_MS,
  });
  try {
    await client.connect();
    const res = await client.query(REPLAYED_SQL);
    const body = res.rows[0]?.body;
    if (typeof body !== 'string') return null;
    const fact = parseFact(JSON.parse(body));
    if (!fact) return null;
    const raw = res.rows[0]?.last_xact_ms;
    return {
      fact,
      lastReplayedXactAt: raw === null || raw === undefined ? null : Number(raw),
      readAt: Date.now(),
    };
  } catch {
    return null;
  } finally {
    await client.end().catch(() => { /* best effort */ });
  }
}

/** Everything a verdict is allowed to rest on. */
export interface SyncPostureEvidence {
  /** The row this copy replayed. The only carrier that survives the master's death, so the only one that can say yes. */
  replayed: ReplayedSyncPosture | null;
  /** The pushed fact, when one has been filed. It can only ever contradict. */
  pushed: SyncPostureRecord | null;
  /** This node's own standby slot; null when it hosts no copy. */
  mySlotName: string | null;
  /** Whether this copy still streams from the master that wrote the row; null when unknown, which is not a yes. */
  sourceIsCurrentMaster: boolean | null;
}

export interface SyncPostureVerdict {
  /** The master was synchronously waiting for THIS copy, and nothing contradicts it. */
  inSync: boolean;
  /** How far that attestation reaches; null when there is none. Beyond it, nothing is claimed. */
  heldToLsn: string | null;
  /** Always populated, so a surface can say why rather than only that. */
  reason: string;
}

/**
 * Was this copy synchronously held, and up to where.
 *
 * This deliberately does NOT decide whether to stand in: it answers one
 * question and leaves the conjunction that arms to the step that arms. A
 * caller making a decision should pass a FRESHLY read `replayed`, because a
 * relax this copy has already replayed is invisible in a cached one.
 */
export function syncPostureVerdict(evidence: SyncPostureEvidence, now = Date.now()): SyncPostureVerdict {
  const { replayed, pushed, mySlotName, sourceIsCurrentMaster } = evidence;
  const no = (reason: string): SyncPostureVerdict => ({ inSync: false, heldToLsn: null, reason });
  if (!mySlotName) return no('this node hosts no standby of the fleet database');
  // A copy that follows some other database is not evidence about this fleet,
  // exactly as a slot verdict from a former master is not (D16).
  if (sourceIsCurrentMaster !== true) return no('this copy does not follow the master that recorded the posture');

  // Two facts from one master are ordered by (term, seq), two counters that
  // master owns: the term steps on every boot and the seq on every attestation
  // within one, so neither a clock step nor a restart reorders them. Null when
  // they are not comparable (no row yet, or another master).
  const order = pushed !== null && replayed !== null && pushed.masterNodeId === replayed.fact.masterNodeId
    ? (pushed.term !== replayed.fact.term ? Math.sign(pushed.term - replayed.fact.term) : Math.sign(pushed.seq - replayed.fact.seq))
    : null;
  // The fast disarm: a fresh pushed fact that contradicts wins outright, unless
  // the row this copy replayed is a LATER attestation that has superseded it
  // (a relax still being re-sent across the re-arm that followed it).
  const pushedIsFresh = pushed !== null && now - pushed.receivedAt < SYNC_POSTURE_FRESH_MS && order !== -1;
  if (pushedIsFresh && pushed!.state !== 'armed') return no('the master has since said it was waiting for no copy');
  if (pushedIsFresh && pushed!.slotName !== mySlotName) return no('the master has since said it was waiting for a different copy');

  if (!replayed) return no('this copy has not replayed the posture the master recorded');
  if (now - replayed.readAt >= REPLAYED_READ_FRESH_MS) return no('the replayed posture was last read too long ago to act on');
  if (replayed.fact.state !== 'armed') return no('the posture this copy replayed says the master was not waiting for any copy');
  if (replayed.fact.slotName !== mySlotName) return no('the posture this copy replayed names a different copy');
  if (!replayed.fact.heldToLsn) return no('the replayed posture records no position it was held to');
  if (pushedIsFresh && pushed!.masterNodeId !== replayed.fact.masterNodeId) {
    return no('the replayed posture came from a different master than the one now speaking');
  }
  // A later attestation from the same master outranks the replayed row at ANY
  // age: the relax it carries is the one a copy whose stream broke first never
  // replays (B7-F23). The window above expires stale positives; a later
  // negative does not become true by ageing.
  if (order === 1) {
    if (pushed!.state !== 'armed') return no('the master later said it was waiting for no copy, and this copy never replayed that relax');
    if (pushed!.slotName !== mySlotName) return no('the master later said it was waiting for a different copy');
  }
  // F23's rule, and the one that closes the unilateral degrade: if this copy
  // has replayed transactions from after the last attestation, WAL kept
  // arriving with nothing vouching for it, so the tail is unattested.
  if (replayed.lastReplayedXactAt !== null && replayed.lastReplayedXactAt - replayed.fact.updatedAt > REPLAY_LAG_TOLERANCE_MS) {
    return no('this copy has replayed writes from after the last attestation, so its most recent writes are not covered');
  }
  return { inSync: true, heldToLsn: replayed.fact.heldToLsn, reason: 'the master was synchronously waiting for this copy' };
}
