// The variables through which the bot is configured: every key src reads from
// process.env by name, and every key envLoader copies by prefix (the payment
// providers'). Tests and the children they start never carry one, so a
// developer's shell can point no run at a real fleet, database, manager,
// payment provider or Discord account. Every other variable passes, the active
// Stryker mutant included. unit/envScrub.test.ts holds the names to src.
// Not covered: configManager's getConfigProperty also reads process.env[key]
// for any config key it is asked for; the known ones (DEVS, testMode) are
// scrubbed here, a module's own config key is not.
const PREFIXES = [
  'DATA_BACKEND', 'CONTROL_', 'FLEET_', 'TRANSFER_', 'BOT_', 'DISCORD_', 'WEBUI_', 'OAUTH_',
  'STRIPE_', 'LEMONSQUEEZY_', 'PAYPAL_', 'PATREON_',
];
const NAMES = [
  'MASTER_URLS', 'SESSION_SECRET', 'CLIENT_ID', 'GUILD_ID', 'MAIN_GUILD_ID', 'NODE_NAME', 'GRAVEYARD_TTL_DAYS',
  'PIN_TEST_GUILD_SHARD', 'XFER_TEST_CORRUPT', 'ENABLE_GUILD_WEBUI', 'DEV_USER_IDS', 'BUILD_MODE', 'BOOST_TARGET_GUILD_ID',
  'DEVS', 'testMode',
];
// Read by src and set by the tests themselves: DATA_DIR per test, NODE_ENV to
// 'test' (vitest keeps a shell's value, and 'development' switches the bot's paths).
export const KEPT = ['DATA_DIR', 'NODE_ENV'];

export function scrubbed(key: string): boolean {
  return NAMES.includes(key) || PREFIXES.some(prefix => key.startsWith(prefix));
}

export function scrubEnv<T extends Record<string, string | undefined>>(env: T): T {
  for (const key of Object.keys(env)) if (scrubbed(key)) delete env[key];
  return env;
}
