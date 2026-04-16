/**
 * Module Reloader
 *
 * Orchestrates the hot-reload cycle for modules:
 * unload → recompile → clear cache → re-import → register → re-attach events/panels
 *
 * Delegates actual module loading to ModuleLoader.loadModule(), single source of truth.
 * Handles both single module and bulk reload.
 */

import { Client, ApplicationCommandType } from 'discord.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { getModuleRegistry } from './moduleRegistry';
import { getModuleEventManager } from './moduleEventManager';
import { ModuleLoader } from './moduleLoader';
import { LoadedModule } from '../../types/moduleTypes';
import { getPanelManager } from './panelManager';
import {
  findModuleManifests,
  getModuleDataPath,
  getBuildRoot
} from './pathHelpers';
import { applyComponentToggleState } from './ipcToggleHandler';
import { reRegisterSlashCommands } from './commandUtils';
import { isAutoCleanupEnabled } from '../events/clientReady/registerCommands';
import { clearSchemaCache, getModulesWithSettings } from './settings/settingsDiscovery';
import { createAllSettingsPanels } from './settings/settingsPanelFactory';

interface CapturedCommand {
  name: string;
  type: number;
  testOnly: boolean;
}

async function deleteModuleCommandsFromDiscord(
  client: Client,
  commands: CapturedCommand[]
): Promise<void> {
  if (commands.length === 0) return;
  if (!isAutoCleanupEnabled()) return;

  try {
    const guildId = process.env.GUILD_ID;
    const guild = guildId ? client.guilds.cache.get(guildId) : undefined;
    const globalCommands = await client.application?.commands.fetch();
    const guildCommands = guild ? await guild.commands.fetch() : undefined;

    for (const cmd of commands) {
      const list = cmd.testOnly ? guildCommands : globalCommands;
      const mgr = cmd.testOnly ? guild?.commands : client.application?.commands;
      if (!list || !mgr) continue;

      const match = list.find(c => c.name === cmd.name && c.type === cmd.type);
      if (!match) continue;

      try {
        await mgr.delete(match.id);
        console.log(`[Reloader] Deleted ${cmd.testOnly ? 'local' : 'global'} command "${cmd.name}" from Discord`);
      } catch (err: any) {
        if (err?.code === 10063) {
          console.debug(`[Reloader] Command "${cmd.name}" already gone on Discord (10063)`);
        } else {
          console.error(`[Reloader] Failed to delete command "${cmd.name}":`, err);
        }
      }
    }
  } catch (err) {
    console.error('[Reloader] Failed during targeted command cleanup:', err);
  }
}

// Guard against concurrent reloads of the same module
const reloadingModules: Set<string> = new Set();
let recompileInProgress = false;

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

const execAsync = promisify(exec);

/**
 * Recompile TypeScript (incremental, non-blocking).
 * Uses async exec so the event loop stays alive (Discord heartbeats, etc.).
 * Serialized: only one recompile runs at a time.
 */
const ASSET_EXTENSIONS = new Set(['.json', '.css', '.html', '.jsx', '.js']);

function copyBuildAssetsToDist(): void {
  const buildRoot = getBuildRoot();
  const distRoot = path.join(process.cwd(), 'dist');
  if (!fs.existsSync(buildRoot) || buildRoot === distRoot) return;

  const walk = (srcDir: string, dstDir: string) => {
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(srcDir, entry.name);
      const dstPath = path.join(dstDir, entry.name);
      if (entry.isDirectory()) {
        walk(srcPath, dstPath);
      } else if (ASSET_EXTENSIONS.has(path.extname(entry.name))) {
        fs.mkdirSync(path.dirname(dstPath), { recursive: true });
        fs.copyFileSync(srcPath, dstPath);
      }
    }
  };

  try {
    walk(buildRoot, distRoot);
  } catch (err) {
    console.error('[Reloader] Asset copy failed:', err);
  }
}

