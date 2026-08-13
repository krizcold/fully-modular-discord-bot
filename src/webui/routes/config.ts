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
import type { ConfigFileMetadata } from '../../bot/internalSetup/utils/configDiscovery';
import type { DataFileMetadata } from '../../bot/types/moduleTypes';
import { routeFor } from '../../bot/internalSetup/utils/dataBackends/routeResolver';
import { getWebuiDataReader, isDataBackendUnreachable } from '../utils/webuiDataReader';
import {
  getMergedConfig,
  saveGlobalConfig,
  saveGuildConfig
} from '../../bot/internalSetup/utils/configManager';
import { isGuildWriteFrozen, writeRawAtomic } from '../../bot/internalSetup/utils/dataManager';
import { dataPath } from '../../utils/dataRoot';
import { coWorkerReadonlyResponse, isCoWorkerNode } from '../middleware/fleetGate';
import { nudgeSync } from '../utils/syncNudge';
import type { BotManager } from '../botManager';

export function createConfigRoutes(botManager: BotManager): Router {
  const router = Router();

  // A guild id must be a plain Discord snowflake. Anything else ('global',
  // 'guildConfigs', a '..'-bearing value) either targets master-owned global
  // state through the guild-scoped path or escapes the guild dir via path.join,
  // so it is rejected for ALL nodes before it reaches dataPath()/saveGuildConfig.
  const isValidGuildId = (id: unknown): id is string => typeof id === 'string' && /^\d{5,20}$/.test(id);

  const BACKUP_DIR = dataPath('configBackups');

  // Ensure backup directory exists
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  /**
   * GET /api/config/list?guildId=<guildId>
   * List all available config files (includes module schemas)
   * If guildId provided, returns guild-specific config files
   */
  router.get('/list', async (req: Request, res: Response) => {
    try {
      const guildId = req.query.guildId as string | undefined;

      // If guild ID provided, return guild-specific configs + data files
      let files;
      if (guildId && routeFor(guildId) === 'postgres') {
        try {
          files = await discoverGuildFilesPostgres(guildId);
        } catch (error) {
          if (!isDataBackendUnreachable(error)) {
            throw error;
          }
          res.status(503).json({
            success: false,
            error: 'Data backend unreachable; retry shortly'
          });
          return;
        }
      } else if (guildId && isValidGuildId(guildId) && !fs.existsSync(dataPath(guildId))) {
        // File-routed guild with no local dir: during a mixed-backend window
        // its files live on the owning node's disk, so ask the owner. A failed
        // hop leaves files unset and the local branch below answers as today.
        files = await discoverGuildFilesViaHop(botManager, guildId);
      }
      if (files === undefined) {
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
  router.post('/update', async (req: Request, res: Response) => {
    try {
      const fileId = req.body.file || 'config.json';
      const newConfig = req.body.config;
      const guildId = req.body.guildId as string | undefined;
      // Any guild-scoped write must carry a genuine snowflake (all nodes): a
      // reserved sentinel like 'global' would otherwise hit the same file as a
      // global write and escape the guild-scoped allowance. A null/absent
      // guildId is a legitimate global write and routes below.
      if (guildId != null && !isValidGuildId(guildId)) {
        res.status(400).json({ success: false, error: 'Invalid guildId format' });
        return;
      }
      // Co-worker: global config is synced from the master; only genuine
      // node-owned guild writes stay allowed (guild data is node-owned).
      if (!guildId && isCoWorkerNode()) {
        coWorkerReadonlyResponse(res);
        return;
      }
      // The facade would silently drop a frozen-guild write (correct for
      // background writers); an operator save must be told instead.
      if (guildId && isGuildWriteFrozen(guildId)) {
        console.warn(`[Config] Rejected config write to frozen guild ${guildId} (shard migration in progress)`);
        res.status(503).json({ success: false, error: 'Guild data is frozen for a shard migration; retry after it completes' });
        return;
      }
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

      // Database-routed guild: the owning bot process applies the write
      // (mapping mirrors saveGuildConfig); the parent never writes postgres.
      if (guildId && routeFor(guildId) === 'postgres') {
        const module = fileId === 'config.json' ? '_guildConfig' : (configInfo.moduleName || '');
        const filename = fileId === 'config.json' ? 'config.json' : configInfo.id;
        const reply = await botManager.writeGuildData({
          guildId,
          module,
          filename,
          op: 'write',
          contentJson: JSON.stringify(newConfig, null, 2)
        });
        sendHopReply(res, reply ?? { ok: false, code: 'bot-down' });
        return;
      }

      // Determine the actual config path (guild or global)
      let actualConfigPath: string;
      if (guildId && configInfo.moduleName) {
        actualConfigPath = dataPath(guildId, configInfo.moduleName, fileId);
      } else if (guildId) {
        actualConfigPath = dataPath(guildId, '_guildConfig', 'config.json');
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
        nudgeSync('config');
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
      // Restore writes the master-authoritative global path; co-workers never restore.
      if (isCoWorkerNode()) {
        coWorkerReadonlyResponse(res);
        return;
      }
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

      // Restore backup through the facade so it is ordered by the single
      // per-path write queue (an in-flight update flush cannot clobber it).
      const backupContents = fs.readFileSync(backupPath, 'utf-8');
      writeRawAtomic(configInfo.path, backupContents);
      console.log(`[Config] Restored ${fileId} from backup: ${filename}`);
      nudgeSync('config');

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
  router.get('/data/get', async (req: Request, res: Response) => {
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

      if (guildId && routeFor(guildId) === 'postgres') {
        await serveGuildDataFromReader(fileId, guildId, res);
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

      // File-routed guild with no local guild dir (owned by another node): ask
      // the bot child to read from the owner. Any miss falls through to the
      // local template/empty behavior, so reads never get worse than today.
      if (guildId && isValidGuildId(guildId) && !fs.existsSync(dataPath(guildId))) {
        const reply = await botManager.readGuildData({
          guildId,
          module: metadata.moduleName || '',
          filename: metadata.id
        });
        if (reply?.ok && reply.contentJson) {
          try {
            const remoteData = JSON.parse(reply.contentJson);
            res.json({
              success: true,
              data: remoteData,
              metadata,
              exists: true
            });
            return;
          } catch {
            // fall through to local behavior
          }
        }
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
  router.post('/data/update', async (req: Request, res: Response) => {
    try {
      const fileId = req.body.file;
      const newData = req.body.data;
      const guildId = req.body.guildId as string | undefined;

      // A guild-scoped data write must be a genuine snowflake (all nodes), or a
      // sentinel/traversal value would reach master-owned global data. A
      // null/absent guildId is a legitimate global write and routes below.
      if (guildId != null && !isValidGuildId(guildId)) {
        res.status(400).json({ success: false, error: 'Invalid guildId format' });
        return;
      }
      // The webui parent never writes postgres; database-routed guild writes
      // go through the owning bot process.
      if (guildId && routeFor(guildId) === 'postgres') {
        if (!fileId) {
          res.status(400).json({ success: false, error: 'File ID is required' });
          return;
        }
        if (newData === undefined) {
          res.status(400).json({ success: false, error: 'Data is required' });
          return;
        }
        const { module, filename } = dataHopTarget(fileId, guildId);
        const reply = await botManager.writeGuildData({
          guildId,
          module,
          filename,
          op: 'write',
          contentJson: JSON.stringify(newData, null, 2)
        });
        sendHopReply(res, reply ?? { ok: false, code: 'bot-down' });
        return;
      }
      // Co-worker: global data files are synced from the master; only genuine
      // node-owned guild writes stay allowed.
      if (!guildId && isCoWorkerNode()) {
        coWorkerReadonlyResponse(res);
        return;
      }
      // This route writes via writeRawAtomic, which has no guild context and
      // therefore no facade freeze gate: without this check a drain-window
      // write would land after the final-round hash and then be graveyarded
      // (or resurrect a zombie guild dir if it races the rename).
      if (guildId && isGuildWriteFrozen(guildId)) {
        console.warn(`[Config] Rejected data write to frozen guild ${guildId} (shard migration in progress)`);
        res.status(503).json({ success: false, error: 'Guild data is frozen for a shard migration; retry after it completes' });
        return;
      }

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

      // Save through the facade so this write is ordered by the single per-path
      // queue (no race with a queued global/guild write to the same file) and
      // lands atomically via temp+fsync+rename.
      writeRawAtomic(savePath, JSON.stringify(newData, null, 2));
      console.log(`[Data] ${fileId} saved successfully${guildId ? ` for guild ${guildId}` : ' (global)'}`);
      if (!guildId) nudgeSync('globaldata');

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

  /**
   * POST /api/config/data/delete
   * Delete a guild data file; the bot child applies it on the owning node.
   */
  router.post('/data/delete', async (req: Request, res: Response) => {
    try {
      const fileId = req.body.file;
      const guildId = req.body.guildId;

      if (!isValidGuildId(guildId)) {
        res.status(400).json({ success: false, error: 'A valid guildId is required' });
        return;
      }
      if (!fileId) {
        res.status(400).json({ success: false, error: 'File ID is required' });
        return;
      }

      const { module, filename } = dataHopTarget(fileId, guildId);
      const reply = await botManager.writeGuildData({
        guildId,
        module,
        filename,
        op: 'delete'
      });
      sendHopReply(res, reply ?? { ok: false, code: 'bot-down' });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: `Failed to delete data file: ${errorMessage}`
      });
    }
  });

  /**
   * POST /api/config/data/delete-guild
   * Delete every data file for a guild (namespace removal on the owning node).
   */
  router.post('/data/delete-guild', async (req: Request, res: Response) => {
    try {
      const guildId = req.body.guildId;

      if (!isValidGuildId(guildId)) {
        res.status(400).json({ success: false, error: 'A valid guildId is required' });
        return;
      }

      const reply = await botManager.writeGuildData({
        guildId,
        module: '',
        filename: '',
        op: 'delete-namespace'
      });
      sendHopReply(res, reply ?? { ok: false, code: 'bot-down' });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: `Failed to delete guild data: ${errorMessage}`
      });
    }
  });

  return router;
}

/**
 * Same (module, filename) mapping as serveGuildDataFromReader: schema metadata
 * wins, otherwise 'module/file.json' style ids split on the slash.
 */
function dataHopTarget(fileId: string, guildId: string): { module: string; filename: string } {
  const metadata = getDataFileMetadata(fileId, guildId);
  const parts = fileId.split('/');
  return {
    module: metadata ? (metadata.moduleName || '') : (parts.length >= 2 ? parts[0] : ''),
    filename: metadata ? metadata.id : parts[parts.length - 1]
  };
}

/**
 * Map a guild-write/read hop reply (bot child IPC) onto the HTTP response.
 */
function sendHopReply(res: Response, reply: any): void {
  if (reply && reply.ok) {
    if (reply.pending) {
      res.status(202).json({ success: true, pending: true, message: 'saved, not yet confirmed durable' });
    } else {
      res.status(200).json({ success: true });
    }
    return;
  }
  const detail = reply && typeof reply.error === 'string' ? reply.error : undefined;
  switch (reply?.code) {
    case 'frozen':
      res.status(503).json({ success: false, error: 'Guild data is frozen for a shard migration; retry after it completes' });
      return;
    case 'not-owner':
    case 'owner-unreachable':
    case 'stale-term':
      res.status(503).json({ success: false, error: 'guild temporarily unavailable' });
      return;
    case 'backend-unavailable':
      res.status(503).json({ success: false, error: detail || 'the database backend is unavailable' });
      return;
    case 'bot-down':
      res.status(503).json({ success: false, error: 'the bot process is not running' });
      return;
    case 'invalid':
      res.status(400).json({ success: false, error: detail || 'Invalid request' });
      return;
    default:
      res.status(500).json({ success: false, error: detail || 'Guild data operation failed' });
      return;
  }
}

/**
 * Mirror of configDiscovery's generateDisplayName for reader-served entries.
 */
function displayNameFor(filename: string): string {
  const baseName = filename.replace('.json', '');
  if (baseName === 'config') {
    return 'Main Bot Config';
  }
  return baseName
    .replace(/([A-Z])/g, ' $1')
    .replace(/[-_]/g, ' ')
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
    .trim();
}

/**
 * Guild file listing for a postgres-routed guild: schema-declared entries keep
 * their metadata but the exists probes are answered by the database, and the
 * orphan disk scan is replaced by database listings (per module present in the
 * database or known to a schema, plus the guild-dir root - a schema-less
 * module's rows must still surface). Disk leftovers are ignored - the database
 * is the source of truth for this guild.
 */
async function discoverGuildFilesPostgres(guildId: string): Promise<Array<ConfigFileMetadata | DataFileMetadata>> {
  const reader = getWebuiDataReader();

  const configFiles = discoverGuildConfigFiles(guildId).filter(file => file.schema);
  const dataFiles = discoverGuildDataFiles(guildId).filter(file => file.schema);
  const schemaFiles: Array<ConfigFileMetadata | DataFileMetadata> = [...configFiles, ...dataFiles];

  await Promise.all(schemaFiles.map(async file => {
    file.exists = await reader.exists(guildId, file.moduleName || '', file.id);
  }));

  const covered = new Set(schemaFiles.map(file => `${file.moduleName || ''}/${file.id}`));
  const schemaModules = schemaFiles.map(file => file.moduleName).filter((name): name is string => !!name);
  const moduleNames = [...new Set([...schemaModules, ...await reader.listModules(guildId)])];
  const orphans: Array<ConfigFileMetadata | DataFileMetadata> = [];

  await Promise.all(moduleNames.map(async moduleName => {
    const filenames = await reader.listFiles(guildId, moduleName);
    for (const filename of filenames) {
      if (covered.has(`${moduleName}/${filename}`)) {
        continue;
      }
      orphans.push({
        id: filename,
        path: dataPath(guildId, moduleName, filename),
        name: displayNameFor(filename),
        description: 'Orphaned data file (no schema defined)',
        category: 'data',
        exists: true,
        required: false,
        template: undefined,
        scope: 'guild',
        moduleName
      });
    }
  }));

  const rootFilenames = await reader.listFiles(guildId);
  for (const filename of rootFilenames) {
    orphans.push({
      id: filename,
      path: dataPath(guildId, filename),
      name: displayNameFor(filename),
      description: `${displayNameFor(filename)} runtime data`,
      category: 'data',
      exists: true,
      default: {}
    });
  }

  // Same dedup-by-path as the file-routed branch: schema entries win.
  const pathMap = new Map<string, ConfigFileMetadata | DataFileMetadata>();
  [...schemaFiles, ...orphans].forEach(file => {
    const existing = pathMap.get(file.path);
    if (!existing || (file.schema && !existing.schema)) {
      pathMap.set(file.path, file);
    }
  });
  return Array.from(pathMap.values());
}

/**
 * Guild file listing for a file-routed guild whose files live on another
 * node's disk (mixed-backend window): the owner's read hop answers with every
 * 'module/filename' key (guild-root files are bare filenames) and the same
 * response shape as discoverGuildFilesPostgres is built against that key set.
 * undefined = hop failed; the caller falls back to the local scan.
 */
async function discoverGuildFilesViaHop(botManager: BotManager, guildId: string): Promise<Array<ConfigFileMetadata | DataFileMetadata> | undefined> {
  const reply = await botManager.readGuildData({ guildId, module: '', scope: 'all' });
  if (!reply || !reply.ok || !Array.isArray(reply.files)) {
    return undefined;
  }
  const keys = new Set<string>(reply.files.filter((key: unknown): key is string => typeof key === 'string'));

  const configFiles = discoverGuildConfigFiles(guildId).filter(file => file.schema);
  const dataFiles = discoverGuildDataFiles(guildId).filter(file => file.schema);
  const schemaFiles: Array<ConfigFileMetadata | DataFileMetadata> = [...configFiles, ...dataFiles];

  for (const file of schemaFiles) {
    file.exists = keys.has(file.moduleName ? `${file.moduleName}/${file.id}` : file.id);
  }

  const covered = new Set(schemaFiles.map(file => `${file.moduleName || ''}/${file.id}`));
  const orphans: Array<ConfigFileMetadata | DataFileMetadata> = [];
  for (const key of keys) {
    const slash = key.indexOf('/');
    if (slash > 0) {
      if (covered.has(key)) {
        continue;
      }
      const moduleName = key.slice(0, slash);
      const filename = key.slice(slash + 1);
      orphans.push({
        id: filename,
        path: dataPath(guildId, moduleName, filename),
        name: displayNameFor(filename),
        description: 'Orphaned data file (no schema defined)',
        category: 'data',
        exists: true,
        required: false,
        template: undefined,
        scope: 'guild',
        moduleName
      });
    } else {
      orphans.push({
        id: key,
        path: dataPath(guildId, key),
        name: displayNameFor(key),
        description: `${displayNameFor(key)} runtime data`,
        category: 'data',
        exists: true,
        default: {}
      });
    }
  }

  // Same dedup-by-path as the other branches: schema entries win.
  const pathMap = new Map<string, ConfigFileMetadata | DataFileMetadata>();
  [...schemaFiles, ...orphans].forEach(file => {
    const existing = pathMap.get(file.path);
    if (!existing || (file.schema && !existing.schema)) {
      pathMap.set(file.path, file);
    }
  });
  return Array.from(pathMap.values());
}

/**
 * GET /data/get for a postgres-routed guild: same (module, filename) mapping
 * as the file path resolution (category subdir = module, basename = filename),
 * answered by the database reader with today's response shapes.
 */
async function serveGuildDataFromReader(fileId: string, guildId: string, res: Response): Promise<void> {
  const metadata = getDataFileMetadata(fileId, guildId);

  const parts = fileId.split('/');
  const moduleName = metadata ? (metadata.moduleName || '') : (parts.length >= 2 ? parts[0] : '');
  const filename = metadata ? metadata.id : parts[parts.length - 1];

  let existsInDb: boolean;
  let doc: string | null;
  try {
    const reader = getWebuiDataReader();
    existsInDb = await reader.exists(guildId, moduleName, filename);
    doc = existsInDb ? await reader.readDoc(guildId, moduleName, filename) : null;
  } catch (error) {
    res.status(503).json({
      success: false,
      error: 'Data backend unreachable; retry shortly'
    });
    return;
  }

  if (!metadata && !existsInDb) {
    res.status(404).json({
      success: false,
      error: 'Data file not found'
    });
    return;
  }

  let data: any;
  if (doc !== null) {
    try {
      data = JSON.parse(doc);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to parse data file JSON'
      });
      return;
    }
  } else {
    data = metadata?.template || {};
  }

  const responseMetadata: DataFileMetadata = metadata
    ? { ...metadata, exists: existsInDb }
    : {
        id: filename,
        path: dataPath(guildId, moduleName, filename),
        name: displayNameFor(filename),
        description: 'Orphaned data file (no schema defined)',
        category: 'data',
        exists: true,
        required: false,
        template: undefined,
        scope: 'guild',
        moduleName
      };

  res.json({
    success: true,
    data,
    metadata: responseMetadata,
    exists: existsInDb
  });
}
