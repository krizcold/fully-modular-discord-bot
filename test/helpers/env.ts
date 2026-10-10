// Every variable through which the bot could reach a real fleet, database,
// manager or Discord account (the keys src reads from process.env). Tests and
// the children they start never carry them; everything else passes, the
// active Stryker mutant included.
export const FLEET_ENV = [
  'DATA_BACKEND', 'DATA_BACKEND_URL', 'DATA_BACKEND_PUBLIC_URL', 'DATA_BACKEND_LOCAL_URL', 'CONTROL_STORE_URL',
  'FLEET_DB_REPLICA_URL', 'FLEET_DB_REPLICA_PUBLIC_URL', 'BOT_NODE_ROLE', 'CONTROL_SECRET', 'DISCORD_TOKEN',
  'DISCORD_CLIENT_SECRET', 'MASTER_URLS', 'FLEET_PUBLIC_URL', 'TRANSFER_URL', 'FLEET_BACKUP_MODE',
  'BOT_MANAGER_API', 'BOT_MANAGER_INTERNAL_URL', 'BOT_MANAGER_UPDATE_TOKEN',
];
