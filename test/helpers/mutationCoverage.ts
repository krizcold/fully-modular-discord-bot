import { createRequire } from 'module';
import { expect } from 'vitest';

// Loaded first in every test file of a run with no mutant that records reach,
// which names its dir in SMDB_MUTATION_COVERAGE (mutation/runner.mjs): pass A's,
// for the fast tier, and pass B's, for the integration and child tiers.
// helpers/reachRecorder.cjs records, in a dir of this file and process under
// it, every mutant this process and the processes under it reach
// (mutation/README.md, "Which fast tests a mutant runs" and "Which tests a pass
// B mutant runs").

const dir = process.env.SMDB_MUTATION_COVERAGE;
// A nested vitest a test starts must not take this run's dir as its own.
delete process.env.SMDB_MUTATION_COVERAGE;

if (dir) {
  const worker = (globalThis as { __vitest_worker__?: { filepath?: unknown } }).__vitest_worker__;
  const file = expect.getState().testPath ?? (typeof worker?.filepath === 'string' ? worker.filepath : undefined);
  // With no file there is no record dir, so the reach reads the file as unsure.
  if (file) (createRequire(import.meta.url)('./reachRecorder.cjs') as { openTestFile(coverage: string, file: string): void }).openTestFile(dir, file);
}
