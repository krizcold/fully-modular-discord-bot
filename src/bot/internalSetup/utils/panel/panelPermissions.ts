// Panel Permissions - Handles permission checking for panels

import { PanelOptions, PanelContext } from '../../../types/panelTypes';
import { loadCredentials } from '../../../../utils/envLoader';
import { getConfigProperty } from '../configManager';

/**
 * Check if a user has permission to access a panel
 */
export function checkPanelPermissions(panel: PanelOptions, context: PanelContext): boolean {
  // Web-UI access - check using accessMethod (more reliable than checking interaction)
  // Web-UI may have a mock interaction for modal support, so we can't rely on !interaction
  if (context.accessMethod === 'web_ui') {
    return checkWebUIPermissions(panel, context.userId);
  }

  // Discord interaction - check guild and permissions
  return checkDiscordPermissions(panel, context);
}

/**
 * Check Web-UI specific permissions (no Discord interaction).
 * Web-UI always operates in MAIN_GUILD_ID context, so system-scope panels are allowed.
 */
function checkWebUIPermissions(panel: PanelOptions, userId: string): boolean {
  // Main Web-UI uses 'web-ui-owner' - it's already authenticated via nginxhashlock (AUTH_HASH)
  // No permission checks needed - owner has full access
  if (userId === 'web-ui-owner') {
    return true;
  }

  // Guild Web-UI uses actual Discord user IDs from OAuth - check permissions normally

  // Dev only check - uses getConfigProperty with correct priority (config.json > env > schema)
  if (panel.devOnly) {
    const devs = getConfigProperty<(string | number)[]>('DEVS') || [];
    const userIdStr = String(userId);
    const isDevUser = devs.some(dev => String(dev) === userIdStr);

    if (!isDevUser) {
      return false;
    }
  }

  // User whitelist check
  if (panel.allowedUsers && !panel.allowedUsers.includes(userId)) {
    return false;
  }

  // System-scope panels are allowed in Web-UI (which implicitly operates in MAIN_GUILD_ID)
  return true; // Web-UI access allowed (already authenticated by NGINX/Express or OAuth)
}

/**
 * Check Discord interaction permissions
 */
function checkDiscordPermissions(panel: PanelOptions, context: PanelContext): boolean {
  const { interaction, userId, guildId } = context;

  if (!interaction) return false;

  const isSystemPanel = panel.panelScope === 'system';

  // Check if panel requires guild context (system-scope, requiredPermissions, or allowedRoles)
  const requiresGuildContext = isSystemPanel ||
    (panel.requiredPermissions && panel.requiredPermissions.length > 0) ||
    (panel.allowedRoles && panel.allowedRoles.length > 0);

  // If panel requires guild context, we need guild and member
  if (requiresGuildContext && (!interaction.guild || !interaction.member)) {
    return false;
  }

  // System-scope panels are strictly main-guild-only
  if (isSystemPanel) {
    const credentials = loadCredentials();
    const mainGuildId = credentials.MAIN_GUILD_ID || credentials.GUILD_ID;

    if (guildId !== mainGuildId) {
      console.log(`[PanelPermissions] System-scope panel ${panel.id} accessed from guild ${guildId}, but main guild is ${mainGuildId}.`);
      return false;
    }
  }

  // Dev only check - uses getConfigProperty with correct priority (config.json > env > schema)
  if (panel.devOnly) {
    const devs = getConfigProperty<(string | number)[]>('DEVS') || [];
    const userIdStr = String(userId);
    const isDevUser = devs.some(dev => String(dev) === userIdStr);

    if (!isDevUser) {
      return false;
    }
  }

  // Permission check (only if guild context available)
  if (panel.requiredPermissions && interaction.memberPermissions) {
    for (const permission of panel.requiredPermissions) {
      if (!interaction.memberPermissions.has(permission)) {
        return false;
      }
    }
  }

  // User whitelist check
  if (panel.allowedUsers && !panel.allowedUsers.includes(userId)) {
    return false;
  }

  return true;
}
