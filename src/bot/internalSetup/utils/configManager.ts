import * as fs from 'fs';
import * as path from 'path';
import { getConfigFileMetadata } from './configDiscovery';
import type { ModuleConfigSchema, ConfigFieldSchema } from '../../types/moduleTypes';

// Use dist/bot/config.json in production, src/bot/config.json in development
const isProd = process.env.NODE_ENV !== 'development';
const rootConfigPath = isProd ? '/data/dist/bot/config.json' : path.join(__dirname, '../../config.json');
const guildConfigsDir = '/data/guildConfigs';

/**
 * Schema for main bot config (config.json)
 * Single source of truth for all config property defaults
 */
const MAIN_CONFIG_SCHEMA: Record<string, any> = {
  'testMode': false,
  'DEVS': [],  // Array of developer Discord user IDs with special permissions
  'adminPanel.itemsPerPage': 10,
  'adminPanel.enablePagination': true,
  'adminPanel.defaultCategory': 'General',
  'interaction.buttonTimeoutMs': 900000,
  'interaction.dropdownTimeoutMs': 900000,
  'system.ipc.rateLimitMs': 1000,
  'system.ipc.rateLimitCleanupThreshold': 100,
  'system.ipc.rateLimitCleanupAgeMs': 300000,
  // Giveaway module config (TODO: Move to module-specific config file)
  'giveaway.itemsPerPage': 10,
  'giveaway.nameDisplayCap': 50
};

/**
 * Ensures config.json is fully populated with all schema properties
 * Called ONCE during bot startup to maintain schema synchronization
 *
 * Behavior:
 * - Adds missing properties from schema with defaults
 * - Preserves existing user-configured values
 * - Removes orphaned properties not in schema
 * - Works for both development and production environments
 */
export function ensureConfigPopulated(): void {
  const configDir = path.dirname(rootConfigPath);

  // Ensure directory exists
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  // Read existing config (if exists)
  let existingConfig: Record<string, any> = {};
  if (fs.existsSync(rootConfigPath)) {
    try {
      const rawContent = fs.readFileSync(rootConfigPath, 'utf-8');
      existingConfig = JSON.parse(rawContent || '{}');
    } catch (e) {
      console.warn(`[ConfigManager] Error reading existing config, will regenerate:`, e);
      existingConfig = {};
    }
  }

  // Build fully populated config
  const populatedConfig: Record<string, any> = {};
  let addedCount = 0;
  let preservedCount = 0;

  // Iterate through schema to add all properties
  for (const [property, defaultValue] of Object.entries(MAIN_CONFIG_SCHEMA)) {
    if (existingConfig.hasOwnProperty(property)) {
      // Preserve existing user value
      populatedConfig[property] = existingConfig[property];
      preservedCount++;
    } else {
      // Add missing property from schema
      populatedConfig[property] = defaultValue;
      addedCount++;
    }
  }

  // Check for orphaned properties (in file but not in schema)
  const orphanedKeys = Object.keys(existingConfig).filter(
    key => !MAIN_CONFIG_SCHEMA.hasOwnProperty(key)
  );

  if (orphanedKeys.length > 0) {
    console.warn(`[ConfigManager] Removing orphaned properties from config.json: ${orphanedKeys.join(', ')}`);
  }

  // Write fully populated config
  try {
    fs.writeFileSync(rootConfigPath, JSON.stringify(populatedConfig, null, 2), 'utf-8');
    console.log(`[ConfigManager] Config synchronized with schema (${addedCount} added, ${preservedCount} preserved, ${orphanedKeys.length} removed)`);
  } catch (e) {
    console.error(`[ConfigManager] Error writing populated config:`, e);
  }
}

/**
 * Ensures a specific config file exists in a given directory. If not, creates an empty one.
 */
function ensureConfigFile(dirPath: string, filePath: string, defaultContent: string = '{}'): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, defaultContent, 'utf-8');
    console.log(`[ConfigManager] Created default config file: ${path.relative(path.resolve(__dirname, '../..'), filePath)}`);
  }
}

/**
 * Reads a JSON config file.
 */
