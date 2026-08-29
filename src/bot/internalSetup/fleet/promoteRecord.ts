// Promote record (PLAN_REPLICATION 20.4, B4): the webui parent's engine persists
// its phase here so a parent restart resumes at the recorded phase, and the bot
// child reads it at boot for the facts only the engine knew (which node it
// superseded, whether the owner asked to retire that side).

import * as fs from 'fs';
import { dataPath } from '../../../utils/dataRoot';
import { FLEET_DIR } from './constants';
import { atomicWriteFileSync } from './fileControlStore';

export type PromotePhase = 'verdict' | 'claim' | 'fence' | 'catchup' | 'promote' | 'restart' | 'done';
export type PromoteMode = 'transfer' | 'failover';

const PHASES: PromotePhase[] = ['verdict', 'claim', 'fence', 'catchup', 'promote', 'restart', 'done'];

export interface PromoteRecord {
  phase: PromotePhase;
  mode: PromoteMode;
  startedAt: number;
  updatedAt: number;
  parked: boolean;
  lastError: string | null;
  /** Who asked for this promote; stamped on the role override at the restart phase. */
  startedBy: 'webui-promote' | 'manager-promote';
  /** Transfer-and-retire: relayed to the old master in its register reply. */
  retireOldMaster: boolean;
  supersededNodeId: string | null;
  supersededTerm: number | null;
  /** The superseded node has registered and taken the fact; stops re-arming it on every reconnect. */
  supersededDelivered: boolean;
  /** Term row observed at the verdict; the claim refuses if the row moved since. */
  expectedTerm: number | null;
  expectedHolder: string | null;
  claimedTerm: number | null;
  /** End-of-WAL position captured when the old primary was fenced (transfer only). */
  fencedLsn: string | null;
  /** Age of the standby's last replayed transaction at the verdict (the RPO shown to the operator). */
  lagMs: number | null;
}

const recordFile = () => dataPath('global', FLEET_DIR, 'promote.json');

export function readPromoteRecord(): PromoteRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(recordFile(), 'utf-8'));
    if (!PHASES.includes(parsed?.phase) || (parsed?.mode !== 'transfer' && parsed?.mode !== 'failover')) return null;
    return {
      phase: parsed.phase,
      mode: parsed.mode,
      startedAt: Number(parsed.startedAt) || 0,
      updatedAt: Number(parsed.updatedAt) || 0,
      parked: parsed.parked === true,
      lastError: typeof parsed.lastError === 'string' ? parsed.lastError : null,
      startedBy: parsed.startedBy === 'manager-promote' ? 'manager-promote' : 'webui-promote',
      retireOldMaster: parsed.retireOldMaster === true,
      supersededNodeId: typeof parsed.supersededNodeId === 'string' ? parsed.supersededNodeId : null,
      supersededTerm: Number.isFinite(parsed.supersededTerm) ? Number(parsed.supersededTerm) : null,
      supersededDelivered: parsed.supersededDelivered === true,
      expectedTerm: Number.isFinite(parsed.expectedTerm) ? Number(parsed.expectedTerm) : null,
      expectedHolder: typeof parsed.expectedHolder === 'string' ? parsed.expectedHolder : null,
      claimedTerm: Number.isFinite(parsed.claimedTerm) ? Number(parsed.claimedTerm) : null,
      fencedLsn: typeof parsed.fencedLsn === 'string' ? parsed.fencedLsn : null,
      lagMs: Number.isFinite(parsed.lagMs) ? Number(parsed.lagMs) : null,
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
