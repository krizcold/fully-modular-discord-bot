// src/webui/routes/commands.ts
//
// Console-exclusive synthetic command execution (`smdb cmd invoke`). Forwards to
// the bot child, which builds a ConsoleInteraction and runs it through the real
// slash-command dispatcher; replies are captured, nothing is sent to Discord.

import { Router, Request, Response } from 'express';
import { BotManager } from '../botManager';
import { validGuildId } from '../../bot/internalSetup/utils/panelRequestShape';
import { sendPanelOp } from './panelRequestRoute';

const SNOWFLAKE = /^[0-9]{5,20}$/;
const COMMAND_NAME = /^[\w-]{1,64}$/;

export function createCommandRoutes(botManager: BotManager): Router {
  const router = Router();

  /**
   * POST /api/commands/invoke
   * Body: { command, guildId?, channelId?, userId?, options?, force? }
   */
  router.post('/invoke', async (req: Request, res: Response) => {
    try {
      const { command, guildId, channelId, userId, options, force } = req.body || {};

      if (typeof command !== 'string' || !COMMAND_NAME.test(command)) {
        res.status(400).json({ success: false, error: 'Invalid command name' });
        return;
      }
      for (const [label, id] of [['guildId', guildId], ['channelId', channelId], ['userId', userId]] as const) {
        if (id !== undefined && id !== null && !SNOWFLAKE.test(String(id))) {
          res.status(400).json({ success: false, error: `Invalid ${label} format` });
          return;
        }
      }
      if (options !== undefined && (typeof options !== 'object' || options === null || Array.isArray(options))) {
        res.status(400).json({ success: false, error: 'options must be an object' });
        return;
      }

      // NB15 decisions 9 and 12: a guild's invoke goes to the machine that runs it; 200 for success, 400 when the
      // command did not start, 500 when it ran and failed, 503 for an answer the bot never gave.
      const guild = guildId === undefined || guildId === null ? null : String(guildId);
      if (guild !== null && !validGuildId(guild)) {
        res.status(400).json({ success: false, error: 'Invalid guild ID format' });
        return;
      }
      await sendPanelOp(botManager, res, {
        op: 'command:invoke', guildId: guild, audience: 'owner', userId: userId ?? null,
        payload: { command, channelId: channelId ?? null, userId: userId ?? null, options: options ?? {}, force: Boolean(force) },
        success: reply => reply, failureText: 'The command failed',
        failureStatus: reply => (reply.ran === false || reply.maintenance === true ? 400 : 500),
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  return router;
}