function readConfigFile<T>(filePath: string, defaultValue: T): T {
  if (!fs.existsSync(filePath)) {
    return defaultValue;
  }
  try {
    const configRaw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(configRaw || JSON.stringify(defaultValue));
  } catch (e) {
    console.error(`[ConfigManager] Error reading/parsing ${path.basename(filePath)}:`, e);
    return defaultValue;
  }
}

/**
 * Retrieves a property from the ROOT config file (config.json).
 * Priority order:
 * 1. config.json (highest - user's explicit configuration)
 * 2. Environment variable (fallback - docker-compose defaults)
 * 3. Schema default (lowest - code defaults)
 *
 * Auto-documents: If property is missing from config.json, writes the default to file.
 */
export function getConfigProperty<T>(property: string): T {
  ensureConfigFile(path.dirname(rootConfigPath), rootConfigPath);

  // Get default from schema
  const defaultValue = MAIN_CONFIG_SCHEMA[property] as T;

  // Priority 1: Check if property explicitly exists in config.json
  // Read raw file to check existence without affecting other systems
  let propertyExistsInFile = false;
  let fileValue: any;

  if (fs.existsSync(rootConfigPath)) {
    try {
      const rawContent = fs.readFileSync(rootConfigPath, 'utf-8');
      const parsedConfig = JSON.parse(rawContent || '{}');
      if (parsedConfig.hasOwnProperty(property)) {
        propertyExistsInFile = true;
        fileValue = parsedConfig[property];
      }
    } catch (e) {
      console.error(`[ConfigManager] Error reading ${path.basename(rootConfigPath)}:`, e);
    }
  }

  if (propertyExistsInFile) {
    return fileValue;
  }

  // Priority 2: Check environment variable (for OPTIONAL env vars)
  const envValue = process.env[property];
  if (envValue !== undefined && envValue !== '') {
    // Filter out placeholder values from docker-compose.yml
    const isPlaceholder = typeof envValue === 'string' &&
                         (envValue.startsWith('OPTIONAL') ||
                          envValue.startsWith('REPLACE'));

    if (!isPlaceholder) {
      // Special handling for DEVS: convert comma-separated string to array
      if (property === 'DEVS') {
        const devArray = envValue.split(',').filter(id => id.trim());
        return devArray as T;
      }
      // For other properties, try to parse as JSON, fallback to string
      try {
        return JSON.parse(envValue) as T;
      } catch {
        return envValue as T;
      }
    }
  }

  // Priority 3: Use schema default (fallback only - config should already be populated)
  // If property is missing, user manually deleted it or config not yet populated
  return defaultValue;
}

/**
 * Retrieves a property with guild-specific override support.
 *
 * Config hierarchy:
 * 1. Schema defaults from MAIN_CONFIG_SCHEMA
 * 2. Base config from /data/config.json (global overrides)
 * 3. Guild-specific override from /data/guildConfigs/{guildId}.json (guild overrides)
 *
 * Guild configs only contain OVERRIDES - properties not defined in guild config
 * will fall back to base config. This allows updating base config without touching
 * individual guild configs.
 *
 * @param property Property name to retrieve
 * @param guildId Guild ID for guild-specific config (optional)
 * @returns Property value (guild override > base config > schema default)
 */
export function getConfigPropertyForGuild<T>(property: string, guildId: string | null | undefined): T {
  // Get base config value (already includes schema default)
  const baseValue = getConfigProperty<T>(property);

  // If no guild ID provided, return base value
  if (!guildId) {
    return baseValue;
  }

  // Check for guild-specific override
  const guildConfigPath = path.join(guildConfigsDir, `${guildId}.json`);

  if (!fs.existsSync(guildConfigPath)) {
    // No guild-specific config, return base value
    return baseValue;
  }

  try {
    const guildConfigRaw = fs.readFileSync(guildConfigPath, 'utf-8');
    const guildConfig = JSON.parse(guildConfigRaw || '{}');

    // If guild config has this property, use it; otherwise use base
    if (guildConfig.hasOwnProperty(property)) {
      return guildConfig[property];
    }

    return baseValue;
  } catch (e) {
    console.error(`[ConfigManager] Error reading guild config for ${guildId}:`, e);
    return baseValue;
  }
}



