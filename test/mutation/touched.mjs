// The L5 gate (VERIFY.md section 2): mutation on the lines a change touched,
// through Stryker's command runner, so code that only child processes run is
// mutated too. How to run it and read it: mutation/README.md.
// Usage: node test/mutation/touched.mjs [--base REF] [--mutate PATTERN]... [--resume DIR] [--concurrency N] [--keep]
// Exit: 0 PASS, 1 FAIL, 2 NO RESULT or a usage error; any other code: interrupted.
// Trust 0 and 1 only after a Verdict line: a process killed on Windows exits 1 too.
import { execFileSync, spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { pastBudget, strykerClock } from './control.mjs';
import { PACKAGE_LOCKS, treeChanges, treePrint } from './tree.mjs';
import { canonicalName, keyOf } from './keys.mjs';
import { A2_BOUND, COMMON, controlBoundMinutes, PASSES, setBoundMs, setsBoundMinutes } from './passes.mjs';
import { boundFor, readCosts, TAKEN_FILE } from './reach.mjs';
import {
  a2Dir, boundedDir, chainOf, CHECKS_FILE, CHECKS_PLAN_FILE, CONTROL_KEY, controlLines, DONE_FILE, keysOf, LOCK_FILE, lockOf, mutantDir, nextDir, PLAN_FILE,
  planOf, RESULTS_FILE, resultLines, resumeNumber, RUN_FILE, RUNNER_FILE, savedRun, setKey, setLines, setupChanges, someOf, STAGE_DIR, stageOf,
} from './resume.mjs';

/**
 * @typedef {import('./ranges.mjs').Location} Location
 * @typedef {import('./verdict.mjs').MutantRecord} MutantRecord
 * @typedef {import('./verdict.mjs').PassName} PassName
 * @typedef {import('./verdict.mjs').PassResult} PassResult
 * @typedef {import('./resume.mjs').SavedResult} SavedResult
 * @typedef {import('./resume.mjs').SetLine} SetLine
 * @typedef {import('./resume.mjs').ControlLine} ControlLine
 * @typedef {import('./resume.mjs').StageDir} StageDir
 * @typedef {{ file: string, patterns: string[], gating: number[] | null, deleted?: number[] }} PassTarget
 * @typedef {{ id: string, fileName: string, location: Location, mutatorName: string, replacement?: string, status: string, statusReason?: string }} StrykerResult
 * @typedef {import('@stryker-mutator/api/core').PartialStrykerOptions} Options
 */
/**
 * @template {{ key: string }} L
 * @typedef {import('./resume.mjs').Stage<L> & { chain: string[], dirs: (StageDir & { plan?: import('./resume.mjs').PlannedMutant[] | null, subset?: boolean })[] }} SavedStage
 */

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  const node = process.env.SMDB_TEST_NODE;
  // A relaunch that is still too old stops here, instead of relaunching again.
  if (!node || process.env.SMDB_MUTATION_RELAUNCHED) {
    console.error(node
      ? `The mutation gate needs Node 22.12 or newer, and SMDB_TEST_NODE (${node}) runs ${process.version}; point it at a newer node binary.`
      : `The mutation gate needs Node 22.12 or newer (this is ${process.version}); set SMDB_TEST_NODE to a newer node binary.`);
    process.exit(2);
  }
  const run = spawnSync(node, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, SMDB_MUTATION_RELAUNCHED: '1' } });
  if (run.error) console.error(`The mutation gate could not start ${node}: ${run.error.message}`);
  process.exit(run.status ?? (run.signal ? 130 : 2));
}

// Stryker links into each sandbox only a node_modules that is a dir, never a
// link, and runner.mjs starts vitest from the sandbox's test/node_modules. Read
// before the libraries load through it: npm ci through a link empties the dir
// it names, another checkout's.
const testPackages = fs.lstatSync(fileURLToPath(new URL('../node_modules', import.meta.url)), { throwIfNoEntry: false });
if (testPackages !== undefined && !testPackages.isDirectory()) {
  console.log("Verdict: NO RESULT (test/node_modules is a link, not a dir of this checkout's own, and Stryker links only a dir into its sandboxes, so no run would find the suite's packages; first remove the link itself, never what it names, with node -e \"require('fs').rmSync('test/node_modules')\" from the bot root (it refuses a real dir), then run npm run test:install: npm ci through the link would empty the other checkout's test/node_modules)");
  process.exit(2);
}

// The libraries load here, so a checkout without the test packages (npm run
// test:install) ends NO RESULT rather than with a crash's exit code.
/** @type {typeof import('./ranges.mjs')} */
let ranges;
/** @type {typeof import('./verdict.mjs')} */
let verdicts;
try {
  ranges = await import('./ranges.mjs');
  verdicts = await import('./verdict.mjs');
} catch (error) {
  console.log(`Verdict: NO RESULT (the gate could not load: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}; run npm run test:install, adding -- --include=dev where a config or NODE_ENV=production leaves dev packages out)`);
  process.exit(2);
}
const {
  structureLines, DATA_ROUTE_WHY, EXTRA_BREAK_WHY, GLOB_NAME_WHY, beyondTree, checkerDiffers, gatesIn, holdsDataRoute, holdsExtraBreak, linesOfTarget, mutatePatterns,
  notMutated, ownNames, planFromGit, rootGlobFree, rootRelatable, sandboxPatterns, strykerTakes, treeTsconfig, unmatchedPatterns, untouched,
} = ranges;
const { byKiller, bySet, classifyKill, endedByBound, judge, killedInA, onlyUnusedDirective, outcome, outcomeOf, toConfirm, toPassB, toUncheck, uncreditFailedAlone, voidFailedSets } = verdicts;

