import * as fs from 'fs';
import * as path from 'path';
import type { ModuleConfigSchema, DataFileMetadata, DataFileSchema } from '../../types/moduleTypes';

// Detect production environment
const isProd = process.env.NODE_ENV !== 'development';

/**
 * Metadata for a discovered config/data file
 */
export interface ConfigFileMetadata {
  id: string;                    // Filename (e.g., 'config.json')
  path: string;                  // Full path to file
  name: string;                  // Display name
  description: string;           // Description
  category: 'config' | 'data';   // Category based on location
  exists: boolean;               // Whether file currently exists
  default?: any;                 // Default value if file doesn't exist
  schema?: ModuleConfigSchema;   // Config schema from module (if available)
  moduleName?: string;           // Module name for namespaced configs
}

/**
 * Recursively scan a directory for JSON files
 */
function scanDirectoryRecursive(
  dirPath: string,
  category: 'config' | 'data',
  prefix: string = ''
): ConfigFileMetadata[] {
  const results: ConfigFileMetadata[] = [];

  if (!fs.existsSync(dirPath)) {
    return results;
  }

  try {
    const items = fs.readdirSync(dirPath);

    for (const item of items) {
      const fullPath = path.join(dirPath, item);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        // Recursively scan subdirectory
        const subResults = scanDirectoryRecursive(
          fullPath,
          category,
          prefix ? `${prefix}/${item}` : item
        );
        results.push(...subResults);
      } else if (stat.isFile() && item.endsWith('.json')) {
        // Found a JSON file
        const id = prefix ? `${prefix}/${item}` : item;
        results.push({
          id,
          path: fullPath,
          name: prefix ? `${prefix} - ${generateDisplayName(item)}` : generateDisplayName(item),
          description: generateDescription(item, category),
          category,
          exists: true,
          default: getDefaultValue(item)
        });
      }
    }
  } catch (error) {
    console.error(`[ConfigDiscovery] Error scanning ${dirPath}:`, error);
  }

  return results;
}

/**
 * Generate human-readable name from filename
 */
function generateDisplayName(filename: string): string {
  // Remove .json extension
  const baseName = filename.replace('.json', '');

  // Handle special cases
  const specialCases: Record<string, string> = {
    'config': 'Main Bot Config',
    'update-config': 'Update Config',
  };

  if (specialCases[baseName]) {
    return specialCases[baseName];
  }

  // Convert camelCase or kebab-case to Title Case
  return baseName
    .replace(/([A-Z])/g, ' $1')  // Add space before capital letters
    .replace(/[-_]/g, ' ')        // Replace dashes/underscores with spaces
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
    .trim();
}

/**
 * Generate description from filename and category
 */
function generateDescription(filename: string, category: 'config' | 'data'): string {
  const name = generateDisplayName(filename);

  if (category === 'config') {
    return `${name} configuration`;
  } else {
    return `${name} runtime data`;
  }
}

/**
 * Get default value for a config file (if known)
 */
function getDefaultValue(filename: string): any {
  const defaults: Record<string, any> = {
    'config.json': {
      testMode: false,
      'adminPanel.itemsPerPage': 10,
      'adminPanel.enablePagination': true,
      'adminPanel.defaultCategory': 'General',
      'interaction.buttonTimeoutMs': 900000,
      'interaction.dropdownTimeoutMs': 900000,
      'system.ipc.rateLimitMs': 1000,
      'system.ipc.rateLimitCleanupThreshold': 100,
      'system.ipc.rateLimitCleanupAgeMs': 300000
    },
    'update-config.json': {},
  };

  return defaults[filename] || {};
}

/**
 * Discover all global config and data files in the system
 * Loads module schemas first, then checks for global override files
 */
