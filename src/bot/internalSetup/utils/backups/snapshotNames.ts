export type SnapshotKind = 'hourly' | 'daily' | 'pre-restore';

export const SNAPSHOT_KINDS: readonly SnapshotKind[] = ['hourly', 'daily', 'pre-restore'];

// The last millisecond whose ISO form has a four-digit year.
export const LATEST_NAMED_TIME = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

/** A UTC time as snapshot names write it: the ISO form with ':' and '.' written as '-'. */
export function formatTime(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > LATEST_NAMED_TIME) throw new RangeError(`No snapshot name for the time ${ms}`);
  return new Date(ms).toISOString().replace(/[:.]/g, '-');
}

export function parseTime(text: string): number | null {
  if (!TIME_RE.test(text)) return null;
  const iso = `${text.slice(0, 13)}:${text.slice(14, 16)}:${text.slice(17, 19)}.${text.slice(20)}`;
  const ms = Date.parse(iso);
  if (!Number.isInteger(ms) || ms < 0 || ms > LATEST_NAMED_TIME) return null;
  return formatTime(ms) === text ? ms : null;
}

export function formatSnapshotName(kind: SnapshotKind, ms: number): string {
  return `${kind}-${formatTime(ms)}`;
}

export interface ParsedName {
  kind: SnapshotKind;
  time: number;
}

export function parseSnapshotName(name: string): ParsedName | null {
  for (const kind of SNAPSHOT_KINDS) {
    if (!name.startsWith(`${kind}-`)) continue;
    const time = parseTime(name.slice(kind.length + 1));
    if (time !== null) return { kind, time };
  }
  return null;
}

/** Orders snapshot names by their time, then by name; a name that does not parse sorts after every one that does. */
export function compareSnapshotNames(a: string, b: string): number {
  const pa = parseSnapshotName(a);
  const pb = parseSnapshotName(b);
  if (pa && pb && pa.time !== pb.time) return pa.time - pb.time;
  if (pa && !pb) return -1;
  if (!pa && pb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export type WorkName =
  | { work: 'taking'; time: number; pid: number }
  | { work: 'restore' | 'pre-restore'; time: number }
  | { work: 'test' | 'delete'; name: string };

export function takingFolderName(ms: number, pid: number): string {
  return `.taking-${formatTime(ms)}-${pid}`;
}

export function restoreFolderName(ms: number): string {
  return `.restore-${formatTime(ms)}`;
}

export function preRestoreFolderName(ms: number): string {
  return `.pre-restore-${formatTime(ms)}`;
}

export function testFolderName(name: string): string {
  return `.test-${name}`;
}

export function deleteFolderName(name: string): string {
  return `.delete-${name}`;
}

/** Reads a work folder's name at the top of _snapshots; null when it is none of the five forms. */
export function parseWorkName(folder: string): WorkName | null {
  if (folder.startsWith('.taking-')) {
    const m = /^(.+)-(\d+)$/.exec(folder.slice('.taking-'.length));
    if (!m) return null;
    const time = parseTime(m[1]);
    const pid = Number(m[2]);
    return time !== null && Number.isSafeInteger(pid) && pid > 0 ? { work: 'taking', time, pid } : null;
  }
  if (folder.startsWith('.pre-restore-')) {
    const time = parseTime(folder.slice('.pre-restore-'.length));
    return time === null ? null : { work: 'pre-restore', time };
  }
  if (folder.startsWith('.restore-')) {
    const time = parseTime(folder.slice('.restore-'.length));
    return time === null ? null : { work: 'restore', time };
  }
  for (const work of ['test', 'delete'] as const) {
    const prefix = `.${work}-`;
    if (folder.startsWith(prefix) && folder.length > prefix.length) return { work, name: folder.slice(prefix.length) };
  }
  return null;
}
