import { LoadedModule, ModuleManifest, ModuleExport } from '../../types/moduleTypes';

/**
 * ModuleRegistry - Central registry for all loaded modules
 * Manages module metadata, exports, and cross-module communication
 */
export class ModuleRegistry {
  private modules: Map<string, LoadedModule> = new Map();
  private exports: Map<string, Map<string, any>> = new Map();

  /**
   * Register a module in the registry
   * @param module - Loaded module to register
   */
  register(module: LoadedModule): void {
    this.modules.set(module.manifest.name, module);

    // Register module exports
    if (module.exports.size > 0) {
      this.exports.set(module.manifest.name, module.exports);
    }
  }

  /**
   * Unregister a module from the registry
   * @param moduleName - Name of module to unregister
   */
  unregister(moduleName: string): void {
    this.modules.delete(moduleName);
    this.exports.delete(moduleName);
  }

  /**
   * Get a module by name
   * @param moduleName - Module name
   * @returns LoadedModule or undefined
   */
  getModule(moduleName: string): LoadedModule | undefined {
    return this.modules.get(moduleName);
  }

  /**
   * Get all registered modules
   * @returns Array of loaded modules
   */
  getAllModules(): LoadedModule[] {
    return Array.from(this.modules.values());
  }

  /**
   * Get modules by category
   * @param category - Category name (fun, misc, moderation, system)
   * @returns Array of modules in category
   */
  getModulesByCategory(category: string): LoadedModule[] {
    return this.getAllModules().filter(m => m.manifest.category === category);
  }

  /**
   * Check if a module is loaded
   * @param moduleName - Module name
   * @returns True if module is loaded
   */
  isLoaded(moduleName: string): boolean {
    return this.modules.has(moduleName);
  }

  /**
   * Check if a module is enabled
   * @param moduleName - Module name
   * @returns True if module is enabled
   */
  isEnabled(moduleName: string): boolean {
    const module = this.modules.get(moduleName);
    return module ? (module.manifest.enabled !== false) : false;
  }

  /**
   * Get an exported value from a module
   * @param moduleName - Module that exports the value
   * @param exportName - Name of the export
   * @returns Exported value or undefined
   */
  getExport<T = any>(moduleName: string, exportName: string): T | undefined {
    const moduleExports = this.exports.get(moduleName);
    if (!moduleExports) {
      return undefined;
    }

    return moduleExports.get(exportName) as T | undefined;
  }

  /**
   * Check if a module has a specific export
   * @param moduleName - Module name
   * @param exportName - Export name
   * @returns True if export exists
   */
  hasExport(moduleName: string, exportName: string): boolean {
    const moduleExports = this.exports.get(moduleName);
    return moduleExports ? moduleExports.has(exportName) : false;
  }

  /**
   * Get all exports from a module
   * @param moduleName - Module name
   * @returns Map of export names to values
   */
  getModuleExports(moduleName: string): Map<string, any> | undefined {
    return this.exports.get(moduleName);
  }

  /**
   * Validate module dependencies
   * @param manifest - Module manifest to validate
   * @returns { valid: boolean, missing: string[] }
   */
  validateDependencies(manifest: ModuleManifest): {
    valid: boolean;
    missing: string[];
  } {
    const missing: string[] = [];

    // Check required dependencies
    if (manifest.dependencies?.required) {
      for (const depName of Object.keys(manifest.dependencies.required)) {
        if (!this.isLoaded(depName)) {
          missing.push(depName);
        }
      }
    }

    return {
      valid: missing.length === 0,
      missing
    };
  }

  /**
   * Get module dependency chain
   * @param moduleName - Module to get dependencies for
   * @param visited - Internal: Track visited modules to detect cycles
   * @returns Array of module names in dependency order
   */
  getDependencies(moduleName: string, visited: Set<string> = new Set()): string[] {
    const module = this.modules.get(moduleName);
    if (!module || visited.has(moduleName)) {
      return [];
    }

    visited.add(moduleName);
    const dependencies: string[] = [];

    // Add required dependencies
    if (module.manifest.dependencies?.required) {
      for (const depName of Object.keys(module.manifest.dependencies.required)) {
        dependencies.push(depName);
        dependencies.push(...this.getDependencies(depName, visited));
      }
    }

    return Array.from(new Set(dependencies)); // Remove duplicates
  }

  /**
   * Get modules that depend on a specific module
   * @param moduleName - Module to check dependents for
   * @returns Array of module names that depend on this module
   */
  getDependents(moduleName: string): string[] {
    const dependents: string[] = [];

    for (const [name, module] of this.modules) {
      const deps = module.manifest.dependencies?.required || {};
      const optionalDeps = module.manifest.dependencies?.optional || {};

      if (deps[moduleName] || optionalDeps[moduleName]) {
        dependents.push(name);
      }
    }

    return dependents;
  }

  /**
   * Get count of loaded modules
   * @returns Number of modules loaded
   */
  getModuleCount(): number {
    return this.modules.size;
  }

  /**
   * Get count of enabled modules
   * @returns Number of enabled modules
   */
  getEnabledModuleCount(): number {
    return this.getAllModules().filter(m => m.manifest.enabled !== false).length;
  }

  /**
   * Clear all registered modules (for testing/hot-reload)
   */
  clear(): void {
    this.modules.clear();
    this.exports.clear();
  }

  /**
   * Get module statistics
   * @returns Module statistics object
   */
  getStats(): {
    total: number;
    enabled: number;
    disabled: number;
    byCategory: Record<string, number>;
    totalExports: number;
  } {
    const all = this.getAllModules();
    const enabled = all.filter(m => m.manifest.enabled !== false);
    const disabled = all.filter(m => m.manifest.enabled === false);

    const byCategory: Record<string, number> = {};
    for (const module of all) {
      const cat = module.manifest.category;
      byCategory[cat] = (byCategory[cat] || 0) + 1;
    }

    const totalExports = Array.from(this.exports.values())
      .reduce((sum, exports) => sum + exports.size, 0);

    return {
      total: all.length,
      enabled: enabled.length,
      disabled: disabled.length,
      byCategory,
      totalExports
    };
  }
}

// Singleton instance
let registryInstance: ModuleRegistry | null = null;

/**
 * Get the global module registry instance
 * @returns ModuleRegistry singleton
 */
export function getModuleRegistry(): ModuleRegistry {
  if (!registryInstance) {
    registryInstance = new ModuleRegistry();
  }
  return registryInstance;
}

/**
 * Reset the module registry (for testing)
 */
export function resetModuleRegistry(): void {
  registryInstance = new ModuleRegistry();
}
