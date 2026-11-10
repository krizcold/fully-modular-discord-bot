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
import { resolveDataBackend } from '../../utils/envLoader';
import { recognitionRefusal } from '../../bot/internalSetup/utils/dataBackends/recognitionGuard';
import { getWebuiDataReader, isDataBackendUnreachable } from '../utils/webuiDataReader';
import {
  configVersionOf,
  guildOverridesFrom,
  mergeConfigValues,
  ROOT_CONFIG_PATH
} from '../../bot/internalSetup/utils/configManager';
import { rawCheckRefusal } from '../../bot/internalSetup/utils/dataManager';
import { keyRefusal, pathKeyOf, sizeRefusal } from '../../bot/internalSetup/utils/storableData';
import { readMaintenanceFile } from '../../utils/maintenanceFile';
import { dataPath } from '../../utils/dataRoot';
import { backupMatch, isBackupFilename, listBackups, stampDate, writeBackup, type LegacyNames } from '../utils/configBackups';
import { childQueuedError, readServedGlobal, readServedGuild, withTargetLock, type ServedRead } from '../utils/servedRead';
import type { BotManager } from '../botManager';
import { hopFailure, noAnswerText } from './hopFailure';
import { graveyardRouteRefusal, moveUnconfirmedText } from './graveyard';
import { shaOfRaw, CHANGED_SINCE_OPEN_TEXT } from '../../bot/internalSetup/utils/ipcDataHandler';
import { FolderSyncError } from '../../bot/internalSetup/utils/folderChain';
import { planGuildChange, remoteNoAnswerText, sendGuildChange, type Plan } from '../utils/guildRequests';

const CONFIG_NOT_FOUND = 'Config file not found. It may not exist in any scanned directories.';

/**
 * One Config tab target, resolved once for get, update, backups and restore:
 * key is the module-qualified row key (the backup stem); guild holds the
 * child's (module, filename) for a guild document, global the child's address
 * of a global file; path is where it lives on this disk.
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

/** Whether a guild data key ('file.json' or 'module/file.json') names a folder on this disk. */
function folderAtKey(guildId: string, fileId: string): boolean {
  const parts = fileId.split('/');
  if (parts.length > 2 || !fileId.endsWith('.json') || !parts.every(part => SEGMENT.test(part) && part !== '..' && part !== '.')) return false;
  try {
    return fs.statSync(dataPath(guildId, ...parts)).isDirectory();
  } catch {
    return false;
  }
}

// Older backups carry only a bare file id, and config files and data files
// were named alike, so an older name belongs to a target only when no other
// file of that id exists.

/** Whether a config file carries this id. */
function configNamed(id: string): boolean {
  const info = getConfigFileMetadata(id);
  return !!info && (id === 'config.json' || !!info.schema || !!info.moduleName);
}

const postgresServed = (): boolean => resolveDataBackend() === 'postgres';

/**
 * Answers a write the data layer refused for a cause the operator can act on: 'unstorable' 422 with the reason, 'io'
 * 503 with or without one; false for any other answer.
 */
function sendWriteRefusal(res: Response, refusal: { cause: string; reason?: string }): boolean {
  if (refusal.cause === 'unstorable') {
    res.status(422).json({ success: false, error: `The data was not saved: ${refusal.reason}` });
    return true;
  }
  if (refusal.cause === 'io') {
    res.status(503).json({ success: false, error: refusal.reason ? `The data was not saved: ${refusal.reason}. Please try again.` : 'The data was not saved. Please try again.' });
    return true;
  }
  return false;
}

/**
 * Whether this process's discovery cannot see the guild's files: a postgres
 * guild's are in the database, and a file-routed guild with no local dir has
 * none it can check.
 */