export function discoverConfigFiles(): ConfigFileMetadata[] {
  const discoveredMap = new Map<string, ConfigFileMetadata>();

  // 1. Add main bot config
  const mainConfigPath = '/data/dist/bot/config.json';
  discoveredMap.set('config.json', {
    id: 'config.json',
    path: mainConfigPath,
    name: 'Main Bot Config',
    description: 'Main bot configuration',
    category: 'config',
    exists: fs.existsSync(mainConfigPath),
    default: getDefaultValue('config.json')
  });

  // 2. Load all module schemas from disk
  const schemas = discoverModuleConfigSchemasFromDisk();
  for (const schema of schemas) {
    discoveredMap.set(schema.id, schema);
  }

  // 3. Scan for any existing files that might not have schemas
  if (fs.existsSync('/data/global')) {
    const globalResults = scanDirectoryRecursive('/data/global', 'data');
    for (const file of globalResults) {
      // Check if a schema already exists for this file (by checking if any entry has the same filename)
      let foundSchema = false;
      for (const [key, existing] of discoveredMap.entries()) {
        // Compare just the filename part (e.g., "chatresponse-config.json")
        const existingFilename = key.split('/').pop();
        const scannedFilename = file.id.split('/').pop();

        if (existingFilename === scannedFilename && existing.moduleName) {
          // This file has a schema entry - just mark it as existing
          existing.exists = true;
          foundSchema = true;
          break;
        }
      }

      if (!foundSchema && !discoveredMap.has(file.id)) {
        // File exists but has no schema - add it
        discoveredMap.set(file.id, file);
      }
    }
  }

  return Array.from(discoveredMap.values());
}

/**
 * Discover guild-specific config and data files
 * Loads module schemas first, then checks for guild-specific override files
 *
 * @param guildId - Guild ID to scan
 * @returns Array of discovered configs (includes schemas even if no override file exists)
 */
export function discoverGuildConfigFiles(guildId: string): ConfigFileMetadata[] {
  const discovered = new Map<string, ConfigFileMetadata>();

  // 1. Load all module schemas from disk
  const schemas = discoverModuleConfigSchemasFromDisk();

  // 2. For each schema, create guild-specific metadata
  for (const schema of schemas) {
    // Path follows module namespace: /data/{guildId}/{moduleName}/{configId}
    const guildPath = `/data/${guildId}/${schema.moduleName}/${schema.id}`;

    discovered.set(schema.id, {
      id: schema.id,
      path: guildPath,
      name: schema.name,
      description: schema.description,
      category: 'config',
      exists: fs.existsSync(guildPath),
      default: schema.default,
      schema: schema.schema,
      moduleName: schema.moduleName
    });
  }

  // 3. Scan for any existing files that might not have schemas
  // Load data schemas to exclude them from config discovery
  // Need to include BOTH global AND guild-scoped data files in exclusion
  const globalDataSchemas = discoverModuleDataSchemasFromDisk();
  const guildDataSchemas = discoverGuildDataFiles(guildId);
  const dataFileIds = new Set([
    ...globalDataSchemas.map(d => `${d.moduleName}/${d.id.split('/').pop()}`),
    ...guildDataSchemas.map(d => `${d.moduleName}/${d.id.split('/').pop()}`)
  ]);

  const guildDir = `/data/${guildId}`;
  if (fs.existsSync(guildDir)) {
    const existingFiles = scanDirectoryRecursive(guildDir, 'data');

    for (const file of existingFiles) {
      // Extract module name and filename for comparison
      const pathParts = file.id.split('/');
      const fileKey = pathParts.length >= 2 ? `${pathParts[0]}/${pathParts[pathParts.length - 1]}` : file.id;

      // Skip if this file is a data file (defined in dataSchema)
      if (dataFileIds.has(fileKey)) {
        continue;
      }

      // Check if a schema already exists for this file
      let foundSchema = false;
      for (const [key, existing] of discovered.entries()) {
        const existingFilename = key.split('/').pop();
        const scannedFilename = file.id.split('/').pop();

        if (existingFilename === scannedFilename && existing.moduleName) {
          // This file has a schema entry - skip it (don't add duplicate)
          foundSchema = true;
          break;
        }
      }

      if (!foundSchema && !discovered.has(file.id)) {
        // File exists but has no schema - add it
        discovered.set(file.id, file);
      }
    }
  }

  return Array.from(discovered.values());
}

