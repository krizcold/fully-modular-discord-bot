// Fleet API - fleet state for the Usage tab's fleet section. Bot offline or
// fleet mid-init responds success:true with initialized:false - the section
// degrades, never errors (no 500s here).

import { Router, Request, Response } from 'express';
import { BotManager } from '../botManager';
import {
  clearRoleOverride,
  invalidateRoleOverrideCache,
  isStandalone,
  resolveEnvRole,
  resolveNodeRole,
  writeRoleOverride,
} from '../../bot/internalSetup/fleet/nodeIdentity';
import { canonicalStoreReachable, promoteReplicaPair, resolveReplicaEndpoints } from '../../bot/internalSetup/fleet/replicaPromotion';
import { effectiveMasterUrls } from '../../bot/internalSetup/fleet/fleetConfig';

// Promotion gate: dataBackendHealthy stays true through the C1 write-acceptance
// coast, so it cannot see a control-store outage. The probe itself lives in
// replicaPromotion.ts because the pair rung decides on the same signal.

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
   * POST /api/fleet/promote { takeover?, chainTakeover? }
   * Warm standby (PLAN_STANDBY 3.5): promote THIS node (the designated backup)
   * to master. Parent-side on purpose - it writes the role override and
   * restarts the bot child, so it works while the child is mid-restart.
   * Prechecks run against the child's live fleet state; every refusal is a
   * clear message, never a 500. takeover skips the boot guard (explicit
   * intent); chainTakeover additionally declares the dead master lost after
   * the hold-down (dead-master failover, NOT planned handover).
   *
   * PLAN_REPLICATION Stage 3: on a machine holding a database standby the
   * rung runs first and decides whether the DATABASE moves too. It only does
   * when the primary is gone on both channels (see replicaPromotion.ts); a
   * reachable fleet database is deposed through the term row instead, because
   * forking the store is what would break that fence. confirmLag is the
   * operator's acknowledgement of the measured RPO (R3); the response carries
   * needsLagConfirm + lagMs when it is required, and promotedDatabase on
   * success says whether the standby became the fleet store.
   */
  router.post('/promote', async (req: Request, res: Response) => {
    try {
      if (!botManager.isRunning()) {
        res.json({ success: false, error: 'Bot is not running; start it before promoting' });
        return;
      }
      const result = await botManager.getFleetState();
      const state: any = result?.success ? result.state : null;
      if (!state || !state.initialized) {
        res.json({ success: false, error: 'Fleet state unavailable (bot still initializing); try again shortly' });
        return;
      }
      // A local standby changes what "the database is unreachable" means: the
      // primary being gone is exactly the failure this pair exists for, and
      // the promotion brings the database back with it.
      const replica = resolveReplicaEndpoints();
      let promotedDatabase = false;
      const refusal = state.role !== 'co-worker' ? 'this node is already a master'
        : state.backupMaster !== true ? 'this node is not the designated backup master (set BOT_NODE_ROLE=backup-master)'
        : state.dataBackend !== 'postgres' ? 'promotion is a postgres-mode feature (file mode has no standby)'
        : (state.dataBackendHealthy === false && !replica) ? 'the database (control store) is unreachable from this node; a promotion would park at boot instead of taking over - wait for it or fix connectivity first'
        : state.draining === true ? 'this node is draining; promotion refused'
        : state.migrationWorkActive === true ? 'a migration/transformation is working on this node; wait for it to finish'
        : null;
      if (refusal) {
        res.json({ success: false, error: refusal });
        return;
      }
      if (replica) {
        // The rung decides whether this promotion needs the database at all
        // (a live fleet database is deposed through the term row and must NOT
        // be forked) and runs the same reachability check when it does not.
        const pair = await promoteReplicaPair(replica, {
          confirmLag: req.body?.confirmLag === true,
          masterAlive: state.masterKnown === true,
        });
        if (!pair.success) {
          console.warn(`[Fleet] Promotion refused at the replica rung: ${pair.error}`);
          res.json({
            success: false,
            error: pair.error ?? 'promoting the local database replica failed',
            ...(pair.needsLagConfirm ? { needsLagConfirm: true, lagMs: pair.lagMs ?? null } : {}),
          });
          return;
        }
        promotedDatabase = pair.promotedDatabase === true;
      } else {
        const store = await canonicalStoreReachable();
        if (!store.ok) {
          console.warn(`[Fleet] Promotion refused: control store probe failed (${store.error})`);
          res.json({ success: false, error: 'the database (control store) is unreachable from this node; a promotion would park at boot instead of taking over - wait for it or fix connectivity first' });
          return;
        }
      }
      writeRoleOverride({
        role: 'master',
        ...(req.body?.takeover === true ? { takeover: true } : {}),
        ...(req.body?.chainTakeover === true ? { chainTakeover: true } : {}),
        setAt: Date.now(),
        setBy: 'webui-promote',
      });
      console.warn(`[Fleet] PROMOTION staged via web UI (takeover=${req.body?.takeover === true}, chainTakeover=${req.body?.chainTakeover === true}); restarting the bot child as master`);
      const restart = await botManager.restart();
      res.json(restart?.success
        ? { success: true, promotedDatabase }
        : { success: false, error: restart?.error ?? 'restart failed; the role override is staged and the next start boots as master' });
    } catch (error) {
      console.error('[Fleet] Promotion failed:', error instanceof Error ? error.message : error);
      res.json({ success: false, error: error instanceof Error ? error.message : 'promotion failed' });
    }
  });

  /**
   * POST /api/fleet/demote
   * Demote THIS master back to co-worker (deposed/overridden master cleanup,
   * or the second half of a planned handover). An env co-worker only needs
   * its override cleared; an env master gets a co-worker override and must
   * have master candidates configured to dial.
   *
   * MUST work in all three master states, not just a healthy one: (a) fully
   * initialized; (b) parked in the boot takeover guard or the stale-master
   * fence (initFleet never returns, so fleet state stays pre-init forever -
   * the flagship old-master-returns flow lives exactly there); (c) bot child
   * down/crash-looping. For (b) and (c) the child's state is unusable (the
   * pre-init branch hardcodes role/standalone), so the prechecks run from
   * PARENT-side truth: the same env + override file the child would boot from.
   */
  router.post('/demote', async (req: Request, res: Response) => {
    try {
      // The child rewrites role-override.json when it consumes one-shot
      // takeover flags; never trust this process's cached copy for a role
      // decision.
      invalidateRoleOverrideCache();
      const running = botManager.isRunning();
      let state: any = null;
      if (running) {
        const result = await botManager.getFleetState();
        state = result?.success ? result.state : null;
      }
      if (state && state.initialized) {
        const refusal = state.role !== 'master' ? 'this node is not a master'
          : state.standalone === true ? 'a standalone master has no fleet to rejoin; demotion is meaningless here'
          : (!Array.isArray(state.masterUrls) || state.masterUrls.length === 0)
            ? 'no master candidates configured (set MASTER_URLS first, or the demoted node would idle)'
          : null;
        if (refusal) {
          res.json({ success: false, error: refusal });
          return;
        }
      } else if (running && !(state && (state.takeoverHold || state.staleMasterPark))) {
        // Genuine early boot with no hold: seconds away from real state.
        res.json({ success: false, error: 'Fleet state unavailable (bot still initializing); try again shortly' });
        return;
      } else {
        // Guard-held boot or a downed child: parent-side prechecks.
        const refusal = resolveNodeRole() !== 'master' ? 'this node is not a master'
          : isStandalone() ? 'a standalone master has no fleet to rejoin; demotion is meaningless here'
          : effectiveMasterUrls().urls.length === 0 ? 'no master candidates configured (set MASTER_URLS or the fleet config first, or the demoted node would idle)'
          : null;
        if (refusal) {
          res.json({ success: false, error: refusal });
          return;
        }
      }
      if (resolveEnvRole() === 'co-worker') {
        clearRoleOverride();
      } else {
        writeRoleOverride({ role: 'co-worker', setAt: Date.now(), setBy: 'webui-demote' });
      }
      console.warn('[Fleet] DEMOTION staged via web UI; restarting the bot child as co-worker');
      const restart = await botManager.restart();
      res.json(restart?.success ? { success: true } : { success: false, error: restart?.error ?? 'restart failed; the role change is staged and the next start boots as co-worker' });
    } catch (error) {
      console.error('[Fleet] Demotion failed:', error instanceof Error ? error.message : error);
      res.json({ success: false, error: error instanceof Error ? error.message : 'demotion failed' });
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