/**
 * Load entire guild-specific config file
 * Guild configs are stored in /data/guildConfigs/{guildId}.json
 * Module configs are stored in /data/{guildId}/{moduleName}/{filename}
 * These contain ONLY overrides - not a full config
 *
 * Note: Defaults come from schemas, not parameters
 */
export function loadGuildConfig(filename: string, guildId: string): any {
  // For guild-specific config files in /data/guildConfigs/
  if (filename === 'config.json') {
    const guildConfigPath = path.join(guildConfigsDir, `${guildId}.json`);
    return readConfigFile(guildConfigPath, {});
  }

  // For module config files, use metadata to get correct path
  const metadata = getConfigFileMetadata(filename);
  if (metadata && metadata.moduleName) {
    // Construct guild-specific path using moduleName
    const filePath = path.join('/data', guildId, metadata.moduleName, filename);
    return readConfigFile(filePath, {});
  }

  // Fallback: construct path without moduleName (legacy)
  const filePath = path.join('/data', guildId, filename);
  return readConfigFile(filePath, {});
}

/**
 * Save entire guild-specific config file
 * Guild configs are stored in /data/guildConfigs/{guildId}.json
 * Module configs are stored in /data/{guildId}/{moduleName}/{filename}
 */
export function saveGuildConfig(filename: string, guildId: string, data: any): void {
  // For guild-specific config files in /data/guildConfigs/
  if (filename === 'config.json') {
    const guildConfigPath = path.join(guildConfigsDir, `${guildId}.json`);

    if (!fs.existsSync(guildConfigsDir)) {
      fs.mkdirSync(guildConfigsDir, { recursive: true });
    }

    fs.writeFileSync(guildConfigPath, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`[ConfigManager] Saved guild config: ${guildConfigPath}`);
    return;
  }

  // For module config files, use metadata to get correct path
  const metadata = getConfigFileMetadata(filename);
  let filePath: string;

  if (metadata && metadata.moduleName) {
    // Construct guild-specific path using moduleName
    filePath = path.join('/data', guildId, metadata.moduleName, filename);
  } else {
    // Fallback: construct path without moduleName (legacy)
    filePath = path.join('/data', guildId, filename);
  }

  const dirPath = path.dirname(filePath);

  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`[ConfigManager] Saved config: ${filePath}`);
}

/**
 * Load global config file (main config.json or discovered module data files)
 * Returns ONLY overrides from file, not schema defaults
 * Returns {} if file doesn't exist (no overrides)
 *
 * Note: Defaults come from schemas, not parameters
 */
export function loadGlobalConfig(filename: string): any {
  if (filename === 'config.json') {
    return readConfigFile(rootConfigPath, {});
  }

  // For discovered module data files
  const metadata = getConfigFileMetadata(filename);
  if (metadata && metadata.moduleName) {
    // Construct path using moduleName for consistency
    const filePath = path.join('/data/global', metadata.moduleName, filename);
    if (fs.existsSync(filePath)) {
      return readConfigFile(filePath, {});
    }
    // File doesn't exist - return empty (no overrides)
    return {};
  }

  // Fallback: construct path from global + filename
  const filePath = path.join('/data/global', filename);
  return readConfigFile(filePath, {});
}

/**
 * Save global config file (main config.json or discovered module data files)
 */
export function saveGlobalConfig(filename: string, data: any): void {
  if (filename === 'config.json') {
    fs.writeFileSync(rootConfigPath, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`[ConfigManager] Saved global config: ${rootConfigPath}`);
    return;
  }

  // For discovered module data files
  const metadata = getConfigFileMetadata(filename);
  let filePath: string;

  if (metadata && metadata.moduleName) {
    // Construct path using moduleName for proper namespace
    filePath = path.join('/data/global', metadata.moduleName, filename);
  } else if (metadata && metadata.path) {
    // Use metadata path if available
    filePath = metadata.path;
  } else {
    // Fallback: construct path from global + filename (legacy)
    filePath = path.join('/data/global', filename);
  }

  const dirPath = path.dirname(filePath);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`[ConfigManager] Saved config: ${filePath}`);
}

/**
 * Represents a single config value with metadata about its source
 */
