import { createRequire } from 'module';
import { expect } from 'vitest';

// Loaded first in every test file of a pass A run with no mutant, which names
// its dir in SMDB_MUTATION_COVERAGE (mutation/runner.mjs). helpers/reachRecorder.cjs
// records, in a dir of this file and process under it, every mutant this
// process and the processes under it reach (mutation/README.md, "Which fast
// tests a mutant runs").

const dir = process.env.SMDB_MUTATION_COVERAGE;
// A nested vitest a test starts must not take this run's dir as its own.
delete process.env.SMDB_MUTATION_COVERAGE;

if (dir) {
  const worker = (globalThis as { __vitest_worker__?: { filepath?: unknown } }).__vitest_worker__;
  const file = expect.getState().testPath ?? (typeof worker?.filepath === 'string' ? worker.filepath : undefined);
  // With no file there is no record dir, so the reach reads the file as unsure.
  if (file) (createRequire(import.meta.url)('./reachRecorder.cjs') as { openTestFile(coverage: string, file: string): void }).openTestFile(dir, file);
}
