import fs from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import fc from 'fast-check';
import { afterAll, afterEach, beforeEach, vi } from 'vitest';
import { setBackendKind } from './backendKind';
import { DEAD_ENDS, scrubEnv } from './env';
import { installDropLineGuard } from './p1Guard';
import { WAIT_MS } from './time.mjs';

type WaitOptions = Parameters<typeof vi.waitFor>[1];
const bounded = (options: WaitOptions): WaitOptions =>
  typeof options === 'number' ? options : { ...options, timeout: options?.timeout ?? WAIT_MS };
const { waitFor, waitUntil } = vi;
vi.waitFor = ((callback, options) => waitFor(callback, bounded(options))) as typeof vi.waitFor;
vi.waitUntil = ((callback, options) => waitUntil(callback, bounded(options))) as typeof vi.waitUntil;

// A row that logs premium's dropped-entries lines without expecting them fails (p1Guard.ts).
installDropLineGuard(beforeEach, afterEach);

vi.mock('../../src/utils/envLoader', async orig => (await import('./backendKind')).withBackendKind(await orig<any>()));
// Every copy of folderChain a test file loaded, as vi.resetModules gives a new one beside the one older imports hold.
const chains = new Set<{ resetFolderSyncFailureForTests(): void; forgetDurableFolders(): void }>();
beforeEach(async () => {
  setBackendKind(null);
  // Loaded here, not at the top: a static import is hoisted above the DATA_DIR line below and fixes DATA_ROOT.
  chains.add(await import('../../src/bot/internalSetup/utils/folderChain'));
  for (const chain of chains) {
    chain.resetFolderSyncFailureForTests();
    chain.forgetDurableFolders();
  }
});

// Every test file runs in its own fork: before any source module is imported,
// keep only the variables helpers/env.ts lets through, point pg and git at
// nothing, give it a throwaway data root, and refuse a fork that would lose it
// (forkGuard.cjs).
createRequire(import.meta.url)('./forkGuard.cjs');
scrubEnv(process.env);
Object.assign(process.env, DEAD_ENDS);
process.env.NODE_ENV = 'test';

// The mutation gate draws one seed per run (mutation/touched.mjs), so a
// property draws the same inputs with a mutant as without one. A seed that is
// set but no integer stops every test file, rather than being passed over, and
// before the data root is made, so a file it stops leaves none behind.
const seed = process.env.SMDB_TEST_SEED;
if (seed) {
  if (!/^-?\d+$/.test(seed) || !Number.isSafeInteger(Number(seed))) throw new Error(`SMDB_TEST_SEED must be an integer, not ${seed}`);
  fc.configureGlobal({ ...fc.readConfigureGlobal(), seed: Number(seed) });
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-test-'));
process.env.DATA_DIR = dataDir;
// Removed by this afterAll when vitest runs it (mutation/README.md says when it
// does not), unless SMDB_KEEP_TEST_FILES keeps it for a look; a dir a process
// still holds is left behind rather than failing the file.
afterAll(() => {
  if (!process.env.SMDB_KEEP_TEST_FILES) {
    try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 }); } catch {}
  }
});
