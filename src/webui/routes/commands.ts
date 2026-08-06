// src/webui/routes/commands.ts
//
// Console-exclusive synthetic command execution (`smdb cmd invoke`). Forwards to
// the bot child, which builds a ConsoleInteraction and runs it through the real
// slash-command dispatcher; replies are captured, nothing is sent to Discord.

import { Router, Request, Response } from 'express';
import { BotManager } from '../botManager';

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

      if (!botManager.isRunning()) {
        res.status(503).json({ success: false, error: 'Bot is not running' });
        return;
      }

      const result = await botManager.invokeCommand({
        command,
        guildId: guildId ?? null,
        channelId: channelId ?? null,
        userId: userId ?? null,
        options: options ?? {},
        force: Boolean(force),
      });

      res.status(result?.success ? 200 : 400).json(result);
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  return router;
}
