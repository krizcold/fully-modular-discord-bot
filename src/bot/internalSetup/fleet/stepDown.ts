// Supersession helpers (PLAN_REPLICATION 20.3/20.13/20.14, B4): the facts a
// superseded master records for its manager, the copy block relayed to
// designated backups, the STEP_DOWN notification a new master sends, and the
// witness-claim judgements shared by the boot fence and the master loop.

import * as fs from 'fs';
import { WebSocket } from 'ws';
import { dataPath } from '../../../utils/dataRoot';
import { FLEET_DIR, WITNESS_CURRENT_WINDOW_MS, WITNESS_FRESH_WINDOW_MS } from './constants';
import { atomicWriteFileSync } from './fileControlStore';
import { ControlEnvelope, CopyBlock, MSG, StepDownPayload, SupersededInfo } from './protocol';
import type { WitnessClaim, WitnessStatus } from './witness';

export type SupersededSource = 'store-fence' | 'step-down' | 'witness';

/** On-disk form of the superseded fact (read by the manager for its retire buttons). */
export interface SupersededRecord extends SupersededInfo {
  source: SupersededSource;
  steppedDown: boolean;
}

const supersededFile = () => dataPath('global', FLEET_DIR, 'superseded.json');
const copyBlockFile = () => dataPath('global', FLEET_DIR, 'copy-block.json');
const freshFleetFile = () => dataPath('global', FLEET_DIR, 'fresh-fleet.json');

export function readSuperseded(): SupersededRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(supersededFile(), 'utf-8'));
    if (typeof parsed?.byNodeId !== 'string' || !Number.isFinite(parsed?.term)) return null;
    return {
      byNodeId: parsed.byNodeId,
      byNodeName: typeof parsed.byNodeName === 'string' ? parsed.byNodeName : parsed.byNodeId,
      term: Number(parsed.term),
      retireRequested: parsed.retireRequested === true,
      at: Number(parsed.at) || 0,
      source: parsed.source === 'step-down' || parsed.source === 'witness' ? parsed.source : 'store-fence',
      steppedDown: parsed.steppedDown === true,
    };
  } catch {
    return null;
  }
}

export function writeSuperseded(record: SupersededRecord): void {
  atomicWriteFileSync(supersededFile(), JSON.stringify(record, null, 2));
}

export function clearSuperseded(): void {
  try { fs.unlinkSync(supersededFile()); } catch { /* already absent */ }
}

export function readCopyBlock(): CopyBlock | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(copyBlockFile(), 'utf-8'));
    if (typeof parsed?.dsn !== 'string' || parsed.dsn === '' || typeof parsed?.cert !== 'string' || parsed.cert === '') return null;
    return { dsn: parsed.dsn, cert: parsed.cert, publishedAt: Number(parsed.publishedAt) || 0 };
  } catch {
    return null;
  }
}

export function writeCopyBlock(block: CopyBlock): void {
  atomicWriteFileSync(copyBlockFile(), JSON.stringify(block, null, 2));
}

/** Drop the block when the database it describes is gone, so nothing relays it. */
export function clearCopyBlock(): void {
  try { fs.unlinkSync(copyBlockFile()); } catch { /* already absent */ }
}

/** The database endpoint a copy block names (the password is never read out); null when its DSN does not parse. */
export function copyBlockEndpoint(block: CopyBlock): { sourceHost: string; sourcePort: number } | null {
  try {
    const url = new URL(block.dsn);
    return url.hostname ? { sourceHost: url.hostname, sourcePort: Number(url.port) || 5432 } : null;
  } catch {
    return null;
  }
}

/** Operator confirmation that an empty master store is a brand-new fleet (exits the 20.14 boot hold). */
/**
 * File-only by design: the confirmation answers ONE empty store and is consumed
 * with it, and an env flag could never be consumed, so it would silently
 * disable the lineage guard for the life of the container.
 */
export function hasFreshFleetConfirm(): boolean {
  try { fs.accessSync(freshFleetFile()); return true; } catch { return false; }
}

export function writeFreshFleetConfirm(): void {
  atomicWriteFileSync(freshFleetFile(), JSON.stringify({ confirmedAt: Date.now() }, null, 2));
}

export function clearFreshFleetConfirm(): void {
  try { fs.unlinkSync(freshFleetFile()); } catch { /* already absent */ }
}

/**
 * Tell a superseded master to step down. Best effort and fire-and-forget by
 * design: the sender is already the master; the notification only shortens
 * the old master's handover (its fallbacks are the witness and a timer).
 */
export function notifyStepDown(url: string, secret: string, payload: StepDownPayload, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { headers: { 'x-control-secret': secret }, handshakeTimeout: timeoutMs });
    } catch {
      resolve(false);
      return;
    }
    const requestId = `step-down_${Date.now()}_${Math.random()}`;
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closing */ }
      resolve(ok);
    };
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch { /* already closing */ }
      finish(false);
    }, timeoutMs);
    ws.on('open', () => {
      try { ws.send(JSON.stringify({ type: MSG.STEP_DOWN, requestId, data: payload })); } catch { finish(false); }
    });
    ws.on('message', raw => {
      let message: ControlEnvelope;
      try { message = JSON.parse(String(raw)); } catch { return; }
      if (!message || typeof message !== 'object' || message.requestId !== requestId) return;
      finish(message.data?.ok === true);
    });
    ws.on('error', () => finish(false));
    ws.on('close', () => finish(false));
  });
}

