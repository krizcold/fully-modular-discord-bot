/**
 * Local Updater (Self-Hosted / Git-Based)
 *
 * This updater is used when the bot runs standalone without Bot Manager.
 * It checks for updates by comparing local version with remote repository.
 *
 * For self-hosted users:
 * - Docker: Pull new image and restart container
 * - Local: Git pull and restart the bot
 */

import * as fs from 'fs';
import {
  getAppStoreManager,
  ModuleUpdateCheck,
  ModuleUpdatesResult
} from '@bot/internalSetup/utils/appStoreManager';

export interface UpdateCheckResult {
  success: boolean;
  hasUpdates: boolean;
  message?: string;
  currentVersion?: string;
  latestVersion?: string;
  currentVersionDate?: string;
  latestVersionDate?: string;
  currentCommit?: string;
  latestCommit?: string;
  commitsBehind?: number;
  error?: string;
}

/** Combined update check result for base code + modules */
export interface CombinedUpdateCheckResult {
  success: boolean;
  partial?: boolean;
  lastChecked: string;
  baseCode: {
    checked: boolean;
    hasUpdates: boolean;
    commitsBehind?: number;
    error?: string;
  };
  modules: {
    checked: boolean;
    hasUpdates: boolean;
    totalInstalled: number;
    updatesAvailable: number;
    unchecked?: number;
    updates: ModuleUpdateCheck[];
    errors: Array<{ moduleName: string; error: string }>;
  };
  summary: {
    totalUpdatesAvailable: number;
    hasAnyUpdates: boolean;
  };
}

/** Result of updating a single module */
export interface ModuleUpdateResult {
  success: boolean;
  moduleName: string;
  oldVersion?: string;
  newVersion?: string;
  error?: string;
}

/** Result of bulk module updates */
export interface BulkModuleUpdateResult {
  success: boolean;
  totalAttempted: number;
  totalUpdated: number;
  updated: Array<{ moduleName: string; oldVersion: string; newVersion: string }>;
  failed: Array<{ moduleName: string; error: string }>;
  checkErrors: Array<{ moduleName: string; error: string }>;
  skipped: Array<{ moduleName: string; reason: string }>;
}

/**
 * Operator-facing sentence for a bulk module update; names every module that was not updated.
 */
export function describeBulkModuleUpdate(result: BulkModuleUpdateResult): string {
  const parts = [`Updated ${result.totalUpdated} module(s)`];
  if (result.failed.length > 0) {
    parts.push(`failed: ${result.failed.map(f => `${f.moduleName} (${f.error})`).join(', ')}`);
  }
  if (result.skipped.length > 0) {
    parts.push(`not updated: ${result.skipped.map(s => `${s.moduleName} (${s.reason})`).join(', ')}`);
  }
  if (result.checkErrors.length > 0) {
    parts.push(`could not check: ${result.checkErrors.map(e => `${e.moduleName} (${e.error})`).join(', ')}`);
  }
  return parts.join('; ');
}

// Re-export module types for convenience
export type { ModuleUpdateCheck, ModuleUpdatesResult };

export interface UpdateTriggerResult {
  success: boolean;
  message?: string;
  error?: string;
}

export interface UpdateStatus {
  inProgress: boolean;
  lastCheck?: number;
  lastError?: string;
  lastErrorCode?: string;
}

const PACKAGE_JSON_PATH = '/app/package.json';
const GITHUB_REPO = process.env.GITHUB_REPO || 'krizcold/fully-modular-discord-bot';

let updateStatus: UpdateStatus = {
  inProgress: false
};

// Get current version from package.json
function getCurrentVersion(): string {
  try {
    if (fs.existsSync(PACKAGE_JSON_PATH)) {
      const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
      return pkg.version || '0.0.0';
    }
  } catch (error) {
    console.error('[Updater] Failed to read package.json:', error);
  }
  return '0.0.0';
}

