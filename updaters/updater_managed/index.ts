/**
 * Managed Updater (Bot Manager API)
 *
 * This updater is used when the bot runs under Bot Manager.
 * It requests updates from the Bot Manager service instead of handling updates directly.
 * The bot receives BOT_MANAGER_UPDATE_TOKEN via environment variable.
 *
 * Also provides combined update checking for both base code and modules.
 */

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
  mode: 'none' | 'basic' | 'relative' | 'full' | 'first';
  lastCheck?: number;
  lastError?: string;
  lastErrorCode?: string;
}

// Bot Manager API configuration
const BOT_MANAGER_URL = process.env.BOT_MANAGER_URL || 'http://bot-manager:8080';
const BOT_ID = process.env.BOT_ID || '';
const UPDATE_TOKEN = process.env.BOT_MANAGER_UPDATE_TOKEN || '';

let updateStatus: UpdateStatus = {
  inProgress: false,
  mode: 'none'
};

/**
 * Make HTTP request to Bot Manager
 */
async function botManagerRequest(
  endpoint: string,
  method: string = 'GET',
  body?: unknown
): Promise<{ ok: boolean; status: number; data?: unknown; error?: string }> {
  const http = require('http');
  const https = require('https');

  return new Promise((resolve) => {
    try {
      const url = new URL(`${BOT_MANAGER_URL}${endpoint}`);
      const client = url.protocol === 'https:' ? https : http;

      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Bot-Token': UPDATE_TOKEN
        }
      };

      const req = client.request(options, (res: any) => {
        let data = '';
        res.on('data', (chunk: any) => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              data: parsed
            });
          } catch {
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              data
            });
          }
        });
      });

      req.on('error', (error: Error) => {
        resolve({ ok: false, status: 0, error: error.message });
      });

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    } catch (error) {
      resolve({ ok: false, status: 0, error: String(error) });
    }
  });
}

/**
 * Check for updates via Bot Manager
 */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
  if (!BOT_ID) {
    return {
      success: false,
      hasUpdates: false,
      error: 'BOT_ID not configured - updates managed by Bot Manager'
    };
  }

  if (!UPDATE_TOKEN) {
    return {
      success: false,
      hasUpdates: false,
      error: 'BOT_MANAGER_UPDATE_TOKEN not configured'
    };
  }

  try {
    const response = await botManagerRequest(`/api/bots/${BOT_ID}/updates`);

    if (!response.ok) {
      return {
        success: false,
        hasUpdates: false,
        error: response.error || `Bot Manager returned ${response.status}`
      };
    }

    const data = response.data as { hasUpdates?: boolean; behindBy?: number };
    updateStatus.lastCheck = Date.now();

    return {
      success: true,
      hasUpdates: data.hasUpdates || false,
      commitsBehind: data.behindBy || 0,
      message: data.hasUpdates ? `${data.behindBy || 0} commits behind` : 'Up to date'
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
 * Request update from Bot Manager
 * Note: Update modes are handled by Bot Manager, not the bot itself
 */
export async function triggerUpdate(_mode: 'basic' | 'relative' | 'full'): Promise<UpdateTriggerResult> {
  if (!BOT_ID) {
    return {
      success: false,
      error: 'BOT_ID not configured - updates managed by Bot Manager'
    };
  }

  if (!UPDATE_TOKEN) {
    return {
      success: false,
      error: 'BOT_MANAGER_UPDATE_TOKEN not configured'
    };
  }

  try {
    console.log('[Updater] Requesting update from Bot Manager...');
    updateStatus.inProgress = true;

    const response = await botManagerRequest(
      `/api/bots/${BOT_ID}/request-update`,
      'POST'
    );

    if (!response.ok) {
      updateStatus.inProgress = false;
      updateStatus.lastError = response.error || `Bot Manager returned ${response.status}`;
      return {
        success: false,
        error: updateStatus.lastError
      };
    }

    console.log('[Updater] Update request accepted by Bot Manager');
    console.log('[Updater] Bot Manager will pull latest code and restart the container');

    return {
      success: true,
      message: 'Update request sent to Bot Manager. Container will restart with new code.'
    };
  } catch (error) {
    updateStatus.inProgress = false;
    updateStatus.lastError = String(error);
    return {
      success: false,
      error: String(error)
    };
  }
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
  return 'managed';
}

// ============================================================================
// COMBINED UPDATE CHECKING (Base Code + Modules)
// ============================================================================

/**
 * Check for all updates (base code via Bot Manager + modules via AppStore)
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
      updates: [],
      errors: []
    },
    summary: {
      totalUpdatesAvailable: 0,
      hasAnyUpdates: false
    }
  };

  // Check base code updates via Bot Manager
  try {
    const baseCodeResult = await checkForUpdates();
    result.baseCode = {
      checked: true,
      hasUpdates: baseCodeResult.hasUpdates,
      commitsBehind: baseCodeResult.commitsBehind,
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

  // Overall success if both checks completed
  result.success = result.baseCode.checked && result.modules.checked;

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
      success: result.success,
      totalAttempted: result.updated.length + result.failed.length,
      totalUpdated: result.updated.length,
      updated: result.updated,
      failed: result.failed
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
      }]
    };
  }
}
