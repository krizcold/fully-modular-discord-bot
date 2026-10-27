// Config tab backups (routes/config.ts). One exact name grammar per target, so a
// prune, a listing and a restore only ever touch their own file and guild:
//
//   <stem>_[before_restore_]<stamp>_<seq>.json             a global target
//   <stem>@<guildId>_[before_restore_]<stamp>_<seq>.json   a guild target
//
// stem is the module-qualified key without .json, '/' written as '+' and every
// other character outside [A-Za-z0-9.-] written as '%' and its four hex digits
// (one UTF-16 unit), '_' included. So two keys never share a stem, and no stem
// holds the '@' that opens a guild's names or the '_' that ends the stem (a key
// ending in '_before_restore' never reads as another key's restore copy). seq is per
// target (highest + 1), so a clock stepping back never reorders the backups
// and the prune never takes the one just written.
//
// Older backups were named by the bare file id, with no seq:
// <id>_[<guildId>_][before_restore_]<stamp>.json. They still belong to their
// target: listed and restorable, never counted or removed by the prune. A
// global target whose id ends in _<digits> takes no older names, since a
// guild's older backups of a shorter id read the same. Where another file
// (another module's, or a config file) has that id, its older backups are
// marked shared and not restored; where no file of that id can be seen, or the
// guild's files are not on this process's disk (a postgres guild, or a
// file-routed one held by another node), its owner cannot be checked, and
// they are marked unchecked and not restored.

import * as fs from 'fs';
import * as path from 'path';

export const BEFORE_RESTORE = 'before_restore_';
export const KEEP_BACKUPS = 10;
const STAMP = '\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z';
const IS_WINDOWS = process.platform === 'win32';

export interface BackupEntry {
  filename: string;
  stamp: string;
  seq: number;
  beforeRestore: boolean;
  damaged: boolean;
  /** Could not be read just now, so whether it parses is unknown. */
  unreadable: boolean;
  size: number;
  /** Named before backups carried the module-qualified key. */
  legacy: boolean;
  /** An older backup whose bare id another file also has. */
  shared: boolean;
  /** An older backup whose owner cannot be checked (no file of its id is seen); also shared, so not restored. */
  unchecked: boolean;
}

/** The bare file id older backups of a target were named by, and whether another file shares it. */
export interface LegacyNames {
  id: string;
  shared: boolean;
  unchecked?: boolean;
}

