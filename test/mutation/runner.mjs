// The command both Stryker passes run (touched.mjs sets the pass, the files and
// the report dir in the env; Stryker adds the active mutant). It runs vitest on
// this tree's own tests: pass a, the fast tier's tests that import the mutated
// files (every file the gate mutates, in every run), of which a mutant's run
// takes those that reached it in the run with no mutant (a rerun alone, those
// its run in pass A took), and one that takes some of them is ended past a
// bound built from what they cost in its pass's run with no mutant, leaving
// <id>-bound.json (reach.mjs boundFor); pass b, the integration
// tests that import them, then the whole child tier, of which a mutant's run
// takes those that reached it in the run with no mutant; or only the test files
// SMDB_MUTATION_ONLY names (the rerun of a pass B failure with the file that
// failed), each in its tier; or, with no mutant, each set of files
// SMDB_MUTATION_SETS names, in a vitest run of its own (touched.mjs aloneCheck
// and setCheck). Every run stops at its
// first failed test, or after a tier that fails. A rerun alone (SMDB_MUTATION_CONFIRM=1) gives the config's
// test and hook limits and a step's default bound four times their time
// (SMDB_TEST_TIME_SCALE, read by vitest.config.ts and helpers/child.ts); a limit
// a test sets itself is not scaled. Vitest's output goes to files, one JSON report and one log
// per run, because Stryker buffers what a command prints with Node's 1 MB exec
// limit and an overflow would end the run and count as a kill.
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const started = performance.now();
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
// touched.mjs gives every run with no mutant the id 'none'.
const active = process.env.__STRYKER_ACTIVE_MUTANT__ ?? 'none';
const mutant = active === 'none' ? 'dry' : active;

/**
 * Runs one tier on `take`: the test files given (relative to test/), the
 * tests related to the mutated files, or every test of the tier. `coverage` is
 * the dir the runs with no mutant of pass A and pass B record reach in; no
 * other run is given one, whatever the caller's shell set.
 * @param {string} project
 * @param {string[] | 'related' | 'all'} take
 * @param {{ coverage?: string, name?: string }} [run] name: the report's and the log's, in `out`
 */
function launch(project, take, { coverage, name = `${mutant}-${project}` } = {}) {
  const files = Array.isArray(take) ? take : null;
  const base = path.join(out, name);
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, SMDB_TEST_TIME_SCALE: confirm ? '4' : '1' };
  delete env.SMDB_MUTATION_COVERAGE;
  delete env.SMDB_MUTATION_INCLUDE;
  delete env.SMDB_MUTATION_SETS;
  if (coverage) env.SMDB_MUTATION_COVERAGE = coverage;
  // vitest.config.ts takes exactly these files, from a file: vitest run <files> takes every path that holds a
  // name, and a long list can pass Windows' limit on a command line.
  if (files) {
    env.SMDB_MUTATION_INCLUDE = `${base}.include.json`;
    fs.writeFileSync(env.SMDB_MUTATION_INCLUDE, JSON.stringify(files));
  }
  // One worker per run: Stryker already runs several at once, and a run's
  // time must match the run with no mutant it is timed against. No results
  // cache: every sandbox links the one in test/node_modules, so earlier runs
  // would choose which file a run takes first.
  const args = [vitest, ...(take === 'related' ? related : ['run']), '--bail=1', '--no-cache', '--maxWorkers=1', '--project', project, '--reporter=json', `--outputFile=${base}.json`];
  return { args, env, log: fs.openSync(`${base}.log`, 'w') };
}

/**
 * @param {string} project
 * @param {string[] | 'related' | 'all'} take
 * @param {{ coverage?: string, name?: string }} [run]
 */
function tier(project, take, run = {}) {
  const { args, env, log } = launch(project, take, run);
  try {
    const result = spawnSync(process.execPath, args, { cwd: testDir, stdio: ['ignore', log, log], env });
    // A command line past the platform's limit, for one, starts nothing: say so where the report points.
    if (result.error) fs.writeSync(log, `runner.mjs could not start vitest: ${result.error.message}\n`);
    return result.status === 0 ? 0 : 1;
  } finally {
    fs.closeSync(log);
  }
}

/** @param {number} pid */
const running = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * Runs `files` as tier() does, and ends it with every process it started
 * once it passes `ms`; resolves to its exit (1 when the bound fired or it
 * could not start), the time it took, whether the runner ended it (it was
 * still running when the bound fired, and did not exit on its own) and
 * vitest's own exit status.
 * @param {string[]} files
 * @param {string} name
 * @param {number} ms
 * @returns {Promise<{ code: number, ms: number, ended: boolean, status: number | null }>}
 */
