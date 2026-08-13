// FileBackend - per-node disk storage carved out of the dataManager facade.
//
// Writes go through an async atomic queue: the facade stringifies
// synchronously, enqueues, and returns immediately; a per-path flusher writes
// to a temp file, fsyncs, and renames over the target so a crash never leaves
// a torn JSON file. Reads consult the queue first so a caller reading right
// after a write still sees its own bytes. The facade (dataManager.ts) owns
// freeze checks, metrics hooks, and .owner stamping; this module owns the
// queue, the filesystem, enumeration, sizing, and the graveyard.

import * as fs from 'fs';
import * as path from 'path';
import { DATA_ROOT } from '../../../../utils/dataRoot';

const BASE_DATA_DIR = DATA_ROOT;

/**
 * Ensure directory exists, create if needed
 */
export function ensureDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    console.log(`[DataManager] Created directory: ${dirPath}`);
  }
}

// ============================================================================
// ASYNC ATOMIC WRITE QUEUE
// ============================================================================

export type PendingOp =
  | { op: 'write'; content: string; seq: number }
  | { op: 'delete'; seq: number }
  | { op: 'append'; content: string; seq: number };

// Keyed by absolute target path. One in-flight flush per path (serialized), so
// a queued delete can never be overtaken by an earlier write and vice versa.
const pendingOps = new Map<string, PendingOp>();
const flushing = new Set<string>();
const scheduled = new Set<string>();
let opSeq = 0;

let flushFailures = 0;

// Monotonic tmp-name suffix so two saves to the same path in the same ms never
// collide on the temp file. Pattern mirrors fleet/fileControlStore.ts.
let tmpCounter = 0;
function tmpNameFor(target: string): string {
  return `${target}.${process.pid}.${Date.now()}.${tmpCounter++}.tmp`;
}

function scheduleFlush(absPath: string): void {
  if (scheduled.has(absPath)) return;
  scheduled.add(absPath);
  setImmediate(() => {
    scheduled.delete(absPath);
    void flushPath(absPath);
  });
}

const IS_WINDOWS = process.platform === 'win32';

