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
// first failed test, or after a tier that fails, but a tier of a run with no
// mutant other than a check of sets, which runs every file to its end and reruns
// alone each file it failed in beside other files (dryTier). A rerun alone (SMDB_MUTATION_CONFIRM=1) and every run with
// no mutant give the config's test and hook limits and a step's default bound four times their time
// (passes.mjs ALONE_TIME_SCALE, as SMDB_TEST_TIME_SCALE, read by vitest.config.ts and helpers/child.ts), so a slow machine cannot fail a run
// with no mutant and stop the gate; a mutant's run in pass A or B keeps scale 1. A limit
// a test sets itself is not scaled. Vitest's output goes to files, one JSON report and one log
// per run, because Stryker buffers what a command prints with Node's 1 MB exec
// limit and an overflow would end the run and count as a kill.
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ALONE_TIME_SCALE, aloneBoundMs } from './passes.mjs';

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
 * other run is given one, whatever the caller's shell set. A run `whole` runs
 * every file to its end, past a failed test, and leaves its unhandled errors
 * beside its report (unhandled.mjs, as `<name>.unhandled.json`).
 * @param {string} project
 * @param {string[] | 'related' | 'all'} take
 * @param {{ coverage?: string, name?: string, whole?: boolean }} [run] name: the report's and the log's, in `out`
 */
function launch(project, take, { coverage, name = `${mutant}-${project}`, whole = false } = {}) {
  const files = Array.isArray(take) ? take : null;
  const base = path.join(out, name);
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, SMDB_TEST_TIME_SCALE: String(confirm || mutant === 'dry' ? ALONE_TIME_SCALE : 1) };
  delete env.SMDB_MUTATION_COVERAGE;
  delete env.SMDB_MUTATION_INCLUDE;
  delete env.SMDB_MUTATION_SETS;
  delete env.SMDB_MUTATION_UNHANDLED;
  delete env.SMDB_MUTATION_DRY_MS;
  if (coverage) env.SMDB_MUTATION_COVERAGE = coverage;
  if (whole) env.SMDB_MUTATION_UNHANDLED = `${base}.unhandled.json`;
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
  const args = [
    vitest, ...(take === 'related' ? related : ['run']), ...(whole ? [] : ['--bail=1']), '--no-cache', '--maxWorkers=1', '--project', project, '--reporter=json',
    ...(whole ? [`--reporter=${path.join(testDir, 'mutation', 'unhandled.mjs')}`] : []), `--outputFile=${base}.json`,
  ];
  return { args, env, log: fs.openSync(`${base}.log`, 'w') };
}

/**
 * @param {string} project
 * @param {string[] | 'related' | 'all'} take
 * @param {{ coverage?: string, name?: string, whole?: boolean }} [run]
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
const running = pid => { try { process.kill(pid, 0); return true; } catch (error) { return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM'; } };

/**
 * Runs `files` as tier() does, and ends it with every process it started
 * once it passes `ms`; resolves to its exit (1 when the bound fired or it
 * could not start), the time it took, whether the runner ended it (it was
 * still running when the bound fired, and did not exit on its own) and
 * vitest's own exit status. With `stop`, it also ends them within a quarter
 * second of `stop()` turning true. `coverage` as in launch().
 * @param {string[]} files
 * @param {string} name
 * @param {number} ms
 * @param {() => boolean} [stop]
 * @param {string} [coverage]
 * @returns {Promise<{ code: number, ms: number, ended: boolean, status: number | null }>}
 */
async function bounded(files, name, ms, stop, coverage) {
  const { endTree } = await import('../helpers/endTree.mjs');
  const { args, env, log } = launch(projectOf(files[0]), files, { name, coverage });
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
    const watch = stop ? setInterval(() => {
      if (!stop()) return;
      clearInterval(watch);
      if (child.pid !== undefined) endTree(child.pid);
      child.kill('SIGKILL');
    }, 250) : undefined;
    // A test's stand-in only (unit/mutationRunner.test.ts): the stand-in exits while the runner is held, so the bound's timer runs before the exit is seen.
    const hold = process.env.SMDB_MUTATION_VITEST ? Number(process.env.SMDB_MUTATION_HOLD_MS) : NaN;
    if (hold > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, hold);
    /** @type {{ status: number | null, signal: NodeJS.Signals | null }} */
    const exit = await new Promise(resolve => {
      child.once('error', error => { fs.writeSync(log, `runner.mjs could not start vitest: ${error.message}\n`); resolve({ status: null, signal: null }); });
      child.once('exit', (status, signal) => resolve({ status, signal }));
    });
    clearTimeout(timer);
    clearInterval(watch);
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
const { AGAIN_FILE, AGAIN_UNWRITTEN_FILE, dropRecords, testName } = await import('./reach.mjs');
/** @type {import('./reach.mjs').Again[]} the reruns alone of this run with no mutant (dryTier) */
const again = [];
/**
 * Leaves the reruns alone in AGAIN_FILE, with whether the run with no mutant
 * passed (null while it runs), written aside and renamed, so the file is
 * whole or as it was. Returns why it could not be written, '' when it was.
 * @param {boolean | null} passed
 */
const writeAgain = passed => {
  const file = path.join(out, AGAIN_FILE);
  try {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ passed, reruns: again }));
    fs.renameSync(`${file}.tmp`, file);
    return '';
  } catch (error) {
    try { fs.rmSync(`${file}.tmp`, { force: true }); } catch {}
    return /** @type {NodeJS.ErrnoException} */ (error).code ?? String(error);
  }
};
/**
 * Ends the run. A run with no mutant leaves its time, which the run with no
 * mutant after a rerun's timeouts is held to (control.mjs), by a monotonic
 * clock, which no clock step moves; its reruns alone are part of it. One that
 * reran files alone fails when its record of them cannot be written: the gate
 * reads it to send a kill of such a file to a2 (touched.mjs flakyCheck), so it
 * must not go on without it. Why goes to AGAIN_UNWRITTEN_FILE, if that can be written.
 * @param {number} code
 */
