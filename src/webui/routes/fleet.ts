// Fleet API - fleet state for the Usage tab's fleet section. Bot offline or
// fleet mid-init responds success:true with initialized:false - the section
// degrades, never errors (no 500s here).

import { Router, Request, Response } from 'express';
import { BotManager } from '../botManager';
import { readPromoteRecord } from '../../bot/internalSetup/fleet/promoteRecord';
import { writeFreshFleetConfirm } from '../../bot/internalSetup/fleet/stepDown';
import { runDemote } from '../lifecycleActions';
import { cancelPromote, continuePromote, startPromote } from '../promoteEngine';

export function createFleetRoutes(botManager: BotManager): Router {
  const router = Router();

  /**
   * GET /api/fleet/state
   * Full fleet state (role, nodes, shard table, guild map) flattened into
   * the response beside running/success.
   */
  router.get('/state', async (req: Request, res: Response) => {
    // The promote record is parent-owned and outlives the child (the restart
    // phase runs while the child is down), so it rides beside the child state.
    const promote = readPromoteRecord();
    try {
      if (!botManager.isRunning()) {
        res.json({ success: true, running: false, initialized: false, promote });
        return;
      }
      const result = await botManager.getFleetState();
      if (!result?.success || !result.state) {
        res.json({ success: true, running: true, initialized: false, promote });
        return;
      }
      res.json({ success: true, running: true, ...result.state, promote });
    } catch (error) {
      console.error('[Fleet] Failed to get fleet state:', error instanceof Error ? error.message : error);
      res.json({ success: true, running: botManager.isRunning(), initialized: false, promote });
    }
  });

  /**
   * POST /api/fleet/config { masterCandidates: string[], witnessChannelId?: string }
   * Master-only runtime edit of the fleet config (B2): validated and applied
   * in the bot child, persisted to the control store, and pushed to every
   * connected node with zero restarts. The current copy rides GET /state
   * (state.fleetConfig, with the source of each value). witnessChannelId
   * omitted = unchanged; empty = owner DM default (B3).
   */
  router.post('/config', async (req: Request, res: Response) => {
    try {
      if (!botManager.isRunning()) {
        res.json({ success: false, error: 'Bot is not running' });
        return;
      }
      const result = await botManager.setFleetConfig(req.body?.masterCandidates, req.body?.witnessChannelId);
      res.json(result?.success ? { success: true, revision: result.revision } : { success: false, error: result?.error ?? 'config update failed' });
    } catch (error) {
      console.error('[Fleet] Failed to set fleet config:', error instanceof Error ? error.message : error);
      res.json({ success: false, error: error instanceof Error ? error.message : 'config update failed' });
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
   * POST /api/fleet/promote { confirmLag?, retireOldMaster? }
   * Unified promote (PLAN_REPLICATION 20.4, B4): THIS instance (the designated
   * backup) becomes the master side, bot and database together. The engine
   * takes the verdict here (every refusal is a clear message, never a 500;
   * needsLagConfirm + lagMs when the RPO must be acknowledged) and runs the
   * phases in the background; the record rides GET /state as `promote`.
   * retireOldMaster is the Transfer-and-retire button: relayed to the old
   * master in its register reply for its manager to act on.
   */
  router.post('/promote', async (req: Request, res: Response) => {
    try {
      const result = await startPromote(botManager, {
        confirmLag: req.body?.confirmLag === true,
        retireOldMaster: req.body?.retireOldMaster === true,
      });
      if (!result.success) console.warn(`[Fleet] Promotion refused: ${result.error}`);
      res.json(result);
    } catch (error) {
      console.error('[Fleet] Promotion failed:', error instanceof Error ? error.message : error);
      res.json({ success: false, error: error instanceof Error ? error.message : 'promotion failed' });
    }
  });

  /** GET /api/fleet/promote: the promote record (also embedded in /state). */
  router.get('/promote', (_req: Request, res: Response) => {
    res.json({ success: true, record: readPromoteRecord() });
  });

  /** POST /api/fleet/promote/continue: re-enter a parked promote at its recorded phase. */
  router.post('/promote/continue', async (_req: Request, res: Response) => {
    try {
      res.json(await continuePromote(botManager));
    } catch (error) {
      res.json({ success: false, error: error instanceof Error ? error.message : 'continue failed' });
    }
  });

  /** POST /api/fleet/promote/cancel: clear a promote that has not passed the point of no return. */
  router.post('/promote/cancel', (_req: Request, res: Response) => {
    res.json(cancelPromote());
  });

  /**
   * POST /api/fleet/confirm-fresh
   * Exit for the empty-store boot hold (PLAN_REPLICATION 20.14): the operator
   * confirms this is a brand-new fleet with no backup holding data.
   */
  router.post('/confirm-fresh', (_req: Request, res: Response) => {
    try {
      writeFreshFleetConfirm();
      console.warn('[Fleet] Brand-new fleet CONFIRMED via web UI; the empty-store hold releases');
      res.json({ success: true });
    } catch (error) {
      res.json({ success: false, error: error instanceof Error ? error.message : 'confirm failed' });
    }
  });

  /**
   * POST /api/fleet/demote { confirm? }
   * Demote THIS master back to co-worker; see runDemote for the state matrix
   * and the 20.12a ordering warning.
   */
  router.post('/demote', async (req: Request, res: Response) => {
    res.json(await runDemote(botManager, req.body?.confirm === true));
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
