// The variables through which the bot is configured: every key src reads from
// process.env, and every key envLoader copies by prefix (the payment
// providers'). Tests and the children they start never carry one, so a
// developer's shell can neither point a run at a real fleet, database,
// manager, payment provider or Discord account nor change how the code under
// test behaves. KEPT passes, and so does every other variable, the active
// Stryker mutant included. unit/envScrub.test.ts holds this to src.
const PREFIXES = [
  'DATA_BACKEND', 'CONTROL_', 'FLEET_', 'TRANSFER_', 'BOT_', 'DISCORD_', 'WEBUI_', 'OAUTH_',
  'STRIPE_', 'LEMONSQUEEZY_', 'PAYPAL_', 'PATREON_',
];
const NAMES = [
  'MASTER_URLS', 'SESSION_SECRET', 'CLIENT_ID', 'GUILD_ID', 'MAIN_GUILD_ID', 'NODE_NAME', 'GRAVEYARD_TTL_DAYS',
  'PIN_TEST_GUILD_SHARD', 'XFER_TEST_CORRUPT', 'ENABLE_GUILD_WEBUI', 'DEV_USER_IDS', 'BUILD_MODE', 'BOOST_TARGET_GUILD_ID',
];
// Read by src but set by the test itself (DATA_DIR) or by the runner (NODE_ENV).
export const KEPT = ['DATA_DIR', 'NODE_ENV'];

export function scrubbed(key: string): boolean {
  return NAMES.includes(key) || PREFIXES.some(prefix => key.startsWith(prefix));
}

export function scrubEnv<T extends Record<string, string | undefined>>(env: T): T {
  for (const key of Object.keys(env)) if (scrubbed(key)) delete env[key];
  return env;
}
