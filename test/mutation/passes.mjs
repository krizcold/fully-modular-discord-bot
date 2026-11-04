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

const BUILD = { buildCommand: 'node test/helpers/build.cjs', checkers: [], dryRunTimeoutMinutes: 15 };

export const PASSES = {
  // Its run with no mutant runs every fast test importing a mutated file: can pass 5 min.
  a: { checkers: ['typescript'], timeoutMS: 10_000, timeoutFactor: 2, dryRunTimeoutMinutes: 30 },
  a2: { checkers: [], concurrency: 1, timeoutMS: 60_000, timeoutFactor: 4, dryRunTimeoutMinutes: 30 },
  // One at a time, as its run with no mutant is made: Stryker builds each run's
  // budget from that run, and a hang in pass B stands with no rerun to clear it.
  b: { ...BUILD, concurrency: 1, timeoutMS: 60_000, timeoutFactor: 2 },
  // A pass B failure rerun with one file: an hour is above anything vitest's own
  // limits let that file take after its first failure (the rest of a child
  // test, then its hooks), so a rerun that fails always leaves its report.
  b2: { ...BUILD, concurrency: 1, timeoutMS: 60 * 60_000, timeoutFactor: 4 },
};

/**
 * The bound, in minutes, on the run with no mutant after a pass's reruns
 * alone (touched.mjs control()): above the largest budget Stryker can give a
 * rerun (timeoutFactor times a run with no mutant inside its own bound, plus
 * timeoutMS) and five minutes for Stryker's overhead, so the budget, not the
 * bound, judges that run's time. That run takes every file `files` reruns
 * took, one each (control-b2: every file that failed in pass B), so the bound
 * is that budget times their number.
 * @param {{ timeoutFactor: number, timeoutMS: number, dryRunTimeoutMinutes: number }} rerun
 * @param {number} [files]
 */
export const controlBoundMinutes = ({ timeoutFactor, timeoutMS, dryRunTimeoutMinutes }, files = 1) =>
  Math.ceil(Math.max(1, files) * (timeoutFactor * dryRunTimeoutMinutes + timeoutMS / 60_000)) + 5;

/**
 * The bound, in ms, on one vitest run with no mutant of `files` fast test
 * files at time scale `scale`, in the runs that check what a pass counted
 * (touched.mjs aloneCheck and setCheck): per file, the config's hook limit for
 * a beforeAll and an afterAll and its test limit (vitest.config.ts), plus a
 * minute to start. A run past it ends, with every process it started, and
 * counts as failed.
 * @param {number} files
 * @param {number} scale
 */
export const setBoundMs = (files, scale) => Math.max(1, files) * scale * (2 * 180_000 + 30_000) + 60_000;

/**
 * Stryker's bound, in minutes, on a run with no mutant that runs each of
 * `sets` in a vitest run of its own: the sum of their bounds and five minutes
 * for Stryker's overhead, so a set's own bound, not Stryker's, ends a hang.
 * @param {{ ms: number }[]} sets
 */
export const setsBoundMinutes = sets => Math.ceil(sets.reduce((sum, set) => sum + set.ms, 0) / 60_000) + 5;