const end = code => {
  let exit = code;
  if (mutant === 'dry' && again.length > 0) {
    const failed = writeAgain(code === 0);
    if (failed) {
      exit = 1;
      try { fs.writeFileSync(path.join(out, AGAIN_UNWRITTEN_FILE), `${AGAIN_FILE} could not be written (${failed})\n`); } catch {}
    }
  }
  if (mutant === 'dry') fs.writeFileSync(path.join(out, 'dry-ms.txt'), String(Math.round(performance.now() - started)));
  process.exit(exit);
};
// Relative to test/: more files fit on a command line than with the sandbox's absolute paths.
const related = ['related', ...files.map(file => path.relative(testDir, file).split(path.sep).join('/')), '--run'];

// Stryker's bound on this run with no mutant (touched.mjs sets it), less a
// minute for Stryker's start before the runner and the runner's end after its
// last vitest: no rerun alone starts past it, and none runs past it.
const dryMs = Number(process.env.SMDB_MUTATION_DRY_MS);
const deadline = dryMs > 0 ? started + dryMs - 60_000 : Infinity;

/**
 * The test files a failed tier of a run with no mutant failed in, relative to
 * test/ and in its report's order, when they are the whole failure and other
 * files ran beside them: each file vitest marked failed (a test, a hook or the
 * file itself) and each file an unhandled error names. null when the failure
 * cannot be laid on them: no report or no record of unhandled errors that
 * reads (vitest itself failed), a report of one file, no file named, or an
 * unhandled error that names no file of the report.
 * @param {string} project
 * @returns {string[] | null}
 */
function failedBeside(project) {
  /** @type {{ testResults?: { name?: unknown, status?: unknown }[] }} */
  let report;
  /** @type {unknown} */
  let errors;
  try {
    report = JSON.parse(fs.readFileSync(path.join(out, `dry-${project}.json`), 'utf8'));
    errors = JSON.parse(fs.readFileSync(path.join(out, `dry-${project}.unhandled.json`), 'utf8'));
  } catch {
    return null;
  }
  const results = report?.testResults;
  if (!Array.isArray(results) || !Array.isArray(errors) || !results.every(result => typeof result?.name === 'string')) return null;
  const names = [...new Set(results.map(result => testName(testDir, /** @type {string} */ (result.name))))];
  if (names.length < 2) return null;
  const failed = new Set(results.filter(result => result.status === 'failed').map(result => testName(testDir, /** @type {string} */ (result.name))));
  for (const error of errors) {
    const file = typeof error?.file === 'string' ? testName(testDir, error.file) : null;
    if (file === null || !names.includes(file)) return null;
    failed.add(file);
  }
  return failed.size > 0 ? names.filter(name => failed.has(name)) : null;
}

/**
 * Runs one tier of a run with no mutant on `take` (as tier() does), every file
 * to its end. When it fails only in test files that ran beside others
 * (failedBeside), each of them reruns alone, one at a time, in a vitest run of
 * its own at the same time scale, within its bound (passes.mjs aloneBoundMs)
 * and what is left of Stryker's; with `coverage`, its records from the failed
 * run are dropped first, so the reach holds the rerun's. The tier passes when
 * every one passes alone, and fails at the first that does not (README, "A
 * run with no mutant that fails beside other files"). Resolves to its exit,
 * the time (Date.now) after the whole tier's vitest exited, and the runner's
 * time to then, by the monotonic clock, which the costs of that vitest's
 * report are made against.
 * @param {string} project
 * @param {string[] | 'related' | 'all'} take
 * @param {string} [coverage]
 * @returns {Promise<{ code: number, end: number, took: number }>}
 */