const USAGE = 'usage: node test/mutation/touched.mjs [--base REF] [--mutate PATTERN]... [--resume DIR] [--concurrency N] [--keep]';
/** @type {{ base: string, baseGiven: boolean, mutate: string[], resume: string, concurrency: number, keep: boolean }} */
const opts = { base: 'HEAD', baseGiven: false, mutate: [], resume: '', concurrency: Math.max(1, Math.floor(os.availableParallelism() / 2)), keep: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  const value = () => {
    if (i + 1 >= argv.length) { console.error(`${arg} needs a value\n${USAGE}`); process.exit(2); }
    return argv[++i];
  };
  if (arg === '--base') { opts.base = value(); opts.baseGiven = true; }
  else if (arg === '--mutate') opts.mutate.push(value());
  else if (arg === '--resume') opts.resume = path.resolve(value());
  else if (arg === '--concurrency') opts.concurrency = Math.max(1, Number(value()) || 1);
  else if (arg === '--keep') opts.keep = true;
  else { console.error(USAGE); process.exit(2); }
}
if (opts.resume && (opts.baseGiven || opts.mutate.length > 0)) {
  console.error(`--resume takes the scope from the stopped run's ${RUN_FILE}, so --base and --mutate cannot be given with it\n${USAGE}`);
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.chdir(root);
// No file-system monitor; planFromGit checks by content the files git still skips or trusts.
/** @param {string[]} args */
const git = (...args) => execFileSync('git', ['-c', 'core.quotePath=false', '-c', 'core.fsmonitor=false', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
/** @param {string} file */
const posix = file => file.split(path.sep).join('/');
/** @param {unknown} error */
const firstLine = error => (error instanceof Error ? error.message.split('\n')[0] : String(error));
if (!rootGlobFree(root)) {
  console.log(`Verdict: NO RESULT (the checkout's path, ${posix(root)}, does not match itself read as a glob, as Stryker reads it: a [ ] class, a { } with a comma or a range, an extglob such as +( ), or one minimatch cannot read; Stryker matches no file to mutate there, so move the checkout)`);
  process.exit(2);
}
if (!rootRelatable(root)) {
  console.log(`Verdict: NO RESULT (the checkout's path, ${posix(root)}, holds the text node_modules, as given or as its real path, and vitest's related runs drop every import under such a path, so no test of the fast or integration tier would meet a mutant; move the checkout)`);
  process.exit(2);
}
// The sandboxes' dir ignores itself, so git status stays clean, from the first
// print on: a sandbox another Stryker run left there is no change.
try {
  fs.mkdirSync(path.join(root, '.stryker-tmp'), { recursive: true });
  fs.writeFileSync(path.join(root, '.stryker-tmp', '.gitignore'), '*\n');
} catch (error) {
  console.log(`Verdict: NO RESULT (the gate could not make .stryker-tmp, where Stryker puts its sandboxes: ${firstLine(error)})`);
  process.exit(2);
}
// The tree as the gate found it before reading any file (tree.mjs), and the
// files that make it: the tracked files and the untracked ones git does not
// ignore. An edit saved from here on shows at the end, and so does an install
// in a dir of packages the runs load (tree.mjs PACKAGE_LOCKS).
const treeFiles = () => git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean);
const packages = treePrint(root, PACKAGE_LOCKS);
/** @type {Map<string, string>} */
let planned;
try {
  planned = treePrint(root, treeFiles());
} catch (error) {
  console.log(`Verdict: NO RESULT (the gate could not read the tree: ${firstLine(error)})`);
  process.exit(2);
}

/**
 * @param {string} file
 * @returns {string | null}
 */
const readText = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

/** @type {string[]} what the report says of a resume: what each stage it found saved kept and what it ran now */
const resumed = [];

/** @param {number} pid */
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM'; } };

/**
 * Takes the report dir for this run: lock.json, created only where none is
 * (the 'wx' flag), with this process's id and start time, and removed at
 * exit. One a process that no longer runs left (a gate that was killed) is
 * taken over, and the report says so; one whose process runs, or that cannot
 * be read, ends the run with `refuse`.
 * @param {string} dir
 * @param {(why: string) => never} refuse
 */
function takeLock(dir, refuse) {
  const file = path.join(dir, LOCK_FILE);
  const mine = `${JSON.stringify({ pid: process.pid, started: new Date().toISOString() })}\n`;
  const write = () => {
    try { fs.writeFileSync(file, mine, { flag: 'wx' }); return ''; } catch (error) { return /** @type {NodeJS.ErrnoException} */ (error).code ?? firstLine(error); }
  };
  let failed = write();
  if (failed === 'EEXIST') {
    const text = readText(file);
    const held = lockOf(text ?? '');
    if (!held) refuse(`its ${LOCK_FILE} cannot be read, so whether another gate run uses the dir is not known; remove ${LOCK_FILE} once none does`);
    if (alive(held.pid)) {
      refuse(`its ${LOCK_FILE} names process ${held.pid}, started ${held.started}, which still runs, so another gate run may be using the dir; if that process is no gate run, remove ${LOCK_FILE}`);
    }
    // Moved aside first, so of two resumes that both found it stale only one takes it.
    const aside = path.join(dir, `lock-stale-${process.pid}.json`);
    let moved = false;
    try { fs.renameSync(file, aside); moved = true; } catch {}
    if (moved && readText(aside) !== text) {
      try { fs.renameSync(aside, file); } catch {}
      refuse(`another gate run took its ${LOCK_FILE} while this one started`);
    }
    fs.rmSync(aside, { force: true });
    failed = write();
    if (!failed) resumed.push(`${LOCK_FILE} named process ${held.pid}, started ${held.started}, which no longer runs, so this resume took the report dir over`);
  }
  if (failed) refuse(failed === 'EEXIST' ? `another gate run took its ${LOCK_FILE} while this one started` : `its ${LOCK_FILE} could not be written (${failed})`);
  process.on('exit', () => { if (readText(file) === mine) fs.rmSync(file, { force: true }); });
}

// A resume continues a stopped run in its report dir (README, "Stopping and
// resuming"), on the tree that run started on: its results say nothing of
// another. The print holds file times too, since the stopped run never
// reached its own end-of-run check, so an edit made and undone while it ran
// shows here.
/** @type {import('./resume.mjs').RunSetup} the Node that runs every test command (runner.mjs) and a test's stand-in for vitest */
const setup = { path: process.execPath, version: process.version, standIn: process.env.SMDB_MUTATION_VITEST ?? '' };
/** @type {import('./resume.mjs').SavedRun | null} */
let saved = null;
let resumeN = 0;
/**
 * @param {string} why
 * @returns {never}
 */
const refuse = why => {
  console.log(`Verdict: NO RESULT (the run in ${posix(path.relative(root, opts.resume)) || '.'} cannot be resumed: ${why}; no pass ran)`);
  process.exit(2);
};
/**
 * Waits up to `ms` for every runner.mjs of a check of sets that a stage dir
 * of `dir` names (resume.mjs runnerFile) to end: one left behind by a killed
 * gate ends the set in flight by itself within a second of the gate's end, and
 * until it ends it could still add a line. Returns what still runs then, or
 * a file that cannot be read, as why the resume cannot go on; '' for none.
 * @param {string} dir
 * @param {number} ms
 */
function runnersLeft(dir, ms) {
  const until = Date.now() + ms;
  for (;;) {
    let left = '';
    for (const stage of fs.readdirSync(dir).filter(name => STAGE_DIR.test(name)).sort()) {
      /** @type {string[]} */
      let names = [];
      try { names = fs.readdirSync(path.join(dir, stage)).filter(name => RUNNER_FILE.test(name)).sort(); } catch { names = []; }
      for (const name of names) {
        const text = readText(path.join(dir, stage, name));
        if (text === null && !fs.existsSync(path.join(dir, stage, name))) continue;
        const held = lockOf(text ?? '');
        if (!held) return `${stage}/${name} cannot be read, so whether a run of sets of test files the stopped gate started still runs there is not known; remove it once none does`;
        if (alive(held.pid)) left ||= `${stage}/${name} names process ${held.pid}, started ${held.started}, a run of sets of test files the stopped gate started, which still runs and could still add a result there; end that process and the processes under it, then resume`;
      }
    }
    if (!left || Date.now() >= until) return left;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
}

if (opts.resume) {
  if (!fs.statSync(opts.resume, { throwIfNoEntry: false })?.isDirectory()) refuse(`it is no dir, so it holds no ${RUN_FILE}`);
  takeLock(opts.resume, refuse);
  const runners = runnersLeft(opts.resume, 10_000);
  if (runners) refuse(runners);
  /** @type {string | null} */
  let text = null;
  try { text = fs.readFileSync(path.join(opts.resume, RUN_FILE), 'utf8'); } catch { text = null; }
  if (text === null) refuse(`it holds no ${RUN_FILE}, which a run writes before pass A starts, so what tree, scope and seed it ran on is not known`);
  saved = savedRun(/** @type {string} */ (text));
  if (!saved) refuse(`its ${RUN_FILE} cannot be read, so what tree, scope and seed it ran on is not known`);
  const was = /** @type {import('./resume.mjs').SavedRun} */ (saved);
  const changed = [...treeChanges(new Map(was.tree), planned), ...treeChanges(new Map(was.packages), packages)].sort();
  if (changed.length > 0) {
    refuse(`the tree or the packages differ from those the stopped run started on (a file's content, size or time, a file added or gone, or an install), so its results say nothing of this tree: ${someOf(changed)}`);
  }
  const ranWith = setupChanges(was.setup, setup);
  if (ranWith.length > 0) refuse(`what ran its tests differs from what runs them now, so its results say nothing of a run here: ${ranWith.join('; ')}`);
  opts.mutate = 'mutate' in was.scope ? was.scope.mutate : [];
  process.env.SMDB_TEST_SEED = was.seed;
  resumeN = resumeNumber(fs.readdirSync(opts.resume));
}
// Every sandbox holds those files and nothing else (ranges.mjs sandboxPatterns).
const sandbox = sandboxPatterns([...planned.keys()]);
// Every run with no mutant carries the id 'none' (runner.mjs), which names no
// mutant, so a test that reacts to the variable being there fails those runs
// too; it also overrides an id set in the shell, which Stryker passes on to the
// command it runs.
process.env.__STRYKER_ACTIVE_MUTANT__ = 'none';
// Only the runs with no mutant of pass A and pass B record reach (runner.mjs gives them the dir); one set in the shell would reach every run.
delete process.env.SMDB_MUTATION_COVERAGE;
// A pattern is a file, or a file and lines; one with columns names no file, so it is refused.
/** @param {string} pattern */
const fileOfPattern = pattern => pattern.replace(/:\d+-\d+$/, '');
/** @type {Set<string> | undefined} */
let inTree;
// Each --mutate file is taken under the name it has on disk (keys.mjs), the
// name Stryker matches, so its mutants find their target in the report. It
// must be in the tree, which is what a sandbox holds and the fingerprint covers.
opts.mutate = opts.mutate.map(pattern => {
  const file = fileOfPattern(pattern);
  const name = canonicalName(root, file);
  if (name === null) {
    console.error(`--mutate takes a file in the bot root that exists, or such a file and lines, never a glob: ${pattern}\n${USAGE}`);
    process.exit(2);
  }
  let text = '';
  try {
    text = fs.readFileSync(path.join(root, name), 'utf8');
  } catch (error) {
    console.error(`--mutate cannot take ${name}: it could not be read (${/** @type {NodeJS.ErrnoException} */ (error).code ?? firstLine(error)})`);
    process.exit(2);
  }
  inTree ??= ownNames(root, planned.keys());
  const why = !strykerTakes(root, name) ? GLOB_NAME_WHY : holdsExtraBreak(text) ? EXTRA_BREAK_WHY : holdsDataRoute(name, text) ? DATA_ROUTE_WHY : notMutated(name)
    ?? (inTree.has(name) ? null : 'git neither tracks it nor would add it (it is ignored, or inside a submodule or an untracked repository), so no sandbox holds it');
  if (why) {
    console.error(`--mutate cannot take ${name}: ${why}`);
    process.exit(2);
  }
  return `${name}${pattern.slice(file.length)}`;
});

// One fast-check seed for every run of the gate (helpers/setup.ts reads it), so
// a property draws the same inputs with a mutant as without one: a property
// that fails in a mutant's run fails for the mutant.
const givenSeed = process.env.SMDB_TEST_SEED;
if (givenSeed && (!/^-?\d+$/.test(givenSeed) || !Number.isSafeInteger(Number(givenSeed)))) {
  console.error(`SMDB_TEST_SEED must be an integer, not ${givenSeed}\n${USAGE}`);
  process.exit(2);
}
process.env.SMDB_TEST_SEED ||= String(crypto.randomInt(2 ** 31));

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
// The process id too: two runs in one checkout that start in the same
// millisecond would otherwise read each other's vitest reports.
const reportDir = opts.resume || path.join(root, 'test', 'mutation', 'reports', `${stamp}-${process.pid}`);

/** @type {PassTarget[]} */
let targets = [];
/**
 * Whether a target can gate: one whose changed lines hold no token, beside a
 * place code was taken out, makes no mutant.
 * @param {PassTarget} target
 */
const canGate = target => target.gating === null || target.gating.length > 0;
// One list: what pass A gives Stryker to mutate is every target of each file a
// target can gate in (all of them, so two names of one file, which differ only
// in case, merge as one diff),
// and every run, each pass and rerun and each run with no mutant, is given
// exactly those files, so its run with no mutant checks each.
const mutated = () => targets.filter(target => targets.some(other => other.file === target.file && canGate(other)));
const changedFiles = () => [...new Set(mutated().map(target => target.file))];
/** @type {{ file: string, why: string }[]} */
let skipped = [];
let scope = opts.mutate.length > 0 ? `the patterns ${opts.mutate.join(' ')}` : `the change from ${opts.base} to the working tree`;
let emptyScope = false;
/** @type {MutantRecord[]} */
let mutants = [];
/** @type {string[]} */
const controls = [];
/** @type {Map<string, string[]>} */
const sources = new Map();

/** @param {string} file */
function linesOf(file) {
  if (!sources.has(file)) sources.set(file, fs.readFileSync(path.join(root, file), 'utf8').split('\n'));
  return sources.get(file) ?? [];
}

/**
 * @param {string} file
 * @param {Location} location
 */
function originalOf(file, location) {
  const first = linesOf(file)[location.start.line - 1] ?? '';
  const text = location.start.line === location.end.line
    ? first.slice(location.start.column - 1, location.end.column - 1)
    : `${first.slice(location.start.column - 1)} ...`;
  return text.length > 100 ? `${text.slice(0, 97)}...` : text;
}

/** @param {MutantRecord} m */
const recordKey = m => keyOf(m.file, m.mutator, m.replacement, m.location);
/** @param {MutantRecord} m */
const spanOf = m => `${m.file}:${m.location.start.line}:${m.location.start.column - 1}-${m.location.end.line}:${m.location.end.column - 1}`;

/**
 * The vitest reports one run left in a pass's dir.
 * @param {string} name
 * @param {string} id
 */
function reportsOf(name, id) {
  return ['fast', 'integration', 'child'].flatMap(project => {
    try { return [JSON.parse(fs.readFileSync(path.join(reportDir, name, `${id}-${project}.json`), 'utf8'))]; } catch { return []; }
  });
}

/**
 * What failed in the run with no mutant that a dir holds, a line per test file.
 * @param {string} name
 */
function dryFailures(name) {
  /** @type {string[]} */
  const lines = [];
  for (const report of reportsOf(name, 'dry')) for (const file of report.testResults ?? []) {
    if (file.status !== 'failed') continue;
    const failed = (file.assertionResults ?? []).filter((/** @type {{ status: string }} */ t) => t.status === 'failed');
    lines.push(`the run with no mutant failed in ${file.name}: ${(failed[0]?.failureMessages?.[0] ?? file.message ?? '').split('\n')[0]}`);
  }
  return lines;
}

/**
 * One pass's result for a mutant, as its stage saved it (results.jsonl), with
 * a kill checked against the reports.
 * @param {string} dir the pass's report dir
 * @param {{ id: string, status: string, statusReason?: string }} r
 * @param {boolean} [alone] a rerun of the mutant alone
 * @returns {PassResult}
 */
function resultOf(dir, r, alone = false) {
  /** @type {PassResult} */
  const result = { id: r.id, dir, status: r.status, ...(r.statusReason ? { statusReason: r.statusReason.split('\n')[0] } : {}) };
  // A type error only of an unused @ts-expect-error proves nothing: a gating one meets pass A's tests again, with no checker.
  if (r.status === 'CompileError' && onlyUnusedDirective(r.statusReason ?? '')) {
    return { ...result, inconclusive: 'a type error only because a @ts-expect-error went unused (TS2578), so no test ran on it' };
  }
  if (r.status === 'Survived' && ranNone(dir, r.id)) return { ...result, unreached: true };
  const bound = boundedDir(dir) ? endedByBound(r.status, boundMarkOf(dir, r.id), a2Dir(dir)) : null;
  if (bound) return { ...result, ...bound };
  return r.status === 'Killed' ? { ...result, ...classifyKill(reportsOf(dir, r.id), alone) } : result;
}

/**
 * What runner.mjs left in `<id>-bound.json` when it ended a run of pass A or
 * a2 at its bound: null when there is no such file, `{}` when it cannot be read.
 * @param {string} dir
 * @param {string} id
 * @returns {unknown}
 */
function boundMarkOf(dir, id) {
  const file = path.join(reportDir, dir, `${id}-bound.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) ?? {}; } catch { return {}; }
}

/**
 * Whether a mutant's run in pass A, its run with no checker, or pass B took no
 * test file, as no file reached it in the pass's run with no mutant
 * (runner.mjs, reach.mjs).
 * @param {string} dir
 * @param {string} id
 */
function ranNone(dir, id) {
  try {
    const { files } = JSON.parse(fs.readFileSync(path.join(reportDir, dir, `${id}-reach.json`), 'utf8'));
    return Array.isArray(files) && files.length === 0;
  } catch {
    return false;
  }
}

/**
 * The fast test files a mutant's run in pass A took (its `<id>-reach.json`),
 * which its rerun alone takes again: a file failed or timed out among them.
 * 'related' for every related file, when that run took them all or its record
 * cannot be read.
 * @param {MutantRecord} m
 * @returns {string[] | 'related'}
 */
function takenInA(m) {
  const a = m.passes.a;
  if (!a?.id || !a.dir) return 'related';
  try {
    const { files } = JSON.parse(fs.readFileSync(path.join(reportDir, a.dir, `${a.id}-reach.json`), 'utf8'));
    return Array.isArray(files) && files.length > 0 && files.every(file => typeof file === 'string') ? files : 'related';
  } catch {
    return 'related';
  }
}

class PassError extends Error {}

/**
 * A file a stage saved: its text, null when it is not there, or the problem
 * when it is there but cannot be read.
 * @param {string} dir
 * @param {string} name
 * @returns {{ text: string | null, problem: string }}
 */
function savedFile(dir, name) {
  try {
    return { text: fs.readFileSync(path.join(reportDir, dir, name), 'utf8'), problem: '' };
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    return code === 'ENOENT' ? { text: null, problem: '' } : { text: null, problem: `${dir}/${name} cannot be read (${code ?? firstLine(error)})` };
  }
}

/** @param {string} text */
const isDone = text => { try { const done = JSON.parse(text); return done !== null && typeof done === 'object'; } catch { return false; } };

/**
 * One dir of a Stryker stage as it is on disk (resume.mjs mutantDir).
 * @param {string} dir
 * @returns {(StageDir & { plan: import('./resume.mjs').PlannedMutant[] | null, subset: boolean }) | { problem: string }}
 */
function savedMutantDir(dir) {
  /** @type {Record<string, string | null>} */
  const text = {};
  for (const name of ['targets.json', PLAN_FILE, RESULTS_FILE, DONE_FILE]) {
    const read = savedFile(dir, name);
    if (read.problem) return { problem: read.problem };
    text[name] = read.text;
  }
  const listed = text['targets.json'];
  const keys = listed === null ? null : keysOf(listed);
  if (listed !== null && !keys) return { problem: `${dir}/targets.json cannot be read` };
  const plan = text[PLAN_FILE] === null ? null : planOf(/** @type {string} */ (text[PLAN_FILE]));
  if (text[PLAN_FILE] !== null && !plan) return { problem: `${dir}/${PLAN_FILE} cannot be read` };
  const { lines, problem } = resultLines(text[RESULTS_FILE] ?? '');
  if (problem) return { problem: `${dir}/${RESULTS_FILE}: ${problem}` };
  if (text[DONE_FILE] !== null && !isDone(/** @type {string} */ (text[DONE_FILE]))) return { problem: `${dir}/${DONE_FILE} cannot be read` };
  const d = mutantDir({ dir, targets: keys, plan, results: lines, done: text[DONE_FILE] !== null });
  return 'problem' in d ? d : { ...d, plan, subset: keys !== null };
}

/**
 * One dir of a check with no mutant as it is on disk: the items it ran for
 * (checks.json) and the lines `read` takes from checks.jsonl.
 * @param {(text: string) => { lines: { key: string }[], problem: string }} read
 * @returns {(dir: string) => StageDir | { problem: string }}
 */
const savedCheckDir = read => dir => {
  /** @type {Record<string, string | null>} */
  const text = {};
  for (const name of [CHECKS_PLAN_FILE, CHECKS_FILE, DONE_FILE]) {
    const file = savedFile(dir, name);
    if (file.problem) return { problem: file.problem };
    text[name] = file.text;
  }
  const listed = text[CHECKS_PLAN_FILE];
  const forKeys = listed === null ? null : keysOf(listed);
  if (listed !== null && !forKeys) return { problem: `${dir}/${CHECKS_PLAN_FILE} cannot be read` };
  const { lines, problem } = read(text[CHECKS_FILE] ?? '');
  if (problem) return { problem: `${dir}/${CHECKS_FILE}: ${problem}` };
  if (text[DONE_FILE] !== null && !isDone(/** @type {string} */ (text[DONE_FILE]))) return { problem: `${dir}/${DONE_FILE} cannot be read` };
  return { dir, forKeys, lines, missing: [], done: text[DONE_FILE] !== null };
};

/** @type {Set<string>} the dirs of the stages this run has walked */
const walked = new Set();
// Set once this run starts its first stage: from then on nothing is refused, only stopped.
let ranNow = false;

/**
 * The dirs of stages a resume found that its walk did not reach: a stage after
 * the first one that did not finish, or one this run does not come to.
 */
const unwalked = () => fs.readdirSync(reportDir).filter(name => STAGE_DIR.test(name) && !walked.has(name)).sort();

/** A resume that has run nothing yet refuses a report dir that holds dirs of stages its walk did not reach. */
function refuseUnwalked() {
  const left = saved && !ranNow ? unwalked() : [];
  if (left.length > 0) refuse(`it holds dirs of stages that come after the first stage that did not finish, or that this run does not reach: ${left.join(', ')}`);
}

/**
 * A stage as its dirs left it (resume.mjs stageOf). A problem ends a resume
 * that has run nothing yet with a refusal, and stops a run that has.
 * @template {{ key: string }} L
 * @param {string} stage
 * @param {string[] | null} want
 * @param {(dir: string) => (StageDir & { plan?: import('./resume.mjs').PlannedMutant[] | null, subset?: boolean }) | { problem: string }} read
 * @returns {SavedStage<L>}
 */
function walkStage(stage, want, read) {
  const chain = chainOf(fs.readdirSync(reportDir), stage);
  for (const dir of chain) walked.add(dir);
  /** @param {string} problem */
  const fail = problem => {
    if (saved && !ranNow) refuse(problem);
    throw new PassError(`the saved results of ${stage} cannot be read: ${problem}`);
  };
  /** @type {SavedStage<L>['dirs']} */
  const dirs = [];
  for (const dir of chain) {
    const d = read(dir);
    if ('problem' in d) fail(d.problem);
    else dirs.push(d);
  }
  const s = /** @type {import('./resume.mjs').Stage<L> | { problem: string }} */ (stageOf(dirs, want));
  if ('problem' in s) fail(s.problem);
  const found = /** @type {import('./resume.mjs').Stage<L>} */ (s);
  if (saved && found.done) resumed.push(`${stage}: finished before this resume (${found.used.map(dir => `${dir}/`).join(', ')}); its ${found.settled.size} result(s) are read back, and none runs again`);
  return { ...found, chain, dirs };
}

/**
 * The dir a stage that has not finished runs its items in now, once a resume
 * has checked that no dir of a later stage is there.
 * @param {string} stage
 * @param {SavedStage<{ key: string }>} s
 */
function beginStage(stage, s) {
  refuseUnwalked();
  ranNow = true;
  const dir = nextDir(stage, s.chain, resumeN);
  walked.add(dir);
  if (s.settled.size > 0) {
    resumed.push(`${stage}: ${s.settled.size} result(s) kept (${s.used.filter(d => [...s.settled.values()].some(v => v.dir === d)).map(d => `${d}/`).join(', ')}); ${s.missing.length > 0 ? `the ${s.missing.length} with none run now in ${dir}/` : 'none is left to run'}`);
  } else if (saved && s.chain.length > 0 && s.targets) {
    resumed.push(`${stage}: ${s.chain.map(d => `${d}/`).join(', ')} saved no result, so its ${s.targets.length} item(s) run now in ${dir}/`);
  }
  return dir;
}

/**
 * Ends a stage that ran now: its saved results must cover every item it is
 * for, and then done.json goes in its dir, as its last act, synchronously, and
 * whole (written aside and renamed).
 * @template {{ key: string }} L
 * @param {string} stage
 * @param {string[] | null} want
 * @param {Parameters<typeof walkStage>[2]} read
 * @param {string} dir
 * @returns {SavedStage<L>}
 */
function finishStage(stage, want, read, dir) {
  const s = /** @type {SavedStage<L>} */ (walkStage(stage, want, read));
  if (s.missing.length > 0) throw new PassError(`${stage} in ${dir}/ ended with no saved result for ${s.missing.length} of the ${s.targets?.length ?? 0} item(s) it ran for`);
  const file = path.join(reportDir, dir, DONE_FILE);
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify({ finished: new Date().toISOString() })}\n`);
  fs.renameSync(`${file}.tmp`, file);
  return { ...s, done: true };
}

/** @type {Options} */
const common = {
  ...COMMON,
  commandRunner: { command: `"${process.execPath}" test/mutation/runner.mjs` },
  cleanTempDir: opts.keep ? false : 'always',
  // targets.mjs: in a pass on some of the mutants, the ids runner.mjs runs.
  plugins: ['@stryker-mutator/*', path.join(root, 'test', 'mutation', 'targets.mjs')],
};

/**
 * Runs Stryker once. `tier` picks the tests (runner.mjs): a for the fast
 * tier's tests related to every file the gate mutates (each mutant's run takes
 * those that reached it in the pass's run with no mutant, and in a2 those its
 * run in pass A took), b for the integration
 * tier's related tests and then the whole child tier (each mutant's run takes
 * those that reached it in pass B's run with no mutant); `only`, when given,
 * names the test files to run instead. A run `alone` (the reruns, a2 and b2,
 * and the runs with no mutant after them) gets four times the config's time
 * limits. `keys`, when given, are the mutants the pass is for: Stryker makes
 * every mutant its spans hold, and the others run no test (targets.mjs).
 * `sets`, when given, are sets of test files the run with no mutant runs each
 * in a vitest run of its own, within the set's bound in ms (aloneCheck,
 * setCheck).
 * @param {{ dir: string, tier: 'a' | 'b', mutate: string[], only?: string[], keys?: string[], alone?: boolean, sets?: { files: string[], ms: number }[], extra: Options }} run
 * @returns {Promise<StrykerResult[]>}
 */
async function stryker({ dir, tier, mutate, only = [], keys, alone = false, sets = [], extra }) {
  const out = path.join(reportDir, dir);
  fs.mkdirSync(out, { recursive: true });
  process.env.SMDB_MUTATION_PASS = tier;
  process.env.SMDB_MUTATION_CONFIRM = alone ? '1' : '';
  process.env.SMDB_MUTATION_SETS = sets.length > 0 ? JSON.stringify(sets) : '';
  process.env.SMDB_MUTATION_FILES = JSON.stringify(changedFiles());
  process.env.SMDB_MUTATION_ONLY = JSON.stringify(only);
  process.env.SMDB_MUTATION_OUT = out;
  process.env.SMDB_MUTATION_TARGETS = keys ? path.join(out, 'targets.json') : '';
  process.env.SMDB_MUTATION_RUN = keys ? path.join(out, 'run-ids.json') : '';
  process.env.SMDB_MUTATION_GATE_PID = String(process.pid);
  if (keys) fs.writeFileSync(path.join(out, 'targets.json'), JSON.stringify(keys));
  if (sandbox.unkept.length > 0) {
    throw new PassError(`the gate cannot give Stryker ${sandbox.unkept.join(', ')} for a sandbox, for it would read the name as a glob; rename it`);
  }
  const { Stryker } = await import('@stryker-mutator/core');
  return new Stryker({ ...common, ignorePatterns: sandbox.patterns, mutate, ...extra }).runMutationTest();
}

/**
 * Runs one Stryker pass (stryker()); one that cannot run stops the gate, with
 * what its run with no mutant said.
 * @param {{ dir: string, tier: 'a' | 'b', mutate: string[], only?: string[], keys?: string[], alone?: boolean, extra: Options }} run
 * @returns {Promise<StrykerResult[]>}
 */
async function pass(run) {
  try {
    return await stryker(run);
  } catch (error) {
    if (error instanceof PassError) throw error;
    const out = path.join(reportDir, run.dir);
    const lines = [`pass ${run.dir} could not run: ${firstLine(error)}`, ...dryFailures(run.dir), ...refusalIn(out)];
    if (fs.readdirSync(out).some(f => f.startsWith('dry-') && f.endsWith('.log'))) lines.push(`the run with no mutant logged to ${posix(path.relative(root, out))}/dry-*.log`);
    throw new PassError(lines.join('\n'));
  }
}

/**
 * Runs a pass's tests once more with no mutant after the reruns alone counted
 * a kill or a timeout: those count only if the tests still pass without a
 * mutant. It runs as the reruns did, a Stryker run of its own over their spans
 * (a fresh sandbox of the tree, the same code made and none of it active), that
 * ends after its run with no mutant (dryRunOnly). When the tests fail, a
 * machine or a container went bad during the reruns, so their results are
 * voided and the gate stops. When the reruns confirmed a timeout (`timed`),
 * the tests must also fit in the budget Stryker gave each rerun (control.mjs)
 * in each dir a timeout came from, or the machine was as slow as the mutants
 * seemed. Its outcome is saved before done.json (resume.mjs CONTROL_KEY), and a
 * resume reads it back.
 * @param {'a2' | 'b2'} after
 * @param {'a' | 'b'} tier
 * @param {MutantRecord[]} on
 * @param {string[]} only the test files the reruns ran, or none
 * @param {boolean} [timed]
 */
async function control(after, tier, on, only, timed = false) {
  const stage = `control-${after}`;
  const read = savedCheckDir(controlLines);
  let s = /** @type {SavedStage<ControlLine>} */ (walkStage(stage, [CONTROL_KEY], read));
  if (!s.done) {
    const dir = beginStage(stage, s);
    const out = path.join(reportDir, dir);
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, CHECKS_PLAN_FILE), JSON.stringify([CONTROL_KEY]));
    console.log(`L5: the same tests once with no mutant, to check the machine after pass ${after}`);
    let failed = '';
    try {
      const rerun = tier === 'a' ? PASSES.a2 : PASSES.b2;
      await stryker({ dir, tier, mutate: [...new Set(on.map(spanOf))], only, alone: true, extra: { ...rerun, dryRunOnly: true, dryRunTimeoutMinutes: controlBoundMinutes(rerun, only.length) } });
      const reruns = timed ? [...new Set(on.filter(m => outcome(m) === 'Timeout').map(m => m.passes[after]?.dir ?? after))] : [];
      for (const at of reruns) {
        failed = pastBudget(path.join(reportDir, at), out, PASSES.a2);
        if (failed) break;
      }
    } catch (error) {
      if (error instanceof PassError) throw error;
      failed = firstLine(error);
    }
    fs.appendFileSync(path.join(out, CHECKS_FILE), `${JSON.stringify({ key: CONTROL_KEY, failed })}\n`);
    s = finishStage(stage, [CONTROL_KEY], read, dir);
  }
  const { dir, line } = /** @type {{ dir: string, line: ControlLine }} */ (s.settled.get(CONTROL_KEY));
  const out = path.join(reportDir, dir);
  const logs = `${posix(path.relative(root, out))}/dry-*.log`;
  if (line.failed) {
    const why = `the run with no mutant after pass ${after} failed`;
    for (const m of on) {
      const result = m.passes[after];
      if (result) m.passes[after] = { ...result, voided: why };
    }
    const refusal = refusalIn(out);
    throw new PassError([
      refusal.length > 0 ? `${why}: it refused the files the reruns ran on` : `${why} (${line.failed}), so what its reruns counted cannot be told from the machine's failures`,
      ...dryFailures(dir), ...refusal, ...(fs.readdirSync(out).some(f => f.endsWith('.log')) ? [`its logs: ${logs}`] : []),
    ].join('\n'));
  }
  controls.push(`after pass ${after}: passed (${logs})`);
}

/**
 * Runs `sets` with no mutant, each in a vitest run of its own within its
 * bound, as a Stryker run of its own over `on`'s spans (a fresh sandbox, the
 * same code made and none of it active); runner.mjs saves a line per finished
 * set. One that cannot run stops the gate.
 * @param {string} dir
 * @param {MutantRecord[]} on
 * @param {{ files: string[], ms: number }[]} sets
 * @param {boolean} alone four times the config's time limits, as a2 ran
 * @param {string} what
 */
async function runSets(dir, on, sets, alone, what) {
  const out = path.join(reportDir, dir);
  try {
    await stryker({
      dir, tier: 'a', mutate: [...new Set(on.map(spanOf))], sets, alone,
      extra: { ...(alone ? PASSES.a2 : PASSES.a), checkers: [], concurrency: 1, dryRunOnly: true, dryRunTimeoutMinutes: setsBoundMinutes(sets) },
    });
  } catch (error) {
    if (error instanceof PassError) throw error;
    throw new PassError([`${what} could not run: ${firstLine(error)}`, ...refusalIn(out)].join('\n'));
  }
}

/**
 * A check of sets of test files with no mutant, as a stage: a resume reads
 * back one that finished and runs only the sets one that stopped has no line
 * for, in a dir of its own. A set the runner left no line for, in a run that
 * ended, left no result, and its line says so (code null), as a whole run
 * counts it. Returns each set's line and the dir it ran in, by setKey.
 * @param {string} stage
 * @param {MutantRecord[]} on
 * @param {{ files: string[], ms: number }[]} sets
 * @param {boolean} alone
 * @param {string} what
 * @returns {Promise<Map<string, { dir: string, line: SetLine }>>}
 */
async function setStage(stage, on, sets, alone, what) {
  const want = sets.map(set => setKey(set.files));
  const read = savedCheckDir(setLines);
  let s = /** @type {SavedStage<SetLine>} */ (walkStage(stage, want, read));
  if (!s.done) {
    const dir = beginStage(stage, s);
    const out = path.join(reportDir, dir);
    const missing = new Set(s.missing);
    const rest = sets.filter(set => missing.has(setKey(set.files)));
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, CHECKS_PLAN_FILE), JSON.stringify(rest.map(set => setKey(set.files))));
    if (rest.length > 0) {
      await runSets(dir, on, rest, alone, what);
      const have = new Set(setLines(readText(path.join(out, CHECKS_FILE)) ?? '').lines.map(line => line.key));
      for (const set of rest.filter(one => !have.has(setKey(one.files)))) fs.appendFileSync(path.join(out, CHECKS_FILE), `${JSON.stringify({ files: set.files, code: null, ms: null })}\n`);
    }
    s = finishStage(stage, want, read, dir);
  }
  return /** @type {Map<string, { dir: string, line: SetLine }>} */ (s.settled);
}