export interface MergedConfigValue {
  /** The actual value */
  value: any;

  /** Whether this value is explicitly set in a config file */
  isSet: boolean;

  /** Source of this value */
  source: 'file' | 'global' | 'default';

  /** Description from schema (if available) */
  description?: string;

  /** Type from schema (if available) */
  type?: string;
}

/**
 * Merged configuration with all possible keys and their sources
 */
export interface MergedConfig {
  /** Map of property name to config value with metadata */
  properties: Record<string, MergedConfigValue>;

  /** Config file metadata */
  metadata: {
    id: string;
    name: string;
    description: string;
    hasSchema: boolean;
  };
}

/**
 * Build default values from a config schema
 */
function buildDefaultsFromSchema(schema: ModuleConfigSchema): Record<string, any> {
  const defaults: Record<string, any> = {};

  for (const [key, field] of Object.entries(schema.properties)) {
    defaults[key] = field.default;
  }

  return defaults;
}

/**
 * Get merged configuration showing all possible keys with their values and sources
 *
 * For global configs:
 * - Shows all schema properties (if schema exists)
 * - Marks which values are set in file vs using defaults
 *
 * For guild configs:
 * - Shows all schema properties (if schema exists)
 * - Marks which values are set in guild file, global file, or using defaults
 *
 * @param fileId - Config file ID (e.g., 'config.json')
 * @param guildId - Optional guild ID for guild-specific configs
 * @returns Merged config with all properties and their sources
 */
export function getMergedConfig(fileId: string, guildId?: string | null): MergedConfig {
  // Get file metadata (includes schema if available)
  const metadata = getConfigFileMetadata(fileId);

  const result: MergedConfig = {
    properties: {},
    metadata: {
      id: fileId,
      name: metadata?.name || fileId,
      description: metadata?.description || '',
      hasSchema: !!metadata?.schema
    }
  };

  // 1. Build defaults from schema (if available)
  const schemaDefaults: Record<string, any> = {};
  const schemaFields: Record<string, ConfigFieldSchema> = {};

  if (metadata?.schema) {
    for (const [key, field] of Object.entries(metadata.schema.properties)) {
      schemaDefaults[key] = field.default;
      schemaFields[key] = field;
    }
  }

  // 2. Load actual saved values
  let savedValues: Record<string, any> = {};
  let globalValues: Record<string, any> = {};

  if (guildId) {
    // Guild config: load both guild and global
    savedValues = loadGuildConfig(fileId, guildId);
    globalValues = loadGlobalConfig(fileId);
  } else {
    // Global config: just load global
    savedValues = loadGlobalConfig(fileId);
  }

  // 3. Collect all unique keys from all sources
  const allKeys = new Set<string>();

  // Add keys from schema
  Object.keys(schemaDefaults).forEach(k => allKeys.add(k));

  // Add keys from saved values
  Object.keys(savedValues).forEach(k => allKeys.add(k));

  // Add keys from global values (for guild configs)
  if (guildId) {
    Object.keys(globalValues).forEach(k => allKeys.add(k));
  }

  // 4. Merge all values with source tracking
  for (const key of allKeys) {
    const hasInFile = savedValues.hasOwnProperty(key);
    const hasInGlobal = guildId && globalValues.hasOwnProperty(key);
    const hasInSchema = schemaDefaults.hasOwnProperty(key);

    let value: any;
    let source: 'file' | 'global' | 'default';
    let isSet: boolean;

    if (hasInFile) {
      // Value is explicitly set in file
      value = savedValues[key];
      source = 'file';
      isSet = true;
    } else if (hasInGlobal) {
      // Guild config: value is set in global but not in guild file
      value = globalValues[key];
      source = 'global';
      isSet = false; // Not set in THIS file
    } else if (hasInSchema) {
      // Value comes from schema default
      value = schemaDefaults[key];
      source = 'default';
      isSet = false;
    } else {
      // Value exists in saved file but not in schema (orphaned config)
      value = savedValues[key];
      source = 'file';
      isSet = true;
    }

    result.properties[key] = {
      value,
      isSet,
      source,
      description: schemaFields[key]?.description,
      type: schemaFields[key]?.type
    };
  }

  return result;
}

