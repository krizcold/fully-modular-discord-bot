// The Stryker options of each pass (mutation/README.md, "The passes"), beyond
// the mutate patterns and the concurrency touched.mjs gives them.
import path from 'path';
import { fileURLToPath } from 'url';

// What every pass shares. configFile names an empty file, so Stryker never
// reads a config file it would otherwise find in the bot root (an inPlace, a
// buildCommand or an excluded mutator there would apply to every pass).
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export const COMMON = {
  configFile: path.join(path.dirname(fileURLToPath(import.meta.url)), 'stryker.json'),
  inPlace: false,
  testRunner: 'command',
  coverageAnalysis: 'off',
  tsconfigFile: 'tsconfig.json',
  tempDirName: '.stryker-tmp',
  incremental: false,
  reporters: ['progress', 'smdb-targets'],
  logLevel: /** @type {import('@stryker-mutator/api/core').LogLevel} */ ('warn'),
};

const BUILD = { buildCommand: 'node test/helpers/build.cjs', checkers: [] };

export const PASSES = {
  // Their run with no mutant runs every fast test importing a mutated file, one worker: one took 27.9 minutes on a
  // busy machine, and a run past this bound ends the gate NO RESULT before any mutant runs.
  a: { checkers: ['typescript'], timeoutMS: 10_000, timeoutFactor: 2, dryRunTimeoutMinutes: 60 },
  a2: { checkers: [], concurrency: 1, timeoutMS: 60_000, timeoutFactor: 4, dryRunTimeoutMinutes: 60 },
  // One at a time, as its run with no mutant is made: Stryker builds each run's
  // budget from that run, and a hang in pass B stands with no rerun to clear it.
  // Its run with no mutant takes every related integration file and the whole
  // child tier on one worker, more than an hour for a change to widely imported
  // files, and one past this bound ends the gate NO RESULT before any survivor runs.
  // The bound leaves room for a child test and its hooks to hang at four times
  // their limits, so vitest's report names the file before Stryker ends the run.
  b: { ...BUILD, concurrency: 1, timeoutMS: 60_000, timeoutFactor: 2, dryRunTimeoutMinutes: 180 },
  // A pass B failure rerun with one file: an hour is above anything vitest's own
  // limits let that file take after its first failure (the rest of a child
  // test, then its hooks), so a rerun that fails always leaves its report.
  b2: { ...BUILD, concurrency: 1, timeoutMS: 60 * 60_000, timeoutFactor: 4, dryRunTimeoutMinutes: 15 },
};

/**
 * The bound on a mutant's run in pass A (and in pass A with no checker) that
 * takes named fast test files (runner.mjs): `factor` times the sum of what
 * those files cost in the pass's run with no mutant (reach.mjs costsOf), plus
 * `startMs` for vitest to start and end. Stryker's own limit on such a run is
 * twice that whole run plus ten seconds, however few files it takes, so a
 * mutant that blocks the event loop (which vitest's own limits cannot end)
 * would hold its slot for the length of every related file. Three times leaves
 * room for a busy machine; a run past it counts as a timeout, never a kill,
 * and a gating one reruns alone in a2.
 */
export const RUN_BOUND = { factor: 3, startMs: 120_000 };

/**
 * The budget of an a2 rerun that takes named fast test files (runner.mjs): the
 * formula Stryker uses for the whole pass, on what those files cost in a2's own
 * run with no mutant (reach.mjs writeCosts), and the budget of the set of those
 * files when it runs with no mutant (touched.mjs setCheck).
 */
export const A2_BOUND = { factor: PASSES.a2.timeoutFactor, startMs: PASSES.a2.timeoutMS };

// Node's limit on a timer: a longer one fires at once.
export const TIMER_LIMIT_MS = 2 ** 31 - 1;
// Stryker hands its bound's minutes * 60,000 to a timer.
export const MAX_BOUND_MINUTES = Math.floor(TIMER_LIMIT_MS / 60_000);

/**
 * The bound, in minutes, on the run with no mutant after a pass's reruns
 * alone (touched.mjs control()): above the largest budget Stryker can give a
 * rerun (timeoutFactor times a run with no mutant inside its own bound, plus
 * timeoutMS) and five minutes for Stryker's overhead, so the budget, not the
 * bound, judges that run's time. That run takes every file `files` reruns
 * took, one each (control-b2: every file that failed in pass B), so the bound
 * is that budget times their number, capped at MAX_BOUND_MINUTES.
 * @param {{ timeoutFactor: number, timeoutMS: number, dryRunTimeoutMinutes: number }} rerun
 * @param {number} [files]
 */
export const controlBoundMinutes = ({ timeoutFactor, timeoutMS, dryRunTimeoutMinutes }, files = 1) =>
  Math.min(MAX_BOUND_MINUTES, Math.ceil(Math.max(1, files) * (timeoutFactor * dryRunTimeoutMinutes + timeoutMS / 60_000)) + 5);

/**
 * The factor runner.mjs gives the config's time limits (SMDB_TEST_TIME_SCALE,
 * helpers/time.mjs) in a rerun alone and in every run with no mutant; a
 * mutant's run in pass A or B gets 1.
 */
export const ALONE_TIME_SCALE = 4;

/**
 * The bound, in ms, on one vitest run with no mutant of `files` fast test
 * files, in the runs that check what a pass counted (touched.mjs aloneCheck
 * and setCheck): per file, the config's hook limit for a beforeAll and an
 * afterAll and its test limit (vitest.config.ts) at ALONE_TIME_SCALE, plus a
 * minute to start. A run past it ends, with every process it started, and
 * counts as failed. It is capped at TIMER_LIMIT_MS, since runner.mjs gives it to a timer.
 * @param {number} files
 */
export const setBoundMs = files => Math.min(TIMER_LIMIT_MS, Math.max(1, files) * ALONE_TIME_SCALE * (2 * 180_000 + 30_000) + 60_000);

/**
 * Stryker's bound, in minutes, on a run with no mutant that runs each of
 * `sets` in a vitest run of its own: the sum of their bounds and five minutes
 * for Stryker's overhead, so a set's own bound, not Stryker's, ends a hang.
 * It is capped at MAX_BOUND_MINUTES, which loses nothing for that reason.
 * @param {{ ms: number }[]} sets
 */
export const setsBoundMinutes = sets => Math.min(MAX_BOUND_MINUTES, Math.ceil(sets.reduce((sum, set) => sum + set.ms, 0) / 60_000) + 5);