/**
 * Runs each test file that killed a mutant in pass A (or in its run with no
 * checker) alone, once, with no mutant: a mutant's run there took only the
 * files that reached it, so a file that fails on its own (for one, without
 * state a dropped file leaves behind) would count as a kill. runSets runs
 * each file as such a run takes files, at pass A's time limits. A kill whose
 * file failed there, or ran past its bound, is taken back (verdict.mjs
 * uncreditFailedAlone), and its mutant reruns alone in a2.
 * @param {MutantRecord[]} all
 */
async function aloneCheck(all) {
  const killed = killedInA(all);
  if (killed.size === 0) return;
  const files = [...killed.keys()];
  const on = [...killed.values()].flat();
  for (const m of on) /** @type {PassResult} */ (m.passes.a).pending = 'alone-a';
  console.log(`L5: each of the ${files.length} test file(s) that killed a mutant in pass A, alone with no mutant, so a kill counts only from a file that passes on its own`);
  const runs = await setStage('alone-a', on, files.map(file => ({ files: [file], ms: setBoundMs(1, 1) })), false, 'the run of each file that killed a mutant in pass A, alone with no mutant,');
  /** @param {string} file */
  const runOf = file => /** @type {{ dir: string, line: SetLine }} */ (runs.get(setKey([file])));
  const dirs = [...new Set(files.map(file => runOf(file).dir))];
  /** @type {Map<string, string>} */
  const taken = new Map();
  for (const dir of dirs) {
    const here = new Map([...killed].filter(([file]) => runOf(file).dir === dir));
    const codes = Object.fromEntries([...here.keys()].map(file => [file, runOf(file).line.code ?? undefined]));
    for (const [file, why] of uncreditFailedAlone(here, codes, dir)) taken.set(file, why);
  }
  for (const m of on) delete /** @type {PassResult} */ (m.passes.a).pending;
  const logs = dirs.map(dir => `${posix(path.relative(root, path.join(reportDir, dir)))}/dry-alone-*.log`).join(', ');
  controls.push(`after pass A, each file that killed a mutant there, alone: ${files.length - taken.size} of ${files.length} passed (${logs})`);
  for (const [file, why] of taken) controls.push(`  ${file}: ${why}, so its ${killed.get(file)?.length} kill(s) in pass A do not count and rerun alone in a2`);
}

