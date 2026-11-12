// What a gate run saves as it goes, and how a resume of a stopped run walks
// what it saved (touched.mjs --resume, mutation/README.md "Stopping and
// resuming"). Pure: the caller reads the files and runs the stages.

/**
 * @typedef {import('./ranges.mjs').Location} Location
 * @typedef {{ file: string, patterns: string[], gating: number[] | null, deleted?: number[] }} PassTarget
 * @typedef {{ key: string, id: string, status: string, statusReason?: string }} SavedResult one line of results.jsonl
 * @typedef {{ key: string, files: string[], code: number | null, ms: number | null }} SetLine one line of checks.jsonl in
 *   the dir of a check of sets of test files: the set's key (setKey), its files, and its exit and time (null: it left none)
 * @typedef {{ key: string, failed: string }} ControlLine the line of checks.jsonl in the dir of the run with no mutant
 *   after the reruns: why it failed, '' when it passed
 * @typedef {{ id: string, key: string, file: string, location: Location, mutator: string, replacement: string }} PlannedMutant
 * @typedef {{ path: string, version: string, standIn: string }} RunSetup what ran every test command: the Node binary
 *   (its path and version) and a test's stand-in for vitest ('' for none)
 * @typedef {{ tree: [string, string][], packages: [string, string][], scope: { base: string, mergeBase: string } | { mutate: string[] },
 *   targets: PassTarget[], seed: string, setup: RunSetup }} SavedRun what run.json holds: the tree's print and the package
 *   locks' print as the run took them at its start (tree.mjs), the scope (the merge-base of --base, or the --mutate
 *   patterns), the targets planned from it, the fast-check seed, and what ran the tests
 * @typedef {{ dir: string, forKeys: string[] | null, lines: { key: string }[], missing: string[], done: boolean }} StageDir
 *   one dir of a stage: the keys of the items it ran for (null when it stopped before it knew them), its saved lines,
 *   the keys it settled with no line (a mutant its plan does not hold), and whether it holds done.json
 */
/**
 * @template {{ key: string }} L
 * @typedef {{ targets: string[] | null, settled: Map<string, { dir: string, line: L | null }>, missing: string[], done: boolean, used: string[] }} Stage
 *   a stage as its dirs left it: the keys it is for (null: not known yet), each settled key's dir and line (null: no
 *   mutant there), the keys still to run, whether it finished, and the dirs that hold any of it
 */

// In the report dir: what the run saved before pass A started.
export const RUN_FILE = 'run.json';
// In the report dir: the gate run or resume using it (its process id and start time), there while it runs.
export const LOCK_FILE = 'lock.json';
// In each Stryker stage's dir: every mutant Stryker planned, with its key, written before any check or run.
export const PLAN_FILE = 'plan.json';
// In each Stryker stage's dir: one line per result of a mutant the stage runs for, as Stryker reported it.
export const RESULTS_FILE = 'results.jsonl';
// In each dir of a check with no mutant: the keys of the items it runs for, written before it runs.
export const CHECKS_PLAN_FILE = 'checks.json';
// In each dir of a check with no mutant: one line per finished item.
export const CHECKS_FILE = 'checks.jsonl';
// In a stage's last dir: written once the stage has finished, after everything its outcome depends on.
export const DONE_FILE = 'done.json';
// In each dir of a check of sets of test files: the runner.mjs that runs the sets (its process id and start time),
// there from before its first set until it exits.
/** @param {number} pid */
export const runnerFile = pid => `runner-${pid}.json`;
export const RUNNER_FILE = /^runner-\d+\.json$/;

// What Stryker reports for a tested mutant (mutation-testing-report-schema's MutantStatus, Pending aside).
export const STATUSES = ['Killed', 'Survived', 'NoCoverage', 'CompileError', 'RuntimeError', 'Timeout', 'Ignored'];

// Every dir a stage of the gate runs in, its own name or a resume's -r<n> form of it.
export const STAGE_DIR = /^(?:a|a-unchecked|alone-a|a2|control-a2|alone-a2|b|b2-\d+|control-b2)(?:-r\d+)?$/;

/** @param {unknown} value */
const isText = value => typeof value === 'string';
/** @param {unknown} value */
const isPosition = value => value !== null && typeof value === 'object'
  && Number.isInteger(/** @type {{ line?: unknown }} */ (value).line) && Number.isInteger(/** @type {{ column?: unknown }} */ (value).column);
/** @param {unknown} value */
const isLocation = value => value !== null && typeof value === 'object'
  && isPosition(/** @type {{ start?: unknown }} */ (value).start) && isPosition(/** @type {{ end?: unknown }} */ (value).end);
