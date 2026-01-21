// Permission Checker - Validates user permissions for guilds and system access

import { DiscordUser, DiscordGuild } from './oauthConfig';
import { loadCredentials } from '../../utils/envLoader';

/**
 * Check if user is a system owner (in DEV_USER_IDS)
 */
export function isSystemOwner(userId: string): boolean {
  const devUserIds = process.env.DEV_USER_IDS?.split(',').map(id => id.trim()) || [];
  return devUserIds.includes(userId);
}

/**
 * Check if user has access to system panels
 */
export function hasSystemAccess(user: DiscordUser): boolean {
  return isSystemOwner(user.id);
}

/**
 * Get list of guild IDs the user has admin access to
 */
export function getUserAdminGuilds(user: DiscordUser): string[] {
  if (!user.guilds) {
    return [];
  }

  // Filter guilds where user has admin permissions
  // Discord permissions are stored as a bitfield string
  const adminGuilds = user.guilds.filter(guild => {
    // Check if user is guild owner
    if (guild.owner) {
      return true;
    }

    // Check if user has Administrator permission (bit 3)
    // Permissions are stored as a number (bitfield)
    const permissions = guild.permissions;
    const ADMINISTRATOR = 0x8; // 0x8 = Administrator permission bit

    return (permissions & ADMINISTRATOR) === ADMINISTRATOR;
  });

  return adminGuilds.map(guild => guild.id);
}

/**
 * Check if user has access to a specific guild
 */
export function hasGuildAccess(user: DiscordUser, guildId: string): boolean {
  // System owners have access to all guilds
  if (hasSystemAccess(user)) {
    return true;
  }

  // Check if user has admin access to this guild
  const adminGuilds = getUserAdminGuilds(user);
  return adminGuilds.includes(guildId);
}

/**
 * Get user's accessible guild from bot's guilds
 * Returns guild IDs where bot is present AND user has admin access
 */
export function getUserAccessibleBotGuilds(user: DiscordUser, botGuildIds: string[]): string[] {
  // System owners can access all bot guilds
  if (hasSystemAccess(user)) {
    return botGuildIds;
  }

  // Get guilds where user has admin access
  const userAdminGuilds = getUserAdminGuilds(user);

  // Filter to only include guilds where bot is present
  return botGuildIds.filter(guildId => userAdminGuilds.includes(guildId));
}

/**
 * Validate if user should have access to the main guild (owner UI)
 */
export function hasMainGuildAccess(user: DiscordUser): boolean {
  const credentials = loadCredentials();
  const mainGuildId = credentials.MAIN_GUILD_ID || credentials.GUILD_ID;

  if (!mainGuildId) {
    // If no main guild configured, only allow system owners
    return hasSystemAccess(user);
  }

  // Check if user has access to main guild
  return hasGuildAccess(user, mainGuildId);
}
