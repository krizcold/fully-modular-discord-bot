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

  /**
   * POST /api/fleet/resume-assignments
   * Master-only: end the reshard pause (delete the marker, resume shard
   * distribution). Clear errors when this node is not the master or no pause
   * is active; never a 500.
   */
  router.post('/resume-assignments', async (req: Request, res: Response) => {
    try {
      if (!botManager.isRunning()) {
        res.json({ success: false, error: 'Bot is not running' });
        return;
      }
      const result = await botManager.resumeFleetAssignments();
      res.json(result?.success ? { success: true } : { success: false, error: result?.error ?? 'resume failed' });
    } catch (error) {
      console.error('[Fleet] Failed to resume assignments:', error instanceof Error ? error.message : error);
      res.json({ success: false, error: error instanceof Error ? error.message : 'resume failed' });
    }
  });

  /**
   * POST /api/fleet/declare-lost { nodeId }
   * Master-only operator verdict on a down node: free its shards and forget
   * it. The bot child does the authoritative validation (connected nodes are
   * refused with a Drain hint); never a 500.
   */
  router.post('/declare-lost', async (req: Request, res: Response) => {
    try {
      if (!botManager.isRunning()) {
        res.json({ success: false, error: 'Bot is not running' });
        return;
      }
      const nodeId = String(req.body?.nodeId ?? '');
      const result = await botManager.declareFleetNodeLost(nodeId);
      res.json(result?.success ? { success: true } : { success: false, error: result?.error ?? 'declare lost failed' });
    } catch (error) {
      console.error('[Fleet] Failed to declare node lost:', error instanceof Error ? error.message : error);
      res.json({ success: false, error: error instanceof Error ? error.message : 'declare lost failed' });
    }
  });

  /**
   * POST /api/fleet/drain { nodeId }
   * Master-only manual lease drain of a live worker. The bot child does the
   * authoritative validation; never a 500.
   */
  router.post('/drain', async (req: Request, res: Response) => {
    try {
      if (!botManager.isRunning()) {
        res.json({ success: false, error: 'Bot is not running' });
        return;
      }
      const nodeId = String(req.body?.nodeId ?? '');
      const result = await botManager.drainFleetNode(nodeId);
      res.json(result?.success ? { success: true } : { success: false, error: result?.error ?? 'drain failed' });
    } catch (error) {
      console.error('[Fleet] Failed to drain node:', error instanceof Error ? error.message : error);
      res.json({ success: false, error: error instanceof Error ? error.message : 'drain failed' });
    }
  });

  /**
   * POST /api/fleet/migrate { kind, ... }
   * Master-only: start a migration (move/swap/retire/redistribute). The bot
   * child validates (concurrency, health, ownership, route); never a 500.
   */
  router.post('/migrate', async (req: Request, res: Response) => {
    try {
      if (!botManager.isRunning()) {
        res.json({ success: false, error: 'Bot is not running' });
        return;
      }
      const result = await botManager.startFleetMigration(req.body ?? {});
      res.json(result?.success ? { success: true, migrationId: result.migrationId } : { success: false, error: result?.error ?? 'migration failed' });
    } catch (error) {
      console.error('[Fleet] Failed to start migration:', error instanceof Error ? error.message : error);
      res.json({ success: false, error: error instanceof Error ? error.message : 'migration failed' });
    }
  });

  /**
   * POST /api/fleet/migrate/precheck { kind, ... }
   * Master-only dry-run: returns est size, target free space, direction, guilds,
   * warnings (and the redistribute move set) for the confirm dialog.
   */
  router.post('/migrate/precheck', async (req: Request, res: Response) => {
    try {
      if (!botManager.isRunning()) {
        res.json({ success: false, error: 'Bot is not running' });
        return;
      }
      const result = await botManager.precheckFleetMigration(req.body ?? {});
      res.json(result?.success ? { success: true, precheck: result.precheck } : { success: false, error: result?.error ?? 'precheck failed' });
    } catch (error) {
      console.error('[Fleet] Failed to precheck migration:', error instanceof Error ? error.message : error);
      res.json({ success: false, error: error instanceof Error ? error.message : 'precheck failed' });
    }
  });

  /**
   * POST /api/fleet/migrate/abort { migrationId }
   * Master-only: abort the active migration (refused post-commit).
   */
  router.post('/migrate/abort', async (req: Request, res: Response) => {
    try {
      if (!botManager.isRunning()) {
        res.json({ success: false, error: 'Bot is not running' });
        return;
      }
      const result = await botManager.abortFleetMigration(String(req.body?.migrationId ?? ''));
      res.json(result?.success ? { success: true } : { success: false, error: result?.error ?? 'abort failed' });
    } catch (error) {
      console.error('[Fleet] Failed to abort migration:', error instanceof Error ? error.message : error);
      res.json({ success: false, error: error instanceof Error ? error.message : 'abort failed' });
    }
  });

  /**
   * POST /api/fleet/migrate/resume { migrationId }
   * Master-only: resume a paused retire at its failed leg.
   */
  router.post('/migrate/resume', async (req: Request, res: Response) => {
    try {
      if (!botManager.isRunning()) {
        res.json({ success: false, error: 'Bot is not running' });
        return;
      }
      const result = await botManager.resumeFleetMigration(String(req.body?.migrationId ?? ''));
      res.json(result?.success ? { success: true } : { success: false, error: result?.error ?? 'resume failed' });
    } catch (error) {
      console.error('[Fleet] Failed to resume migration:', error instanceof Error ? error.message : error);
      res.json({ success: false, error: error instanceof Error ? error.message : 'resume failed' });
    }
  });

  /**
   * GET /api/fleet/migrations
   * Master-only: the active + recent migrations. Degrade-never-500 like /state.
   */
  router.get('/migrations', async (_req: Request, res: Response) => {
    try {
      if (!botManager.isRunning()) {
        res.json({ success: true, running: false, migrations: { active: null, history: [] } });
        return;
      }
      const result = await botManager.listFleetMigrations();
      res.json({ success: true, running: true, migrations: result?.migrations ?? { active: null, history: [] } });
    } catch (error) {
      console.error('[Fleet] Failed to list migrations:', error instanceof Error ? error.message : error);
      res.json({ success: true, running: botManager.isRunning(), migrations: { active: null, history: [] } });
    }
  });

  /**
   * POST /api/fleet/transform { direction? }
   * Start the backend transformation (any master incl. standalone). The
   * direction is derived from where the data lives; a supplied one is
   * validated against it.
   */
  router.post('/transform', async (req: Request, res: Response) => {
    try {
      if (!botManager.isRunning()) {
        res.json({ success: false, error: 'Bot is not running' });
        return;
      }
      const direction = typeof req.body?.direction === 'string' ? { direction: req.body.direction } : {};
      const result = await botManager.startFleetTransformation(direction);
      res.json(result?.success ? { success: true, transformationId: result.transformationId } : { success: false, error: result?.error ?? 'transform start failed' });
    } catch (error) {
      console.error('[Fleet] Failed to start transformation:', error instanceof Error ? error.message : error);
      res.json({ success: false, error: error instanceof Error ? error.message : 'transform start failed' });
    }
  });

  /** POST /api/fleet/transform/pause - lets the in-flight guild finish, then holds. */
  router.post('/transform/pause', async (_req: Request, res: Response) => {
    try {
      if (!botManager.isRunning()) {
        res.json({ success: false, error: 'Bot is not running' });
        return;
      }
      const result = await botManager.pauseFleetTransformation();
      res.json(result?.success ? { success: true } : { success: false, error: result?.error ?? 'pause failed' });
    } catch (error) {
      console.error('[Fleet] Failed to pause transformation:', error instanceof Error ? error.message : error);
      res.json({ success: false, error: error instanceof Error ? error.message : 'pause failed' });
    }
  });

  /** POST /api/fleet/transform/resume - re-enters at the cursors. */
  router.post('/transform/resume', async (_req: Request, res: Response) => {
    try {
      if (!botManager.isRunning()) {
        res.json({ success: false, error: 'Bot is not running' });
        return;
      }
      const result = await botManager.resumeFleetTransformation();
      res.json(result?.success ? { success: true } : { success: false, error: result?.error ?? 'resume failed' });
    } catch (error) {
      console.error('[Fleet] Failed to resume transformation:', error instanceof Error ? error.message : error);
      res.json({ success: false, error: error instanceof Error ? error.message : 'resume failed' });
    }
  });

  /** POST /api/fleet/transform/abort - reverses the converted prefix (refused after the flip). */
  router.post('/transform/abort', async (_req: Request, res: Response) => {
    try {
      if (!botManager.isRunning()) {
        res.json({ success: false, error: 'Bot is not running' });
        return;
      }
      const result = await botManager.abortFleetTransformation();
      res.json(result?.success ? { success: true } : { success: false, error: result?.error ?? 'abort failed' });
    } catch (error) {
      console.error('[Fleet] Failed to abort transformation:', error instanceof Error ? error.message : error);
      res.json({ success: false, error: error instanceof Error ? error.message : 'abort failed' });
    }
  });

  /**
   * POST /api/fleet/dev/corrupt-lease { shardId }
   * Dev fault hook (drill P2.8): corrupt a held lease so the next renew reports
   * lease-mismatch. Inert unless FLEET_DEV_HOOKS=1 on the bot; never a 500.
   */
  router.post('/dev/corrupt-lease', async (req: Request, res: Response) => {
    try {
      if (!botManager.isRunning()) {
        res.json({ success: false, error: 'Bot is not running' });
        return;
      }
      const result = await botManager.corruptFleetLease(Number(req.body?.shardId));
      res.json(result?.success ? { success: true } : { success: false, error: result?.error ?? 'corrupt-lease failed' });
    } catch (error) {
      console.error('[Fleet] Failed to corrupt lease:', error instanceof Error ? error.message : error);
      res.json({ success: false, error: error instanceof Error ? error.message : 'corrupt-lease failed' });
    }
  });

  return router;
}
