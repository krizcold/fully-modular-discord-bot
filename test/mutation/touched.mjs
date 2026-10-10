// The L5 gate (VERIFY.md section 2): mutation on the lines a change touched,
// through Stryker's command runner, so code that only child processes run is
// mutated too. How to run it and read it: mutation/README.md.
// Usage: node test/mutation/touched.mjs [--base REF] [--mutate PATTERN]... [--concurrency N] [--keep]
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { gates, parseDiff, patternsOf, planTargets } from './ranges.mjs';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  const node = process.env.SMDB_TEST_NODE;
  if (!node) {
    console.error(`The mutation gate needs Node 22.12 or newer (this is ${process.version}); set SMDB_TEST_NODE to a newer node binary.`);
    process.exit(2);
  }
  const run = spawnSync(node, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(run.status ?? 2);
}

/**
 * @typedef {import('./ranges.mjs').Location} Location
 * @typedef {{ file: string, patterns: string[], gating: number[] | null }} PassTarget
 * @typedef {{ id: string | null, status: string, killedBy?: string, inconclusive?: string }} PassResult
 * @typedef {{ file: string, location: Location, mutator: string, original: string, replacement: string, gating: boolean,
 *   a: PassResult, b: PassResult | null }} MutantRecord
 * @typedef {{ id: string, fileName: string, location: Location, mutatorName: string, replacement?: string, status: string }} StrykerResult
 */

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
  else { console.error(USAGE); process.exit(arg === '--help' ? 0 : 2); }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.chdir(root);
/** @param {string[]} args */
const git = (...args) => execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
/** @param {string} file */
const posix = file => file.split(path.sep).join('/');

// What to mutate: the explicit patterns (every mutant gates), or the change
// from the merge-base of --base and HEAD to the working tree.
/** @type {PassTarget[]} */
let targets;
/** @type {{ file: string, why: string }[]} */
let skipped = [];
let scope;
if (opts.mutate.length > 0) {
  targets = opts.mutate.map(pattern => ({ file: pattern.replace(/:\d+(:\d+)?-\d+(:\d+)?$/, ''), patterns: [pattern], gating: null }));
  scope = `the patterns ${opts.mutate.join(' ')}`;
} else {
  const base = git('merge-base', opts.base, 'HEAD').trim();
  const diff = parseDiff(git('diff', '-U0', '--no-color', '--no-ext-diff', '--diff-filter=AMR', base, '--', 'src'));
  const untracked = git('ls-files', '-z', '--others', '--exclude-standard', '--', 'src').split('\0').filter(Boolean);
  const plan = planTargets({ diff, untracked, read: file => fs.readFileSync(path.join(root, file), 'utf8') });
  targets = plan.targets.map(target => ({ ...target, patterns: patternsOf(target) }));
  skipped = plan.skipped;
  scope = `the change from ${opts.base} (merge-base ${base.slice(0, 7)}) to the working tree`;
}
const files = [...new Set(targets.map(target => target.file))];

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportDir = path.join(root, 'test', 'mutation', 'reports', stamp);
fs.mkdirSync(path.join(reportDir, 'a'), { recursive: true });
fs.mkdirSync(path.join(reportDir, 'b'), { recursive: true });

// The sandbox holds what a clean checkout holds: everything git ignores stays
// out (.env, data dirs, dist, private module repos), node_modules aside, which
// Stryker links. Its temp dir ignores itself, so git status stays clean.
const ignored = git('ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory').split('\0').filter(Boolean);
const ignorePatterns = [...new Set(['/dist/', ...ignored.filter(p => path.posix.basename(p.replace(/\/$/, '')) !== 'node_modules').map(p => `/${p}`)])];
fs.mkdirSync(path.join(root, '.stryker-tmp'), { recursive: true });
fs.writeFileSync(path.join(root, '.stryker-tmp', '.gitignore'), '*\n');

const { Stryker } = await import('@stryker-mutator/core');
/** @typedef {import('@stryker-mutator/api/core').PartialStrykerOptions} Options */
/** @type {Options} */
const common = {
  testRunner: 'command',
  commandRunner: { command: `"${process.execPath}" test/mutation/runner.mjs` },
  coverageAnalysis: 'off',
  tsconfigFile: 'tsconfig.json',
  tempDirName: '.stryker-tmp',
  cleanTempDir: !opts.keep,
  ignorePatterns,
  incremental: false,
  reporters: ['progress'],
  logLevel: /** @type {import('@stryker-mutator/api/core').LogLevel} */ ('warn'),
};

/**
 * @param {'a' | 'b'} name
 * @param {string[]} mutate
 * @param {string[]} passFiles
 * @param {Options} extra
 * @returns {Promise<StrykerResult[]>}
 */
