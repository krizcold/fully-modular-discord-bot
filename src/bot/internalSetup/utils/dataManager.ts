// Data Manager - Centralized guild-aware data storage
// Handles per-guild data isolation with optional global data access

import * as fs from 'fs';
import * as path from 'path';

/**
 * Base data directory for all bot data
 */
const BASE_DATA_DIR = '/data';

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
    const dir = getDataDirectory(options);
    const filePath = getDataFilePath(filename, options);

    ensureDirectory(dir);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');

    console.log(`[DataManager] Saved ${filename} to ${filePath}`);
    return true;
  } catch (error) {
    console.error(`[DataManager] Error saving ${filename}:`, error);
    return false;
  }
}

/**
 * Check if data file exists
 */
export function dataExists(filename: string, options: DataOptions): boolean {
  const filePath = getDataFilePath(filename, options);
  return fs.existsSync(filePath);
}

/**
 * Delete data file
 */
export function deleteData(filename: string, options: DataOptions): boolean {
  try {
    const filePath = getDataFilePath(filename, options);

    if (!fs.existsSync(filePath)) {
      console.log(`[DataManager] File not found for deletion: ${filePath}`);
      return false;
    }

    fs.unlinkSync(filePath);
    console.log(`[DataManager] Deleted ${filePath}`);
    return true;
  } catch (error) {
    console.error(`[DataManager] Error deleting ${filename}:`, error);
    return false;
  }
}

/**
 * List all guild directories
 */
export function listGuilds(): string[] {
  try {
    const items = fs.readdirSync(BASE_DATA_DIR);
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
