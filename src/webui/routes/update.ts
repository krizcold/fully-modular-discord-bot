import express, { Router, Request, Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { BotManager } from '../botManager';
import { getSafetyManager } from '../../utils/updateSafety';
import { dataPath } from '../../utils/dataRoot';
import { requireMasterNode } from '../middleware/fleetGate';
import { nudgeSync } from '../utils/syncNudge';

import {
  checkForUpdates,
  triggerUpdate,
  getUpdateStatus,
  getUpdaterType,
  checkForAllUpdates,
  triggerModuleUpdate,
  triggerAllModuleUpdates,
  describeBulkModuleUpdate
} from '@/updater';

const COPY_OPTIONS = { recursive: true, force: true, preserveTimestamps: true, verbatimSymlinks: true } as const;

type BackupLookup = { status: 400 | 404; error: string } | { dir: string };

// Only a listed backup: a whole-number id naming a folder directly under the
// backups folder that holds its metadata.json.
function lookUpBackup(timestamp: string): BackupLookup {
  if (!/^\d+$/.test(timestamp)) return { status: 400, error: 'Invalid backup id' };
  const backupsDir = dataPath('backups');
  const dir = path.join(backupsDir, `backup-${timestamp}`);
  if (path.dirname(dir) !== backupsDir || !fs.existsSync(path.join(dir, 'metadata.json'))) {
    return { status: 404, error: 'Backup not found' };
  }
  return { dir };
}

async function emptyDir(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
  for (const name of await fs.promises.readdir(dir)) {
    await fs.promises.rm(path.join(dir, name), { recursive: true, force: true });
  }
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else total += (await fs.promises.lstat(full)).size;
  }
  return total;
}

