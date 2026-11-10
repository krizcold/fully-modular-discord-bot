/**
 * App Store Routes
 *
 * API endpoints for managing App Store repositories, modules, and credentials.
 */

import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { getModuleRegistry } from '../../bot/internalSetup/utils/moduleRegistry';
import {
  getAppStoreManager,
  AppStoreRepository,
  StoreModuleInfo,
  StoreWriteError,
} from '../../bot/internalSetup/utils/appStoreManager';
import { getPremiumManager, DEFAULT_MESSAGES, PremiumMessages } from '../../bot/internalSetup/utils/premiumManager';
import {
  globalModuleConfigFrom,
  globalSettingsRel,
  loadGlobalModuleConfig,
  type GlobalModuleConfig,
} from '../../bot/internalSetup/utils/settings/settingsStorage';
import { getModulesWithSettings, getSettingsSchema } from '../../bot/internalSetup/utils/settings/settingsDiscovery';
import { moduleConfigErrors } from '../../bot/internalSetup/utils/settings/settingsValidation';
import type { HardLimitOverride, SettingValue } from '../../bot/types/settingsTypes';
import { getPaymentRegistry } from '../../bot/internalSetup/utils/payment/paymentRegistry';
import type { OfferingVariant } from '../../bot/internalSetup/utils/payment/paymentTypes';
import {
  credentialsReadError, loadCredentials, providerCredentials, providerCredentialsUnread, providerDocKey,
  resolveDataBackend, saveCredentials, BotCredentials,
} from '../../utils/envLoader';
import { dataPath } from '../../utils/dataRoot';
import { getModulesDir, getModulesDevDir } from '../../bot/internalSetup/utils/pathHelpers';
import { BotManager, inStoreWrite } from '../botManager';
import { ComponentToggleDebouncer } from '../utils/componentToggleDebouncer';
import { getInstallQueue } from '../utils/installQueue';
import { readConfigFile, writeConfigFile } from '../../bot/internalSetup/utils/appStoreConfigFile';
import { FolderSyncError, writeErrorText } from '../../bot/internalSetup/utils/folderChain';
import { childQueuedError, readServedGlobal, withTargetLock } from '../utils/servedRead';
import { SharedOpAnswered, sharedOpFailure, sharedOpRunner } from './hopFailure';
import { shaOfRaw } from '../../bot/internalSetup/utils/ipcDataHandler';
import { rowBackend } from '../../bot/internalSetup/utils/sharedStore';

/**
 * A module's Free baseline (its global settings.json) as the process that
 * serves it holds it, queue first: the raw body, for a save to build on, and
 * the config view of it.
 */
const baselinePath = (moduleName: string) => dataPath('global', ...globalSettingsRel(moduleName).split('/'));

async function servedBaseline(botManager: BotManager, moduleName: string): Promise<
  | { ok: true; raw: Record<string, any>; text: string | null; config: GlobalModuleConfig; childQueued: boolean; childFailing: boolean; notice?: string }
  | { ok: false; status: number; error: string }
> {
  if (!/^[A-Za-z0-9_-]+$/.test(moduleName)) return { ok: false, status: 400, error: 'invalid moduleName' };
  const read = await readServedGlobal(botManager, { rel: globalSettingsRel(moduleName), path: baselinePath(moduleName) });
  if (!read.ok) return read;
  let raw: Record<string, any> = {};
  if (read.content !== null) {
    try {
      raw = JSON.parse(read.content);
    } catch {
      return { ok: false, status: 500, error: `the global settings of ${moduleName} are not valid JSON` };
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, status: 500, error: `the global settings of ${moduleName} are not an object` };
    }
  }
  return {
    ok: true,
    raw,
    text: read.content,
    config: globalModuleConfigFrom(raw),
    childQueued: read.childQueued === true,
    childFailing: read.childFailing === true,
    ...(read.notice ? { notice: read.notice } : {}),
  };
}

/**
 * Refresh each enabled ProviderLink's variant cache from its provider at
 * save time. Per-link is independent in the new model (no cross-provider
 * price lock): each link validates its own variantIds (Price mode) or
 * productId (Product mode) against the provider's API and stores the
 * resulting variants in `link.cache`.
 *
 * Records non-fatal issues into `warnings`; disables links whose provider
 * can't satisfy their declared mode (e.g. Discord with Product mode).
 * Lookup failures leave `link.cache` whatever it was (transient errors
 * shouldn't tear down a working offering).
 */
async function refreshOfferingProviderLinks(offering: any, warnings: string[]): Promise<any> {
  const out = { ...offering };
  const linksIn = Array.isArray(offering?.providerLinks) ? offering.providerLinks : [];
  const linksOut: any[] = [];
  for (const linkRaw of linksIn) {
    const link = { ...linkRaw, cache: linkRaw.cache ? { ...linkRaw.cache } : undefined };
    if (!link.enabled) {
      linksOut.push(link);
      continue;
    }
    const provider = getPaymentRegistry().get(link.providerId);
    if (!provider) {
      link.enabled = false;
      warnings.push(`Provider '${link.providerId}' is not registered; link disabled.`);
      linksOut.push(link);
      continue;
    }
    if (!provider.isConfigured()) {
      // Provider is wired in code but missing creds; keep the config but
      // let the admin know nothing will validate until they set creds.
      warnings.push(`Provider '${link.providerId}' is not configured (missing credentials). Variants will refresh once configured.`);
      linksOut.push(link);
      continue;
    }
    try {
      if (link.mode === 'product') {
        if (!provider.capabilities.supportsProductMode || !provider.listVariants) {
          warnings.push(`Provider '${link.providerId}' does not support Product mode; link disabled.`);
          link.enabled = false;
        } else if (!link.productConfig?.productId) {
          warnings.push(`Provider '${link.providerId}' link has no productId; link disabled.`);
          link.enabled = false;
        } else {
          const variants = await provider.listVariants(link.productConfig.productId);
          link.cache = {
            syncedAt: new Date().toISOString(),
            variants,
          };
          // Prune label overrides that no longer point at a real variant.
          // Keeping orphaned entries grows the config file forever and shows
          // up as ghost rows if the variant ever returns under the same id.
          const overrides = link.productConfig.variantLabelOverrides;
          if (overrides && typeof overrides === 'object') {
            const validIds = new Set(variants.map(v => v.variantId));
            const cleaned: Record<string, string> = {};
            for (const [id, label] of Object.entries(overrides)) {
              if (validIds.has(id) && typeof label === 'string' && label.length > 0) {
                cleaned[id] = label;
              }
            }
            link.productConfig = { ...link.productConfig, variantLabelOverrides: cleaned };
          }
        }
      } else {
        // Price mode (default).
        const entries = Array.isArray(link.priceConfig?.entries) ? link.priceConfig.entries : [];
        if (entries.length === 0) {
          warnings.push(`Provider '${link.providerId}' link has no priceConfig entries; link disabled.`);
          link.enabled = false;
        } else if (!provider.fetchVariant) {
          warnings.push(`Provider '${link.providerId}' does not support Price mode; link disabled.`);
          link.enabled = false;
        } else {
          const variants: OfferingVariant[] = [];
          for (const entry of entries) {
            try {
              const v = await provider.fetchVariant(entry.variantId);
              if (v) {
                variants.push(entry.labelOverride ? { ...v, label: entry.labelOverride } : v);
              } else {
                warnings.push(`Variant '${entry.variantId}' on '${link.providerId}' could not be resolved (missing or archived).`);
              }
            } catch (err: any) {
              warnings.push(`Failed to fetch variant '${entry.variantId}' on '${link.providerId}': ${err?.message || err}`);
            }
          }
          link.cache = {
            syncedAt: new Date().toISOString(),
            variants,
          };
        }
      }
    } catch (err: any) {
      warnings.push(`Refresh failed for '${link.providerId}' on '${out.label || out.id}': ${err?.message || err}`);
    }
    linksOut.push(link);
  }
  out.providerLinks = linksOut;

  // primaryProviderId only stays valid if it points to an enabled link.
  if (out.primaryProviderId) {
    const primaryLink = linksOut.find(l => l.providerId === out.primaryProviderId);
    if (!primaryLink || !primaryLink.enabled) {
      delete out.primaryProviderId;
    }
  }
  return out;
}

/** Decision 28's answer for a StoreWriteError (409, 500 or 202 with its text); false for any other error. */
function storeWriteAnswered(res: Response, error: unknown): boolean {
  if (!(error instanceof StoreWriteError)) return false;
  res.status(error.status).json({ success: false, error: error.message });
  return true;
}

/** A credential value the forms count as set. */
const isSet = (v: string | undefined): boolean => !!(v && v.trim() && !v.startsWith('REPLACE'));

/** The premium tab's status for a built-in provider's keys while the credentials doc cannot be read; null when it can. */
function docUnread(providerId: string): string | null {
  const unread = providerCredentialsUnread(providerId);
  return unread === null ? null : `can't confirm: ${unread}`;
}

const FAILED_STATUS_SQL = "SELECT s.module, s.node_name, s.sha, s.error, m.version FROM smdb_data.shared_module_status s LEFT JOIN smdb_data.shared_modules m ON m.module = s.module AND m.sha = s.sha WHERE s.state = 'failed' ORDER BY s.module, s.node_name";

/** A machine where a module's version failed to load (owner question 1); the version is the module row's, else the sha. */
export interface ModuleFailure {
  module: string;
  version: string;
  machine: string;
  error: string;
}

