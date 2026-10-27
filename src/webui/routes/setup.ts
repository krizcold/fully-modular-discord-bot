// src/webui/routes/setup.ts
//
// Handles credential management for both bot and Guild Web-UI settings.
// Under managed deployments (BUILD_MODE=managed), bot credentials (DISCORD_TOKEN,
// CLIENT_ID, GUILD_ID) are owned by the external bot manager and this endpoint
// rejects attempts to modify them. Under standalone deployments they are
// editable here. Guild Web-UI credentials are editable in both modes and
// trigger a hot-reload of the OAuth strategy without a restart.

import * as fs from 'fs';
import * as dotenv from 'dotenv';
import { Router, Request, Response } from 'express';
import {
  loadCredentials,
  saveCredentials,
  getCredentialStatus,
  BotCredentials,
  getDeploymentMode,
  isContainerPinned
} from '../../utils/envLoader';
import { dataPath } from '../../utils/dataRoot';
import { reconfigureOAuth } from '../auth/oauthConfig';

/** Keys whose value an answer never repeats (the secrets, and the IDs /status masks). */
const MASKED_KEYS = new Set<string>([
  'DISCORD_TOKEN', 'DISCORD_CLIENT_SECRET', 'SESSION_SECRET', 'DATA_BACKEND_URL',
  'CLIENT_ID', 'GUILD_ID', 'DISCORD_CLIENT_ID',
]);

/** The keys stored in /data/.env itself, with their stored values; the container env is not in it. */
function readStoredEnv(): Record<string, string> {
  const file = dataPath('.env');
  return fs.existsSync(file) ? dotenv.parse(fs.readFileSync(file)) : {};
}

/**
 * What a save writes: the file's own keys, plus every key whose value the
 * save changed (removed when it cleared it). A value that only the container
 * env supplied is never copied into the file.
 */
function fileAfterSave(stored: Record<string, string>, before: BotCredentials, after: BotCredentials): BotCredentials {
  const out: BotCredentials = { ...stored };
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[key] === after[key]) continue;
    if (after[key] === undefined) delete out[key]; else out[key] = after[key];
  }
  return out;
}

/**
 * Changed or cleared keys the container env pins: the env wins over the
 * file, so each keeps its env value whatever the file now says. Call after
 * loadCredentials().
 */
function containerSetChanges(before: BotCredentials, after: BotCredentials): Array<{ field: string; message: string }> {
  const out: Array<{ field: string; message: string }> = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[key] === after[key] || !isContainerPinned(key)) continue;
    const kept = MASKED_KEYS.has(key) ? 'its value' : process.env[key];
    out.push({ field: key, message: `${key} is set by the container environment, so it keeps ${kept}` });
  }
  return out;
}

const OAUTH_FIELDS = ['ENABLE_GUILD_WEBUI', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'OAUTH_CALLBACK_URL'] as const;

/** Data backend settings; changes only take effect after a bot restart. */
const DATA_BACKEND_FIELDS = ['DATA_BACKEND', 'DATA_BACKEND_URL'] as const;

/**
 * Classify credential changes by their reload semantics. Returns a per-field
 * array the client can surface (e.g. "applied live", "bot needs restart").
 */
