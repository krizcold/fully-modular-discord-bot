// src/webui/routes/setup.ts
//
// NOTE: Main credentials (DISCORD_TOKEN, CLIENT_ID, GUILD_ID) are now
// managed by Bot Manager. This route only handles optional/bot-specific settings.

import { Router, Request, Response } from 'express';
import {
  loadCredentials,
  saveCredentials,
  getCredentialStatus,
  BotCredentials
} from '../../utils/envLoader';

export function createSetupRoutes(): Router {
  const router = Router();

  // Auth is applied in server.ts via requireAuth middleware

  /**
   * GET /api/setup/status
   * Get credential status for optional settings only.
   * Main credentials (DISCORD_TOKEN, CLIENT_ID, GUILD_ID) are managed by Bot Manager.
   */
  router.get('/status', (req: Request, res: Response) => {
    try {
      const credentials = loadCredentials();
      const status = getCredentialStatus(credentials);

      // Check if main credentials exist (set by Bot Manager)
      const mainCredentialsConfigured = !!(
        credentials.DISCORD_TOKEN &&
        credentials.CLIENT_ID &&
        credentials.GUILD_ID
      );

      // Include guild IDs (not sensitive, needed for UI dropdowns)
      const guildIds = {
        GUILD_ID: credentials.GUILD_ID || null,
        MAIN_GUILD_ID: credentials.MAIN_GUILD_ID || null
      };

      res.json({
        success: true,
        // Main credentials are managed by Bot Manager
        mainCredentialsConfigured,
        managedByBotManager: ['DISCORD_TOKEN', 'CLIENT_ID', 'GUILD_ID'],
        // Optional settings status
        credentials: status,
        guildIds: guildIds
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  /**
   * POST /api/setup/credentials
   * Save OPTIONAL credentials to /data/.env
   *
   * NOTE: Main credentials (DISCORD_TOKEN, CLIENT_ID, GUILD_ID) are managed
   * by Bot Manager and should NOT be modified here. This endpoint only handles
   * optional settings like MAIN_GUILD_ID and OAuth configuration.
   */
  router.post('/credentials', async (req: Request, res: Response) => {
    try {
      const {
        // Main credentials are NOT accepted - managed by Bot Manager
        // DISCORD_TOKEN, CLIENT_ID, GUILD_ID - DO NOT ACCEPT

        // Optional bot-specific settings
        MAIN_GUILD_ID,
        // OAuth fields (optional)
        ENABLE_GUILD_WEBUI, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET,
        OAUTH_CALLBACK_URL, SESSION_SECRET
      } = req.body;

      // Load existing credentials (includes Bot Manager-set values)
      const existingCredentials = loadCredentials();

      // Validate MAIN_GUILD_ID if provided (optional)
      if (MAIN_GUILD_ID && MAIN_GUILD_ID.trim() !== '') {
        if (MAIN_GUILD_ID.trim().length < 17 || !/^\d+$/.test(MAIN_GUILD_ID.trim())) {
          res.status(400).json({
            success: false,
            error: 'MAIN_GUILD_ID must be a valid Discord server ID (numeric) if provided'
          });
          return;
        }
      }

      // Determine if OAuth will be enabled (either explicitly set or already enabled)
      const oauthWillBeEnabled = ENABLE_GUILD_WEBUI === 'true' || ENABLE_GUILD_WEBUI === true ||
        (ENABLE_GUILD_WEBUI === undefined && existingCredentials.ENABLE_GUILD_WEBUI === 'true');

      // Validate OAuth fields if OAuth will be enabled
      if (oauthWillBeEnabled) {
        // Use provided values or fall back to existing
        const finalOAuthClientId = DISCORD_CLIENT_ID?.trim() || existingCredentials.DISCORD_CLIENT_ID;
        const finalOAuthClientSecret = DISCORD_CLIENT_SECRET?.trim() || existingCredentials.DISCORD_CLIENT_SECRET;
        const finalCallbackUrl = OAUTH_CALLBACK_URL?.trim() || existingCredentials.OAUTH_CALLBACK_URL;
        const finalSessionSecret = SESSION_SECRET?.trim() || existingCredentials.SESSION_SECRET;

        // Validate DISCORD_CLIENT_ID (either provided or existing)
        if (!finalOAuthClientId || finalOAuthClientId.length < 17 || !/^\d+$/.test(finalOAuthClientId)) {
          res.status(400).json({
            success: false,
            error: 'DISCORD_CLIENT_ID must be a valid Discord application ID (numeric) when OAuth is enabled'
          });
          return;
        }

        // Validate DISCORD_CLIENT_SECRET (either provided or existing)
        if (!finalOAuthClientSecret || finalOAuthClientSecret.length < 20) {
          res.status(400).json({
            success: false,
            error: 'DISCORD_CLIENT_SECRET must be provided when OAuth is enabled'
          });
          return;
        }

        // Validate OAUTH_CALLBACK_URL (either provided or existing)
        if (!finalCallbackUrl || !finalCallbackUrl.includes('/auth/discord/callback')) {
          res.status(400).json({
            success: false,
            error: 'OAUTH_CALLBACK_URL must be a valid callback URL (must contain /auth/discord/callback)'
          });
          return;
        }

        // Validate SESSION_SECRET (either provided or existing)
        if (!finalSessionSecret || finalSessionSecret.length < 16) {
          res.status(400).json({
            success: false,
            error: 'SESSION_SECRET must be at least 16 characters when OAuth is enabled'
          });
          return;
        }
      }

      // Build credentials object - PRESERVE main credentials from Bot Manager
      const credentials: BotCredentials = {
        // PRESERVE main credentials (set by Bot Manager)
        DISCORD_TOKEN: existingCredentials.DISCORD_TOKEN,
        CLIENT_ID: existingCredentials.CLIENT_ID,
        GUILD_ID: existingCredentials.GUILD_ID,
        // MAIN_GUILD_ID: Use provided value, or keep existing
        ...(MAIN_GUILD_ID && MAIN_GUILD_ID.trim() !== ''
          ? { MAIN_GUILD_ID: MAIN_GUILD_ID.trim() }
          : existingCredentials.MAIN_GUILD_ID && { MAIN_GUILD_ID: existingCredentials.MAIN_GUILD_ID }),
        // OAuth fields: Use provided value, or keep existing
        ...(ENABLE_GUILD_WEBUI !== undefined
          ? { ENABLE_GUILD_WEBUI: ENABLE_GUILD_WEBUI === true || ENABLE_GUILD_WEBUI === 'true' ? 'true' : 'false' }
          : existingCredentials.ENABLE_GUILD_WEBUI && { ENABLE_GUILD_WEBUI: existingCredentials.ENABLE_GUILD_WEBUI }),
        ...(DISCORD_CLIENT_ID && DISCORD_CLIENT_ID.trim() !== ''
          ? { DISCORD_CLIENT_ID: DISCORD_CLIENT_ID.trim() }
          : existingCredentials.DISCORD_CLIENT_ID && { DISCORD_CLIENT_ID: existingCredentials.DISCORD_CLIENT_ID }),
        ...(DISCORD_CLIENT_SECRET && DISCORD_CLIENT_SECRET.trim() !== ''
          ? { DISCORD_CLIENT_SECRET: DISCORD_CLIENT_SECRET.trim() }
          : existingCredentials.DISCORD_CLIENT_SECRET && { DISCORD_CLIENT_SECRET: existingCredentials.DISCORD_CLIENT_SECRET }),
        ...(OAUTH_CALLBACK_URL && OAUTH_CALLBACK_URL.trim() !== ''
          ? { OAUTH_CALLBACK_URL: OAUTH_CALLBACK_URL.trim() }
          : existingCredentials.OAUTH_CALLBACK_URL && { OAUTH_CALLBACK_URL: existingCredentials.OAUTH_CALLBACK_URL }),
        ...(SESSION_SECRET && SESSION_SECRET.trim() !== ''
          ? { SESSION_SECRET: SESSION_SECRET.trim() }
          : existingCredentials.SESSION_SECRET && { SESSION_SECRET: existingCredentials.SESSION_SECRET })
      };

      // Save credentials
      const saveResult = saveCredentials(credentials);

      if (!saveResult.success) {
        res.status(500).json({
          success: false,
          error: saveResult.error || 'Failed to save credentials'
        });
        return;
      }

      // Return masked status (NEVER return actual values)
      const status = getCredentialStatus(credentials);

      res.json({
        success: true,
        message: 'Settings saved successfully',
        credentials: status
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        success: false,
        error: errorMessage
      });
    }
  });

  /**
   * GET /api/setup/instructions
   * Get instructions for optional settings.
   * Main credentials (DISCORD_TOKEN, CLIENT_ID, GUILD_ID) are managed by Bot Manager.
   */
  router.get('/instructions', (req: Request, res: Response) => {
    res.json({
      success: true,
      // Note: Main credentials are managed by Bot Manager
      managedByBotManager: {
        notice: 'The following credentials are managed by Bot Manager and cannot be changed here:',
        credentials: ['DISCORD_TOKEN', 'CLIENT_ID', 'GUILD_ID'],
        instructions: 'To modify these credentials, use the Bot Manager Web-UI.'
      },
      // Instructions for optional settings only
      instructions: {
        MAIN_GUILD_ID: {
          title: 'Main Guild ID (Optional)',
          steps: [
            '⚠️ This field is OPTIONAL',
            'Use this if you have a separate production server',
            'Right-click on your main/production server icon',
            'Click "Copy Server ID" and paste it here',
            'If left empty, it will default to Guild ID',
            'Web-UI panels and mainGuildOnly features use this server'
          ],
          example: '987654321098765432 (or leave empty)'
        },
        ENABLE_GUILD_WEBUI: {
          title: 'Enable Guild Web-UI (Optional)',
          steps: [
            '⚠️ This feature is OPTIONAL',
            'Enable this to allow guild administrators to access /guild interface',
            'Guild admins can manage their guild settings via Discord OAuth login',
            'Requires additional Discord OAuth application setup (see below)',
            'Only enable if you need multi-guild admin access',
            'Leave disabled for single-guild bots or owner-only management'
          ],
          example: 'true or false'
        },
        DISCORD_CLIENT_ID: {
          title: 'Discord OAuth Client ID (Required if OAuth enabled)',
          steps: [
            '1. Go to https://discord.com/developers/applications',
            '2. Create a NEW application (or use existing OAuth app)',
            '   ⚠️ This should be a SEPARATE OAuth app, NOT your bot application',
            '3. Go to "OAuth2" section in left sidebar',
            '4. Copy the "CLIENT ID" at the top',
            '5. Add redirect URI: http://your-domain:3000/auth/discord/callback',
            '   (Replace with your actual domain)',
            '6. Select scopes: identify, guilds, guilds.members.read',
            '7. Save changes and paste CLIENT ID here'
          ],
          example: '987654321098765432'
        },
        DISCORD_CLIENT_SECRET: {
          title: 'Discord OAuth Client Secret (Required if OAuth enabled)',
          steps: [
            '1. In the same OAuth2 application from above',
            '2. Click "Reset Secret" button',
            '3. Copy the secret immediately (it only shows once!)',
            '4. Paste it here',
            '⚠️ NEVER share this secret with anyone!',
            '⚠️ Keep this secret secure - it grants access to user OAuth'
          ],
          example: 'AbCdEf123456_XXXXXXXXXXXXX'
        },
        OAUTH_CALLBACK_URL: {
          title: 'OAuth Callback URL (Required if OAuth enabled)',
          steps: [
            'This is the URL Discord redirects to after login',
            'Format: http://your-domain:3000/auth/discord/callback',
            'Must EXACTLY match the redirect URI in Discord OAuth2 settings',
            'Use http://localhost:3000/auth/discord/callback for local testing',
            'Use https://your-domain/auth/discord/callback for production'
          ],
          example: 'http://localhost:3000/auth/discord/callback'
        },
        SESSION_SECRET: {
          title: 'Session Secret (Required if OAuth enabled)',
          steps: [
            'Random string used to encrypt user sessions',
            'Must be at least 16 characters (longer is better)',
            'Use the "Generate" button to create a secure random secret',
            'Or generate manually with: openssl rand -base64 32',
            '⚠️ Keep this secret secure - changing it logs out all users'
          ],
          example: 'Use the Generate button or: openssl rand -base64 32'
        },
        REDIS_URL: {
          title: 'Redis URL (Optional)',
          steps: [
            '⚠️ This field is OPTIONAL',
            'Redis provides persistent session storage',
            'Without Redis, sessions are stored in memory (lost on restart)',
            'Format: redis://host:port or redis://user:pass@host:port/db',
            'Examples:',
            '  - redis://localhost:6379',
            '  - redis://redis:6379 (Docker)',
            'Leave empty to use memory store (fine for testing)'
          ],
          example: 'redis://localhost:6379 (or leave empty)'
        }
      }
    });
  });

  return router;
}