function guildFilesUnseen(guildId: string | null): boolean {
  return !!guildId && (postgresServed() || !fs.existsSync(dataPath(guildId)));
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
    if (postgresServed()) {
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
  // 'guildConfigs', a '..'-bearing value) either targets global state through
  // the guild-scoped path or escapes the guild dir via path.join, so it is
  // rejected before it reaches dataPath()/saveGuildConfig.
  const isValidGuildId = (id: unknown): id is string => typeof id === 'string' && /^\d{5,20}$/.test(id);

  const BACKUP_DIR = dataPath('configBackups');

  // Ensure backup directory exists
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  /** The target's newest accepted body, from the process that serves it. */
  const readTarget = (t: ConfigTarget, plan?: Plan): Promise<ServedRead> => (t.guildId
    ? readServedGuild(botManager, { guildId: t.guildId, module: t.guild!.module, filename: t.guild!.filename, path: t.path }, { plan })
    : readServedGlobal(botManager, { ...t.global, path: t.path }));

  /** A durable backup of the body the target holds now; none when it holds none. Throws when it cannot be written. */
  const backupCurrent = (t: ConfigTarget, body: string | null, beforeRestore = false): boolean => {
    if (body === null) return false;
    const written = writeBackup(BACKUP_DIR, backupKeyOf(t), t.guildId, body, beforeRestore);
    console.log(`[Config] Backup ${written.created ? 'created' : 'NOT kept'}: ${path.join(BACKUP_DIR, written.filename)}`);
    return written.created;
  };

  /**
   * The write rules the target's write of text meets, run before its backup so that a refused write writes and
   * prunes no backup: for a file target its rules with P read only, and for a postgres-routed guild K and S here and P
   * from the bot's read. The process that makes the write checks them again.
   */
  const refusalBeforeBackup = (t: ConfigTarget, text: string, current: { unstorable?: string }): { cause: string; reason?: string } | null => {
    if (t.guildId && postgresServed()) {
      const reason = keyRefusal(pathKeyOf(t.guild!.module, t.guild!.filename), 'save') ?? sizeRefusal(text) ?? current.unstorable ?? null;
      if (reason === null) return null;
      console.error(`[Config] Refused a write of ${t.key} for guild ${t.guildId}: ${reason}; nothing was saved`);
      return { cause: 'unstorable', reason };
    }
    return rawCheckRefusal(t.path, text);
  };

  const fail = (res: Response, failure: { status: number; error: string; code?: string }) => {
    res.status(failure.status).json({ success: false, error: failure.error, ...(failure.code ? { code: failure.code } : {}) });
  };

  /** A postgres-routed guild's change is planned (NB7 decision 3) inside its target lock, before its read. */
  const plannedTarget = (t: ConfigTarget): boolean => !!t.guildId && postgresServed();

  /** The plan of a postgres-routed guild's write, or undefined for any other target; a refusal is answered here. */
  const planWrite = async (t: ConfigTarget, res: Response): Promise<{ plan?: Plan } | null> => {
    if (!plannedTarget(t)) return {};
    const plan = await planGuildChange(botManager, t.guildId!, 'write');
    if (plan.kind !== 'refuse') return { plan };
    sendHopReply(res, plan.reply);
    return null;
  };

  /** A write the route cannot make now (the web panel exiting, the bot stopping, starting or waiting): refused before its read. */
  const refuseBeforeRead = (t: ConfigTarget, res: Response): boolean => {
    const refusal = botManager.writeRefusal(t.guildId ? 'guild' : 'shared');
    if (!refusal) return false;
    res.status(refusal.status).json({ success: false, error: refusal.error });
    return true;
  };

  /**
   * The target's write, built on the body read (expectSha): the bot process applies it, or the local chain with no bot;
   * a planned guild write goes by its plan, to this machine's bot process or as a request to the machine that runs it.
   */
  const writeTarget = (t: ConfigTarget, contentJson: string, expectSha: string, twin?: { root?: 'config'; rel?: string; expectSha: string }, sinceOpen = false, plan?: Plan): Promise<any> => {
    if (!t.guildId) return botManager.runSharedOp('global.write', { ...t.global, contentJson, expectSha, ...(sinceOpen ? { sinceOpen } : {}) });
    const payload = { guildId: t.guildId, module: t.guild!.module, filename: t.guild!.filename, op: 'write' as const, contentJson, expectSha, ...(twin ? { twin } : {}), ...(sinceOpen ? { sinceOpen } : {}) };
    return plan ? sendGuildChange(botManager, plan, payload) : botManager.writeGuildData(payload);
  };

  /** The bot refuses to serve guild data while DATA_BACKEND names the store the data does not live in: say why instead of listing or writing the wrong one. */
  const refuseGuildOffStore = (guildId: string | null | undefined, res: Response, write: boolean): boolean => {
    if (!guildId) return false;
    const reason = recognitionRefusal();
    if (!reason) return false;
    res.status(503).json({ success: false, error: `${write ? 'Nothing was saved' : 'Guild data is not served'}: ${reason}.` });
    return true;
  };

  /** A guild write waits out a data migration, and on a JSON bot a maintenance the manager set (the data may be moving). */
  const refuseGuildWrite = (guildId: string | null | undefined, res: Response): boolean => {
    if (!guildId) return false;
    const running = botManager.migrationRunning?.();
    if (running) {
      res.status(503).json({ success: false, error: `Nothing was saved: a data migration is running (migration ${running.jobId}).` });
      return true;
    }
    if (!postgresServed() && readMaintenanceFile().state === 'maintenance') {
      res.status(503).json({ success: false, error: 'Nothing was saved: the bot is in maintenance.' });
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
      if (refuseGuildOffStore(guildId, res, false)) return;

      // If guild ID provided, return guild-specific configs + data files
      let files;
      if (guildId && postgresServed()) {
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
      if (refuseGuildOffStore(t.guildId, res, false)) return;

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
        version: configVersionOf(savedValues, globalValues, t.configInfo),
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
      // Any guild-scoped write must carry a genuine snowflake: a
      // reserved sentinel like 'global' would otherwise hit the same file as a
      // global write and escape the guild-scoped allowance. A null/absent
      // guildId is a legitimate global write and routes below.
      if (guildId != null && !isValidGuildId(guildId)) {
        res.status(400).json({ success: false, error: 'Invalid guildId format' });
        return;
      }
      if (refuseGuildWrite(guildId, res)) return;
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

      if (refuseGuildOffStore(t.guildId, res, true)) return;
      if (!plannedTarget(t) && refuseBeforeRead(t, res)) return;
      // One operator write of a file at a time, from its plan and read to its write.
      await withTargetLock(t.path, async () => {
        const planned = await planWrite(t, res);
        if (!planned) return;
        // The backup holds the newest accepted body, from the process that
        // serves the target; a backup that cannot be written stops the save.
        const current = await readTarget(t, planned.plan);
        if (!current.ok) {
          fail(res, current);
          return;
        }
        // The child's queued write would land over this one.
        if (current.childQueued) {
          res.status(409).json({ success: false, error: childQueuedError(current) });
          return;
        }
        let toStore: Record<string, any> = newConfig;
        let twinSha: string | null = null;
        if (req.body.version !== undefined || req.body.effective === true) {
          let globalBody: string | null = null;
          if (t.globalTwin) {
            const twin = await readServedGlobal(botManager, t.globalTwin);
            if (!twin.ok) {
              fail(res, twin);
              return;
            }
            globalBody = twin.content;
            twinSha = shaOfRaw(globalBody);
          }
          let savedValues: Record<string, any>;
          let globalValues: Record<string, any>;
          try {
            savedValues = current.content === null ? {} : JSON.parse(current.content);
            globalValues = globalBody === null ? {} : JSON.parse(globalBody);
          } catch {
            res.status(500).json({ success: false, error: 'Failed to update config: the stored file is not valid JSON; nothing was saved' });
            return;
          }
          if (req.body.version !== undefined && req.body.version !== configVersionOf(savedValues, globalValues, t.configInfo)) {
            res.status(409).json({ success: false, error: 'This config changed since you loaded it; nothing was saved. Reload it to see the current values.' });
            return;
          }
          if (req.body.effective === true && t.guildId) {
            toStore = guildOverridesFrom(newConfig, savedValues, globalValues, t.configInfo);
          }
        }
        const refusal = refusalBeforeBackup(t, JSON.stringify(toStore, null, 2), current);
        if (refusal && sendWriteRefusal(res, refusal)) return;
        let backupCreated: boolean;
        try {
          backupCreated = backupCurrent(t, current.content);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          res.status(500).json({
            success: false,
            error: error instanceof FolderSyncError
              ? `Failed to update config: nothing was saved, because the backup of ${t.key} can't be confirmed as saved: ${detail}`
              : `Failed to update config: the backup could not be written (${detail}); nothing was saved`,
          });
          return;
        }

        // The bot process applies the write while it runs; with none, the web UI's local chain does. Either compares
        // the stored body with the one read here, in the write's own turn.
        const twin = twinSha !== null && t.globalTwin ? { root: t.globalTwin.root, rel: t.globalTwin.rel, expectSha: twinSha } : undefined;
        const reply = await writeTarget(t, JSON.stringify(toStore, null, 2), shaOfRaw(current.content), twin, false, planned.plan);
        if (reply?.ok && !reply.pending) console.log(`[Config] ${fileId} updated successfully ${guildId ? `for guild ${guildId}` : '(global)'}`);
        sendHopReply(res, reply, { backupCreated, storedKeys: Object.keys(toStore).length });
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
      const { filename, file, category } = req.body;
      const fileId = file || 'config.json';
      const scope = guildOf(req.body.guildId);
      if (!scope.ok) {
        res.status(400).json({ success: false, error: 'Invalid guildId format' });
        return;
      }
      const guildId = scope.guildId;
      if (refuseGuildWrite(guildId, res)) return;
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

      if (refuseGuildOffStore(t.guildId, res, true)) return;
      if (!plannedTarget(t) && refuseBeforeRead(t, res)) return;

      // One operator write of a file at a time, from its plan and read to its write.
      await withTargetLock(t.path, async () => {
        const planned = await planWrite(t, res);
        if (!planned) return;
        // The undo copy is this target's own, of the newest body it accepted.
        const current = await readTarget(t, planned.plan);
        if (!current.ok) {
          fail(res, current);
          return;
        }
        // The child's queued write would land over this one.
        if (current.childQueued) {
          res.status(409).json({ success: false, error: childQueuedError(current) });
          return;
        }
        // A config file is written as its own save writes it; a data file as the backup holds it.
        const body = t.kind === 'config' ? JSON.stringify(restoredValue, null, 2) : backupContents;
        const refusal = refusalBeforeBackup(t, body, current);
        if (refusal && sendWriteRefusal(res, refusal)) return;
        let backupCreated: boolean;
        try {
          backupCreated = backupCurrent(t, current.content, true);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          res.status(500).json({
            success: false,
            error: error instanceof FolderSyncError
              ? `Nothing was restored, because the backup of the current version can't be confirmed as saved: ${detail}`
              : `The current version could not be backed up (${detail}); nothing was restored`,
          });
          return;
        }

        const reply = await writeTarget(t, body, shaOfRaw(current.content), undefined, false, planned.plan);
        if (reply?.ok && !reply.pending) console.log(`[Config] Restored ${t.key}${guildId ? ` for guild ${guildId}` : ''} from backup: ${filename}`);
        sendHopReply(res, reply, { backupCreated });
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
      if (refuseGuildOffStore(t.guildId, res, false)) return;
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
        // The body the editor loads, which its save sends back as loadedSha.
        sha: shaOfRaw(read.content),
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

      // A guild-scoped data write must be a genuine snowflake, or a
      // sentinel/traversal value would reach global data. A null/absent
      // guildId is a legitimate global write and routes below.
      if (guildId != null && !isValidGuildId(guildId)) {
        res.status(400).json({ success: false, error: 'Invalid guildId format' });
        return;
      }
      if (refuseGuildWrite(guildId, res)) return;
      // The webui parent never writes postgres; database-routed guild writes
      // go through the bot process.
      const postgres = !!guildId && postgresServed();

      if (!fileId) {
        res.status(400).json({
          success: false,
          error: 'File ID is required'
        });
        return;
      }

      // A postgres doc no discovery lists still resolves by its module/file key,
      // and so does the guild-root file the listing shows from this disk, and a
      // key with a folder in its place, which the write then removes or refuses.
      const rootOnDisk = !postgres && !!guildId && typeof fileId === 'string' && SEGMENT.test(fileId)
        && fileId.endsWith('.json') && existsQueueFirst(dataPath(guildId, fileId));
      const folderInPlace = !postgres && !!guildId && typeof fileId === 'string' && folderAtKey(guildId, fileId);
      const resolved = resolveDataTarget(fileId, guildId ?? null, postgres || rootOnDisk || folderInPlace);
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
      const loadedSha = req.body.loadedSha;
      if (typeof loadedSha !== 'string' || loadedSha.length === 0) {
        res.status(400).json({ success: false, error: 'This page is out of date; nothing was saved. Reload the page and open the file again.' });
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

      if (refuseGuildOffStore(t.guildId, res, true)) return;
      if (!plannedTarget(t) && refuseBeforeRead(t, res)) return;
      // One operator write of a file at a time, from its plan and read to its write.
      await withTargetLock(t.path, async () => {
        const planned = await planWrite(t, res);
        if (!planned) return;
        // The backup holds the newest accepted body, from the process that
        // serves the target; a backup that cannot be written stops the save.
        const current = await readTarget(t, planned.plan);
        if (!current.ok) {
          fail(res, current);
          return;
        }
        // The child's queued write would land over this one.
        if (current.childQueued) {
          res.status(409).json({ success: false, error: childQueuedError(current) });
          return;
        }
        // A change made since the editor loaded the file is never replaced by the editor's older copy.
        if (shaOfRaw(current.content) !== loadedSha) {
          res.status(409).json({ success: false, error: CHANGED_SINCE_OPEN_TEXT });
          return;
        }
        const refusal = refusalBeforeBackup(t, JSON.stringify(newData, null, 2), current);
        if (refusal && sendWriteRefusal(res, refusal)) return;
        let backupCreated: boolean;
        try {
          backupCreated = backupCurrent(t, current.content);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          res.status(500).json({
            success: false,
            error: error instanceof FolderSyncError
              ? `Failed to save data file: nothing was saved, because the backup of ${t.key} can't be confirmed as saved: ${detail}`
              : `Failed to save data file: the backup could not be written (${detail}); nothing was saved`,
          });
          return;
        }

        const reply = await writeTarget(t, JSON.stringify(newData, null, 2), loadedSha, undefined, true, planned.plan);
        if (reply?.ok && !reply.pending) console.log(`[Data] ${t.key} saved successfully${guildId ? ` for guild ${guildId}` : ' (global)'}`);
        sendHopReply(res, reply, { backupCreated });
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
   * Delete a guild data file; the bot child applies it.
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
      if (refuseGuildWrite(guildId, res)) return;

      const resolved = resolveDataTarget(fileId, guildId, true);
      if (!resolved.ok) {
        res.status(resolved.status).json({ success: false, error: resolved.error });
        return;
      }
      if (refuseGuildOffStore(guildId, res, true)) return;
      const plan = await planGuildChange(botManager, guildId, 'delete');
      const reply = await sendGuildChange(botManager, plan, {
        guildId,
        module: resolved.target.guild!.module,
        filename: resolved.target.guild!.filename,
        op: 'delete'
      });
      sendHopReply(res, reply ?? { ok: false, code: 'bot-down' }, {}, 'delete');
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
   * Delete every data file for a guild (namespace removal in the bot process).
   */
  router.post('/data/delete-guild', async (req: Request, res: Response) => {
    try {
      const guildId = req.body.guildId;

      if (!isValidGuildId(guildId)) {
        res.status(400).json({ success: false, error: 'A valid guildId is required' });
        return;
      }
      if (refuseGuildWrite(guildId, res)) return;
      if (refuseGuildOffStore(guildId, res, true)) return;

      const plan = await planGuildChange(botManager, guildId, 'delete-namespace');
      const reply = await sendGuildChange(botManager, plan, {
        guildId,
        module: '',
        filename: '',
        op: 'delete-namespace'
      });
      sendHopReply(res, reply ?? { ok: false, code: 'bot-down' }, reply?.ok && typeof reply.moveUnconfirmed === 'string' ? { warning: moveUnconfirmedText(reply.moveUnconfirmed, 'delete') } : {}, 'guild-delete');
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

const PENDING_TEXT = 'not confirmed as saved yet; reload in a moment to check';

// The bot commits or renames nothing past 40 s after the send, so a reload at once could show data a late delete removes.
const GUILD_DELETE_MINUTE = 'Within a minute, `smdb graveyard list` lists a new entry for this server if it was deleted (on a database, an entry with the reason webui-operator-delete); if no such entry is listed by then, it was not. The list reads the data of the bot behind the web panel it asks; if the main database was replaced meanwhile, check once that bot runs on the new main.';

function noAnswerReplyText(cause: unknown, what: 'write' | 'delete' | 'guild-delete'): string {
  const text = noAnswerText(cause, what);
  return what === 'guild-delete' ? text.replace(/ Reload to check\.$/, ` ${GUILD_DELETE_MINUTE}`) : text;
}

/**
 * Map a guild-write/read hop reply (bot child IPC) onto the HTTP response;
 * extra (a backup's outcome) rides on a success answer.
 */
export function sendHopReply(res: Response, reply: any, extra: Record<string, unknown> = {}, what: 'write' | 'delete' | 'guild-delete' = 'write'): void {
  // NB7 decision 9: an answer another machine's bot gave is prefixed with its name; the sender's own answers are not.
  const servedBy = reply && typeof reply.servedBy === 'string' ? reply.servedBy : null;
  const on = (text: string) => (servedBy && !reply.sender ? `On ${servedBy}: ${text}` : text);
  const by = servedBy ? { servedBy } : {};
  // A change the bot never answered: nobody knows whether it was saved.
  if (reply && reply.noAnswer) {
    res.status(503).json({ success: false, code: 'no-answer', error: servedBy ? remoteNoAnswerText(reply.noAnswer, servedBy, what) : noAnswerReplyText(reply.noAnswer, what), ...by });
    return;
  }
  if (reply && reply.ok) {
    if (reply.pending) {
      res.status(202).json({ success: true, pending: true, message: on(reply.note ?? PENDING_TEXT), ...extra, ...by });
    } else {
      res.status(200).json({ success: true, ...extra, ...by });
    }
    return;
  }
  if (reply?.code === 'no-holder' || reply?.code === 'not-taken') {
    res.status(503).json({ success: false, code: reply.code, error: hopFailure(reply.code, reply.error)!.error, ...by });
    return;
  }
  // A shared op the bot accepted and has not confirmed on disk yet; built while the bot stops, its text says it may be lost.
  if (reply?.code === 'unconfirmed' && !reply.stopWorded && !reply.stopping && (reply.answer === 'pending' || reply.answer === 'held')) {
    res.status(202).json({ success: true, pending: true, message: reply.answer === 'pending' ? PENDING_TEXT : reply.error, ...extra });
    return;
  }
  const detail = reply && typeof reply.error === 'string' ? reply.error : undefined;
  const refused = what === 'guild-delete' ? graveyardRouteRefusal(reply?.code, detail, 'guild-delete') : null;
  if (refused) {
    res.status(503).json({ success: false, error: on(refused), ...by });
    return;
  }
  const failure = hopFailure(reply?.code, detail);
  if (failure) {
    res.status(failure.status).json({ success: false, error: on(failure.error), ...by });
    return;
  }
  switch (reply?.code) {
    case 'invalid':
      res.status(400).json({ success: false, error: on(detail || 'Invalid request'), ...by });
      return;
    default:
      res.status(500).json({ success: false, error: on(detail || 'Guild data operation failed'), ...by });
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
