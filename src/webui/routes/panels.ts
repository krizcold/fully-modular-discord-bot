// src/webui/routes/panels.ts

import { Router, Request, Response } from 'express';
import { BotManager } from '../botManager';

export function createPanelRoutes(botManager: BotManager): Router {
  const router = Router();

  /**
   * GET /api/panels/list
   * Get list of available panels
   */
  router.get('/list', async (req: Request, res: Response) => {
    try {
      if (!botManager.isRunning()) {
        res.status(503).json({
          success: false,
          error: 'Bot is not running'
        });
        return;
      }

      const result = await botManager.getPanelList();

      if (result.success) {
        res.json({
          success: true,
          panels: result.panels
        });
      } else {
        res.status(500).json({
          success: false,
          error: result.error || 'Failed to get panel list'
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: `Failed to get panel list: ${errorMessage}`
      });
    }
  });

  /**
   * Validate panel ID format
   */
  function validatePanelId(panelId: string): boolean {
    return typeof panelId === 'string' &&
           /^[a-zA-Z0-9._-]+$/.test(panelId) &&
           panelId.length > 0 &&
           panelId.length < 100;
  }

  /**
   * Validate button/dropdown ID format (more permissive than panel ID)
   * Button IDs can contain forward slashes (for file paths) and other safe characters
   */
  function validateInteractionId(id: string): boolean {
    if (typeof id !== 'string' || id.length === 0 || id.length >= 200) {
      return false;
    }
    // Allow alphanumeric, underscore, hyphen, dot, forward slash, colon
    // Disallow dangerous characters that could be used for injection
    return /^[a-zA-Z0-9._\-/:]+$/.test(id);
  }

  /**
   * Validate user ID format (Discord snowflake IDs or web-ui-owner)
   */
  function validateUserId(userId: string): boolean {
    if (typeof userId !== 'string' || userId.length === 0) {
      return false;
    }

    // Allow 'web-ui-owner' for Web-UI authenticated users
    if (userId === 'web-ui-owner') {
      return true;
    }

    // Allow Discord snowflake IDs (17-19 digit numbers)
    return /^[0-9]+$/.test(userId) &&
           userId.length >= 17 &&
           userId.length <= 19;
  }

  /**
   * POST /api/panels/execute
   * Execute a panel and get its initial state
   */
  router.post('/execute', async (req: Request, res: Response) => {
    try {
      const { panelId, userId, guildId, channelId } = req.body;

      if (!panelId || !validatePanelId(panelId)) {
        res.status(400).json({
          success: false,
          error: 'Invalid panel ID format'
        });
        return;
      }

      if (!userId || !validateUserId(userId)) {
        res.status(400).json({
          success: false,
          error: 'Invalid user ID format'
        });
        return;
      }

      // Validate channelId if provided (Discord snowflake format)
      if (channelId && !/^[0-9]{17,19}$/.test(channelId)) {
        res.status(400).json({
          success: false,
          error: 'Invalid channel ID format'
        });
        return;
      }

      if (!botManager.isRunning()) {
        res.status(503).json({
          success: false,
          error: 'Bot is not running'
        });
        return;
      }

      const result = await botManager.executePanel(panelId, userId, guildId || null, channelId || null);

      if (result.success) {
        res.json({
          success: true,
          panel: result.data
        });
      } else {
        res.status(500).json({
          success: false,
          error: result.error || 'Failed to execute panel'
        });
      }
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
      const { panelId, buttonId, userId, guildId, channelId } = req.body;

      if (!panelId || !validatePanelId(panelId)) {
        res.status(400).json({
          success: false,
          error: 'Invalid panel ID format'
        });
        return;
      }

      if (!buttonId || !validateInteractionId(buttonId)) {
        res.status(400).json({
          success: false,
          error: 'Invalid button ID format'
        });
        return;
      }

      if (!userId || !validateUserId(userId)) {
        res.status(400).json({
          success: false,
          error: 'Invalid user ID format'
        });
        return;
      }

      // Validate channelId if provided (Discord snowflake format)
      if (channelId && !/^[0-9]{17,19}$/.test(channelId)) {
        res.status(400).json({
          success: false,
          error: 'Invalid channel ID format'
        });
        return;
      }

      if (!botManager.isRunning()) {
        res.status(503).json({
          success: false,
          error: 'Bot is not running'
        });
        return;
      }

      const result = await botManager.handlePanelButton(panelId, buttonId, userId, guildId || null, channelId || null);

      if (result.success) {
        res.json({
          success: true,
          panel: result.data
        });
      } else {
        res.status(500).json({
          success: false,
          error: result.error || 'Failed to handle button'
        });
      }
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
      const { panelId, values, userId, guildId, dropdownId, channelId } = req.body;

      if (!panelId || !validatePanelId(panelId)) {
        res.status(400).json({
          success: false,
          error: 'Invalid panel ID format'
        });
        return;
      }

      if (!values || !Array.isArray(values)) {
        res.status(400).json({
          success: false,
          error: 'Values array is required'
        });
        return;
      }

      // Validate dropdown values (array of strings with reasonable length)
      if (values.length > 25 || !values.every(v => typeof v === 'string' && v.length < 100)) {
        res.status(400).json({
          success: false,
          error: 'Invalid values format - max 25 items, each under 100 characters'
        });
        return;
      }

      if (!userId || !validateUserId(userId)) {
        res.status(400).json({
          success: false,
          error: 'Invalid user ID format'
        });
        return;
      }

      // Validate channelId if provided (Discord snowflake format)
      if (channelId && !/^[0-9]{17,19}$/.test(channelId)) {
        res.status(400).json({
          success: false,
          error: 'Invalid channel ID format'
        });
        return;
      }

      if (!botManager.isRunning()) {
        res.status(503).json({
          success: false,
          error: 'Bot is not running'
        });
        return;
      }

      const result = await botManager.handlePanelDropdown(panelId, values, userId, guildId || null, dropdownId, channelId || null);

      if (result.success) {
        res.json({
          success: true,
          panel: result.data
        });
      } else {
        res.status(500).json({
          success: false,
          error: result.error || 'Failed to handle dropdown'
        });
      }
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
      const { panelId, modalId, fields, userId, guildId, channelId } = req.body;

      if (!panelId || !validatePanelId(panelId)) {
        res.status(400).json({
          success: false,
          error: 'Invalid panel ID format'
        });
        return;
      }

      if (!modalId || !validateInteractionId(modalId)) { // modalId can have file paths
        res.status(400).json({
          success: false,
          error: 'Invalid modal ID format'
        });
        return;
      }

      if (!fields || typeof fields !== 'object') {
        res.status(400).json({
          success: false,
          error: 'Fields object is required'
        });
        return;
      }

      if (!userId || !validateUserId(userId)) {
        res.status(400).json({
          success: false,
          error: 'Invalid user ID format'
        });
        return;
      }

      // Validate channelId if provided (Discord snowflake format)
      if (channelId && !/^[0-9]{17,19}$/.test(channelId)) {
        res.status(400).json({
          success: false,
          error: 'Invalid channel ID format'
        });
        return;
      }

      if (!botManager.isRunning()) {
        res.status(503).json({
          success: false,
          error: 'Bot is not running'
        });
        return;
      }

      const result = await botManager.handlePanelModal(panelId, modalId, fields, userId, guildId || null, channelId || null);

      if (result.success) {
        res.json({
          success: true,
          panel: result.data
        });
      } else {
        res.status(500).json({
          success: false,
          error: result.error || 'Failed to handle modal'
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: `Failed to handle modal: ${errorMessage}`
      });
    }
  });

  /**
   * GET /api/panels/roles
   * Get list of assignable roles for a guild (for role select menus)
   */
  router.get('/roles', async (req: Request, res: Response) => {
    try {
      const guildId = req.query.guildId as string;

      if (!guildId || !validatePanelId(guildId)) {
        res.status(400).json({
          success: false,
          error: 'Invalid guild ID format'
        });
        return;
      }

      if (!botManager.isRunning()) {
        res.status(503).json({
          success: false,
          error: 'Bot is not running'
        });
        return;
      }

      const result = await botManager.getGuildRoles(guildId);

      if (result.success) {
        res.json({
          success: true,
          roles: result.roles
        });
      } else {
        res.status(500).json({
          success: false,
          error: result.error || 'Failed to get roles'
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: `Failed to get roles: ${errorMessage}`
      });
    }
  });

  /**
   * GET /api/panels/channels
   * Get list of text channels for a guild (for channel-required panels)
   */
  router.get('/channels', async (req: Request, res: Response) => {
    try {
      const guildId = req.query.guildId as string;

      if (!guildId || !validatePanelId(guildId)) { // Reuse validation - guild IDs are numeric like panel IDs
        res.status(400).json({
          success: false,
          error: 'Invalid guild ID format'
        });
        return;
      }

      if (!botManager.isRunning()) {
        res.status(503).json({
          success: false,
          error: 'Bot is not running'
        });
        return;
      }

      const result = await botManager.getGuildChannels(guildId);

      if (result.success) {
        res.json({
          success: true,
          channels: result.channels
        });
      } else {
        res.status(500).json({
          success: false,
          error: result.error || 'Failed to get channels'
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: `Failed to get channels: ${errorMessage}`
      });
    }
  });

  return router;
}
