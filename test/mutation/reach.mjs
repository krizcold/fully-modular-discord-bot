// Which test files a mutant run of pass A or pass B takes (runner.mjs): the
// run with no mutant of pass A records the fast tier's reach, and that of pass
// B the integration and child tiers'. Each loads helpers/reachRecorder.cjs in
// every test file's process and the Node processes under it, which leave the
// mutant ids that file's run reached; each mutant run then takes the files that
// reached it, every file whose reach is unknown, and nothing else.
// A rerun alone (a2) of a mutant takes the files its run in pass A took. A run
// of pass A or a2 that takes some of them is bounded by what they cost in its
// pass's run with no mutant (boundFor).
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { RUN_BOUND } from './passes.mjs';

/**
 * @typedef {{ files: string[], unsure: number[], reached: Record<string, number[]>, costs?: number[] }} Reach files: the
 *   test files the run with no mutant ran, relative to test/; unsure: the indexes of those whose reach is unknown, which
 *   every mutant run takes; reached: per mutant id, the indexes of the files that reached it; costs: per file, the ms
 *   it cost in that run (costsOf), absent when they could not be made
 * @typedef {{ files: string[], costs?: number[] }} Costs files: the test files a run with no mutant ran, relative to
 *   test/; costs: per file, the ms it cost in that run (costsOf)
 * @typedef {{ factor: number, startMs: number }} Formula a bound of `factor` times what a run's files cost, plus `startMs`
 * @typedef {{ file?: unknown, ids?: unknown, unsure?: unknown }} CoverageRecord one test file's run: its ids, and why
 *   it is unsure when it is
 * @typedef {{ startTime?: unknown, testResults?: { name?: unknown, startTime?: unknown, endTime?: unknown,
 *   assertionResults?: { duration?: unknown }[] }[] }} TimedReport the parts of vitest's JSON report costsOf reads
 */

// The dir, under a pass's report dir, where the run with no mutant leaves one record per test file.
export const COVERAGE_DIR = 'dry-coverage';
// The reach that run leaves for the mutant runs after it.
export const REACH_FILE = 'dry-reach.json';
// In a2's dir: per mutant key, the files its run in pass A took (touched.mjs).
export const TAKEN_FILE = 'taken.json';
// In a pass's dir: per mutant id, its key (targets.mjs).
export const RUN_KEYS_FILE = 'run-keys.json';
// In a2's dir: what each file cost in a2's run with no mutant (writeCosts).
export const COSTS_FILE = 'dry-costs.json';
// Node's limit on a timer: a longer one fires at once.
export const TIMER_LIMIT_MS = 2 ** 31 - 1;

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