/**
 * The fast test files a mutant's a2 run took, from its `<id>-reach.json`
 * there: 'related' for every related file, null when it cannot be read.
 * @param {MutantRecord} m
 * @returns {string[] | 'related' | null}
 */
function takenInA2(m) {
  const a2 = m.passes.a2;
  if (!a2?.id || !a2.dir) return null;
  try {
    const { files } = JSON.parse(fs.readFileSync(path.join(reportDir, a2.dir, `${a2.id}-reach.json`), 'utf8'));
    if (files === 'related') return 'related';
    return Array.isArray(files) && files.length > 0 && files.every(file => typeof file === 'string') ? files : null;
  } catch {
    return null;
  }
}

/**
 * Runs, with no mutant, each set of fast test files an a2 kill or timeout ran
 * on when that was fewer than every related file, which the run with no mutant
 * after the reruns took: a file of the set can fail or hang there without
 * state a dropped file leaves behind, and a2 would count it. Each set runs once
 * in a vitest run of its own, as a2 ran it (runSets, a2's time limits). A
 * result whose set failed there, left no result, ran past its bound, or (for a
 * timeout) took longer than the budget that rerun had (the set's own, from
 * the costs of the a2 dir it ran in, for one the runner ended; Stryker's there
 * for one Stryker ended), is voided (verdict.mjs voidFailedSets), and its
 * mutant is inconclusive.
 * @param {MutantRecord[]} on
 */
