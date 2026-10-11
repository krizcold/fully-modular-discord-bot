import fs from 'fs';
import os from 'os';
import path from 'path';
import { scrubEnv } from './env';

// Every test file runs in its own fork: give it a throwaway data root and
// strip every bot configuration key (helpers/env.ts) before any source module
// is imported.
scrubEnv(process.env);
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-test-'));
