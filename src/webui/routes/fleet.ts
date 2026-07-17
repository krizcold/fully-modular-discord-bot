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

  /**
   * POST /api/fleet/assign { shardId, nodeId }
   * Master-only manual assignment of a FREE shard to a node. Owned shards are
   * rejected with a migration error; the bot child does the authoritative
   * validation. Returns { success } or { success:false, error }.
   */
  router.post('/assign', async (req: Request, res: Response) => {
    try {
      if (!botManager.isRunning()) {
        res.json({ success: false, error: 'Bot is not running' });
        return;
      }
      const shardId = Number(req.body?.shardId);
      const nodeId = String(req.body?.nodeId ?? '');
      const result = await botManager.assignFleetShard(shardId, nodeId);
      res.json(result?.success ? { success: true } : { success: false, error: result?.error ?? 'assign failed' });
    } catch (error) {
      console.error('[Fleet] Failed to assign shard:', error instanceof Error ? error.message : error);
      res.json({ success: false, error: error instanceof Error ? error.message : 'assign failed' });
    }
  });

  return router;
}
