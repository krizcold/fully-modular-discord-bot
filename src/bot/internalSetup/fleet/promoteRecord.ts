// Promote record (PLAN_REPLICATION 20.4, B4): the webui parent's engine persists
// its phase here so a parent restart resumes at the recorded phase, and the bot
// child reads it at boot for the facts only the engine knew (which node it
// superseded, whether the owner asked to retire that side).

import * as fs from 'fs';
import { dataPath } from '../../../utils/dataRoot';
import { FLEET_DIR } from './constants';
import { atomicWriteFileSync } from './fileControlStore';

export type PromotePhase = 'verdict' | 'claim' | 'fence' | 'catchup' | 'promote' | 'restart' | 'done';
/** stand-in: a serving stand-in's copy takes the fleet's writes (20.5, B6 map F2); it keeps its backup identity. */
export type PromoteMode = 'transfer' | 'failover' | 'stand-in';

const PHASES: PromotePhase[] = ['verdict', 'claim', 'fence', 'catchup', 'promote', 'restart', 'done'];

export interface PromoteRecord {
  phase: PromotePhase;
  mode: PromoteMode;
  startedAt: number;
  updatedAt: number;
  parked: boolean;
  lastError: string | null;
  /** Who asked for this promote; stamped on the role override at the restart phase. */
  startedBy: 'webui-promote' | 'manager-promote' | 'stand-in';
  /** Transfer-and-retire: relayed to the old master in its register reply. */
  retireOldMaster: boolean;
  supersededNodeId: string | null;
  supersededTerm: number | null;
  /** The superseded node has registered and taken the fact; stops re-arming it on every reconnect. */
  supersededDelivered: boolean;
  /** Term row observed at the verdict; the claim refuses if the row moved since. */
  expectedTerm: number | null;
  expectedHolder: string | null;
  /** 20.12 c3: the superseded master's node id when the verdict saw it alive with its database dead; the boot fence lets that one peer answer. */
  supersededStoreDead: string | null;
  claimedTerm: number | null;
  /** End-of-WAL position captured when the old primary was fenced (transfer only). */
  fencedLsn: string | null;
  /** Age of the standby's last replayed transaction at the verdict (the RPO shown to the operator). */
  lagMs: number | null;
  /**
   * The fleet database this promote fences and claims, credential-less, when it
   * is not the one this node's own credentials name: a returning master follows
   * its stand-in's database (B6 map F28). Null = the node's own canonical URL.
   */
  canonicalEndpoint: string | null;
  /** A returning master's F31 verdict on its own database against the one it follows, as read when this promote started (B6-j: the episode record). */
  lineageVerdict: string | null;
  /** When this node first saw the node it follows holding the fleet, captured when the failback was decided (the child clears the sighting when it boots). */
  holdSince: number | null;
  /** The decision found this copy already out of recovery: a lane's own promoted database, still holding what that lane took (B6-j). */
  promotedCopy: boolean;
}

const recordFile = () => dataPath('global', FLEET_DIR, 'promote.json');

export function readPromoteRecord(): PromoteRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(recordFile(), 'utf-8'));
    if (!PHASES.includes(parsed?.phase) || (parsed?.mode !== 'transfer' && parsed?.mode !== 'failover' && parsed?.mode !== 'stand-in')) return null;
    return {
      phase: parsed.phase,
      mode: parsed.mode,
      startedAt: Number(parsed.startedAt) || 0,
      updatedAt: Number(parsed.updatedAt) || 0,
      parked: parsed.parked === true,
      lastError: typeof parsed.lastError === 'string' ? parsed.lastError : null,
      startedBy: parsed.startedBy === 'manager-promote' ? 'manager-promote' : parsed.startedBy === 'stand-in' ? 'stand-in' : 'webui-promote',
      retireOldMaster: parsed.retireOldMaster === true,
      supersededNodeId: typeof parsed.supersededNodeId === 'string' ? parsed.supersededNodeId : null,
      supersededTerm: Number.isFinite(parsed.supersededTerm) ? Number(parsed.supersededTerm) : null,
      supersededDelivered: parsed.supersededDelivered === true,
      expectedTerm: Number.isFinite(parsed.expectedTerm) ? Number(parsed.expectedTerm) : null,
      expectedHolder: typeof parsed.expectedHolder === 'string' ? parsed.expectedHolder : null,
      supersededStoreDead: typeof parsed.supersededStoreDead === 'string' && parsed.supersededStoreDead !== '' ? parsed.supersededStoreDead : null,
      claimedTerm: Number.isFinite(parsed.claimedTerm) ? Number(parsed.claimedTerm) : null,
      fencedLsn: typeof parsed.fencedLsn === 'string' ? parsed.fencedLsn : null,
      lagMs: Number.isFinite(parsed.lagMs) ? Number(parsed.lagMs) : null,
      canonicalEndpoint: typeof parsed.canonicalEndpoint === 'string' && parsed.canonicalEndpoint !== '' ? parsed.canonicalEndpoint : null,
      lineageVerdict: typeof parsed.lineageVerdict === 'string' ? parsed.lineageVerdict : null,
      holdSince: Number.isFinite(parsed.holdSince) ? Number(parsed.holdSince) : null,
      promotedCopy: parsed.promotedCopy === true,
    };
  } catch {
    return null;
  }
}

export function writePromoteRecord(record: PromoteRecord): void {
  atomicWriteFileSync(recordFile(), JSON.stringify({ ...record, updatedAt: Date.now() }, null, 2));
}

export function clearPromoteRecord(): void {
  try { fs.unlinkSync(recordFile()); } catch { /* already absent */ }
}
