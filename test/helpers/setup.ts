import fs from 'fs';
import os from 'os';
import path from 'path';

// Every test file runs in its own fork: give it a throwaway data root and
// strip anything that could point the code at a real fleet, database or
// Discord token before any source module is imported.
const FLEET_ENV = [
  'DATA_BACKEND', 'DATA_BACKEND_URL', 'CONTROL_STORE_URL', 'BOT_NODE_ROLE', 'CONTROL_SECRET',
  'DISCORD_TOKEN', 'MASTER_URLS', 'FLEET_PUBLIC_URL', 'TRANSFER_URL', 'FLEET_BACKUP_MODE',
];
for (const key of FLEET_ENV) delete process.env[key];
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-test-'));
