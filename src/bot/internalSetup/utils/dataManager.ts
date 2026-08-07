// Data Manager - Centralized guild-aware data storage
// Handles per-guild data isolation with optional global data access.
//
// Writes go through an async atomic queue: saveData stringifies synchronously,
// enqueues, and returns immediately; a per-path flusher writes to a temp file,
// fsyncs, and renames over the target so a crash never leaves a torn JSON file.
// The module-facing API (loadData/saveData/dataExists/deleteData and every
// helper) keeps its exact signatures and return values; only durability timing
// changes (a bounded ms window). Reads consult the queue first so a caller
// reading right after a write still sees its own bytes.

import * as fs from 'fs';
import * as path from 'path';
import { getMetricsCollector } from './metrics/metricsCollector';
import { DATA_ROOT } from '../../../utils/dataRoot';

/**
 * Base data directory for all bot data
 */
const BASE_DATA_DIR = DATA_ROOT;

/**
 * Data scope - either guild-specific or global
 */
export type DataScope = 'guild' | 'global';

/**
 * Options for loading/saving data
 */
export interface DataOptions {
  /**
   * Guild ID for guild-scoped data (required if scope is 'guild')
   */
  guildId?: string | null;

  /**
   * Data scope - defaults to 'guild'
   */
  scope?: DataScope;

  /**
   * Custom subdirectory within guild/global folder
   * Example: 'giveaways', 'responses', 'users'
   */
  category?: string;
}

/**
 * Get the directory path for data storage
 */
function getDataDirectory(options: DataOptions): string {
  const scope = options.scope || 'guild';

  if (scope === 'global') {
    // Global data: /data/global/
    const dir = path.join(BASE_DATA_DIR, 'global');
    if (options.category) {
      return path.join(dir, options.category);
    }
    return dir;
  }

  // Guild data: /data/{guildId}/
  if (!options.guildId) {
    throw new Error('[DataManager] guildId is required for guild-scoped data');
  }

  const dir = path.join(BASE_DATA_DIR, options.guildId);
  if (options.category) {
    return path.join(dir, options.category);
  }
  return dir;
}

/**
 * Get the full file path for a data file
 */
function getDataFilePath(filename: string, options: DataOptions): string {
  const dir = getDataDirectory(options);
  return path.join(dir, filename);
}

/**
 * Ensure directory exists, create if needed
 */
function ensureDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    console.log(`[DataManager] Created directory: ${dirPath}`);
  }
}

// ============================================================================
// ASYNC ATOMIC WRITE QUEUE
// ============================================================================

type PendingOp =
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
// FREEZE (migration drain choke point)
// ============================================================================

// Cached: the write path only consults the .freeze sentinel when NOT standalone,
// so a standalone box (incl. a master with BOT_NODE_ROLE=master and no
// CONTROL_SECRET) pays zero extra per-write syscalls. This mirrors
// nodeIdentity.isStandalone (master role + no CONTROL_SECRET); the role
// resolution is duplicated locally to keep dataManager free of a fleet import.
let cachedFleetEnv: boolean | null = null;
function hasFleetEnv(): boolean {
  if (cachedFleetEnv === null) {
    const explicitRole = (process.env.BOT_NODE_ROLE || '').trim().toLowerCase();
    const isCoWorker = explicitRole === 'co-worker'
      || (explicitRole !== 'master' && (process.env.MASTER_URL || '').trim() !== '');
    const isStandalone = !isCoWorker && (process.env.CONTROL_SECRET || '').trim() === '';
    cachedFleetEnv = !isStandalone;
  }
  return cachedFleetEnv;
}

const frozenGuilds = new Set<string>();
let frozenWriteRejections = 0;
const rejectionsAtFreeze = new Map<string, number>();

export function freezeGuildWrites(guildId: string): void {
  frozenGuilds.add(guildId);
  rejectionsAtFreeze.set(guildId, frozenWriteRejections);
}

export function unfreezeGuildWrites(guildId: string): void {
  const atFreeze = rejectionsAtFreeze.get(guildId);
  rejectionsAtFreeze.delete(guildId);
  if (frozenGuilds.delete(guildId) && atFreeze !== undefined) {
    // Counter is facade-global, so with several guilds frozen at once the
    // delta attributes all rejections in the window to each; observability
    // only, exact counts live with the rejecting writer's own handling.
    const dropped = frozenWriteRejections - atFreeze;
    if (dropped > 0) console.log(`[Data] Guild ${guildId} unfrozen; ${dropped} frozen-write rejection(s) during the freeze window`);
  }
}

export function getFrozenStats(): { frozenGuilds: string[]; frozenWriteRejections: number } {
  return { frozenGuilds: [...frozenGuilds], frozenWriteRejections };
}