/**
 * Get metadata for a specific config file by ID
 */
export function getConfigFileMetadata(fileId: string): ConfigFileMetadata | null {
  const allFiles = discoverConfigFiles();
  return allFiles.find(f => f.id === fileId) || null;
}

/**
 * Check if a config file exists
 */
export function configFileExists(fileId: string): boolean {
  const metadata = getConfigFileMetadata(fileId);
  return metadata ? fs.existsSync(metadata.path) : false;
}

/**
 * Discover module config schemas from loaded modules
 * @param modules - Array of loaded modules from ModuleRegistry
 * @returns Array of config metadata including schemas
 */
export function discoverModuleConfigSchemas(modules: any[]): ConfigFileMetadata[] {
  const discovered: ConfigFileMetadata[] = [];

  for (const module of modules) {
    if (module.manifest.configSchema) {
      const schema = module.manifest.configSchema;
      const moduleName = module.manifest.name;

      // Build default values from schema
      const defaultValues: Record<string, any> = {};
      for (const [key, field] of Object.entries(schema.properties)) {
        defaultValues[key] = (field as any).default;
      }

      // Path follows module namespace: /data/global/{moduleName}/{configId}
      const configPath = `/data/global/${moduleName}/${schema.id}`;

      discovered.push({
        id: schema.id,
        path: configPath,
        name: schema.name,
        description: schema.description,
        category: 'config',
        exists: fs.existsSync(configPath),
        default: defaultValues,
        schema: schema,
        moduleName: moduleName
      });
    }
  }

  return discovered;
}

/**
 * Discover ALL possible config files (existing + schemas)
 * Combines file-based discovery with module schema discovery
 */
export function discoverAllConfigFiles(modules?: any[]): ConfigFileMetadata[] {
  const discovered = new Map<string, ConfigFileMetadata>();

  // 1. Add existing config files
  const existingFiles = discoverConfigFiles();
  for (const file of existingFiles) {
    discovered.set(file.id, file);
  }

  // 2. Add module config schemas (don't overwrite existing)
  if (modules && modules.length > 0) {
    const moduleConfigs = discoverModuleConfigSchemas(modules);
    for (const config of moduleConfigs) {
      if (!discovered.has(config.id)) {
        discovered.set(config.id, config);
      } else {
        // File exists - add schema to existing metadata
        const existing = discovered.get(config.id)!;
        existing.schema = config.schema;
      }
    }
  }

  return Array.from(discovered.values());
}

/**
 * Discover module config schemas by scanning module.json files on disk
 * (Used by Web-UI which doesn't have access to loaded modules)
 * Flat structure: modules/{moduleName}/module.json
 */
export function discoverModuleConfigSchemasFromDisk(): ConfigFileMetadata[] {
  const discovered: ConfigFileMetadata[] = [];
  // Use relative path from __dirname - works in both dev and prod
  const modulesPath = path.join(__dirname, '../../modules');

  if (!fs.existsSync(modulesPath)) {
    return discovered;
  }

  try {
    // Scan module directories directly (flat structure)
    const modules = fs.readdirSync(modulesPath, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory() && !dirent.name.endsWith('.disabled'))
      .map(dirent => dirent.name);

    for (const folderName of modules) {
      const modulePath = path.join(modulesPath, folderName);

      // Check for module.json
      const moduleJsonPath = path.join(modulePath, 'module.json');

      if (!fs.existsSync(moduleJsonPath)) continue;

      try {
        const moduleJson = JSON.parse(fs.readFileSync(moduleJsonPath, 'utf-8'));
        // Use module.json name (kebab-case), not folder name (may be camelCase)
        const moduleName = moduleJson.name || folderName;

        if (moduleJson.configSchema) {
          const schema = moduleJson.configSchema;

          // Build default values from schema
          const defaultValues: Record<string, any> = {};
          for (const [key, field] of Object.entries(schema.properties || {})) {
            defaultValues[key] = (field as any).default;
          }

          // Path follows module namespace using module.json name
          const configPath = `/data/global/${moduleName}/${schema.id}`;

          discovered.push({
            id: schema.id,
            path: configPath,
            name: schema.name,
            description: schema.description,
            category: 'config',
            exists: fs.existsSync(configPath),
            default: defaultValues,
            schema: schema,
            moduleName: moduleName
          });
        }
      } catch (error) {
        console.error(`[ConfigDiscovery] Error reading module.json for ${folderName}:`, error);
      }
    }
  } catch (error) {
    console.error(`[ConfigDiscovery] Error scanning modules directory:`, error);
  }

  return discovered;
}

