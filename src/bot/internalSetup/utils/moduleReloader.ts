/**
 * Module Reloader
 *
 * Orchestrates the hot-reload cycle for modules:
 * unload → recompile → clear cache → re-import → register → re-attach events/panels
 *
 * Delegates actual module loading to ModuleLoader.loadModule() — single source of truth.
 * Handles both single module and bulk reload.
 */

import { Client } from 'discord.js';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { getModuleRegistry } from './moduleRegistry';
import { getModuleEventManager } from './moduleEventManager';
import { ModuleLoader } from './moduleLoader';
import { LoadedModule } from '../../types/moduleTypes';
import { getPanelManager } from './panelManager';
import {
  findModuleManifests,
  toImportPath,
  getModuleDataPath
} from './pathHelpers';

export interface ReloadResult {
  success: boolean;
  moduleName: string;
  error?: string;
  duration?: number;
}

export interface BulkReloadResult {
  success: boolean;
  reloaded: string[];
  failed: Array<{ moduleName: string; error: string }>;
  compileDuration: number;
  totalDuration: number;
}

/**
 * Recompile TypeScript (incremental). Returns true on success.
 */
function recompileTypeScript(): { success: boolean; error?: string; duration: number } {
  const start = Date.now();
  try {
    execSync('npm run build-prod', {
      cwd: process.cwd(),
      stdio: 'pipe',
      timeout: 60000
    });
    return { success: true, duration: Date.now() - start };
  } catch (error: any) {
    const stderr = error.stderr?.toString() || error.message || 'Unknown compilation error';
    return { success: false, error: stderr, duration: Date.now() - start };
  }
}

/**
 * Clear Node's require cache for all files belonging to a module.
 */
function clearModuleCache(module: LoadedModule): void {
  for (const filePath of module.importedFiles) {
    const importPath = toImportPath(filePath);
    try {
      const resolved = require.resolve(importPath);
      delete require.cache[resolved];
    } catch {
      // Not in require cache
    }
  }
}

/**
 * Find a module's manifest path by name.
 */
