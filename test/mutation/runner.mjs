// The command both Stryker passes run (touched.mjs sets the pass, the files and
// the report dir in the env; Stryker adds the active mutant). It runs vitest on
// this tree's own tests: pass a, the fast tier's tests that import the mutated
// files; pass b, the integration tests that import them, then the whole child
// tier. A run stops at its first failure, except a rerun alone
// (SMDB_MUTATION_CONFIRM=1), which runs every test of both tiers, so the order
// vitest picks cannot decide what it finds, and gives every test four times its
// time (SMDB_TEST_TIME_SCALE, read by vitest.config.ts and helpers/child.ts).
// Vitest's output goes to files, one JSON report and one log per run, because
// Stryker buffers what a command prints with Node's 1 MB exec limit and an
// overflow would end the run and count as a kill.
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const testDir = path.join(root, 'test');
// SMDB_MUTATION_VITEST: a test's stand-in for vitest (unit/mutationRunner.test.ts).
const vitest = process.env.SMDB_MUTATION_VITEST || path.join(testDir, 'node_modules', 'vitest', 'vitest.mjs');
const confirm = process.env.SMDB_MUTATION_CONFIRM === '1';
const pass = process.env.SMDB_MUTATION_PASS;
/** @type {string[]} */
const files = JSON.parse(process.env.SMDB_MUTATION_FILES ?? '[]').map((/** @type {string} */ file) => path.join(root, file));
const out = process.env.SMDB_MUTATION_OUT ?? '';
const mutant = process.env.__STRYKER_ACTIVE_MUTANT__ ?? 'dry';

/**
 * @param {string} project
 * @param {string[]} args
 */
function tier(project, args) {
  const base = path.join(out, `${mutant}-${project}`);
  const log = fs.openSync(`${base}.log`, 'w');
  try {
    // One worker per run: Stryker already runs several at once, and a run's
    // time must match the run with no mutant it is timed against.
    const run = spawnSync(process.execPath, [vitest, ...args, ...(confirm ? [] : ['--bail=1']), '--maxWorkers=1', '--project', project, '--reporter=json', `--outputFile=${base}.json`], {
      cwd: testDir,
      stdio: ['ignore', log, log],
      env: { ...process.env, SMDB_TEST_TIME_SCALE: confirm ? '4' : '1' },
    });
    return run.status === 0 ? 0 : 1;
  } finally {
    fs.closeSync(log);
  }
}

if (!out || files.length === 0 || (pass !== 'a' && pass !== 'b')) {
  console.error('runner.mjs is run by touched.mjs, which sets SMDB_MUTATION_PASS, SMDB_MUTATION_FILES and SMDB_MUTATION_OUT');
  process.exit(2);
}
const related = ['related', ...files, '--run'];
if (pass === 'a') process.exit(tier('fast', related));
const integration = tier('integration', related);
process.exit(integration && !confirm ? integration : integration | tier('child', ['run']));
