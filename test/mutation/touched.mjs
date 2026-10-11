// The L5 gate (VERIFY.md section 2): mutation on the lines a change touched,
// through Stryker's command runner, so code that only child processes run is
// mutated too. How to run it and read it: mutation/README.md.
// Usage: node test/mutation/touched.mjs [--base REF] [--mutate PATTERN]... [--concurrency N] [--keep]
// Exit: 0 PASS, 1 FAIL, 2 NO RESULT or a usage error; any other code: interrupted.
// Trust 0 and 1 only after a Verdict line: a process killed on Windows exits 1 too.
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { runControl } from './control.mjs';
import { PASSES } from './passes.mjs';

/**
 * @typedef {import('./ranges.mjs').Location} Location
 * @typedef {import('./verdict.mjs').MutantRecord} MutantRecord
 * @typedef {import('./verdict.mjs').PassName} PassName
 * @typedef {import('./verdict.mjs').PassResult} PassResult
 * @typedef {{ file: string, patterns: string[], gating: number[] | null }} PassTarget
 * @typedef {{ id: string, fileName: string, location: Location, mutatorName: string, replacement?: string, status: string, statusReason?: string }} StrykerResult
 * @typedef {import('@stryker-mutator/api/core').PartialStrykerOptions} Options
 */

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  const node = process.env.SMDB_TEST_NODE;
  if (!node) {
    console.error(`The mutation gate needs Node 22.12 or newer (this is ${process.version}); set SMDB_TEST_NODE to a newer node binary.`);
    process.exit(2);
  }
  const run = spawnSync(node, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  if (run.error) console.error(`The mutation gate could not start ${node}: ${run.error.message}`);
  process.exit(run.status ?? (run.signal ? 130 : 2));
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
  console.error(`Verdict: NO RESULT (the gate could not load: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}; run npm run test:install)`);
  process.exit(2);
}
const { diffArgs, gates, linesOfTarget, parseDiff, patternsOf, planTargets, untouched } = ranges;
const { byKiller, classifyKill, judge, outcome, toConfirm, toPassB } = verdicts;

const USAGE = 'usage: node test/mutation/touched.mjs [--base REF] [--mutate PATTERN]... [--concurrency N] [--keep]';
/** @type {{ base: string, mutate: string[], concurrency: number, keep: boolean }} */
const opts = { base: 'HEAD', mutate: [], concurrency: Math.max(1, Math.floor(os.availableParallelism() / 2)), keep: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  const value = () => {
    if (i + 1 >= argv.length) { console.error(`${arg} needs a value\n${USAGE}`); process.exit(2); }
    return argv[++i];
  };
  if (arg === '--base') opts.base = value();
  else if (arg === '--mutate') opts.mutate.push(value());
  else if (arg === '--concurrency') opts.concurrency = Math.max(1, Number(value()) || 1);
  else if (arg === '--keep') opts.keep = true;
  else { console.error(USAGE); process.exit(2); }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.chdir(root);
/** @param {string[]} args */
const git = (...args) => execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
/** @param {string} file */
const posix = file => file.split(path.sep).join('/');
/** @param {string} pattern */
const fileOfPattern = pattern => pattern.replace(/:\d+(:\d+)?-\d+(:\d+)?$/, '');
const GLOB = /[*?[\]{}()!|+@]/;
/**
 * A --mutate value's file under the name git gives it (from the bot root, with
 * forward slashes, the case and the path it has on disk), or null when it is no
 * file in the bot root. Stryker reads the value as a glob (extglobs included)
 * and the report matches mutants to targets by name, so both get this name.
 * @param {string} file
 */
function canonicalFile(file) {
  if (GLOB.test(file)) return null;
  let real;
  try { real = fs.realpathSync.native(path.resolve(root, file)); } catch { return null; }
  if (!fs.statSync(real).isFile()) return null;
  const relative = path.relative(fs.realpathSync.native(root), real);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) return null;
  const name = posix(relative);
  return GLOB.test(name) ? null : name;
}
opts.mutate = opts.mutate.map(pattern => {
  const file = fileOfPattern(pattern);
  const name = canonicalFile(file);
  if (name === null) {
    console.error(`--mutate takes a file in the bot root that exists, or such a file and lines, never a glob: ${pattern}\n${USAGE}`);
    process.exit(2);
  }
  return `${name}${pattern.slice(file.length)}`;
});

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportDir = path.join(root, 'test', 'mutation', 'reports', stamp);