async function atomicReplace(target: string, content: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const tmp = tmpNameFor(target);
  const fh = await fs.promises.open(tmp, 'w');
  try {
    await fh.writeFile(content, 'utf-8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  // Windows can throw EPERM on rename-over-existing while a reader (e.g. the
  // webui parent) holds the target open; retry with a short backoff. NEVER
  // fall back to a direct overwrite - that reintroduces the torn-file window
  // the temp+fsync+rename exists to eliminate. On exhaustion the tmp file is
  // left in place and the caller keeps the pending entry to retry later.
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(tmp, target);
      break;
    } catch (error) {
      if (attempt >= 9) throw error;
      await delay(25 * (attempt + 1));
    }
  }
  // POSIX best-effort parent-dir fsync so the rename itself is durable.
  if (!IS_WINDOWS) {
    try {
      const dh = await fs.promises.open(path.dirname(target), 'r');
      try { await dh.sync(); } finally { await dh.close(); }
    } catch { /* directory fsync is best-effort */ }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function flushPath(absPath: string): Promise<void> {
  if (flushing.has(absPath)) return;
  const entry = pendingOps.get(absPath);
  if (!entry) return;
  flushing.add(absPath);
  try {
    const seqAtStart = entry.seq;
    try {
      if (entry.op === 'write') {
        await atomicReplace(absPath, entry.content);
      } else if (entry.op === 'delete') {
        try {
          await fs.promises.unlink(absPath);
        } catch (error: any) {
          if (error?.code !== 'ENOENT') throw error;
        }
      } else {
        // append: a torn tail line on crash is tolerated (readers skip bad lines).
        // appendFile is cumulative (unlike an idempotent write overwrite), so we
        // must trim ONLY the bytes we persisted, never re-append them.
        await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
        const flushed = entry.content; // snapshot before the await
        await fs.promises.appendFile(absPath, flushed, 'utf-8');
        // A concurrent append may have grown the entry mid-flush; keep the tail.
        const cur = pendingOps.get(absPath);
        if (cur && cur.op === 'append') {
          cur.content = cur.content.slice(flushed.length);
          if (cur.content.length === 0) pendingOps.delete(absPath);
          else scheduleFlush(absPath); // flush only the remaining tail
        }
        return; // bypass the generic seq-drop below (only correct for write/delete)
      }
    } catch (error) {
      flushFailures += 1;
      console.error(`[DataManager] Flush failed for ${absPath} (will retry):`, error);
      return; // keep the pending entry + tmp file; next write / flushAll retries
    }
    // Drop the entry only if no newer op arrived while we were flushing.
    const current = pendingOps.get(absPath);
    if (current && current.seq === seqAtStart) {
      pendingOps.delete(absPath);
    } else if (current) {
      scheduleFlush(absPath);
    }
  } finally {
    flushing.delete(absPath);
  }
}

async function flushPaths(paths: string[]): Promise<void> {
  // Drain each path to empty (a re-flush may enqueue the same path again if a
  // newer op landed mid-flush). A persistently-failing flush (ENOSPC, a
  // read-only dir, EPERM exhaustion) leaves the pending entry in place with the
  // same seq and no re-schedule: detect that no-progress case and give up in
  // line after a bounded backoff rather than spinning forever. The entry stays
  // queued, so the next write / flushAll retries it (surfaced via flushFailures).
  await Promise.all(paths.map(async absPath => {
    let stuckAttempts = 0;
    while (pendingOps.has(absPath)) {
      const before = pendingOps.get(absPath)?.seq;
      await flushPath(absPath);
      const after = pendingOps.get(absPath);
      if (!after) break; // drained
      if (flushing.has(absPath)) {
        await delay(5); // another flush is in flight for this path
        continue;
      }
      if (after.seq === before) {
        // Flush failed and no newer op arrived: stop the in-line loop.
        if (++stuckAttempts >= 3) break;
        await delay(25 * stuckAttempts);
      } else {
        stuckAttempts = 0; // a newer op drained/re-queued: real progress
      }
    }
  }));
}

/**
 * Flush every queued write/delete/append to disk. Awaited on shutdown.
 */
export async function flushAll(): Promise<void> {
  await flushPaths([...pendingOps.keys()]);
}

/**
 * Flush every queued op under /data/{guildId}/.
 */
export async function flushGuild(guildId: string): Promise<void> {
  const prefix = path.join(BASE_DATA_DIR, guildId) + path.sep;
  const guildDir = path.join(BASE_DATA_DIR, guildId);
  const paths = [...pendingOps.keys()].filter(p => p === guildDir || p.startsWith(prefix));
  await flushPaths(paths);
}

/** Count of paths whose flush is currently failing (surfaced in diagnostics). */
export function getFlushFailures(): number {
  return flushFailures;
}

// ============================================================================
// QUEUE PRIMITIVES (facade CRUD builds on these)
// ============================================================================

/** The queued op for a path, if any (read-your-writes). */
export function getPending(absPath: string): PendingOp | undefined {
  return pendingOps.get(absPath);
}

export function enqueueWrite(absPath: string, content: string): void {
  pendingOps.set(absPath, { op: 'write', content, seq: ++opSeq });
  scheduleFlush(absPath);
}

export function enqueueAppend(absPath: string, line: string): void {
  const existing = pendingOps.get(absPath);
  // Coalesce consecutive appends waiting on the same flush into one op.
  if (existing && existing.op === 'append') {
    existing.content += line;
    existing.seq = ++opSeq;
  } else {
    pendingOps.set(absPath, { op: 'append', content: line, seq: ++opSeq });
  }
  scheduleFlush(absPath);
}

export function enqueueDelete(absPath: string): void {
  pendingOps.set(absPath, { op: 'delete', seq: ++opSeq });
  scheduleFlush(absPath);
}

export function existsOnDisk(absPath: string): boolean {
  return fs.existsSync(absPath);
}

export function readFileUtf8(absPath: string): string {
  return fs.readFileSync(absPath, 'utf-8');
}

/** Cross-process migration freeze sentinel for a guild. */
export function freezeSentinelExists(guildId: string): boolean {
  return fs.existsSync(path.join(BASE_DATA_DIR, guildId, '.freeze'));
}

/** Best-effort: the in-memory freeze set is the primary gate; the sentinel adds cross-process visibility. */
export async function writeFreezeSentinel(guildId: string): Promise<void> {
  try {
    const dir = path.join(BASE_DATA_DIR, guildId);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, '.freeze'), String(Date.now()), 'utf-8');
  } catch (error) {
    console.warn(`[DataManager] Could not write freeze sentinel for ${guildId}:`, error);
  }
}

