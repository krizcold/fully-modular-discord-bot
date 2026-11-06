// Graveyard API - list retired guild namespaces and restore them. Listing is
// parent-local (file _graveyard scan plus the read-only postgres reader);
// restore runs in the bot process via the guild data write IPC.

import { Router, Request, Response } from 'express';
import { BotManager, ROUTE_TEXT } from '../botManager';
import { resolveDataBackend } from '../../utils/envLoader';
import { listGraveyardEntries } from '../../bot/internalSetup/utils/dataManager';
import { readFileMarker, recognitionRefusal } from '../../bot/internalSetup/utils/dataBackends/recognitionGuard';
import { getWebuiDataReader, isDataBackendUnreachable } from '../utils/webuiDataReader';
import { hopFailure } from './hopFailure';
import { planGuildChange, remoteRestoreNoAnswerCause, sendGuildChange } from '../utils/guildRequests';

const NO_ANSWER_CAUSE: Record<string, string> = {
  timeout: 'the bot did not answer within 50 s',
  stopped: 'the bot process stopped before answering',
  failed: 'the request could not be handed to the bot',
};

export const RESTORE_MINUTE = "Within a minute, if it was restored, the server's data is back and its entry is gone from `smdb graveyard list`; if not, the entry is still listed, unless it had passed the graveyard's keep time and the graveyard sweep removed it, data and all.";

/** The warning of a restore or a delete whose folder move the disk did not confirm. */
export function moveUnconfirmedText(code: string, what: 'restore' | 'delete'): string {
  return `The disk did not confirm the move of this server's folder (${code}), so a power cut can undo the ${what}. Check the disk.`;
}

/** The web UI's own refusal of a restore or a server's data delete while the bot starts or stops: hopFailure's words are a save's. */
export function graveyardRouteRefusal(code: unknown, detail: string | undefined, what: 'restore' | 'guild-delete'): string | null {
  const nothing = what === 'restore' ? 'nothing was restored' : 'nothing was removed';
  const again = what === 'restore' ? 'restore again' : 'delete again';
  if (code === 'stopping') {
    if (detail === ROUTE_TEXT.exiting) return `the web panel is shutting down; ${nothing}; try again once it is back`;
    if (detail === ROUTE_TEXT.restarting) return `the bot is restarting; ${nothing}; try again once the bot has started`;
    return `the bot is stopping; ${nothing}; ${again} once the bot is started`;
  }
  if (code === 'starting') {
    if (!detail || detail === ROUTE_TEXT.starting) return `the bot is starting; ${nothing}; try again once the bot has started`;
    return detail.replace('nothing was saved', nothing);
  }
  return null;
}

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
   * All restorable entries: the _graveyard dirs when files are the live
   * store, and the tombstone batches when the deployment routes postgres.
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const refusal = recognitionRefusal();
      if (refusal) {
        res.status(503).json({ success: false, error: `The graveyard is not served: ${refusal}.` });
        return;
      }
      // A move to Postgres leaves /data/_graveyard in place; it is listed only while files are the live store.
      const live = readFileMarker()?.live ?? resolveDataBackend();
      const entries: GraveyardEntry[] = live === 'file' ? (await listGraveyardEntries()).map(e => ({ ...e, backend: 'file' as const })) : [];
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
      if (retiredAt !== undefined && (typeof retiredAt !== 'number' || !Number.isSafeInteger(retiredAt) || retiredAt < 0)) {
        res.status(400).json({ success: false, error: 'retiredAt must be a whole number of milliseconds' });
        return;
      }
      const refusal = recognitionRefusal();
      if (refusal) {
        res.status(503).json({ success: false, error: `Nothing was restored: ${refusal}.` });
        return;
      }
      const plan = await planGuildChange(botManager, guildId, 'restore-graveyard');
      if (plan.kind === 'refuse' && plan.reply?.code === 'invalid') {
        res.status(400).json({ success: false, error: plan.reply.error });
        return;
      }
      const reply = await sendGuildChange(botManager, plan, {
        guildId,
        module: '',
        filename: '',
        op: 'restore-graveyard',
        contentJson: JSON.stringify({ retiredAt }),
      });
      // NB7 decision 9: another machine's answer is prefixed with its name; the sender's own answers are not.
      const servedBy = reply && typeof reply.servedBy === 'string' ? reply.servedBy : null;
      const on = (text: string) => (servedBy && !reply.sender ? `On ${servedBy}: ${text}` : text);
      const by = servedBy ? { servedBy } : {};
      // No answer from the bot: whatever the code, the restore may have landed.
      if (reply?.noAnswer) {
        const cause = servedBy ? remoteRestoreNoAnswerCause(reply.noAnswer, servedBy) : NO_ANSWER_CAUSE[reply.noAnswer as string] ?? NO_ANSWER_CAUSE.failed;
        res.status(503).json({ success: false, error: `can't confirm whether server ${guildId} was restored: ${cause}. ${RESTORE_MINUTE}`, ...by });
        return;
      }
      if (reply?.ok) {
        res.json({
          success: true,
          retiredAt: reply.retiredAt,
          reason: reply.reason,
          ...(typeof reply.moved === 'number' ? { moved: reply.moved } : {}),
          ...(typeof reply.moveUnconfirmed === 'string' ? { warning: moveUnconfirmedText(reply.moveUnconfirmed, 'restore') } : {}),
          ...by,
        });
        return;
      }
      const code = reply?.code;
      const error = reply?.error || 'restore failed';
      if (code === 'invalid') {
        res.status(409).json({ success: false, error: on(error), ...by });
        return;
      }
      // The restore's own words: hopFailure's speak of a change.
      if (code === 'not-owner') {
        res.status(503).json({ success: false, error: on("another bot process now serves this server's data; nothing was restored"), ...by });
        return;
      }
      if (code === 'io-error') {
        res.status(500).json({ success: false, error: on(error), ...by });
        return;
      }
      const refused = graveyardRouteRefusal(code, reply?.error, 'restore');
      if (refused) {
        res.status(503).json({ success: false, error: on(refused), ...by });
        return;
      }
      const failure = hopFailure(code, reply?.error);
      const named = code === 'no-holder' || code === 'not-taken' ? { code } : {};
      if (failure) {
        res.status(failure.status).json({ success: false, ...named, error: on(failure.error), ...by });
      } else {
        res.status(500).json({ success: false, error: on(error), ...by });
      }
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  return router;
}
