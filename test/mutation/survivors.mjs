// Pass A's survivors so far, from a gate run's report dir while the run goes on
// or after it died (mutation/README.md, "Survivors before a pass ends"). It
// reads the report dir, the run's sandbox and the tree, and writes only into
// --out. Never import touched.mjs here: loading it runs the gate.
// Usage: node test/mutation/survivors.mjs --report DIR --sandbox DIR [--sandbox-name sandbox-XXXX] --out DIR [--tree DIR] [--base REF] [--mutate PATTERN]...
// Exit: 0 every mutated file proven, 1 some file unproven or some id unmatched, 2 a usage error or nothing could be read.
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { disableTypeChecks, Instrumenter } from '@stryker-mutator/instrumenter';
import { canonicalName, keyOf } from './keys.mjs';
import { gatesIn, mutatePatterns, planFromGit } from './ranges.mjs';

/**
 * @typedef {{ line: number, column: number }} Position
 * @typedef {{ start: Position, end: Position }} Location
 * @typedef {{ file: string, patterns: string[], gating: number[] | null, ranges?: [number, number][] | null }} Target
 * @typedef {true | Location[]} MutateDescription Stryker's own: true for a whole file, else ranges counted from 0
 * @typedef {{ id: string, mutatorName: string, replacement: string, location: Location }} Made a mutant as the instrumenter gives it (lines and columns from 0)
 * @typedef {'passed' | 'failed' | 'unknown' | 'no run'} State
 * @typedef {{ id: string, key: string, file: string, location: Location, mutator: string, replacement: string, original: string, gating: boolean, state: State, unreached: boolean }} Listed
 * @typedef {{ file: string, why: string }} Unproven
 */

export const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const LIMITS = [
  "Stryker judges a run by vitest's exit code, not by its report. vitest 5.0.3 exits 1 on an unhandled error or rejection while its JSON report still reads success true with every test passed, and with only the JSON reporter it prints nothing about the error to the log, so such a run is listed as passed here while the gate counts it inconclusive.",
  'A timeout Stryker called after the report was complete cannot be seen: the files read the same as a run that passed in time, so such a run is listed as passed here while the gate counts it a timeout.',
];

const USAGE = 'usage: node test/mutation/survivors.mjs --report DIR --sandbox DIR [--sandbox-name sandbox-XXXX] --out DIR [--tree DIR] [--base REF] [--mutate PATTERN]...';
// Stryker's mutate pattern with a range (core's project-reader MUTATION_RANGE_REGEX).
const RANGE = /(.*?):((\d+)(?::(\d+))?-(\d+)(?::(\d+))?)$/;
// The files Stryker's disableTypeChecks: true matches (core's FileMatcher).
const NO_CHECK = /\.(js|ts|jsx|tsx|html|vue|mjs|mts|cts|cjs)$/;
const ID_CALL = /\b(stryMutAct_9fa48|stryCov_9fa48)\(((?:"\d+"(?:, )?)*)\)/g;
const RUN_FILE = /^(\d+)-(fast\.json|fast\.log|reach\.json|fast\.include\.json)$/;
const SANDBOX_TEST = /\/\.stryker-tmp\/(sandbox-[^/]+)\/test\/(.+)$/;

/** @param {Position} p */
const fromOne = p => ({ line: p.line + 1, column: p.column + 1 });

/**
 * The mutate description Stryker gives the instrumenter for each file, from
 * the gate's patterns, as core's ProjectReader builds it.
 * @param {string[]} patterns
 * @returns {Map<string, MutateDescription>}
 */
export function describeMutate(patterns) {
  /** @type {Map<string, MutateDescription>} */
  const byFile = new Map();
  for (const pattern of patterns) {
    const m = RANGE.exec(pattern);
    const file = m ? m[1] : pattern;
    /** @type {MutateDescription} */
    const mutate = m
      ? [{ start: { line: Number(m[3]) - 1, column: Number(m[4] ?? 0) }, end: { line: Number(m[5]) - 1, column: m[6] === undefined ? Number.MAX_SAFE_INTEGER : Number(m[6]) } }]
      : true;
    const before = byFile.get(file);
    byFile.set(file, before === undefined ? mutate : before === true || mutate === true ? true : [...before, ...mutate]);
  }
  return byFile;
}