/** @param {unknown} value */
const isPairs = value => Array.isArray(value) && value.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(isText));
/** @param {unknown} value */
const isTexts = value => Array.isArray(value) && value.every(isText);
/** @param {unknown} value */
const isTarget = value => {
  if (value === null || typeof value !== 'object') return false;
  const t = /** @type {Record<string, unknown>} */ (value);
  const lines = (/** @type {unknown} */ list) => Array.isArray(list) && list.every(Number.isInteger);
  return isText(t.file) && isTexts(t.patterns) && (t.gating === null || lines(t.gating)) && (t.deleted === undefined || lines(t.deleted));
};
/** @param {unknown} value */
const isTime = value => value === null || (typeof value === 'number' && Number.isFinite(value));

/** @param {string} text */
const parse = text => { try { return /** @type {unknown} */ (JSON.parse(text)); } catch { return undefined; } };

/**
 * The lines of a .jsonl file a run appends to, each read by `read` (a line, or
 * why it is none). The last piece, after the last line break, is a line the
 * stop cut short (or nothing) and is dropped; any other line that does not
 * read is a problem, since the file can then not be trusted.
 * @template T
 * @param {string} text
 * @param {(value: unknown) => T | string} read
 * @returns {{ lines: T[], problem: string }}
 */
function linesOf(text, read) {
  /** @type {T[]} */
  const lines = [];
  for (const [index, line] of text.split('\n').slice(0, -1).entries()) {
    const value = read(parse(line));
    if (typeof value === 'string') return { lines: [], problem: `line ${index + 1} ${value}` };
    lines.push(value);
  }
  return { lines, problem: '' };
}

/**
 * The results a Stryker stage's results.jsonl holds. A status Stryker never
 * reports is a problem too: the verdict reads an unknown one as no failure.
 * @param {string} text
 * @returns {{ lines: SavedResult[], problem: string }}
 */
export function resultLines(text) {
  return linesOf(text, value => {
    const r = /** @type {Record<string, unknown> | null | undefined} */ (value);
    if (!r || typeof r !== 'object' || !isText(r.key) || !isText(r.id) || !isText(r.status) || !(r.statusReason === undefined || isText(r.statusReason))) {
      return 'does not read as a result';
    }
    if (!STATUSES.includes(r.status)) return `holds the status ${JSON.stringify(r.status)}, which Stryker never reports for a tested mutant`;
    return { key: r.key, id: r.id, status: r.status, ...(r.statusReason !== undefined ? { statusReason: r.statusReason } : {}) };
  });
}

/**
 * A set of test files' key in a check's dir: its files, in order.
 * @param {string[]} files
 */
export const setKey = files => JSON.stringify(files);

/**
 * The finished sets a check of sets of test files saved in checks.jsonl.
 * @param {string} text
 * @returns {{ lines: SetLine[], problem: string }}
 */
export function setLines(text) {
  return linesOf(text, value => {
    const r = /** @type {Record<string, unknown> | null | undefined} */ (value);
    if (!r || typeof r !== 'object' || !isTexts(r.files) || !isTime(r.code) || !isTime(r.ms)) return 'does not read as the run of a set of test files';
    const files = /** @type {string[]} */ (r.files);
    return { key: setKey(files), files, code: /** @type {number | null} */ (r.code), ms: /** @type {number | null} */ (r.ms) };
  });
}

// The one item of the run with no mutant after the reruns.
export const CONTROL_KEY = 'control';

/**
 * The outcome the run with no mutant after the reruns saved in checks.jsonl.
 * @param {string} text
 * @returns {{ lines: ControlLine[], problem: string }}
 */
export function controlLines(text) {
  return linesOf(text, value => {
    const r = /** @type {Record<string, unknown> | null | undefined} */ (value);
    if (!r || typeof r !== 'object' || r.key !== CONTROL_KEY || !isText(r.failed)) return 'does not read as the outcome of a run with no mutant';
    return { key: CONTROL_KEY, failed: r.failed };
  });
}

/**
 * The mutants a stage's plan.json holds, or null when any of it cannot be read.
 * @param {string} text
 * @returns {PlannedMutant[] | null}
 */
export function planOf(text) {
  const plan = parse(text);
  if (!Array.isArray(plan)) return null;
  const valid = plan.every(m => m !== null && typeof m === 'object' && isText(m.id) && isText(m.key) && isText(m.file) && isLocation(m.location)
    && isText(m.mutator) && isText(m.replacement));
  return valid ? /** @type {PlannedMutant[]} */ (plan) : null;
}