async function recompileTypeScript(): Promise<{ success: boolean; error?: string; duration: number }> {
  if (recompileInProgress) {
    return new Promise(resolve => {
      const check = setInterval(() => {
        if (!recompileInProgress) {
          clearInterval(check);
          resolve({ success: true, duration: 0 });
        }
      }, 200);
    });
  }

  recompileInProgress = true;
  const start = Date.now();
  try {
    const tscBin = path.join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
    await execAsync(`"${tscBin}" -p tsconfig.json`, {
      cwd: process.cwd(),
      timeout: 60000
    });
    copyBuildAssetsToDist();
    return { success: true, duration: Date.now() - start };
  } catch (error: any) {
    const stderr = error.stderr?.toString() || error.message || 'Unknown compilation error';
    return { success: false, error: stderr, duration: Date.now() - start };
  } finally {
    recompileInProgress = false;
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
 * ModuleLoader.loadModule() only creates the LoadedModule, it doesn't attach to the client.
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

  // Snapshot BEFORE panel registration, since panels call panel.initialize(client)
  // which may register interaction handlers too.
  const bBefore = new Set(Array.from(((client as any).buttonHandlers ?? new Map()).keys()));
  const mBefore = new Set(Array.from(((client as any).modalHandlers ?? new Map()).keys()));
  const dBefore = new Set(Array.from(((client as any).dropdownHandlers ?? new Map()).keys()));

  // Register module-defined panels
  try {
    const panelManager = getPanelManager();
    for (const panel of module.panels) {
      if (panel?.id) {
        panelManager.registerPanel(panel);
      }
    }

    // Generate and register auto-created settings panels from settingsSchema.json
    clearSchemaCache();
    const modulesWithSettings = getModulesWithSettings(true);
    const thisModule = modulesWithSettings.find(m => m.name === module.manifest.name);
    if (thisModule) {
      const settingsPanels = createAllSettingsPanels([thisModule]);
      for (const panel of settingsPanels) {
        panelManager.registerPanel(panel);
        if (typeof panel.initialize === 'function') {
          panel.initialize(client);
        }
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

  const bAfter = Array.from(((client as any).buttonHandlers ?? new Map()).keys()) as string[];
  const mAfter = Array.from(((client as any).modalHandlers ?? new Map()).keys()) as string[];
  const dAfter = Array.from(((client as any).dropdownHandlers ?? new Map()).keys()) as string[];
  module.registeredInteractionIds = {
    buttons: bAfter.filter(k => !bBefore.has(k)),
    modals: mAfter.filter(k => !mBefore.has(k)),
    dropdowns: dAfter.filter(k => !dBefore.has(k))
  };

  // Re-apply component toggle state (keep disabled components off after reload)
  await applyComponentToggleState(client, module);

  console.log(`[Reloader] Reloaded: ${module.manifest.displayName} v${module.manifest.version} (${module.commands.length} commands, ${module.events.size} event types, ${module.panels.length} panels)`);
}

/**
 * Reload a single module by name.
 * Works for both existing modules (unload → reload) and fresh installs (just load).
 */
export async function reloadModule(client: Client, moduleName: string): Promise<ReloadResult> {
  if (reloadingModules.has(moduleName)) {
    return { success: false, moduleName, error: 'Module is already being reloaded' };
  }

  reloadingModules.add(moduleName);
  const start = Date.now();

  try {
    const registry = getModuleRegistry();
    const existingModule = registry.getModule(moduleName);

    // Atomic swap: prepare new module before touching registry so a mid-flight
    // failure leaves the old module registered.
    const compile = await recompileTypeScript();
    if (!compile.success) {
      return { success: false, moduleName, error: `Compilation failed: ${compile.error}`, duration: Date.now() - start };
    }

    const manifestPath = findModuleManifestPath(moduleName);
    if (!manifestPath) {
      return { success: false, moduleName, error: 'Module manifest not found after recompile', duration: Date.now() - start };
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const modulePath = path.dirname(manifestPath);

    const loader = new ModuleLoader(client);
    const newModule = await loader.loadModule(manifest, modulePath);

    if (existingModule) {
      await registry.unloadModule(moduleName);
    }
    await registerReloadedModule(client, newModule);

    await reRegisterSlashCommands(client, { runOrphanCleanup: false });

    const action = existingModule ? 'Reloaded' : 'Loaded';
    console.log(`[Reloader] ${action}: ${moduleName} (${Date.now() - start}ms)`);
    return { success: true, moduleName, duration: Date.now() - start };
  } catch (error: any) {
    return { success: false, moduleName, error: error.message || String(error), duration: Date.now() - start };
  } finally {
    reloadingModules.delete(moduleName);
  }
}

/**
 * Unload a module from memory (for uninstall).
 * Removes events, panels, commands, cache. Module is fully gone from runtime.
 */
export async function unloadModuleFromMemory(client: Client, moduleName: string): Promise<ReloadResult> {
  if (reloadingModules.has(moduleName)) {
    return { success: false, moduleName, error: 'Module is currently being reloaded' };
  }

  const start = Date.now();
  const registry = getModuleRegistry();
  const existingModule = registry.getModule(moduleName);

  if (!existingModule) {
    return { success: true, moduleName, duration: 0 };
  }

  const capturedCommands: CapturedCommand[] = existingModule.commands
    .filter((c: any) => c && typeof c.name === 'string')
    .map((c: any) => ({
      name: c.name,
      type: (c.type ?? ApplicationCommandType.ChatInput) as number,
      testOnly: !!c.testOnly
    }));

  try {
    await registry.unloadModule(moduleName);
    await deleteModuleCommandsFromDiscord(client, capturedCommands);
    await reRegisterSlashCommands(client, { runOrphanCleanup: false });

    console.log(`[Reloader] Unloaded: ${moduleName} (${Date.now() - start}ms)`);
    return { success: true, moduleName, duration: Date.now() - start };
  } catch (error: any) {
    return { success: false, moduleName, error: error.message || String(error), duration: Date.now() - start };
  }
}

/**
 * Reload multiple modules. Recompiles once, then reloads each module.
 */
export async function reloadModules(client: Client, moduleNames: string[]): Promise<BulkReloadResult> {
  // Filter out modules that are already being reloaded
  const available = moduleNames.filter(n => !reloadingModules.has(n));
  const skipped = moduleNames.filter(n => reloadingModules.has(n));

  const start = Date.now();
  const registry = getModuleRegistry();
  const result: BulkReloadResult = {
    success: true,
    reloaded: [],
    failed: skipped.map(n => ({ moduleName: n, error: 'Module is already being reloaded' })),
    compileDuration: 0,
    totalDuration: 0
  };

  // Mark all as reloading
  for (const name of available) reloadingModules.add(name);

  try {
    // 1. Unload all target modules
    for (const name of available) {
      const existing = registry.getModule(name);
      if (existing) {
        await registry.unloadModule(name);
      }
    }

    // 2. Single recompile for all changes
    const compile = await recompileTypeScript();
    result.compileDuration = compile.duration;
    if (!compile.success) {
      result.success = false;
      for (const name of available) {
        result.failed.push({ moduleName: name, error: `Compilation failed: ${compile.error}` });
      }
      result.totalDuration = Date.now() - start;
      return result;
    }

    // 3. Reload each module via ModuleLoader
    const loader = new ModuleLoader(client);
    for (const name of available) {
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

    if (result.reloaded.length > 0) {
      await reRegisterSlashCommands(client, { runOrphanCleanup: false });
    }

    result.success = result.failed.length === 0;
    result.totalDuration = Date.now() - start;
    return result;
  } finally {
    for (const name of available) reloadingModules.delete(name);
  }
}