async function setCheck(on) {
  const sets = bySet(on, takenInA2);
  if (sets.length === 0) return;
  for (const m of sets.flatMap(set => set.on)) /** @type {PassResult} */ (m.passes.a2).pending = 'alone-a2';
  const runnable = /** @type {{ files: string[], on: MutantRecord[] }[]} */ (sets.filter(set => set.files !== null));
  console.log(`L5: each of the ${sets.length} set(s) of fast test files an a2 kill or timeout ran on, once with no mutant, so a result counts only from a set that passes without it`);
  const runs = runnable.length === 0 ? new Map() : await setStage('alone-a2', runnable.flatMap(set => set.on), runnable.map(set => ({ files: set.files, ms: setBoundMs(set.files.length, 4) })), true,
    'the run of each set of files an a2 result ran on, with no mutant,');
  /** @param {MutantRecord} m */
  const a2At = m => m.passes.a2?.dir ?? 'a2';
  /** @type {Map<string, import('./reach.mjs').Costs | null>} */
  const costs = new Map();
  /** @param {string} dir */
  const costsIn = dir => {
    if (!costs.has(dir)) costs.set(dir, readCosts(path.join(reportDir, dir)));
    return costs.get(dir) ?? null;
  };
  /** @param {MutantRecord} m */
  const budget = m => strykerBudget(a2At(m), PASSES.a2);
  /**
   * @param {string[]} files
   * @param {MutantRecord} m
   */
  const ownBudget = (files, m) => boundFor(costsIn(a2At(m)), files, A2_BOUND) ?? NaN;
  const lines = [...runs.values()].map(({ dir, line }) => ({ ...line, dir }));
  const { lines: why, voided } = voidFailedSets(sets, lines, 'alone-a2', budget, ownBudget);
  for (const m of sets.flatMap(set => set.on)) delete /** @type {PassResult} */ (m.passes.a2).pending;
  const dirs = [...new Set(lines.map(line => line.dir))];
  controls.push(`after pass a2, each set of files an a2 result ran on, with no mutant: ${sets.length - voided} of ${sets.length} held (${dirs.map(dir => `${posix(path.relative(root, path.join(reportDir, dir)))}/dry-alone-*.log`).join(', ') || 'none ran'})`);
  for (const line of why) controls.push(`  ${line}`);
}

