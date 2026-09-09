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
  /** Where this node's own slot had confirmed at the master's read; null when the primary had no restart position for it. */
  restartLsn: string | null;
  /** The other standbys' rows from the SAME read, so a promote can see who received further (20.19 F14). */
  peers: { slotName: string; nodeId: string | null; restartLsn: string | null }[];
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
      restartLsn: typeof parsed.restartLsn === 'string' && parsed.restartLsn !== '' ? parsed.restartLsn : null,
      peers: Array.isArray(parsed.peers)
        ? parsed.peers
          .filter((p: any) => typeof p?.slotName === 'string' && p.slotName !== '')
          .map((p: any) => ({
            slotName: String(p.slotName),
            nodeId: typeof p.nodeId === 'string' && p.nodeId !== '' ? p.nodeId : null,
            restartLsn: typeof p.restartLsn === 'string' && p.restartLsn !== '' ? p.restartLsn : null,
          }))
        : [],
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

/**
 * A postgres LSN ('X/Y', hex) as an absolute byte position; null when it does
 * not parse. BigInt because a WAL position outruns an exact double.
 */
export function lsnBytes(lsn: string | null): bigint | null {
  if (!lsn) return null;
  const parts = /^([0-9a-fA-F]{1,8})\/([0-9a-fA-F]{1,8})$/.exec(lsn.trim());
  if (!parts) return null;
  return (BigInt('0x' + parts[1]) << 32n) + BigInt('0x' + parts[2]);
}

/**
 * The backups whose slot confirmed FURTHER than this node's own, furthest
 * first (20.9 "freshest lineage wins; priority breaks ties", 20.19 F14). The
 * last table the master pushed before it died is the final word on how far
 * each standby received, and every row in it was read at one instant, so the
 * positions are comparable.
 *
 * Only a FRESH table is evidence: a stale or missing one, an unparsable
 * position, or a row for a slot nothing claims says nothing at all.
 *
 * A slot position is where a copy's SLOT reached, which is not always where a
 * usable copy reached: a re-seed streams on the same slot while the volume
 * behind it is being rebuilt, so that node can read as ahead while holding
 * nothing promotable. No fact reaching this node separates the two (a node
 * whose standby is merely down looks identical, and it is the case this
 * advisory exists for), so the reading is left as it is and stays confirmable. A null
 * bytesAhead is the sharpest case rather than the absent one: the primary held
 * no position for THIS copy while a peer still had one.
 */
export function backupsAhead(
  record: SlotStatusRecord | null,
  myPriority: number,
  priorityOf: (nodeId: string) => number,
  now = Date.now(),
): { nodeId: string; slotName: string; bytesAhead: number | null }[] {
  if (!record || now - record.receivedAt >= SLOT_STATUS_FRESH_MS) return [];
  const mine = lsnBytes(record.restartLsn);
  const ahead: { nodeId: string; slotName: string; bytesAhead: number | null }[] = [];
  for (const peer of record.peers) {
    // Only a row a live node claims as its own standby is another COPY. The
    // primary also carries slots that are nobody's copy (the orphan a removed
    // standby leaves, the recovery channel's own), and a position on one of
    // those says nothing about how far any copy received.
    if (peer.nodeId === null) continue;
    const theirs = lsnBytes(peer.restartLsn);
    if (theirs === null) continue;
    if (mine === null) {
      // The primary holds no position for this copy: its slot was invalidated,
      // or it never attached. It cannot be shown to have received as far as a
      // peer that still has one, and staying silent would hide the very case
      // this advisory exists for.
      ahead.push({ nodeId: peer.nodeId, slotName: peer.slotName, bytesAhead: null });
    } else if (theirs > mine) {
      ahead.push({ nodeId: peer.nodeId, slotName: peer.slotName, bytesAhead: Number(theirs - mine) });
    } else if (theirs === mine && peer.nodeId !== null && priorityOf(peer.nodeId) < myPriority) {
      // Level with this copy, so the designated order is what separates them.
      ahead.push({ nodeId: peer.nodeId, slotName: peer.slotName, bytesAhead: 0 });
    }
  }
  const rank = (n: number | null): number => (n === null ? Number.MAX_SAFE_INTEGER : n);
  return ahead.sort((a, b) => rank(b.bytesAhead) - rank(a.bytesAhead));
}

/** This standby's row out of a pushed table; 'absent' when the primary has no slot of that name. */
export function recordFromPush(payload: SlotStatusPayload, slotName: string, sourceIsCurrentMaster: boolean | null): SlotStatusRecord {
  const row = payload.slots.find(s => s.slotName === slotName);
  return {
    restartLsn: row?.restartLsn ?? null,
    peers: payload.slots
      .filter(s => s.slotName !== slotName)
      .map(s => ({ slotName: s.slotName, nodeId: s.nodeId ?? null, restartLsn: s.restartLsn ?? null })),
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
