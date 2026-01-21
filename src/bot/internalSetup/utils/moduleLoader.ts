import fs from 'fs';
import path from 'path';
import { Client } from 'discord.js';
import {
  ModuleManifest,
  LoadedModule,
  ModuleValidationResult,
  ModuleDependencyGraph,
  ModuleContext
} from '../../types/moduleTypes';
import { getModuleRegistry } from './moduleRegistry';
import {
  findModuleManifests,
  getModuleInfo,
  getModulePath,
  getModuleDataPath,
  resolveModuleExport,
  toImportPath,
  ensureDir
} from './pathHelpers';

/**
 * ModuleLoader - Discovers, loads, and initializes bot modules
 */
export class ModuleLoader {
  private client: Client;
  private isProd: boolean;

  constructor(client: Client) {
    this.client = client;
    this.isProd = process.env.NODE_ENV !== 'development';
  }

  /**
   * Load all modules
   * @returns Array of loaded modules
   */
  async loadAllModules(): Promise<LoadedModule[]> {
    console.log('[ModuleLoader] Starting module discovery...');

    // Step 1: Discover all module manifests
    const manifestPaths = findModuleManifests();
    console.log(`[ModuleLoader] Found ${manifestPaths.length} module manifests`);

    if (manifestPaths.length === 0) {
      console.log('[ModuleLoader] No modules found in modules/ directory');
      return [];
    }

    // Step 2: Load and validate manifests
    const manifests: Array<{ manifest: ModuleManifest; path: string }> = [];

    for (const manifestPath of manifestPaths) {
      try {
        const manifest = this.loadManifest(manifestPath);
        const validation = this.validateManifest(manifest);

        if (!validation.valid) {
          console.error(
            `[ModuleLoader] Module "${manifest.name}" validation failed:`,
            validation.errors
          );
          continue;
        }

        if (validation.warnings.length > 0) {
          console.warn(
            `[ModuleLoader] Module "${manifest.name}" warnings:`,
            validation.warnings
          );
        }

        // Skip disabled modules
        if (manifest.enabled === false) {
          console.log(`[ModuleLoader] Skipping disabled module: ${manifest.name}`);
          continue;
        }

        const { moduleName } = getModuleInfo(manifestPath);
        const modulePath = path.dirname(manifestPath);

        manifests.push({ manifest, path: modulePath });
      } catch (error) {
        console.error(`[ModuleLoader] Failed to load manifest ${manifestPath}:`, error);
      }
    }

    // Step 3: Resolve dependencies and determine load order
    const dependencyGraph = this.buildDependencyGraph(manifests.map(m => m.manifest));

    if (dependencyGraph.circularDependencies.length > 0) {
      console.error(
        '[ModuleLoader] Circular dependencies detected:',
        dependencyGraph.circularDependencies
      );
    }

    if (dependencyGraph.missingDependencies.length > 0) {
      console.error(
        '[ModuleLoader] Missing required dependencies:',
        dependencyGraph.missingDependencies
      );
    }

    // Step 4: Load modules in dependency order
    const loadedModules: LoadedModule[] = [];

    for (const moduleName of dependencyGraph.loadOrder) {
      const manifestData = manifests.find(m => m.manifest.name === moduleName);
      if (!manifestData) continue;

      try {
        const module = await this.loadModule(manifestData.manifest, manifestData.path);
        loadedModules.push(module);

        // Register in module registry
        getModuleRegistry().register(module);

        console.log(
          `[ModuleLoader] Loaded module: ${module.manifest.displayName} v${module.manifest.version}`
        );
      } catch (error) {
        console.error(`[ModuleLoader] Failed to load module ${moduleName}:`, error);
      }
    }

    console.log(`[ModuleLoader] Successfully loaded ${loadedModules.length} modules`);

    return loadedModules;
  }