/**
 * The budget, in ms, Stryker gave each mutant run of the pass in `dir`, as it
 * built it from that pass's run with no mutant; NaN when its time could not be
 * read or its clock stepped (control.mjs strykerClock).
 * @param {string} dir
 * @param {{ timeoutFactor: number, timeoutMS: number }} pass
 */
function strykerBudget(dir, { timeoutFactor, timeoutMS }) {
  const { clock, net, overhead } = strykerClock(path.join(reportDir, dir));
  return clock ? NaN : timeoutFactor * net + timeoutMS + overhead;
}

/**
 * runner.mjs's refusal of the files a run with no mutant was given (a way to a
 * fixed root, ranges.mjs DATA_ROUTE_WHY, or a file it could not read), if it
 * refused them.
 * @param {string} dir the run's report dir
 * @returns {string[]}
 */
function refusalIn(dir) {
  try { return [fs.readFileSync(path.join(dir, 'dry-refused.txt'), 'utf8').trim()]; } catch { return []; }
}

/** @param {MutantRecord} m */
const credited = m => ['Killed', 'Timeout'].includes(outcome(m));

/**
 * Runs a pass on exactly the given mutants, as a stage, and records its
 * results on them from what the stage saved (results.jsonl): a resume reads
 * back a stage that finished, and runs only the mutants one that stopped has
 * no result for, in a dir of its own, so no mutant runs twice in a stage.
 * @param {PassName} name
 * @param {string} stage the stage's dir name
 * @param {'a' | 'b'} tier
 * @param {MutantRecord[]} on
 * @param {Options} extra
 * @param {string[]} [only]
 */
