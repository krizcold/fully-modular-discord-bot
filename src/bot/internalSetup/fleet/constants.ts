// Identify and gateway timings.

/** Per-bucket identify spacing. */
export const IDENTIFY_SPACING_MS = 5500;

/** Timeout for the /gateway/bot fetch; a fallback keeps boot alive offline. */
export const GATEWAY_INFO_TIMEOUT_MS = 5000;

/** How often session_start_limit is refreshed from /gateway/bot. */
export const BUDGET_REFRESH_MS = 300000;

/** Delay before the refresh that follows a charge, so one round of identifies is read once. */
export const BUDGET_CHARGE_REFRESH_MS = 5000;

/** Directory under /data/global/ holding node.json. */
export const FLEET_DIR = 'fleet';
