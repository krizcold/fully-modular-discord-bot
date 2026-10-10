// The command both Stryker passes run (touched.mjs sets the pass, the files and
// the report dir in the env; Stryker adds the active mutant). It runs vitest on
// this tree's own tests: pass a, the fast tier's tests that import the mutated
// files; pass b, the integration tests that import them, then the whole child
// tier. Vitest's output goes to files, one JSON report and one log per run,
// because Stryker buffers what a command prints with Node's 1 MB exec limit and
// an overflow would end the run and count as a kill.
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const testDir = path.join(root, 'test');
const vitest = path.join(testDir, 'node_modules', 'vitest', 'vitest.mjs');
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
    const run = spawnSync(process.execPath, [vitest, ...args, '--bail=1', '--project', project, '--reporter=json', `--outputFile=${base}.json`], {
      cwd: testDir,
      stdio: ['ignore', log, log],
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
process.exit(pass === 'a' ? tier('fast', related) : tier('integration', related) || tier('child', ['run']));