async function passOn(name, stage, tier, on, extra, only) {
  const alone = name === 'a2' || name === 'b2';
  const want = on.map(recordKey);
  let s = /** @type {SavedStage<SavedResult>} */ (walkStage(stage, want, savedMutantDir));
  if (!s.done) {
    const dir = beginStage(stage, s);
    const missing = new Set(s.missing);
    const rest = on.filter(m => missing.has(recordKey(m)));
    fs.mkdirSync(path.join(reportDir, dir), { recursive: true });
    if (name === 'a2') fs.writeFileSync(path.join(reportDir, dir, TAKEN_FILE), JSON.stringify(Object.fromEntries(rest.map(m => [recordKey(m), takenInA(m)]))));
    if (rest.length > 0) await pass({ dir, tier, mutate: [...new Set(rest.map(spanOf))], only, keys: rest.map(recordKey), alone, extra });
    else fs.writeFileSync(path.join(reportDir, dir, 'targets.json'), '[]');
    s = finishStage(stage, want, savedMutantDir, dir);
  }
  for (const m of on) {
    const { dir, line } = /** @type {{ dir: string, line: SavedResult | null }} */ (s.settled.get(recordKey(m)));
    m.passes[name] = line ? resultOf(dir, line, alone) : { id: null, dir, status: 'Missing' };
  }
  for (const dir of s.used) clockOfTimeouts(name, dir, on.filter(m => m.passes[name]?.dir === dir));
}

/**
 * A timeout in pass B or a b2 rerun counts against its mutant with no run
 * after it to clear it, so it stands on the budget Stryker built from that
 * pass's own run with no mutant, which a clock step during that run makes
 * meaningless: the gate then stops. `on` are the mutants whose `name` result
 * came from `dir`.
 * @param {PassName} name
 * @param {string} dir
 * @param {MutantRecord[]} on
 */
function clockOfTimeouts(name, dir, on) {
  if ((name === 'b' || name === 'b2') && on.some(m => m.passes[name]?.status === 'Timeout')) {
    const { clock } = strykerClock(path.join(reportDir, dir));
    if (clock) {
      const why = clock === 'unread'
        ? `the time of pass ${dir}'s run with no mutant could not be read`
        : `Stryker's own time for pass ${dir}'s run with no mutant does not match that run's monotonic time, so the clock of Stryker's process stepped and the budget it gave each run there was not what that run took`;
      for (const m of on) {
        const result = m.passes[name];
        if (result) m.passes[name] = { ...result, voided: why };
      }
      throw new PassError(`a run in pass ${dir} timed out, but ${why}, so the timeout says nothing of the mutant`);
    }
  }
}

/**
 * The verdict, the report files and the exit, once the report has reached
 * stdout: awaited, it never settles, so nothing runs after it.
 * @param {string[]} [stopped]
 * @returns {Promise<never>}
 */
function finish(stopped) {
  try {
    report(stopped, [...treeChanges(planned, treePrint(root, treeFiles())), ...treeChanges(packages, treePrint(root, PACKAGE_LOCKS))].sort());
  } catch (error) {
    console.log(`Verdict: NO RESULT (the report could not be written: ${firstLine(error)})`);
    process.exit(2);
  }
  return new Promise(() => {});
}

/**
 * A resume writes its own report in the stopped run's dir: an earlier one
 * there (a run that stopped with a report, or an earlier resume's) is moved to
 * a name of its own, never written over.
 * @param {string} name
 */
function keepEarlier(name) {
  const file = path.join(reportDir, name);
  if (!fs.existsSync(file)) return;
  const { name: base, ext } = path.parse(name);
  let to = path.join(reportDir, `${base}-before-r${resumeN}${ext}`);
  for (let n = 1; fs.existsSync(to); n++) to = path.join(reportDir, `${base}-before-r${resumeN}-${n}${ext}`);
  fs.renameSync(file, to);
}

/**
 * @param {string[] | undefined} stopped
 * @param {string[]} treeChanged
 */
function report(stopped, treeChanged) {
  /** @type {{ file: string, lines: number[] }[]} */
  const noMutant = [];
  /** @type {{ file: string, lines: number[] }[]} */
  const brackets = [];
  /** @type {{ file: string, lines: number[] }[]} */
  const deleted = [];
  const unmatched = stopped && mutants.length === 0 ? [] : unmatchedPatterns(targets, mutants);
  for (const target of targets) {
    const made = mutants.filter(m => m.file === target.file);
    if (stopped && mutants.length === 0) continue;
    let text;
    try {
      text = linesOf(target.file).join('\n');
    } catch (error) {
      // Deleted during the run: the tree check names it.
      if (treeChanged.length > 0) continue;
      throw error;
    }
    const moved = target.gating ? structureLines(target.file, text, target.gating) : [];
    if (moved.length > 0) brackets.push({ file: target.file, lines: moved });
    if (target.deleted) deleted.push({ file: target.file, lines: target.deleted });
    /** @type {[number, number][]} */
    const spans = made.map(m => [m.location.start.line, m.location.end.line]);
    const lines = untouched(target.file, text, linesOfTarget(target, text.split('\n').length), spans);
    if (lines.length > 0) noMutant.push({ file: target.file, lines });
  }
  const seed = process.env.SMDB_TEST_SEED;
  const result = judge({
    stamp, scope: `${scope}; fast-check seed ${seed}`, emptyScope, skipped, mutants, noMutant, brackets, deleted, unmatched, report: posix(path.relative(root, reportDir)), stopped, treeChanged, controls,
    resumed, standIn: process.env.SMDB_MUTATION_VITEST,
  });
  fs.mkdirSync(reportDir, { recursive: true });
  for (const name of saved ? ['mutants.json', 'summary.txt'] : []) keepEarlier(name);
  fs.writeFileSync(path.join(reportDir, 'mutants.json'), `${JSON.stringify({ scope, seed, ...(saved ? { resume: resumeN, resumed } : {}), skipped, targets, mutants, controls, verdict: result.verdict, stopped, treeChanged }, null, 2)}\n`);
  fs.writeFileSync(path.join(reportDir, 'summary.txt'), `${result.lines.join('\n')}\n`);
  // On POSIX a pipe takes stdout asynchronously: exit only once it has all of it.
  process.stdout.write(`${result.lines.join('\n')}\n`, () => process.exit(result.code));
}

