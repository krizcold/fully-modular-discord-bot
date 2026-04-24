/**
 * Module Auto-Update Scheduler
 *
 * When enabled via the "Auto-Update Modules" toggle in AppStore config,
 * periodically checks for module updates, downloads them, and hot-reloads
 * changed modules, all without restarting the bot.
 *
 * Config: /data/global/appstore/config.json → autoUpdate (boolean)
 * Default: disabled
 * Interval: 30 minutes
 */

import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'discord.js';
import { getAppStoreManager } from './appStoreManager';
import { reloadModules } from './moduleReloader';

const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let clientRef: Client | null = null;

/**
 * Read the autoUpdate flag from appstore config.
 */
function isAutoUpdateEnabled(): boolean {
  try {
    const configPath = path.join(process.env.DATA_DIR || '/data', 'global', 'appstore', 'config.json');
    if (!fs.existsSync(configPath)) return false;
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return cfg.autoUpdate === true;
  } catch {
    return false;
  }
}

/**
 * Run a single check: look for module updates, download, and hot-reload.
 */
async function runModuleUpdateCheck(): Promise<void> {
  if (!clientRef) return;
  if (!isAutoUpdateEnabled()) return;

  try {
    const manager = getAppStoreManager();
    const installed = manager.getInstalledModules();
    if (installed.length === 0) return;

    // Check for updates (refreshes repos and compares versions)
    const checkResult = await manager.checkAllModulesForUpdates();
    if (!checkResult.success || checkResult.updatesAvailable === 0) return;

    const modulesWithUpdates = checkResult.updates.filter(u => u.hasUpdate);
    console.log(`[ModuleAutoUpdater] ${modulesWithUpdates.length} module update(s) available, downloading...`);

    // Download updates
    const updateResult = await manager.updateAllModules();
    if (updateResult.updated.length === 0) return;

    const updatedNames = updateResult.updated.map(u => u.moduleName);
    console.log(`[ModuleAutoUpdater] Downloaded: ${updatedNames.join(', ')}. Hot-reloading...`);

    // Hot-reload the updated modules
    const reloadResult = await reloadModules(clientRef, updatedNames);
    if (reloadResult.success) {
      console.log(`[ModuleAutoUpdater] Hot-reloaded ${reloadResult.reloaded.length} module(s) in ${reloadResult.totalDuration}ms`);
    } else {
      console.warn(`[ModuleAutoUpdater] Reload partial: ${reloadResult.reloaded.length} OK, ${reloadResult.failed.length} failed`);
      for (const f of reloadResult.failed) {
        console.warn(`[ModuleAutoUpdater]   Failed: ${f.moduleName}: ${f.error}`);
      }
    }
  } catch (error) {
    console.error('[ModuleAutoUpdater] Error during auto-update check:', error);
  }
}

/**
 * Start the module auto-update scheduler.
 * Must be called after the Discord client is ready.
 */
export function startModuleAutoUpdater(client: Client): void {
  if (intervalHandle) return;

  clientRef = client;
  console.log(`[ModuleAutoUpdater] Started (interval: ${CHECK_INTERVAL_MS / 1000 / 60}min, enabled: ${isAutoUpdateEnabled()})`);

  intervalHandle = setInterval(() => {
    runModuleUpdateCheck().catch(err => {
      console.error('[ModuleAutoUpdater] Tick error:', err);
    });
  }, CHECK_INTERVAL_MS);
}

/**
 * Stop the module auto-update scheduler.
 */
export function stopModuleAutoUpdater(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    clientRef = null;
    console.log('[ModuleAutoUpdater] Stopped');
  }
}