export async function removeFreezeSentinel(guildId: string): Promise<void> {
  try {
    await fs.promises.unlink(path.join(BASE_DATA_DIR, guildId, '.freeze'));
  } catch { /* absent */ }
}

// ============================================================================
// RAW PATH ENTRY (root config + secondary bypassers outside the namespaces)
// ============================================================================

/** Enqueue an atomic write to an arbitrary absolute path. */
export function writeRawAtomic(absPath: string, contents: string): boolean {
  try {
    pendingOps.set(absPath, { op: 'write', content: contents, seq: ++opSeq });
    scheduleFlush(absPath);
    return true;
  } catch (error) {
    console.error(`[DataManager] Error writing raw ${absPath}:`, error);
    return false;
  }
}

/** Read an arbitrary absolute path, consulting the queue first (read-your-writes). */
export function readRaw(absPath: string): string | null {
  const pending = pendingOps.get(absPath);
  if (pending) {
    if (pending.op === 'delete') return null;
    if (pending.op === 'write') return pending.content;
  }
  try {
    if (!fs.existsSync(absPath)) return null;
    return fs.readFileSync(absPath, 'utf-8');
  } catch {
    return null;
  }
}

/** Enqueue an atomic delete of an arbitrary absolute path. */
export function deleteRawAtomic(absPath: string): boolean {
  try {
    const pending = pendingOps.get(absPath);
    if (!fs.existsSync(absPath) && (!pending || pending.op === 'delete')) return false;
    pendingOps.set(absPath, { op: 'delete', seq: ++opSeq });
    scheduleFlush(absPath);
    return true;
  } catch (error) {
    console.error(`[DataManager] Error deleting raw ${absPath}:`, error);
    return false;
  }
}

// ============================================================================
// GUILD NAMESPACE DELETION (graveyard)
// ============================================================================

const GRAVEYARD_DIR = '_graveyard';

export function guildDirExists(guildId: string): boolean {
  return fs.existsSync(path.join(BASE_DATA_DIR, guildId));
}

/** Drop queued entries for every path under /data/{guildId}. */
export function dropPendingForGuild(guildId: string): void {
  const src = path.join(BASE_DATA_DIR, guildId);
  const prefix = src + path.sep;
  for (const key of [...pendingOps.keys()]) {
    if (key === src || key.startsWith(prefix)) pendingOps.delete(key);
  }
}

/**
 * Rename /data/{guildId} under _graveyard and write a .graveyard.json reason
 * marker inside. The facade drains and drops pending state first.
 */
