// src/webui/routes/config.ts

import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import {
  discoverConfigFiles,
  getConfigFileMetadata,
  discoverAllConfigFilesForWebUI,
  discoverGuildConfigFiles,
  discoverGuildDataFiles,
  getDataFileMetadata
} from '../../bot/internalSetup/utils/configDiscovery';
import type { DataFileMetadata } from '../../bot/types/moduleTypes';
import {
  getMergedConfig,
  saveGlobalConfig,
  saveGuildConfig
} from '../../bot/internalSetup/utils/configManager';

export function createConfigRoutes(): Router {
  const router = Router();

  const BACKUP_DIR = '/data/configBackups';

  // Ensure backup directory exists
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  /**
   * GET /api/config/list?guildId=<guildId>
   * List all available config files (includes module schemas)
   * If guildId provided, returns guild-specific config files
   */
  router.get('/list', (req: Request, res: Response) => {
    try {
      const guildId = req.query.guildId as string | undefined;

      // If guild ID provided, return guild-specific configs + data files
      let files;
      if (guildId) {
        const configFiles = discoverGuildConfigFiles(guildId);
        const dataFiles = discoverGuildDataFiles(guildId);

        // Deduplicate by path, preferring schema-defined entries over auto-generated ones
        const pathMap = new Map();

        [...configFiles, ...dataFiles].forEach(file => {
          const existing = pathMap.get(file.path);

          if (!existing) {
            // No entry for this path yet, add it
            pathMap.set(file.path, file);
          } else if (file.schema && !existing.schema) {
            // Current has schema, existing doesn't - replace with schema version
            pathMap.set(file.path, file);
          } else if (!file.schema && existing.schema) {
            // Current has no schema, existing does - keep existing (skip current)
            return;
          }
          // If both have schema or both don't, keep first occurrence
        });

        files = Array.from(pathMap.values());
      } else {
        files = discoverAllConfigFilesForWebUI();
      }

      res.json({
        success: true,
        files
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
   * GET /api/config/get?file=config.json&guildId=<guildId>
   * Get specific config file with merged schema defaults
   * If guildId provided, returns guild-specific merged config
   */
  router.get('/get', (req: Request, res: Response) => {
    try {
      const fileId = req.query.file ? decodeURIComponent(req.query.file as string) : 'config.json';
      const guildId = req.query.guildId as string | undefined;
      const configInfo = getConfigFileMetadata(fileId);

      if (!configInfo) {
        res.status(400).json({
          success: false,
          error: 'Config file not found. It may not exist in any scanned directories.'
        });
        return;
      }

      // Get merged config with all possible keys (guild-aware if guildId provided)
      const mergedConfig = getMergedConfig(fileId, guildId || null);

      // Build simple config object for Web-UI (just values, not metadata)
      const config: Record<string, any> = {};
      for (const [key, prop] of Object.entries(mergedConfig.properties)) {
        config[key] = prop.value;
      }

      res.json({
        success: true,
        config,
        mergedConfig, // Include full merged config for advanced rendering
        initialized: fs.existsSync(configInfo.path),
        hasSchema: mergedConfig.metadata.hasSchema
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: `Failed to read config: ${errorMessage}`
      });
    }
  });

  /**
   * POST /api/config/update
   * Update config file (dynamically discovered)
   * Supports guild-specific config updates via guildId in request body
   */
  router.post('/update', (req: Request, res: Response) => {
    try {
      const fileId = req.body.file || 'config.json';
      const newConfig = req.body.config;
      const guildId = req.body.guildId as string | undefined;
      const configInfo = getConfigFileMetadata(fileId);

      if (!configInfo) {
        res.status(400).json({
          success: false,
          error: 'Config file not found. It may not exist in any scanned directories.'
        });
        return;
      }

      if (!newConfig || typeof newConfig !== 'object') {
        res.status(400).json({
          success: false,
          error: 'Invalid config data'
        });
        return;
      }

      // Validate JSON structure
      try {
        JSON.stringify(newConfig);
      } catch (e) {
        res.status(400).json({
          success: false,
          error: 'Config is not valid JSON'
        });
        return;
      }

      // Determine the actual config path (guild or global)
      let actualConfigPath: string;
      if (guildId && configInfo.moduleName) {
        actualConfigPath = path.join('/data', guildId, configInfo.moduleName, fileId);
      } else if (guildId) {
        actualConfigPath = path.join('/data/guildConfigs', `${guildId}.json`);
      } else {
        actualConfigPath = configInfo.path;
      }

      // Create backup of current config if it exists
      if (fs.existsSync(actualConfigPath)) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFilename = `${fileId.replace('.json', '')}_${guildId ? `${guildId}_` : ''}${timestamp}.json`;
        const backupPath = path.join(BACKUP_DIR, backupFilename);
        fs.copyFileSync(actualConfigPath, backupPath);
        console.log(`[Config] Backup created: ${backupPath}`);

        // Keep only last 10 backups per file
        const backupPrefix = fileId.replace('.json', '') + (guildId ? `_${guildId}` : '');
        const backups = fs.readdirSync(BACKUP_DIR)
          .filter(f => f.startsWith(backupPrefix + '_'))
          .sort()
          .reverse();

        if (backups.length > 10) {
          backups.slice(10).forEach(backup => {
            fs.unlinkSync(path.join(BACKUP_DIR, backup));
          });
        }
      }

      // Use appropriate save function based on context
      if (guildId) {
        saveGuildConfig(fileId, guildId, newConfig);
        console.log(`[Config] ${fileId} updated successfully for guild ${guildId}`);
      } else {
        saveGlobalConfig(fileId, newConfig);
        console.log(`[Config] ${fileId} updated successfully (global)`);
      }

      res.json({
        success: true,
        message: 'Config updated successfully'
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: `Failed to update config: ${errorMessage}`
      });
    }
  });

  /**
   * GET /api/config/backups?file=config.json
   * List available backups for a specific file
   */
  router.get('/backups', (req: Request, res: Response) => {
    try {
      const fileId = req.query.file ? decodeURIComponent(req.query.file as string) : 'config.json';
      const backupPrefix = fileId.replace('.json', '');

      if (!fs.existsSync(BACKUP_DIR)) {
        res.json({
          success: true,
          backups: []
        });
        return;
      }

      const backups = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.startsWith(backupPrefix + '_'))
        .map(filename => {
          const filePath = path.join(BACKUP_DIR, filename);
          const stats = fs.statSync(filePath);
          return {
            filename,
            fileId,
            timestamp: stats.mtime,
            size: stats.size
          };
        })
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

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
   * Validate backup filename to prevent path traversal
   */
  function validateBackupFilename(filename: string): boolean {
    // Only allow alphanumeric, dash, underscore, and .json extension
    return /^[a-zA-Z0-9_-]+\.json$/.test(filename);
  }

  /**
   * POST /api/config/restore
   * Restore from backup (dynamically discovered)
   */
  router.post('/restore', (req: Request, res: Response) => {
    try {
      const { filename, file } = req.body;
      const fileId = file || 'config.json';
      const configInfo = getConfigFileMetadata(fileId);

      if (!configInfo) {
        res.status(400).json({
          success: false,
          error: 'Config file not found. It may not exist in any scanned directories.'
        });
        return;
      }

      if (!filename || !validateBackupFilename(filename)) {
        res.status(400).json({
          success: false,
          error: 'Invalid backup filename format'
        });
        return;
      }

      // Normalize path and ensure it's within BACKUP_DIR
      const backupPath = path.normalize(path.join(BACKUP_DIR, filename));

      // Security check: ensure path is still within BACKUP_DIR after normalization
      if (!backupPath.startsWith(path.normalize(BACKUP_DIR))) {
        res.status(400).json({
          success: false,
          error: 'Invalid backup path - path traversal detected'
        });
        return;
      }

      if (!fs.existsSync(backupPath)) {
        res.status(404).json({
          success: false,
          error: 'Backup file not found'
        });
        return;
      }

      // Create backup of current config before restoring (if exists)
      if (fs.existsSync(configInfo.path)) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFilename = `${fileId.replace('.json', '')}_before_restore_${timestamp}.json`;
        const currentBackup = path.join(BACKUP_DIR, backupFilename);
        fs.copyFileSync(configInfo.path, currentBackup);
      }

      // Ensure parent directory exists
      const configDir = path.dirname(configInfo.path);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      // Restore backup
      fs.copyFileSync(backupPath, configInfo.path);
      console.log(`[Config] Restored ${fileId} from backup: ${filename}`);

      res.json({
        success: true,
        message: 'Config restored successfully'
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
   * GET /api/data/get?file=giveaways.json&guildId=<guildId>
   * Get specific data file (raw JSON)
   * If guildId provided, returns guild-specific data file
   */
  router.get('/data/get', (req: Request, res: Response) => {
    try {
      const fileId = req.query.file ? decodeURIComponent(req.query.file as string) : undefined;
      const guildId = req.query.guildId as string | undefined;

      if (!fileId) {
        res.status(400).json({
          success: false,
          error: 'File ID is required'
        });
        return;
      }

      const metadata = getDataFileMetadata(fileId, guildId);

      if (!metadata) {
        res.status(404).json({
          success: false,
          error: 'Data file not found'
        });
        return;
      }

      // Load raw data from file path
      let data: any;
      const filePath = metadata.path;

      if (fs.existsSync(filePath)) {
        try {
          const fileContents = fs.readFileSync(filePath, 'utf-8');
          data = JSON.parse(fileContents);
        } catch (error) {
          res.status(500).json({
            success: false,
            error: 'Failed to parse data file JSON'
          });
          return;
        }
      } else {
        // File doesn't exist - use template or empty object
        data = metadata.template || {};
      }

      res.json({
        success: true,
        data,
        metadata,
        exists: metadata.exists
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: `Failed to read data file: ${errorMessage}`
      });
    }
  });

  /**
   * POST /api/data/update
   * Update data file (raw JSON)
   * Supports guild-specific data updates via guildId in request body
   */
  router.post('/data/update', (req: Request, res: Response) => {
    try {
      const fileId = req.body.file;
      const newData = req.body.data;
      const guildId = req.body.guildId as string | undefined;

      if (!fileId) {
        res.status(400).json({
          success: false,
          error: 'File ID is required'
        });
        return;
      }

      const metadata = getDataFileMetadata(fileId, guildId);

      if (!metadata) {
        res.status(404).json({
          success: false,
          error: 'Data file not found'
        });
        return;
      }

      if (newData === undefined) {
        res.status(400).json({
          success: false,
          error: 'Data is required'
        });
        return;
      }

      // Validate JSON structure
      try {
        JSON.stringify(newData);
      } catch (e) {
        res.status(400).json({
          success: false,
          error: 'Data is not valid JSON'
        });
        return;
      }

      const savePath = metadata.path;

      // Create backup if file exists
      if (fs.existsSync(savePath)) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFilename = `${fileId.replace('.json', '')}_${guildId ? `${guildId}_` : ''}${timestamp}.json`;
        const backupPath = path.join(BACKUP_DIR, backupFilename);
        fs.copyFileSync(savePath, backupPath);
        console.log(`[Data] Backup created: ${backupPath}`);

        // Keep only last 10 backups per file
        const backupPrefix = fileId.replace('.json', '') + (guildId ? `_${guildId}` : '');
        const backups = fs.readdirSync(BACKUP_DIR)
          .filter(f => f.startsWith(backupPrefix + '_'))
          .sort()
          .reverse();

        if (backups.length > 10) {
          backups.slice(10).forEach(backup => {
            fs.unlinkSync(path.join(BACKUP_DIR, backup));
          });
        }
      }

      // Ensure parent directory exists
      const dirPath = path.dirname(savePath);
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }

      // Save data file
      fs.writeFileSync(savePath, JSON.stringify(newData, null, 2), 'utf-8');
      console.log(`[Data] ${fileId} saved successfully${guildId ? ` for guild ${guildId}` : ' (global)'}`);

      res.json({
        success: true,
        message: 'Data file saved successfully'
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: `Failed to save data file: ${errorMessage}`
      });
    }
  });

  return router;
}