/** @param {unknown} value */
const isTime = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * What each test file cost, in ms, in a run with no mutant on one worker, from
 * its vitest JSON report and `end`, the time (Date.now) after that vitest
 * exited: its own span and the gaps on both sides of it, from the end of the
 * file before it (for the first, from the report's start) to the start of the
 * file after it (for the last, to `end`). The report gives a file's start and
 * end as those of its tests, so the fork, the imports, collection and a
 * beforeAll fall in the gap before it and an afterAll in the gap after it; a
 * gap cannot be split between the two files beside it, so each is given it
 * whole. A file none of whose tests ran (each skipped, or none collected) has
 * no times of its own: it ran inside one of those gaps, so it costs the widest
 * of them. null when the report has no start, a file with no name or with
 * times that cannot be read, times that overlap (not one file after another),
 * no timed file, or `end` is not a time after the last file's end; and null
 * when the wall-clock time the costs are built from, the report's start to
 * `end`, is longer than `took`, that run's time by the monotonic clock from
 * before vitest started, plus a second and a hundredth of it: the wall clock
 * stepped forward during the run.
 * @param {string} testDir
 * @param {TimedReport | null | undefined} report
 * @param {number} end
 * @param {number} took
 * @returns {Record<string, number> | null}
 */
export function costsOf(testDir, report, end, took) {
  const start = report?.startTime;
  const results = report?.testResults;
  if (!isTime(start) || !isTime(end) || !isTime(took) || !Array.isArray(results)) return null;
  if (end - /** @type {number} */ (start) > took + 1000 + took / 100) return null;
  /** @type {{ name: string, from: number, to: number }[]} */
  const timed = [];
  /** @type {string[]} */
  const untimed = [];
  for (const file of results) {
    if (typeof file?.name !== 'string') return null;
    const name = testName(testDir, file.name);
    const tests = Array.isArray(file.assertionResults) ? file.assertionResults : [];
    if (!tests.some(test => isTime(test?.duration))) { untimed.push(name); continue; }
    if (!isTime(file.startTime) || !isTime(file.endTime)) return null;
    const [from, to] = [/** @type {number} */ (file.startTime), /** @type {number} */ (file.endTime)];
    if (to < from || from < /** @type {number} */ (start)) return null;
    timed.push({ name, from, to });
  }
  if (timed.length === 0) return null;
  timed.sort((x, y) => x.from - y.from);
  /** @type {Record<string, number>} */
  const costs = {};
  let before = /** @type {number} */ (start);
  let widest = 0;
  for (const [index, { name, from, to }] of timed.entries()) {
    const after = index + 1 < timed.length ? timed[index + 1].from : end;
    if (from < before || after < to) return null;
    widest = Math.max(widest, from - before, after - to);
    costs[name] = (Object.hasOwn(costs, name) ? costs[name] : 0) + after - before;
    before = to;
  }
  for (const name of untimed) costs[name] = (Object.hasOwn(costs, name) ? costs[name] : 0) + widest;
  return costs;
}

/**
 * The bound, in ms, on a mutant's run that takes `take`, by `formula` (pass
 * A: passes.mjs RUN_BOUND; a2: PASSES.a2's timeoutFactor and timeoutMS) on
 * what those files cost in `costs`: null when it takes none of them or every
 * one, when a file it takes has no cost, or when the bound is past Node's
 * timer limit.
 * @param {Costs | null} costs
 * @param {string[] | null} take
 * @param {Formula} [formula]
 * @returns {number | null}
 */
export function boundFor(costs, take, { factor, startMs } = RUN_BOUND) {
  const each = costs?.costs;
  if (!costs || !each || !Array.isArray(take) || take.length === 0) return null;
  if (costs.files.every(name => take.includes(name))) return null;
  let sum = 0;
  for (const name of take) {
    const index = costs.files.indexOf(name);
    if (index < 0 || !isTime(each[index])) return null;
    sum += each[index];
  }
  const bound = factor * sum + startMs;
  return Number.isFinite(bound) && bound <= TIMER_LIMIT_MS ? bound : null;
}

/**
 * The time a bounded run leaves vitest to start and end: `ms`, or
 * SMDB_MUTATION_BOUND_START_MS when a test's stand-in replaces vitest
 * (SMDB_MUTATION_VITEST), so a test can see a bound fire in seconds; the gate
 * has no result whenever the stand-in is set.
 * @param {NodeJS.ProcessEnv} env
 * @param {number} [ms]
 */
export function boundStartMs(env, ms = RUN_BOUND.startMs) {
  const given = Number(env.SMDB_MUTATION_BOUND_START_MS);
  return env.SMDB_MUTATION_VITEST && env.SMDB_MUTATION_BOUND_START_MS && isTime(given) ? given : ms;
}

/**
 * The run with no mutant's fast report in `out`, or null when it cannot be read.
 * @param {string} out
 * @returns {TimedReport | null}
 */
function dryReport(out) {
  try { return JSON.parse(fs.readFileSync(path.join(out, 'dry-fast.json'), 'utf8')); } catch { return null; }
}

/**
 * Writes what each file cost in a2's run with no mutant (costsOf, from its fast
 * report in `out`, to `end`, against `took`) to `out`, or removes what is there
 * when the costs cannot be made.
 * @param {string} out a2's report dir
 * @param {string} testDir
 * @param {number} end the time (Date.now) after that run's vitest exited
 * @param {number} took that run's time so far, by the monotonic clock
 */
export function writeCosts(out, testDir, end, took) {
  const file = path.join(out, COSTS_FILE);
  fs.rmSync(file, { force: true });
  const costs = costsOf(testDir, dryReport(out), end, took);
  if (costs) fs.writeFileSync(file, JSON.stringify({ files: Object.keys(costs), costs: Object.values(costs) }));
}

/**
 * What writeCosts left in `out`, or null when there is none or it cannot be read.
 * @param {string} out
 * @returns {Costs | null}
 */
export function readCosts(out) {
  try {
    const { files, costs } = JSON.parse(fs.readFileSync(path.join(out, COSTS_FILE), 'utf8')) ?? {};
    const valid = Array.isArray(files) && files.every(name => typeof name === 'string') && Array.isArray(costs) && costs.length === files.length && costs.every(isTime);
    return valid ? { files, costs } : null;
  } catch {
    return null;
  }
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
 * writes it there, with what each file cost when `end` and `took` are given
 * and the fast report gives that (costsOf, to `end`, against `took`). A tier
 * with no report, or no list of files in it, or reports that list no file in
 * all, leave no reach, so every mutant run takes every related file (in pass
 * B, and the whole child tier).
 * @param {string} out the pass's report dir
 * @param {string} testDir
 * @param {string[]} [tiers] pass A's fast tier, or pass B's integration and child tiers
 * @param {number} [end] the time (Date.now) after that run's vitest exited
 * @param {number} [took] that run's time so far, by the monotonic clock
 */
export function writeReach(out, testDir, tiers = ['fast'], end, took) {
  /** @type {string[]} */
  const ran = [];
  /** @type {TimedReport | null} */
  let fast = null;
  for (const tier of tiers) {
    /** @type {TimedReport} */
    let report;
    try { report = JSON.parse(fs.readFileSync(path.join(out, `dry-${tier}.json`), 'utf8')); } catch { return; }
    if (!Array.isArray(report?.testResults)) return;
    if (tier === 'fast') fast = report;
    ran.push(.../** @type {string[]} */ (report.testResults.map(result => result?.name).filter(name => typeof name === 'string')));
  }
  if (ran.length === 0) return;
  const records = readRecords(path.join(out, COVERAGE_DIR), testDir, ran);
  const reach = reachOf(testDir, ran, records);
  const costs = end === undefined || took === undefined ? null : costsOf(testDir, fast, end, took);
  if (costs && reach.files.every(name => Object.hasOwn(costs, name))) reach.costs = reach.files.map(name => costs[name]);
  fs.writeFileSync(path.join(out, REACH_FILE), JSON.stringify(reach));
}

/**
 * The reach the run with no mutant left in `out`, or null when there is none
 * or it cannot be read; its costs are dropped when they cannot be read.
 * @param {string} out
 * @returns {Reach | null}
 */
export function readReach(out) {
  try {
    const reach = JSON.parse(fs.readFileSync(path.join(out, REACH_FILE), 'utf8'));
    const indexes = (/** @type {unknown} */ list) => Array.isArray(list) && list.every(i => Number.isInteger(i) && i >= 0 && i < reach.files.length);
    const valid = Array.isArray(reach?.files) && reach.files.every((/** @type {unknown} */ f) => typeof f === 'string') && indexes(reach.unsure)
      && reach.reached !== null && typeof reach.reached === 'object' && Object.values(reach.reached).every(indexes);
    if (!valid) return null;
    if (!(Array.isArray(reach.costs) && reach.costs.length === reach.files.length && reach.costs.every(isTime))) delete reach.costs;
    return reach;
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