/**
 * Any other node's claim holding a term above ours, fresh or not: this copy is
 * a stale fork (boot fence).
 *
 * A stand-in covering THIS node needs no exception here, and must not have one.
 * While it serves READ-ONLY it holds this node's own term, so it never clears
 * the strictly-greater test and this node's boot continues past it to hand
 * back (B6 map F21/F28). A stand-in at a HIGHER term has TAKEN WRITES: its copy
 * is the fleet database now and this node's is behind it, so this node must
 * park (or, if still serving, step down) rather than mint past those writes.
 */
export function higherTermClaim(claims: WitnessClaim[], selfNodeId: string, selfTerm: number): WitnessClaim | null {
  let best: WitnessClaim | null = null;
  for (const claim of claims) {
    if (claim.nodeId === selfNodeId || claim.term <= selfTerm) continue;
    if (!best || claim.term > best.term) best = claim;
  }
  return best;
}

/**
 * A FRESH higher-term claim from another node: that node is up and holds a
 * newer term than this one, so this master steps down now. Freshness is judged
 * on Discord's edit stamps and the read itself must be recent, so a stale
 * snapshot from a dark witness can never trigger a step-down.
 */
export function freshHigherTermClaim(status: WitnessStatus, selfNodeId: string, selfTerm: number, now: number): WitnessClaim | null {
  if (status.lastReadAt === null || now - status.lastReadAt > WITNESS_FRESH_WINDOW_MS) return null;
  const candidate = higherTermClaim(status.claims.filter(c => now - c.observedAt <= WITNESS_FRESH_WINDOW_MS), selfNodeId, selfTerm);
  return candidate;
}

/**
 * The HIGHEST-term fresh master claim from another node: the master is alive as
 * far as the witness can tell. Highest-term, not first-seen: beacons come back
 * in Discord's message order, which has nothing to do with term, and a stale
 * ex-master's beacon must never stand in for the real one.
 */
export function freshMasterClaim(status: WitnessStatus, selfNodeId: string, now: number): WitnessClaim | null {
  if (status.lastReadAt === null || now - status.lastReadAt > WITNESS_FRESH_WINDOW_MS) return null;
  let best: WitnessClaim | null = null;
  for (const claim of status.claims) {
    // A stand-in IS the fleet's coordinator for the duration, so every node but
    // the one it covers must see it here: otherwise a third backup reads
    // masterAlive=false and is offered the RPO path INTO a live stand-in, and
    // the demote guard warns the fleet is about to freeze when it is not (F21).
    const serving = claim.role === 'master' || claim.standingInFor !== undefined;
    if (claim.nodeId === selfNodeId || !serving) continue;
    if (now - claim.observedAt > WITNESS_FRESH_WINDOW_MS) continue;
    if (!best || claim.term > best.term) best = claim;
  }
  return best;
}

/**
 * A live master's own verdict that its store is gone, believed only while it is
 * genuinely current (20.12 c3). This one fact flips within seconds - a sidecar
 * that restarts is healthy again long before a three-period-old beacon expires -
 * and it unlocks the RPO path, so a stale reading here would strand every write
 * the recovered master accepted meanwhile.
 */
export function masterStoreDeadNow(claim: WitnessClaim | null, status: WitnessStatus, now: number): boolean {
  // ONLY 'dead'. A 'stalled' master is waiting on a departed sync standby: its
  // database is alive and holds the newest writes, and treating that as a dead
  // store would unlock the lossy path in the very case that loses most (F20).
  if (!claim || claim.storeState !== 'dead') return false;
  if (status.lastReadAt === null || now - status.lastReadAt > WITNESS_CURRENT_WINDOW_MS) return false;
  return now - claim.observedAt <= WITNESS_CURRENT_WINDOW_MS;
}

/** Child -> parent: the co-worker override is staged, restart me (B4 step-down). */
export function requestStepDownRestart(): void {
  if (!process.send) return;
  try { process.send({ type: 'fleet:stepdown' }); } catch { /* the fallback timer retries */ }
}

export interface StandInWriteRequest {
  coveringNodeId: string;
  inheritedTerm: number | null;
  heldToLsn: string | null;
}

/**
 * A serving stand-in asks the parent to take writes (20.5, B6 map F2). The
 * step runs in the parent because only there is the container-pinned URL
 * verdict correct; the parent answers by rewriting the arm record.
 */
export function requestStandInWrites(data: StandInWriteRequest): void {
  if (!process.send) return;
  try { process.send({ type: 'fleet:standin:writes', data }); } catch { /* the lane asks again once the request goes stale */ }
}