/**
 * Discover all possible config files (for Web-UI)
 * Combines existing files with module schemas from disk
 */
export function discoverAllConfigFilesForWebUI(): (ConfigFileMetadata | DataFileMetadata)[] {
  const discovered = new Map<string, ConfigFileMetadata | DataFileMetadata>();

  // 1. Add existing config files
  const existingFiles = discoverConfigFiles();
  for (const file of existingFiles) {
    discovered.set(file.id, file);
  }

  // 2. Add module config schemas from disk
  const moduleConfigs = discoverModuleConfigSchemasFromDisk();
  for (const config of moduleConfigs) {
    if (!discovered.has(config.id)) {
      discovered.set(config.id, config);
    } else {
      // File exists - add schema to existing metadata
      const existing = discovered.get(config.id)!;
      if ('schema' in existing) {
        existing.schema = config.schema;
      }
    }
  }

  // 3. Add global data files from data schemas
  const globalDataFiles = discoverGlobalDataFiles();
  for (const dataFile of globalDataFiles) {
    // Use module namespace as key to avoid conflicts
    const key = `${dataFile.moduleName}/${dataFile.id}`;
    if (!discovered.has(key)) {
      discovered.set(key, dataFile);
    }
  }

  return Array.from(discovered.values());
}

// ============================================================================
// DATA SCHEMA DISCOVERY FUNCTIONS
// ============================================================================

/**
 * Discover module data schemas by scanning module.json files on disk
 * Similar to config discovery but for dataSchema property
 * Flat structure: modules/{moduleName}/module.json
 */
export function discoverModuleDataSchemasFromDisk(): DataFileMetadata[] {
  const discovered: DataFileMetadata[] = [];
  // Use relative path from __dirname - works in both dev and prod
  const modulesPath = path.join(__dirname, '../../modules');

  if (!fs.existsSync(modulesPath)) {
    return discovered;
  }

  try {
    // Scan module directories directly (flat structure)
    const modules = fs.readdirSync(modulesPath, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory() && !dirent.name.endsWith('.disabled'))
      .map(dirent => dirent.name);

    for (const folderName of modules) {
      const modulePath = path.join(modulesPath, folderName);

      // Check for module.json
      const moduleJsonPath = path.join(modulePath, 'module.json');

      if (!fs.existsSync(moduleJsonPath)) continue;

      try {
        const moduleJson = JSON.parse(fs.readFileSync(moduleJsonPath, 'utf-8'));
        // Use module.json name (kebab-case), not folder name (may be camelCase)
        const moduleName = moduleJson.name || folderName;

        if (moduleJson.dataSchema && moduleJson.dataSchema.files) {
          const dataFiles: DataFileSchema[] = moduleJson.dataSchema.files;

          for (const dataFile of dataFiles) {
            // For global scope or both scopes
            if (dataFile.scope === 'global' || dataFile.scope === 'both') {
              const globalPath = `/data/global/${moduleName}/${dataFile.id}`;

              discovered.push({
                id: dataFile.id,  // Keep original filename as ID
                path: globalPath,
                name: dataFile.name,
                description: dataFile.description,
                category: 'data',
                exists: fs.existsSync(globalPath),
                required: dataFile.required,
                template: dataFile.template,
                scope: dataFile.scope,
                moduleName: moduleName,
                schema: dataFile
              });
            }
          }
        }
      } catch (error) {
        console.error(`[ConfigDiscovery] Error reading module.json for ${folderName}:`, error);
      }
    }
  } catch (error) {
    console.error(`[ConfigDiscovery] Error scanning modules directory:`, error);
  }

  return discovered;
}

