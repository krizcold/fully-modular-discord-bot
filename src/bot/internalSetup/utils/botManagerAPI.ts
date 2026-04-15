/**
 * Bot Manager Update API
 *
 * Provides wrapper functions for the Bot Manager update system.
 *
 * Updates are requested from Bot Manager via:
 *   POST /api/bots/{botId}/request-update
 *   Header: X-Bot-Token: {BOT_MANAGER_UPDATE_TOKEN}
 */

import * as updater from '@/updater';
import type {
  CombinedUpdateCheckResult,
  ModuleUpdateResult,
  BulkModuleUpdateResult
} from '@/updater';

// Re-export types for compatibility
export type { CombinedUpdateCheckResult, ModuleUpdateResult, BulkModuleUpdateResult };

export interface UpdateCheckResponse {
  success: boolean;
  hasUpdates: boolean;
  message?: string;
  currentCommit?: string;
  latestCommit?: string;
  currentVersion?: string;
  latestVersion?: string;
  currentVersionDate?: string;
  latestVersionDate?: string;
  commitsBehind?: number;
  lastChecked?: string;
  error?: string | null;
}

export interface BuildStatusResponse {
  success: boolean;
  data?: {
    running?: number;
    queued?: number;
    maxConcurrent?: number;
  };
}

/**
 * Check for updates via Bot Manager
 */
export async function checkForBotUpdates(): Promise<UpdateCheckResponse | null> {
  const result = await updater.checkForUpdates();
  return result as UpdateCheckResponse | null;
}

/**
 * Request system update from Bot Manager.
 * Triggers pull + rebuild + restart via Bot Manager API.
 */
export async function requestSystemUpdate(): Promise<{ success: boolean; error?: string; code?: string }> {
  return await updater.triggerUpdate();
}

/**
 * Smart update: check and trigger if updates available
 */
export async function smartBotUpdate(): Promise<{
  triggered: boolean;
  reason: string;
  updateInfo?: UpdateCheckResponse;
}> {
  const updateCheck = await updater.checkForUpdates();

  if (!updateCheck || !updateCheck.success) {
    return { triggered: false, reason: 'Failed to check for updates' };
  }

  if (!updateCheck.hasUpdates) {
    return {
      triggered: false,
      reason: 'No updates available',
      updateInfo: updateCheck as UpdateCheckResponse
    };
  }

  const result = await requestSystemUpdate();

  return {
    triggered: result.success,
    reason: result.success
      ? `Update triggered - ${updateCheck.message || 'updates available'}`
      : result.error || 'Failed to trigger update',
    updateInfo: updateCheck as UpdateCheckResponse
  };
}

/**
 * Get build status - not applicable with Bot Manager
 */
export async function getBotBuildStatus(): Promise<BuildStatusResponse | null> {
  // Build status is managed by Bot Manager, not accessible from bot
  return {
    success: true,
    data: { running: 0, queued: 0, maxConcurrent: 1 }
  };
}

/**
 * Get current update status
 */
export function getBotUpdateStatus(): {
  inProgress: boolean;
  lastCheck?: number;
  lastError?: string;
  lastErrorCode?: string;
} {
  const status = updater.getUpdateStatus();
  return {
    inProgress: status.inProgress,
    lastCheck: status.lastCheck,
    lastError: status.lastError,
    lastErrorCode: status.lastErrorCode
  };
}

// ============================================================================
// COMBINED UPDATE CHECKING (Base Code + Modules)
// ============================================================================

/**
 * Check for all bot updates (base code + modules)
 */
export async function checkForAllBotUpdates(): Promise<CombinedUpdateCheckResult | null> {
  try {
    return await updater.checkForAllUpdates();
  } catch (error) {
    console.error('[BotManagerAPI] Failed to check for all updates:', error);
    return null;
  }
}

/**
 * Trigger update for a specific module
 */
export async function triggerModuleUpdate(moduleName: string): Promise<ModuleUpdateResult> {
  return await updater.triggerModuleUpdate(moduleName);
}

/**
 * Trigger updates for all modules with available updates
 */
export async function triggerAllModuleUpdates(): Promise<BulkModuleUpdateResult> {
  return await updater.triggerAllModuleUpdates();
}

