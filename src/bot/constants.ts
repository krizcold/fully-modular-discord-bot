// Bot-wide constants

/**
 * Discord API Constants
 */
export const DISCORD_EPHEMERAL_FLAG = 64;
export const DISCORD_MAX_COMPONENT_ROWS = 5;
export const DISCORD_MAX_EMBED_FIELDS = 25;
export const DISCORD_MAX_EMBED_DESCRIPTION_LENGTH = 4096;

/**
 * IPC Communication Constants
 */
export const IPC_TIMEOUT_MS = 30000; // 30 seconds
export const IPC_RATE_LIMIT_MS = 1000; // 1 request per second per user
export const IPC_RATE_LIMIT_CLEANUP_THRESHOLD = 100; // Clean up map when it reaches this size
export const IPC_RATE_LIMIT_CLEANUP_AGE_MS = 300000; // 5 minutes

/**
 * Panel System Constants
 */
export const PANEL_DEFAULT_ITEMS_PER_PAGE = 10;
export const PANEL_MAX_ITEMS_PER_PAGE = 25;