/** @type {PassTarget[]} */
let targets = [];
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

/**
 * @param {string} file
 * @param {string} mutator
 * @param {string} replacement
 * @param {Location} l
 */
const keyOf = (file, mutator, replacement, l) => `${file}|${mutator}|${replacement}|${l.start.line}:${l.start.column}-${l.end.line}:${l.end.column}`;
/** @param {StrykerResult} r */
const fileOf = r => posix(path.relative(root, path.resolve(root, r.fileName)));
/** @param {StrykerResult} r */
const resultKey = r => keyOf(fileOf(r), r.mutatorName, r.replacement ?? '', r.location);
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
 * One pass's result for a mutant, with a kill checked against the reports.
 * @param {string} dir the pass's report dir
 * @param {StrykerResult} r
 * @returns {PassResult}
 */
function resultOf(dir, r) {
  /** @type {PassResult} */
  const result = { id: r.id, status: r.status, ...(r.statusReason ? { statusReason: r.statusReason.split('\n')[0] } : {}) };
  return r.status === 'Killed' ? { ...result, ...classifyKill(reportsOf(dir, r.id)) } : result;
}

class PassError extends Error {}

/** @type {Options} */
const common = {
  testRunner: 'command',
  commandRunner: { command: `"${process.execPath}" test/mutation/runner.mjs` },
  coverageAnalysis: 'off',
  tsconfigFile: 'tsconfig.json',
  tempDirName: '.stryker-tmp',
  cleanTempDir: opts.keep ? false : 'always',
  incremental: false,
  reporters: ['progress'],
  logLevel: /** @type {import('@stryker-mutator/api/core').LogLevel} */ ('warn'),
};

/**
 * Runs one Stryker pass. `tier` picks the tests (runner.mjs): a for the fast
 * tier, b for the integration and child tiers; `only`, when given, names the
 * test files to run instead. The reruns alone, a2 and b2, get four times the
 * time.
 * @param {{ name: PassName, dir: string, tier: 'a' | 'b', mutate: string[], files: string[], only?: string[], extra: Options }} run
 * @returns {Promise<StrykerResult[]>}
 */
async function pass({ name, dir, tier, mutate, files, only = [], extra }) {
  const out = path.join(reportDir, dir);
  fs.mkdirSync(out, { recursive: true });
  process.env.SMDB_MUTATION_PASS = tier;
  process.env.SMDB_MUTATION_CONFIRM = name === 'a2' || name === 'b2' ? '1' : '';
  process.env.SMDB_MUTATION_FILES = JSON.stringify(files);
  process.env.SMDB_MUTATION_ONLY = JSON.stringify(only);
  process.env.SMDB_MUTATION_OUT = out;
  const { Stryker } = await import('@stryker-mutator/core');
  try {
    return await new Stryker({ ...common, mutate, ...extra }).runMutationTest();
  } catch (error) {
    const lines = [`pass ${dir} could not run: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`, ...dryFailures(dir)];
    if (fs.readdirSync(out).some(f => f.startsWith('dry-'))) lines.push(`the run with no mutant logged to ${posix(path.relative(root, out))}/dry-*.log`);
    throw new PassError(lines.join('\n'));
  }
}

/**
 * Runs a pass's tests once more with no mutant, here in the checkout, after
 * the reruns alone counted a kill or a timeout (control.mjs): those count only
 * if the tests still pass without a mutant. When they fail, a machine or a
 * container went bad during the reruns, so their results are voided and the
 * gate stops.
 * @param {PassName} after
 * @param {'a' | 'b'} tier
 * @param {MutantRecord[]} on
 * @param {string[]} only the test files the reruns ran, or none
 */
