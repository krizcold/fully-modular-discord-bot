import fs from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import fc from 'fast-check';
import { DEAD_ENDS, scrubEnv } from './env';

// Every test file runs in its own fork: before any source module is imported,
// keep only the variables helpers/env.ts lets through, point pg and git at
// nothing, give it a throwaway data root, and refuse a fork that would lose it
// (forkGuard.cjs).
createRequire(import.meta.url)('./forkGuard.cjs');
scrubEnv(process.env);
Object.assign(process.env, DEAD_ENDS);
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-test-'));

// The mutation gate draws one seed per run (mutation/touched.mjs), so a
// property draws the same inputs with a mutant as without one. A seed that is
// set but no integer stops every test file, rather than being passed over.
const seed = process.env.SMDB_TEST_SEED;
if (seed) {
  if (!/^-?\d+$/.test(seed) || !Number.isSafeInteger(Number(seed))) throw new Error(`SMDB_TEST_SEED must be an integer, not ${seed}`);
  fc.configureGlobal({ ...fc.readConfigureGlobal(), seed: Number(seed) });
}