// Returns true when writes to this guild must be rejected (in-memory freeze set,
// or the cross-process .freeze sentinel when fleet env is present).
function isGuildFrozen(options: DataOptions): boolean {
  if ((options.scope || 'guild') !== 'guild') return false;
  const guildId = options.guildId;
  if (!guildId) return false;
  if (frozenGuilds.has(guildId)) return true;
  if (hasFleetEnv() && fs.existsSync(path.join(BASE_DATA_DIR, guildId, '.freeze'))) return true;
  return false;
}

/**
 * Route-visible freeze check: the same gate the facade rejects writes with,
 * including the cross-process .freeze sentinel, so the webui process can refuse
 * an operator save instead of silently dropping it.
 */
export function isGuildWriteFrozen(guildId: string): boolean {
  return isGuildFrozen({ guildId });
}

// ============================================================================
// .owner MANIFESTS
// ============================================================================

export interface OwnerInfo {
  nodeId: string;
  term: number;
  epoch: number;
  shardCount: number;
}

let ownerInfoProvider: (() => OwnerInfo | null) | null = null;
// Guilds whose .owner has been stamped this process lifetime (no per-write cost).
const ownerStamped = new Set<string>();

/**
 * Wire the owner-info source (fleet/bootstrap after init). dataManager cannot
 * import fleet, so ownership is injected. Provider null (early boot) -> skip.
 */
export function setOwnerInfoProvider(fn: () => OwnerInfo | null): void {
  ownerInfoProvider = fn;
}

// Local copy of the guild->shard formula (placement.ts) to avoid an import
// cycle (fleet imports the facade, not vice versa).
function guildIdToShardId(guildId: string, shardCount: number): number {
  try {
    return Number((BigInt(guildId) >> 22n) % BigInt(Math.max(1, shardCount)));
  } catch {
    return 0;
  }
}

/**
 * Stamp /data/{guildId}/.owner if not yet done this process lifetime. Enqueued
 * through the same atomic queue. No-op when no provider is wired.
 */
export function stampOwner(guildId: string): void {
  if (ownerStamped.has(guildId)) return;
  const info = ownerInfoProvider?.();
  if (!info) return;
  ownerStamped.add(guildId);
  const manifest = {
    guildId,
    shardId: guildIdToShardId(guildId, info.shardCount),
    nodeId: info.nodeId,
    term: info.term,
    epoch: info.epoch,
    updatedAt: Date.now(),
  };
  const target = path.join(BASE_DATA_DIR, guildId, '.owner');
  writeRawAtomic(target, JSON.stringify(manifest, null, 2));
}

// ============================================================================
// LOAD / SAVE
// ============================================================================

/**
 * Load JSON data from file
 * Returns defaultValue if file doesn't exist or on error
 */
export function loadData<T = any>(
  filename: string,
  options: DataOptions,
  defaultValue: T
): T {
  try {
    const filePath = getDataFilePath(filename, options);
    getMetricsCollector().recordIO('read', options.scope === 'global' ? null : options.guildId ?? null, options.category ?? null);

    // Read-your-writes: a queued op is authoritative over disk.
    const pending = pendingOps.get(filePath);
    if (pending) {
      if (pending.op === 'delete') return defaultValue;
      if (pending.op === 'write') return JSON.parse(pending.content);
      // append ops fall through to disk (jsonl callers use readRaw, not loadData)
    }

    if (!fs.existsSync(filePath)) {
      console.log(`[DataManager] File not found: ${filePath} - returning default value`);
      return defaultValue;
    }

    const rawData = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(rawData || JSON.stringify(defaultValue));
  } catch (error) {
    console.error(`[DataManager] Error loading ${filename}:`, error);
    return defaultValue;
  }
}

/**
 * Save JSON data to file
 * Automatically creates directory if needed
 */
export function saveData<T = any>(
  filename: string,
  options: DataOptions,
  data: T
): boolean {
  try {
    if (isGuildFrozen(options)) {
      frozenWriteRejections += 1;
      return false;
    }
    const dir = getDataDirectory(options);
    const filePath = getDataFilePath(filename, options);
    const scope = options.scope || 'guild';

    // Ensure the dir synchronously so the guild dir exists (and .owner can be
    // stamped) the moment the save is accepted, matching today's create timing.
    ensureDirectory(dir);
    if (scope === 'guild' && options.guildId) stampOwner(options.guildId);

    const content = JSON.stringify(data, null, 2);
    pendingOps.set(filePath, { op: 'write', content, seq: ++opSeq });
    scheduleFlush(filePath);
    getMetricsCollector().recordIO('write', scope === 'global' ? null : options.guildId ?? null, options.category ?? null);

    console.log(`[DataManager] Saved ${filename} to ${filePath}`);
    return true;
  } catch (error) {
    console.error(`[DataManager] Error saving ${filename}:`, error);
    return false;
  }
}