function control(after, tier, on, only) {
  const name = `control-${after}`;
  const out = path.join(reportDir, name);
  fs.mkdirSync(out, { recursive: true });
  console.log(`L5: the same tests once with no mutant, to check the machine after pass ${after}`);
  const run = runControl({ root, out, tier, files: [...new Set(on.map(m => m.file))], only });
  const logs = `${posix(path.relative(root, out))}/dry-*.log`;
  if (!run.passed) {
    const why = `the run with no mutant after pass ${after} failed`;
    for (const m of on) {
      const result = m.passes[after];
      if (result) m.passes[after] = { ...result, voided: why };
    }
    throw new PassError([`${why} (${run.why}), so what its reruns counted cannot be told from the machine's failures`, ...dryFailures(name), `its logs: ${logs}`].join('\n'));
  }
  controls.push(`after pass ${after}: passed (${logs})`);
}

/** @param {MutantRecord} m */
const credited = m => ['Killed', 'Timeout'].includes(outcome(m));

/**
 * Runs a pass on exactly the given mutants and records its results on them.
 * @param {PassName} name
 * @param {string} dir
 * @param {'a' | 'b'} tier
 * @param {MutantRecord[]} on
 * @param {Options} extra
 * @param {string[]} [only]
 */
async function passOn(name, dir, tier, on, extra, only) {
  const results = await pass({ name, dir, tier, mutate: [...new Set(on.map(spanOf))], files: [...new Set(on.map(m => m.file))], only, extra });
  const byKey = new Map(results.map(r => [resultKey(r), r]));
  for (const m of on) {
    const r = byKey.get(recordKey(m));
    m.passes[name] = r ? resultOf(dir, r) : { id: null, status: 'Missing' };
  }
}

/**
 * The verdict, the report files and the exit.
 * @param {string[]} [stopped]
 */
function finish(stopped) {
  try {
    report(stopped);
  } catch (error) {
    console.error(`Verdict: NO RESULT (the report could not be written: ${error instanceof Error ? error.message.split('\n')[0] : String(error)})`);
    process.exit(2);
  }
}

/** @param {string[]} [stopped] */
function report(stopped) {
  /** @type {{ file: string, lines: number[] }[]} */
  const noMutant = [];
  /** @type {string[]} */
  const unmatched = [];
  for (const target of targets) {
    const made = mutants.filter(m => m.file === target.file);
    if (stopped && mutants.length === 0) continue;
    if (target.gating === null && made.length === 0) unmatched.push(...target.patterns);
    const text = linesOf(target.file).join('\n');
    /** @type {[number, number][]} */
    const spans = made.map(m => [m.location.start.line, m.location.end.line]);
    const lines = untouched(target.file, text, linesOfTarget(target, text.split('\n').length), spans);
    if (lines.length > 0) noMutant.push({ file: target.file, lines });
  }
  const result = judge({ stamp, scope, emptyScope, skipped, mutants, noMutant, unmatched, report: posix(path.relative(root, reportDir)), stopped, controls, standIn: process.env.SMDB_MUTATION_VITEST });
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'mutants.json'), `${JSON.stringify({ scope, skipped, targets, mutants, controls, verdict: result.verdict, stopped }, null, 2)}\n`);
  fs.writeFileSync(path.join(reportDir, 'summary.txt'), `${result.lines.join('\n')}\n`);
  console.log(result.lines.join('\n'));
  process.exit(result.code);
}