try {
  // What to mutate: the explicit patterns (every mutant gates), or the change
  // from the merge-base of --base and HEAD to the working tree.
  /** @type {{ base: string, mergeBase: string } | { mutate: string[] }} */
  let runScope = { mutate: opts.mutate };
  if (opts.mutate.length > 0) {
    targets = opts.mutate.map(pattern => ({ file: fileOfPattern(pattern), patterns: [pattern], gating: null }));
  } else {
    const label = saved && 'base' in saved.scope ? saved.scope.base : opts.base;
    const base = saved && 'mergeBase' in saved.scope ? saved.scope.mergeBase : git('merge-base', opts.base, 'HEAD').trim();
    ({ targets, skipped, emptyScope } = planFromGit({ git, base, root, read: file => linesOf(file).join('\n') }));
    scope = `the change from ${label} (merge-base ${base.slice(0, 7)}) to the working tree`;
    runScope = { base: label, mergeBase: base };
  }
  if (saved) {
    if (JSON.stringify(targets) !== JSON.stringify(saved.targets)) {
      refuse(`the plan made now from its scope (${scope}) differs from the targets it saved, so its results are not for these targets`);
    }
    fs.writeFileSync(path.join(reportDir, `resume-r${resumeN}.json`), `${JSON.stringify({ started: new Date().toISOString(), concurrency: opts.concurrency, keep: opts.keep })}\n`);
  }
  // Nothing that could gate (only places where code was taken out): the report names them, and Stryker is never
  // given an empty list to mutate.
  if (!targets.some(canGate)) await finish();

  console.log(`L5: ${saved ? `resuming the run in ${posix(path.relative(root, reportDir))}, ` : ''}mutating ${scope}: ${changedFiles().length} file(s), pass A (in-process tests that import them)`);
  // The type checker judges the tree's files only (ranges.mjs treeTsconfig, beyondTree), with the TypeScript and
  // the packages the root lockfile ships (checkerDiffers).
  const compiler = checkerDiffers(root);
  if (compiler) throw new PassError(compiler);
  const checkerConfig = `.stryker-tmp/tsconfig.l5-${process.pid}.json`;
  const checker = treeTsconfig(root, planned.keys(), '.stryker-tmp');
  const beyond = beyondTree(root, planned.keys(), checker, '.stryker-tmp');
  if (beyond.length > 0) {
    throw new PassError(`the type checker would judge ${beyond.join(', ')}, which a file in the tree imports or references but no sandbox holds, so a mutant that broke only it would count as killed with no test run; make the tree's file stop importing or referencing it, or add it to the tree if it belongs there`);
  }
  // Saved before pass A starts, so a run that stops can be resumed (README, "Stopping and resuming"); the lock first,
  // so no resume takes the dir while this run uses it.
  if (!saved) {
    try {
      fs.mkdirSync(reportDir, { recursive: true });
    } catch (error) {
      throw new PassError(`the gate could not make its report dir: ${firstLine(error)}`);
    }
    takeLock(reportDir, why => { throw new PassError(`the gate could not take its report dir: ${why}`); });
    try {
      fs.writeFileSync(path.join(reportDir, RUN_FILE), `${JSON.stringify({ tree: [...planned], packages: [...packages], scope: runScope, targets, seed: process.env.SMDB_TEST_SEED, setup })}\n`);
    } catch (error) {
      throw new PassError(`the gate could not write ${RUN_FILE}, which a resume reads: ${firstLine(error)}`);
    }
  }
  /**
   * @param {string} file
   * @param {Location} location
   * @param {string} mutator
   * @param {string} replacement
   * @returns {MutantRecord}
   */
  const recordOf = (file, location, mutator, replacement) => ({
    file, location, mutator, original: originalOf(file, location), replacement, gating: gatesIn(targets, file, location), passes: {},
  });
  /** @param {string[]} files */
  const orphansOf = files => {
    const orphans = [...new Set(files.filter(file => !targets.some(t => t.file === file)))];
    if (orphans.length > 0) throw new PassError(`Stryker mutated ${orphans.join(', ')}, which no target names, so the report could not answer for it`);
  };
  /**
   * Pass A's plan: that of the first of its dirs that knew its mutants, which ran on every mutant.
   * @param {SavedStage<SavedResult>} s
   */
  const planIn = s => {
    const first = s.dirs.find(d => d.forKeys !== null);
    if (!first) return null;
    if (first.subset || !first.plan) {
      const why = `${first.dir}/, the first run of pass A that knew its mutants, ran on only some of them, so no plan names them all`;
      if (saved && !ranNow) refuse(why);
      throw new PassError(why);
    }
    return first.plan;
  };
  // Pass A: every mutant Stryker makes, in plan order; on a resume, only those
  // its plan holds with no saved result, in a dir of its own.
  let stageA = /** @type {SavedStage<SavedResult>} */ (walkStage('a', null, savedMutantDir));
  if (!stageA.done) {
    const known = planIn(stageA);
    const dirA = beginStage('a', stageA);
    fs.writeFileSync(path.join(root, checkerConfig), `${JSON.stringify(checker, null, 2)}\n`);
    try {
      const extraA = { ...PASSES.a, concurrency: opts.concurrency, tsconfigFile: checkerConfig };
      if (!known) {
        if (saved) resumed.push(`a: the stopped run saved no plan of pass A, so it runs whole in ${dirA}/`);
        await pass({ dir: dirA, tier: 'a', mutate: mutatePatterns(mutated()), extra: extraA });
      } else {
        const missing = new Set(stageA.missing);
        const rest = known.filter(m => missing.has(m.key)).map(m => recordOf(m.file, m.location, m.mutator, m.replacement));
        fs.mkdirSync(path.join(reportDir, dirA), { recursive: true });
        if (rest.length > 0) {
          console.log(`L5: pass A on the ${rest.length} mutant(s) the stopped run has no result for`);
          await pass({ dir: dirA, tier: 'a', mutate: [...new Set(rest.map(spanOf))], keys: rest.map(recordKey), extra: extraA });
        } else {
          fs.writeFileSync(path.join(reportDir, dirA, 'targets.json'), '[]');
        }
      }
    } finally {
      fs.rmSync(path.join(root, checkerConfig), { force: true });
    }
    stageA = finishStage('a', null, savedMutantDir, dirA);
  }
  const planA = /** @type {import('./resume.mjs').PlannedMutant[]} */ (planIn(stageA) ?? []);
  orphansOf(planA.map(m => m.file));
  mutants = planA.map(m => recordOf(m.file, m.location, m.mutator, m.replacement));
  for (const m of mutants) {
    const { dir, line } = /** @type {{ dir: string, line: SavedResult | null }} */ (stageA.settled.get(recordKey(m)));
    m.passes.a = line ? resultOf(dir, line) : { id: null, dir, status: 'Missing' };
  }

  // Their run with no checker is their pass A, and they go on from it like any other.
  const unchecked = toUncheck(mutants);
  if (unchecked.length > 0) {
    console.log(`L5: pass A again, with no type checker, on ${unchecked.length} mutant(s) whose only type error is an unused @ts-expect-error`);
    await passOn('a', 'a-unchecked', 'a', unchecked, { ...PASSES.a, checkers: [], concurrency: opts.concurrency });
  }
  await aloneCheck(mutants);

  const confirmA = toConfirm(mutants, 'a');
  if (confirmA.length > 0) {
    console.log(`L5: pass A again, one at a time, on ${confirmA.length} mutant(s) to confirm alone: timeouts, and runs that failed only on the machine's texts`);
    await passOn('a2', 'a2', 'a', confirmA, PASSES.a2);
    if (confirmA.some(credited)) await control('a2', 'a', confirmA, [], confirmA.some(m => outcome(m) === 'Timeout'));
    await setCheck(confirmA);
  }

  const forB = toPassB(mutants);
  if (forB.length > 0) {
    console.log(`L5: pass B (integration tests that import the mutated files, then every child scenario) on ${forB.length} survivor(s)`);
    await passOn('b', 'b', 'b', forB, PASSES.b);
    const confirmB = toConfirm(mutants, 'b');
    const killers = byKiller(confirmB);
    let group = 0;
    for (const [killer, on] of killers) {
      group += 1;
      console.log(`L5: pass B again, one at a time, on ${on.length} mutant(s) whose run failed in ${killer}, with that file alone; a failure counts only if it repeats`);
      await passOn('b2', `b2-${group}`, 'b', on, PASSES.b2, [killer]);
    }
    if (confirmB.some(credited)) await control('b2', 'b', confirmB, [...killers.keys()]);
  }
  refuseUnwalked();
  await finish();
} catch (error) {
  refuseUnwalked();
  await finish(error instanceof PassError ? error.message.split('\n') : [`the gate stopped: ${firstLine(error)}`]);
}