/**
 * Append a line to a data file (serialized through the same queue). A torn tail
 * line on crash is tolerated by callers (they skip bad lines on read).
 */
export function appendData(filename: string, options: DataOptions, line: string): boolean {
  try {
    if (isGuildFrozen(options)) {
      frozenWriteRejections += 1;
      return false;
    }
    const dir = getDataDirectory(options);
    const filePath = getDataFilePath(filename, options);
    const scope = options.scope || 'guild';
    ensureDirectory(dir);
    if (scope === 'guild' && options.guildId) stampOwner(options.guildId);

    const existing = pendingOps.get(filePath);
    // Coalesce consecutive appends waiting on the same flush into one op.
    if (existing && existing.op === 'append') {
      existing.content += line;
      existing.seq = ++opSeq;
    } else {
      pendingOps.set(filePath, { op: 'append', content: line, seq: ++opSeq });
    }
    scheduleFlush(filePath);
    getMetricsCollector().recordIO('write', scope === 'global' ? null : options.guildId ?? null, options.category ?? null);
    return true;
  } catch (error) {
    console.error(`[DataManager] Error appending ${filename}:`, error);
    return false;
  }
}

/**
 * Check if data file exists
 */
export function dataExists(filename: string, options: DataOptions): boolean {
  const filePath = getDataFilePath(filename, options);
  const pending = pendingOps.get(filePath);
  if (pending) {
    if (pending.op === 'delete') return false;
    return true;
  }
  return fs.existsSync(filePath);
}

/**
 * Delete data file
 */
