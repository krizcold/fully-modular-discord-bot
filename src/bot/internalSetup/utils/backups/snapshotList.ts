import * as fs from 'fs';
import * as path from 'path';
import { dataPath } from '../../../../utils/dataRoot';
import { compareSnapshotNames, parseSnapshotName, parseWorkName, type SnapshotKind } from './snapshotNames';

export const HOURLY_KEEP_MS = 48 * 60 * 60 * 1000;
export const DAILY_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
export const AHEAD_LIMIT_MS = 5 * 60 * 1000;
export const RESTORE_LEFTOVER_MS = 60 * 60 * 1000;

export interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
  sig: { ino: number; size: number; mtimeMs: number; ctimeMs: number };
}

export interface Manifest {
  format: 1;
  name: string;
  kind: SnapshotKind;
  takenAt: number;
  botVersion: string;
  counts: { files: number; bytes: number; dirs: number; guilds: number; graveyardEntries: number };
  files: ManifestFile[];
  dirs: string[];
}

export type SnapshotEntry =
  | { name: string; kind: SnapshotKind | null; time: number | null; state: 'complete'; manifest: Manifest }
  | { name: string; kind: SnapshotKind | null; time: number | null; state: 'damaged'; cause: string };

export function snapshotsRoot(): string {
  return dataPath('_snapshots');
}

/** One snapshot folder, read synchronously: complete when its manifest parses with `format` 1 and its own name. */
export function readSnapshot(name: string, root: string = snapshotsRoot()): SnapshotEntry {
  const parsed = parseSnapshotName(name);
  const head = { name, kind: parsed?.kind ?? null, time: parsed?.time ?? null };
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, name, 'manifest.json'), 'utf8');
  } catch (e) {
    return { ...head, state: 'damaged', cause: (e as NodeJS.ErrnoException).code ?? String(e) };
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return { ...head, state: 'damaged', cause: 'not valid JSON' };
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { ...head, state: 'damaged', cause: 'not a JSON object' };
  const m = manifest as Record<string, unknown>;
  if (m.format !== 1) return { ...head, state: 'damaged', cause: m.format === undefined ? 'no format field' : `format ${JSON.stringify(m.format)}, which this version cannot read` };
  if (m.name !== name) return { ...head, state: 'damaged', cause: m.name === undefined ? 'no name field' : `it names the backup ${JSON.stringify(m.name)}` };
  return { ...head, state: 'complete', manifest: m as unknown as Manifest };
}

/** Every snapshot folder at the top of _snapshots (names starting with '.' are work folders and are not listed), oldest first. */
export async function listSnapshots(root: string = snapshotsRoot()): Promise<SnapshotEntry[]> {
  let dirents: fs.Dirent[];
  try {
    dirents = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  return dirents
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => d.name)
    .sort(compareSnapshotNames)
    .map(name => readSnapshot(name, root));
}

export interface PruneProtect {
  /** `state.json` `test.lastPassed`. */
  lastPassed: string | null;
  /** The snapshot the running daily test reads. */
  testing?: string | null;
  /** The snapshot `restore.json` names. */
  restoring?: string | null;
  /** state.json cannot be read, so the newest passed snapshot is unknown. */
  stateUnreadable?: boolean;
}

export interface PruneVerdict {
  remove: string[];
  /** Set when a name is dated more than 5 minutes ahead of the clock; nothing is removed then. */
  ahead: { name: string; minutes: number } | null;
}

function keepMs(kind: SnapshotKind): number | null {
  return kind === 'hourly' ? HOURLY_KEEP_MS : kind === 'daily' ? DAILY_KEEP_MS : null;
}

/** The snapshots the schedule removes: hourly ones past 48 hours and daily ones past 30 days, less the protected. */
export function pruneVerdict(list: readonly SnapshotEntry[], now: number, protect: PruneProtect): PruneVerdict {
  let ahead: PruneVerdict['ahead'] = null;
  let aheadMs = AHEAD_LIMIT_MS;
  for (const s of list) {
    if (s.time === null || s.time - now <= aheadMs) continue;
    aheadMs = s.time - now;
    ahead = { name: s.name, minutes: Math.floor(aheadMs / 60_000) };
  }
  if (ahead || protect.stateUnreadable) return { remove: [], ahead };
  let newest: SnapshotEntry | null = null;
  for (const s of list) {
    if (s.state !== 'complete' || s.time === null || keepMs(s.kind as SnapshotKind) === null) continue;
    if (!newest || (newest.time as number) < s.time) newest = s;
  }
  const kept = new Set([newest?.name, protect.lastPassed, protect.testing, protect.restoring].filter((n): n is string => !!n));
  const remove: string[] = [];
  for (const s of list) {
    if (s.state !== 'complete' || s.kind === null || s.time === null || kept.has(s.name)) continue;
    const keep = keepMs(s.kind);
    if (keep !== null && now - s.time > keep) remove.push(s.name);
  }
  return { remove, ahead: null };
}

/**
 * The `.restore-<t>` folders at the top of _snapshots that the prune removes: dated more than an hour before `now`,
 * except `keep` (the folder a `failed` journal's `leftover` names). A name whose time does not parse, or that is dated
 * ahead of the clock, is kept.
 */
export function restoreLeftovers(names: readonly string[], now: number, keep: string | null = null): string[] {
  return names.filter(name => {
    if (name === keep) return false;
    const work = parseWorkName(name);
    if (!work || work.work !== 'restore') return false;
    return work.time <= now && now - work.time > RESTORE_LEFTOVER_MS;
  });
}
