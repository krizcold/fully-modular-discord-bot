// Manager-facing surface. It takes the per-instance token both sides already hold;
// the browser's routes are authenticated at the deployment boundary instead.

import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';

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

export function createManagedRoutes(): Router {
  const router = Router();
  router.use(requireManagerToken);
  return router;
}