async function pass(name, mutate, passFiles, extra) {
  process.env.SMDB_MUTATION_PASS = name;
  process.env.SMDB_MUTATION_FILES = JSON.stringify(passFiles);
  process.env.SMDB_MUTATION_OUT = path.join(reportDir, name);
  try {
    return await new Stryker({ ...common, mutate, ...extra }).runMutationTest();
  } catch (error) {
    const lines = [`pass ${name} could not run: ${error instanceof Error ? error.message : String(error)}`, ...dryRunFailures(name)];
    fs.writeFileSync(path.join(reportDir, 'summary.txt'), `${lines.join('\n')}\n`);
    console.error(lines.join('\n'));
    console.error(`Verdict: NO RESULT (report: ${posix(path.relative(root, reportDir))})`);
    process.exit(2);
  }
}

// The vitest reports a run left behind: per test file, the failures. Test
// files are named from their sandbox's test dir.
/** @param {string} name */
const testFile = name => posix(name).replace(/^.*\/\.stryker-tmp\/sandbox-[^/]+\/test\//, '');
/**
 * @param {'a' | 'b'} name
 * @param {string | null} mutant
 * @returns {{ test: string, message: string }[] | null} null when no report was written
 */
function failuresOf(name, mutant) {
  /** @type {{ test: string, message: string }[]} */
  const failures = [];
  let found = false;
  for (const project of ['fast', 'integration', 'child']) {
    let report;
    try { report = JSON.parse(fs.readFileSync(path.join(reportDir, name, `${mutant}-${project}.json`), 'utf8')); } catch { continue; }
    found = true;
    for (const file of report.testResults ?? []) {
      /** @type {{ status: string, fullName: string, failureMessages?: string[] }[]} */
      const failed = (file.assertionResults ?? []).filter((/** @type {{ status: string }} */ test) => test.status === 'failed');
      for (const test of failed) failures.push({ test: `${testFile(file.name)} > ${test.fullName}`, message: (test.failureMessages ?? []).join('\n') });
      if (file.status === 'failed' && failed.length === 0) failures.push({ test: testFile(file.name), message: file.message ?? '' });
    }
  }
  return found ? failures : null;
}

/** @param {'a' | 'b'} name */
function dryRunFailures(name) {
  const failures = failuresOf(name, 'dry');
  if (failures === null) return [`  no vitest report: see ${posix(path.relative(root, path.join(reportDir, name)))}/dry-*.log`];
  return failures.slice(0, 10).map(f => `  ${f.test}: ${f.message.split('\n')[0]}`);
}

// A kill whose every failure is the machine, not the mutant, proves nothing.
const INFRASTRUCTURE = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EMFILE|ENOMEM|ENOSPC|heap out of memory|Hook timed out|container runtime|Could not find a working container/i;
/**
 * @param {'a' | 'b'} name
 * @param {string | null} mutant
 */
function killVerdict(name, mutant) {
  const failures = failuresOf(name, mutant);
  if (failures === null) return { inconclusive: 'no vitest report was written' };
  if (failures.length === 0) return { inconclusive: 'vitest failed with no failing test' };
  if (failures.every(f => INFRASTRUCTURE.test(f.message))) return { inconclusive: `only infrastructure failed: ${failures[0].message.split('\n')[0]}` };
  return { killedBy: failures[0].test };
}

/** @type {Map<string, string[]>} */
const sources = new Map();
/**
 * @param {string} file
 * @param {Location} location
 */
function originalOf(file, location) {
  if (!sources.has(file)) sources.set(file, fs.readFileSync(path.join(root, file), 'utf8').split('\n'));
  const lines = sources.get(file) ?? [];
  const first = lines[location.start.line - 1] ?? '';
  const text = location.start.line === location.end.line
    ? first.slice(location.start.column - 1, location.end.column - 1)
    : `${first.slice(location.start.column - 1)} ...`;
  return text.length > 100 ? `${text.slice(0, 97)}...` : text;
}

/** @param {MutantRecord} m */
const keyOf = m => `${m.file}|${m.mutator}|${m.replacement}|${m.location.start.line}:${m.location.start.column}-${m.location.end.line}:${m.location.end.column}`;
/**
 * @param {StrykerResult} result
 * @returns {MutantRecord}
 */
const recordOf = result => {
  const file = posix(path.relative(root, path.resolve(root, result.fileName)));
  const target = targets.find(t => t.file === file);
  return {
    file,
    location: result.location,
    mutator: result.mutatorName,
    original: originalOf(file, result.location),
    replacement: result.replacement ?? '',
    gating: target ? gates(target, result.location) : true,
    a: { id: result.id, status: result.status },
    b: null,
  };
};

/** @type {MutantRecord[]} */
let mutants = [];
if (targets.length > 0) {
  console.log(`L5: mutating ${scope}: ${files.length} file(s), pass A (in-process tests that import them)`);
  const resultsA = await pass('a', targets.flatMap(t => t.patterns), files, {
    checkers: ['typescript'],
    concurrency: opts.concurrency,
    timeoutMS: 10_000,
    timeoutFactor: 2,
  });
  mutants = resultsA.map(recordOf);
  for (const m of mutants) if (m.a.status === 'Killed') Object.assign(m.a, killVerdict('a', m.a.id));

  const survivors = mutants.filter(m => m.gating && (m.a.status === 'Survived' || m.a.status === 'NoCoverage'));
  if (survivors.length > 0) {
    console.log(`L5: pass B (integration tests that import them, then every child scenario) on ${survivors.length} survivor(s)`);
    const spans = survivors.map(m => `${m.file}:${m.location.start.line}:${m.location.start.column - 1}-${m.location.end.line}:${m.location.end.column - 1}`);
    const resultsB = await pass('b', [...new Set(spans)], [...new Set(survivors.map(m => m.file))], {
      buildCommand: 'node test/helpers/build.cjs',
      checkers: [],
      concurrency: Math.max(1, Math.floor(opts.concurrency / 2)),
      timeoutMS: 60_000,
      timeoutFactor: 2,
      dryRunTimeoutMinutes: 15,
    });
    const byKey = new Map(resultsB.map(result => [keyOf(recordOf(result)), result]));
    for (const m of survivors) {
      const result = byKey.get(keyOf(m));
      /** @type {PassResult} */
      const b = result ? { id: result.id, status: result.status } : { id: null, status: 'Missing' };
      if (b.status === 'Killed') Object.assign(b, killVerdict('b', b.id));
      m.b = b;
    }
  }
}

// The verdict: a gating mutant must end Killed (or Timeout, listed apart) with
// a kill that is not the machine's alone.
/** @param {MutantRecord} m */
const final = m => (m.b ?? m.a);
/** @param {MutantRecord} m */
const statusOf = m => (final(m).inconclusive ? 'Inconclusive' : final(m).status);
const gating = mutants.filter(m => m.gating);
const context = mutants.filter(m => !m.gating);
const failing = gating.filter(m => ['Survived', 'NoCoverage', 'Missing', 'Inconclusive'].includes(statusOf(m)));
/** @param {MutantRecord} m */
const where = m => `${m.file}:${m.location.start.line}:${m.location.start.column}`;
/** @param {MutantRecord} m */
const show = m => `  ${where(m)} ${m.mutator}: \`${m.original}\` -> \`${m.replacement}\`${final(m).inconclusive ? ` (${final(m).inconclusive})` : ''}`;
/** @param {MutantRecord[]} list */
const tally = list => ['Killed', 'Timeout', 'Survived', 'NoCoverage', 'Inconclusive', 'Missing', 'CompileError', 'RuntimeError', 'Ignored']
  .map(status => `${list.filter(m => statusOf(m) === status).length} ${status}`).filter(entry => !entry.startsWith('0 ')).join(', ') || 'none';
/**
 * @param {string} title
 * @param {MutantRecord[]} list
 */
const section = (title, list) => (list.length > 0 ? [title, ...list.map(show)] : []);

const verdict = failing.length === 0 ? 'PASS' : 'FAIL';
const summary = [
  `L5 touched-line mutation, ${stamp}`,
  `Scope: ${scope}`,
  `Mutated: ${files.length > 0 ? files.join(', ') : 'nothing'}`,
  ...(skipped.length > 0 ? ['Not mutated:', ...skipped.map(s => `  ${s.file}: ${s.why}`)] : []),
  `Gating mutants (they touch a changed line): ${gating.length}: ${tally(gating)}`,
  `  killed in pass A: ${gating.filter(m => m.a.status === 'Killed' && !m.a.inconclusive && !m.b).length}; sent to pass B: ${gating.filter(m => m.b).length}, killed there: ${gating.filter(m => m.b && m.b.status === 'Killed' && !m.b.inconclusive).length}`,
  ...section('Survivors (each needs a test that kills it, or a justification in the notes):', gating.filter(m => ['Survived', 'NoCoverage', 'Missing'].includes(statusOf(m)))),
  ...section('Inconclusive (the kill came from the machine alone; rerun):', gating.filter(m => statusOf(m) === 'Inconclusive')),
  ...section('Timeouts (counted as killed; a slow host can cause one):', gating.filter(m => statusOf(m) === 'Timeout')),
  `Context mutants (in the widened statements, not on a changed line; not gating): ${context.length}: ${tally(context)}`,
  ...section('Context survivors:', context.filter(m => statusOf(m) === 'Survived')),
  `Report: ${posix(path.relative(root, reportDir))} (mutants.json has every mutant, its passes and what killed it)`,
  `Verdict: ${verdict}`,
];
fs.writeFileSync(path.join(reportDir, 'mutants.json'), `${JSON.stringify({ scope, files, skipped, targets, mutants, verdict }, null, 2)}\n`);
fs.writeFileSync(path.join(reportDir, 'summary.txt'), `${summary.join('\n')}\n`);
console.log(summary.join('\n'));
process.exit(verdict === 'PASS' ? 0 : 1);
