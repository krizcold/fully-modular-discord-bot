// src/webui/routes/config.ts

import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import {
  getConfigFileMetadata,
  discoverAllConfigFilesForWebUI,
  discoverGuildConfigFiles,
  discoverGuildDataFiles,
  existsQueueFirst,
  findDataFileMetadata,
  isCoreOwnedGlobalFile
} from '../../bot/internalSetup/utils/configDiscovery';
import type { ConfigFileMetadata } from '../../bot/internalSetup/utils/configDiscovery';
import type { DataFileMetadata } from '../../bot/types/moduleTypes';
import { routeFor } from '../../bot/internalSetup/utils/dataBackends/routeResolver';
import { getWebuiDataReader, isDataBackendUnreachable } from '../utils/webuiDataReader';
import {
  mergeConfigValues,
  ROOT_CONFIG_PATH,
  saveGlobalConfig,
  saveGuildConfig
} from '../../bot/internalSetup/utils/configManager';
import { isGuildWriteFrozen, writeRawAtomic } from '../../bot/internalSetup/utils/dataManager';
import { dataPath } from '../../utils/dataRoot';
import { coWorkerReadonlyResponse, isCoWorkerNode } from '../middleware/fleetGate';
import { nudgeSync } from '../utils/syncNudge';
import { backupMatch, isBackupFilename, listBackups, stampDate, writeBackup, type LegacyNames } from '../utils/configBackups';
import { childQueuedError, readServedGlobal, readServedGuild, withTargetLock, type ServedRead } from '../utils/servedRead';
import type { BotManager } from '../botManager';

const CONFIG_NOT_FOUND = 'Config file not found. It may not exist in any scanned directories.';

/**
 * One Config tab target, resolved once for get, update, backups and restore:
 * key is the module-qualified row key (the backup stem); guild holds the
 * child's (module, filename) for a guild document, global the child's address
 * of a global file; path is where it lives on this node's disk.
 */
interface ConfigTarget {
  kind: 'config' | 'data';
  key: string;
  guildId: string | null;
  path: string;
  guild?: { module: string; filename: string };
  global?: { root?: 'config'; rel?: string };
  /** A guild config's global twin, merged under it by /get. */
  globalTwin?: { root?: 'config'; rel?: string; path: string };
  configInfo?: ConfigFileMetadata;
  metadata?: DataFileMetadata | null;
  /** A module data file's older backups, named by its bare id. */
  legacy?: LegacyNames;
}

const FROZEN = 'Guild data is frozen for a shard migration; retry after it completes';

type Resolved = { ok: true; target: ConfigTarget } | { ok: false; status: number; error: string };

function coreOwnedRefusal(fileId: string): Resolved | null {
  if (!isCoreOwnedGlobalFile(fileId)) return null;
  const error = fileId.startsWith('premium-tiers')
    ? `${fileId} is the premium store; edit tiers and subscriptions in the Premium tab`
    : `${fileId} is managed by the bot itself and cannot be edited here`;
  return { ok: false, status: 400, error };
}

function resolveConfigTarget(fileId: string, guildId: string | null): Resolved {
  const refused = coreOwnedRefusal(fileId);
  if (refused) return refused;
  const info = getConfigFileMetadata(fileId);
  if (!info) return { ok: false, status: 400, error: CONFIG_NOT_FOUND };
  if (fileId !== 'config.json' && !info.schema && !info.moduleName) {
    return { ok: false, status: 404, error: `${fileId} is not a config file; open it under Data Files` };
  }
  const isRoot = fileId === 'config.json';
  const globalTwin = isRoot
    ? { root: 'config' as const, path: ROOT_CONFIG_PATH }
    : { rel: `${info.moduleName}/${fileId}`, path: dataPath('global', info.moduleName!, fileId) };
  if (guildId) {
    const guild = isRoot ? { module: '_guildConfig', filename: 'config.json' } : { module: info.moduleName!, filename: fileId };
    const guildPath = dataPath(guildId, guild.module, guild.filename);
    return { ok: true, target: { kind: 'config', key: fileId, guildId, path: guildPath, guild, globalTwin, configInfo: info, legacy: configLegacyOf(fileId, guildId, guildPath) } };
  }
  const { path: globalPath, ...global } = globalTwin;
  return { ok: true, target: { kind: 'config', key: fileId, guildId: null, path: globalPath, global, configInfo: info, legacy: configLegacyOf(fileId, null, globalPath) } };
}

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