/**
 * The keys a targets.json or checks.json holds, or null when it cannot be read.
 * @param {string} text
 * @returns {string[] | null}
 */
export function keysOf(text) {
  const keys = parse(text);
  return isTexts(keys) ? /** @type {string[]} */ (keys) : null;
}

/**
 * What run.json holds, or null when it cannot be read whole.
 * @param {string} text
 * @returns {SavedRun | null}
 */
export function savedRun(text) {
  const run = /** @type {Record<string, unknown> | null | undefined} */ (parse(text));
  if (!run || typeof run !== 'object') return null;
  const scope = /** @type {Record<string, unknown> | null | undefined} */ (run.scope);
  const scoped = !!scope && typeof scope === 'object'
    && ((isText(scope.base) && isText(scope.mergeBase) && scope.mutate === undefined) || (isTexts(scope.mutate) && scope.base === undefined));
  const setup = /** @type {Record<string, unknown> | null | undefined} */ (run.setup);
  const valid = isPairs(run.tree) && isPairs(run.packages) && scoped && Array.isArray(run.targets) && run.targets.every(isTarget)
    && isText(run.seed) && /^-?\d+$/.test(/** @type {string} */ (run.seed))
    && !!setup && typeof setup === 'object' && isText(setup.path) && isText(setup.version) && isText(setup.standIn);
  return valid ? /** @type {SavedRun} */ (run) : null;
}

/**
 * What lock.json or a runner-<pid>.json holds, or null when it cannot be read.
 * @param {string} text
 * @returns {{ pid: number, started: string } | null}
 */
export function lockOf(text) {
  const lock = /** @type {Record<string, unknown> | null | undefined} */ (parse(text));
  return lock && typeof lock === 'object' && Number.isSafeInteger(lock.pid) && Number(lock.pid) > 0 && isText(lock.started)
    ? { pid: /** @type {number} */ (lock.pid), started: lock.started } : null;
}

/**
 * What differs between what ran the stopped run's tests and what runs them
 * now: a kill made under another Node, or under a test's stand-in for vitest,
 * says nothing of a run under this one.
 * @param {RunSetup} was
 * @param {RunSetup} now
 * @returns {string[]}
 */
export function setupChanges(was, now) {
  return [
    ...(was.path !== now.path || was.version !== now.version ? [`the Node binary (${was.path}, ${was.version}; now ${now.path}, ${now.version})`] : []),
    ...(was.standIn !== now.standIn ? [`the stand-in for vitest (${was.standIn || 'none'}; now ${now.standIn || 'none'})`] : []),
  ];
}

/**
 * The dirs of a stage, in the order they ran: its own name, then its
 * `-r<n>` forms by n, of the names `names` holds.
 * @param {string[]} names the entries of the report dir
 * @param {string} stage
 */
export function chainOf(names, stage) {
  const match = new RegExp(`^${stage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:-r(\\d+))?$`);
  return names.flatMap(name => {
    const m = match.exec(name);
    return m ? [{ name, n: m[1] === undefined ? 0 : Number(m[1]) }] : [];
  }).sort((x, y) => x.n - y.n).map(entry => entry.name);
}

/**
 * The number of this resume: one more than every `-r<n>` the report dir's
 * names hold (a dir, or a file before its extension), so no name this resume
 * makes is one an earlier run made.
 * @param {string[]} names
 */
export function resumeNumber(names) {
  let most = 0;
  for (const name of names) {
    const m = /-r(\d+)(?:\.[^.]*)?$/.exec(name);
    if (m) most = Math.max(most, Number(m[1]));
  }
  return most + 1;
}

/**
 * The dir a stage runs in now: its own name when none of its chain exists,
 * else `<stage>-r<n>`, so no dir an earlier run made is written again.
 * @param {string} stage
 * @param {string[]} chain chainOf's
 * @param {number} n
 */
export const nextDir = (stage, chain, n) => (chain.length === 0 ? stage : `${stage}-r${n}`);

/**
 * Whether a dir is one of pass A's tests (pass A, its run with no checker, a2),
 * whose runs the runner can end at a bound built from their files' costs, and
 * whether it is a2's, where that bound is the rerun's own budget.
 * @param {string} dir
 */
export const boundedDir = dir => /^(?:a|a-unchecked|a2)(?:-r\d+)?$/.test(dir);
/** @param {string} dir */
export const a2Dir = dir => /^a2(?:-r\d+)?$/.test(dir);