export function deleteData(filename: string, options: DataOptions): boolean {
  try {
    if (isGuildFrozen(options)) {
      frozenWriteRejections += 1;
      return false;
    }
    const filePath = getDataFilePath(filename, options);

    const pending = pendingOps.get(filePath);
    const existsOnDisk = fs.existsSync(filePath);
    // Nothing to delete: neither a queued write nor a file on disk.
    if (!existsOnDisk && (!pending || pending.op === 'delete')) {
      console.log(`[DataManager] File not found for deletion: ${filePath}`);
      return false;
    }

    // Enqueue a delete tombstone (serialized with in-flight writes so a queued
    // write cannot resurrect the file).
    pendingOps.set(filePath, { op: 'delete', seq: ++opSeq });
    scheduleFlush(filePath);
    console.log(`[DataManager] Deleted ${filePath}`);
    return true;
  } catch (error) {
    console.error(`[DataManager] Error deleting ${filename}:`, error);
    return false;
  }
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

/**
 * Retire a guild namespace to the graveyard (same volume). Flushes and drops
 * any pending state for the guild, then renames the dir under _graveyard and
 * writes a .graveyard.json reason marker inside.
 */
export async function deleteGuildNamespace(guildId: string, reason: string): Promise<boolean> {
  const src = path.join(BASE_DATA_DIR, guildId);
  if (!fs.existsSync(src)) return false;

  await flushGuild(guildId);
  // Drop pending entries + freeze/stamp state for this guild.
  const prefix = src + path.sep;
  for (const key of [...pendingOps.keys()]) {
    if (key === src || key.startsWith(prefix)) pendingOps.delete(key);
  }
  frozenGuilds.delete(guildId);
  ownerStamped.delete(guildId);

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
  console.warn(`[DataManager] Guild ${guildId} moved to graveyard (${reason})`);
  return true;
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
 * Helper: Load guild-scoped data
 */
export function loadGuildData<T = any>(
  filename: string,
  guildId: string,
  defaultValue: T,
  category?: string
): T {
  return loadData(filename, { guildId, scope: 'guild', category }, defaultValue);
}

/**
 * Helper: Save guild-scoped data
 */
export function saveGuildData<T = any>(
  filename: string,
  guildId: string,
  data: T,
  category?: string
): boolean {
  return saveData(filename, { guildId, scope: 'guild', category }, data);
}

/**
 * Helper: Load global data
 */
export function loadGlobalData<T = any>(
  filename: string,
  defaultValue: T,
  category?: string
): T {
  return loadData(filename, { scope: 'global', category }, defaultValue);
}

/**
 * Helper: Save global data
 */
export function saveGlobalData<T = any>(
  filename: string,
  data: T,
  category?: string
): boolean {
  return saveData(filename, { scope: 'global', category }, data);
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

// ============================================================================
// MODULE-NAMESPACED DATA HELPERS
// ============================================================================

/**
 * Load module-scoped data (guild-specific)
 * Automatically namespaces data by module name
 *
 * @param filename - Data filename (supports subfolders: 'archive/2024.json')
 * @param guildId - Guild ID
 * @param moduleName - Module name (used as namespace)
 * @param defaultValue - Default value if file doesn't exist
 * @returns Loaded data or default value
 *
 * @example
 * // Loads from: /data/{guildId}/giveaway/data.json
 * loadModuleData('data.json', '123456', 'giveaway', {})
 *
 * // Loads from: /data/{guildId}/giveaway/archive/2024.json
 * loadModuleData('archive/2024.json', '123456', 'giveaway', [])
 */
export function loadModuleData<T = any>(
  filename: string,
  guildId: string,
  moduleName: string,
  defaultValue: T
): T {
  return loadGuildData(filename, guildId, defaultValue, moduleName);
}

/**
 * Save module-scoped data (guild-specific)
 * Automatically namespaces data by module name
 *
 * @param filename - Data filename (supports subfolders: 'archive/2024.json')
 * @param guildId - Guild ID
 * @param moduleName - Module name (used as namespace)
 * @param data - Data to save
 * @returns True if saved successfully
 *
 * @example
 * // Saves to: /data/{guildId}/giveaway/data.json
 * saveModuleData('data.json', '123456', 'giveaway', { active: true })
 */
export function saveModuleData<T = any>(
  filename: string,
  guildId: string,
  moduleName: string,
  data: T
): boolean {
  return saveGuildData(filename, guildId, data, moduleName);
}

/**
 * Load global module data
 * Automatically namespaces data by module name
 *
 * @param filename - Data filename (supports subfolders)
 * @param moduleName - Module name (used as namespace)
 * @param defaultValue - Default value if file doesn't exist
 * @returns Loaded data or default value
 *
 * @example
 * // Loads from: /data/global/analytics/stats.json
 * loadGlobalModuleData('stats.json', 'analytics', {})
 */
export function loadGlobalModuleData<T = any>(
  filename: string,
  moduleName: string,
  defaultValue: T
): T {
  return loadGlobalData(filename, defaultValue, moduleName);
}

/**
 * Save global module data
 * Automatically namespaces data by module name
 *
 * @param filename - Data filename (supports subfolders)
 * @param moduleName - Module name (used as namespace)
 * @param data - Data to save
 * @returns True if saved successfully
 *
 * @example
 * // Saves to: /data/global/analytics/stats.json
 * saveGlobalModuleData('stats.json', 'analytics', { totalUsers: 100 })
 */
export function saveGlobalModuleData<T = any>(
  filename: string,
  moduleName: string,
  data: T
): boolean {
  return saveGlobalData(filename, data, moduleName);
}

/**
 * List all data files for a module (guild-specific)
 *
 * @param guildId - Guild ID
 * @param moduleName - Module name
 * @returns Array of filenames
 *
 * @example
 * listModuleDataFiles('123456', 'giveaway')
 * // Returns: ['data.json', 'archive/2024.json', ...]
 */
export function listModuleDataFiles(guildId: string, moduleName: string): string[] {
  return listGuildDataFiles(guildId, moduleName);
}

/**
 * List all global data files for a module
 *
 * @param moduleName - Module name
 * @returns Array of filenames
 *
 * @example
 * listGlobalModuleDataFiles('analytics')
 * // Returns: ['stats.json', 'reports.json', ...]
 */
export function listGlobalModuleDataFiles(moduleName: string): string[] {
  return listGlobalDataFiles(moduleName);
}

/**
 * Check if module data file exists (guild-specific)
 *
 * @param filename - Data filename
 * @param guildId - Guild ID
 * @param moduleName - Module name
 * @returns True if file exists
 */
export function moduleDataExists(
  filename: string,
  guildId: string,
  moduleName: string
): boolean {
  return dataExists(filename, { guildId, scope: 'guild', category: moduleName });
}

/**
 * Check if global module data file exists
 *
 * @param filename - Data filename
 * @param moduleName - Module name
 * @returns True if file exists
 */
export function globalModuleDataExists(filename: string, moduleName: string): boolean {
  return dataExists(filename, { scope: 'global', category: moduleName });
}

/**
 * Delete module data file (guild-specific)
 *
 * @param filename - Data filename
 * @param guildId - Guild ID
 * @param moduleName - Module name
 * @returns True if deleted successfully
 */
export function deleteModuleData(
  filename: string,
  guildId: string,
  moduleName: string
): boolean {
  return deleteData(filename, { guildId, scope: 'guild', category: moduleName });
}

/**
 * Delete global module data file
 *
 * @param filename - Data filename
 * @param moduleName - Module name
 * @returns True if deleted successfully
 */
export function deleteGlobalModuleData(filename: string, moduleName: string): boolean {
  return deleteData(filename, { scope: 'global', category: moduleName });
}

// ============================================================================
// SIZE HELPERS (async recursive stat)
// ============================================================================

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