// Older backups carry only a bare file id, and config files and data files
// were named alike, so an older name belongs to a target only when no other
// file of that id exists.

/** Whether a config file carries this id. */
function configNamed(id: string): boolean {
  const info = getConfigFileMetadata(id);
  return !!info && (id === 'config.json' || !!info.schema || !!info.moduleName);
}

/**
 * Whether this process's discovery cannot see the guild's files: a postgres
 * guild's are in the database, and a file-routed guild with no local dir
 * keeps them on the owning node's disk.
 */
function guildFilesUnseen(guildId: string | null): boolean {
  return !!guildId && (routeFor(guildId) === 'postgres' || !fs.existsSync(dataPath(guildId)));
}

/** Whether a file named id other than ownPath sits anywhere under dir (discovery keeps one per 'module/id'). */
function otherFileNamed(dir: string, id: string, ownPath: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return otherFileNamed(full, id, ownPath);
    return entry.name === id && path.resolve(full) !== path.resolve(ownPath);
  });
}

/** A config target's older backups are shared when a data file other than the target itself has its id. */
function configLegacyOf(fileId: string, guildId: string | null, ownPath: string): LegacyNames | undefined {
  if (guildFilesUnseen(guildId)) return { id: fileId, shared: true, unchecked: true };
  const data = findDataFileMetadata(fileId, guildId ?? undefined);
  const shared = data === 'ambiguous' || (!!data && path.resolve(data.path) !== path.resolve(ownPath));
  return shared ? { id: fileId, shared: true } : undefined;
}

/**
 * A data target's older backups, named by its bare id: shared when another
 * module's file (or a same-named file elsewhere in its own module) or a
 * config file has that id; unchecked (and not restored) when a module file's
 * id names no file this process can see, or the guild's files are not on its
 * disk, so whose they are cannot be told.
 */
function legacyOf(module: string, id: string, guildId: string | null, ownPath: string): LegacyNames | undefined {
  if (guildFilesUnseen(guildId)) return { id, shared: true, unchecked: true };
  const bare = findDataFileMetadata(id, guildId ?? undefined);
  const config = configNamed(id);
  if (module && bare === null && !config) return { id, shared: true, unchecked: true };
  const otherData = module
    ? !(bare && bare !== 'ambiguous' && (bare.moduleName || '') === module) || otherFileNamed(dataPath(guildId ?? 'global', module), id, ownPath)
    : bare === 'ambiguous' || (!!bare && !!bare.moduleName);
  const shared = otherData || config;
  if (!module && !shared) return undefined;
  return { id, shared };
}

/**
 * A data target. allowUnlisted: a guild key no discovery lists (a postgres
 * doc, a deleted file's backups) still resolves from its 'module/file' form.
 */