async function dryTier(project, take, coverage) {
  for (const name of [`dry-${project}.json`, `dry-${project}.unhandled.json`]) fs.rmSync(path.join(out, name), { force: true });
  const code = tier(project, take, { coverage, whole: true });
  const ran = { end: Date.now(), took: performance.now() - started };
  const failed = code === 0 ? [] : failedBeside(project);
  if (failed === null) return { code, ...ran };
  for (const file of failed) {
    const name = `dry-again-${again.length}`;
    const bound = Math.min(aloneBoundMs(project), Math.floor(deadline - performance.now()));
    if (bound <= 0) {
      again.push({ tier: project, file, name, code: null, ms: 0, bound: 0, why: "no time was left within Stryker's bound on the run with no mutant" });
      writeAgain(null);
      return { code: 1, ...ran };
    }
    if (coverage) dropRecords(coverage, testDir, file);
    const run = await bounded([file], name, bound, undefined, coverage);
    again.push({ tier: project, file, name, code: run.code, ms: run.ms, bound, end: Date.now(), ...(run.ended ? { ended: true } : {}) });
    writeAgain(null);
    if (run.code !== 0) return { code: 1, ...ran };
  }
  return { code: 0, ...ran };
}
// The run with no mutant that checks what a pass counted (touched.mjs
// aloneCheck and setCheck): each set of test files SMDB_MUTATION_SETS names
// in a vitest run of its own, as a mutant run takes files, within the set's
// own bound, and the exit and time of each in dry-alone.json, and one line per
// finished set appended to checks.jsonl, which a resume reads (resume.mjs); the
// run itself passes, so Stryker reads no failure into it. Once the gate that
// started the run is gone, it ends the set in flight and adds no line, so a
// resume, which waits while runner-<pid>.json names a live process, runs that
// set once, and no runner of a killed gate loads the machine under it.
/** @type {{ files: string[], ms: number }[]} */
const sets = JSON.parse(process.env.SMDB_MUTATION_SETS || '[]');
if (mutant === 'dry' && sets.length > 0) {
  const { CHECKS_FILE, runnerFile } = await import('./resume.mjs');
  const gate = Number(process.env.SMDB_MUTATION_GATE_PID);
  const own = path.join(out, runnerFile(process.pid));
  fs.writeFileSync(own, `${JSON.stringify({ pid: process.pid, started: new Date().toISOString() })}\n`);
  process.on('exit', () => { try { fs.rmSync(own, { force: true }); } catch {} });
  const gone = () => Number.isSafeInteger(gate) && gate > 0 && !running(gate);
  /** @type {{ files: string[], code: number, ms: number }[]} */
  const runs = [];
  for (const [index, set] of sets.entries()) {
    if (gone()) process.exit(1);
    const run = { files: set.files, ...await bounded(set.files, `dry-alone-${index}`, set.ms, gone) };
    if (gone()) process.exit(1);
    runs.push(run);
    fs.writeFileSync(path.join(out, 'dry-alone.json'), JSON.stringify(runs));
    fs.appendFileSync(path.join(out, CHECKS_FILE), `${JSON.stringify(run)}\n`);
  }
  end(0);
}
if (only.length > 0) {
  for (const project of ['fast', 'integration', 'child']) {
    const these = only.filter(file => projectOf(file) === project);
    if (these.length > 0 && (mutant === 'dry' ? (await dryTier(project, these)).code : tier(project, these))) end(1);
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
  /** @param {string} [coverage] */
  const whole = async coverage => (mutant === 'dry'
    ? (await dryTier('integration', 'related', coverage)).code || (await dryTier('child', 'all', coverage)).code
    : tier('integration', 'related') || tier('child', 'all'));
  if (confirm) end(await whole());
  else if (mutant === 'dry') {
    const coverage = path.join(out, COVERAGE_DIR);
    fs.rmSync(coverage, { recursive: true, force: true });
    try { fs.rmSync(path.join(out, REACH_FILE), { force: true }); } catch {}
    const code = await whole(coverage);
    // With no reach left, every mutant run takes every related integration file and the whole child tier.
    if (code === 0) try { writeReach(out, testDir, ['integration', 'child'], undefined, undefined, again); } catch { try { fs.rmSync(path.join(out, REACH_FILE), { force: true }); } catch {} }
    end(code);
  } else {
    const reach = readReach(out);
    const take = reach && reach.files.every(file => projectOf(file) !== 'fast') ? selectFor(reach, mutant) : null;
    // One that cannot be written only leaves the report without "no test of pass B reached it".
    try { fs.writeFileSync(path.join(out, `${mutant}-reach.json`), JSON.stringify({ files: take ?? 'related' })); } catch {}
    if (take === null) end(await whole());
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
    const run = await dryTier('fast', 'related');
    try { writeCosts(out, testDir, run.end, run.took, again); } catch { try { fs.rmSync(path.join(out, COSTS_FILE), { force: true }); } catch {} }
    end(run.code);
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
  const run = await dryTier('fast', 'related', coverage);
  // With no reach left, every mutant run takes every related file.
  try { writeReach(out, testDir, ['fast'], run.end, run.took, again); } catch { try { fs.rmSync(path.join(out, REACH_FILE), { force: true }); } catch {} }
  end(run.code);
}
const reach = readReach(out);
const take = selectFor(reach, mutant);
await runTake(take, boundFor(reach, take, { ...RUN_BOUND, startMs: boundStartMs(process.env, RUN_BOUND.startMs) }));
