// Data Manager - Centralized guild-aware data storage
// Handles per-guild data isolation with optional global data access.
//
// This is the module-facing facade: loadData/saveData/dataExists/deleteData
// and every helper keep their exact signatures and return values. The facade
// owns freeze checks, IO metrics, and .owner stamping; physical storage lives
// behind it (dataBackends/fileBackend.ts today: an async atomic queue where
// saveData stringifies synchronously, enqueues, and returns immediately, and
// a per-path flusher writes temp+fsync+rename so a crash never leaves a torn
// JSON file). Reads consult the queue first so a caller reading right after a
// write still sees its own bytes.

import * as path from 'path';
import { getMetricsCollector } from './metrics/metricsCollector';
import { DATA_ROOT } from '../../../utils/dataRoot';
import {
  ensureDirectory,
  getPending,
  enqueueWrite,
  enqueueAppend,
  enqueueDelete,
  existsOnDisk,
  readFileUtf8,
  freezeSentinelExists,
  guildDirExists,
  dropPendingForGuild,
  graveyardGuildDir,
  flushGuild,
  writeRawAtomic,
  listGuildDataFiles,
  listGlobalDataFiles,
} from './dataBackends/fileBackend';

export { listGuildDataFiles, listGlobalDataFiles };
export {
  flushAll,
  flushGuild,
  getFlushFailures,
  writeRawAtomic,
  readRaw,
  deleteRawAtomic,
  sweepGraveyard,
  listGuilds,
  sizeOfGuildData,
  sizeOfGlobalData,
} from './dataBackends/fileBackend';

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
  if (hasFleetEnv() && freezeSentinelExists(guildId)) return true;
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
    const pending = getPending(filePath);
    if (pending) {
      if (pending.op === 'delete') return defaultValue;
      if (pending.op === 'write') return JSON.parse(pending.content);
      // append ops fall through to disk (jsonl callers use readRaw, not loadData)
    }

    if (!existsOnDisk(filePath)) {
      console.log(`[DataManager] File not found: ${filePath} - returning default value`);
      return defaultValue;
    }

    const rawData = readFileUtf8(filePath);
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
    enqueueWrite(filePath, content);
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

    enqueueAppend(filePath, line);
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
  const pending = getPending(filePath);
  if (pending) {
    if (pending.op === 'delete') return false;
    return true;
  }
  return existsOnDisk(filePath);
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

    const pending = getPending(filePath);
    const existsNow = existsOnDisk(filePath);
    // Nothing to delete: neither a queued write nor a file on disk.
    if (!existsNow && (!pending || pending.op === 'delete')) {
      console.log(`[DataManager] File not found for deletion: ${filePath}`);
      return false;
    }

    // Enqueue a delete tombstone (serialized with in-flight writes so a queued
    // write cannot resurrect the file).
    enqueueDelete(filePath);
    console.log(`[DataManager] Deleted ${filePath}`);
    return true;
  } catch (error) {
    console.error(`[DataManager] Error deleting ${filename}:`, error);
    return false;
  }
}

// ============================================================================
// GUILD NAMESPACE DELETION (graveyard)
// ============================================================================

/**
 * Retire a guild namespace to the graveyard (same volume). Flushes and drops
 * any pending state for the guild, then renames the dir under _graveyard and
 * writes a .graveyard.json reason marker inside.
 */
export async function deleteGuildNamespace(guildId: string, reason: string): Promise<boolean> {
  if (!guildDirExists(guildId)) return false;

  await flushGuild(guildId);
  // Drop pending entries + freeze/stamp state for this guild.
  dropPendingForGuild(guildId);
  frozenGuilds.delete(guildId);
  ownerStamped.delete(guildId);

  return graveyardGuildDir(guildId, reason);
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