function resolveDataTarget(fileId: string, guildId: string | null, allowUnlisted: boolean): Resolved {
  if (!guildId) {
    const refused = coreOwnedRefusal(fileId);
    if (refused) return refused;
  }
  // A guild key without a module names the guild-root doc, never a module
  // file of that name: the bare-id lookup is for the global scope only.
  const found = guildId && !fileId.includes('/') ? null : findDataFileMetadata(fileId, guildId ?? undefined);
  if (found === 'ambiguous') {
    return { ok: false, status: 400, error: `${fileId} names a file in more than one module; name it as module/file` };
  }
  if (!guildId) {
    if (!found) return { ok: false, status: 404, error: 'Data file not found' };
    const rel = path.relative(dataPath('global'), found.path).split(path.sep).join('/');
    if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, status: 404, error: 'Data file not found' };
    const key = found.moduleName ? `${found.moduleName}/${found.id}` : found.id;
    return { ok: true, target: { kind: 'data', key, guildId: null, path: found.path, global: { rel }, metadata: found, legacy: legacyOf(found.moduleName || '', found.id, null, found.path) } };
  }
  if (found) {
    const module = found.moduleName || '';
    const key = module ? `${module}/${found.id}` : found.id;
    if (routeFor(guildId) === 'postgres') {
      // The panel lists a postgres guild's top-level docs from the database,
      // while this process's discovery scans its disk, where a leftover in a
      // subfolder may sit under the same key: the doc is the listed one.
      const docPath = module ? dataPath(guildId, module, found.id) : dataPath(guildId, found.id);
      return { ok: true, target: { kind: 'data', key, guildId, path: docPath, guild: { module, filename: found.id }, metadata: { ...found, path: docPath }, legacy: legacyOf(module, found.id, guildId, docPath) } };
    }
    // The child's address of the listed file, which may sit in a subfolder of its module.
    const filename = path.relative(module ? dataPath(guildId, module) : dataPath(guildId), found.path).split(path.sep).join('/');
    if (!filename || filename.startsWith('..') || path.isAbsolute(filename)) return { ok: false, status: 404, error: 'Data file not found' };
    return { ok: true, target: { kind: 'data', key, guildId, path: found.path, guild: { module, filename }, metadata: found, legacy: legacyOf(module, found.id, guildId, found.path) } };
  }
  if (!allowUnlisted) return { ok: false, status: 404, error: 'Data file not found' };
  const parts = fileId.split('/');
  if (parts.length > 2 || !parts.every(part => SEGMENT.test(part) && part !== '..' && part !== '.') || !fileId.endsWith('.json')) {
    return { ok: false, status: 400, error: 'Invalid file id' };
  }
  const module = parts.length === 2 ? parts[0] : '';
  const filename = parts[parts.length - 1];
  const filePath = module ? dataPath(guildId, module, filename) : dataPath(guildId, filename);
  return { ok: true, target: { kind: 'data', key: fileId, guildId, path: filePath, guild: { module, filename }, metadata: null, legacy: legacyOf(module, filename, guildId, filePath) } };
}

/**
 * The key a target's backups are named by. A data file's is its own path
 * under its module (or scope), so a file in a subfolder and a file of the
 * same name its listing key may come to name never share backups.
 */
function backupKeyOf(t: ConfigTarget): string {
  if (t.kind !== 'data') return t.key;
  if (t.global?.rel) return t.global.rel;
  if (t.guild) return t.guild.module ? `${t.guild.module}/${t.guild.filename}` : t.guild.filename;
  return t.key;
}