/**
 * The env of every git command the tool starts: the process's own, with
 * GIT_OPTIONAL_LOCKS=0 so a read never refreshes the index or takes
 * .git/index.lock in a tree where a gate run or the owner is working.
 * @returns {NodeJS.ProcessEnv}
 */
export const gitEnv = () => ({ ...process.env, GIT_OPTIONAL_LOCKS: '0' });

/**
 * The plan touched.mjs makes: with patterns, those; otherwise the change from
 * the merge-base of `base` and HEAD, through planFromGit. Only the files a
 * target can gate in are mutated (touched.mjs mutated()).
 * @param {{ tree: string, base: string, mutate: string[] }} options
 * @returns {{ targets: Target[], patterns: string[] }}
 */
export function planOf({ tree, base, mutate }) {
  /** @type {Target[]} */
  let targets;
  if (mutate.length > 0) {
    targets = mutate.map(pattern => {
      const file = pattern.replace(/:\d+-\d+$/, '');
      const name = canonicalName(tree, file);
      if (name === null) throw new UsageError(`--mutate takes a file in the tree that exists, or such a file and lines: ${pattern}`);
      return { file: name, patterns: [`${name}${pattern.slice(file.length)}`], gating: null };
    });
  } else {
    /** @param {string[]} args */
    const git = (...args) => execFileSync('git', ['-c', 'core.quotePath=false', '-c', 'core.fsmonitor=false', ...args], { cwd: tree, env: gitEnv(), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    const at = git('merge-base', base, 'HEAD').trim();
    ({ targets } = planFromGit({ git, base: at, root: tree, read: file => fs.readFileSync(path.join(tree, file), 'utf8') }));
  }
  /** @param {Target} target */
  const canGate = target => target.gating === null || target.gating.length > 0;
  const mutated = targets.filter(target => targets.some(other => other.file === target.file && canGate(other)));
  return { targets, patterns: mutatePatterns(mutated) };
}

class UsageError extends Error {}

const quiet = () => {};
const logger = { debug: quiet, info: quiet, warn: quiet, error: quiet, trace: quiet, fatal: quiet, isDebugEnabled: () => false, isTraceEnabled: () => false, isInfoEnabled: () => false, isWarnEnabled: () => false, isErrorEnabled: () => false, isFatalEnabled: () => false };

/**
 * One file instrumented alone, as Stryker 10.0.0 instruments it and then
 * writes it into a sandbox: its instrumenter with Stryker's default mutator
 * options, then disableTypeChecks for the files that option matches. Its ids
 * count from 0.
 * @param {string} name the file's absolute path
 * @param {string} content
 * @param {MutateDescription} mutate
 * @returns {Promise<{ text: string, mutants: Made[] }>}
 */
export async function instrumentAlone(name, content, mutate) {
  const instrumenter = new Instrumenter(/** @type {never} */ (logger));
  const result = await instrumenter.instrument([/** @type {never} */ ({ name, content, mutate })], /** @type {never} */ ({ ignorers: [], plugins: null, excludedMutations: [] }));
  const [file] = result.files;
  const text = NO_CHECK.test(name) ? (await disableTypeChecks(file, { plugins: null })).content : file.content;
  return { text, mutants: /** @type {Made[]} */ (/** @type {unknown} */ (result.mutants)) };
}

/**
 * The mutant ids an instrumented text names, in order of first use.
 * @param {string} text
 * @returns {number[]}
 */
export function idsIn(text) {
  /** @type {Set<number>} */
  const ids = new Set();
  for (const m of text.matchAll(ID_CALL)) for (const id of m[2].matchAll(/"(\d+)"/g)) ids.add(Number(id[1]));
  return [...ids];
}

/**
 * @param {string} text
 * @param {number} by
 */
export const shiftIds = (text, by) => text.replace(ID_CALL, (_, fn, args) => `${fn}(${args.replace(/"(\d+)"/g, (/** @type {string} */ __, /** @type {string} */ id) => `"${Number(id) + by}"`)})`);

/**
 * Ties a file's mutants to the ids its sandbox copy holds. The file is
 * instrumented alone and its ids shifted by the difference of the first id
 * each text names; it is proven only when the shifted text equals the
 * sandbox's exactly.
 * @param {{ name: string, content: string, mutate: MutateDescription, sandboxText: string | null }} file
 * @returns {Promise<{ mutants: Made[] } | { why: string }>}
 */
export async function proveFile({ name, content, mutate, sandboxText }) {
  if (sandboxText === null) return { why: 'the sandbox holds no copy of it' };
  let alone;
  try {
    alone = await instrumentAlone(name, content, mutate);
  } catch (error) {
    return { why: `the instrumenter failed on it: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}` };
  }
  const own = idsIn(alone.text);
  const theirs = idsIn(sandboxText);
  if (own.length === 0 && alone.mutants.length > 0) return { why: 'none of its mutants is placed in the text, so no id can be tied to it' };
  const by = own.length === 0 ? 0 : (theirs.length === 0 ? NaN : Math.min(...theirs) - Math.min(...own));
  if (Number.isNaN(by)) return { why: 'the sandbox copy names no mutant id, and the instrumenter places some' };
  if (shiftIds(alone.text, by) !== sandboxText) return { why: 'its instrumented text, ids shifted, differs from the sandbox copy' };
  return { mutants: alone.mutants.map(m => ({ ...m, id: String(Number(m.id) + by) })) };
}

/**
 * A test file of a vitest report, relative to the sandbox's test dir, or
 * null when the name is not under a sandbox.
 * @param {unknown} name
 */
export function testFileOf(name) {
  if (typeof name !== 'string') return null;
  const m = SANDBOX_TEST.exec(name.split('\\').join('/'));
  return m ? m[2] : null;
}

/**
 * The names of the sandboxes (sandbox-XXXX) whose test files a parsed vitest
 * report ran.
 * @param {unknown} report
 * @returns {string[]}
 */
export function sandboxesOf(report) {
  if (!isObject(report) || !Array.isArray(report.testResults)) return [];
  return report.testResults.flatMap(file => {
    const m = typeof file?.name === 'string' ? SANDBOX_TEST.exec(file.name.split('\\').join('/')) : null;
    return m ? [m[1]] : [];
  });
}

/**
 * @param {unknown} report
 * @returns {report is { success?: unknown, numFailedTests?: unknown, numFailedTestSuites?: unknown, testResults?: unknown }}
 */
const isObject = report => report !== null && typeof report === 'object' && !Array.isArray(report);

/**
 * Whether a parsed vitest JSON report holds a failure.
 * @param {unknown} report
 */
export function holdsFailure(report) {
  if (!isObject(report)) return false;
  const files = Array.isArray(report.testResults) ? report.testResults : [];
  return (typeof report.numFailedTests === 'number' && report.numFailedTests > 0)
    || (typeof report.numFailedTestSuites === 'number' && report.numFailedTestSuites > 0)
    || files.some(file => file?.status === 'failed' || (Array.isArray(file?.assertionResults) && file.assertionResults.some((/** @type {{ status?: unknown }} */ t) => t?.status === 'failed')));
}

/**
 * A finished vitest JSON report in which every test passed: success is true,
 * no test and no suite failed, every file entry passed, every test passed or
 * was skipped, at least one test passed, and the files it holds are exactly
 * `expected`, each once.
 * @param {unknown} report
 * @param {string[]} expected test files, relative to test/
 */
export function finishedAndPassed(report, expected) {
  if (!isObject(report) || report.success !== true || report.numFailedTests !== 0 || report.numFailedTestSuites !== 0) return false;
  if (!Array.isArray(report.testResults)) return false;
  const tests = report.testResults.flatMap(file => (Array.isArray(file?.assertionResults) ? file.assertionResults : [null]));
  const everyFilePassed = report.testResults.every(file => file?.status === 'passed' && Array.isArray(file.assertionResults));
  const everyTestDone = tests.every(test => ['passed', 'skipped', 'todo'].includes(test?.status));
  const oneRan = tests.some(test => test?.status === 'passed');
  const files = report.testResults.map(file => testFileOf(file?.name));
  const exactly = files.length === expected.length && new Set(files).size === files.length && files.every(file => file !== null && expected.includes(file));
  return everyFilePassed && everyTestDone && oneRan && exactly;
}

/**
 * @param {string} file
 * @returns {unknown}
 */
function parsed(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

/**
 * The fast test files a run that took 'related' took: those the pass's run
 * with no mutant ran, or null when that cannot be read.
 * @param {string} reportDir
 * @returns {string[] | null}
 */
export function relatedOf(reportDir) {
  const reach = parsed(path.join(reportDir, 'dry-reach.json'));
  if (isObject(reach) && Array.isArray(/** @type {{ files?: unknown }} */ (reach).files)) {
    const files = /** @type {unknown[]} */ (/** @type {{ files: unknown[] }} */ (reach).files);
    if (files.length > 0 && files.every(file => typeof file === 'string')) return /** @type {string[]} */ (files);
  }
  const dry = parsed(path.join(reportDir, 'dry-fast.json'));
  if (!isObject(dry) || !Array.isArray(dry.testResults)) return null;
  const files = dry.testResults.map(file => testFileOf(file?.name));
  return files.length > 0 && files.every(file => file !== null) ? /** @type {string[]} */ (files) : null;
}

/**
 * One mutant's state from the files its pass A run left.
 * @param {string} reportDir
 * @param {string} id
 * @param {Set<string>} present ids that left a file
 * @param {() => string[] | null} related
 * @param {Set<string>} [sandboxes] gets the names of the sandboxes its report ran in
 * @returns {{ state: State, unreached: boolean }}
 */
export function stateOf(reportDir, id, present, related, sandboxes) {
  if (!present.has(id)) return { state: 'no run', unreached: false };
  const reach = parsed(path.join(reportDir, `${id}-reach.json`));
  const files = isObject(reach) ? /** @type {{ files?: unknown }} */ (reach).files : undefined;
  const report = parsed(path.join(reportDir, `${id}-fast.json`));
  for (const name of sandboxesOf(report)) sandboxes?.add(name);
  if (Array.isArray(files) && files.length === 0) {
    return report === undefined && !fs.existsSync(path.join(reportDir, `${id}-fast.json`)) ? { state: 'passed', unreached: true } : { state: 'unknown', unreached: false };
  }
  const expected = files === 'related' ? related() : Array.isArray(files) && files.every(file => typeof file === 'string') ? /** @type {string[]} */ (files) : null;
  if (expected === null || report === undefined) return { state: 'unknown', unreached: false };
  if (holdsFailure(report)) return { state: 'failed', unreached: false };
  return { state: finishedAndPassed(report, expected) ? 'passed' : 'unknown', unreached: false };
}

/**
 * The real path of `dir`, through its nearest ancestor that exists.
 * @param {string} dir
 */
function realOf(dir) {
  const full = path.resolve(dir);
  let at = full;
  while (!fs.existsSync(at)) {
    const up = path.dirname(at);
    if (up === at) return full;
    at = up;
  }
  return path.join(fs.realpathSync.native(at), path.relative(at, full));
}

/**
 * @param {string} child
 * @param {string} parent
 */
export function isInside(child, parent) {
  const rel = path.relative(realOf(parent), realOf(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The nearest dir at or above `dir` that holds .git, or null.
 * @param {string} dir
 */
function checkoutOf(dir) {
  let at = realOf(dir);
  for (;;) {
    if (fs.existsSync(path.join(at, '.git'))) return at;
    const up = path.dirname(at);
    if (up === at) return null;
    at = up;
  }
}

/**
 * Why --out cannot be used, or null: a new file in a tree ends a gate run
 * there as NO RESULT, and the tool writes nowhere it reads.
 * @param {{ out: string, tree: string, report: string, sandbox: string }} dirs
 * @returns {string | null}
 */
export function refuseOut({ out, tree, report, sandbox }) {
  /** @type {[string | null, string][]} */
  const places = [
    [tree, 'the tree'],
    [TOOL_ROOT, "the tool's own checkout"],
    [checkoutOf(TOOL_ROOT), "the tool's own checkout"],
    [sandbox, 'the sandbox'],
    [checkoutOf(sandbox), "the sandbox's checkout"],
    [report, 'the report dir'],
    [checkoutOf(report), "the report dir's checkout"],
  ];
  for (const [dir, what] of places) if (dir !== null && isInside(out, dir)) return `--out ${out} is inside ${what} (${dir}), where a new file would end a gate run as NO RESULT`;
  return null;
}

/**
 * Refuses a sandbox the reports do not name: another run's sandbox of the same
 * tree can prove every file while its ids sit off the report dir's, which
 * would give each mutant a neighbour's state.
 * @param {Set<string>} seen the sandbox names the reports read so far ran in
 * @param {string} expected
 * @param {boolean} needed whether some id is to be listed
 */
function refuseSandbox(seen, expected, needed) {
  const others = [...seen].filter(name => name !== expected);
  if (others.length > 0) throw new UsageError(`the report dir's runs ran in ${others.join(', ')}, not in ${expected}; give the run's own sandbox, or --sandbox-name with its name for a copy`);
  if (needed && seen.size === 0) throw new UsageError(`no report in the report dir names its sandbox, so ${expected} cannot be tied to the run`);
}

/**
 * @param {string} file
 * @param {Location} location lines and columns from 1
 * @param {string[]} lines
 */
export function originalOf(file, location, lines) {
  const first = lines[location.start.line - 1] ?? '';
  const text = location.start.line === location.end.line
    ? first.slice(location.start.column - 1, location.end.column - 1)
    : `${first.slice(location.start.column - 1)} ...`;
  return text.length > 100 ? `${text.slice(0, 97)}...` : text;
}

/**
 * Lists pass A's survivors so far and writes them into `out`.
 * @param {{ report: string, sandbox: string, sandboxName?: string, out: string, tree: string, base: string, mutate: string[] }} options
 * @returns {Promise<{ code: number, summary: string }>}
 */
export async function survivors({ report, sandbox, sandboxName, out, tree, base, mutate }) {
  const refused = refuseOut({ out, tree, report, sandbox });
  if (refused) throw new UsageError(refused);
  const expectedSandbox = sandboxName ?? path.basename(sandbox);
  /** @type {Set<string>} */
  const sandboxes = new Set(sandboxesOf(parsed(path.join(report, 'dry-fast.json'))));
  refuseSandbox(sandboxes, expectedSandbox, false);
  /** @type {string[]} */
  let names;
  try {
    names = fs.readdirSync(report);
  } catch (error) {
    throw new UsageError(`the report dir ${report} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!fs.existsSync(path.join(sandbox, 'src'))) throw new UsageError(`the sandbox ${sandbox} holds no src dir`);
  const present = new Set(names.map(name => RUN_FILE.exec(name)?.[1]).filter(id => id !== undefined));
  const { targets, patterns } = planOf({ tree, base, mutate });
  if (patterns.length === 0) throw new UsageError('the plan mutates no file');
  /** @type {Listed[]} */
  const listed = [];
  /** @type {Unproven[]} */
  const unproven = [];
  /** @type {Map<string, string>} */
  const owner = new Map();
  /** @type {string[] | null | undefined} */
  let related;
  const relatedOnce = () => (related === undefined ? (related = relatedOf(report)) : related);
  /** @type {Map<string, Listed[]>} */
  const byFile = new Map();
  for (const [file, description] of describeMutate(patterns)) {
    let content;
    try {
      content = fs.readFileSync(path.join(tree, file), 'utf-8');
    } catch {
      unproven.push({ file, why: 'the tree holds no such file' });
      continue;
    }
    let sandboxText = null;
    try { sandboxText = fs.readFileSync(path.join(sandbox, file), 'utf-8'); } catch {}
    const proof = await proveFile({ name: path.join(tree, file), content, mutate: description, sandboxText });
    if ('why' in proof) { unproven.push({ file, why: proof.why }); continue; }
    const lines = content.split('\n');
    /** @type {Listed[]} */
    const here = proof.mutants.map(m => {
      const location = { start: fromOne(m.location.start), end: fromOne(m.location.end) };
      const replacement = m.replacement ?? '';
      return {
        id: m.id, key: keyOf(file, m.mutatorName, replacement, location), file, location, mutator: m.mutatorName, replacement,
        original: originalOf(file, location, lines), gating: gatesIn(targets, file, location), ...stateOf(report, m.id, present, relatedOnce, sandboxes),
      };
    });
    const clash = here.find(m => owner.has(m.id));
    if (clash) {
      const other = /** @type {string} */ (owner.get(clash.id));
      unproven.push({ file, why: `its id ${clash.id} is also ${other}'s` });
      if (byFile.has(other)) { byFile.delete(other); unproven.push({ file: other, why: `its id ${clash.id} is also ${file}'s` }); }
      continue;
    }
    for (const m of here) owner.set(m.id, file);
    byFile.set(file, here);
  }
  refuseSandbox(sandboxes, expectedSandbox, byFile.size > 0);
  for (const here of byFile.values()) listed.push(...here);
  listed.sort((a, b) => Number(a.id) - Number(b.id));
  const mapped = new Set(listed.map(m => m.id));
  const strays = [...present].filter(id => !mapped.has(id));
  const summary = summaryOf(listed, unproven, strays.length, byFile);
  fs.mkdirSync(out, { recursive: true });
  const passed = listed.filter(m => m.state === 'passed');
  fs.writeFileSync(path.join(out, 'survivors.json'), `${JSON.stringify(passed.filter(m => m.gating).map(m => m.key))}\n`);
  fs.writeFileSync(path.join(out, 'survivors-context.json'), `${JSON.stringify(passed.filter(m => !m.gating).map(m => m.key))}\n`);
  fs.writeFileSync(path.join(out, 'mutants.json'), `${JSON.stringify(listed, null, 2)}\n`);
  fs.writeFileSync(path.join(out, 'summary.txt'), summary);
  return { code: unproven.length > 0 || strays.length > 0 ? 1 : 0, summary };
}

/** @type {State[]} */
const STATES = ['passed', 'failed', 'unknown', 'no run'];

/** @param {Listed[]} list */
const counts = list => STATES.map(state => `${state} ${list.filter(m => m.state === state).length}`).join(', ');

/**
 * @param {Listed[]} listed
 * @param {Unproven[]} unproven
 * @param {number} strays
 * @param {Map<string, Listed[]>} byFile
 */
function summaryOf(listed, unproven, strays, byFile) {
  const gating = listed.filter(m => m.gating);
  const context = listed.filter(m => !m.gating);
  const lines = [
    `Pass A's results so far, ${listed.length} mapped mutant(s) in ${byFile.size} proven file(s)`,
    `Gating (${gating.length}): ${counts(gating)}; passed with no fast test reaching it: ${gating.filter(m => m.unreached).length}`,
    `Context (${context.length}): ${counts(context)}`,
    '',
    'Per file (gating; context):',
    ...[...byFile].sort(([a], [b]) => a.localeCompare(b)).map(([file, here]) => `  ${file}: ${counts(here.filter(m => m.gating))}; ${counts(here.filter(m => !m.gating))}`),
    '',
    `Unproven files (${unproven.length}), none of whose mutants is listed:`,
    ...(unproven.length > 0 ? unproven.map(u => `  ${u.file}: ${u.why}`) : ['  none']),
    '',
    `Ids in the report dir that match no mapped mutant: ${strays}${strays > 0 ? '; the plan left out a file the run mutated, so survivors may be missing' : ''}`,
    '',
    'What the files cannot show:',
    ...LIMITS.map(line => `  ${line}`),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * @param {string[]} argv
 * @returns {{ report: string, sandbox: string, sandboxName?: string, out: string, tree: string, base: string, mutate: string[] }}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const one = {};
  /** @type {string[]} */
  const mutate = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!['--report', '--sandbox', '--sandbox-name', '--out', '--tree', '--base', '--mutate'].includes(arg) || i + 1 >= argv.length) throw new UsageError(USAGE);
    const value = argv[++i];
    if (arg === '--mutate') mutate.push(value);
    else one[arg.slice(2)] = value;
  }
  if (!one.report || !one.sandbox || !one.out) throw new UsageError(USAGE);
  return {
    report: path.resolve(one.report), sandbox: path.resolve(one.sandbox), ...(one['sandbox-name'] ? { sandboxName: one['sandbox-name'] } : {}),
    out: path.resolve(one.out), tree: path.resolve(one.tree ?? TOOL_ROOT), base: one.base ?? 'HEAD', mutate,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { code, summary } = await survivors(parseArgs(process.argv.slice(2)));
    process.stdout.write(summary, () => process.exit(code));
  } catch (error) {
    console.error(`[Survivors] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
