// Slot-status fact (PLAN_REPLICATION 20.14/20.17, the B4m-2b slot signal). The
// master's bot pushes the primary's slot table to every node hosting a standby;
// the standby's bot picks its own slot, records it beside the copy block, and
// answers the manager's facts hook from that record. wal_status lives only on
// the primary, so this record is the standby's only honest source for "lost":
// its own receiver cannot tell a lost slot from a primary that is merely offline.

import * as fs from 'fs';
import { dataPath } from '../../../utils/dataRoot';
import { FLEET_DIR } from './constants';
import { atomicWriteFileSync } from './fileControlStore';
import type { SlotStatusPayload } from './protocol';

/** A fact older than this reads as unknown: several missed samples, plus slack. */
export const SLOT_STATUS_FRESH_MS = 5 * 60_000;

export interface SlotStatusRecord {
  slotName: string;
  /** pg_replication_slots.wal_status, or 'absent' when the primary has no slot of that name. */
  walStatus: string;
  active: boolean;
  retainedBytes: number | null;
  /** The master's clock at the read. */
  observedAt: number;
  /** This node's clock at receipt; freshness is judged against it. */
  receivedAt: number;
  fromNodeId: string;
  fromTerm: number;
  /** This copy's primary_conninfo names the database endpoint the sending master delivered; null when the source could not be read. */
  sourceIsCurrentMaster: boolean | null;
}

const slotStatusFile = () => dataPath('global', FLEET_DIR, 'slot-status.json');

export function readSlotStatus(): SlotStatusRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(slotStatusFile(), 'utf-8'));
    if (typeof parsed?.slotName !== 'string' || parsed.slotName === '' || typeof parsed?.walStatus !== 'string') return null;
    if (!Number.isFinite(parsed?.receivedAt)) return null;
    return {
      slotName: parsed.slotName,
      walStatus: parsed.walStatus,
      active: parsed.active === true,
      retainedBytes: Number.isFinite(parsed.retainedBytes) ? Number(parsed.retainedBytes) : null,
      observedAt: Number(parsed.observedAt) || 0,
      receivedAt: Number(parsed.receivedAt),
      fromNodeId: typeof parsed.fromNodeId === 'string' ? parsed.fromNodeId : '',
      fromTerm: Number(parsed.fromTerm) || 0,
      sourceIsCurrentMaster: parsed.sourceIsCurrentMaster === true ? true : parsed.sourceIsCurrentMaster === false ? false : null,
    };
  } catch {
    return null;
  }
}

export function writeSlotStatus(record: SlotStatusRecord): void {
  atomicWriteFileSync(slotStatusFile(), JSON.stringify(record, null, 2));
}

/** Drop the record when this node no longer hosts a standby, so nothing reads a stale verdict. */
export function clearSlotStatus(): void {
  try { fs.unlinkSync(slotStatusFile()); } catch { /* already absent */ }
}

/** This standby's row out of a pushed table; 'absent' when the primary has no slot of that name. */
export function recordFromPush(payload: SlotStatusPayload, slotName: string, sourceIsCurrentMaster: boolean | null): SlotStatusRecord {
  const row = payload.slots.find(s => s.slotName === slotName);
  return {
    slotName,
    walStatus: row ? row.walStatus : 'absent',
    active: row?.active === true,
    retainedBytes: row?.retainedBytes ?? null,
    observedAt: Number(payload.observedAt) || 0,
    receivedAt: Date.now(),
    fromNodeId: String(payload.nodeId || ''),
    fromTerm: Number(payload.term) || 0,
    sourceIsCurrentMaster,
  };
}

/** True when the standby's source endpoint is one of the given database URLs (the forms the master delivered). */
export function sourceMatchesAny(source: { sourceHost: string | null; sourcePort: number | null }, urls: string[]): boolean {
  if (!source.sourceHost) return false;
  const host = source.sourceHost.toLowerCase();
  const port = source.sourcePort ?? 5432;
  return urls.some(candidate => {
    try {
      const parsed = new URL(candidate);
      return parsed.hostname.toLowerCase() === host && (Number(parsed.port) || 5432) === port;
    } catch {
      return false;
    }
  });
}

/**
 * The verdict the manager acts on: fresh, lost, and from the master this copy
 * follows. Anything else, including no record at all, is unknown and reads as
 * false; a standby is never re-seeded on silence.
 */
export function slotLostVerdict(record: SlotStatusRecord | null, now = Date.now()): boolean {
  return record !== null
    && now - record.receivedAt < SLOT_STATUS_FRESH_MS
    && record.walStatus === 'lost'
    && record.sourceIsCurrentMaster === true;
}
