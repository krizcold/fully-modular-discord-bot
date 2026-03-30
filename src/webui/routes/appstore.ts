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

export function createAppStoreRoutes(): Router {
  const router = Router();

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
  router.post('/repos', (req: Request, res: Response) => {
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
      const repo = manager.addRepository(
        name,
        url,
        branch || 'main',
        githubToken
      );

      res.json({
        success: true,
        repository: {
          ...repo,
          githubToken: repo.githubToken ? '***' : null
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
        modules: modules.map(formatModuleInfo)
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
        modules: modules.map(formatModuleInfo)
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
   * Install a module
   * Body: { repoId, credentials? }
   */
  router.post('/modules/:name/install', async (req: Request, res: Response) => {
    try {
      const { name } = req.params;
      const { repoId, credentials } = req.body;

      if (!repoId) {
        return res.status(400).json({
          success: false,
          error: 'Repository ID is required'
        });
      }

      const manager = getAppStoreManager();

      // Save credentials if provided
      if (credentials && typeof credentials === 'object') {
        manager.saveCredentials(name, credentials);
      }

      await manager.installModule(name, repoId);

      res.json({
        success: true,
        message: `Module ${name} installed successfully. Restart the container to load it.`,
        requiresRestart: true
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
   * DELETE /api/appstore/modules/:name
   * Uninstall a module
   */
  router.delete('/modules/:name', async (req: Request, res: Response) => {
    try {
      const { name } = req.params;
      const manager = getAppStoreManager();

      await manager.uninstallModule(name);

      res.json({
        success: true,
        message: `Module ${name} uninstalled successfully. Restart the bot to apply changes.`,
        requiresRestart: true
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

  const COMPONENT_CONFIG_PATH = path.join(process.env.DATA_DIR || '/data', 'global', 'appstore', 'component-config.json');

  function loadComponentConfig(): Record<string, boolean> {
    try {
      if (fs.existsSync(COMPONENT_CONFIG_PATH)) {
        return JSON.parse(fs.readFileSync(COMPONENT_CONFIG_PATH, 'utf-8'));
      }
    } catch { /* ignore */ }
    return {};
  }

  function saveComponentConfig(config: Record<string, boolean>): void {
    const dir = path.dirname(COMPONENT_CONFIG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(COMPONENT_CONFIG_PATH, JSON.stringify(config, null, 2));
  }

  /**
   * GET /api/appstore/components
   * Returns all components from loaded modules, grouped by module
   */
  router.get('/components', (req: Request, res: Response) => {
    try {
      const registry = getModuleRegistry();
      const allModules = registry.getAllModules();
      const config = loadComponentConfig();

      const modules = allModules.map(mod => {
        const commands = (mod.commands || []).map((cmd: any) => ({
          name: cmd.name,
          description: cmd.description || '',
          type: cmd.type || 'ChatInput',
          enabled: config[`${mod.manifest.name}:command:${cmd.name}`] !== false
        }));

        const events: Array<{ name: string; handlerCount: number; enabled: boolean }> = [];
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

        return {
          name: mod.manifest.name,
          displayName: mod.manifest.displayName || mod.manifest.name,
          category: mod.manifest.category || 'misc',
          commands,
          events,
          panels
        };
      });

      // Sort: internal-ish modules first, then alphabetical
      modules.sort((a, b) => a.name.localeCompare(b.name));

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
      res.json({ success: true, key, enabled });
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