  /**
   * Load a module manifest from file
   * @param manifestPath - Path to module.json
   * @returns Parsed module manifest
   */
  private loadManifest(manifestPath: string): ModuleManifest {
    const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
    return JSON.parse(manifestContent) as ModuleManifest;
  }

  /**
   * Validate a module manifest
   * @param manifest - Module manifest to validate
   * @returns Validation result
   */
  private validateManifest(manifest: ModuleManifest): ModuleValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Required fields
    if (!manifest.name) errors.push('Missing required field: name');
    if (!manifest.version) errors.push('Missing required field: version');
    if (!manifest.displayName) errors.push('Missing required field: displayName');
    if (!manifest.description) errors.push('Missing required field: description');
    if (!manifest.author) errors.push('Missing required field: author');
    if (!manifest.category) errors.push('Missing required field: category');

    // Validate name format (kebab-case)
    if (manifest.name && !/^[a-z0-9-]+$/.test(manifest.name)) {
      errors.push('Module name must be lowercase kebab-case (e.g., "my-module")');
    }

    // Validate version format (semver)
    if (manifest.version && !/^\d+\.\d+\.\d+/.test(manifest.version)) {
      warnings.push('Version should follow semver format (e.g., "1.0.0")');
    }

    // Validate category
    const validCategories = ['fun', 'misc', 'moderation', 'system'];
    if (manifest.category && !validCategories.includes(manifest.category)) {
      warnings.push(
        `Category "${manifest.category}" is not standard. Consider using: ${validCategories.join(', ')}`
      );
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Build dependency graph and determine load order
   * @param manifests - Array of module manifests
   * @returns Dependency graph with load order
   */
  private buildDependencyGraph(manifests: ModuleManifest[]): ModuleDependencyGraph {
    const dependencies = new Map<string, string[]>();
    const loadOrder: string[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const circularDependencies: string[][] = [];
    const missingDependencies: Array<{ module: string; dependency: string }> = [];

    // Build dependency map
    for (const manifest of manifests) {
      const deps: string[] = [];

      if (manifest.dependencies?.required) {
        deps.push(...Object.keys(manifest.dependencies.required));
      }

      dependencies.set(manifest.name, deps);
    }

    // Topological sort using DFS
    const visit = (name: string, path: string[] = []): void => {
      if (visited.has(name)) return;

      if (visiting.has(name)) {
        // Circular dependency detected
        circularDependencies.push([...path, name]);
        return;
      }

      visiting.add(name);

      const deps = dependencies.get(name) || [];
      for (const dep of deps) {
        // Check if dependency exists
        if (!dependencies.has(dep)) {
          missingDependencies.push({ module: name, dependency: dep });
          continue;
        }

        visit(dep, [...path, name]);
      }

      visiting.delete(name);
      visited.add(name);
      loadOrder.push(name);
    };

    // Visit all modules
    for (const manifest of manifests) {
      visit(manifest.name);
    }

    return {
      loadOrder,
      dependencies,
      circularDependencies,
      missingDependencies
    };
  }

  /**
   * Load a single module
   * @param manifest - Module manifest
   * @param modulePath - Absolute path to module directory
   * @returns Loaded module
   */
  private async loadModule(manifest: ModuleManifest, modulePath: string): Promise<LoadedModule> {
    const module: LoadedModule = {
      manifest,
      path: modulePath,
      commands: [],
      events: new Map(),
      panels: [],
      exports: new Map(),
      initialized: false
    };

    // Load commands
    const commandsPath = path.join(modulePath, 'commands');
    if (fs.existsSync(commandsPath)) {
      module.commands = await this.loadCommands(commandsPath);
    }

    // Load events
    const eventsPath = path.join(modulePath, 'events');
    if (fs.existsSync(eventsPath)) {
      module.events = await this.loadEvents(eventsPath);
    }

    // Load panels
    const panelsPath = path.join(modulePath, 'panels');
    if (fs.existsSync(panelsPath)) {
      module.panels = await this.loadPanels(panelsPath);
    }

    // Load exports
    if (manifest.exports) {
      for (const [exportName, exportPath] of Object.entries(manifest.exports)) {
        try {
          const { filePath, exportName: namedExport } = resolveModuleExport(
            modulePath,
            exportPath
          );

          const imported = await import(toImportPath(filePath));
          const exportValue = namedExport ? imported[namedExport] : imported.default;

          module.exports.set(exportName, exportValue);
        } catch (error) {
          console.error(
            `[ModuleLoader] Failed to load export "${exportName}" from ${manifest.name}:`,
            error
          );
        }
      }
    }

    return module;
  }

  /**
   * Load commands from a commands directory
   * @param commandsPath - Path to commands directory
   * @returns Array of command definitions
   */
  private async loadCommands(commandsPath: string): Promise<any[]> {
    const commands: any[] = [];

    const fileExtension = this.isProd ? '.js' : '.ts';
    const files = this.getAllFiles(commandsPath, fileExtension);

    for (const file of files) {
      try {
        const imported = await import(toImportPath(file));
        const commandDef = imported.default || imported;

        // Only register if it has a 'name' property (command definition)
        if (commandDef && typeof commandDef === 'object' && 'name' in commandDef) {
          commands.push(commandDef);
        }
      } catch (error) {
        console.error(`[ModuleLoader] Failed to load command ${file}:`, error);
      }
    }

    return commands;
  }

  /**
   * Load event handlers from an events directory
   * @param eventsPath - Path to events directory
   * @returns Map of event names to handler arrays
   */
  private async loadEvents(eventsPath: string): Promise<Map<string, Function[]>> {
    const events = new Map<string, Function[]>();

    const eventDirs = fs
      .readdirSync(eventsPath, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);

    for (const eventName of eventDirs) {
      const eventPath = path.join(eventsPath, eventName);
      const handlers: Function[] = [];

      const fileExtension = this.isProd ? '.js' : '.ts';
      const files = this.getAllFiles(eventPath, fileExtension);

      for (const file of files) {
        try {
          const imported = await import(toImportPath(file));

          // Only register if it has a default export function (event handler)
          if (imported.default && typeof imported.default === 'function') {
            handlers.push(imported.default);
          }
        } catch (error) {
          console.error(`[ModuleLoader] Failed to load event handler ${file}:`, error);
        }
      }

      if (handlers.length > 0) {
        events.set(eventName, handlers);
      }
    }

    return events;
  }

  /**
   * Load panels from a panels directory
   * @param panelsPath - Path to panels directory
   * @returns Array of panel definitions
   */
  private async loadPanels(panelsPath: string): Promise<any[]> {
    const panels: any[] = [];

    const fileExtension = this.isProd ? '.js' : '.ts';
    const files = this.getAllFiles(panelsPath, fileExtension);

    for (const file of files) {
      try {
        const imported = await import(toImportPath(file));
        const panelDef = imported.default || imported;

        // Only register if it has an 'id' property (panel definition)
        if (panelDef && typeof panelDef === 'object' && 'id' in panelDef) {
          panels.push(panelDef);
        }
      } catch (error) {
        console.error(`[ModuleLoader] Failed to load panel ${file}:`, error);
      }
    }

    return panels;
  }

  /**
   * Recursively get all files with a specific extension
   * @param dir - Directory to scan
   * @param extension - File extension to filter (e.g., '.ts')
   * @returns Array of absolute file paths
   */
  private getAllFiles(dir: string, extension: string): string[] {
    const files: string[] = [];

    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Skip disabled directories (named 'disabled' or ending with '.disabled')
        if (entry.name === 'disabled' || entry.name.endsWith('.disabled')) continue;
        files.push(...this.getAllFiles(fullPath, extension));
      } else if (entry.isFile() && entry.name.endsWith(extension)) {
        // Skip disabled files
        if (entry.name.endsWith('.disabled' + extension)) continue;
        files.push(fullPath);
      }
    }

    return files;
  }
}