export function createUpdateRouter(botManager: BotManager): Router {
  const router = Router();
  const safetyManager = getSafetyManager();

  /**
   * GET /api/update/status
   * Get update status and safety information
   */
  router.get('/status', (req: Request, res: Response) => {
    try {
      const safetyStatus = safetyManager.getStatus();
      const botStatus = botManager.getStatus();

      res.json({
        success: true,
        safety: safetyStatus,
        bot: botStatus
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  router.post('/check', async (req: Request, res: Response) => {
    try {
      const result = await checkForUpdates();

      res.json({
        ...result,
        updaterType: getUpdaterType()
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: errorMessage,
        hasUpdates: false
      });
    }
  });

  router.post('/trigger', async (_req: Request, res: Response) => {
    try {
      const result = await triggerUpdate();

      if (result.success) {
        res.json({
          success: true,
          message: result.message || 'Update triggered successfully.'
        });
      } else {
        res.json({
          success: false,
          error: result.error || 'Failed to trigger update'
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  // ============================================================================
  // COMBINED UPDATE ENDPOINTS (Base Code + Modules)
  // ============================================================================

  /**
   * POST /api/update/check-all
   * Check for all updates (base code + modules)
   */
  router.post('/check-all', async (req: Request, res: Response) => {
    try {
      const result = await checkForAllUpdates();

      res.json({
        ...result,
        updaterType: getUpdaterType()
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  /**
   * POST /api/update/modules/:name
   * Update a specific module. Module updates are master-only; co-workers
   * receive them via sync (base-code updates stay per-node).
   */
  router.post('/modules/:name', requireMasterNode, async (req: Request, res: Response) => {
    try {
      const { name } = req.params;

      if (!name) {
        return res.status(400).json({
          success: false,
          error: 'Module name is required'
        });
      }

      const result = await triggerModuleUpdate(name);

      if (result.success) {
        nudgeSync('modules');
        res.json({
          success: true,
          moduleName: result.moduleName,
          oldVersion: result.oldVersion,
          newVersion: result.newVersion,
          message: `Module ${name} updated successfully from ${result.oldVersion} to ${result.newVersion}`
        });
      } else {
        res.json({
          success: false,
          moduleName: result.moduleName,
          error: result.error || 'Failed to update module'
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  /**
   * POST /api/update/modules
   * Update all modules with available updates (master-only; synced to co-workers)
   */
  router.post('/modules', requireMasterNode, async (req: Request, res: Response) => {
    try {
      const result = await triggerAllModuleUpdates();
      if (result.totalUpdated > 0) nudgeSync('modules');

      res.json({
        success: result.success,
        totalAttempted: result.totalAttempted,
        totalUpdated: result.totalUpdated,
        updated: result.updated,
        failed: result.failed,
        checkErrors: result.checkErrors,
        skipped: result.skipped,
        message: describeBulkModuleUpdate(result)
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  // ============================================================================
  // COMBINED UPDATE + HOT-RELOAD ENDPOINTS
  // ============================================================================

  /**
   * POST /api/update/modules-and-reload
   * Download module updates AND hot-reload them in one step.
   * Returns both the download results and the reload results.
   */
  router.post('/modules-and-reload', requireMasterNode, async (req: Request, res: Response) => {
    try {
      // Step 1: Download module updates via AppStoreManager
      const updateResult = await triggerAllModuleUpdates();
      if (updateResult.totalUpdated > 0) nudgeSync('modules');

      if (updateResult.totalUpdated === 0) {
        res.json({
          success: updateResult.success,
          download: updateResult,
          reload: null,
          message: updateResult.success
            ? 'No modules were updated; nothing to reload'
            : describeBulkModuleUpdate(updateResult)
        });
        return;
      }

      // Step 2: Hot-reload the updated modules
      const updatedNames = updateResult.updated.map(u => u.moduleName);
      const reloadResult = await botManager.reloadModules(updatedNames);

      res.json({
        success: updateResult.success && (reloadResult?.success !== false),
        download: updateResult,
        reload: reloadResult,
        message: reloadResult?.success
          ? `${describeBulkModuleUpdate(updateResult)}; reloaded the updated module(s)`
          : `${describeBulkModuleUpdate(updateResult)}; reload had issues`
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  /**
   * POST /api/update/module-and-reload/:name
   * Download a single module update AND hot-reload it.
   */
  router.post('/module-and-reload/:name', requireMasterNode, async (req: Request, res: Response) => {
    try {
      const { name } = req.params;

      // Step 1: Download module update
      const updateResult = await triggerModuleUpdate(name);
      if (updateResult.success) nudgeSync('modules');

      if (!updateResult.success) {
        res.json({
          success: false,
          download: updateResult,
          reload: null,
          error: updateResult.error || 'Failed to download module update'
        });
        return;
      }

      // Step 2: Hot-reload the module
      const reloadResult = await botManager.reloadModule(name);

      res.json({
        success: reloadResult?.success !== false,
        download: updateResult,
        reload: reloadResult,
        message: reloadResult?.success
          ? `Updated and reloaded ${name}`
          : `Updated ${name} but reload failed: ${reloadResult?.error}`
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // ============================================================================
  // MODULE HOT-RELOAD ENDPOINTS (standalone: reload without downloading)
  // ============================================================================

  /**
   * POST /api/update/reload/:name
   * Hot-reload a single module (no restart needed)
   */
  router.post('/reload/:name', requireMasterNode, async (req: Request, res: Response) => {
    try {
      const result = await botManager.reloadModule(req.params.name);
      res.json(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  /**
   * POST /api/update/reload
   * Hot-reload multiple modules (no restart needed)
   * Body: { moduleNames: string[] }
   */
  router.post('/reload', requireMasterNode, async (req: Request, res: Response) => {
    try {
      const { moduleNames } = req.body as { moduleNames?: string[] };
      if (!moduleNames || !Array.isArray(moduleNames) || moduleNames.length === 0) {
        res.status(400).json({ success: false, error: 'moduleNames array is required' });
        return;
      }
      const result = await botManager.reloadModules(moduleNames);
      res.json(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  /**
   * GET /api/update/loaded-modules
   * Get list of currently loaded modules from bot process
   */
  router.get('/loaded-modules', async (req: Request, res: Response) => {
    try {
      const result = await botManager.getLoadedModules();
      res.json(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  /**
   * GET /api/update/backups
   * List available backups
   */
  router.get('/backups', (req: Request, res: Response) => {
    try {
      const backups = safetyManager.getBackups();

      res.json({
        success: true,
        backups
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  /**
   * POST /api/update/backup
   * Create a manual backup
   */
  router.post('/backup', requireMasterNode, async (req: Request, res: Response) => {
    try {
      const { description } = req.body;
      const timestamp = Date.now();
      const backupName = `backup-${timestamp}`;
      const backupPath = path.join(dataPath('backups'), backupName);

      fs.mkdirSync(backupPath, { recursive: true });

      if (fs.existsSync('/app/custom')) {
        await fs.promises.cp('/app/custom', path.join(backupPath, 'custom'), COPY_OPTIONS);
      }
      if (fs.existsSync(dataPath('appstore-modules'))) {
        await fs.promises.cp(dataPath('appstore-modules'), path.join(backupPath, 'appstore-modules'), COPY_OPTIONS);
      }

      let version = 'unknown';
      try {
        const packageJson = JSON.parse(fs.readFileSync('/app/package.json', 'utf8'));
        version = packageJson.version || 'unknown';
      } catch (e) {
        // ignore
      }

      // Create metadata
      const metadata = {
        timestamp,
        version,
        description: description || 'Manual backup',
        type: 'manual',
        size: 0  // Will be calculated
      };

      try {
        metadata.size = await dirSize(backupPath);
      } catch (e) {
        // Ignore
      }

      // Save metadata
      fs.writeFileSync(
        path.join(backupPath, 'metadata.json'),
        JSON.stringify(metadata, null, 2)
      );

      res.json({
        success: true,
        backup: metadata
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  /**
   * POST /api/update/rollback/:timestamp
   * Restore from backup
   */
  router.post('/rollback/:timestamp', requireMasterNode, async (req: Request, res: Response) => {
    try {
      const found = lookUpBackup(req.params.timestamp);
      if (!('dir' in found)) {
        res.status(found.status).json({ success: false, error: found.error });
        return;
      }
      const backupPath = found.dir;

      const backupCustom = path.join(backupPath, 'custom');
      const backupAppstore = path.join(backupPath, 'appstore-modules');
      const kinds = [backupCustom, backupAppstore].map(subdir => {
        try {
          return fs.lstatSync(subdir).isDirectory() ? 'dir' : 'other';
        } catch {
          return 'missing';
        }
      });
      if (kinds.includes('other')) {
        res.status(400).json({
          success: false,
          error: 'Backup is corrupted (custom or appstore-modules is not a plain folder)'
        });
        return;
      }
      if (!kinds.includes('dir')) {
        res.status(400).json({
          success: false,
          error: 'Backup is corrupted (missing custom and appstore-modules)'
        });
        return;
      }

      // Unconditional: a crashed child may still be waiting on its automatic
      // start, which the shutdown calls off.
      const wasRunning = botManager.isRunning();
      await botManager.shutdown(false);
      if (wasRunning) await new Promise(resolve => setTimeout(resolve, 2000));

      if (kinds[0] === 'dir') {
        await emptyDir('/app/custom');
        await fs.promises.cp(backupCustom, '/app/custom', COPY_OPTIONS);
      }
      if (kinds[1] === 'dir') {
        await emptyDir(dataPath('appstore-modules'));
        await fs.promises.cp(backupAppstore, dataPath('appstore-modules'), COPY_OPTIONS);
      }

      // Wipe ephemeral build outputs + the applied-version marker so the next
      // boot's buildId compare rebuilds /app/build and /app/dist from the
      // restored sources. Mirrors performRollback in rollback.js.
      await fs.promises.rm('/app/build', { recursive: true, force: true });
      await fs.promises.rm('/app/dist', { recursive: true, force: true });
      try {
        if (fs.existsSync(dataPath('applied-version.json'))) {
          fs.unlinkSync(dataPath('applied-version.json'));
        }
      } catch {
        // best-effort
      }

      res.json({
        success: true,
        message: 'Rollback successful. Please restart the bot.'
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  /**
   * DELETE /api/update/backup/:timestamp
   * Delete a backup
   */
  router.delete('/backup/:timestamp', requireMasterNode, async (req: Request, res: Response) => {
    try {
      const found = lookUpBackup(req.params.timestamp);
      if (!('dir' in found)) {
        res.status(found.status).json({ success: false, error: found.error });
        return;
      }

      await fs.promises.rm(found.dir, { recursive: true, force: true });

      res.json({
        success: true,
        message: 'Backup deleted successfully'
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  /**
   * POST /api/update/clear-crash-history
   * Clear crash history
   */
  router.post('/clear-crash-history', (req: Request, res: Response) => {
    try {
      const config = safetyManager.getStatus();
      config.crashHistory = [];
      config.safeMode = false;

      // Save config
      fs.writeFileSync(
        dataPath('update-safety.json'),
        JSON.stringify(config, null, 2)
      );

      res.json({
        success: true,
        message: 'Crash history cleared'
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  return router;
}