/**
 * Discover guild-specific data files
 * Loads module data schemas first, then checks for guild-specific data files
 * Flat structure: modules/{moduleName}/module.json
 *
 * @param guildId - Guild ID to scan
 * @returns Array of discovered data files (includes schemas even if no file exists)
 */
export function discoverGuildDataFiles(guildId: string): DataFileMetadata[] {
  const discovered = new Map<string, DataFileMetadata>();
  const configFileIds = new Set<string>();  // Track config file IDs to exclude from data
  const modulesPath = path.join(__dirname, '../../modules');

  if (!fs.existsSync(modulesPath)) {
    return [];
  }

  try {
    // Scan module directories directly (flat structure)
    const modules = fs.readdirSync(modulesPath, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory() && !dirent.name.endsWith('.disabled'))
      .map(dirent => dirent.name);

    for (const folderName of modules) {
      const modulePath = path.join(modulesPath, folderName);

      // Check for module.json
      const moduleJsonPath = path.join(modulePath, 'module.json');

      if (!fs.existsSync(moduleJsonPath)) continue;

      try {
        const moduleJson = JSON.parse(fs.readFileSync(moduleJsonPath, 'utf-8'));
        // Use module.json name (kebab-case), not folder name (may be camelCase)
        const moduleName = moduleJson.name || folderName;

        // Collect config file IDs to exclude them from data discovery
        if (moduleJson.configSchema && moduleJson.configSchema.id) {
          configFileIds.add(`${moduleName}/${moduleJson.configSchema.id}`);
        }

        if (moduleJson.dataSchema && moduleJson.dataSchema.files) {
          const dataFiles: DataFileSchema[] = moduleJson.dataSchema.files;

          for (const dataFile of dataFiles) {
            // For guild scope or both scopes
            if (dataFile.scope === 'guild' || dataFile.scope === 'both') {
              // Path follows module namespace using module.json name
              const guildPath = `/data/${guildId}/${moduleName}/${dataFile.id}`;

              const key = `${moduleName}/${dataFile.id}`;
              discovered.set(key, {
                id: dataFile.id,  // Keep original filename as ID
                path: guildPath,
                name: dataFile.name,
                description: dataFile.description,
                category: 'data',
                exists: fs.existsSync(guildPath),
                required: dataFile.required,
                template: dataFile.template,
                scope: dataFile.scope,
                moduleName: moduleName,
                schema: dataFile
              });
            }
          }
        }
      } catch (error) {
        console.error(`[ConfigDiscovery] Error reading module.json for ${folderName}:`, error);
      }
    }

    // Also scan for any existing files that might not have schemas
    const guildDir = `/data/${guildId}`;
    if (fs.existsSync(guildDir)) {
      const existingFiles = scanDirectoryRecursive(guildDir, 'data');

      for (const file of existingFiles) {
        // Extract module name from path (e.g., "moduleName/file.json")
        const pathParts = file.id.split('/');
        if (pathParts.length >= 2) {
          const key = `${pathParts[0]}/${pathParts[pathParts.length - 1]}`;

          // Skip if this is a config file (defined in configSchema)
          if (configFileIds.has(key)) {
            continue;
          }

          if (!discovered.has(key)) {
            // File exists but has no schema - add it as orphaned data
            // Use just the filename as id (consistent with schema-based files)
            const filename = pathParts[pathParts.length - 1];
            discovered.set(key, {
              id: filename,  // Just filename, not full path (moduleName is separate)
              path: file.path,
              name: generateDisplayName(filename),
              description: `Orphaned data file (no schema defined)`,
              category: 'data',
              exists: true,
              required: false,
              template: undefined,
              scope: 'guild',
              moduleName: pathParts[0]
            });
          }
        }
      }
    }
  } catch (error) {
    console.error(`[ConfigDiscovery] Error discovering guild data files:`, error);
  }

  return Array.from(discovered.values());
}

