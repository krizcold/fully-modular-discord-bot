// The send and answer of a panel action, a console invoke or a read a panel needs (NB15 decisions 9 and 12), shared by
// the owner's routes, the member's routes and the console: the plan, the local send or the request route, the status.

import type { Response } from 'express';
import type { BotManager } from '../botManager';
import { actorFor, planGuildRequest, runGuildRequest, type Audience, type PanelAnswer } from '../utils/guildRequests';
import { actionViewVersion, getPanelLiveWatch, peekPanelLiveWatch, realWatchClient, realWatchEntry, type PanelLiveWatch } from '../utils/panelLiveWatch';
import type { PanelRequestOp } from '../../bot/internalSetup/utils/panelRequestShape';
import { VIEW_CHANGE_OPS } from '../../bot/internalSetup/fleet/panelLive';

export interface PanelOpSpec {
  op: PanelRequestOp;
  /** null: the System context, which stays on this machine (decision 5). */
  guildId: string | null;
  /** The IPC data, without guildId and actor. */
  payload: Record<string, unknown>;
  audience: Audience;
  /** The user the route checked: a snowflake, or 'web-ui-owner'. */
  userId: string | null;
  /** The route's own fields beside success: true. */
  success: (reply: Record<string, any>) => Record<string, unknown>;
  failureText: string;
  /** The route's status for a failed reply with no status of its own; 500 when absent. */
  failureStatus?: (reply: Record<string, any>) => number;
}

const KEPT_FIELDS = ['code', 'servedBy', 'noAnswer', 'ran', 'truth', 'partial', 'pending', 'note', 'oversize', 'capturedOmitted'];

/** The owner's live watcher, built at the first use (decision 15). */
export function watcherFor(botManager: BotManager): PanelLiveWatch {
  return getPanelLiveWatch(() => ({
    fetch: async (guildId, panelId, userId, have) => {
      const plan = await planGuildRequest(botManager, guildId, 'panel:live', 'owner');
      return runGuildRequest(plan, { panelId, ...have, actor: actorFor('owner', userId) }, () => botManager.panelIpc('panel:live', { guildId, panelId, ...have }));
    },
    emitUpdate: data => botManager.emitPanelUpdate(data),
    emitStatus: data => botManager.emitPanelLiveStatus(data),
    entry: realWatchEntry,
    makeClient: realWatchClient,
  }));
}

/** Sends the op by the route decision 9 picks and answers it. */
export async function runPanelOp(botManager: BotManager, spec: PanelOpSpec): Promise<PanelAnswer | null> {
  const local = () => botManager.panelIpc(spec.op, { ...spec.payload, guildId: spec.guildId });
  if (spec.guildId === null) {
    if (!botManager.isRunning()) return null;
    const plan = { kind: 'json' as const, op: spec.op, guildId: '', audience: spec.audience, deadline: 0 };
    return runGuildRequest(plan, spec.payload, local);
  }
  const plan = await planGuildRequest(botManager, spec.guildId, spec.op, spec.audience);
  if (plan.kind === 'json' && !botManager.isRunning()) return null;
  return runGuildRequest(plan, { ...spec.payload, actor: actorFor(spec.audience, spec.userId) }, local);
}

/** The HTTP answer of an op: the route's success shape, or the failure with its code, its status and its words. */
export function respondPanelOp(res: Response, spec: PanelOpSpec, answer: PanelAnswer | null): void {
  if (answer === null) {
    res.status(503).json({ success: false, error: 'Bot is not running' });
    return;
  }
  const reply = answer.reply ?? {};
  const status = answer.status ?? (reply.success === true ? 200 : spec.failureStatus?.(reply) ?? 500);
  const kept: Record<string, unknown> = {};
  for (const field of KEPT_FIELDS) if (reply[field] !== undefined) kept[field] = reply[field];
  if (status < 300 && reply.success === true) {
    res.status(status).json({ success: true, ...spec.success(reply), ...kept });
    return;
  }
  res.status(status).json({ ...(spec.op === 'command:invoke' ? reply : {}), success: false, error: reply.error || spec.failureText, ...kept });
}

/**
 * runPanelOp, then respondPanelOp. An owner's button, select menu or modal submit answered by another machine sends
 * its view to the other tabs watching the pair (opening a panel sends nothing to them); the pair's version is raised
 * once the response finished, or after an aborted one only when a tab got the view. When a state was applied to the
 * pair after the op was sent, its view goes to no other tab and the pair is fetched again for every tab.
 */
export async function sendPanelOp(botManager: BotManager, res: Response, spec: PanelOpSpec): Promise<void> {
  const sentAt = peekPanelLiveWatch()?.applyMark() ?? 0;
  const answer = await runPanelOp(botManager, spec);
  const reply = answer?.reply;
  respondPanelOp(res, spec, answer);
  const guildId = spec.guildId;
  const panelId = spec.payload.panelId;
  if (spec.audience !== 'owner' || !guildId || reply?.success !== true || typeof reply.servedBy !== 'string' || typeof panelId !== 'string') return;
  if (reply.liveSince === undefined) return;
  const watcher = watcherFor(botManager);
  const holder = answer?.holderProcess;
  const changes = VIEW_CHANGE_OPS.includes(spec.op);
  const arrival = changes ? watcher.actionArrived(guildId, panelId, holder, reply, sentAt) : null;
  const sent = arrival?.sent ?? 0;
  const version = actionViewVersion(reply);
  let noted = false;
  const note = (pageHasIt: boolean) => {
    if (noted) return;
    noted = true;
    const shown = pageHasIt || sent > 0 ? version : 0;
    if (arrival) watcher.noteAnswer(guildId, panelId, holder, reply.liveSince, shown, arrival);
    else watcher.noteOpened(guildId, panelId, holder, reply.liveSince, shown, sentAt);
  };
  if (res.writableFinished) {
    note(true);
    return;
  }
  res.once('finish', () => note(true));
  res.once('close', () => note(res.writableFinished));
}
