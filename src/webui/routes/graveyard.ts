// Graveyard API - list retired guild namespaces and restore them. Listing is
// parent-local (file _graveyard scan plus the read-only postgres reader);
// restore runs in the bot process via the guild data write IPC.

import { Router, Request, Response } from 'express';
import { BotManager, ROUTE_TEXT } from '../botManager';
import { resolveDataBackend } from '../../utils/envLoader';
import { listGraveyardEntries, restoreNoAnswerEnding } from '../../bot/internalSetup/utils/dataManager';
import { readFileMarker, recognitionRefusal } from '../../bot/internalSetup/utils/dataBackends/recognitionGuard';
import { getWebuiDataReader, isDataBackendUnreachable } from '../utils/webuiDataReader';
import { hopFailure } from './hopFailure';
import { planGuildChange, remoteRestoreNoAnswerCause, sendGuildChange } from '../utils/guildRequests';

const NO_ANSWER_CAUSE: Record<string, string> = {
  timeout: 'the bot did not answer within 50 s',
  stopped: 'the bot process stopped before answering',
  failed: 'the request could not be handed to the bot',
};

const REPLACE_TEXT = 'replace must be true or false';
const N_READ_BOUND_MS = 5000;

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

/**
 * One guild's entries, newest first, by the full listing's store rule: the JSON entries while files are the live store,
 * the database's batches when the deployment routes postgres, both when both hold.
 */
async function guildGraveyardEntries(guildId: string, boundMs?: number): Promise<GraveyardEntry[]> {
  const live = readFileMarker()?.live ?? resolveDataBackend();
  const entries: GraveyardEntry[] = live === 'file' ? (await listGraveyardEntries(guildId)).map(e => ({ ...e, backend: 'file' as const })) : [];
  if (resolveDataBackend() === 'postgres') {
    for (const batch of await getWebuiDataReader().listGuildGraveyard(guildId, boundMs)) entries.push({ ...batch, backend: 'postgres' });
  }
  return entries.sort((a, b) => b.retiredAt - a.retiredAt);
}

/** The newest retiredAt among the guild's entries (undefined: none), or the read's error after at most 5 s. */
async function newestEntry(guildId: string): Promise<{ n: number | undefined } | { error: string }> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<{ error: string }>(resolve => {
    timer = setTimeout(() => resolve({ error: `no answer within ${N_READ_BOUND_MS / 1000} s` }), N_READ_BOUND_MS);
  });
  const read = guildGraveyardEntries(guildId, N_READ_BOUND_MS).then(
    entries => ({ n: entries.length > 0 ? entries[0].retiredAt : undefined }),
    error => ({ error: error instanceof Error ? error.message : String(error) }),
  );
  try {
    return await Promise.race([read, late]);
  } finally {
    clearTimeout(timer);
  }
}

export function createGraveyardRoutes(botManager: BotManager): Router {
  const router = Router();

  /**
   * GET /api/data/graveyard
   * All restorable entries: the _graveyard dirs when files are the live
   * store, and the tombstone batches when the deployment routes postgres.
   * ?guildId= lists that guild's entries only, through its own bounded read.
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const refusal = recognitionRefusal();
      if (refusal) {
        res.status(503).json({ success: false, error: `The graveyard is not served: ${refusal}.` });
        return;
      }
      const guildId = req.query?.guildId;
      if (guildId !== undefined) {
        if (typeof guildId !== 'string' || !/^\d+$/.test(guildId)) {
          res.status(400).json({ success: false, error: 'Invalid guild ID format' });
          return;
        }
        let entries: GraveyardEntry[];
        try {
          entries = await guildGraveyardEntries(guildId);
        } catch (error) {
          if (!isDataBackendUnreachable(error)) throw error;
          res.status(503).json({ success: false, error: 'Data backend unreachable; retry shortly' });
          return;
        }
        res.json({ success: true, entries });
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
   * POST /api/data/graveyard/restore {guildId, retiredAt?, replace?}
   * Applied in the bot process; refusals (live data exists, no entry) map to 409.
   */
  router.post('/restore', async (req: Request, res: Response) => {
    try {
      const { guildId, retiredAt, replace } = (req.body || {}) as { guildId?: unknown; retiredAt?: unknown; replace?: unknown };
      if (typeof guildId !== 'string' || !/^\d+$/.test(guildId)) {
        res.status(400).json({ success: false, error: 'Invalid guild ID format' });
        return;
      }
      if (retiredAt !== undefined && (typeof retiredAt !== 'number' || !Number.isSafeInteger(retiredAt) || retiredAt < 0)) {
        res.status(400).json({ success: false, error: 'retiredAt must be a whole number of milliseconds' });
        return;
      }
      if (replace !== undefined && typeof replace !== 'boolean') {
        res.status(400).json({ success: false, error: REPLACE_TEXT });
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
      // N, for a no-answer text: an entry newer than N can only be one this request made.
      let n: number | undefined;
      if (plan.kind !== 'refuse') {
        const newest = await newestEntry(guildId);
        if ('error' in newest) {
          res.status(503).json({ success: false, error: `the graveyard list could not be read (${newest.error}); nothing was restored; try again in a moment` });
          return;
        }
        n = newest.n;
      }
      const reply = await sendGuildChange(botManager, plan, {
        guildId,
        module: '',
        filename: '',
        op: 'restore-graveyard',
        contentJson: JSON.stringify({ retiredAt, replace }),
      });
      // NB7 decision 9: another machine's answer is prefixed with its name; the sender's own answers are not.
      const servedBy = reply && typeof reply.servedBy === 'string' ? reply.servedBy : null;
      const on = (text: string) => (servedBy && !reply.sender ? `On ${servedBy}: ${text}` : text);
      const by = servedBy ? { servedBy } : {};
      // No answer from the bot: whatever the code, the restore may have landed.
      if (reply?.noAnswer) {
        const cause = servedBy ? remoteRestoreNoAnswerCause(reply.noAnswer, servedBy) : NO_ANSWER_CAUSE[reply.noAnswer as string] ?? NO_ANSWER_CAUSE.failed;
        const ending = restoreNoAnswerEnding(guildId, (retiredAt as number | undefined) ?? n, n, replace === true);
        res.status(503).json({ success: false, error: `can't confirm whether server ${guildId} was restored: ${cause}. ${ending}`, ...by });
        return;
      }
      if (reply?.ok) {
        res.json({
          success: true,
          retiredAt: reply.retiredAt,
          reason: reply.reason,
          ...(typeof reply.keptUntil === 'number' ? { keptUntil: reply.keptUntil } : {}),
          ...(typeof reply.copied === 'number' ? { copied: reply.copied } : {}),
          ...(reply.replaced !== undefined ? { replaced: reply.replaced } : {}),
          ...(typeof reply.moveUnconfirmed === 'string' ? { warning: moveUnconfirmedText(reply.moveUnconfirmed, 'restore') } : {}),
          ...by,
        });
        return;
      }
      const code = reply?.code;
      const error = reply?.error || 'restore failed';
      if (code === 'invalid') {
        const live = reply.refusal === 'live-data' && typeof reply.retiredAt === 'number' ? { refusal: 'live-data', retiredAt: reply.retiredAt } : {};
        res.status(409).json({ success: false, ...live, error: on(error), ...by });
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