export function backupStem(key: string): string {
  return key
    .replace(/\.json$/, '')
    .replace(/[^A-Za-z0-9.\-/]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
    .replace(/\//g, '+');
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function currentGrammar(key: string, guildId: string | null): RegExp {
  return new RegExp(`^${escape(backupStem(key))}${guildId ? `@${guildId}` : ''}_(${BEFORE_RESTORE})?(${STAMP})_(\\d+)\\.json$`);
}

function legacyGrammar(key: string, guildId: string | null, legacy?: LegacyNames): RegExp | null {
  const stem = (legacy?.id ?? key).replace('.json', '');
  if (!/^[A-Za-z0-9_.-]+$/.test(stem)) return null;
  if (!guildId && /_\d{5,20}$/.test(stem)) return null;
  return new RegExp(`^${escape(stem)}_${guildId ? `${guildId}_` : ''}(${BEFORE_RESTORE})?(${STAMP})\\.json$`);
}

/** A name a restore may open: no path parts, no leading dot (temp files), no '..'. */
export function isBackupFilename(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z0-9_+%@-][A-Za-z0-9_+.%@-]*\.json$/.test(name) && !name.includes('..');
}

/** How the name belongs to the target, or null when it is another target's. */
export function backupMatch(name: string, key: string, guildId: string | null, legacy?: LegacyNames): { legacy: boolean; shared: boolean; unchecked: boolean } | null {
  if (currentGrammar(key, guildId).test(name)) return { legacy: false, shared: false, unchecked: false };
  if (legacyGrammar(key, guildId, legacy)?.test(name)) return { legacy: true, shared: legacy?.shared === true, unchecked: legacy?.unchecked === true };
  return null;
}

export function backupMatchesTarget(name: string, key: string, guildId: string | null, legacy?: LegacyNames): boolean {
  return backupMatch(name, key, guildId, legacy) !== null;
}

/** The stamp in a backup name as an ISO date. */
export function stampDate(stamp: string): string {
  return stamp.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z');
}

/** 'unreadable' when the file could not be read just now (EBUSY, EPERM, EACCES): its content was not checked. */
function checkBody(file: string): 'ok' | 'damaged' | 'unreadable' {
  let body: string;
  try {
    body = fs.readFileSync(file, 'utf-8');
  } catch {
    return 'unreadable';
  }
  try {
    JSON.parse(body);
    return 'ok';
  } catch {
    return 'damaged';
  }
}

/** The target's own backups, newest first (older-named ones after the rest). */
export function listBackups(dir: string, key: string, guildId: string | null, legacy?: LegacyNames): BackupEntry[] {
  if (!fs.existsSync(dir)) return [];
  const current = currentGrammar(key, guildId);
  const older = legacyGrammar(key, guildId, legacy);
  const entries: BackupEntry[] = [];
  for (const filename of fs.readdirSync(dir)) {
    const m = current.exec(filename);
    const o = m ? null : older?.exec(filename) ?? null;
    if (!m && !o) continue;
    const full = path.join(dir, filename);
    let stats: fs.Stats;
    try {
      stats = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stats.isFile()) continue;
    const body = checkBody(full);
    const base = { filename, damaged: body === 'damaged', unreadable: body === 'unreadable', size: stats.size };
    entries.push(m
      ? { ...base, beforeRestore: !!m[1], stamp: m[2], seq: Number(m[3]), legacy: false, shared: false, unchecked: false }
      : { ...base, beforeRestore: !!o![1], stamp: o![2], seq: 0, legacy: true, shared: legacy?.shared === true, unchecked: legacy?.unchecked === true });
  }
  return entries.sort((a, b) => b.seq - a.seq || (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
}

/** Keeps the newest KEEP_BACKUPS backups that parse; a damaged, unreadable or older-named one is neither counted nor removed. */
function pruneBackups(dir: string, key: string, guildId: string | null, justWritten: string): void {
  const good = listBackups(dir, key, guildId).filter(entry => !entry.damaged && !entry.unreadable && !entry.legacy);
  for (const entry of good.slice(KEEP_BACKUPS)) {
    if (entry.filename === justWritten) continue;
    try {
      fs.unlinkSync(path.join(dir, entry.filename));
    } catch (error) {
      console.error(`[Config] Could not prune backup ${entry.filename}:`, error);
    }
  }
}

function fsyncDir(dir: string): void {
  if (IS_WINDOWS) return;
  try {
    const fd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch { /* directory fsync is best-effort */ }
}

/**
 * Writes one backup of the target durably (temp file, fsync, rename), then
 * prunes the target's own backups. created is read from the disk after the
 * prune. Throws when the backup could not be written.
 */
export function writeBackup(dir: string, key: string, guildId: string | null, body: string, beforeRestore = false): { filename: string; created: boolean } {
  fs.mkdirSync(dir, { recursive: true });
  const seq = listBackups(dir, key, guildId).reduce((max, entry) => Math.max(max, entry.seq), 0) + 1;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${backupStem(key)}${guildId ? `@${guildId}` : ''}_${beforeRestore ? BEFORE_RESTORE : ''}${stamp}_${seq}.json`;
  const final = path.join(dir, filename);
  const tmp = path.join(dir, `.${filename}.tmp`);
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, body, 'utf-8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, final);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw error;
  }
  fsyncDir(dir);
  pruneBackups(dir, key, guildId, filename);
  return { filename, created: fs.existsSync(final) };
}
