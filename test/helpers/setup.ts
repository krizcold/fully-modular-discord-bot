import fs from 'fs';
import os from 'os';
import path from 'path';
import { FLEET_ENV } from './env';

// Every test file runs in its own fork: give it a throwaway data root and
// strip anything that could point the code at a real fleet, database or
// Discord token before any source module is imported.
for (const key of FLEET_ENV) delete process.env[key];
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-test-'));