export async function graveyardGuildDir(guildId: string, reason: string): Promise<boolean> {
  const src = path.join(BASE_DATA_DIR, guildId);
  const graveyardRoot = path.join(BASE_DATA_DIR, GRAVEYARD_DIR);
  await fs.promises.mkdir(graveyardRoot, { recursive: true });
  const dest = path.join(graveyardRoot, `${guildId}-${Date.now()}`);

  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(src, dest);
      break;
    } catch (error) {
      if (attempt >= 9) {
        console.error(`[DataManager] Failed to move ${guildId} to graveyard:`, error);
        return false;
      }
      await delay(25 * (attempt + 1));
    }
  }

  const marker = { guildId, reason, ts: Date.now() };
  try {
    await fs.promises.writeFile(path.join(dest, '.graveyard.json'), JSON.stringify(marker, null, 2), 'utf-8');
  } catch (error) {
    console.warn(`[DataManager] Failed to write graveyard marker for ${guildId}:`, error);
  }
  console.log(`[DataManager] Guild ${guildId} moved to graveyard (${reason})`);
  return true;
}

export interface FileGraveyardEntry {
  guildId: string;
  retiredAt: number;
  reason: string;
}

/** Enumerate _graveyard entries ({guildId}-{ms} dirs), newest first. */
export async function listGraveyardEntries(): Promise<FileGraveyardEntry[]> {
  const graveyardRoot = path.join(BASE_DATA_DIR, GRAVEYARD_DIR);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(graveyardRoot, { withFileTypes: true });
  } catch {
    return []; // no graveyard yet
  }
  const out: FileGraveyardEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dashIdx = entry.name.lastIndexOf('-');
    if (dashIdx <= 0) continue;
    const guildId = entry.name.slice(0, dashIdx);
    const retiredAt = Number(entry.name.slice(dashIdx + 1));
    if (!/^\d+$/.test(guildId) || !Number.isFinite(retiredAt)) continue;
    let reason = '';
    try {
      const raw = await fs.promises.readFile(path.join(graveyardRoot, entry.name, '.graveyard.json'), 'utf-8');
      const marker = JSON.parse(raw) as { reason?: unknown };
      if (typeof marker?.reason === 'string') reason = marker.reason;
    } catch { /* marker is best-effort */ }
    out.push({ guildId, retiredAt, reason });
  }
  out.sort((a, b) => b.retiredAt - a.retiredAt);
  return out;
}

/**
 * Rename a _graveyard entry back to /data/{guildId}. Refuses when a live guild
 * dir exists or no matching entry is found (returned as {ok:false}); an actual
 * rename failure throws so callers can tell refusal from IO error.
 */
export async function restoreGuildDirFromGraveyard(guildId: string, retiredAt?: number): Promise<{ ok: boolean; error?: string }> {
  if (guildDirExists(guildId)) {
    return { ok: false, error: 'live guild data exists; delete it before restoring' };
  }
  const graveyardRoot = path.join(BASE_DATA_DIR, GRAVEYARD_DIR);
  let entryName: string | null = null;
  if (retiredAt !== undefined) {
    const candidate = `${guildId}-${retiredAt}`;
    if (fs.existsSync(path.join(graveyardRoot, candidate))) entryName = candidate;
  } else {
    const newest = (await listGraveyardEntries()).find(e => e.guildId === guildId);
    if (newest) entryName = `${guildId}-${newest.retiredAt}`;
  }
  if (!entryName) return { ok: false, error: 'no graveyard entry for this guild' };
  const dest = path.join(BASE_DATA_DIR, guildId);
  await fs.promises.rename(path.join(graveyardRoot, entryName), dest);
  await fs.promises.rm(path.join(dest, '.graveyard.json'), { force: true }).catch(() => { /* marker cleanup is best-effort */ });
  console.warn(`[DataManager] Guild ${guildId} restored from graveyard entry ${entryName}`);
  return { ok: true };
}

/**
 * Delete graveyard entries older than the TTL (default 14 days).
 */