function findModuleManifestPath(moduleName: string): string | null {
  const manifestPaths = findModuleManifests();
  for (const manifestPath of manifestPaths) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      if (manifest.name === moduleName) {
        return manifestPath;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * After loading a module, register its events/panels/commands and call lifecycle hooks.
 * ModuleLoader.loadModule() only creates the LoadedModule — it doesn't attach to the client.
 */
async function registerReloadedModule(client: Client, module: LoadedModule): Promise<void> {
  const registry = getModuleRegistry();
  registry.register(module);

  // Register event listeners via EventManager
  const eventManager = getModuleEventManager();
  for (const [eventName, handlers] of module.events) {
    for (const handler of handlers) {
      if (typeof handler === 'function') {
        eventManager.registerListener(module.manifest.name, eventName, handler);
      }
    }
  }

  // Register panels
  try {
    const panelManager = getPanelManager();
    for (const panel of module.panels) {
      if (panel?.id) {
        panelManager.registerPanel(panel);
      }
    }
  } catch {
    // panelManager may not be initialized
  }

  // Run command initializers (button/dropdown/modal handlers)
  for (const command of module.commands) {
    if (typeof command.initialize === 'function') {
      try {
        command.initialize(client);
      } catch (error) {
        console.error(`[Reloader] Command initialize failed for ${module.manifest.name}:`, error);
      }
    }
  }

  // Call onLoad hook
  if (module.hooks?.onLoad) {
    try {
      await module.hooks.onLoad({
        client,
        manifest: module.manifest,
        modulePath: module.path,
        dataPath: getModuleDataPath(module.manifest.name)
      });
    } catch (error) {
      console.error(`[Reloader] onLoad hook failed for ${module.manifest.name}:`, error);
    }
  }

  // Call onReady hook
  if (module.hooks?.onReady) {
    try {
      await module.hooks.onReady({
        client,
        manifest: module.manifest,
        modulePath: module.path,
        dataPath: getModuleDataPath(module.manifest.name)
      });
    } catch (error) {
      console.error(`[Reloader] onReady hook failed for ${module.manifest.name}:`, error);
    }
  }

  console.log(`[Reloader] Reloaded: ${module.manifest.displayName} v${module.manifest.version} (${module.commands.length} commands, ${module.events.size} event types, ${module.panels.length} panels)`);
}

/**
 * Re-register slash commands with Discord after reload.
 * Calls the existing registerCommands event handler.
 */
async function reRegisterSlashCommands(client: Client): Promise<void> {
  try {
    const isProd = process.env.NODE_ENV !== 'development';
    const registerPath = isProd
      ? path.join(process.cwd(), 'dist', 'bot', 'internalSetup', 'events', 'clientReady', 'registerCommands.js')
      : path.join(process.cwd(), 'src', 'bot', 'internalSetup', 'events', 'clientReady', 'registerCommands.ts');

    if (!fs.existsSync(registerPath)) {
      console.warn('[Reloader] registerCommands not found, skipping slash command sync');
      return;
    }

    // Clear cache so we get the latest version
    try {
      const resolved = require.resolve(registerPath);
      delete require.cache[resolved];
    } catch { /* ignore */ }

    const registerModule = require(registerPath);
    const registerFn = registerModule.default || registerModule;

    if (typeof registerFn === 'function') {
      await registerFn(client);
      console.log('[Reloader] Slash commands re-registered with Discord');
    }
  } catch (error) {
    console.error('[Reloader] Failed to re-register slash commands:', error);
  }
}

/**
 * Reload a single module by name.
 * The module must already be loaded (registered in the registry).
 */
export async function reloadModule(client: Client, moduleName: string): Promise<ReloadResult> {
  const start = Date.now();
  const registry = getModuleRegistry();
  const existingModule = registry.getModule(moduleName);

  if (!existingModule) {
    return { success: false, moduleName, error: `Module "${moduleName}" is not loaded` };
  }

  try {
    // 1. Unload the module (lifecycle hook, events, panels, cache)
    clearModuleCache(existingModule);
    await registry.unloadModule(moduleName);

    // 2. Recompile (incremental — only changed files)
    const compile = recompileTypeScript();
    if (!compile.success) {
      return { success: false, moduleName, error: `Compilation failed: ${compile.error}`, duration: Date.now() - start };
    }

    // 3. Re-discover and re-load the module
    const manifestPath = findModuleManifestPath(moduleName);
    if (!manifestPath) {
      return { success: false, moduleName, error: 'Module manifest not found after recompile', duration: Date.now() - start };
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const modulePath = path.dirname(manifestPath);

    // 4. Load via ModuleLoader (single source of truth)
    const loader = new ModuleLoader(client);
    const module = await loader.loadModule(manifest, modulePath);

    // 5. Register events, panels, commands, hooks
    await registerReloadedModule(client, module);

    // 6. Re-register slash commands with Discord
    await reRegisterSlashCommands(client);

    return { success: true, moduleName, duration: Date.now() - start };
  } catch (error: any) {
    return { success: false, moduleName, error: error.message || String(error), duration: Date.now() - start };
  }
}

/**
 * Reload multiple modules. Recompiles once, then reloads each module.
 */
export async function reloadModules(client: Client, moduleNames: string[]): Promise<BulkReloadResult> {
  const start = Date.now();
  const registry = getModuleRegistry();
  const result: BulkReloadResult = {
    success: true,
    reloaded: [],
    failed: [],
    compileDuration: 0,
    totalDuration: 0
  };

  // 1. Unload all target modules
  for (const name of moduleNames) {
    const existing = registry.getModule(name);
    if (existing) {
      clearModuleCache(existing);
      await registry.unloadModule(name);
    }
  }

  // 2. Single recompile for all changes
  const compile = recompileTypeScript();
  result.compileDuration = compile.duration;
  if (!compile.success) {
    result.success = false;
    for (const name of moduleNames) {
      result.failed.push({ moduleName: name, error: `Compilation failed: ${compile.error}` });
    }
    result.totalDuration = Date.now() - start;
    return result;
  }

  // 3. Reload each module via ModuleLoader
  const loader = new ModuleLoader(client);
  for (const name of moduleNames) {
    try {
      const manifestPath = findModuleManifestPath(name);
      if (!manifestPath) {
        result.failed.push({ moduleName: name, error: 'Module manifest not found' });
        continue;
      }

      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const modulePath = path.dirname(manifestPath);

      const module = await loader.loadModule(manifest, modulePath);
      await registerReloadedModule(client, module);
      result.reloaded.push(name);
    } catch (error: any) {
      result.failed.push({ moduleName: name, error: error.message || String(error) });
    }
  }

  // 4. Re-register slash commands once (covers all reloaded modules)
  if (result.reloaded.length > 0) {
    await reRegisterSlashCommands(client);
  }

  result.success = result.failed.length === 0;
  result.totalDuration = Date.now() - start;
  return result;
}
