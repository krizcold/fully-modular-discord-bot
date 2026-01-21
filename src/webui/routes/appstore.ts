/**
 * App Store Routes
 *
 * API endpoints for managing App Store repositories, modules, and credentials.
 */

import { Router, Request, Response } from 'express';
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
        module: formatModuleInfo(moduleInfo)
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
        message: `Module ${name} installed successfully. Restart the bot to load it.`,
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

  return router;
}

/**
 * Format module info for API response
 */
function formatModuleInfo(info: StoreModuleInfo): any {
  return {
    name: info.manifest.name,
    displayName: info.manifest.displayName,
    description: info.manifest.description,
    version: info.manifest.version,
    author: info.manifest.author,
    category: info.manifest.category,
    premium: info.manifest.premium || false,
    hasCredentials: !!info.manifest.apiCredentials,
    apiCredentialsSchema: info.manifest.apiCredentials?.schema || null,
    repoId: info.repoId,
    repoName: info.repoName,
    installed: info.installed,
    installedVersion: info.installedVersion
  };
}
