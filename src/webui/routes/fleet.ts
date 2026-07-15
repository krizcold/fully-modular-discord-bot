// Fleet API - fleet state for the Usage tab's fleet section. Bot offline or
// fleet mid-init responds success:true with initialized:false - the section
// degrades, never errors (no 500s here).

import { Router, Request, Response } from 'express';
import { BotManager } from '../botManager';

export function createFleetRoutes(botManager: BotManager): Router {
  const router = Router();

  /**
   * GET /api/fleet/state
   * Full fleet state (role, nodes, shard table, guild map) flattened into
   * the response beside running/success.
   */
  router.get('/state', async (req: Request, res: Response) => {
    try {
      if (!botManager.isRunning()) {
        res.json({ success: true, running: false, initialized: false });
        return;
      }
      const result = await botManager.getFleetState();
      if (!result?.success || !result.state) {
        res.json({ success: true, running: true, initialized: false });
        return;
      }
      res.json({ success: true, running: true, ...result.state });
    } catch (error) {
      console.error('[Fleet] Failed to get fleet state:', error instanceof Error ? error.message : error);
      res.json({ success: true, running: botManager.isRunning(), initialized: false });
    }
  });

  return router;
}
