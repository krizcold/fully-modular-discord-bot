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
  StoreModuleInfo
} from '../../bot/internalSetup/utils/appStoreManager';
import { getPremiumManager } from '../../bot/internalSetup/utils/premiumManager';
import { BotManager } from '../botManager';
import { ComponentToggleDebouncer } from '../utils/componentToggleDebouncer';
import { getInstallQueue } from '../utils/installQueue';

export function createAppStoreRoutes(botManager: BotManager): Router {
  const toggleDebouncer = new ComponentToggleDebouncer(1500);
  const installQueue = getInstallQueue();
  installQueue.setBotManager(botManager);
  const router = Router();

  // ============================================================================
  // BUNDLED DATA (single request for all AppStore data)
  // ============================================================================

  /**
   * GET /api/appstore/bundle
   * Returns all AppStore data in a single response to avoid multiple API calls.
   */
  router.get('/bundle', async (_req: Request, res: Response) => {
    try {
      const manager = getAppStoreManager();
      const premiumMgr = getPremiumManager();

      // Use fast cache; fall back to full fetch (with git clone) if cache is empty
      let modules = manager.getCachedModules();
      if (modules.length === 0 && manager.getRepositories().some(r => r.enabled)) {
        modules = await manager.getAvailableModules();
      }
      const installedRaw = manager.getInstalledModules();
      const repos = manager.getRepositories();

      // Cross-reference installed modules with what the bot has actually loaded
      // into memory. A module can be on disk + tracked in installedConfig but
      // not loaded if its last hot-load failed (compile error, import failure,
      // etc). The frontend uses this to show a "Needs bot restart" pill.
      const loadedNames = await botManager.listLoadedModules();
      const loadedSet = loadedNames ? new Set(loadedNames) : null;
      const installed = installedRaw.map(m => ({
        ...m,
        loaded: loadedSet ? loadedSet.has(m.name) : null
      }));

      res.json({
        success: true,
        modules: modules.map(m => formatModuleInfo(m)),
        installed,
        repositories: repos.map(repo => ({
          ...repo,
          githubToken: repo.githubToken ? '***' : null
        })),
        tiers: premiumMgr.getAllTiers(),
        guildAssignments: premiumMgr.getAllGuildAssignments(),
        installQueue: installQueue.getSnapshot()
      });
    } catch (error) {
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
  router.get('/repos', (_req: Request, res: Response) => {
    try {
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

      // Test access before saving — catches bad tokens / wrong URLs early
      const testRepo = { url: normalized.url, branch: finalBranch, githubToken: githubToken || null } as any;
      const access = manager.testRepoAccess(testRepo);
      if (!access.ok) {
        return res.status(400).json({
          success: false,
          error: access.error || 'Could not access repository'
        });
      }

      const repo = manager.addRepository(
        name,
        url,
        finalBranch,
        githubToken
      );

      // Immediately clone and scan for modules
      let modules: any[] = [];
      try {
        const scanned = await manager.refreshRepository(repo.id);
        modules = scanned.map(m => formatModuleInfo(m));
      } catch (refreshErr) {
        console.error('[AppStore] Auto-refresh after add failed:', refreshErr);
      }

      res.json({
        success: true,
        repository: {
          ...repo,
          githubToken: repo.githubToken ? '***' : null
        },
        modules
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
   * PUT /api/appstore/repos/:id
   * Update a repository
   * Body: { name?, url?, branch?, githubToken?, enabled? }
   */
  router.put('/repos/:id', (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const updates = req.body as Partial<AppStoreRepository>;

      const manager = getAppStoreManager();

      if (!manager.getRepository(id)) {
        return res.status(404).json({
          success: false,
          error: 'Repository not found'
        });
      }

      const success = manager.updateRepository(id, updates);

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
  router.delete('/repos/:id', (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const manager = getAppStoreManager();

      if (!manager.getRepository(id)) {
        return res.status(404).json({
          success: false,
          error: 'Repository not found'
        });
      }

      const success = manager.removeRepository(id);

      res.json({
        success,
        message: success ? 'Repository removed' : 'Failed to remove repository'
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
   * POST /api/appstore/repos/:id/refresh
   * Refresh modules from a repository
   */
  router.post('/repos/:id/refresh', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const manager = getAppStoreManager();

      if (!manager.getRepository(id)) {
        return res.status(404).json({
          success: false,
          error: 'Repository not found'
        });
      }

      const modules = await manager.refreshRepository(id);

      res.json({
        success: true,
        modules: modules.map(m => formatModuleInfo(m))
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
  // MODULE MANAGEMENT
  // ============================================================================

  /**
   * GET /api/appstore/modules
   * List all available modules from all enabled repositories
   */
  router.get('/modules', async (_req: Request, res: Response) => {
    try {
      const manager = getAppStoreManager();
      const modules = await manager.getAvailableModules();

      res.json({
        success: true,
        modules: modules.map(m => formatModuleInfo(m))
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
   * GET /api/appstore/modules/:name
   * Get details for a specific module
   */
  router.get('/modules/:name', (req: Request, res: Response) => {
    try {
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
  router.get('/installed', (_req: Request, res: Response) => {
    try {
      const manager = getAppStoreManager();
      const installed = manager.getInstalledModules();

      res.json({
        success: true,
        modules: installed
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
  // CREDENTIALS MANAGEMENT
  // ============================================================================

  /**
   * GET /api/appstore/credentials/:name
   * Get credentials for a module (masked)
   */
  router.get('/credentials/:name', (req: Request, res: Response) => {
    try {
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
  router.put('/credentials/:name', (req: Request, res: Response) => {
    try {
      const { name } = req.params;
      const { credentials } = req.body;

      if (!credentials || typeof credentials !== 'object') {
        return res.status(400).json({
          success: false,
          error: 'Credentials object is required'
        });
      }

      const manager = getAppStoreManager();
      const success = manager.saveCredentials(name, credentials);

      res.json({
        success,
        message: success ? 'Credentials saved' : 'Failed to save credentials'
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
   * DELETE /api/appstore/credentials/:name
   * Delete credentials for a module
   */
  router.delete('/credentials/:name', (req: Request, res: Response) => {
    try {
      const { name } = req.params;
      const manager = getAppStoreManager();
      const success = manager.deleteCredentials(name);

      res.json({
        success,
        message: success ? 'Credentials deleted' : 'Failed to delete credentials'
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
   * Body: { displayName, priority, overrides }
   */
  router.put('/premium/tiers/:id', (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { displayName, priority, overrides } = req.body;

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

      const manager = getPremiumManager();
      const success = manager.setTier(id, {
        displayName,
        priority,
        overrides: overrides || {}
      });

      res.json({
        success,
        message: success ? 'Tier saved' : 'Failed to save tier'
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
   * DELETE /api/appstore/premium/tiers/:id
   * Delete a tier (cannot delete 'free')
   */
  router.delete('/premium/tiers/:id', (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      if (id === 'free') {
        return res.status(400).json({
          success: false,
          error: 'Cannot delete the free tier'
        });
      }

      const manager = getPremiumManager();
      const success = manager.deleteTier(id);

      res.json({
        success,
        message: success ? 'Tier deleted' : 'Tier not found'
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
   * GET /api/appstore/premium/guilds
   * List all guild tier assignments
   */
  router.get('/premium/guilds', (_req: Request, res: Response) => {
    try {
      const manager = getPremiumManager();
      const assignments = manager.getAllGuildAssignments();

      res.json({
        success: true,
        assignments
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
   * PUT /api/appstore/premium/guilds/:guildId
   * Assign a tier to a guild
   * Body: { tierId }
   */
  router.put('/premium/guilds/:guildId', (req: Request, res: Response) => {
    try {
      const { guildId } = req.params;
      const { tierId } = req.body;

      if (!tierId || typeof tierId !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Tier ID is required'
        });
      }

      const manager = getPremiumManager();
      const success = manager.setGuildTier(guildId, tierId);

      res.json({
        success,
        message: success ? 'Guild tier assigned' : 'Failed to assign tier (tier may not exist)'
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
   * DELETE /api/appstore/premium/guilds/:guildId
   * Remove tier assignment from a guild (reset to free)
   */
  router.delete('/premium/guilds/:guildId', (req: Request, res: Response) => {
    try {
      const { guildId } = req.params;
      const manager = getPremiumManager();
      const success = manager.removeGuildTier(guildId);

      res.json({
        success,
        message: success ? 'Guild tier removed' : 'Failed to remove tier'
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  // ─── Component Management (Commands tab) ───

  const APPSTORE_CONFIG_DIR = path.join(process.env.DATA_DIR || '/data', 'global', 'appstore');
  const COMPONENT_CONFIG_PATH = path.join(APPSTORE_CONFIG_DIR, 'component-config.json');
  const APPSTORE_CONFIG_PATH = path.join(APPSTORE_CONFIG_DIR, 'config.json');

  function loadComponentConfig(): Record<string, boolean> {
    try {
      if (fs.existsSync(COMPONENT_CONFIG_PATH)) {
        return JSON.parse(fs.readFileSync(COMPONENT_CONFIG_PATH, 'utf-8'));
      }
    } catch { /* ignore */ }
    return {};
  }

  function saveComponentConfig(config: Record<string, boolean>): void {
    if (!fs.existsSync(APPSTORE_CONFIG_DIR)) fs.mkdirSync(APPSTORE_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(COMPONENT_CONFIG_PATH, JSON.stringify(config, null, 2));
  }

  function loadAppStoreConfig(): Record<string, any> {
    try {
      if (fs.existsSync(APPSTORE_CONFIG_PATH)) {
        return JSON.parse(fs.readFileSync(APPSTORE_CONFIG_PATH, 'utf-8'));
      }
    } catch { /* ignore */ }
    return {};
  }

  function saveAppStoreConfig(config: Record<string, any>): void {
    if (!fs.existsSync(APPSTORE_CONFIG_DIR)) fs.mkdirSync(APPSTORE_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(APPSTORE_CONFIG_PATH, JSON.stringify(config, null, 2));
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
  router.get('/components', (req: Request, res: Response) => {
    try {
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
  router.put('/components/:module/:type/:name', (req: Request, res: Response) => {
    try {
      const { module: moduleName, type, name } = req.params;
      const { enabled } = req.body;

      if (!['command', 'event', 'panel'].includes(type)) {
        return res.status(400).json({ success: false, error: 'type must be command, event, or panel' });
      }

      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ success: false, error: 'enabled (boolean) is required' });
      }

      const key = `${moduleName}:${type}:${name}`;
      const config = loadComponentConfig();

      if (enabled) {
        delete config[key]; // Default is enabled, so just remove the override
      } else {
        config[key] = false;
      }

      saveComponentConfig(config);

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

      res.json({ success: true, key, enabled });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: msg });
    }
  });

  // ─── AppStore Config (cleanup toggle, etc.) ───

  /**
   * GET /api/appstore/config
   * Returns AppStore general config (cleanup toggle, etc.)
   */
  router.get('/config', (_req: Request, res: Response) => {
    try {
      const config = loadAppStoreConfig();
      res.json({
        success: true,
        autoCleanup: config.autoCleanup === true,  // default false
        autoUpdate: config.autoUpdate === true      // default false
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
  router.put('/config', (req: Request, res: Response) => {
    try {
      const config = loadAppStoreConfig();
      if (typeof req.body.autoCleanup === 'boolean') {
        config.autoCleanup = req.body.autoCleanup;
      }
      if (typeof req.body.autoUpdate === 'boolean') {
        config.autoUpdate = req.body.autoUpdate;
      }
      saveAppStoreConfig(config);

      // If autoCleanup was just turned ON, trigger immediate orphan cleanup
      if (req.body.autoCleanup === true && botManager.isRunning()) {
        botManager.reregisterCommands().catch(err => {
          console.error('[AppStore] Failed to trigger cleanup on toggle:', err);
        });
      }

      res.json({ success: true, autoCleanup: config.autoCleanup === true, autoUpdate: config.autoUpdate === true });
    } catch (error) {
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
    premium: info.manifest.premium || false,
    requiredIntents: info.manifest.requiredIntents || [],
    requiredPermissions: info.manifest.requiredPermissions || [],
    hasCredentials: !!info.manifest.apiCredentials,
    apiCredentials: info.manifest.apiCredentials || null,
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