/**
 * Get config file IDs from all modules to exclude from data discovery
 * Flat structure: modules/{moduleName}/module.json
 */
function getConfigFileIds(): Set<string> {
  const configFileIds = new Set<string>();
  const modulesPath = path.join(__dirname, '../../modules');

  if (!fs.existsSync(modulesPath)) {
    return configFileIds;
  }

  try {
    // Scan module directories directly (flat structure)
    const modules = fs.readdirSync(modulesPath, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory() && !dirent.name.endsWith('.disabled'))
      .map(dirent => dirent.name);

    for (const folderName of modules) {
      const modulePath = path.join(modulesPath, folderName);
      const moduleJsonPath = path.join(modulePath, 'module.json');

      if (!fs.existsSync(moduleJsonPath)) continue;

      try {
        const moduleJson = JSON.parse(fs.readFileSync(moduleJsonPath, 'utf-8'));
        // Use module.json name (kebab-case), not folder name (may be camelCase)
        const moduleName = moduleJson.name || folderName;
        if (moduleJson.configSchema && moduleJson.configSchema.id) {
          configFileIds.add(`${moduleName}/${moduleJson.configSchema.id}`);
        }
      } catch {
        // Ignore parsing errors
      }
    }
  } catch {
    // Ignore errors
  }

  return configFileIds;
}

/**
 * Discover global data files
 * Loads module data schemas first, then checks for global data files
 */
export function discoverGlobalDataFiles(): DataFileMetadata[] {
  const discovered = new Map<string, DataFileMetadata>();
  const configFileIds = getConfigFileIds();  // Exclude config files

  // 1. Load all module data schemas
  const schemas = discoverModuleDataSchemasFromDisk();
  for (const schema of schemas) {
    const key = `${schema.moduleName}/${schema.id}`;
    discovered.set(key, schema);
  }

  // 2. Scan for any existing files that might not have schemas
  const globalDir = '/data/global';
  if (fs.existsSync(globalDir)) {
    const existingFiles = scanDirectoryRecursive(globalDir, 'data');

    for (const file of existingFiles) {
      // Extract module name from path
      const pathParts = file.id.split('/');
      if (pathParts.length >= 2) {
        const key = `${pathParts[0]}/${pathParts[pathParts.length - 1]}`;

        // Skip if this is a config file (defined in configSchema)
        if (configFileIds.has(key)) {
          continue;
        }

        if (!discovered.has(key)) {
          // File exists but has no schema - add it as orphaned data
          // Use just the filename as id (consistent with schema-based files)
          const filename = pathParts[pathParts.length - 1];
          discovered.set(key, {
            id: filename,  // Just filename, not full path (moduleName is separate)
            path: file.path,
            name: generateDisplayName(filename),
            description: `Orphaned data file (no schema defined)`,
            category: 'data',
            exists: true,
            required: false,
            template: undefined,
            scope: 'global',
            moduleName: pathParts[0]
          });
        } else {
          // Schema exists - mark as existing
          discovered.get(key)!.exists = true;
        }
      }
    }
  }

  return Array.from(discovered.values());
}

/**
 * Get metadata for a specific data file
 * Searches in global and guild data files
 *
 * @param fileId - Data file ID (can be just 'file.json' or 'moduleName/file.json')
 * @param guildId - Optional guild ID for guild-specific data files
 * @returns DataFileMetadata or null if not found
 */
export function getDataFileMetadata(fileId: string, guildId?: string): DataFileMetadata | null {
  // Search in global data files
  const globalFiles = discoverGlobalDataFiles();

  // Try exact match on id or module/id format
  let match = globalFiles.find(f => f.id === fileId || `${f.moduleName}/${f.id}` === fileId);
  if (match && !guildId) {
    return match;
  }

  // Search in guild data files if guildId provided
  if (guildId) {
    const guildFiles = discoverGuildDataFiles(guildId);
    match = guildFiles.find(f => f.id === fileId || `${f.moduleName}/${f.id}` === fileId);
    if (match) {
      return match;
    }
  }

  return null;
}