function computeReloadActions(
  before: BotCredentials,
  after: BotCredentials
): Array<{ field: string; action: 'hot-inplace' | 'web-ui-remount' | 'bot-reconnect' | 'session-invalidate' }> {
  const changes: Array<{ field: string; action: 'hot-inplace' | 'web-ui-remount' | 'bot-reconnect' | 'session-invalidate' }> = [];
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of allKeys) {
    if (before[key] === after[key]) continue;
    // Unset DATA_BACKEND means file; persisting the default is not a change.
    if (key === 'DATA_BACKEND' && (before[key] || 'file') === (after[key] || 'file')) continue;
    if (OAUTH_FIELDS.includes(key as any)) {
      changes.push({ field: key, action: 'web-ui-remount' });
    } else if (key === 'SESSION_SECRET') {
      changes.push({ field: key, action: 'session-invalidate' });
    } else if (key === 'DISCORD_TOKEN' || key === 'CLIENT_ID' || key === 'GUILD_ID') {
      changes.push({ field: key, action: 'bot-reconnect' });
    } else if (DATA_BACKEND_FIELDS.includes(key as any)) {
      // Data backend changes require a bot restart to take effect.
      changes.push({ field: key, action: 'bot-reconnect' });
    } else {
      changes.push({ field: key, action: 'hot-inplace' });
    }
  }
  return changes;
}

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
        // Deployment mode: UI uses this to hide / disable bot credential fields when managed
        deploymentMode: getDeploymentMode(),
        // Optional settings status
        credentials: status,
        guildIds: guildIds,
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
   * Save credentials to /data/.env
   *
   * Main credentials (DISCORD_TOKEN, CLIENT_ID, GUILD_ID) are accepted only
   * in standalone mode. In managed mode they are owned by Bot Manager and any
   * values sent here are ignored; existing values are preserved.
   */
  router.post('/credentials', async (req: Request, res: Response) => {
    try {
      const isStandalone = getDeploymentMode() === 'standalone';
      const {
        // Main credentials: only honored when isStandalone (ignored when managed)
        DISCORD_TOKEN, CLIENT_ID, GUILD_ID,
        // Optional bot-specific settings
        MAIN_GUILD_ID,
        // OAuth fields (optional)
        ENABLE_GUILD_WEBUI, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET,
        OAUTH_CALLBACK_URL, SESSION_SECRET,
        // Data backend settings: only honored when isStandalone (ignored when managed)
        DATA_BACKEND, DATA_BACKEND_URL,
        // Payment provider credentials are NOT accepted here - each provider
        // owns its own credential modal accessible from the Premium panel.
        // The PUT /api/appstore/premium/providers/:id/credentials route
        // handles persistence via saveCredentials() with the same
        // leave-blank-to-keep semantics this route uses.
      } = req.body;

      // Load existing credentials (includes Bot Manager-set values)
      const existingCredentials = loadCredentials();
      const stored = readStoredEnv();

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

      // Validate standalone-editable bot credentials if provided (blank = keep existing)
      if (isStandalone) {
        if (CLIENT_ID && CLIENT_ID.trim() !== '' && (CLIENT_ID.trim().length < 17 || !/^\d+$/.test(CLIENT_ID.trim()))) {
          res.status(400).json({
            success: false,
            error: 'CLIENT_ID must be a valid Discord application ID (numeric) if provided'
          });
          return;
        }
        if (GUILD_ID && GUILD_ID.trim() !== '' && (GUILD_ID.trim().length < 17 || !/^\d+$/.test(GUILD_ID.trim()))) {
          res.status(400).json({
            success: false,
            error: 'GUILD_ID must be a valid Discord server ID (numeric) if provided'
          });
          return;
        }
        if (DATA_BACKEND && DATA_BACKEND.trim() !== ''
            && DATA_BACKEND.trim() !== 'file' && DATA_BACKEND.trim() !== 'postgres') {
          res.status(400).json({
            success: false,
            error: 'DATA_BACKEND must be "file" or "postgres"'
          });
          return;
        }
        if (DATA_BACKEND_URL && DATA_BACKEND_URL.trim() !== ''
            && !/^postgres(ql)?:\/\//.test(DATA_BACKEND_URL.trim())) {
          res.status(400).json({
            success: false,
            error: 'DATA_BACKEND_URL must start with postgresql:// or postgres://'
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

      // The merged view after the save; only the keys it changed reach the
      // file (fileAfterSave). Managed mode: main credentials are preserved (owned by Bot Manager).
      // Standalone: provided non-empty values replace existing ones; blank
      // fields keep the stored value.
      const credentials: BotCredentials = {
        ...existingCredentials,
        DISCORD_TOKEN: isStandalone && DISCORD_TOKEN && DISCORD_TOKEN.trim() !== ''
          ? DISCORD_TOKEN.trim()
          : existingCredentials.DISCORD_TOKEN,
        CLIENT_ID: isStandalone && CLIENT_ID && CLIENT_ID.trim() !== ''
          ? CLIENT_ID.trim()
          : existingCredentials.CLIENT_ID,
        GUILD_ID: isStandalone && GUILD_ID && GUILD_ID.trim() !== ''
          ? GUILD_ID.trim()
          : existingCredentials.GUILD_ID,
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
          : existingCredentials.SESSION_SECRET && { SESSION_SECRET: existingCredentials.SESSION_SECRET }),
        // Data backend settings: standalone-editable; managed mode preserves
        // existing values (owned by the external manager). Blank keeps existing.
        ...(isStandalone && DATA_BACKEND && DATA_BACKEND.trim() !== ''
          ? { DATA_BACKEND: DATA_BACKEND.trim() }
          : existingCredentials.DATA_BACKEND && { DATA_BACKEND: existingCredentials.DATA_BACKEND }),
        ...(isStandalone && DATA_BACKEND_URL && DATA_BACKEND_URL.trim() !== ''
          ? { DATA_BACKEND_URL: DATA_BACKEND_URL.trim() }
          : existingCredentials.DATA_BACKEND_URL && { DATA_BACKEND_URL: existingCredentials.DATA_BACKEND_URL }),
      };

      // Save credentials
      const saveResult = saveCredentials(fileAfterSave(stored, existingCredentials, credentials));

      if (!saveResult.success) {
        res.status(500).json({
          success: false,
          error: saveResult.error || 'Failed to save credentials'
        });
        return;
      }

      // Classify what changed so the client can surface per-field feedback; a
      // container-pinned key keeps its env value, so it changed nothing.
      const containerSet = containerSetChanges(existingCredentials, credentials);
      const reloadActions = computeReloadActions(existingCredentials, credentials)
        .filter(c => !containerSet.some(p => p.field === c.field));

      // Hot-reload Guild Web-UI OAuth when any OAuth-related field changed.
      const oauthChanged = reloadActions.some(c => c.action === 'web-ui-remount');
      if (oauthChanged) {
        try {
          reconfigureOAuth();
        } catch (err) {
          console.error('[Setup] reconfigureOAuth failed:', err);
        }
      }

      // Return masked status (NEVER return actual values)
      const status = getCredentialStatus(credentials);

      res.json({
        success: true,
        message: 'Settings saved successfully',
        containerSet,
        credentials: status,
        // Per-field reload actions so the UI can show what happened:
        //   hot-inplace       : applied live, no further action needed
        //   web-ui-remount    : OAuth strategy reconfigured live
        //   bot-reconnect     : bot process needs to restart (ignored in managed mode)
        //   session-invalidate: SESSION_SECRET changed; active sessions logged out on restart
        reload: {
          changes: reloadActions,
          oauthReconfigured: oauthChanged,
          sessionSecretChanged: reloadActions.some(c => c.action === 'session-invalidate'),
          botCredentialsChanged: reloadActions.some(c => c.action === 'bot-reconnect'),
        }
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
   * GET /api/setup/deployment-mode
   * Returns the current deployment mode. UI uses this to gate bot credential editing.
   */
  router.get('/deployment-mode', (_req: Request, res: Response) => {
    res.json({ success: true, mode: getDeploymentMode() });
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
            'Web-UI panels and system-scope features use this server'
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
        DATA_BACKEND: {
          title: 'Data Backend (Optional, standalone only)',
          steps: [
            'Choose where the bot stores its data: file (default) or postgres',
            'Switching the backend does NOT move existing data: the bot refuses to start against an empty database while its data is in files',
            'A bot restart is required for the change to take effect'
          ],
          example: 'file or postgres'
        },
        DATA_BACKEND_URL: {
          title: 'Database URL (Required if backend is postgres)',
          steps: [
            'PostgreSQL connection string for the data backend',
            'Format: postgresql://user:password@host:5432/db',
            'Leave blank to keep the saved value (it is never shown here)',
            'A bot restart is required for changes to take effect'
          ],
          example: 'postgresql://user:password@host:5432/db'
        }
      }
    });
  });

  return router;
}
