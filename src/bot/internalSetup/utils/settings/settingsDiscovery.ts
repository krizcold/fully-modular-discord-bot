/**
 * Settings Discovery
 *
 * Discovers and loads settingsSchema.json files from modules.
 * Updated for flat module structure - category comes from module.json manifest.
 */

import fs from 'fs';
import path from 'path';
import { SettingsSchema, ModuleWithSettings } from '@bot/types/settingsTypes';
import { getModulesDir, getModulesDevDir, getModuleInfo, getModulePath } from '../pathHelpers';

/** Cache for loaded schemas */
const schemaCache = new Map<string, SettingsSchema>();

/** Cache for module list with settings */
let modulesWithSettingsCache: ModuleWithSettings[] | null = null;

/**
 * Find all settingsSchema.json files in modules and modulesDev
 * Flat structure: modules/{moduleName}/settingsSchema.json
 * Dev structure: modulesDev/{repoName}/Modules/{moduleName}/settingsSchema.json
 * @returns Array of paths to settingsSchema.json files
 */
export function findSettingsSchemas(): string[] {
  const schemas: string[] = [];

  // Scan main modules directory
  const modulesDir = getModulesDir();
  if (fs.existsSync(modulesDir)) {
    const modules = fs.readdirSync(modulesDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory() && !dirent.name.endsWith('.disabled'))
      .map(dirent => dirent.name);

    for (const moduleName of modules) {
      const schemaPath = path.join(modulesDir, moduleName, 'settingsSchema.json');
      if (fs.existsSync(schemaPath)) {
        schemas.push(schemaPath);
      }
    }
  }

  // Scan modulesDev directory
  const modulesDevDir = getModulesDevDir();
  if (fs.existsSync(modulesDevDir)) {
    const repos = fs.readdirSync(modulesDevDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory() && !dirent.name.startsWith('.'))
      .map(dirent => dirent.name);

    for (const repoName of repos) {
      const repoModulesDir = path.join(modulesDevDir, repoName, 'Modules');
      if (fs.existsSync(repoModulesDir)) {
        const devModules = fs.readdirSync(repoModulesDir, { withFileTypes: true })
          .filter(dirent => dirent.isDirectory() && !dirent.name.endsWith('.disabled'))
          .map(dirent => dirent.name);

        for (const moduleName of devModules) {
          const schemaPath = path.join(repoModulesDir, moduleName, 'settingsSchema.json');
          if (fs.existsSync(schemaPath)) {
            schemas.push(schemaPath);
          }
        }
      }
    }
  }

  return schemas;
}

/**
 * Get category from module.json manifest
 * @param modulePath - Path to module directory
 * @returns Category string or 'misc' as default
 */
function getCategoryFromManifest(modulePath: string): string {
  const manifestPath = path.join(modulePath, 'module.json');

  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      return manifest.category || 'misc';
    } catch {
      return 'misc';
    }
  }

  return 'misc';
}

/**
 * Load a settings schema from a file path
 * @param schemaPath - Absolute path to settingsSchema.json
 * @returns Parsed SettingsSchema or null if failed
 */
export function loadSchemaFromPath(schemaPath: string): SettingsSchema | null {
  try {
    const content = fs.readFileSync(schemaPath, 'utf-8');
    const schema = JSON.parse(content) as SettingsSchema;

    // Basic validation
    if (!schema.id || !schema.name || !schema.scope) {
      console.error(`[SettingsDiscovery] Invalid schema at ${schemaPath}: missing required fields`);
      return null;
    }

    return schema;
  } catch (error) {
    console.error(`[SettingsDiscovery] Failed to load schema at ${schemaPath}:`, error);
    return null;
  }
}

/**
 * Load a settings schema for a specific module
 * @param moduleName - Module name (folder name, e.g., 'responseManager')
 * @param _category - Deprecated parameter, kept for backwards compatibility
 * @returns SettingsSchema or null if not found
 */
export function loadSettingsSchema(
  moduleName: string,
  _category?: string
): SettingsSchema | null {
  // Check cache first
  if (schemaCache.has(moduleName)) {
    return schemaCache.get(moduleName)!;
  }

  const modulePath = getModulePath(moduleName);
  const schemaPath = path.join(modulePath, 'settingsSchema.json');

  if (fs.existsSync(schemaPath)) {
    const schema = loadSchemaFromPath(schemaPath);
    if (schema) {
      schemaCache.set(moduleName, schema);
      return schema;
    }
  }

  return null;
}

/**
 * Get all modules that have settings schemas
 * @param forceRefresh - Force refresh of cached list
 * @returns Array of ModuleWithSettings
 */
export function getModulesWithSettings(forceRefresh = false): ModuleWithSettings[] {
  if (modulesWithSettingsCache && !forceRefresh) {
    return modulesWithSettingsCache;
  }

  const schemaPaths = findSettingsSchemas();
  const modules: ModuleWithSettings[] = [];

  for (const schemaPath of schemaPaths) {
    const schema = loadSchemaFromPath(schemaPath);
    if (!schema) continue;

    // Extract module name from path
    const { moduleName } = getModuleInfo(schemaPath);
    const modulePath = path.dirname(schemaPath);

    // Get category from module.json manifest
    const category = getCategoryFromManifest(modulePath);

    // Try to get display name from module.json if exists
    const moduleJsonPath = path.join(modulePath, 'module.json');
    let displayName = schema.name;

    if (fs.existsSync(moduleJsonPath)) {
      try {
        const moduleJson = JSON.parse(fs.readFileSync(moduleJsonPath, 'utf-8'));
        displayName = moduleJson.displayName || moduleJson.name || schema.name;
      } catch {
        // Use schema name as fallback
      }
    }

    modules.push({
      name: moduleName,
      displayName,
      category,
      path: modulePath,
      schema,
    });

    // Cache the schema
    schemaCache.set(moduleName, schema);
  }

  // Sort by category, then by displayName
  modules.sort((a, b) => {
    if (a.category !== b.category) {
      return a.category.localeCompare(b.category);
    }
    return a.displayName.localeCompare(b.displayName);
  });

  modulesWithSettingsCache = modules;
  return modules;
}

/**
 * Clear all cached schemas
 * Useful when schemas might have changed
 */
export function clearSchemaCache(): void {
  schemaCache.clear();
  modulesWithSettingsCache = null;
}

/**
 * Get a cached schema by module name
 * Only returns if already cached (doesn't load from disk)
 * @param moduleName - Module name
 * @returns Cached schema or undefined
 */
export function getCachedSchema(moduleName: string): SettingsSchema | undefined {
  return schemaCache.get(moduleName);
}

/**
 * Check if a module has a settings schema
 * @param moduleName - Module name
 * @param _category - Deprecated parameter, kept for backwards compatibility
 * @returns true if module has a settings schema
 */
export function hasSettingsSchema(moduleName: string, _category?: string): boolean {
  const modulePath = getModulePath(moduleName);
  const schemaPath = path.join(modulePath, 'settingsSchema.json');
  return fs.existsSync(schemaPath);
}

/**
 * Get schema for a module, loading if necessary
 * @param moduleName - Module name
 * @param _category - Deprecated parameter, kept for backwards compatibility
 * @returns Schema or null
 */
export function getSettingsSchema(
  moduleName: string,
  _category?: string
): SettingsSchema | null {
  // Try cache first
  const cached = getCachedSchema(moduleName);
  if (cached) return cached;

  // Load from disk
  return loadSettingsSchema(moduleName);
}