async function bounded(files, name, ms) {
  const { endTree } = await import('../helpers/endTree.mjs');
  const { args, env, log } = launch(projectOf(files[0]), files, { name });
  const begun = performance.now();
  try {
    const child = spawn(process.execPath, args, { cwd: testDir, stdio: ['ignore', log, log], env });
    let fired = false;
    let killed = false;
    const timer = setTimeout(() => {
      fired = true;
      killed = child.pid !== undefined && child.exitCode === null && child.signalCode === null && running(child.pid);
      if (child.pid !== undefined) endTree(child.pid);
      child.kill('SIGKILL');
    }, ms);
    // A test's stand-in only (unit/mutationRunner.test.ts): the stand-in exits while the runner is held, so the bound's timer runs before the exit is seen.
    const hold = process.env.SMDB_MUTATION_VITEST ? Number(process.env.SMDB_MUTATION_HOLD_MS) : NaN;
    if (hold > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, hold);
    /** @type {{ status: number | null, signal: NodeJS.Signals | null }} */
    const exit = await new Promise(resolve => {
      child.once('error', error => { fs.writeSync(log, `runner.mjs could not start vitest: ${error.message}\n`); resolve({ status: null, signal: null }); });
      child.once('exit', (status, signal) => resolve({ status, signal }));
    });
    clearTimeout(timer);
    // A vitest that exited on its own between the check and the kill keeps its own exit: 0, or no signal on POSIX.
    const ended = killed && exit.status !== 0 && (process.platform === 'win32' || exit.signal !== null);
    if (ended) fs.writeSync(log, `runner.mjs ended vitest after ${ms} ms, the bound on this run${mutant === 'dry' ? ' with no mutant' : ''}\n`);
    return { code: !fired && exit.status === 0 ? 0 : 1, ms: Math.round(performance.now() - begun), ended, status: exit.status };
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
// One it cannot read is refused too, as it may hold one.
if (mutant === 'dry') {
  const { DATA_ROUTE_WHY, holdsDataRoute } = await import('./ranges.mjs');
  /** @param {string[]} list */
  const names = list => list.map(file => path.relative(root, file).split(path.sep).join('/')).join(', ');
  /** @type {string[]} */
  const unread = [];
  const routes = files.filter(file => { try { return holdsDataRoute(file, fs.readFileSync(file, 'utf8')); } catch { unread.push(file); return false; } });
  const refused = [
    ...(routes.length > 0 ? [`${names(routes)}: ${DATA_ROUTE_WHY}`] : []),
    ...(unread.length > 0 ? [`${names(unread)}: it could not be read, so it was not checked for a way to a fixed root`] : []),
  ];
  if (refused.length > 0) {
    fs.writeFileSync(path.join(out, 'dry-refused.txt'), `${refused.join('; ')}\n`);
    process.exit(1);
  }
}
/**
 * Ends the run. A run with no mutant leaves its time, which the run with no
 * mutant after a rerun's timeouts is held to (control.mjs), by a monotonic
 * clock, which no clock step moves.
 * @param {number} code
 */
const end = code => {
  if (mutant === 'dry') fs.writeFileSync(path.join(out, 'dry-ms.txt'), String(Math.round(performance.now() - started)));
  process.exit(code);
};
// Relative to test/: more files fit on a command line than with the sandbox's absolute paths.
const related = ['related', ...files.map(file => path.relative(testDir, file).split(path.sep).join('/')), '--run'];
// The run with no mutant that checks what a pass counted (touched.mjs
// aloneCheck and setCheck): each set of test files SMDB_MUTATION_SETS names
// in a vitest run of its own, as a mutant run takes files, within the set's
// own bound, and the exit and time of each in dry-alone.json; the run itself
// passes, so Stryker reads no failure into it.
/** @type {{ files: string[], ms: number }[]} */
const sets = JSON.parse(process.env.SMDB_MUTATION_SETS || '[]');
if (mutant === 'dry' && sets.length > 0) {
  /** @type {{ files: string[], code: number, ms: number }[]} */
  const runs = [];
  for (const [index, set] of sets.entries()) {
    runs.push({ files: set.files, ...await bounded(set.files, `dry-alone-${index}`, set.ms) });
    fs.writeFileSync(path.join(out, 'dry-alone.json'), JSON.stringify(runs));
  }
  end(0);
}
if (only.length > 0) {
  for (const project of ['fast', 'integration', 'child']) {
    const these = only.filter(file => projectOf(file) === project);
    if (these.length > 0 && tier(project, these)) end(1);
  }
  end(0);
}
// Pass B: its run with no mutant records what each integration and child test
// file reached, its own process and the Node processes under it, and each
// mutant run takes, tier by tier, the files that reached its mutant and the
// unsure ones (reach.mjs). A b2 rerun, and the run with no mutant after b2,
// name their files above.
if (pass === 'b') {
  const { COVERAGE_DIR, REACH_FILE, readReach, selectFor, writeReach } = await import('./reach.mjs');
  const whole = () => tier('integration', 'related') || tier('child', 'all');
  if (confirm) end(whole());
  else if (mutant === 'dry') {
    const coverage = path.join(out, COVERAGE_DIR);
    fs.rmSync(coverage, { recursive: true, force: true });
    try { fs.rmSync(path.join(out, REACH_FILE), { force: true }); } catch {}
    const code = tier('integration', 'related', { coverage }) || tier('child', 'all', { coverage });
    // With no reach left, every mutant run takes every related integration file and the whole child tier.
    if (code === 0) try { writeReach(out, testDir, ['integration', 'child']); } catch { try { fs.rmSync(path.join(out, REACH_FILE), { force: true }); } catch {} }
    end(code);
  } else {
    const reach = readReach(out);
    const take = reach && reach.files.every(file => projectOf(file) !== 'fast') ? selectFor(reach, mutant) : null;
    // One that cannot be written only leaves the report without "no test of pass B reached it".
    try { fs.writeFileSync(path.join(out, `${mutant}-reach.json`), JSON.stringify({ files: take ?? 'related' })); } catch {}
    if (take === null) end(whole());
    else {
      for (const project of ['integration', 'child']) {
        const these = take.filter(file => projectOf(file) === project);
        if (these.length > 0 && tier(project, these)) end(1);
      }
      end(0);
    }
  }
}
const { boundFor, boundStartMs, COSTS_FILE, COVERAGE_DIR, REACH_FILE, readCosts, readReach, selectFor, takenBefore, writeCosts, writeReach } = await import('./reach.mjs');
const { A2_BOUND, RUN_BOUND } = await import('./passes.mjs');
/**
 * Runs a mutant's fast tests on `take` within `bound` (ms; null for Stryker's
 * limit alone) and ends.
 * @param {string[] | null} take
 * @param {number | null} bound
 */
async function runTake(take, bound) {
  // One that cannot be written only leaves the report without "no fast test reached it".
  try { fs.writeFileSync(path.join(out, `${mutant}-reach.json`), JSON.stringify({ files: take ?? 'related' })); } catch {}
  if (take === null) end(tier('fast', 'related'));
  else if (take.length === 0) end(0);
  else if (bound === null) end(tier('fast', take));
  else {
    const run = await bounded(take, `${mutant}-fast`, bound);
    // The mark tells the gate the runner, not the mutant, ended the run (touched.mjs resultOf, verdict.mjs endedByBound).
    if (run.ended) try { fs.writeFileSync(path.join(out, `${mutant}-bound.json`), JSON.stringify({ ms: bound, files: take.length })); } catch {}
    end(run.ended || run.status !== 0 ? 1 : 0);
  }
}
// A rerun alone (a2) is of mutants a file already failed or timed out on in
// pass A, so it takes the files that run took: a fresh run with no mutant that
// missed the mutant would drop the file that showed it. Its run with no mutant
// takes every related file and leaves what each cost, and a rerun of some of
// them is bounded by what they cost there, as Stryker bounds the whole pass.
if (confirm) {
  if (mutant === 'dry') {
    const code = tier('fast', 'related');
    try { writeCosts(out, testDir, Date.now(), performance.now() - started); } catch { try { fs.rmSync(path.join(out, COSTS_FILE), { force: true }); } catch {} }
    end(code);
  }
  const take = takenBefore(out, mutant);
  await runTake(take, boundFor(readCosts(out), take, { ...A2_BOUND, startMs: boundStartMs(process.env, A2_BOUND.startMs) }));
}
// Pass A: the run with no mutant records what each test file reached and cost,
// and each mutant run takes only the files that reached its mutant, within a
// bound built from what they cost (reach.mjs).
if (mutant === 'dry') {
  const coverage = path.join(out, COVERAGE_DIR);
  fs.rmSync(coverage, { recursive: true, force: true });
  const code = tier('fast', 'related', { coverage });
  // With no reach left, every mutant run takes every related file.
  try { writeReach(out, testDir, ['fast'], Date.now(), performance.now() - started); } catch { try { fs.rmSync(path.join(out, REACH_FILE), { force: true }); } catch {} }
  end(code);
}
const reach = readReach(out);
const take = selectFor(reach, mutant);
await runTake(take, boundFor(reach, take, { ...RUN_BOUND, startMs: boundStartMs(process.env, RUN_BOUND.startMs) }));
