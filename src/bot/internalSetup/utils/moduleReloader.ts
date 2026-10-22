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
import { ModuleLoader, hotLoadRefusal } from './moduleLoader';
import { LoadedModule, ModuleManifest } from '../../types/moduleTypes';
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
import { getMetricsCollector } from './metrics/metricsCollector';
import { resolveClientApplication } from './clientApplication';
import { beginReload, endReload, recordLoadFailure } from './loadFailures';

interface CapturedCommand {
  name: string;
  type: number;
  testOnly: boolean;
}

export async function deleteModuleCommandsFromDiscord(
  client: Client,
  commands: CapturedCommand[]
): Promise<void> {
  if (commands.length === 0) return;
  if (!isAutoCleanupEnabled()) return;

  try {
    const guildId = process.env.GUILD_ID;
    const application = await resolveClientApplication(client);
    if (!application) {
      console.error(`[Reloader] Commands not deleted from Discord (${commands.map(c => c.name).join(', ')}): the bot application could not be resolved`);
      return;
    }
    const globalCommands = await application.commands.fetch();
    const hasTestOnly = commands.some(c => c.testOnly);
    if (hasTestOnly && !guildId) {
      console.error('[Reloader] Test-only commands not deleted from Discord: GUILD_ID is not set');
    }
    const guildCommands = hasTestOnly && guildId ? await application.commands.fetch({ guildId }) : undefined;

    for (const cmd of commands) {
      const list = cmd.testOnly ? guildCommands : globalCommands;
      if (!list) continue;

      const match = list.find(c => c.name === cmd.name && c.type === cmd.type);
      if (!match) continue;

      try {
        await application.commands.delete(match.id, cmd.testOnly ? guildId : undefined);
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

export async function recompileTypeScript(): Promise<{ success: boolean; error?: string; duration: number }> {
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
    if (process.platform !== 'win32') await execAsync('sync', { timeout: 60000 });
    return { success: true, duration: Date.now() - start };
  } catch (error: any) {
    const stderr = error.stderr?.toString() || error.message || 'Unknown compilation error';
    return { success: false, error: stderr, duration: Date.now() - start };
  } finally {
    recompileInProgress = false;
  }
}

/**
 * Find a module's manifest by name and pass it through the boot loader's gates.
 * Two manifests with one name are refused: boot would load only the first, and
 * a reload by name cannot tell which copy is meant.
 */
function resolveHotLoad(
  client: Client,
  moduleName: string
): { manifest: ModuleManifest; modulePath: string } | { error: string } {
  const matches: Array<{ manifest: ModuleManifest; manifestPath: string }> = [];
  for (const manifestPath of findModuleManifests()) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      if (manifest.name === moduleName) matches.push({ manifest, manifestPath });
    } catch {
      continue;
    }
  }
  if (matches.length === 0) return { error: 'Module manifest not found' };
  if (matches.length > 1) {
    return {
      error: `Two modules are named "${moduleName}" (${matches.map(m => path.dirname(m.manifestPath)).join(', ')}); remove or rename one, then restart the bot`
    };
  }
  const refusal = hotLoadRefusal(matches[0].manifest, client);
  if (refusal) return { error: refusal };
  return { manifest: matches[0].manifest, modulePath: path.dirname(matches[0].manifestPath) };
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
  const rBefore = new Set(Array.from(((client as any).reactionHandlers ?? new Map()).keys()));
  const rrBefore = new Set(Array.from(((client as any).reactionRemoveHandlers ?? new Map()).keys()));

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
  const rAfter = Array.from(((client as any).reactionHandlers ?? new Map()).keys()) as string[];
  const rrAfter = Array.from(((client as any).reactionRemoveHandlers ?? new Map()).keys()) as string[];
  const bNew = bAfter.filter(k => !bBefore.has(k));
  const mNew = mAfter.filter(k => !mBefore.has(k));
  const dNew = dAfter.filter(k => !dBefore.has(k));
  const rNew = rAfter.filter(k => !rBefore.has(k));
  const rrNew = rrAfter.filter(k => !rrBefore.has(k));
  for (const id of bNew) { const info = (client as any).buttonHandlers.get(id); if (info) info._moduleName = module.manifest.name; }
  for (const id of mNew) { const info = (client as any).modalHandlers.get(id); if (info) info._moduleName = module.manifest.name; }
  for (const id of dNew) { const info = (client as any).dropdownHandlers.get(id); if (info) info._moduleName = module.manifest.name; }
  for (const id of rNew) { const info = (client as any).reactionHandlers.get(id); if (info) info._moduleName = module.manifest.name; }
  for (const id of rrNew) { const infos = (client as any).reactionRemoveHandlers.get(id); if (infos) for (const info of infos) info._moduleName = module.manifest.name; }
  module.registeredInteractionIds = {
    buttons: bNew,
    modals: mNew,
    dropdowns: dNew
  };
  (module as any).registeredReactionIds = {
    reactions: rNew,
    reactionRemoves: rrNew
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
  beginReload();
  try {
    return await reloadModuleBody(client, moduleName);
  } finally {
    endReload();
  }
}

async function reloadModuleBody(client: Client, moduleName: string): Promise<ReloadResult> {
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
      recordLoadFailure(moduleName);
      return { success: false, moduleName, error: `Compilation failed: ${compile.error}`, duration: Date.now() - start };
    }

    const target = resolveHotLoad(client, moduleName);
    if ('error' in target) {
      recordLoadFailure(moduleName);
      return { success: false, moduleName, error: target.error, duration: Date.now() - start };
    }
    const { manifest, modulePath } = target;

    const loader = new ModuleLoader(client);
    const newModule = await loader.loadModule(manifest, modulePath);

    if (existingModule) {
      await registry.unloadModule(moduleName);
      getMetricsCollector().dropModule(moduleName);
    }
    await registerReloadedModule(client, newModule);

    await reRegisterSlashCommands(client, { runOrphanCleanup: false });

    const action = existingModule ? 'Reloaded' : 'Loaded';
    console.log(`[Reloader] ${action}: ${moduleName} (${Date.now() - start}ms)`);
    return { success: true, moduleName, duration: Date.now() - start };
  } catch (error: any) {
    recordLoadFailure(moduleName);
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
    getMetricsCollector().dropModule(moduleName);
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
  beginReload();
  try {
    return await reloadModulesBody(client, moduleNames);
  } finally {
    endReload();
  }
}

async function reloadModulesBody(client: Client, moduleNames: string[]): Promise<BulkReloadResult> {
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

  for (const name of available) reloadingModules.add(name);

  try {
    // 1. Single recompile for all changes, so the gate reads the manifest the compile produced
    const compile = await recompileTypeScript();
    result.compileDuration = compile.duration;
    if (!compile.success) {
      result.success = false;
      for (const name of available) {
        recordLoadFailure(name);
        result.failed.push({ moduleName: name, error: `Compilation failed: ${compile.error}` });
      }
      result.totalDuration = Date.now() - start;
      return result;
    }

    const targets = new Map<string, { manifest: ModuleManifest; modulePath: string }>();
    for (const name of available) {
      const target = resolveHotLoad(client, name);
      if ('error' in target) {
        recordLoadFailure(name);
        result.failed.push({ moduleName: name, error: target.error });
      } else targets.set(name, target);
    }
    const accepted = [...targets.keys()];

    // 2. Unload only the accepted modules
    for (const name of accepted) {
      const existing = registry.getModule(name);
      if (existing) {
        await registry.unloadModule(name);
        getMetricsCollector().dropModule(name);
      }
    }

    // 3. Reload each module via ModuleLoader
    const loader = new ModuleLoader(client);
    for (const name of accepted) {
      try {
        const { manifest, modulePath } = targets.get(name)!;

        const module = await loader.loadModule(manifest, modulePath);
        await registerReloadedModule(client, module);
        result.reloaded.push(name);
      } catch (error: any) {
        recordLoadFailure(name);
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
