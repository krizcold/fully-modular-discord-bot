// src/webui/routes/panels.ts

import { Router, Request, Response } from 'express';
import { BotManager } from '../botManager';
import { resolveDataBackend } from '../../utils/envLoader';
import {
  validDropdownValues,
  validGuildId,
  validInteractionId,
  validPanelId,
  validUserId,
} from '../../bot/internalSetup/utils/panelRequestShape';
import { sendPanelOp, watcherFor } from './panelRequestRoute';

export function createPanelRoutes(botManager: BotManager): Router {
  const router = Router();

  const badRequest = (res: Response, error: string) => res.status(400).json({ success: false, error });

  /** A guild id as decision 9 checks it; null for the System context. */
  function guildOf(value: unknown): { guildId: string | null } | { error: string } {
    if (value === undefined || value === null || value === '' || value === 'null') return { guildId: null };
    return validGuildId(value) ? { guildId: value } : { error: 'Invalid guild ID format' };
  }

  /**
   * GET /api/panels/list
   * Get list of available panels; with a guildId, the panels of that server's context
   */
  router.get('/list', async (req: Request, res: Response) => {
    try {
      const guild = guildOf(req.query.guildId);
      if ('error' in guild) {
        badRequest(res, guild.error);
        return;
      }
      await sendPanelOp(botManager, res, {
        op: 'panel:list', guildId: guild.guildId, payload: {}, audience: 'owner', userId: 'web-ui-owner',
        success: reply => ({ panels: reply.panels }), failureText: 'Failed to get panel list',
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: `Failed to get panel list: ${errorMessage}`
      });
    }
  });

  /** The checks every panel action route makes: the panel, the user, the channel and the guild. */
  function actionFields(req: Request, res: Response): { panelId: string; userId: string; guildId: string | null; channelId: string | null } | null {
    const { panelId, userId, guildId, channelId } = req.body;
    if (!panelId || !validPanelId(panelId)) {
      badRequest(res, 'Invalid panel ID format');
      return null;
    }
    if (!userId || !validUserId(userId)) {
      badRequest(res, 'Invalid user ID format');
      return null;
    }
    if (channelId && !/^[0-9]{17,19}$/.test(channelId)) {
      badRequest(res, 'Invalid channel ID format');
      return null;
    }
    const guild = guildOf(guildId);
    if ('error' in guild) {
      badRequest(res, guild.error);
      return null;
    }
    return { panelId, userId, guildId: guild.guildId, channelId: channelId || null };
  }

  const panelSuccess = (reply: Record<string, any>) => ({ panel: reply.data ?? null });

  /**
   * POST /api/panels/execute
   * Execute a panel and get its initial state
   */
  router.post('/execute', async (req: Request, res: Response) => {
    try {
      const fields = actionFields(req, res);
      if (!fields) return;
      await sendPanelOp(botManager, res, {
        op: 'panel:execute', guildId: fields.guildId, audience: 'owner', userId: fields.userId,
        payload: { panelId: fields.panelId, userId: fields.userId, channelId: fields.channelId },
        success: panelSuccess, failureText: 'Failed to execute panel',
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: `Failed to execute panel: ${errorMessage}`
      });
    }
  });

  /**
   * POST /api/panels/button
   * Handle button interaction in a panel
   */
  router.post('/button', async (req: Request, res: Response) => {
    try {
      const { panelId, buttonId } = req.body;
      if (!panelId || !validPanelId(panelId)) {
        badRequest(res, 'Invalid panel ID format');
        return;
      }
      if (!buttonId || !validInteractionId(buttonId)) {
        badRequest(res, 'Invalid button ID format');
        return;
      }
      const fields = actionFields(req, res);
      if (!fields) return;
      await sendPanelOp(botManager, res, {
        op: 'panel:button', guildId: fields.guildId, audience: 'owner', userId: fields.userId,
        payload: { panelId: fields.panelId, buttonId, userId: fields.userId, channelId: fields.channelId },
        success: panelSuccess, failureText: 'Failed to handle button',
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: `Failed to handle button: ${errorMessage}`
      });
    }
  });

  /**
   * POST /api/panels/dropdown
   * Handle dropdown interaction in a panel
   */
  router.post('/dropdown', async (req: Request, res: Response) => {
    try {
      const { panelId, values, dropdownId } = req.body;
      if (!panelId || !validPanelId(panelId)) {
        badRequest(res, 'Invalid panel ID format');
        return;
      }
      if (!values || !Array.isArray(values)) {
        badRequest(res, 'Values array is required');
        return;
      }
      if (!validDropdownValues(values)) {
        badRequest(res, 'Invalid values format - max 25 items, each under 100 characters');
        return;
      }
      const fields = actionFields(req, res);
      if (!fields) return;
      await sendPanelOp(botManager, res, {
        op: 'panel:dropdown', guildId: fields.guildId, audience: 'owner', userId: fields.userId,
        payload: { panelId: fields.panelId, values, userId: fields.userId, dropdownId, channelId: fields.channelId },
        success: panelSuccess, failureText: 'Failed to handle dropdown',
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: `Failed to handle dropdown: ${errorMessage}`
      });
    }
  });

  /**
   * POST /api/panels/modal
   * Handle modal submission in a panel
   */
  router.post('/modal', async (req: Request, res: Response) => {
    try {
      const { panelId, modalId, fields: modalFields } = req.body;
      if (!panelId || !validPanelId(panelId)) {
        badRequest(res, 'Invalid panel ID format');
        return;
      }
      if (!modalId || !validInteractionId(modalId)) {
        badRequest(res, 'Invalid modal ID format');
        return;
      }
      if (!modalFields || typeof modalFields !== 'object') {
        badRequest(res, 'Fields object is required');
        return;
      }
      const fields = actionFields(req, res);
      if (!fields) return;
      await sendPanelOp(botManager, res, {
        op: 'panel:modal', guildId: fields.guildId, audience: 'owner', userId: fields.userId,
        payload: { panelId: fields.panelId, modalId, fields: modalFields, userId: fields.userId, channelId: fields.channelId },
        success: panelSuccess, failureText: 'Failed to handle modal',
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: `Failed to handle modal: ${errorMessage}`
      });
    }
  });

  /** GET /roles and /channels: a server's lists for a panel's selects. */
  function listRoute(op: 'guild:roles' | 'guild:channels', field: 'roles' | 'channels', failureText: string) {
    return async (req: Request, res: Response) => {
      try {
        const guildId = req.query.guildId;
        if (!validGuildId(guildId)) {
          badRequest(res, 'Invalid guild ID format');
          return;
        }
        await sendPanelOp(botManager, res, {
          op, guildId, payload: {}, audience: 'owner', userId: 'web-ui-owner',
          success: reply => ({ [field]: reply[field] }), failureText,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        res.status(500).json({ success: false, error: `${failureText}: ${errorMessage}` });
      }
    };
  }

  /**
   * GET /api/panels/roles
   * Get list of assignable roles for a guild (for role select menus)
   */
  router.get('/roles', listRoute('guild:roles', 'roles', 'Failed to get roles'));

  /**
   * GET /api/panels/channels
   * Get list of text channels for a guild (for channel-required panels)
   */
  router.get('/channels', listRoute('guild:channels', 'channels', 'Failed to get channels'));

  /**
   * POST /api/panels/watch
   * Keeps a panel another machine runs up to date (NB15 decision 15): one call registers or renews the watch.
   */
  router.post('/watch', async (req: Request, res: Response) => {
    try {
      const { guildId, panelId, userId, servedBy } = req.body ?? {};
      if (!validGuildId(guildId)) {
        badRequest(res, 'Invalid guild ID format');
        return;
      }
      if (!panelId || !validPanelId(panelId)) {
        badRequest(res, 'Invalid panel ID format');
        return;
      }
      if (userId !== undefined && !validUserId(userId)) {
        badRequest(res, 'Invalid user ID format');
        return;
      }
      if (resolveDataBackend() !== 'postgres') {
        badRequest(res, 'Only a database bot runs panels on other machines');
        return;
      }
      const name = typeof servedBy === 'string' && servedBy.length > 0 && servedBy.length <= 200 ? servedBy : 'the machine that runs it';
      const status = watcherFor(botManager).watch(guildId, panelId, userId || 'web-ui-owner', name);
      res.json({ success: true, ...status });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ success: false, error: `Failed to watch the panel: ${errorMessage}` });
    }
  });

  return router;
}
