// Guild Panel Routes - Panel API for guild-specific Web-UI with OAuth

import { Router, Request, Response } from 'express';
import { BotManager } from '../botManager';
import { requireOAuth, requireGuildAccess } from '../auth/oauthMiddleware';
import { DiscordUser } from '../auth/oauthConfig';
import { refreshUserGuilds } from '../auth/guildPermissionRefresher';
import { hasGuildAccess as permHasGuildAccess } from '../auth/permissionChecker';

// Dev-user check cache: avoids IPC to bot on every request.
// Keyed by user id; 5-minute TTL keeps permission changes relatively fresh.
const DEV_CHECK_TTL = 5 * 60 * 1000;
const devCheckCache = new Map<string, { isDev: boolean; ts: number }>();

async function cachedIsUserDev(botManager: BotManager, userId: string): Promise<boolean> {
  const cached = devCheckCache.get(userId);
  const now = Date.now();
  if (cached && now - cached.ts < DEV_CHECK_TTL) return cached.isDev;
  const result = await botManager.isUserDev(userId);
  if (result?.success) {
    const isDev = !!result.isDev;
    devCheckCache.set(userId, { isDev, ts: now });
    return isDev;
  }
  // On IPC failure, fall back to last known value (fail-closed if none)
  return cached?.isDev ?? false;
}

// Refresh user guilds AND persist the fresh user into the session via
// req.login() so subsequent requests see up-to-date guild/permissions data.
async function refreshAndSaveUser(req: Request, user: DiscordUser): Promise<DiscordUser> {
  const refreshedUser = await refreshUserGuilds(user);
  await new Promise<void>((resolve, reject) => {
    req.login(refreshedUser, (err) => err ? reject(err) : resolve());
  });
  return refreshedUser;
}

