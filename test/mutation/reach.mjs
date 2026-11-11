// Which test files a mutant run of pass A or pass B takes (runner.mjs): the
// run with no mutant of pass A records the fast tier's reach, and that of pass
// B the integration and child tiers'. Each loads helpers/reachRecorder.cjs in
// every test file's process and the Node processes under it, which leave the
// mutant ids that file's run reached; each mutant run then takes the files that
// reached it, every file whose reach is unknown, and nothing else.
// A rerun alone (a2) of a mutant takes the files its run in pass A took.
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * @typedef {{ files: string[], unsure: number[], reached: Record<string, number[]> }} Reach files: the test files the
 *   run with no mutant ran, relative to test/; unsure: the indexes of those whose reach is unknown, which every mutant
 *   run takes; reached: per mutant id, the indexes of the files that reached it
 * @typedef {{ file?: unknown, ids?: unknown, unsure?: unknown }} CoverageRecord one test file's run: its ids, and why
 *   it is unsure when it is
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
 * The name a test file's record dir starts with, before `-<pid>` (helpers/reachRecorder.cjs fileKey makes the same).
 * @param {string} file
 */
export const fileKey = file => createHash('sha256').update(path.resolve(file)).digest('hex').slice(0, 32);

const KINDS = new Set(['node', 'listed', 'worker', 'other']);
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * One test file process's record dir: the file its own process names, the ids every record in it holds, and the
 * first reason the file is unsure, if any.
 * @param {string} dir
 * @returns {{ file?: string, ids: string[], unsure?: string }}
 */
export function readRecordDir(dir) {
  /** @type {Set<string>} */
  const ids = new Set();
  let unsure = '';
  const why = (/** @type {string} */ text) => { unsure ||= text; };
  /** @type {string[]} */
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return { ids: [], unsure: 'its record dir cannot be read' }; }
  /** @type {string[]} */
  const own = [];
  /** @type {Set<string>} */
  const children = new Set();
  /** @type {Set<string>} */
  const nodeStarts = new Set();
  for (const name of names) {
    if (!name.endsWith('.jsonl')) { why(`its record dir holds ${name}, which is no record (a write failed)`); continue; }
    /** @type {string[]} */
    let lines;
    try { lines = fs.readFileSync(path.join(dir, name), 'utf8').split('\n'); } catch { why(`its record ${name} cannot be read`); continue; }
    if (lines.at(-1) === '') lines.pop();
    if (lines.length === 0) { why(`its record ${name} is empty`); continue; }
    lines.forEach((line, index) => {
      /** @type {unknown} */
      let entry;
      try { entry = JSON.parse(line); } catch { entry = null; }
      if (!isObject(entry)) { why(`a line of its record ${name} cannot be read`); return; }
      if (index === 0) {
        const header = (entry.role === 'file' && typeof entry.file === 'string') || (entry.role === 'child' && typeof entry.token === 'string');
        if (!header || typeof entry.ranOther !== 'boolean' || typeof entry.late !== 'boolean') { why(`its record ${name} does not start with a header`); return; }
        if (entry.role === 'file') own.push(/** @type {string} */ (entry.file));
        else children.add(/** @type {string} */ (entry.token));
        if (entry.ranOther) why('its process ran another test file first');
        if (entry.late) why('a process of it counted mutants before its recorder started');
        return;
      }
      if (typeof entry.id === 'string') { ids.add(entry.id); return; }
      if (entry.failed === true) { why('a write to its records failed'); return; }
      if (typeof entry.start === 'string' && typeof entry.kind === 'string' && KINDS.has(entry.kind)) {
        if (entry.elsewhere !== undefined) why('a process of it started one whose records go to another test file');
        else if (entry.kind === 'worker') why('it started a worker');
        else if (entry.kind === 'other') why('it started a program that may run the tree\'s code where no record follows it');
        else if (entry.kind === 'node') nodeStarts.add(entry.start);
        return;
      }
      why(`a line of its record ${name} cannot be read`);
    });
  }
  if (own.length === 0) why('its own process left no record');
  if (own.length > 1) why('more than one record claims to be its own process');
  if ([...nodeStarts].some(start => !children.has(start))) why('it started a Node process that left no record');
  return { ...(own.length === 1 ? { file: own[0] } : {}), ids: [...ids], ...(unsure ? { unsure } : {}) };
}

/**
 * The records the run with no mutant left in `coverage`, one per test file process, each read by readRecordDir. A
 * dir whose own record is missing names its file by its key only, and is matched to the file in `ran` it belongs to.
 * @param {string} coverage
 * @param {string} testDir
 * @param {string[]} ran the test files vitest's report lists
 * @returns {CoverageRecord[]}
 */
export function readRecords(coverage, testDir, ran) {
  const byKey = new Map(ran.map(file => [fileKey(path.resolve(testDir, file)), file]));
  /** @type {CoverageRecord[]} */
  const records = [];
  /** @type {fs.Dirent[]} */
  let entries = [];
  try { entries = fs.readdirSync(coverage, { withFileTypes: true }); } catch { entries = []; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const key = entry.name.slice(0, entry.name.lastIndexOf('-'));
    const record = readRecordDir(path.join(coverage, entry.name));
    const owner = byKey.get(key);
    if (record.file !== undefined && fileKey(record.file) !== key) {
      const unsure = 'its record names another file than its dir';
      records.push({ file: record.file, ids: record.ids, unsure });
      if (owner !== undefined) records.push({ file: owner, ids: record.ids, unsure });
      continue;
    }
    const file = record.file ?? owner;
    if (file !== undefined) records.push({ ...record, file });
  }
  return records;
}

/**
 * Builds the reach from what the run with no mutant left in `out` (the report
 * of each of its `tiers`, in the order they ran, and its coverage records) and
 * writes it there. A tier with no report, or no list of files in it, or
 * reports that list no file in all, leave no reach, so every mutant run takes
 * every related file (in pass B, and the whole child tier).
 * @param {string} out the pass's report dir
 * @param {string} testDir
 * @param {string[]} [tiers] pass A's fast tier, or pass B's integration and child tiers
 */
export function writeReach(out, testDir, tiers = ['fast']) {
  /** @type {string[]} */
  const ran = [];
  for (const tier of tiers) {
    /** @type {{ testResults?: { name?: unknown }[] }} */
    let report;
    try { report = JSON.parse(fs.readFileSync(path.join(out, `dry-${tier}.json`), 'utf8')); } catch { return; }
    if (!Array.isArray(report?.testResults)) return;
    ran.push(.../** @type {string[]} */ (report.testResults.map(result => result?.name).filter(name => typeof name === 'string')));
  }
  if (ran.length === 0) return;
  const records = readRecords(path.join(out, COVERAGE_DIR), testDir, ran);
  fs.writeFileSync(path.join(out, REACH_FILE), JSON.stringify(reachOf(testDir, ran, records)));
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
