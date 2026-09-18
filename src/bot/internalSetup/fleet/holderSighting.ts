// The last time this node saw the fleet held by ANOTHER node (B6 map F28):
// the boot fence's park and hold, a live supersession, a registration as a
// co-worker. The promote engine reads it as the evidence that outlives a role
// change: a non-stand-in promote decided BEFORE that sighting would restart
// this node as master past the fence onto a fleet somebody else holds,
// whatever role the node has meanwhile been given and whether its child runs.

import * as fs from 'fs';
import { dataPath } from '../../../utils/dataRoot';
import { FLEET_DIR } from './constants';
import { atomicWriteFileSync } from './fileControlStore';

export type HolderSightingVia = 'fence-park' | 'fence-hold' | 'step-down' | 'register';

export interface HolderSighting {
  nodeId: string;
  term: number;
  /** When this node FIRST saw that node holding at that term; a re-derived hold or a reconnect keeps it. */
  seenAt: number;
  via: HolderSightingVia;
}

const sightingFile = () => dataPath('global', FLEET_DIR, 'holder-sighting.json');

export function readHolderSighting(): HolderSighting | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(sightingFile(), 'utf-8'));
    if (typeof parsed?.nodeId !== 'string' || parsed.nodeId === '' || !Number.isFinite(parsed?.term) || !Number.isFinite(parsed?.seenAt)) return null;
    return {
      nodeId: parsed.nodeId,
      term: Number(parsed.term),
      seenAt: Number(parsed.seenAt),
      via: parsed.via === 'fence-park' || parsed.via === 'fence-hold' || parsed.via === 'step-down' ? parsed.via : 'register',
    };
  } catch {
    return null;
  }
}

/**
 * Records another node holding the fleet. The sighting dates the HOLDING, not
 * the look: a term below the recorded one, or the same node at the same term,
 * is a re-derivation from a staler source (the lagging replayed row of a
 * stalled copy, an old beacon, a reconnect) and moves nothing, so a hold
 * re-derived across a restart never postdates the failback decided in it.
 * ANOTHER node at the same term is a new holding: a serve-only stand-in
 * inherits the dead master's term (20.5), and its register reply is the only
 * channel that reports it.
 */
export function noteHolderSighting(nodeId: string | null, term: number | null, via: HolderSightingVia, selfNodeId: string): void {
  if (!nodeId || nodeId === selfNodeId || term === null || !Number.isFinite(term)) return;
  const current = readHolderSighting();
  if (current && (term < current.term || (term === current.term && nodeId === current.nodeId))) return;
  atomicWriteFileSync(sightingFile(), JSON.stringify({ nodeId, term, seenAt: Date.now(), via }, null, 2));
}

export function clearHolderSighting(): void {
  try { fs.unlinkSync(sightingFile()); } catch { /* already absent */ }
}