export function createGuildPanelRoutes(botManager: BotManager): Router {
  const router = Router();

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
   * Validate guild ID format (Discord snowflake)
   */
  function validateGuildId(guildId: string): boolean {
    return typeof guildId === 'string' &&
           /^[0-9]+$/.test(guildId) &&
           guildId.length >= 17 &&
           guildId.length <= 19;
  }

  /**
   * GET /guild/api/panels/list
   * Get list of available guild panels for a specific guild
   * Requires OAuth authentication
   * If guildId is null, returns system panels (requires dev access)
   */
  router.get('/list', requireOAuth, async (req: Request, res: Response) => {
    try {
      const guildId = req.query.guildId as string | null;
      const user = req.user as DiscordUser;

      // Check if user is accessing system panels (guildId is null or 'null' string)
      const isSystemPanels = guildId === null || guildId === 'null';

      if (isSystemPanels) {
        // System panels require dev access
        if (!await cachedIsUserDev(botManager, user.id)) {
          res.status(403).json({
            success: false,
            error: 'Access denied: System panels require developer access'
          });
          return;
        }
      } else {
        // Guild panels require valid guild ID
        if (!guildId || !validateGuildId(guildId)) {
          res.status(400).json({
            success: false,
            error: 'Valid guild ID is required'
          });
          return;
        }
      }

      if (!botManager.isRunning()) {
        res.status(503).json({
          success: false,
          error: 'Bot is not running'
        });
        return;
      }

      // Get all panels
      const result = await botManager.getPanelList();

      if (result.success) {
        // Filter panels based on context
        let filteredPanels;
        if (isSystemPanels) {
          // System panels - filter to system scope only
          filteredPanels = (result.panels || []).filter((p: any) => p.scope === 'system');
        } else {
          // Guild panels - filter to guild-scope only
          filteredPanels = (result.panels || []).filter((p: any) => p.scope === 'guild' || !p.scope);
        }

        res.json({
          success: true,
          panels: filteredPanels,
          guildId: isSystemPanels ? null : guildId
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
   * POST /guild/api/panels/execute
   * Execute a guild panel or system panel (requires dev for system)
   * Requires OAuth authentication and guild access (or dev access for system panels)
   */
  router.post('/execute', requireOAuth, async (req: Request, res: Response) => {
    try {
      const { panelId, guildId, channelId } = req.body;
      const user = req.user as DiscordUser;

      if (!panelId || !validatePanelId(panelId)) {
        res.status(400).json({
          success: false,
          error: 'Invalid panel ID format'
        });
        return;
      }

      // Check if this is a system panel request
      const isSystemPanel = guildId === null || guildId === 'null';

      if (isSystemPanel) {
        // System panels require dev access
        if (!await cachedIsUserDev(botManager, user.id)) {
          res.status(403).json({
            success: false,
            error: 'Access denied: System panels require developer access'
          });
          return;
        }
      } else {
        // Guild panels require valid guild ID and guild access
        if (!guildId || !validateGuildId(guildId)) {
          res.status(400).json({
            success: false,
            error: 'Invalid guild ID format'
          });
          return;
        }

        // Refresh user permissions from Discord API (with 5-min cache) and
        // persist the fresh user into the session.
        const refreshedUser = await refreshAndSaveUser(req, user);

        if (!permHasGuildAccess(refreshedUser, guildId)) {
          res.status(403).json({
            success: false,
            error: 'Access denied: You do not have administrator access to this guild'
          });
          return;
        }
      }

      if (!botManager.isRunning()) {
        res.status(503).json({
          success: false,
          error: 'Bot is not running'
        });
        return;
      }

      // Execute panel with appropriate context (null for system, guildId for guild)
      const result = await botManager.executePanel(
        panelId,
        user.id,
        isSystemPanel ? null : guildId,
        channelId || null
      );

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
   * POST /guild/api/panels/button
   * Handle button interaction in a guild panel or system panel
   */
  router.post('/button', requireOAuth, async (req: Request, res: Response) => {
    try {
      const { panelId, buttonId, guildId, channelId } = req.body;
      const user = req.user as DiscordUser;

      if (!panelId || !validatePanelId(panelId)) {
        res.status(400).json({
          success: false,
          error: 'Invalid panel ID format'
        });
        return;
      }

      if (!buttonId || !validatePanelId(buttonId)) {
        res.status(400).json({
          success: false,
          error: 'Invalid button ID format'
        });
        return;
      }

      // Check if this is a system panel request
      const isSystemPanel = guildId === null || guildId === 'null';

      if (isSystemPanel) {
        // System panels require dev access
        if (!await cachedIsUserDev(botManager, user.id)) {
          res.status(403).json({
            success: false,
            error: 'Access denied: System panels require developer access'
          });
          return;
        }
      } else {
        // Guild panels require valid guild ID and guild access
        if (!guildId || !validateGuildId(guildId)) {
          res.status(400).json({
            success: false,
            error: 'Invalid guild ID format'
          });
          return;
        }

        // Refresh user permissions from Discord API (with 5-min cache) and
        // persist the fresh user into the session.
        const refreshedUser = await refreshAndSaveUser(req, user);

        if (!permHasGuildAccess(refreshedUser, guildId)) {
          res.status(403).json({
            success: false,
            error: 'Access denied: You do not have administrator access to this guild'
          });
          return;
        }
      }

      if (!botManager.isRunning()) {
        res.status(503).json({
          success: false,
          error: 'Bot is not running'
        });
        return;
      }

      // Handle button with appropriate context
      const result = await botManager.handlePanelButton(
        panelId,
        buttonId,
        user.id,
        isSystemPanel ? null : guildId,
        channelId || null
      );

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
   * POST /guild/api/panels/dropdown
   * Handle dropdown interaction in a guild panel or system panel
   */
  router.post('/dropdown', requireOAuth, async (req: Request, res: Response) => {
    try {
      const { panelId, values, guildId, dropdownId, channelId } = req.body;
      const user = req.user as DiscordUser;

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

      if (values.length > 25 || !values.every(v => typeof v === 'string' && v.length < 100)) {
        res.status(400).json({
          success: false,
          error: 'Invalid values format - max 25 items, each under 100 characters'
        });
        return;
      }

      // Check if this is a system panel request
      const isSystemPanel = guildId === null || guildId === 'null';

      if (isSystemPanel) {
        // System panels require dev access
        if (!await cachedIsUserDev(botManager, user.id)) {
          res.status(403).json({
            success: false,
            error: 'Access denied: System panels require developer access'
          });
          return;
        }
      } else {
        // Guild panels require valid guild ID and guild access
        if (!guildId || !validateGuildId(guildId)) {
          res.status(400).json({
            success: false,
            error: 'Invalid guild ID format'
          });
          return;
        }

        // Refresh user permissions from Discord API (with 5-min cache) and
        // persist the fresh user into the session.
        const refreshedUser = await refreshAndSaveUser(req, user);

        if (!permHasGuildAccess(refreshedUser, guildId)) {
          res.status(403).json({
            success: false,
            error: 'Access denied: You do not have administrator access to this guild'
          });
          return;
        }
      }

      if (!botManager.isRunning()) {
        res.status(503).json({
          success: false,
          error: 'Bot is not running'
        });
        return;
      }

      // Handle dropdown with appropriate context
      const result = await botManager.handlePanelDropdown(
        panelId,
        values,
        user.id,
        isSystemPanel ? null : guildId,
        dropdownId,
        channelId || null
      );

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
   * POST /guild/api/panels/modal
   * Handle modal submission in a guild panel or system panel
   */
  router.post('/modal', requireOAuth, async (req: Request, res: Response) => {
    try {
      const { panelId, modalId, fields, guildId, channelId } = req.body;
      const user = req.user as DiscordUser;

      if (!panelId || !validatePanelId(panelId)) {
        res.status(400).json({
          success: false,
          error: 'Invalid panel ID format'
        });
        return;
      }

      if (!modalId || !validatePanelId(modalId)) {
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

      // Check if this is a system panel request
      const isSystemPanel = guildId === null || guildId === 'null';

      if (isSystemPanel) {
        // System panels require dev access
        if (!await cachedIsUserDev(botManager, user.id)) {
          res.status(403).json({
            success: false,
            error: 'Access denied: System panels require developer access'
          });
          return;
        }
      } else {
        // Guild panels require valid guild ID and guild access
        if (!guildId || !validateGuildId(guildId)) {
          res.status(400).json({
            success: false,
            error: 'Invalid guild ID format'
          });
          return;
        }

        // Refresh user permissions from Discord API (with 5-min cache) and
        // persist the fresh user into the session.
        const refreshedUser = await refreshAndSaveUser(req, user);

        if (!permHasGuildAccess(refreshedUser, guildId)) {
          res.status(403).json({
            success: false,
            error: 'Access denied: You do not have administrator access to this guild'
          });
          return;
        }
      }

      if (!botManager.isRunning()) {
        res.status(503).json({
          success: false,
          error: 'Bot is not running'
        });
        return;
      }

      // Handle modal with appropriate context
      const result = await botManager.handlePanelModal(
        panelId,
        modalId,
        fields,
        user.id,
        isSystemPanel ? null : guildId,
        channelId || null
      );

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
   * GET /guild/api/panels/channels
   * Get list of text channels for a guild (for channel-required panels)
   */
  router.get('/channels', requireOAuth, async (req: Request, res: Response) => {
    try {
      const guildId = req.query.guildId as string;
      const user = req.user as DiscordUser;

      if (!guildId || !validateGuildId(guildId)) {
        res.status(400).json({
          success: false,
          error: 'Valid guild ID is required'
        });
        return;
      }

      // Verify user has access to this guild (refresh + persist to session)
      const refreshedUser = await refreshAndSaveUser(req, user);

      if (!permHasGuildAccess(refreshedUser, guildId)) {
        res.status(403).json({
          success: false,
          error: 'Access denied: You do not have administrator access to this guild'
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

  /**
   * GET /guild/api/panels/roles
   * Get list of assignable roles for a guild (for role select menus)
   */
  router.get('/roles', requireOAuth, async (req: Request, res: Response) => {
    try {
      const guildId = req.query.guildId as string;
      const user = req.user as DiscordUser;

      if (!guildId || !validateGuildId(guildId)) {
        res.status(400).json({
          success: false,
          error: 'Valid guild ID is required'
        });
        return;
      }

      // Verify user has access to this guild (refresh + persist to session)
      const refreshedUser = await refreshAndSaveUser(req, user);

      if (!permHasGuildAccess(refreshedUser, guildId)) {
        res.status(403).json({
          success: false,
          error: 'Access denied: You do not have administrator access to this guild'
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
   * GET /guild/api/guilds
   * Get list of guilds the authenticated user can access
   * Refreshes user permissions from Discord API before returning list
   */
  router.get('/guilds', requireOAuth, async (req: Request, res: Response) => {
    try {
      const user = req.user as DiscordUser;

      if (!botManager.isRunning()) {
        res.status(503).json({
          success: false,
          error: 'Bot is not running'
        });
        return;
      }

      // Refresh user guilds from Discord API (with caching) and persist to session.
      const refreshedUser = await refreshAndSaveUser(req, user);

      // Get bot's guild list
      const botGuildsResult = await botManager.getBotGuilds();

      if (!botGuildsResult.success) {
        res.status(500).json({
          success: false,
          error: 'Failed to get bot guilds'
        });
        return;
      }

      // Intersect user-admin guilds with bot-present guilds.
      const userGuilds = refreshedUser.guilds || [];
      const botGuildIds = new Set((botGuildsResult.guilds || []).map((g: any) => g.id));
      const accessibleGuilds = userGuilds
        .filter(g => botGuildIds.has(g.id) && permHasGuildAccess(refreshedUser, g.id));

      const guildsResponse = accessibleGuilds.map(g => ({
        id: g.id,
        name: g.name,
        icon: g.icon
      }));

      // Check if user is a developer (from DEVS config); cached
      const isDev = await cachedIsUserDev(botManager, user.id);

      // Add System Panels pseudo-guild for developers
      if (isDev) {
        guildsResponse.unshift({
          id: 'system',  // Special ID for system panels
          name: 'System Panels',
          icon: null
        });
      }

      res.json({
        success: true,
        guilds: guildsResponse,
        isDev: isDev  // Include dev status in response
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: `Failed to get guilds: ${errorMessage}`
      });
    }
  });

  return router;
}
