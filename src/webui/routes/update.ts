import express, { Router, Request, Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { BotManager } from '../botManager';
import { getSafetyManager } from '../../utils/updateSafety';
import { exec } from 'child_process';
import { promisify } from 'util';

import {
  checkForUpdates,
  triggerUpdate,
  getUpdateStatus,
  getUpdaterType,
  checkForAllUpdates,
  triggerModuleUpdate,
  triggerAllModuleUpdates
} from '@/updater';

const execAsync = promisify(exec);

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

  router.post('/trigger', async (req: Request, res: Response) => {
    try {
      const mode = req.body?.mode || 'relative';

      if (!['basic', 'relative', 'full'].includes(mode)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid update mode. Must be basic, relative, or full.'
        });
      }

      const result = await triggerUpdate(mode);

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
   * Update a specific module
   */
  router.post('/modules/:name', async (req: Request, res: Response) => {
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
   * Update all modules with available updates
   */
  router.post('/modules', async (req: Request, res: Response) => {
    try {
      const result = await triggerAllModuleUpdates();

      res.json({
        success: result.success,
        totalAttempted: result.totalAttempted,
        totalUpdated: result.totalUpdated,
        updated: result.updated,
        failed: result.failed,
        message: result.success
          ? `Successfully updated ${result.totalUpdated} module(s)`
          : `Updated ${result.totalUpdated} module(s), ${result.failed.length} failed`
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
  router.post('/backup', async (req: Request, res: Response) => {
    try {
      const { description } = req.body;
      const timestamp = Date.now();
      const backupName = `backup-${timestamp}`;
      const backupPath = path.join('/data/backups', backupName);

      // Create backup directory
      fs.mkdirSync(backupPath, { recursive: true });

      // Copy smdb-source to backup
      const sourceDir = '/app/smdb-source';
      const destDir = path.join(backupPath, 'smdb-source');

      // Use cp command for copying
      await execAsync(`cp -r ${sourceDir} ${destDir}`);

      // Get current version from package.json
      let version = 'unknown';
      try {
        const packageJson = JSON.parse(fs.readFileSync('/app/package.json', 'utf8'));
        version = packageJson.version || 'unknown';
      } catch (e) {
        // Ignore
      }

      // Create metadata
      const metadata = {
        timestamp,
        version,
        description: description || 'Manual backup',
        type: 'manual',
        size: 0  // Will be calculated
      };

      // Calculate size
      try {
        const { stdout } = await execAsync(`du -sb ${backupPath}`);
        const sizeMatch = stdout.match(/^(\d+)/);
        if (sizeMatch) {
          metadata.size = parseInt(sizeMatch[1], 10);
        }
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
  router.post('/rollback/:timestamp', async (req: Request, res: Response) => {
    try {
      const { timestamp } = req.params;
      const backupName = `backup-${timestamp}`;
      const backupPath = path.join('/data/backups', backupName);

      // Check if backup exists
      if (!fs.existsSync(backupPath)) {
        res.status(404).json({
          success: false,
          error: 'Backup not found'
        });
        return;
      }

      // Check if smdb-source exists in backup
      const backupSource = path.join(backupPath, 'smdb-source');
      if (!fs.existsSync(backupSource)) {
        res.status(400).json({
          success: false,
          error: 'Backup is corrupted (missing smdb-source)'
        });
        return;
      }

      // Stop bot if running
      if (botManager.isRunning()) {
        await botManager.shutdown(false);
        // Wait for shutdown
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      // Clear current smdb-source
      await execAsync('rm -rf /app/smdb-source/*');

      // Restore from backup
      await execAsync(`cp -r ${backupSource}/* /app/smdb-source/`);

      // Update safety manager
      const metadata = JSON.parse(
        fs.readFileSync(path.join(backupPath, 'metadata.json'), 'utf8')
      );
      safetyManager.createRollbackSnapshot(
        metadata.version,
        'rollback',
        backupPath
      );

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
  router.delete('/backup/:timestamp', async (req: Request, res: Response) => {
    try {
      const { timestamp } = req.params;
      const backupName = `backup-${timestamp}`;
      const backupPath = path.join('/data/backups', backupName);

      // Check if backup exists
      if (!fs.existsSync(backupPath)) {
        res.status(404).json({
          success: false,
          error: 'Backup not found'
        });
        return;
      }

      // Remove backup directory
      await execAsync(`rm -rf ${backupPath}`);

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
        '/data/update-safety.json',
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