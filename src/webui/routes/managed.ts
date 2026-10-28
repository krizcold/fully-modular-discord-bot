// Manager-facing surface. It takes the per-instance token both sides already hold;
// the browser's routes are authenticated at the deployment boundary instead.

import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import type { BotManager } from '../botManager';
import { DEFAULT_MAINTENANCE_MESSAGE } from '../../bot/internalSetup/utils/maintenanceGate';
import { MAINTENANCE_MESSAGE_MAX, readMaintenanceFile, writeMaintenanceFile } from '../../utils/maintenanceFile';

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

  // Contract 1: the state is saved first; entering, the bot process then saves what it holds; leaving, the bot process
  // saves what it holds and asks for its restart once nothing is held.
  router.post('/maintenance', async (req: Request, res: Response) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { state?: unknown; message?: unknown };
    const { state, message } = body;
    if (state !== 'running' && state !== 'maintenance') {
      res.status(400).json({ success: false, error: "state must be 'running' or 'maintenance'" });
      return;
    }
    if (message !== undefined && typeof message !== 'string') {
      res.status(400).json({ success: false, error: 'message must be a string' });
      return;
    }
    if (typeof message === 'string' && message.length > MAINTENANCE_MESSAGE_MAX) {
      res.status(400).json({ success: false, error: `message must be at most ${MAINTENANCE_MESSAGE_MAX} characters` });
      return;
    }
    const before = readMaintenanceFile();
    const given = typeof message === 'string' && message.trim() !== '' ? message : null;
    // Leaving keeps the saved message, which a later refused database login shows.
    const text = given ?? (state === 'running' ? before.message : DEFAULT_MAINTENANCE_MESSAGE);
    try {
      writeMaintenanceFile(state, text);
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      console.error(`[Maintenance] The maintenance state could not be saved: ${cause}`);
      res.status(500).json({ success: false, error: `The maintenance state could not be saved: ${cause}` });
      return;
    }
    if (state === 'maintenance') {
      const result = await botManager.enterMaintenance(text);
      res.json({ success: true, state, ...result });
      return;
    }
    if (before.state === 'running' && botManager.isServingNormally()) {
      res.json({ success: true, state, restarting: false, note: 'The bot is already running.' });
      return;
    }
    console.log('[Maintenance] Leaving maintenance: asking the bot process to save what it holds and restart');
    const result = await botManager.leaveMaintenance();
    res.json({ success: true, state, ...result });
  });

  return router;
}
