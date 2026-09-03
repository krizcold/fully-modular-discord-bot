// Manager-facing lifecycle surface (PLAN_REPLICATION 20.16). The browser's
// /api/fleet/* is authenticated at the deployment boundary and is deliberately
// open inside the container, so it must never be what an orchestrator drives.
// This surface takes the per-instance token both sides already hold and wraps
// the SAME engine the browser routes call - it duplicates no decision logic.
//
// The app decides, the manager acts: /facts reports what this node concluded
// (superseded, retire instruction, copy block, promote phase), and the manager
// performs the docker and data-directory work those facts imply.

import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { BotManager } from '../botManager';
import { readPromoteRecord } from '../../bot/internalSetup/fleet/promoteRecord';
import { clearCopyBlock, readCopyBlock, readSuperseded, writeCopyBlock, writeFreshFleetConfirm } from '../../bot/internalSetup/fleet/stepDown';
import { runDemote } from '../lifecycleActions';
import { cancelPromote, continuePromote, startPromote } from '../promoteEngine';

function tokensMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  // Compare a fixed-width digest so the length itself is not an oracle.
  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(a).digest(),
    crypto.createHash('sha256').update(b).digest(),
  );
}

/**
 * An unset token means NO manager owns this instance (a hand deployment), and
 * an empty expected value must never turn into an open door: refuse everything.
 */
function requireManagerToken(req: Request, res: Response, next: NextFunction): void {
  const expected = (process.env.BOT_MANAGER_UPDATE_TOKEN || '').trim();
  if (!expected) {
    res.status(403).json({ success: false, error: 'this instance is not managed; no manager token is configured' });
    return;
  }
  const given = String(req.headers['x-bot-token'] || '').trim();
  if (!given || !tokensMatch(given, expected)) {
    res.status(403).json({ success: false, error: 'invalid manager token' });
    return;
  }
  next();
}

export function createManagedRoutes(botManager: BotManager): Router {
  const router = Router();
  router.use(requireManagerToken);

  /**
   * GET /api/managed/facts
   * What this node concluded, for the manager's retire/decommission/reseed
   * surfaces. Never 500s; an unreadable fact reads as absent.
   */
  router.get('/facts', async (_req: Request, res: Response) => {
    try {
      let state: any = null;
      if (botManager.isRunning()) {
        const result = await botManager.getFleetState();
        state = result?.success ? result.state : null;
      }
      const copyBlock = readCopyBlock();
      res.json({
        success: true,
        running: botManager.isRunning(),
        initialized: state?.initialized === true,
        role: state?.role ?? null,
        nodeId: state?.nodeId ?? null,
        nodeName: state?.nodeName ?? null,
        term: state?.term ?? null,
        standalone: state?.standalone === true,
        backupMaster: state?.backupMaster === true,
        superseded: readSuperseded(),
        promote: readPromoteRecord(),
        emptyStoreHold: state?.emptyStoreHold ?? null,
        takeoverHold: state?.takeoverHold ?? null,
        staleMasterPark: state?.staleMasterPark ?? null,
        // Only an initialized master relays the block to designated backups
        // (20.14); the manager keys its publishes on this verdict instead of
        // interpreting this app's role vocabulary.
        copyBlockTarget: state?.initialized === true && state?.role === 'master',
        copyBlock,
      });
    } catch (error) {
      res.json({ success: false, error: error instanceof Error ? error.message : 'facts unavailable' });
    }
  });

  /** POST /api/managed/promote { confirmLag?, retireOldMaster? } */
  router.post('/promote', async (req: Request, res: Response) => {
    try {
      const result = await startPromote(botManager, {
        confirmLag: req.body?.confirmLag === true,
        retireOldMaster: req.body?.retireOldMaster === true,
        startedBy: 'manager-promote',
      });
      if (!result.success) console.warn(`[Managed] Promotion refused: ${result.error}`);
      res.json(result);
    } catch (error) {
      console.error('[Managed] Promotion failed:', error instanceof Error ? error.message : error);
      res.json({ success: false, error: error instanceof Error ? error.message : 'promotion failed' });
    }
  });

  /** GET /api/managed/promote: the persisted promote record. */
  router.get('/promote', (_req: Request, res: Response) => {
    res.json({ success: true, record: readPromoteRecord() });
  });

  /** POST /api/managed/promote/continue: re-enter a parked promote at its phase. */
  router.post('/promote/continue', async (_req: Request, res: Response) => {
    try {
      res.json(await continuePromote(botManager));
    } catch (error) {
      res.json({ success: false, error: error instanceof Error ? error.message : 'continue failed' });
    }
  });

  /** POST /api/managed/promote/cancel */
  router.post('/promote/cancel', (_req: Request, res: Response) => {
    res.json(cancelPromote());
  });

  /** POST /api/managed/demote { confirm? } */
  router.post('/demote', async (req: Request, res: Response) => {
    res.json(await runDemote(botManager, req.body?.confirm === true, 'manager-demote'));
  });

  /**
   * POST /api/managed/copy-block { dsn, cert }
   * The manager hands this node the replication copy block for the database it
   * hosts, so the bot can relay it to designated backups on register (20.14).
   * Only the manager can produce it: the replicator password and the server
   * certificate live in the sidecar the manager owns, never in the bot.
   */
  router.post('/copy-block', (req: Request, res: Response) => {
    try {
      // clear:true retracts it, for when the database it describes is gone.
      // Relaying a block to a deleted database would point a backup at nothing.
      if (req.body?.clear === true) {
        clearCopyBlock();
        console.log('[Managed] Copy block retracted by the manager');
        res.json({ success: true });
        return;
      }
      const dsn = String(req.body?.dsn ?? '').trim();
      const cert = String(req.body?.cert ?? '').trim();
      if (!dsn || !cert) {
        res.json({ success: false, error: 'dsn and cert are both required' });
        return;
      }
      writeCopyBlock({ dsn, cert, publishedAt: Date.now() });
      console.log('[Managed] Copy block published by the manager; designated backups get it on register');
      res.json({ success: true });
    } catch (error) {
      res.json({ success: false, error: error instanceof Error ? error.message : 'copy block write failed' });
    }
  });

  /** POST /api/managed/confirm-fresh: release the empty-store boot hold (20.14). */
  router.post('/confirm-fresh', (_req: Request, res: Response) => {
    try {
      writeFreshFleetConfirm();
      console.warn('[Managed] Brand-new fleet CONFIRMED by the manager; the empty-store hold releases');
      res.json({ success: true });
    } catch (error) {
      res.json({ success: false, error: error instanceof Error ? error.message : 'confirm failed' });
    }
  });

  return router;
}
