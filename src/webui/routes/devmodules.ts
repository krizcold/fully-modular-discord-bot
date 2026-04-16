/**
 * Dev Modules Routes
 *
 * API endpoints for listing and reloading modules in modulesDev/.
 *
 * @TODO Future work:
 * - File-watcher auto-reload (watch modulesDev for changes, trigger reload automatically)
 * - Dev logging (dedicated log stream for dev module compile/load output)
 * - Dependency linking (resolve cross-module deps within modulesDev repos)
 */

import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { getModulesDevDir } from '../../bot/internalSetup/utils/pathHelpers';
import { BotManager } from '../botManager';

interface DevModuleInfo {
  name: string;
  displayName: string;
  version: string;
  description: string;
  author: string;
  category: string;
  loaded: boolean | null;
}

interface DevRepoInfo {
  name: string;
  modules: DevModuleInfo[];
}

function scanDevModules(loadedModules: string[] | null): DevRepoInfo[] {
  const devDir = getModulesDevDir();
  if (!fs.existsSync(devDir)) return [];

  const repos: DevRepoInfo[] = [];
  const loadedSet = loadedModules ? new Set(loadedModules) : null;

  const repoDirs = fs.readdirSync(devDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'));

  for (const repoDir of repoDirs) {
    const modulesPath = path.join(devDir, repoDir.name, 'Modules');
    const modules: DevModuleInfo[] = [];

    if (fs.existsSync(modulesPath)) {
      const moduleEntries = fs.readdirSync(modulesPath, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.endsWith('.disabled'));

      for (const entry of moduleEntries) {
        const manifestPath = path.join(modulesPath, entry.name, 'module.json');
        try {
          if (!fs.existsSync(manifestPath)) continue;
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          modules.push({
            name: manifest.name || entry.name,
            displayName: manifest.displayName || manifest.name || entry.name,
            version: manifest.version || '0.0.0',
            description: manifest.description || '',
            author: manifest.author || '',
            category: manifest.category || 'misc',
            loaded: loadedSet ? loadedSet.has(manifest.name || entry.name) : null,
          });
        } catch (err) {
          console.warn(`[DevModules] Failed to read manifest for ${entry.name}:`, err);
        }
      }
    }

    repos.push({ name: repoDir.name, modules });
  }

  return repos;
}

export function createDevModulesRoutes(botManager: BotManager): Router {
  const router = Router();

  // List all dev modules grouped by repo
  router.get('/list', async (req: Request, res: Response) => {
    try {
      const loadedModules = await botManager.listLoadedModules();
      const repos = scanDevModules(loadedModules);
      res.json({ success: true, repos });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // Reload a single dev module
  router.post('/:name/reload', async (req: Request, res: Response) => {
    try {
      if (!botManager.isRunning()) {
        res.status(400).json({ success: false, error: 'Bot is not running' });
        return;
      }
      const result = await botManager.reloadModule(req.params.name);
      res.json(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  // Reload all loaded dev modules
  router.post('/reload-all', async (req: Request, res: Response) => {
    try {
      if (!botManager.isRunning()) {
        res.status(400).json({ success: false, error: 'Bot is not running' });
        return;
      }

      const loadedModules = await botManager.listLoadedModules();
      if (!loadedModules) {
        res.json({ success: true, reloaded: [], message: 'Could not query loaded modules' });
        return;
      }

      // Get all dev module names
      const repos = scanDevModules(loadedModules);
      const devModuleNames = repos.flatMap(r => r.modules.map(m => m.name));

      // Only reload dev modules that are currently loaded
      const toReload = devModuleNames.filter(name => loadedModules.includes(name));

      if (toReload.length === 0) {
        res.json({ success: true, reloaded: [], message: 'No dev modules are currently loaded' });
        return;
      }

      const result = await botManager.reloadModules(toReload);
      res.json(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: errorMessage });
    }
  });

  return router;
}
