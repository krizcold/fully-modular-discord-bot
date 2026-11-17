// A vitest reporter for the tiers of a run with no mutant (runner.mjs dryTier):
// it writes the run's unhandled errors, each with the test file vitest gives
// it, to the file SMDB_MUTATION_UNHANDLED names. vitest 5's JSON report leaves
// them out, though one fails the run with every test passed, so without this
// file the runner could not tell which files a failed run failed in.
import fs from 'fs';

export default class UnhandledReporter {
  // Taken out of the env, so no vitest a test starts writes over it.
  file = process.env.SMDB_MUTATION_UNHANDLED ?? '';

  constructor() {
    delete process.env.SMDB_MUTATION_UNHANDLED;
  }

  /**
   * @param {unknown} _modules
   * @param {readonly { VITEST_TEST_PATH?: unknown, message?: unknown }[]} [errors]
   */
  onTestRunEnd(_modules, errors = []) {
    if (!this.file) return;
    const lines = errors.map(error => ({
      file: typeof error?.VITEST_TEST_PATH === 'string' ? error.VITEST_TEST_PATH : null,
      message: String(error?.message ?? error).split('\n')[0],
    }));
    fs.writeFileSync(this.file, JSON.stringify(lines));
  }
}
