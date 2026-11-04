// Which fast test files a mutant run of pass A takes (runner.mjs): the run with
// no mutant loads helpers/mutationCoverage.ts in every test file, which leaves
// the mutant ids that file's run reached; each mutant run then takes the files
// that reached it, every file whose reach is unknown, and nothing else.
// A rerun alone (a2) of a mutant takes the files its run in pass A took.
import fs from 'fs';
import path from 'path';

/**
 * @typedef {{ files: string[], unsure: number[], reached: Record<string, number[]> }} Reach files: the test files the
 *   run with no mutant ran, relative to test/; unsure: the indexes of those whose reach is unknown, which every mutant
 *   run takes; reached: per mutant id, the indexes of the files that reached it
 * @typedef {{ file?: unknown, ids?: unknown, unsure?: unknown }} CoverageRecord what mutationCoverage.ts leaves
 */

// The dir, under a pass's report dir, where the run with no mutant leaves one record per test file.
export const COVERAGE_DIR = 'dry-coverage';
// The reach that run leaves for the mutant runs after it.
export const REACH_FILE = 'dry-reach.json';
// In a2's dir: per mutant key, the files its run in pass A took (touched.mjs).
export const TAKEN_FILE = 'taken.json';
// In a pass's dir: per mutant id, its key (targets.mjs).
export const RUN_KEYS_FILE = 'run-keys.json';

/**
 * @param {string} testDir
 * @param {string} file a test file's absolute path, as vitest gives it
 */
export const testName = (testDir, file) => path.relative(testDir, path.resolve(testDir, file)).split(path.sep).join('/');

/**
 * The reach of a run with no mutant: the test files its vitest report lists,
 * each with the ids its record names. A file with no record, or a record that
 * is unsure or unreadable, is unsure.
 * @param {string} testDir
 * @param {string[]} ran the test files vitest's report lists, absolute
 * @param {CoverageRecord[]} records
 * @returns {Reach}
 */
export function reachOf(testDir, ran, records) {
  /** @type {Map<string, string[] | null>} */
  const byFile = new Map();
  for (const record of records) {
    if (typeof record?.file !== 'string') continue;
    const name = testName(testDir, record.file);
    const ids = Array.isArray(record.ids) && record.ids.every(id => typeof id === 'string') && record.unsure === undefined ? record.ids : null;
    // Two records of one file (it ran twice): only both sure, merged, are sure.
    const before = byFile.get(name);
    byFile.set(name, before === undefined ? ids : before && ids ? [...before, ...ids] : null);
  }
  const files = [...new Set(ran.map(file => testName(testDir, file)))];
  /** @type {number[]} */
  const unsure = [];
  /** @type {Record<string, number[]>} */
  const reached = {};
  files.forEach((name, index) => {
    const ids = byFile.get(name);
    if (!ids) { unsure.push(index); return; }
    for (const id of new Set(ids)) {
      if (!Object.hasOwn(reached, id)) reached[id] = [];
      reached[id].push(index);
    }
  });
  return { files, unsure, reached };
}

/**
 * Builds the reach from what the run with no mutant left in `out` (its fast
 * report and its coverage records) and writes it there. No report, or one
 * that lists no file, leaves no reach, so every mutant run takes every
 * related file.
 * @param {string} out the pass's report dir
 * @param {string} testDir
 */
export function writeReach(out, testDir) {
  /** @type {{ testResults?: { name?: unknown }[] }} */
  let report;
  try { report = JSON.parse(fs.readFileSync(path.join(out, 'dry-fast.json'), 'utf8')); } catch { return; }
  const ran = (report?.testResults ?? []).map(result => result?.name).filter(name => typeof name === 'string');
  if (ran.length === 0) return;
  /** @type {CoverageRecord[]} */
  const records = [];
  let names = /** @type {string[]} */ ([]);
  try { names = fs.readdirSync(path.join(out, COVERAGE_DIR)); } catch { names = []; }
  for (const name of names) {
    try { records.push(JSON.parse(fs.readFileSync(path.join(out, COVERAGE_DIR, name), 'utf8'))); } catch {}
  }
  fs.writeFileSync(path.join(out, REACH_FILE), JSON.stringify(reachOf(testDir, /** @type {string[]} */ (ran), records)));
}

/**
 * The reach the run with no mutant left in `out`, or null when there is none
 * or it cannot be read.
 * @param {string} out
 * @returns {Reach | null}
 */
export function readReach(out) {
  try {
    const reach = JSON.parse(fs.readFileSync(path.join(out, REACH_FILE), 'utf8'));
    const indexes = (/** @type {unknown} */ list) => Array.isArray(list) && list.every(i => Number.isInteger(i) && i >= 0 && i < reach.files.length);
    const valid = Array.isArray(reach?.files) && reach.files.every((/** @type {unknown} */ f) => typeof f === 'string') && indexes(reach.unsure)
      && reach.reached !== null && typeof reach.reached === 'object' && Object.values(reach.reached).every(indexes);
    return valid ? reach : null;
  } catch {
    return null;
  }
}

/**
 * The test files a mutant's run takes: null for every related file (no reach,
 * or every file reached it or is unsure), else the files that reached it and
 * the unsure ones, in the order the run with no mutant ran them; none when no
 * file reached it.
 * @param {Reach | null} reach
 * @param {string} mutant
 * @returns {string[] | null}
 */
export function selectFor(reach, mutant) {
  if (!reach) return null;
  const take = new Set([...reach.unsure, ...(Object.hasOwn(reach.reached, mutant) ? reach.reached[mutant] : [])]);
  if (take.size >= reach.files.length) return null;
  return reach.files.filter((_, index) => take.has(index));
}

/**
 * The test files a rerun alone (a2) of a mutant takes: those its run in pass A
 * took, which touched.mjs left by the mutant's key and targets.mjs links to its
 * id here; null for every related file when a link is missing or unreadable.
 * @param {string} out a2's report dir
 * @param {string} mutant
 * @returns {string[] | null}
 */
export function takenBefore(out, mutant) {
  try {
    const keys = JSON.parse(fs.readFileSync(path.join(out, RUN_KEYS_FILE), 'utf8'));
    const taken = JSON.parse(fs.readFileSync(path.join(out, TAKEN_FILE), 'utf8'));
    const key = keys !== null && typeof keys === 'object' && Object.hasOwn(keys, mutant) ? keys[mutant] : null;
    const files = typeof key === 'string' && taken !== null && typeof taken === 'object' && Object.hasOwn(taken, key) ? taken[key] : null;
    return Array.isArray(files) && files.length > 0 && files.every(name => typeof name === 'string') ? files : null;
  } catch {
    return null;
  }
}
