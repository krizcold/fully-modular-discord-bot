// The command both Stryker passes run (touched.mjs sets the pass, the files and
// the report dir in the env; Stryker adds the active mutant). It runs vitest on
// this tree's own tests: pass a, the fast tier's tests that import the mutated
// files (every file the gate mutates, in every run); pass b, the integration
// tests that import them, then the whole child tier; or only the test files
// SMDB_MUTATION_ONLY names (the rerun of a pass B failure with the file that
// failed), each in its tier. Every run stops at its
// first failure. A rerun alone (SMDB_MUTATION_CONFIRM=1) gives the config's
// test and hook limits and a step's default bound four times their time
// (SMDB_TEST_TIME_SCALE, read by vitest.config.ts and helpers/child.ts); a limit
// a test sets itself is not scaled. Vitest's output goes to files, one JSON report and one log
// per run, because Stryker buffers what a command prints with Node's 1 MB exec
// limit and an overflow would end the run and count as a kill.
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const started = Date.now();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const testDir = path.join(root, 'test');
// SMDB_MUTATION_VITEST: a test's stand-in for vitest (unit/mutationRunner.test.ts).
const vitest = process.env.SMDB_MUTATION_VITEST || path.join(testDir, 'node_modules', 'vitest', 'vitest.mjs');
const confirm = process.env.SMDB_MUTATION_CONFIRM === '1';
const pass = process.env.SMDB_MUTATION_PASS;
/** @type {string[]} */
const files = JSON.parse(process.env.SMDB_MUTATION_FILES ?? '[]').map((/** @type {string} */ file) => path.join(root, file));
/** @type {string[]} test files, relative to test/ */
const only = JSON.parse(process.env.SMDB_MUTATION_ONLY || '[]');
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
    const run = spawnSync(process.execPath, [vitest, ...args, '--bail=1', '--maxWorkers=1', '--project', project, '--reporter=json', `--outputFile=${base}.json`], {
      cwd: testDir,
      stdio: ['ignore', log, log],
      env: { ...process.env, SMDB_TEST_TIME_SCALE: confirm ? '4' : '1' },
    });
    // A command line past the platform's limit, for one, starts nothing: say so where the report points.
    if (run.error) fs.writeSync(log, `runner.mjs could not start vitest: ${run.error.message}\n`);
    return run.status === 0 ? 0 : 1;
  } finally {
    fs.closeSync(log);
  }
}

/** @param {string} file */
const projectOf = file => (file.startsWith('integration/') ? 'integration' : file.startsWith('child/') ? 'child' : 'fast');

if (!out || files.length === 0 || (pass !== 'a' && pass !== 'b')) {
  console.error('runner.mjs is run by touched.mjs, which sets SMDB_MUTATION_PASS, SMDB_MUTATION_FILES and SMDB_MUTATION_OUT');
  process.exit(2);
}
// A pass on some of the mutants Stryker made runs no test for the others
// (targets.mjs lists the ids it is for; touched.mjs drops the rest's results).
// With no readable list, every mutant runs.
const runIds = process.env.SMDB_MUTATION_RUN;
if (runIds && mutant !== 'dry') {
  /** @type {unknown} */
  let ids = null;
  try { ids = JSON.parse(fs.readFileSync(runIds, 'utf8')); } catch { ids = null; }
  if (Array.isArray(ids) && !ids.includes(mutant)) process.exit(0);
}
// The run with no mutant comes first in every pass: here the files as the pass
// copied them must hold no way to a fixed root, whatever changed since the gate
// planned (ranges.mjs holdsDataRoute; an instrumented file still names it).
if (mutant === 'dry') {
  const { DATA_ROUTE_WHY, holdsDataRoute } = await import('./ranges.mjs');
  const routes = files.filter(file => { try { return holdsDataRoute(file, fs.readFileSync(file, 'utf8')); } catch { return false; } });
  if (routes.length > 0) {
    fs.writeFileSync(path.join(out, 'dry-refused.txt'), `${routes.map(file => path.relative(root, file).split(path.sep).join('/')).join(', ')}: ${DATA_ROUTE_WHY}\n`);
    process.exit(1);
  }
}
/**
 * Ends the run. A run with no mutant leaves its time, which the run with no
 * mutant after a rerun's timeouts is held to (touched.mjs).
 * @param {number} code
 */
const end = code => {
  if (mutant === 'dry') fs.writeFileSync(path.join(out, 'dry-ms.txt'), String(Date.now() - started));
  process.exit(code);
};
if (only.length > 0) {
  for (const project of ['fast', 'integration', 'child']) {
    const these = only.filter(file => projectOf(file) === project);
    if (these.length > 0 && tier(project, ['run', ...these])) end(1);
  }
  end(0);
}
// Relative to test/: more files fit on a command line than with the sandbox's absolute paths.
const related = ['related', ...files.map(file => path.relative(testDir, file).split(path.sep).join('/')), '--run'];
end(pass === 'a' ? tier('fast', related) : tier('integration', related) || tier('child', ['run']));
