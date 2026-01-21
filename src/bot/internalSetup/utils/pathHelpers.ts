import path from 'path';
import fs from 'fs';

/**
 * Get the root directory of the bot
 * @returns Absolute path to the bot root directory
 */
export function getBotRoot(): string {
  // In development: /data/src/bot
  // In production: /data/dist/bot
  return __dirname.includes('/dist/')
    ? path.join(__dirname, '../..')
    : path.join(__dirname, '../..');
}

/**
 * Get the modules directory path
 * @returns Absolute path to the modules directory
 */
export function getModulesDir(): string {
  return path.join(getBotRoot(), 'modules');
}

/**
 * Get the modulesDev directory path (for App Store development)
 * @returns Absolute path to the modulesDev directory
 */
export function getModulesDevDir(): string {
  return path.join(getBotRoot(), 'modulesDev');
}

/**
 * Get the path to a specific module (flat structure)
 * @param moduleName - Module name
 * @returns Absolute path to the module directory
 */
export function getModulePath(moduleName: string): string {
  return path.join(getModulesDir(), moduleName);
}

/**
 * Get the data directory for a module
 * @param moduleName - Module name
 * @param guildId - Guild ID (optional, for global data use null)
 * @returns Absolute path to the module's data directory
 */
export function getModuleDataPath(moduleName: string, guildId?: string | null): string {
  const dataRoot = path.join(process.cwd(), 'data');

  if (guildId) {
    return path.join(dataRoot, guildId, moduleName);
  } else {
    return path.join(dataRoot, 'global', moduleName);
  }
}

/**
 * Get the path to a specific data file within a module
 * @param moduleName - Module name
 * @param filename - Data filename (can include subfolders, e.g., "archive/2024.json")
 * @param guildId - Guild ID (optional, for global data use null)
 * @returns Absolute path to the data file
 */
export function getModuleDataFilePath(
  moduleName: string,
  filename: string,
  guildId?: string | null
): string {
  return path.join(getModuleDataPath(moduleName, guildId), filename);
}

/**
 * Ensure a directory exists, creating it if necessary
 * @param dirPath - Directory path to ensure
 */
export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Resolve a module export path
 * Format: "path/to/file.ts#exportName" or "path/to/file.ts"
 * @param modulePath - Absolute path to module directory
 * @param exportPath - Export path string from module.json
 * @returns { filePath: string, exportName?: string }
 */
export function resolveModuleExport(modulePath: string, exportPath: string): {
  filePath: string;
  exportName?: string;
} {
  const [relativeFilePath, exportName] = exportPath.split('#');

  // Remove .ts extension if present (for require/import)
  const filePathWithoutExt = relativeFilePath.endsWith('.ts')
    ? relativeFilePath.slice(0, -3)
    : relativeFilePath;

  const filePath = path.join(modulePath, filePathWithoutExt);

  return {
    filePath,
    exportName
  };
}

/**
 * Find all module.json files in the modules directory and modulesDev directory
 * Flat structure: modules/{moduleName}/module.json
 * Dev structure: modulesDev/{repoName}/Modules/{moduleName}/module.json
 * @returns Array of absolute paths to module.json files
 */
export function findModuleManifests(): string[] {
  const manifests: string[] = [];

  // Scan main modules directory (flat structure)
  const modulesDir = getModulesDir();
  if (fs.existsSync(modulesDir)) {
    const modules = fs.readdirSync(modulesDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory() && !dirent.name.endsWith('.disabled'))
      .map(dirent => dirent.name);

    for (const moduleName of modules) {
      const manifestPath = path.join(modulesDir, moduleName, 'module.json');
      if (fs.existsSync(manifestPath)) {
        manifests.push(manifestPath);
      }
    }
  }

  // Scan modulesDev directory (App Store repos in development)
  // Structure: modulesDev/{repoName}/Modules/{moduleName}/module.json
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
          const manifestPath = path.join(repoModulesDir, moduleName, 'module.json');
          if (fs.existsSync(manifestPath)) {
            manifests.push(manifestPath);
          }
        }
      }
    }
  }

  return manifests;
}

/**
 * Get module name from manifest path
 * @param manifestPath - Absolute path to module.json
 * @returns { moduleName: string }
 */
export function getModuleInfo(manifestPath: string): {
  moduleName: string;
} {
  const parts = manifestPath.split(path.sep);
  const moduleName = parts[parts.length - 2];

  return { moduleName };
}

/**
 * Convert file path to proper import path for dynamic imports
 * @param filePath - Absolute file path
 * @returns Import-compatible path
 */
export function toImportPath(filePath: string): string {
  // Windows: Convert backslashes to forward slashes
  // Remove .ts extension if present
  let importPath = filePath.replace(/\\/g, '/');

  if (importPath.endsWith('.ts')) {
    importPath = importPath.slice(0, -3);
  }

  return importPath;
}