// Check GitHub for latest release/version
async function checkGitHubForUpdates(): Promise<{ hasUpdates: boolean; latestVersion?: string; error?: string }> {
  return new Promise((resolve) => {
    const https = require('https');

    const options = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/releases/latest`,
      method: 'GET',
      headers: {
        'User-Agent': 'discord-bot-updater',
        'Accept': 'application/vnd.github.v3+json'
      }
    };

    const req = https.request(options, (res: any) => {
      let data = '';
      res.on('data', (chunk: any) => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode === 404) {
            resolve({ hasUpdates: false, error: `No release is published for ${GITHUB_REPO}; cannot compare` });
            return;
          }

          if (res.statusCode !== 200) {
            resolve({ hasUpdates: false, error: `GitHub API returned ${res.statusCode}` });
            return;
          }

          const release = JSON.parse(data);
          const latestVersion = release.tag_name?.replace(/^v/, '') || release.name;
          const currentVersion = getCurrentVersion();

          // Simple version comparison
          const hasUpdates = latestVersion !== currentVersion &&
            compareVersions(latestVersion, currentVersion) > 0;

          resolve({ hasUpdates, latestVersion });
        } catch (error) {
          resolve({ hasUpdates: false, error: String(error) });
        }
      });
    });

    req.on('error', (error: Error) => {
      resolve({ hasUpdates: false, error: error.message });
    });

    req.setTimeout(10000, () => {
      req.destroy();
      resolve({ hasUpdates: false, error: 'Request timeout' });
    });

    req.end();
  });
}

// Compare semantic versions
function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] || 0;
    const numB = partsB[i] || 0;
    if (numA > numB) return 1;
    if (numA < numB) return -1;
  }
  return 0;
}

/**
 * Check for updates by comparing local version with GitHub
 */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
  try {
    const currentVersion = getCurrentVersion();
    const githubResult = await checkGitHubForUpdates();

    if (githubResult.error) {
      updateStatus.lastError = githubResult.error;
      return {
        success: false,
        hasUpdates: false,
        currentVersion,
        error: githubResult.error
      };
    }

    updateStatus.lastCheck = Date.now();
    updateStatus.lastError = undefined;

    return {
      success: true,
      hasUpdates: githubResult.hasUpdates,
      currentVersion,
      latestVersion: githubResult.latestVersion,
      message: githubResult.hasUpdates
        ? `Update available: ${currentVersion} -> ${githubResult.latestVersion}`
        : `No newer release than ${currentVersion}`
    };
  } catch (error) {
    updateStatus.lastError = String(error);
    return {
      success: false,
      hasUpdates: false,
      error: String(error)
    };
  }
}

/**
 * Self-hosted updates are applied by hand; a plain restart keeps the old image and the old code.
 */
export async function triggerUpdate(): Promise<UpdateTriggerResult> {
  return {
    success: false,
    error: 'Self-hosted mode: update by hand. Remote stack: git pull, then sudo ./setup.sh. Standalone stack: git pull, then docker compose -f docker-compose.standalone.yml up -d --build. Published image: pull the new image and recreate the container.'
  };
}

/**
 * Get current update status
 */
export function getUpdateStatus(): UpdateStatus {
  return { ...updateStatus };
}

/**
 * Get updater type identifier
 */
export function getUpdaterType(): string {
  return 'local';
}

// ============================================================================
// COMBINED UPDATE CHECKING (Base Code + Modules)
// ============================================================================

/**
 * Check for all updates (base code via GitHub + modules via AppStore)
 */
export async function checkForAllUpdates(): Promise<CombinedUpdateCheckResult> {
  const result: CombinedUpdateCheckResult = {
    success: true,
    lastChecked: new Date().toISOString(),
    baseCode: {
      checked: false,
      hasUpdates: false
    },
    modules: {
      checked: false,
      hasUpdates: false,
      totalInstalled: 0,
      updatesAvailable: 0,
      unchecked: 0,
      updates: [],
      errors: []
    },
    summary: {
      totalUpdatesAvailable: 0,
      hasAnyUpdates: false
    }
  };

  // Check base code updates via GitHub
  try {
    const baseCodeResult = await checkForUpdates();
    result.baseCode = {
      checked: baseCodeResult.success,
      hasUpdates: baseCodeResult.hasUpdates,
      error: baseCodeResult.error
    };
  } catch (error) {
    result.baseCode = {
      checked: false,
      hasUpdates: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  // Check module updates via AppStoreManager
  try {
    const appStoreManager = getAppStoreManager();
    const installedModules = appStoreManager.getInstalledModules();
    result.modules.totalInstalled = installedModules.length;

    if (installedModules.length > 0) {
      const moduleResult = await appStoreManager.checkAllModulesForUpdates();
      result.modules = {
        checked: true,
        hasUpdates: moduleResult.updatesAvailable > 0,
        totalInstalled: installedModules.length,
        updatesAvailable: moduleResult.updatesAvailable,
        unchecked: moduleResult.errors.length,
        updates: moduleResult.updates,
        errors: moduleResult.errors
      };
    } else {
      result.modules.checked = true;
    }
  } catch (error) {
    result.modules.checked = false;
    result.modules.errors.push({
      moduleName: '*',
      error: error instanceof Error ? error.message : String(error)
    });
  }

  // Calculate summary
  result.summary = {
    totalUpdatesAvailable:
      (result.baseCode.hasUpdates ? 1 : 0) + result.modules.updatesAvailable,
    hasAnyUpdates: result.baseCode.hasUpdates || result.modules.hasUpdates
  };

  result.partial = !result.baseCode.checked || !result.modules.checked || (result.modules.unchecked || 0) > 0;
  result.success = !result.partial;

  return result;
}

/**
 * Trigger update for a specific module
 */
export async function triggerModuleUpdate(moduleName: string): Promise<ModuleUpdateResult> {
  try {
    const appStoreManager = getAppStoreManager();
    const installedModules = appStoreManager.getInstalledModules();
    const installed = installedModules.find(m => m.name === moduleName);

    if (!installed) {
      return {
        success: false,
        moduleName,
        error: `Module ${moduleName} is not installed`
      };
    }

    const oldVersion = installed.version;
    const updateResult = await appStoreManager.updateModule(moduleName);

    return {
      success: updateResult.success,
      moduleName,
      oldVersion,
      newVersion: updateResult.newVersion,
      error: updateResult.error
    };
  } catch (error) {
    return {
      success: false,
      moduleName,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Trigger updates for all modules with available updates
 */
export async function triggerAllModuleUpdates(): Promise<BulkModuleUpdateResult> {
  try {
    const appStoreManager = getAppStoreManager();
    const result = await appStoreManager.updateAllModules();

    return {
      success: result.failed.length === 0 && result.skipped.length === 0 && result.checkErrors.length === 0,
      totalAttempted: result.updated.length + result.failed.length + result.skipped.length,
      totalUpdated: result.updated.length,
      updated: result.updated,
      failed: result.failed,
      checkErrors: result.checkErrors,
      skipped: result.skipped
    };
  } catch (error) {
    return {
      success: false,
      totalAttempted: 0,
      totalUpdated: 0,
      updated: [],
      failed: [{
        moduleName: '*',
        error: error instanceof Error ? error.message : String(error)
      }],
      checkErrors: [],
      skipped: []
    };
  }
}
