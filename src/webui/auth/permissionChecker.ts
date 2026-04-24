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

  const ADMINISTRATOR = BigInt(0x8); // Administrator permission bit

  const adminGuilds = user.guilds.filter(guild => {
    if (guild.owner) return true;
    // Discord returns the bitfield as a string for newer apps (value can exceed Number.MAX_SAFE_INTEGER).
    // Normalize via BigInt for correctness on large values.
    try {
      const perms = typeof guild.permissions === 'bigint'
        ? guild.permissions
        : BigInt(guild.permissions as string | number);
      return (perms & ADMINISTRATOR) === ADMINISTRATOR;
    } catch {
      return false;
    }
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
