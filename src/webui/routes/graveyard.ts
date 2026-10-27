// Graveyard API - list retired guild namespaces and restore them. Listing is
// parent-local (file _graveyard scan plus the read-only postgres reader);
// restore runs in the bot process via the guild data write IPC.

import { Router, Request, Response } from 'express';
import { BotManager } from '../botManager';
import { resolveDataBackend } from '../../utils/envLoader';
import { listGraveyardEntries } from '../../bot/internalSetup/utils/dataManager';
import { recognitionRefusal } from '../../bot/internalSetup/utils/dataBackends/recognitionGuard';
import { getWebuiDataReader, isDataBackendUnreachable } from '../utils/webuiDataReader';
import { hopFailure } from './hopFailure';

interface GraveyardEntry {
  guildId: string;
  retiredAt: number;
  reason: string;
  rows?: number;
  backend: 'file' | 'postgres';
}

export function createGraveyardRoutes(botManager: BotManager): Router {
  const router = Router();

  /**
   * GET /api/data/graveyard
   * All restorable entries: file-mode _graveyard dirs plus, when the
   * deployment routes postgres, the tombstone batches.
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const refusal = recognitionRefusal();
      if (refusal) {
        res.status(503).json({ success: false, error: `The graveyard is not served: ${refusal}.` });
        return;
      }
      const entries: GraveyardEntry[] = (await listGraveyardEntries()).map(e => ({ ...e, backend: 'file' as const }));
      if (resolveDataBackend() === 'postgres') {
        try {
          for (const batch of await getWebuiDataReader().listGraveyard()) {
            entries.push({ ...batch, backend: 'postgres' });
          }
        } catch (error) {
          if (!isDataBackendUnreachable(error)) throw error;
          res.status(503).json({ success: false, error: 'Data backend unreachable; retry shortly' });
          return;
        }
      }
      entries.sort((a, b) => b.retiredAt - a.retiredAt);
      res.json({ success: true, entries });
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  /**
   * POST /api/data/graveyard/restore {guildId, retiredAt?}
   * Applied in the bot process; refusals (live data exists, no entry) map to 409.
   */
  router.post('/restore', async (req: Request, res: Response) => {
    try {
      const { guildId, retiredAt } = (req.body || {}) as { guildId?: unknown; retiredAt?: unknown };
      if (typeof guildId !== 'string' || !/^\d+$/.test(guildId)) {
        res.status(400).json({ success: false, error: 'Invalid guild ID format' });
        return;
      }
      if (retiredAt !== undefined && (typeof retiredAt !== 'number' || !Number.isFinite(retiredAt))) {
        res.status(400).json({ success: false, error: 'retiredAt must be a number (ms)' });
        return;
      }
      const refusal = recognitionRefusal();
      if (refusal) {
        res.status(503).json({ success: false, error: `Nothing was restored: ${refusal}.` });
        return;
      }
      const reply = await botManager.writeGuildData({
        guildId,
        module: '',
        filename: '',
        op: 'restore-graveyard',
        contentJson: JSON.stringify({ retiredAt }),
      });
      if (reply?.ok) {
        res.json({ success: true });
        return;
      }
      const code = reply?.code;
      const error = reply?.error || 'restore failed';
      const failure = code === 'invalid' ? null : hopFailure(code, reply?.error);
      if (code === 'invalid') {
        res.status(409).json({ success: false, error });
      } else if (failure) {
        res.status(failure.status).json({ success: false, error: failure.error });
      } else {
        res.status(500).json({ success: false, error });
      }
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  return router;
}