/** guildId as a route reads it: absent or empty is global; anything but a snowflake is refused. */
function guildOf(value: unknown): { ok: true; guildId: string | null } | { ok: false } {
  if (value === undefined || value === null || value === '') return { ok: true, guildId: null };
  return typeof value === 'string' && /^\d{5,20}$/.test(value) ? { ok: true, guildId: value } : { ok: false };
}

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

  /** The target's newest accepted body, from the process that serves it. */
  const readTarget = (t: ConfigTarget): Promise<ServedRead> => (t.guildId
    ? readServedGuild(botManager, { guildId: t.guildId, module: t.guild!.module, filename: t.guild!.filename, path: t.path })
    : readServedGlobal(botManager, { ...t.global, path: t.path }));

  /** A durable backup of the body the target holds now; none when it holds none. Throws when it cannot be written. */
  const backupCurrent = (t: ConfigTarget, body: string | null, beforeRestore = false): boolean => {
    if (body === null) return false;
    const written = writeBackup(BACKUP_DIR, backupKeyOf(t), t.guildId, body, beforeRestore);
    console.log(`[Config] Backup ${written.created ? 'created' : 'NOT kept'}: ${path.join(BACKUP_DIR, written.filename)}`);
    return written.created;
  };

  const fail = (res: Response, failure: { status: number; error: string }) => {
    res.status(failure.status).json({ success: false, error: failure.error });
  };

  /** Only the bot child writes a postgres-routed guild: with it down, nothing is read or backed up for a write. */
  const hopWriteWithoutBot = (t: ConfigTarget): boolean => !!t.guildId && routeFor(t.guildId) === 'postgres' && !botManager.isRunning();

  /**
   * The write gates again after the serving read, which is awaited: a shard
   * migration's freeze or a demotion to co-worker may have begun meanwhile.
   */
  const refusedAfterRead = (res: Response, t: ConfigTarget, coWorkerAnyScope = false): boolean => {
    if ((coWorkerAnyScope || !t.guildId) && isCoWorkerNode()) {
      coWorkerReadonlyResponse(res);
      return true;
    }
    if (t.guildId && routeFor(t.guildId) !== 'postgres' && isGuildWriteFrozen(t.guildId)) {
      res.status(503).json({ success: false, error: FROZEN });
      return true;
    }
    return false;
  };

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
  router.get('/get', async (req: Request, res: Response) => {
    try {
      const fileId = req.query.file ? decodeURIComponent(req.query.file as string) : 'config.json';
      const scope = guildOf(req.query.guildId);
      if (!scope.ok) {
        res.status(400).json({ success: false, error: 'Invalid guildId format' });
        return;
      }
      const resolved = resolveConfigTarget(fileId, scope.guildId);
      if (!resolved.ok) {
        fail(res, resolved);
        return;
      }
      const t = resolved.target;

      // Both bodies from the process that serves them: a postgres-routed
      // guild's lives in the child's working set, never on this process's disk.
      const own = await readTarget(t);
      if (!own.ok) {
        fail(res, own);
        return;
      }
      let globalBody: string | null = null;
      let notice = own.notice;
      if (t.globalTwin) {
        const twin = await readServedGlobal(botManager, t.globalTwin);
        if (!twin.ok) {
          fail(res, twin);
          return;
        }
        globalBody = twin.content;
        notice = notice ?? twin.notice;
      }
      let savedValues: Record<string, any>;
      let globalValues: Record<string, any>;
      try {
        savedValues = own.content === null ? {} : JSON.parse(own.content);
        globalValues = globalBody === null ? {} : JSON.parse(globalBody);
      } catch {
        res.status(500).json({ success: false, error: 'Failed to read config: the stored file is not valid JSON' });
        return;
      }

      const mergedConfig = mergeConfigValues(fileId, t.configInfo ?? null, savedValues, globalValues, !!t.guildId);

      // Build simple config object for Web-UI (just values, not metadata)
      const config: Record<string, any> = {};
      for (const [key, prop] of Object.entries(mergedConfig.properties)) {
        config[key] = prop.value;
      }

      res.json({
        success: true,
        config,
        mergedConfig, // Include full merged config for advanced rendering
        initialized: own.content !== null,
        hasSchema: mergedConfig.metadata.hasSchema,
        ...(notice ? { notice } : {})
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
        res.status(503).json({ success: false, error: FROZEN });
        return;
      }
      const resolved = resolveConfigTarget(fileId, guildId ?? null);
      if (!resolved.ok) {
        fail(res, resolved);
        return;
      }
      const t = resolved.target;

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

      if (hopWriteWithoutBot(t)) {
        sendHopReply(res, { ok: false, code: 'bot-down' });
        return;
      }
      // One operator write of a file at a time, from its read to its write.
      await withTargetLock(t.path, async () => {
        // The backup holds the newest accepted body, from the process that
        // serves the target; a backup that cannot be written stops the save.
        const current = await readTarget(t);
        if (!current.ok) {
          fail(res, current);
          return;
        }
        // The child's queued write would land over this one.
        if (current.childQueued) {
          res.status(409).json({ success: false, error: childQueuedError(current) });
          return;
        }
        if (refusedAfterRead(res, t)) return;
        let backupCreated: boolean;
        try {
          backupCreated = backupCurrent(t, current.content);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          res.status(500).json({ success: false, error: `Failed to update config: the backup could not be written (${detail}); nothing was saved` });
          return;
        }

        // Database-routed guild: the owning bot process applies the write
        // (mapping mirrors saveGuildConfig); the parent never writes postgres.
        if (guildId && routeFor(guildId) === 'postgres') {
          const reply = await botManager.writeGuildData({
            guildId,
            module: t.guild!.module,
            filename: t.guild!.filename,
            op: 'write',
            contentJson: JSON.stringify(newConfig, null, 2)
          });
          sendHopReply(res, reply ?? { ok: false, code: 'bot-down' }, { backupCreated });
          return;
        }

        // Use appropriate save function based on context
        if (guildId) {
          const outcome = saveGuildConfig(fileId, guildId, newConfig);
          if (outcome === 'frozen') {
            res.status(503).json({ success: false, error: FROZEN });
            return;
          }
          if (outcome !== 'saved') throw new Error(`the guild config was not written (${outcome})`);
          console.log(`[Config] ${fileId} updated successfully for guild ${guildId}`);
        } else {
          saveGlobalConfig(fileId, newConfig);
          console.log(`[Config] ${fileId} updated successfully (global)`);
          nudgeSync('config');
        }

        res.json({
          success: true,
          message: 'Config updated successfully',
          backupCreated
        });
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
      const scope = guildOf(req.query.guildId);
      if (!scope.ok) {
        res.status(400).json({ success: false, error: 'Invalid guildId format' });
        return;
      }
      const resolved = req.query.category === 'data'
        ? resolveDataTarget(fileId, scope.guildId, true)
        : resolveConfigTarget(fileId, scope.guildId);
      if (!resolved.ok) {
        fail(res, resolved);
        return;
      }
      const t = resolved.target;

      // Only this target's own backups (its exact name grammar), newest first.
      const backups = listBackups(BACKUP_DIR, backupKeyOf(t), t.guildId, t.legacy).map(entry => ({
        filename: entry.filename,
        fileId: t.key,
        guildId: t.guildId,
        timestamp: stampDate(entry.stamp),
        size: entry.size,
        damaged: entry.damaged,
        unreadable: entry.unreadable,
        beforeRestore: entry.beforeRestore,
        legacy: entry.legacy,
        shared: entry.shared,
        unchecked: entry.unchecked
      }));

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
   * POST /api/config/restore { file, filename, guildId?, category? }
   * Restore one target from one of its own backups.
   */
  router.post('/restore', async (req: Request, res: Response) => {
    try {
      // Restore writes the master-authoritative global path; co-workers never restore.
      if (isCoWorkerNode()) {
        coWorkerReadonlyResponse(res);
        return;
      }
      const { filename, file, category } = req.body;
      const fileId = file || 'config.json';
      const scope = guildOf(req.body.guildId);
      if (!scope.ok) {
        res.status(400).json({ success: false, error: 'Invalid guildId format' });
        return;
      }
      const guildId = scope.guildId;
      const resolved = category === 'data' ? resolveDataTarget(fileId, guildId, true) : resolveConfigTarget(fileId, guildId);
      if (!resolved.ok) {
        fail(res, resolved);
        return;
      }
      const t = resolved.target;

      if (!isBackupFilename(filename)) {
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

      // A backup of another file or guild never lands here.
      const owned = backupMatch(filename, backupKeyOf(t), t.guildId, t.legacy);
      if (!owned) {
        res.status(400).json({ success: false, error: 'This backup belongs to another file or guild; nothing was restored' });
        return;
      }
      if (owned.shared) {
        res.status(409).json({
          success: false,
          error: owned.unchecked
            ? 'This older backup is named by the file name alone, and which file it belongs to cannot be checked here, so it may not be this file\'s; nothing was restored'
            : 'This older backup is named by the file name alone, which another file also has, so it may not be this file\'s; nothing was restored'
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

      let backupContents: string;
      try {
        backupContents = fs.readFileSync(backupPath, 'utf-8');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code || (error instanceof Error ? error.message : String(error));
        res.status(500).json({ success: false, error: `The backup could not be read (${code}); nothing was restored` });
        return;
      }
      let restoredValue: unknown;
      try {
        restoredValue = JSON.parse(backupContents);
      } catch {
        res.status(422).json({ success: false, error: 'The backup is damaged (it is not valid JSON); nothing was restored' });
        return;
      }

      if (guildId && routeFor(guildId) !== 'postgres' && isGuildWriteFrozen(guildId)) {
        res.status(503).json({ success: false, error: FROZEN });
        return;
      }
      if (hopWriteWithoutBot(t)) {
        sendHopReply(res, { ok: false, code: 'bot-down' });
        return;
      }

      // One operator write of a file at a time, from its read to its write.
      await withTargetLock(t.path, async () => {
        // The undo copy is this target's own, of the newest body it accepted.
        const current = await readTarget(t);
        if (!current.ok) {
          fail(res, current);
          return;
        }
        // The child's queued write would land over this one.
        if (current.childQueued) {
          res.status(409).json({ success: false, error: childQueuedError(current) });
          return;
        }
        if (refusedAfterRead(res, t, true)) return;
        let backupCreated: boolean;
        try {
          backupCreated = backupCurrent(t, current.content, true);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          res.status(500).json({ success: false, error: `The current version could not be backed up (${detail}); nothing was restored` });
          return;
        }

        if (guildId && routeFor(guildId) === 'postgres') {
          const reply = await botManager.writeGuildData({ guildId, module: t.guild!.module, filename: t.guild!.filename, op: 'write', contentJson: backupContents });
          sendHopReply(res, reply ?? { ok: false, code: 'bot-down' }, { backupCreated });
          return;
        }

        // Through the facade, as the target's own save is, so it is ordered by
        // the single per-path write queue.
        if (t.kind === 'config' && guildId) {
          const outcome = saveGuildConfig(fileId, guildId, restoredValue);
          if (outcome === 'frozen') {
            res.status(503).json({ success: false, error: FROZEN });
            return;
          }
          if (outcome !== 'saved') throw new Error(`the guild config was not written (${outcome})`);
        } else if (t.kind === 'config') {
          saveGlobalConfig(fileId, restoredValue);
          nudgeSync('config');
        } else {
          writeRawAtomic(t.path, backupContents);
          if (!guildId) nudgeSync('globaldata');
        }
        console.log(`[Config] Restored ${t.key}${guildId ? ` for guild ${guildId}` : ''} from backup: ${filename}`);

        res.json({
          success: true,
          message: 'Config restored successfully',
          backupCreated
        });
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
      const scope = guildOf(req.query.guildId);

      if (!fileId) {
        res.status(400).json({
          success: false,
          error: 'File ID is required'
        });
        return;
      }
      if (!scope.ok) {
        res.status(400).json({ success: false, error: 'Invalid guildId format' });
        return;
      }

      const resolved = resolveDataTarget(fileId, scope.guildId, true);
      if (!resolved.ok) {
        fail(res, resolved);
        return;
      }
      const t = resolved.target;
      const metadata = t.metadata ?? null;

      // Queue first, from the process that serves it: the child's working set
      // or write queue holds writes this process's disk and the database lack.
      const read = await readTarget(t);
      if (!read.ok) {
        fail(res, read);
        return;
      }
      const exists = read.content !== null;
      if (!metadata && !exists) {
        res.status(404).json({
          success: false,
          error: 'Data file not found'
        });
        return;
      }

      let data: any;
      if (exists) {
        try {
          data = JSON.parse(read.content!);
        } catch (error) {
          res.status(500).json({
            success: false,
            error: 'Failed to parse data file JSON'
          });
          return;
        }
      } else {
        // File doesn't exist - use template or empty object
        data = metadata?.template || {};
      }

      const responseMetadata: DataFileMetadata = metadata
        ? { ...metadata, exists }
        : {
            id: t.guild!.filename,
            path: t.path,
            name: displayNameFor(t.guild!.filename),
            description: 'Orphaned data file (no schema defined)',
            category: 'data',
            exists: true,
            required: false,
            template: undefined,
            scope: 'guild',
            moduleName: t.guild!.module
          };

      res.json({
        success: true,
        data,
        metadata: responseMetadata,
        exists,
        ...(read.notice ? { notice: read.notice } : {})
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
      const postgres = !!guildId && routeFor(guildId) === 'postgres';
      if (!postgres) {
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
          res.status(503).json({ success: false, error: FROZEN });
          return;
        }
      }

      if (!fileId) {
        res.status(400).json({
          success: false,
          error: 'File ID is required'
        });
        return;
      }

      // A postgres doc no discovery lists still resolves by its module/file key,
      // and so does the guild-root file the listing shows from this disk.
      const rootOnDisk = !postgres && !!guildId && typeof fileId === 'string' && SEGMENT.test(fileId)
        && fileId.endsWith('.json') && existsQueueFirst(dataPath(guildId, fileId));
      const resolved = resolveDataTarget(fileId, guildId ?? null, postgres || rootOnDisk);
      if (!resolved.ok) {
        fail(res, resolved);
        return;
      }
      const t = resolved.target;

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

      if (hopWriteWithoutBot(t)) {
        sendHopReply(res, { ok: false, code: 'bot-down' });
        return;
      }
      // One operator write of a file at a time, from its read to its write.
      await withTargetLock(t.path, async () => {
        // The backup holds the newest accepted body, from the process that
        // serves the target; a backup that cannot be written stops the save.
        const current = await readTarget(t);
        if (!current.ok) {
          fail(res, current);
          return;
        }
        // The child's queued write would land over this one.
        if (current.childQueued) {
          res.status(409).json({ success: false, error: childQueuedError(current) });
          return;
        }
        if (refusedAfterRead(res, t)) return;
        let backupCreated: boolean;
        try {
          backupCreated = backupCurrent(t, current.content);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          res.status(500).json({ success: false, error: `Failed to save data file: the backup could not be written (${detail}); nothing was saved` });
          return;
        }

        if (postgres) {
          const reply = await botManager.writeGuildData({
            guildId: guildId!,
            module: t.guild!.module,
            filename: t.guild!.filename,
            op: 'write',
            contentJson: JSON.stringify(newData, null, 2)
          });
          sendHopReply(res, reply ?? { ok: false, code: 'bot-down' }, { backupCreated });
          return;
        }

        // Save through the facade so this write is ordered by the single per-path
        // queue (no race with a queued global/guild write to the same file) and
        // lands atomically via temp+fsync+rename.
        writeRawAtomic(t.path, JSON.stringify(newData, null, 2));
        console.log(`[Data] ${t.key} saved successfully${guildId ? ` for guild ${guildId}` : ' (global)'}`);
        if (!guildId) nudgeSync('globaldata');

        res.json({
          success: true,
          message: 'Data file saved successfully',
          backupCreated
        });
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

      const resolved = resolveDataTarget(fileId, guildId, true);
      if (!resolved.ok) {
        res.status(resolved.status).json({ success: false, error: resolved.error });
        return;
      }
      const reply = await botManager.writeGuildData({
        guildId,
        module: resolved.target.guild!.module,
        filename: resolved.target.guild!.filename,
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
 * Map a guild-write/read hop reply (bot child IPC) onto the HTTP response;
 * extra (a backup's outcome) rides on a success answer.
 */
function sendHopReply(res: Response, reply: any, extra: Record<string, unknown> = {}): void {
  if (reply && reply.ok) {
    if (reply.pending) {
      res.status(202).json({ success: true, pending: true, message: reply.note ? `not yet durable: ${reply.note}` : 'saved, not yet confirmed durable', ...extra });
    } else {
      res.status(200).json({ success: true, ...extra });
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
  // Underscore modules (_guildConfig, _hardLimits, ...) are internal namespaces, never rows.
  const moduleNames = [...new Set([...schemaModules, ...await reader.listModules(guildId)])].filter(name => !name.startsWith('_'));
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
  const keys = new Set<string>(reply.files.filter((key: unknown): key is string => typeof key === 'string' && !key.startsWith('_')));

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