try {
  // What to mutate: the explicit patterns (every mutant gates), or the change
  // from the merge-base of --base and HEAD to the working tree.
  if (opts.mutate.length > 0) {
    targets = opts.mutate.map(pattern => ({ file: fileOfPattern(pattern), patterns: [pattern], gating: null }));
  } else {
    const base = git('merge-base', opts.base, 'HEAD').trim();
    const diff = parseDiff(git(...diffArgs(base)));
    const untracked = git('ls-files', '-z', '--others', '--exclude-standard', '--', 'src').split('\0').filter(Boolean);
    const deleted = git('-c', 'diff.renames=true', 'diff', '--name-only', '-z', '--no-relative', '--diff-filter=D', base, '--', 'src').split('\0').filter(Boolean);
    const plan = planTargets({ diff, untracked, read: file => linesOf(file).join('\n') });
    targets = plan.targets.map(target => ({ ...target, patterns: patternsOf(target) }));
    skipped = [...plan.skipped, ...deleted.map(file => ({ file, why: 'deleted: nothing is left to mutate' }))];
    scope = `the change from ${opts.base} (merge-base ${base.slice(0, 7)}) to the working tree`;
    emptyScope = diff.length === 0 && untracked.length === 0 && deleted.length === 0;
  }
  if (targets.length === 0) finish();

  // The sandbox holds the tracked files and the untracked ones git does not
  // ignore; everything git ignores stays out (.env, data dirs, dist, private
  // module repos), node_modules aside, which Stryker links. The temp dir
  // ignores itself, so git status stays clean.
  const ignored = git('ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory').split('\0').filter(Boolean);
  common.ignorePatterns = [...new Set(['/dist/', ...ignored.filter(p => path.posix.basename(p.replace(/\/$/, '')) !== 'node_modules').map(p => `/${p}`)])];
  fs.mkdirSync(path.join(root, '.stryker-tmp'), { recursive: true });
  fs.writeFileSync(path.join(root, '.stryker-tmp', '.gitignore'), '*\n');

  const files = [...new Set(targets.map(target => target.file))];
  console.log(`L5: mutating ${scope}: ${files.length} file(s), pass A (in-process tests that import them)`);
  const resultsA = await pass({ name: 'a', dir: 'a', tier: 'a', mutate: targets.flatMap(t => t.patterns), files, extra: { ...PASSES.a, concurrency: opts.concurrency } });
  const orphans = [...new Set(resultsA.map(fileOf).filter(file => !targets.some(t => t.file === file)))];
  if (orphans.length > 0) throw new PassError(`Stryker mutated ${orphans.join(', ')}, which no target names, so the report could not answer for it`);
  mutants = resultsA.map(r => {
    const file = fileOf(r);
    const target = targets.find(t => t.file === file);
    return {
      file,
      location: r.location,
      mutator: r.mutatorName,
      original: originalOf(file, r.location),
      replacement: r.replacement ?? '',
      gating: target ? gates(target, r.location) : true,
      passes: { a: resultOf('a', r) },
    };
  });

  const confirmA = toConfirm(mutants, 'a');
  if (confirmA.length > 0) {
    console.log(`L5: pass A again, one at a time, on ${confirmA.length} timeout(s)`);
    await passOn('a2', 'a2', 'a', confirmA, PASSES.a2);
    if (confirmA.some(credited)) control('a2', 'a', confirmA, []);
  }

  const forB = toPassB(mutants);
  if (forB.length > 0) {
    console.log(`L5: pass B (integration tests that import them, then every child scenario) on ${forB.length} survivor(s)`);
    await passOn('b', 'b', 'b', forB, { ...PASSES.b, concurrency: Math.max(1, Math.floor(opts.concurrency / 2)) });
    const confirmB = toConfirm(mutants, 'b');
    const killers = byKiller(confirmB);
    let group = 0;
    for (const [killer, on] of killers) {
      group += 1;
      console.log(`L5: pass B again, one at a time, on ${on.length} kill(s) by ${killer}, with that file alone; a kill counts only if it repeats`);
      await passOn('b2', `b2-${group}`, 'b', on, PASSES.b2, [killer]);
    }
    if (confirmB.some(credited)) control('b2', 'b', confirmB, [...killers.keys()]);
  }
  finish();
} catch (error) {
  finish(error instanceof PassError ? error.message.split('\n') : [`the gate stopped: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`]);
}
