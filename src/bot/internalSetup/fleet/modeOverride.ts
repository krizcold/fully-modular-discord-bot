// The emergency lever (PLAN_REPLICATION_B6_MAP F11, B6-k): a node-local
// override of the master's stored designation, set from this backup's own web
// UI while the master is dark. It supplies the MASTER'S key only (the node's
// own env consent stays required), it counts only while this node's own arm
// evidence says the master is unreachable (the stored value decides whenever
// the master is reachable), and it survives restarts until cleared, on the
// role-override precedent.

import * as fs from 'fs';
import { dataPath } from '../../../utils/dataRoot';
import { FLEET_DIR } from './constants';
import { atomicWriteFileSync } from './fileControlStore';

export interface ModeOverride {
  mode: 'active';
  setAt: number;
  setBy: string;
}

const overrideFile = () => dataPath('global', FLEET_DIR, 'mode-override.json');

export function readModeOverride(): ModeOverride | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(overrideFile(), 'utf-8'));
    if (parsed?.mode !== 'active') return null;
    return { mode: 'active', setAt: Number(parsed.setAt) || 0, setBy: typeof parsed.setBy === 'string' ? parsed.setBy : 'unknown' };
  } catch {
    return null;
  }
}

export function writeModeOverride(setBy: string): ModeOverride {
  const override: ModeOverride = { mode: 'active', setAt: Date.now(), setBy };
  atomicWriteFileSync(overrideFile(), JSON.stringify(override, null, 2));
  return override;
}

export function clearModeOverride(): void {
  try {
    fs.unlinkSync(overrideFile());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * A node the master never ranked sorts LAST (F22's ordering): one past the
 * highest stored priority, plus a stable sub-step from its own id so two
 * unranked nodes never share a slot and it lands strictly after a rank its
 * cache does not list. armDeferral scales a fractional rank.
 */
export function leverRank(designations: { priority: number }[], nodeId: string): number {
  return Math.max(2, designations.reduce((m, d) => Math.max(m, d.priority), 0) + 1) + idFraction(nodeId);
}

function idFraction(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  return (h + 1) / 4294967297;
}

/** The lever route's two body shapes: the empty object sets, exactly {clear: true} clears, anything else is refused. */
export function modeOverrideAction(body: unknown): 'set' | 'clear' | null {
  if (body === undefined || body === null) return 'set';
  if (typeof body !== 'object' || Array.isArray(body)) return null;
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.length === 0) return 'set';
  if (keys.length === 1 && (body as Record<string, unknown>).clear === true) return 'clear';
  return null;
}

/**
 * Whether the master's key is turned for this node: the stored designation
 * decides whenever the master is reachable; the lever counts only while it is
 * not. The node's own consent is the other key and is read by the caller.
 */
export function backupModeEnabled(designationMode: string | null | undefined, override: ModeOverride | null, masterUnreachable: boolean): boolean {
  if (!masterUnreachable) return designationMode === 'active';
  return designationMode === 'active' || override !== null;
}