export async function sweepGraveyard(): Promise<void> {
  const graveyardRoot = path.join(BASE_DATA_DIR, GRAVEYARD_DIR);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(graveyardRoot, { withFileTypes: true });
  } catch {
    return; // no graveyard yet
  }
  const ttlDays = Number(process.env.GRAVEYARD_TTL_DAYS);
  const ttlMs = (Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays : 14) * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - ttlMs;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(graveyardRoot, entry.name);
    // Timestamp is the trailing -{ms} suffix; fall back to mtime if absent.
    const dashIdx = entry.name.lastIndexOf('-');
    let ts = dashIdx >= 0 ? Number(entry.name.slice(dashIdx + 1)) : NaN;
    if (!Number.isFinite(ts)) {
      try { ts = (await fs.promises.stat(full)).mtimeMs; } catch { continue; }
    }
    if (ts < cutoff) {
      try {
        await fs.promises.rm(full, { recursive: true, force: true });
        console.log(`[DataManager] Swept expired graveyard entry: ${entry.name}`);
      } catch (error) {
        console.warn(`[DataManager] Failed to sweep graveyard entry ${entry.name}:`, error);
      }
    }
  }
}

// ============================================================================
// ENUMERATION + SIZING
// ============================================================================

/**
 * List all guild directories
 */
export function listGuilds(): string[] {
  try {
    const items = fs.readdirSync(BASE_DATA_DIR);
    // The numeric-only filter also excludes _graveyard, _incoming, global, dist.
    return items.filter(item => {
      const fullPath = path.join(BASE_DATA_DIR, item);
      return fs.statSync(fullPath).isDirectory() &&
             item !== 'global' && // Global data directory (not guild-specific)
             item !== 'dist' && // Build output (not guild data)
             /^\d+$/.test(item); // Guild IDs are numeric only
    });
  } catch (error) {
    console.error('[DataManager] Error listing guilds:', error);
    return [];
  }
}

/**
 * List all data files in a guild directory
 */
export function listGuildDataFiles(guildId: string, category?: string): string[] {
  try {
    const dir = category
      ? path.join(BASE_DATA_DIR, guildId, category)
      : path.join(BASE_DATA_DIR, guildId);

    if (!fs.existsSync(dir)) {
      return [];
    }

    const items = fs.readdirSync(dir);
    return items.filter(item => {
      const fullPath = path.join(dir, item);
      return fs.statSync(fullPath).isFile() && item.endsWith('.json');
    });
  } catch (error) {
    console.error(`[DataManager] Error listing guild data files for ${guildId}:`, error);
    return [];
  }
}

/**
 * List all data files in global directory
 */
export function listGlobalDataFiles(category?: string): string[] {
  try {
    const dir = category
      ? path.join(BASE_DATA_DIR, 'global', category)
      : path.join(BASE_DATA_DIR, 'global');

    if (!fs.existsSync(dir)) {
      return [];
    }

    const items = fs.readdirSync(dir);
    return items.filter(item => {
      const fullPath = path.join(dir, item);
      return fs.statSync(fullPath).isFile() && item.endsWith('.json');
    });
  } catch (error) {
    console.error('[DataManager] Error listing global data files:', error);
    return [];
  }
}

async function sizeDirectoryRecursive(dir: string, exclude?: string[]): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (exclude && entry.isDirectory() && exclude.includes(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await sizeDirectoryRecursive(fullPath);
    } else if (entry.isFile()) {
      try {
        total += (await fs.promises.stat(fullPath)).size;
      } catch { /* file vanished mid-walk */ }
    }
  }
  return total;
}

/**
 * Total size in bytes of a guild's data directory.
 */
export function sizeOfGuildData(guildId: string): Promise<number> {
  return sizeDirectoryRecursive(path.join(BASE_DATA_DIR, guildId));
}

/**
 * Total size in bytes of the global data directory. Excludes the fleet subdir
 * (control-plane state, not user data).
 */
export function sizeOfGlobalData(): Promise<number> {
  return sizeDirectoryRecursive(path.join(BASE_DATA_DIR, 'global'), ['fleet']);
}
