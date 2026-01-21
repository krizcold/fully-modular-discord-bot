// Guild Permission Refresher - Refreshes user guild data from Discord API
// Implements caching to prevent rate limiting while ensuring permissions are up-to-date

import axios from 'axios';
import { DiscordUser, DiscordGuild } from './oauthConfig';

/**
 * Cache entry for user guilds
 */
interface GuildCacheEntry {
  guilds: DiscordGuild[];
  timestamp: number;
}

/**
 * Cache for user guild data
 * Key: userId, Value: { guilds, timestamp }
 */
const guildCache = new Map<string, GuildCacheEntry>();

/**
 * Cache TTL (time to live) in milliseconds
 * Default: 5 minutes
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Rate limit tracking
 * Prevents a single user from spamming refresh requests
 */
const rateLimitMap = new Map<string, number>();
const RATE_LIMIT_MS = 60 * 1000; // 1 minute between forced refreshes

/**
 * Fetch user guilds from Discord API
 * @param accessToken User's Discord access token
 * @returns Array of guilds with permissions
 */
async function fetchUserGuildsFromDiscord(accessToken: string): Promise<DiscordGuild[]> {
  try {
    const response = await axios.get('https://discord.com/api/users/@me/guilds', {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    return response.data;
  } catch (error) {
    console.error('[GuildPermissionRefresher] Error fetching guilds from Discord:', error);
    throw new Error('Failed to fetch guilds from Discord API');
  }
}

/**
 * Refresh user guild data from Discord API
 * Uses cache to prevent excessive API calls
 *
 * @param user Discord user object from session
 * @param forceRefresh Force refresh even if cache is valid
 * @returns Updated user object with fresh guild data
 */
export async function refreshUserGuilds(user: DiscordUser, forceRefresh: boolean = false): Promise<DiscordUser> {
  const userId = user.id;
  const now = Date.now();

  // Check rate limit for forced refreshes
  if (forceRefresh) {
    const lastRefresh = rateLimitMap.get(userId) || 0;
    if (now - lastRefresh < RATE_LIMIT_MS) {
      console.log(`[GuildPermissionRefresher] Rate limit hit for user ${userId}, using cache`);
      forceRefresh = false; // Downgrade to cache check
    }
  }

  // Check cache
  const cached = guildCache.get(userId);
  if (cached && !forceRefresh) {
    const age = now - cached.timestamp;
    if (age < CACHE_TTL_MS) {
      console.log(`[GuildPermissionRefresher] Using cached guilds for user ${userId} (age: ${Math.round(age / 1000)}s)`);
      return {
        ...user,
        guilds: cached.guilds
      };
    }
  }

  // Cache expired or force refresh - fetch from Discord
  console.log(`[GuildPermissionRefresher] Refreshing guilds for user ${userId} from Discord API`);

  try {
    // Fetch fresh guild data from Discord
    const freshGuilds = await fetchUserGuildsFromDiscord(user.accessToken);

    // Update cache
    guildCache.set(userId, {
      guilds: freshGuilds,
      timestamp: now
    });

    // Update rate limit tracking
    if (forceRefresh) {
      rateLimitMap.set(userId, now);
    }

    // Clean up old cache entries (simple cleanup every 100 refreshes)
    if (Math.random() < 0.01) {
      cleanupCache();
    }

    console.log(`[GuildPermissionRefresher] Successfully refreshed ${freshGuilds.length} guilds for user ${userId}`);

    return {
      ...user,
      guilds: freshGuilds
    };
  } catch (error) {
    console.error(`[GuildPermissionRefresher] Failed to refresh guilds for user ${userId}:`, error);

    // On error, return cached data if available, otherwise return original user
    if (cached) {
      console.log(`[GuildPermissionRefresher] Falling back to cached guilds for user ${userId}`);
      return {
        ...user,
        guilds: cached.guilds
      };
    }

    // No cache available, return original user data
    console.warn(`[GuildPermissionRefresher] No cache available for user ${userId}, using session data`);
    return user;
  }
}

/**
 * Clean up old cache entries
 * Removes entries older than 10 minutes
 */
function cleanupCache(): void {
  const now = Date.now();
  const maxAge = 10 * 60 * 1000; // 10 minutes

  let cleaned = 0;
  for (const [userId, entry] of guildCache.entries()) {
    if (now - entry.timestamp > maxAge) {
      guildCache.delete(userId);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`[GuildPermissionRefresher] Cleaned up ${cleaned} old cache entries`);
  }
}

/**
 * Clear cache for a specific user
 * Useful when user logs out
 */
export function clearUserCache(userId: string): void {
  guildCache.delete(userId);
  rateLimitMap.delete(userId);
  console.log(`[GuildPermissionRefresher] Cleared cache for user ${userId}`);
}

/**
 * Clear all cache
 * Useful for testing or emergency cache invalidation
 */
export function clearAllCache(): void {
  guildCache.clear();
  rateLimitMap.clear();
  console.log('[GuildPermissionRefresher] Cleared all cache');
}

/**
 * Get cache statistics
 * Useful for monitoring
 */
export function getCacheStats(): { size: number; entries: Array<{ userId: string; age: number; guildCount: number }> } {
  const now = Date.now();
  const entries = Array.from(guildCache.entries()).map(([userId, entry]) => ({
    userId,
    age: Math.round((now - entry.timestamp) / 1000), // Age in seconds
    guildCount: entry.guilds.length
  }));

  return {
    size: guildCache.size,
    entries
  };
}