/**
 * One dir of a Stryker stage as a resume reads it: the keys it ran for (its
 * targets.json, or for a pass on every mutant the keys of its plan), its
 * results, and the keys it ran for that its plan does not hold (Stryker made
 * no mutant there, so the stage records it missing and nothing runs it again).
 * A dir with results but no plan, a plan with a key twice, or a result whose
 * id is not the one its plan gives its key, is a problem.
 * @param {{ dir: string, targets: string[] | null, plan: PlannedMutant[] | null, results: SavedResult[], done: boolean }} saved
 * @returns {StageDir | { problem: string }}
 */
export function mutantDir({ dir, targets, plan, results, done }) {
  if (!plan && results.length > 0) return { problem: `${dir}/ holds results but no ${PLAN_FILE}, so what their ids name is not known` };
  /** @type {Map<string, string>} */
  const ids = new Map();
  for (const m of plan ?? []) {
    if (ids.has(m.key)) return { problem: `${dir}/${PLAN_FILE} holds the mutant ${m.key} twice` };
    ids.set(m.key, m.id);
  }
  for (const r of results) {
    if (ids.has(r.key) && ids.get(r.key) !== r.id) return { problem: `${dir}/${RESULTS_FILE} gives ${r.key} the id ${r.id}, but its plan gives it ${ids.get(r.key)}` };
  }
  const forKeys = targets ?? (plan ? [...ids.keys()] : null);
  return { dir, forKeys, lines: results, missing: plan && forKeys ? forKeys.filter(key => !ids.has(key)) : [], done };
}

/**
 * A stage as its dirs (in chain order) left it, or the problem that keeps a
 * resume from going on from it. `want` is the keys of the items the stage is
 * for now, or null to take them from its first dir that knew its items (pass A
 * on every mutant, whose plan names them). Each dir after the first must have
 * run for exactly the items the dirs before it left unsettled, each line must
 * be for an item its dir ran for, no item may be settled twice, a dir that
 * knew no items may hold nothing, no dir may follow one that holds done.json,
 * and done.json stands only where every item is settled.
 * @template {{ key: string }} L
 * @param {StageDir[]} dirs
 * @param {string[] | null} want
 * @returns {Stage<L> | { problem: string }}
 */
export function stageOf(dirs, want) {
  /** @type {string[] | null} */
  let targets = want;
  /** @type {Map<string, { dir: string, line: L | null }>} */
  const settled = new Map();
  /** @type {string[]} */
  const used = [];
  let done = '';
  for (const d of dirs) {
    if (done) return { problem: `${d.dir}/ comes after ${done}/, where the stage finished` };
    if (d.forKeys === null) {
      if (d.lines.length > 0 || d.done) return { problem: `${d.dir}/ holds ${d.done ? DONE_FILE : 'results'} but does not say what it ran for` };
      used.push(d.dir);
      continue;
    }
    if (new Set(d.forKeys).size !== d.forKeys.length) return { problem: `${d.dir}/ names an item it ran for twice` };
    const all = targets ?? d.forKeys;
    targets = all;
    const open = all.filter(key => !settled.has(key));
    if (d.forKeys.length !== open.length || !d.forKeys.every(key => open.includes(key))) {
      return { problem: `${d.dir}/ ran for ${d.forKeys.length} item(s), not the ${open.length} the stage ${settled.size > 0 ? 'had left' : 'is for now'}` };
    }
    const ran = new Set(d.forKeys);
    /** @type {[string, L | null][]} */
    const found = [...d.lines.map(l => /** @type {[string, L | null]} */ ([l.key, /** @type {L} */ (l)])), ...d.missing.map(k => /** @type {[string, L | null]} */ ([k, null]))];
    for (const [key, line] of found) {
      if (!ran.has(key)) return { problem: `${d.dir}/ holds a result for ${key}, which it did not run for` };
      if (settled.has(key)) return { problem: `${d.dir}/ holds a second result for ${key}` };
      settled.set(key, { dir: d.dir, line });
    }
    used.push(d.dir);
    if (d.done) {
      const left = all.filter(key => !settled.has(key)).length;
      if (left > 0) return { problem: `${d.dir}/ holds ${DONE_FILE}, but ${left} of the ${all.length} item(s) the stage ran for have no result` };
      done = d.dir;
    }
  }
  return { targets, settled, missing: targets ? targets.filter(key => !settled.has(key)) : [], done: Boolean(done), used };
}

/**
 * Names files for a message: the first ten, and how many there are.
 * @param {string[]} files
 */
export const someOf = files => `${files.slice(0, 10).join(', ')}${files.length > 10 ? ` and ${files.length - 10} more` : ''} (${files.length} file(s))`;