/** On a Postgres bot, the machines whose status row says 'failed', read on the reader pool, or the read's cause; null on a JSON bot. */
async function moduleFailures(): Promise<{ moduleFailures: ModuleFailure[] } | { moduleFailuresUnread: string } | null> {
  if (resolveDataBackend() !== 'postgres') return null;
  const backend = rowBackend();
  if (!backend?.sharedSelect) return { moduleFailuresUnread: "this process has no connection to the bot's database" };
  try {
    const { rows } = await backend.sharedSelect(FAILED_STATUS_SQL, [], 10_000);
    return {
      moduleFailures: rows.map(row => ({
        module: String(row.module),
        version: row.version ? String(row.version) : String(row.sha),
        machine: String(row.node_name),
        error: row.error === null || row.error === undefined ? '' : String(row.error),
      })),
    };
  } catch (error) {
    return { moduleFailuresUnread: error instanceof Error ? error.message : String(error) };
  }
}

export function createAppStoreRoutes(botManager: BotManager): Router {
  const shared = sharedOpRunner(botManager);
  const toggleDebouncer = new ComponentToggleDebouncer(1500);
  const installQueue = getInstallQueue();
  installQueue.setBotManager(botManager);
  const router = Router();

  /** Decision 31: with no bot child, the route first brings the App Store docs up to the rows; false when it answered. */
  const storeFirst = async (res: Response): Promise<boolean> => {
    if (resolveDataBackend() !== 'postgres') return true;
    const refused = await botManager.storeDocsFirst();
    if (!refused) return true;
    res.status(refused.status).json({ success: false, error: refused.error });
    return false;
  };

  // ============================================================================
  // BUNDLED DATA (single request for all AppStore data)
  // ============================================================================

  /**
   * GET /api/appstore/bundle
   * Returns all AppStore data in a single response to avoid multiple API calls.
   */
  router.get('/bundle', async (_req: Request, res: Response) => {
    try {
      if (!(await storeFirst(res))) return;
      const manager = getAppStoreManager();
      const premiumMgr = getPremiumManager();

      // Use fast cache; fall back to full fetch (with git clone) if cache is empty
      let modules = manager.getCachedModules();
      if (modules.length === 0 && manager.getRepositories().some(r => r.enabled)) {
        modules = await manager.getAvailableModules();
      }
      const installedRaw = manager.getInstalledModules();
      const repos = manager.getRepositories();

      // The Free tier view reads each baseline from the process that serves it.
      // A refused read is named, never filled from this process's older view,
      // since the Free editor saves whole modules over what it was shown.
      const freeBaselines = new Map<string, GlobalModuleConfig>();
      const baselineUnavailable: Record<string, string> = {};
      let baselineNotice: string | undefined;
      await Promise.all(getModulesWithSettings().map(async ({ name }) => {
        const served = await servedBaseline(botManager, name);
        if (served.ok) {
          freeBaselines.set(name, served.config);
          baselineNotice = baselineNotice ?? served.notice;
        } else {
          baselineUnavailable[name] = served.error;
        }
      }));
      const tiers = premiumMgr.getAllTiersWithEffectiveFree(name => freeBaselines.get(name)
        ?? (name in baselineUnavailable ? globalModuleConfigFrom({}) : loadGlobalModuleConfig(name)));
      if (tiers.free && (baselineNotice || Object.keys(baselineUnavailable).length > 0)) {
        tiers.free = {
          ...tiers.free,
          ...(baselineNotice ? { baselineNotice } : {}),
          ...(Object.keys(baselineUnavailable).length > 0 ? { baselineUnavailable } : {}),
        } as typeof tiers.free;
      }
      const loadedNames = await botManager.listLoadedModules();
      const loadedSet = loadedNames ? new Set(loadedNames) : null;
      const installed = installedRaw.map(m => ({
        ...m,
        loaded: loadedSet ? loadedSet.has(m.name) : null
      }));
      const failures = await moduleFailures();

      res.json({
        success: true,
        modules: modules.map(m => formatModuleInfo(m)),
        installed,
        ...failures,
        repositories: repos.map(repo => ({
          ...repo,
          githubToken: repo.githubToken ? '***' : null
        })),
        tiers,
        subscriptions: premiumMgr.getAllSubscriptions(),
        messages: premiumMgr.getMessages(),
        messageDefaults: DEFAULT_MESSAGES,
        installQueue: installQueue.getSnapshot()
      });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // ============================================================================
  // REPOSITORY MANAGEMENT
  // ============================================================================

  /**
   * GET /api/appstore/repos
   * List all configured repositories
   */
  router.get('/repos', async (_req: Request, res: Response) => {
    try {
      if (!(await storeFirst(res))) return;
      const manager = getAppStoreManager();
      const repos = manager.getRepositories();

      // Mask GitHub tokens
      const safeRepos = repos.map(repo => ({
        ...repo,
        githubToken: repo.githubToken ? '***' : null
      }));

      res.json({
        success: true,
        repositories: safeRepos
      });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  /**
   * POST /api/appstore/repos
   * Add a new repository
   * Body: { name, url, branch?, githubToken? }
   */
  router.post('/repos', async (req: Request, res: Response) => {
    try {
      if (!(await storeFirst(res))) return;
      const { name, url, branch, githubToken } = req.body;

      if (!name || typeof name !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Repository name is required'
        });
      }

      if (!url || typeof url !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Repository URL is required'
        });
      }

      const manager = getAppStoreManager();

      // Normalize URL first (strips /tree/branch, .git, etc.)
      const normalized = manager.normalizeGitUrl(url);
      const finalBranch = branch || normalized.branch || 'main';

      // Test access before saving; catches bad tokens / wrong URLs early
      const testRepo = { url: normalized.url, branch: finalBranch, githubToken: githubToken || null } as any;
      const access = manager.testRepoAccess(testRepo);
      if (!access.ok) {
        return res.status(400).json({
          success: false,
          error: access.error || 'Could not access repository'
        });
      }

      const repo = await inStoreWrite(() => manager.addRepositoryAwaited(
        name,
        url,
        finalBranch,
        githubToken
      ));

      // Immediately clone and scan for modules. The repo itself was added
      // successfully; if the scan fails (auth, DNS, malformed manifest) the
      // repo stays in the registry but we surface the failure so the client
      // doesn't think the modules are simply empty - that was the previous
      // false-positive: catch + log + return success:true with modules: [].
      let modules: any[] = [];
      let refreshWarning: string | undefined;
      try {
        const scanned = await inStoreWrite(() => manager.refreshRepository(repo.id));
        modules = scanned.map(m => formatModuleInfo(m));
      } catch (refreshErr) {
        refreshWarning = refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
        console.error('[AppStore] Auto-refresh after add failed:', refreshErr);
      }

      res.json({
        success: !refreshWarning,
        repository: {
          ...repo,
          githubToken: repo.githubToken ? '***' : null
        },
        modules,
        ...(refreshWarning
          ? { warning: `Repository added but module scan failed: ${refreshWarning}. Click Refresh to retry.` }
          : {}),
      });
    } catch (error) {
      if (storeWriteAnswered(res, error)) return;
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  /**
   * PUT /api/appstore/repos/:id
   * Update a repository
   * Body: { name?, url?, branch?, githubToken?, enabled? }
   */
  router.put('/repos/:id', async (req: Request, res: Response) => {
    try {
      if (!(await storeFirst(res))) return;
      const { id } = req.params;
      const updates = req.body as Partial<AppStoreRepository>;

      const manager = getAppStoreManager();

      if (!manager.getRepository(id)) {
        return res.status(404).json({
          success: false,
          error: 'Repository not found'
        });
      }

      const success = await inStoreWrite(() => manager.updateRepositoryAwaited(id, updates));

      if (!success) {
        return res.status(500).json({
          success: false,
          error: 'Failed to update repository'
        });
      }

      const repo = manager.getRepository(id);
      res.json({
        success: true,
        repository: {
          ...repo,
          githubToken: repo?.githubToken ? '***' : null
        }
      });
    } catch (error) {
      if (storeWriteAnswered(res, error)) return;
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  /**
   * DELETE /api/appstore/repos/:id
   * Remove a repository
   */
  router.delete('/repos/:id', async (req: Request, res: Response) => {
    try {
      if (!(await storeFirst(res))) return;
      const { id } = req.params;
      const manager = getAppStoreManager();

      if (!manager.getRepository(id)) {
        return res.status(404).json({
          success: false,
          error: 'Repository not found'
        });
      }

      const success = await inStoreWrite(() => manager.removeRepositoryAwaited(id));

      res.json({
        success,
        message: success ? 'Repository removed' : 'Failed to remove repository'
      });
    } catch (error) {
      if (storeWriteAnswered(res, error)) return;
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  /**
   * POST /api/appstore/repos/:id/refresh
   * Refresh modules from a repository
   */
  router.post('/repos/:id/refresh', async (req: Request, res: Response) => {
    try {
      if (!(await storeFirst(res))) return;
      const { id } = req.params;
      const manager = getAppStoreManager();

      if (!manager.getRepository(id)) {
        return res.status(404).json({
          success: false,
          error: 'Repository not found'
        });
      }

      const modules = await inStoreWrite(() => manager.refreshRepository(id));

      res.json({
        success: true,
        modules: modules.map(m => formatModuleInfo(m))
      });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  // ============================================================================
  // MODULE MANAGEMENT
  // ============================================================================

  /**
   * GET /api/appstore/modules
   * List all available modules from all enabled repositories
   */
  router.get('/modules', async (_req: Request, res: Response) => {
    try {
      if (!(await storeFirst(res))) return;
      const manager = getAppStoreManager();
      const modules = await manager.getAvailableModules();

      res.json({
        success: true,
        modules: modules.map(m => formatModuleInfo(m))
      });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  /**
   * GET /api/appstore/modules/:name
   * Get details for a specific module
   */
  router.get('/modules/:name', async (req: Request, res: Response) => {
    try {
      if (!(await storeFirst(res))) return;
      const { name } = req.params;
      const manager = getAppStoreManager();
      const moduleInfo = manager.getModuleInfo(name);

      if (!moduleInfo) {
        return res.status(404).json({
          success: false,
          error: 'Module not found'
        });
      }

      res.json({
        success: true,
        module: formatModuleInfo(moduleInfo, true)
      });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  /**
   * POST /api/appstore/modules/:name/install
   * Enqueue a module for installation. Installs run strictly serially.
   * Body: { repoId, credentials? }
   */
  router.post('/modules/:name/install', (req: Request, res: Response) => {
    try {
      const { name } = req.params;
      const { repoId, credentials } = req.body;

      if (!repoId) {
        return res.status(400).json({
          success: false,
          error: 'Repository ID is required'
        });
      }

      const job = installQueue.enqueueInstall(name, repoId, credentials);
      res.status(202).json({
        success: true,
        jobId: job.id,
        status: job.status,
        message: `Module ${name} queued for install.`
      });
    } catch (error: any) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const code = error?.code;
      const status = code === 'DUPLICATE' ? 409 : 500;
      res.status(status).json({ success: false, error: errorMessage });
    }
  });

  /**
   * DELETE /api/appstore/modules/:name/install
   * Request cancel of a queued install. Running installs cannot be cancelled.
   */
  router.delete('/modules/:name/install', (req: Request, res: Response) => {
    const { name } = req.params;
    const result = installQueue.requestCancel(name, 'install');
    if (result.ok) {
      return res.json({ success: true, job: result.job });
    }
    if (result.reason === 'already-running') {
      return res.status(409).json({
        success: false,
        error: 'Installation already started, cannot cancel.'
      });
    }
    return res.status(404).json({ success: false, error: 'No pending install for this module.' });
  });

  /**
   * DELETE /api/appstore/modules/:name/uninstall
   * Request cancel of a queued uninstall. Running uninstalls cannot be cancelled.
   */
  router.delete('/modules/:name/uninstall', (req: Request, res: Response) => {
    const { name } = req.params;
    const result = installQueue.requestCancel(name, 'uninstall');
    if (result.ok) {
      return res.json({ success: true, job: result.job });
    }
    if (result.reason === 'already-running') {
      return res.status(409).json({
        success: false,
        error: 'Uninstall already started, cannot cancel.'
      });
    }
    return res.status(404).json({ success: false, error: 'No pending uninstall for this module.' });
  });

  /**
   * GET /api/appstore/install-queue
   * Snapshot of current install queue state (for hydration/reconnect).
   */
  router.get('/install-queue', (_req: Request, res: Response) => {
    res.json({ success: true, jobs: installQueue.getSnapshot() });
  });

  /**
   * DELETE /api/appstore/modules/:name
   * Enqueue a module for uninstall. Uninstalls run serially via the same queue
   * as installs, so mixed install/uninstall sequences are race-free.
   */
  router.delete('/modules/:name', (req: Request, res: Response) => {
    try {
      const { name } = req.params;
      const job = installQueue.enqueueUninstall(name);
      res.status(202).json({
        success: true,
        jobId: job.id,
        status: job.status,
        message: `Module ${name} queued for uninstall.`
      });
    } catch (error: any) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const code = error?.code;
      const status = code === 'DUPLICATE' ? 409 : 500;
      res.status(status).json({ success: false, error: errorMessage });
    }
  });

  /**
   * GET /api/appstore/installed
   * List all installed modules
   */
  router.get('/installed', async (_req: Request, res: Response) => {
    try {
      if (!(await storeFirst(res))) return;
      const manager = getAppStoreManager();
      const installed = manager.getInstalledModules();
      const failures = await moduleFailures();

      res.json({
        success: true,
        modules: installed,
        ...failures,
      });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  // ============================================================================
  // CREDENTIALS MANAGEMENT
  // ============================================================================

  /**
   * GET /api/appstore/credentials/:name
   * Get credentials for a module (masked)
   */
  router.get('/credentials/:name', async (req: Request, res: Response) => {
    try {
      if (!(await storeFirst(res))) return;
      const { name } = req.params;
      const manager = getAppStoreManager();
      const credentials = manager.getCredentials(name);

      if (!credentials) {
        return res.json({
          success: true,
          hasCredentials: false,
          credentials: null
        });
      }

      // Mask credential values
      const maskedCredentials: Record<string, string> = {};
      for (const [key, value] of Object.entries(credentials)) {
        maskedCredentials[key] = value ? '***' : '';
      }

      res.json({
        success: true,
        hasCredentials: true,
        credentials: maskedCredentials
      });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  /**
   * PUT /api/appstore/credentials/:name
   * Save credentials for a module
   * Body: { credentials: Record<string, string> }
   */
  router.put('/credentials/:name', async (req: Request, res: Response) => {
    try {
      if (!(await storeFirst(res))) return;
      const { name } = req.params;
      const { credentials } = req.body;

      if (!credentials || typeof credentials !== 'object') {
        return res.status(400).json({
          success: false,
          error: 'Credentials object is required'
        });
      }

      const manager = getAppStoreManager();
      const success = await inStoreWrite(() => manager.saveCredentialsAwaited(name, credentials));

      res.json({
        success,
        message: success ? 'Credentials saved' : 'Failed to save credentials'
      });
    } catch (error) {
      if (storeWriteAnswered(res, error)) return;
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  /**
   * DELETE /api/appstore/credentials/:name
   * Delete credentials for a module
   */
  router.delete('/credentials/:name', async (req: Request, res: Response) => {
    try {
      if (!(await storeFirst(res))) return;
      const { name } = req.params;
      const manager = getAppStoreManager();
      const success = await inStoreWrite(() => manager.deleteCredentialsAwaited(name));

      res.json({
        success,
        message: success ? 'Credentials deleted' : 'Failed to delete credentials'
      });
    } catch (error) {
      if (storeWriteAnswered(res, error)) return;
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  // ============================================================================
  // PREMIUM TIER MANAGEMENT
  // ============================================================================

  /**
   * GET /api/appstore/premium/tiers
   * List all premium tier definitions
   */
  router.get('/premium/tiers', (_req: Request, res: Response) => {
    try {
      const manager = getPremiumManager();
      const tiers = manager.getAllTiers();

      res.json({
        success: true,
        tiers
      });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  /**
   * PUT /api/appstore/premium/tiers/:id
   * Create or update a tier
   * Body: { displayName, priority, overrides, offerings }
   *
   * Each offering with a `primaryProviderId` is enforced: the primary's price
   * is fetched, the offering's money fields are overridden with the primary's
   * truth, and other real provider links are toggled off if their prices
   * don't match. A failed primary fetch rejects the save with the provider's
   * error verbatim so the admin can fix the upstream config.
   */
  router.put('/premium/tiers/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { displayName, priority, overrides, offerings } = req.body;

      // Free tier is the deployment baseline; its data lives in the Global
      // module config (`/data/global/{module}/settings.json`) and is edited
      // via PUT /api/appstore/global-config/:moduleName or the Discord
      // System Panel. Tier-shaped updates to Free aren't supported.
      if (id === 'free') {
        return res.status(400).json({
          success: false,
          error: "Cannot edit the 'free' tier directly. Edit per-module Global config via /api/appstore/global-config/:moduleName or the Discord System Panel.",
        });
      }

      if (!displayName || typeof displayName !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Display name is required'
        });
      }

      if (typeof priority !== 'number') {
        return res.status(400).json({
          success: false,
          error: 'Priority must be a number'
        });
      }

      if (overrides !== undefined && (!overrides || typeof overrides !== 'object' || Array.isArray(overrides))) {
        return res.status(400).json({ success: false, error: 'overrides must be an object' });
      }
      const overrideErrors: string[] = [];
      const storedOverrides = (getPremiumManager().getTier(id)?.overrides ?? {}) as Record<string, unknown>;
      for (const [moduleName, moduleOverride] of Object.entries((overrides || {}) as Record<string, any>)) {
        if (!moduleOverride || typeof moduleOverride !== 'object' || Array.isArray(moduleOverride)) {
          overrideErrors.push(`${moduleName}: must be an object`);
          continue;
        }
        const { _hardLimits, ...rest } = moduleOverride;
        const values = Object.fromEntries(Object.entries(rest).filter(([k]) => !k.startsWith('_')));
        const storedOverride = (storedOverrides[moduleName] ?? {}) as Record<string, any>;
        const free = loadGlobalModuleConfig(moduleName);
        const errors = moduleConfigErrors(getSettingsSchema(moduleName), values, _hardLimits ?? {}, free.hardLimits, [{
          values: storedOverride,
          hardLimits: storedOverride._hardLimits && typeof storedOverride._hardLimits === 'object' ? storedOverride._hardLimits : {},
        }, { values: free.values, hardLimits: free.hardLimits }]);
        overrideErrors.push(...errors.map(e => `${moduleName}.${e}`));
      }
      if (overrideErrors.length > 0) {
        return res.status(400).json({ success: false, error: `Not saved: ${overrideErrors.join('; ')}` });
      }

      const inputOfferings = Array.isArray(offerings) ? offerings : [];
      const refreshedOfferings: any[] = [];
      const warnings: string[] = [];

      for (const offering of inputOfferings) {
        try {
          const refreshed = await refreshOfferingProviderLinks(offering, warnings);
          refreshedOfferings.push(refreshed);
        } catch (refreshErr) {
          const message = refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
          return res.status(400).json({
            success: false,
            error: `Offering '${offering?.label || offering?.id || '?'}': ${message}`,
          });
        }
      }

      const manager = getPremiumManager();
      const success = await shared(res, 'premium.setTier', [id, {
        displayName,
        priority,
        overrides: overrides || {},
        offerings: refreshedOfferings,
      }]);

      res.json({
        success,
        message: success ? 'Tier saved' : 'Failed to save tier',
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  /**
   * DELETE /api/appstore/premium/tiers/:id
   * Delete a tier (cannot delete 'free')
   */
  router.delete('/premium/tiers/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      if (id === 'free') {
        return res.status(400).json({
          success: false,
          error: 'Cannot delete the free tier'
        });
      }

      const manager = getPremiumManager();
      const success = await shared(res, 'premium.deleteTier', [id]);

      res.json({
        success,
        message: success ? 'Tier deleted' : 'Tier not found'
      });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  /**
   * GET /api/appstore/premium/messages
   * Returns current restriction messages and their defaults.
   */
  router.get('/premium/messages', (_req: Request, res: Response) => {
    try {
      const manager = getPremiumManager();
      res.json({
        success: true,
        messages: manager.getMessages(),
        defaults: DEFAULT_MESSAGES
      });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  /**
   * PUT /api/appstore/premium/messages
   * Body: { moduleBlocked?, commandBlocked?, panelBlocked?, upgradeButtonLabel? }
   */
  router.put('/premium/messages', async (req: Request, res: Response) => {
    try {
      const { moduleBlocked, commandBlocked, panelBlocked, upgradeButtonLabel } = req.body || {};
      const partial: Partial<PremiumMessages> = {};
      if (typeof moduleBlocked === 'string') partial.moduleBlocked = moduleBlocked;
      if (typeof commandBlocked === 'string') partial.commandBlocked = commandBlocked;
      if (typeof panelBlocked === 'string') partial.panelBlocked = panelBlocked;
      if (typeof upgradeButtonLabel === 'string') partial.upgradeButtonLabel = upgradeButtonLabel;

      if (Object.keys(partial).length === 0) {
        return res.status(400).json({ success: false, error: 'No valid message fields provided' });
      }

      const manager = getPremiumManager();
      const success = await shared(res, 'premium.setMessages', [partial]);
      res.json({
        success,
        messages: manager.getMessages(),
        defaults: DEFAULT_MESSAGES
      });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  /**
   * POST /api/appstore/premium/messages/reset
   * Reset all restriction messages to defaults.
   */
  router.post('/premium/messages/reset', async (_req: Request, res: Response) => {
    try {
      const manager = getPremiumManager();
      const success = await shared(res, 'premium.resetMessages', []);
      res.json({
        success,
        messages: manager.getMessages(),
        defaults: DEFAULT_MESSAGES
      });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  /**
   * GET /api/appstore/global-config/:moduleName
   *
   * Read the deployment baseline (Global / Free tier) for one module. This
   * is the canonical source for module values, hard limits, the
   * module-enabled flag, and the disabled-commands list. The Discord
   * System Panel and the Web Premium Tiers > Free tier view both read
   * from this endpoint.
   */
  router.get('/global-config/:moduleName', async (req: Request, res: Response) => {
    try {
      const { moduleName } = req.params;
      if (!moduleName || typeof moduleName !== 'string') {
        return res.status(400).json({ success: false, error: 'moduleName required' });
      }
      const served = await servedBaseline(botManager, moduleName);
      if (!served.ok) {
        return res.status(served.status).json({ success: false, error: served.error });
      }
      const schema = getSettingsSchema(moduleName);
      res.json({
        success: true,
        moduleName,
        config: served.config,
        schema: schema || null,
        ...(served.notice ? { notice: served.notice } : {}),
      });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  /**
   * PUT /api/appstore/global-config/:moduleName
   *
   * Body: { values?, hardLimits?, moduleEnabled?, disabledCommands? }
   *
   * Writes a partial update to the module's deployment baseline. Paid-tier
   * entries are re-sanitized against the new baseline (state worse than Free
   * is dropped) but not pruned, so a value equal to Free stays stored.
   */
  router.put('/global-config/:moduleName', async (req: Request, res: Response) => {
    try {
      const { moduleName } = req.params;
      if (!moduleName || typeof moduleName !== 'string') {
        return res.status(400).json({ success: false, error: 'moduleName required' });
      }

      const body = req.body || {};
      const partial: Partial<GlobalModuleConfig> = {};

      if (body.values !== undefined) {
        if (!body.values || typeof body.values !== 'object' || Array.isArray(body.values)) {
          return res.status(400).json({ success: false, error: 'values must be an object' });
        }
        partial.values = body.values as Record<string, SettingValue>;
      }
      if (body.hardLimits !== undefined) {
        if (!body.hardLimits || typeof body.hardLimits !== 'object' || Array.isArray(body.hardLimits)) {
          return res.status(400).json({ success: false, error: 'hardLimits must be an object' });
        }
        partial.hardLimits = body.hardLimits as Record<string, HardLimitOverride>;
      }
      if (body.moduleEnabled !== undefined) {
        if (typeof body.moduleEnabled !== 'boolean') {
          return res.status(400).json({ success: false, error: 'moduleEnabled must be a boolean' });
        }
        partial.moduleEnabled = body.moduleEnabled;
      }
      if (body.disabledCommands !== undefined) {
        if (!Array.isArray(body.disabledCommands) || !body.disabledCommands.every((c: any) => typeof c === 'string')) {
          return res.status(400).json({ success: false, error: 'disabledCommands must be an array of strings' });
        }
        partial.disabledCommands = body.disabledCommands;
      }

      if (Object.keys(partial).length === 0) {
        return res.status(400).json({ success: false, error: 'No valid fields provided' });
      }

      if (!/^[A-Za-z0-9_-]+$/.test(moduleName)) {
        return res.status(400).json({ success: false, error: 'invalid moduleName' });
      }
      // One save of a module's baseline at a time, so each builds on the last.
      await withTargetLock(baselinePath(moduleName), async () => {
        // The save builds on the serving process's body; a write the child still
        // holds queued would land over this one, so it waits for that to land.
        const served = await servedBaseline(botManager, moduleName);
        if (!served.ok) {
          res.status(served.status).json({ success: false, error: served.error });
          return;
        }
        if (served.childQueued) {
          res.status(409).json({ success: false, error: childQueuedError(served) });
          return;
        }

        const storedLimits = served.raw?._hardLimits && typeof served.raw._hardLimits === 'object' ? served.raw._hardLimits : {};
        const configErrors = moduleConfigErrors(
          getSettingsSchema(moduleName),
          partial.values ?? {},
          partial.hardLimits ?? {},
          partial.hardLimits ? {} : storedLimits,
          { values: globalModuleConfigFrom(served.raw ?? {}).values, hardLimits: storedLimits },
        );
        if (configErrors.length > 0) {
          res.status(400).json({ success: false, error: `Not saved: ${configErrors.join('; ')}` });
          return;
        }

        // Applied by the process that writes settings.json, only if the file still holds the body read here.
        const reply = await botManager.runSharedOp('premium.setGlobalModuleConfig', {
          moduleName, partial, rel: globalSettingsRel(moduleName), expectSha: shaOfRaw(served.text),
        });
        const failure = sharedOpFailure(reply);
        if (failure) {
          res.status(failure.status).json({ success: false, error: failure.error });
          return;
        }
        const ok = reply.result === true;
        res.json({
          success: ok,
          moduleName,
          config: loadGlobalModuleConfig(moduleName),
        });
      });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  /**
   * GET /api/appstore/premium/module-schemas
   * Returns all modules with their settings schemas and command names (for the tier overrides editor).
   * Includes modules without settings so they can still be toggled on/off per tier.
   * Command data comes from the live bot registry when available, with filesystem fallback.
   */
  router.get('/premium/module-schemas', async (_req: Request, res: Response) => {
    try {
      const moduleMap = new Map<string, { name: string; displayName: string; category: string; commands: Array<{ name: string; type: string }>; settings: Record<string, any> }>();

      // Scan filesystem for module manifests and settings schemas
      const scanDir = (baseDir: string, nested: boolean) => {
        if (!fs.existsSync(baseDir)) return;
        const processDirs = (dirs: Array<{ name: string; path: string }>) => {
          for (const { name: dirName, path: dirPath } of dirs) {
            if (moduleMap.has(dirName)) continue; // skip duplicates
            const manifestPath = path.join(dirPath, 'module.json');
            const schemaPath = path.join(dirPath, 'settingsSchema.json');
            if (!fs.existsSync(manifestPath)) continue;
            try {
              const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
              let settings = {};
              try {
                if (fs.existsSync(schemaPath)) {
                  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
                  settings = schema.settings || {};
                }
              } catch { /* no schema or parse error */ }

              // Detect command file names from commands/ directory as fallback
              // Type is unknown from filesystem; defaults to 'ChatInput'
              const commands: Array<{ name: string; type: string }> = [];
              const cmdDir = path.join(dirPath, 'commands');
              if (fs.existsSync(cmdDir)) {
                const files = fs.readdirSync(cmdDir).filter(f => f.endsWith('.ts') || f.endsWith('.js'));
                for (const f of files) commands.push({ name: f.replace(/\.(ts|js)$/, ''), type: 'ChatInput' });
              }

              moduleMap.set(manifest.name || dirName, {
                name: manifest.name || dirName,
                displayName: manifest.displayName || manifest.name || dirName,
                category: manifest.category || 'misc',
                commands,
                settings,
              });
            } catch (err) {
              console.warn(`[Premium] Failed to read module ${dirName}:`, err);
            }
          }
        };

        if (nested) {
          const repos = fs.readdirSync(baseDir, { withFileTypes: true })
            .filter(d => d.isDirectory() && !d.name.startsWith('.'));
          for (const repo of repos) {
            const modulesPath = path.join(baseDir, repo.name, 'Modules');
            if (!fs.existsSync(modulesPath)) continue;
            const entries = fs.readdirSync(modulesPath, { withFileTypes: true })
              .filter(d => d.isDirectory() && !d.name.endsWith('.disabled'));
            processDirs(entries.map(e => ({ name: e.name, path: path.join(modulesPath, e.name) })));
          }
        } else {
          const entries = fs.readdirSync(baseDir, { withFileTypes: true })
            .filter(d => d.isDirectory() && !d.name.endsWith('.disabled'));
          processDirs(entries.map(e => ({ name: e.name, path: path.join(baseDir, e.name) })));
        }
      };

      scanDir(getModulesDir(), false);
      scanDir(getModulesDevDir(), true);

      // Enrich with live command data from bot process via IPC
      if (botManager.isRunning()) {
        try {
          const result = await botManager.listLoadedModulesDetailed();
          if (result && Array.isArray(result.modules)) {
            for (const live of result.modules) {
              const existing = moduleMap.get(live.name);
              if (existing && live.commandDetails && live.commandDetails.length > 0) {
                existing.commands = live.commandDetails; // prefer live data (has real types) over filesystem
              }
            }
          }
        } catch { /* bot not ready or IPC timeout */ }
      }

      res.json({ success: true, modules: Array.from(moduleMap.values()) });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  /**
   * GET /api/appstore/premium/bot-guilds
   * Returns all guilds the bot is in (for guild assignment UI)
   */
  router.get('/premium/bot-guilds', async (_req: Request, res: Response) => {
    try {
      if (!botManager.isRunning()) {
        res.json({ success: true, guilds: [], botRunning: false });
        return;
      }
      const result = await botManager.getBotGuilds();
      if (result.success) {
        res.json({ success: true, guilds: result.guilds || [], botRunning: true });
      } else {
        res.json({ success: true, guilds: [], botRunning: true, error: result.error });
      }
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // ============================================================================
  // COUPONS
  // ============================================================================

  // ============================================================================
  // DUMMY PROVIDER ADMIN: variants, products, coupons
  //
  // Dummy is the in-process simulator; admin manages its catalog (variants +
  // products + coupons) via these endpoints. Real providers (Stripe, LS,
  // PayPal, ...) own their catalogs at the provider's dashboard, so they
  // don't have equivalent admin endpoints.
  // ============================================================================

  /** Resolve the live DummyProvider with its admin backdoor methods. */
  function getDummyProvider() {
    const provider = getPaymentRegistry().get('dummy');
    if (!provider) return null;
    const dummy = provider as unknown as {
      adminListVariants: () => any[];
      adminSetVariant: (v: any) => void;
      adminDeleteVariant: (id: string) => boolean;
      adminListProducts: () => any[];
      adminSetProduct: (p: any) => void;
      adminDeleteProduct: (id: string) => boolean;
      adminListCoupons: () => any[];
      adminSetCoupon: (c: any) => boolean;
      adminDeleteCoupon: (code: string) => boolean;
    };
    if (typeof dummy.adminListVariants !== 'function') return null;
    return dummy;
  }

  router.get('/premium/providers/dummy/variants', (_req: Request, res: Response) => {
    try {
      const dummy = getDummyProvider();
      if (!dummy) return res.status(404).json({ success: false, error: 'Dummy provider not available' });
      res.json({ success: true, variants: dummy.adminListVariants() });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  router.put('/premium/providers/dummy/variants/:variantId', async (req: Request, res: Response) => {
    try {
      const dummy = getDummyProvider();
      if (!dummy) return res.status(404).json({ success: false, error: 'Dummy provider not available' });
      const { variantId } = req.params;
      const { label, amount, currency, durationDays, trialDays, recurring, active } = req.body || {};
      if (!variantId || !label || typeof amount !== 'number' || !currency) {
        return res.status(400).json({ success: false, error: 'variantId, label, amount, currency are required' });
      }
      await shared(res, 'dummy.adminSetVariant', [{
        variantId,
        label,
        amount,
        currency,
        durationDays: durationDays ?? null,
        ...(typeof trialDays === 'number' ? { trialDays } : {}),
        recurring: !!recurring,
        active: active !== false,
      }]);
      res.json({ success: true });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  router.delete('/premium/providers/dummy/variants/:variantId', async (req: Request, res: Response) => {
    try {
      const dummy = getDummyProvider();
      if (!dummy) return res.status(404).json({ success: false, error: 'Dummy provider not available' });
      const ok = await shared(res, 'dummy.adminDeleteVariant', [req.params.variantId]);
      res.json({ success: ok });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  router.get('/premium/providers/dummy/products', (_req: Request, res: Response) => {
    try {
      const dummy = getDummyProvider();
      if (!dummy) return res.status(404).json({ success: false, error: 'Dummy provider not available' });
      res.json({ success: true, products: dummy.adminListProducts() });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  router.put('/premium/providers/dummy/products/:productId', async (req: Request, res: Response) => {
    try {
      const dummy = getDummyProvider();
      if (!dummy) return res.status(404).json({ success: false, error: 'Dummy provider not available' });
      const { productId } = req.params;
      const { label, description, variantIds } = req.body || {};
      if (!productId || !label) {
        return res.status(400).json({ success: false, error: 'productId and label are required' });
      }
      await shared(res, 'dummy.adminSetProduct', [{
        productId,
        label,
        description,
        variantIds: Array.isArray(variantIds) ? variantIds : [],
      }]);
      res.json({ success: true });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  router.delete('/premium/providers/dummy/products/:productId', async (req: Request, res: Response) => {
    try {
      const dummy = getDummyProvider();
      if (!dummy) return res.status(404).json({ success: false, error: 'Dummy provider not available' });
      const ok = await shared(res, 'dummy.adminDeleteProduct', [req.params.productId]);
      res.json({ success: ok });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  router.get('/premium/providers/dummy/coupons', (_req: Request, res: Response) => {
    try {
      const dummy = getDummyProvider();
      if (!dummy) return res.status(404).json({ success: false, error: 'Dummy provider not available' });
      res.json({ success: true, coupons: dummy.adminListCoupons() });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  router.put('/premium/providers/dummy/coupons/:code', async (req: Request, res: Response) => {
    try {
      const dummy = getDummyProvider();
      if (!dummy) return res.status(404).json({ success: false, error: 'Dummy provider not available' });
      const { code } = req.params;
      if (!code || !code.trim()) {
        return res.status(400).json({ success: false, error: 'Coupon code is required' });
      }
      const { description, percentOff, extraDays, maxUses, expiresAt } = req.body || {};
      const ok = await shared(res, 'dummy.adminSetCoupon', [{
        code,
        description,
        percentOff,
        extraDays,
        maxUses,
        expiresAt,
        usedCount: 0,
        createdAt: new Date().toISOString(),
      }]);
      if (!ok) {
        return res.status(400).json({
          success: false,
          error: 'Invalid coupon. Exactly one of percentOff (1-100) or extraDays (>=1) must be set; optional maxUses must be >=1 and expiresAt must be a valid ISO date.',
        });
      }
      res.json({ success: true });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  router.delete('/premium/providers/dummy/coupons/:code', async (req: Request, res: Response) => {
    try {
      const dummy = getDummyProvider();
      if (!dummy) return res.status(404).json({ success: false, error: 'Dummy provider not available' });
      const ok = await shared(res, 'dummy.adminDeleteCoupon', [req.params.code]);
      if (!ok) return res.status(404).json({ success: false, error: 'Coupon not found' });
      res.json({ success: true });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // ============================================================================
  // SUBSCRIPTIONS
  // ============================================================================

  /**
   * GET /api/appstore/premium/subscriptions
   * List all guilds with any subscription (Main Web-UI table).
   */
  router.get('/premium/subscriptions', (_req: Request, res: Response) => {
    try {
      const manager = getPremiumManager();
      res.json({ success: true, subscriptions: manager.getAllSubscriptions() });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  /**
   * GET /api/appstore/premium/subscriptions/:guildId
   * Single-guild detail + effective tier (Guild Web-UI tab).
   */
  router.get('/premium/subscriptions/:guildId', (req: Request, res: Response) => {
    try {
      const { guildId } = req.params;
      const manager = getPremiumManager();
      const subscriptions = manager.getSubscriptions(guildId);
      const resolved = manager.resolveActiveTier(guildId);
      res.json({
        success: true,
        subscriptions,
        effective: { tierId: resolved.tierId, tier: resolved.tier, source: resolved.source }
      });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  /**
   * POST /api/appstore/premium/subscriptions/:guildId/manual
   * Grant (or replace) the manual subscription for a guild.
   * Body: { tierId, durationDays: number | null, notes? }
   *
   * Stacks per the unified rules: higher priority displaces the active sub
   * into the paused queue; same priority replaces (manual wins ties); lower
   * priority enters the paused queue at its position.
   */
  router.post('/premium/subscriptions/:guildId/manual', async (req: Request, res: Response) => {
    try {
      const { guildId } = req.params;
      const { tierId, durationDays, notes } = req.body || {};
      if (!tierId || typeof tierId !== 'string') {
        return res.status(400).json({ success: false, error: 'tierId is required' });
      }
      if (durationDays !== null && (typeof durationDays !== 'number' || durationDays <= 0)) {
        return res.status(400).json({ success: false, error: 'durationDays must be a positive number or null (for Lifetime)' });
      }
      const manager = getPremiumManager();
      const success = await shared(res, 'premium.grantManual', [guildId, tierId, durationDays, typeof notes === 'string' ? notes : undefined]);
      res.json({ success, subscriptions: manager.getSubscriptions(guildId) });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  /**
   * POST /api/appstore/premium/subscriptions/:guildId/manual/extend
   * Extend the manual subscription.
   * Body: { addDays }
   */
  router.post('/premium/subscriptions/:guildId/manual/extend', async (req: Request, res: Response) => {
    try {
      const { guildId } = req.params;
      const { addDays } = req.body || {};
      if (typeof addDays !== 'number' || addDays <= 0) {
        return res.status(400).json({ success: false, error: 'addDays must be a positive number' });
      }
      const manager = getPremiumManager();
      const success = await shared(res, 'premium.extendManual', [guildId, addDays]);
      res.json({ success, subscriptions: manager.getSubscriptions(guildId) });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  /**
   * DELETE /api/appstore/premium/subscriptions/:guildId/manual
   * Revoke the manual subscription.
   */
  router.delete('/premium/subscriptions/:guildId/manual', async (req: Request, res: Response) => {
    try {
      const { guildId } = req.params;
      const manager = getPremiumManager();
      const success = await shared(res, 'premium.revokeManual', [guildId]);
      res.json({ success, subscriptions: manager.getSubscriptions(guildId) });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  /**
   * POST /api/appstore/premium/subscriptions/:guildId/paid
   * Initiate a paid subscription through the offering's provider.
   * Body: { tierId, offeringId, providerId, variantId, couponCode?, userId? }
   * Response shape depends on the provider's mechanism:
   *   immediate      -> { providerSubId, state }
   *   redirect       -> { redirectUrl }
   *   client_handoff -> { clientHandoff }
   *   oauth_link     -> { oauthUrl }
   */
  router.post('/premium/subscriptions/:guildId/paid', async (req: Request, res: Response) => {
    try {
      const { guildId } = req.params;
      const { tierId, offeringId, providerId, variantId, couponCode, userId } = req.body || {};
      if (!tierId || typeof tierId !== 'string') {
        return res.status(400).json({ success: false, error: 'tierId is required' });
      }
      if (!offeringId || typeof offeringId !== 'string') {
        return res.status(400).json({ success: false, error: 'offeringId is required' });
      }
      if (!providerId || typeof providerId !== 'string') {
        return res.status(400).json({ success: false, error: 'providerId is required' });
      }
      if (!variantId || typeof variantId !== 'string') {
        return res.status(400).json({ success: false, error: 'variantId is required' });
      }
      const manager = getPremiumManager();
      const result = await shared(res, 'premium.initiatePaidSubscription', [guildId, tierId, offeringId, { providerId, variantId, couponCode, userId }]);
      res.json({
        success: true,
        result,
        subscriptions: manager.getSubscriptions(guildId),
      });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  /**
   * DELETE /api/appstore/premium/subscriptions/:guildId/paid
   * Cancel the paid subscription (autoRenew off, remaining days intact).
   */
  router.delete('/premium/subscriptions/:guildId/paid', async (req: Request, res: Response) => {
    try {
      const { guildId } = req.params;
      const manager = getPremiumManager();
      const success = await shared(res, 'premium.cancelPaidSubscription', [guildId]);
      res.json({ success, subscriptions: manager.getSubscriptions(guildId) });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  /**
   * POST /api/appstore/premium/subscriptions/:guildId/paid/reactivate
   * Reactivate the paid subscription (autoRenew back on while still active).
   */
  router.post('/premium/subscriptions/:guildId/paid/reactivate', async (req: Request, res: Response) => {
    try {
      const { guildId } = req.params;
      const manager = getPremiumManager();
      const success = await shared(res, 'premium.reactivatePaidSubscription', [guildId]);
      res.json({ success, subscriptions: manager.getSubscriptions(guildId) });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  /**
   * GET /api/appstore/premium/providers
   * Registered payment providers (id, displayName, capabilities).
   */
  router.get('/premium/providers', (_req: Request, res: Response) => {
    try {
      const registry = getPaymentRegistry();
      const manager = getPremiumManager();
      const activated = manager.getActivatedProviders();
      const providers = registry.listAll().map(p => {
        const activation = activated[p.id];
        const fields = p.getCredentialFields ? p.getCredentialFields() : [];
        return {
          id: p.id,
          displayName: p.displayName,
          isConfigured: p.isConfigured(),
          capabilities: p.capabilities,
          activated: !!activation,
          defaultEnabled: activation ? !!activation.defaultEnabled : false,
          /** True when the provider declares any credential fields - drives
           * the "Configure" affordance on the provider card. */
          hasCredentials: fields.length > 0,
        };
      });
      res.json({ success: true, providers });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  /**
   * POST /api/appstore/premium/providers/:providerId/variant-lookup
   * Body: { variantId: string }
   * Resolve a single wire-level variantId to its normalized OfferingVariant.
   * Used by the offering modal for paste-validate (Price mode) and the
   * explicit refresh button. Returns the variant on success, 400 with a
   * `reason` on validation errors so the UI can surface them verbatim.
   */
  router.post('/premium/providers/:providerId/variant-lookup', async (req: Request, res: Response) => {
    try {
      const { providerId } = req.params;
      const { variantId } = req.body || {};
      if (!variantId || typeof variantId !== 'string') {
        return res.status(400).json({ success: false, error: 'variantId is required' });
      }
      const registry = getPaymentRegistry();
      const provider = registry.get(providerId);
      if (!provider) {
        return res.status(404).json({ success: false, error: `Provider '${providerId}' is not registered` });
      }
      if (!provider.fetchVariant) {
        return res.status(400).json({ success: false, error: `Provider '${providerId}' does not support variant lookup.` });
      }
      if (!provider.isConfigured()) {
        return res.status(400).json({ success: false, error: `Provider '${providerId}' is not configured. Set its credentials in the Credentials tab first.` });
      }
      try {
        const variant = await provider.fetchVariant(variantId);
        if (!variant) {
          return res.status(400).json({ success: false, error: `Variant '${variantId}' not found, archived, or not supported.` });
        }
        return res.json({ success: true, variant });
      } catch (lookupErr: any) {
        const message = lookupErr instanceof Error ? lookupErr.message : String(lookupErr);
        return res.status(400).json({ success: false, error: message });
      }
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  /**
   * POST /api/appstore/premium/providers/:providerId/product-lookup
   * Body: { productId: string }
   * Resolve a Product ID to its list of variants. Used by Product-mode
   * editor in the offering modal.
   */
  router.post('/premium/providers/:providerId/product-lookup', async (req: Request, res: Response) => {
    try {
      const { providerId } = req.params;
      const { productId } = req.body || {};
      if (!productId || typeof productId !== 'string') {
        return res.status(400).json({ success: false, error: 'productId is required' });
      }
      const registry = getPaymentRegistry();
      const provider = registry.get(providerId);
      if (!provider) {
        return res.status(404).json({ success: false, error: `Provider '${providerId}' is not registered` });
      }
      if (!provider.capabilities.supportsProductMode || !provider.listVariants) {
        return res.status(400).json({ success: false, error: `Provider '${providerId}' does not support Product mode.` });
      }
      if (!provider.isConfigured()) {
        return res.status(400).json({ success: false, error: `Provider '${providerId}' is not configured. Set its credentials in the Credentials tab first.` });
      }
      try {
        const variants = await provider.listVariants(productId);
        return res.json({ success: true, variants });
      } catch (lookupErr: any) {
        const message = lookupErr instanceof Error ? lookupErr.message : String(lookupErr);
        return res.status(400).json({ success: false, error: message });
      }
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  /**
   * PUT /api/appstore/premium/providers/:providerId/activation
   * Toggle a provider's system-wide activation.
   * Body: { activated: boolean, defaultEnabled?: boolean }
   */
  /**
   * GET /api/appstore/premium/audit
   * Read the premium audit log with optional filters.
   * Query: from, to (ISO timestamps), action, tierId, providerId, guildId,
   *        subscriptionId, limit. Returns newest-first up to `limit`.
   */
  router.get('/premium/audit', async (req: Request, res: Response) => {
    try {
      const manager = getPremiumManager();
      const { from, to, action, tierId, providerId, guildId, subscriptionId, limit } = req.query as Record<string, string | undefined>;
      const parsedLimit = limit ? parseInt(limit, 10) : undefined;
      const result = await manager.readAuditEntries({
        from: from || undefined,
        to: to || undefined,
        action: action || undefined,
        tierId: tierId || undefined,
        providerId: providerId || undefined,
        guildId: guildId || undefined,
        subscriptionId: subscriptionId || undefined,
        limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
      });
      res.json({ success: true, ...result });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  /**
   * Migration management (Stage 5).
   * - GET    /premium/migrations            -> list all (any status)
   * - POST   /premium/migrations            -> schedule new
   * - DELETE /premium/migrations/:id        -> cancel a pending one
   * - GET    /premium/migration-silence-policy
   * - PUT    /premium/migration-silence-policy { policy: 'cancel'|'continue' }
   */
  router.get('/premium/migrations', (_req: Request, res: Response) => {
    try {
      const mgr = getPremiumManager();
      res.json({ success: true, migrations: mgr.listMigrations(), silencePolicy: mgr.getMigrationSilencePolicy() });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  router.post('/premium/migrations', async (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      const required = ['providerId', 'sourceTierId', 'sourceOfferingId', 'sourceVariantId',
        'targetTierId', 'targetOfferingId', 'targetVariantId', 'effectiveDate'];
      for (const k of required) {
        if (!body[k] || typeof body[k] !== 'string') {
          return res.status(400).json({ success: false, error: `${k} is required (string)` });
        }
      }
      const mgr = getPremiumManager();
      const migration = await shared(res, 'premium.scheduleMigration', [{
        providerId: body.providerId,
        sourceTierId: body.sourceTierId,
        sourceOfferingId: body.sourceOfferingId,
        sourceVariantId: body.sourceVariantId,
        targetTierId: body.targetTierId,
        targetOfferingId: body.targetOfferingId,
        targetVariantId: body.targetVariantId,
        effectiveDate: body.effectiveDate,
        message: typeof body.message === 'string' ? body.message : '',
        scheduledBy: typeof body.scheduledBy === 'string' ? body.scheduledBy : 'admin',
      }]);
      res.json({ success: true, migration });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(400).json({ success: false, error: errorMessage });
    }
  });

  router.delete('/premium/migrations/:migrationId', async (req: Request, res: Response) => {
    try {
      const mgr = getPremiumManager();
      const ok = await shared(res, 'premium.cancelMigration', [req.params.migrationId]);
      if (!ok) return res.status(404).json({ success: false, error: 'Migration not found or not pending' });
      res.json({ success: true });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  router.get('/premium/migration-silence-policy', (_req: Request, res: Response) => {
    try {
      res.json({ success: true, policy: getPremiumManager().getMigrationSilencePolicy() });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  router.put('/premium/migration-silence-policy', async (req: Request, res: Response) => {
    try {
      const policy = req.body?.policy;
      if (policy !== 'cancel' && policy !== 'continue') {
        return res.status(400).json({ success: false, error: 'policy must be "cancel" or "continue"' });
      }
      const ok = await shared(res, 'premium.setMigrationSilencePolicy', [policy]);
      if (!ok) return res.status(500).json({ success: false, error: 'Failed to set policy' });
      res.json({ success: true, policy });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  /**
   * GET /api/appstore/premium/providers/:providerId/credentials
   * Returns the provider's declared credential fields + a per-key
   * masked status ({ set: boolean }). Never returns actual values.
   */
  router.get('/premium/providers/:providerId/credentials', (req: Request, res: Response) => {
    try {
      const provider = getPaymentRegistry().get(req.params.providerId);
      if (!provider) return res.status(404).json({ success: false, error: `Provider '${req.params.providerId}' not registered` });
      const fields = provider.getCredentialFields ? provider.getCredentialFields() : [];
      const c = providerCredentials(req.params.providerId);
      const unread = docUnread(req.params.providerId);
      const status: Record<string, { set: boolean; preview?: string; unread?: string }> = {};
      for (const f of fields) {
        const v = c[f.key];
        const set = isSet(v);
        status[f.key] = set
          ? { set: true, preview: f.type === 'secret' ? '••••••••' : (v || '') }
          : unread && providerDocKey(req.params.providerId, f.key) ? { set: false, unread } : { set: false };
      }
      res.json({ success: true, fields, status, isConfigured: provider.isConfigured() });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  /**
   * PUT /api/appstore/premium/providers/:providerId/credentials
   * Body: { values: { [key]: string }, clear?: string[] }
   * - `values`: keys to set. Empty string keeps the existing value (matches
   *   leave-blank-to-keep semantics of the legacy credentials form).
   * - `clear`: keys to actively remove (set to undefined).
   * Refuses to touch DISCORD_TOKEN / CLIENT_ID / GUILD_ID even if a provider
   * declares them in its field list (those are owned by Bot Manager under
   * managed deployments).
   */
  router.put('/premium/providers/:providerId/credentials', async (req: Request, res: Response) => {
    try {
      const running = botManager.migrationRunning?.();
      if (running) {
        return res.status(409).json({ success: false, error: `A data migration is running (migration ${running.jobId}); nothing was saved` });
      }
      const provider = getPaymentRegistry().get(req.params.providerId);
      if (!provider) return res.status(404).json({ success: false, error: `Provider '${req.params.providerId}' not registered` });
      const fields = provider.getCredentialFields ? provider.getCredentialFields() : [];
      if (fields.length === 0) {
        return res.status(400).json({ success: false, error: `Provider '${req.params.providerId}' has no credentials to set` });
      }

      const body = req.body || {};
      const values = (body.values && typeof body.values === 'object') ? body.values : {};
      const clearList: string[] = Array.isArray(body.clear) ? body.clear.filter((k: any) => typeof k === 'string') : [];

      const RESERVED = new Set(['DISCORD_TOKEN', 'CLIENT_ID', 'GUILD_ID']);
      const allowed = new Set(fields.map(f => f.key));
      const existing = loadCredentials();
      const readError = credentialsReadError();
      if (readError) {
        return res.status(500).json({ success: false, error: `Could not read /data/.env, so nothing was saved: ${readError}` });
      }
      const next: BotCredentials = { ...existing };
      // NB6 decision 57: on a Postgres bot a built-in provider's own keys go to the credentials doc; the rest stay here.
      const onDatabase = resolveDataBackend() === 'postgres';
      const providerId = req.params.providerId;
      const docChanges: Record<string, string | null> = {};
      const localKeys: string[] = [];

      for (const f of fields) {
        if (RESERVED.has(f.key)) continue;
        if (!allowed.has(f.key)) continue;
        const toDoc = onDatabase && providerDocKey(providerId, f.key);
        let value: string | undefined;
        if (clearList.includes(f.key)) {
          value = undefined;
        } else {
          const incoming = values[f.key];
          if (typeof incoming !== 'string') continue;
          const trimmed = incoming.trim();
          if (trimmed === '') continue; // leave-blank-to-keep
          value = trimmed;
        }
        if (toDoc) {
          docChanges[f.key] = value ?? null;
        } else {
          next[f.key] = value;
          localKeys.push(f.key);
        }
      }

      if (!onDatabase || localKeys.length > 0) {
        const result = saveCredentials(next);
        if (!result.success) {
          return res.status(500).json({ success: false, error: result.error || 'Failed to save credentials' });
        }
      }
      const kept = onDatabase && localKeys.length > 0 ? localKeys.join(', ') : null;
      if (Object.keys(docChanges).length > 0) {
        // Decision 25: the bot writes the doc while it runs, the local chain while it does not.
        const failure = sharedOpFailure(await botManager.runSharedOp('provider.saveCredentials', { providerId, changes: docChanges }));
        if (failure) {
          const tail = kept ? ` ${kept} were saved on this machine only (in /data/.env); set them on each machine of the bot.` : '';
          return res.status(failure.status).json({ success: false, error: `${failure.error}${tail}` });
        }
      }
      // Return the updated masked status so the modal can refresh in place.
      const c = providerCredentials(providerId);
      const unread = docUnread(providerId);
      const status: Record<string, { set: boolean; unread?: string }> = {};
      for (const f of fields) {
        const set = isSet(c[f.key]);
        status[f.key] = !set && unread && providerDocKey(providerId, f.key) ? { set, unread } : { set };
      }
      res.json({
        success: true,
        status,
        isConfigured: provider.isConfigured(),
        ...(kept ? { message: `Saved. ${kept} are kept on this machine only (in /data/.env); set them on each machine of the bot.` } : {}),
      });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  router.put('/premium/providers/:providerId/activation', async (req: Request, res: Response) => {
    try {
      const { providerId } = req.params;
      const { activated, defaultEnabled } = req.body || {};
      if (typeof activated !== 'boolean') {
        return res.status(400).json({ success: false, error: 'activated (boolean) is required' });
      }
      const registry = getPaymentRegistry();
      if (!registry.get(providerId)) {
        return res.status(404).json({ success: false, error: `Provider '${providerId}' is not registered` });
      }
      const manager = getPremiumManager();
      const success = await shared(res, 'premium.setProviderActivation', [providerId, activated, !!defaultEnabled]);
      res.json({ success, activated: manager.getActivatedProviders() });
    } catch (error) {
      if (error instanceof SharedOpAnswered) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // ─── Component Management (Commands tab) ───

  const APPSTORE_CONFIG_DIR = dataPath('global', 'appstore');
  const COMPONENT_CONFIG_PATH = path.join(APPSTORE_CONFIG_DIR, 'component-config.json');
  const APPSTORE_CONFIG_PATH = path.join(APPSTORE_CONFIG_DIR, 'config.json');

  function loadComponentConfig(): Record<string, boolean> {
    return readComponentConfig().config;
  }

  function readComponentConfig(): { config: Record<string, boolean>; sha: string } {
    const read = readConfigFile(COMPONENT_CONFIG_PATH);
    if (!read.ok) throw new Error(`component-config.json cannot be read: ${read.error}`);
    return read;
  }

  function saveComponentConfig(config: Record<string, boolean>, base: string): Promise<void> {
    return inStoreWrite(() => writeConfigFile(COMPONENT_CONFIG_PATH, config, base));
  }

  function readAppStoreConfig(): { config: Record<string, any>; sha: string } {
    const read = readConfigFile(APPSTORE_CONFIG_PATH);
    if (!read.ok) throw new Error(`config.json cannot be read: ${read.error}`);
    return read;
  }

  function loadAppStoreConfig(): Record<string, any> {
    return readAppStoreConfig().config;
  }

  function saveAppStoreConfig(config: Record<string, any>, base: string): Promise<void> {
    return inStoreWrite(() => writeConfigFile(APPSTORE_CONFIG_PATH, config, base));
  }

  /** Map Discord ApplicationCommandOptionType numbers to readable strings */
  const OPTION_TYPE_NAMES: Record<number, string> = {
    1: 'SubCommand', 2: 'SubCommandGroup', 3: 'String', 4: 'Integer',
    5: 'Boolean', 6: 'User', 7: 'Channel', 8: 'Role', 9: 'Mentionable',
    10: 'Number', 11: 'Attachment'
  };

  /** Extract command options metadata for API response */
  function extractCommandOptions(cmd: any): Array<{ name: string; description: string; type: string; required: boolean }> {
    if (!cmd.options || !Array.isArray(cmd.options)) return [];
    return cmd.options.map((opt: any) => ({
      name: opt.name || '',
      description: opt.description || '',
      type: OPTION_TYPE_NAMES[opt.type] || String(opt.type),
      required: !!opt.required
    }));
  }

  /** Scan internalSetup directories and return an "Internal" module entry */
  function getInternalComponents(config: Record<string, boolean>) {
    const isProd = process.env.NODE_ENV !== 'development';
    const ext = isProd ? '.js' : '.ts';
    const internalBase = path.resolve(__dirname, '../../bot/internalSetup');

    const commands: any[] = [];
    const events: any[] = [];
    const panels: any[] = [];

    // --- Commands ---
    const cmdDir = path.join(internalBase, 'commands');
    if (fs.existsSync(cmdDir)) {
      for (const file of fs.readdirSync(cmdDir)) {
        if (!file.endsWith(ext) || file.includes('.disabled')) continue;
        try {
          const mod = require(path.join(cmdDir, file));
          const cmd = mod.default || mod;
          if (cmd && cmd.name) {
            commands.push({
              name: cmd.name,
              description: cmd.description || '',
              type: 'ChatInput',
              options: extractCommandOptions(cmd),
              testOnly: !!cmd.testOnly,
              devOnly: !!cmd.devOnly,
              enabled: config[`_internal:command:${cmd.name}`] !== false
            });
          }
        } catch { /* skip broken files */ }
      }
    }

    // --- Events ---
    const evtDir = path.join(internalBase, 'events');
    if (fs.existsSync(evtDir)) {
      for (const eventFolder of fs.readdirSync(evtDir)) {
        const eventPath = path.join(evtDir, eventFolder);
        if (!fs.statSync(eventPath).isDirectory()) continue;
        const handlers = fs.readdirSync(eventPath).filter(f => f.endsWith(ext) && !f.includes('.disabled'));
        if (handlers.length > 0) {
          events.push({
            name: eventFolder,
            handlerCount: handlers.length,
            handlers: handlers.map(h => h.replace(ext, '')),
            enabled: config[`_internal:event:${eventFolder}`] !== false
          });
        }
      }
    }

    // --- Panels ---
    const pnlDir = path.join(internalBase, 'panels');
    if (fs.existsSync(pnlDir)) {
      for (const file of fs.readdirSync(pnlDir)) {
        if (!file.endsWith(ext) || file.includes('.disabled')) continue;
        try {
          const mod = require(path.join(pnlDir, file));
          const panel = mod.default || mod;
          if (panel && (panel.id || panel.name)) {
            panels.push({
              name: panel.name || panel.id,
              id: panel.id || file.replace(ext, ''),
              description: panel.description || '',
              scope: panel.panelScope || 'guild',
              enabled: config[`_internal:panel:${panel.id || file.replace(ext, '')}`] !== false
            });
          }
        } catch { /* skip broken files */ }
      }
    }

    return {
      name: '_internal',
      displayName: 'Internal',
      category: 'core',
      commands,
      events,
      panels
    };
  }

  /**
   * GET /api/appstore/components
   * Returns all components from loaded modules + internalSetup, grouped by module
   */
  router.get('/components', async (req: Request, res: Response) => {
    try {
      if (!(await storeFirst(res))) return;
      const registry = getModuleRegistry();
      const allModules = registry.getAllModules();
      const config = loadComponentConfig();

      const modules: any[] = [];

      // Add internalSetup as the first group
      modules.push(getInternalComponents(config));

      // Add loaded AppStore/module components
      for (const mod of allModules) {
        const commands = (mod.commands || []).map((cmd: any) => ({
          name: cmd.name,
          description: cmd.description || '',
          type: cmd.type || 'ChatInput',
          options: extractCommandOptions(cmd),
          testOnly: !!cmd.testOnly,
          devOnly: !!cmd.devOnly,
          enabled: config[`${mod.manifest.name}:command:${cmd.name}`] !== false
        }));

        const events: Array<{ name: string; handlerCount: number; handlers?: string[]; enabled: boolean }> = [];
        if (mod.events) {
          for (const [eventName, handlers] of mod.events.entries()) {
            events.push({
              name: eventName,
              handlerCount: Array.isArray(handlers) ? handlers.length : 1,
              enabled: config[`${mod.manifest.name}:event:${eventName}`] !== false
            });
          }
        }

        const panels = (mod.panels || []).map((panel: any) => ({
          name: panel.name || panel.id,
          id: panel.id,
          description: panel.description || '',
          scope: panel.panelScope || 'guild',
          enabled: config[`${mod.manifest.name}:panel:${panel.id}`] !== false
        }));

        modules.push({
          name: mod.manifest.name,
          displayName: mod.manifest.displayName || mod.manifest.name,
          category: mod.manifest.category || 'misc',
          commands,
          events,
          panels
        });
      }

      res.json({ success: true, modules });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: msg });
    }
  });

  /**
   * PUT /api/appstore/components/:module/:type/:name
   * Toggle a component on/off
   */
  router.put('/components/:module/:type/:name', async (req: Request, res: Response) => {
    try {
      if (!(await storeFirst(res))) return;
      const { module: moduleName, type, name } = req.params;
      const { enabled } = req.body;

      if (!['command', 'event', 'panel'].includes(type)) {
        return res.status(400).json({ success: false, error: 'type must be command, event, or panel' });
      }

      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ success: false, error: 'enabled (boolean) is required' });
      }

      const key = `${moduleName}:${type}:${name}`;
      const { config, sha } = readComponentConfig();
      const changed = (config[key] !== false) !== enabled;

      // A FolderSyncError leaves the new setting in the file, so the running bot is told as on success.
      let unconfirmed: FolderSyncError | null = null;
      if (changed) {
        if (enabled) {
          delete config[key]; // Default is enabled, so just remove the override
        } else {
          config[key] = false;
        }
        try {
          await saveComponentConfig(config, sha);
        } catch (error) {
          if (!(error instanceof FolderSyncError)) throw error;
          unconfirmed = error;
        }
      }

      // Fire debounced runtime toggle (async, doesn't block response)
      if (botManager.isRunning()) {
        toggleDebouncer.debounce(key, enabled, async (finalEnabled) => {
          try {
            await botManager.toggleComponent(moduleName, type as 'command' | 'event' | 'panel', name, finalEnabled);
          } catch (err) {
            console.error(`[AppStore] Runtime toggle failed for ${key}:`, err);
          }
        });
      }

      if (unconfirmed) {
        const text = writeErrorText('The component setting', unconfirmed);
        console.error(`[AppStore] ${text}`);
        res.status(500).json({ success: false, key, enabled, changed, error: text });
        return;
      }
      res.json({ success: true, key, enabled, changed, ...(changed ? {} : { message: enabled ? 'already enabled' : 'already disabled' }) });
    } catch (error) {
      if (storeWriteAnswered(res, error)) return;
      const msg = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: msg });
    }
  });

  // ─── AppStore Config (cleanup toggle, etc.) ───

  /**
   * GET /api/appstore/config
   * Returns AppStore general config (cleanup toggle, etc.)
   */
  router.get('/config', async (_req: Request, res: Response) => {
    try {
      if (!(await storeFirst(res))) return;
      const config = loadAppStoreConfig();
      res.json({
        success: true,
        autoCleanup: config.autoCleanup === true,  // default false
        autoUpdate: config.autoUpdate === true,     // default false
        cleanup: botManager.getCommandCleanupStatus()
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: msg });
    }
  });

  /**
   * PUT /api/appstore/config
   * Update AppStore general config
   * Body: { autoCleanup?: boolean }
   */
  router.put('/config', async (req: Request, res: Response) => {
    try {
      if (!(await storeFirst(res))) return;
      const { config, sha } = readAppStoreConfig();
      if (typeof req.body.autoCleanup === 'boolean') {
        config.autoCleanup = req.body.autoCleanup;
      }
      if (typeof req.body.autoUpdate === 'boolean') {
        config.autoUpdate = req.body.autoUpdate;
      }
      let unconfirmed: FolderSyncError | null = null;
      try {
        await saveAppStoreConfig(config, sha);
      } catch (error) {
        if (!(error instanceof FolderSyncError)) throw error;
        unconfirmed = error;
      }

      // Turning autoCleanup ON kicks off the orphan sweep as tracked background
      // work: rate-limited global-command sweeps can run for minutes, so the
      // response returns immediately and the UI polls the `cleanup` status from
      // GET /config until the run finishes (the outcome, including IPC failure,
      // is captured there rather than blocking this request on the sweep).
      let cleanupStarted = false;
      if (req.body.autoCleanup === true && botManager.isRunning()) {
        botManager.startCommandCleanup();
        cleanupStarted = true;
      }
      const cleanupStopping = req.body.autoCleanup === false && botManager.getCommandCleanupStatus().running;

      if (unconfirmed) {
        const text = writeErrorText('The App Store settings', unconfirmed);
        console.error(`[AppStore] ${text}`);
        res.status(500).json({
          success: false,
          autoCleanup: config.autoCleanup === true,
          autoUpdate: config.autoUpdate === true,
          ...(cleanupStarted ? { cleanupStarted: true } : {}),
          ...(cleanupStopping ? { cleanupStopping: true } : {}),
          error: text,
        });
        return;
      }

      res.json({
        success: true,
        autoCleanup: config.autoCleanup === true,
        autoUpdate: config.autoUpdate === true,
        ...(cleanupStarted ? { cleanupStarted: true } : {}),
        ...(cleanupStopping ? { cleanupStopping: true } : {}),
      });
    } catch (error) {
      if (storeWriteAnswered(res, error)) return;
      const msg = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: msg });
    }
  });

  return router;
}

/**
 * Format module info for API response
 */
function formatModuleInfo(info: StoreModuleInfo, includeComponents = false): any {
  const result: any = {
    name: info.manifest.name,
    displayName: info.manifest.displayName,
    description: info.manifest.description,
    version: info.manifest.version,
    author: info.manifest.author,
    category: info.manifest.category,
    requiredIntents: info.manifest.requiredIntents || [],
    requiredPermissions: info.manifest.requiredPermissions || [],
    hasCredentials: !!info.manifest.apiCredentials,
    apiCredentials: info.manifest.apiCredentials || null,
    // Forward the tier gate so the AppStore browse view can show a
    // "Requires <Tier>+" badge on premium-only module cards.
    tierRequirement: info.manifest.tierRequirement || null,
    repoId: info.repoId,
    repoName: info.repoName,
    installed: info.installed,
    installedVersion: info.installedVersion
  };

  if (includeComponents) {
    const manager = getAppStoreManager();
    result.components = manager.getModuleComponents(info.manifest.name, info.repoId);
  }

  return result;
}
