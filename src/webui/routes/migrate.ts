// The panel's data migration route, behind `smdb data migrate --to postgres|file`. A managed bot is migrated by its
// manager through /api/managed/migrate instead; the destination is DATA_BACKEND_URL.

import { randomBytes } from 'crypto';
import { Router, Request, Response } from 'express';
import type { BotManager } from '../botManager';
import { MigrationService } from '../../bot/internalSetup/utils/dataMigration';

export function createMigrateRoutes(botManager: BotManager, migration: MigrationService = new MigrationService(botManager)): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response) => {
    if ((process.env.BOT_MANAGER_UPDATE_TOKEN || '').trim() !== '') {
      res.status(409).json({ success: false, error: "This bot is managed; use the manager's Migrate control" });
      return;
    }
    const to = (req.body && typeof req.body === 'object' ? req.body : {}).to;
    const answer = await migration.post({ jobId: `smdb-${randomBytes(8).toString('hex')}`, to });
    res.status(answer.status).json(answer.body);
  });

  router.get('/', (_req: Request, res: Response) => {
    const answer = migration.status();
    res.status(answer.status).json(answer.body);
  });

  return router;
}
