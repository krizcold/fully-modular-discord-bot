// The L5 gate (VERIFY.md section 2): mutation on the lines a change touched,
// through Stryker's command runner, so code that only child processes run is
// mutated too. How to run it and read it: mutation/README.md.
// Usage: node test/mutation/touched.mjs [--base REF] [--mutate PATTERN]... [--concurrency N] [--keep]
// Exit: 0 PASS, 1 FAIL, 2 NO RESULT; any other code: interrupted.
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { codeLines, diffArgs, gates, parseDiff, patternsOf, planTargets } from './ranges.mjs';
import { classifyKill, judge, toConfirm, toPassB } from './verdict.mjs';

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
  process.exit(run.status ?? 2);
}

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

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportDir = path.join(root, 'test', 'mutation', 'reports', stamp);
fs.mkdirSync(reportDir, { recursive: true });

/** @type {PassTarget[]} */
let targets = [];
/** @type {{ file: string, why: string }[]} */
let skipped = [];
let scope = opts.mutate.length > 0 ? `the patterns ${opts.mutate.join(' ')}` : `the change from ${opts.base} to the working tree`;
let emptyScope = false;
/** @type {MutantRecord[]} */
let mutants = [];
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
 * @param {PassName} name
 * @param {string} id
 */
function reportsOf(name, id) {
  return ['fast', 'integration', 'child'].flatMap(project => {
    try { return [JSON.parse(fs.readFileSync(path.join(reportDir, name, `${id}-${project}.json`), 'utf8'))]; } catch { return []; }
  });
}

/**
 * One pass's result for a mutant, with a kill checked against the reports.
 * @param {PassName} name
 * @param {StrykerResult} r
 * @returns {PassResult}
 */
function resultOf(name, r) {
  /** @type {PassResult} */
  const result = { id: r.id, status: r.status, ...(r.statusReason ? { statusReason: r.statusReason.split('\n')[0] } : {}) };
  return r.status === 'Killed' ? { ...result, ...classifyKill(reportsOf(name, r.id)) } : result;
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
 * tier, b for the integration and child tiers.
 * @param {PassName} name
 * @param {'a' | 'b'} tier
 * @param {string[]} mutate
 * @param {string[]} passFiles
 * @param {Options} extra
 * @returns {Promise<StrykerResult[]>}
 */
async function pass(name, tier, mutate, passFiles, extra) {
  const out = path.join(reportDir, name);
  fs.mkdirSync(out, { recursive: true });
  process.env.SMDB_MUTATION_PASS = tier;
  process.env.SMDB_MUTATION_FILES = JSON.stringify(passFiles);
  process.env.SMDB_MUTATION_OUT = out;
  const { Stryker } = await import('@stryker-mutator/core');
  try {
    return await new Stryker({ ...common, mutate, ...extra }).runMutationTest();
  } catch (error) {
    const lines = [`pass ${name} could not run: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`];
    const dry = reportsOf(name, 'dry');
    if (dry.length > 0) {
      for (const report of dry) for (const file of report.testResults ?? []) {
        if (file.status !== 'failed') continue;
        const failed = (file.assertionResults ?? []).filter((/** @type {{ status: string }} */ t) => t.status === 'failed');
        lines.push(`the run with no mutant failed in ${file.name}: ${(failed[0]?.failureMessages?.[0] ?? file.message ?? '').split('\n')[0]}`);
      }
    } else if (fs.readdirSync(out).some(f => f.startsWith('dry-'))) {
      lines.push(`the run with no mutant wrote no report: see ${posix(path.relative(root, out))}/dry-*.log`);
    }
    throw new PassError(lines.join('\n'));
  }
}

/**
 * Runs a pass on exactly the given mutants and records its results on them.
 * @param {PassName} name
 * @param {'a' | 'b'} tier
 * @param {MutantRecord[]} on
 * @param {Options} extra
 */
async function passOn(name, tier, on, extra) {
  const results = await pass(name, tier, [...new Set(on.map(spanOf))], [...new Set(on.map(m => m.file))], extra);
  const byKey = new Map(results.map(r => [resultKey(r), r]));
  for (const m of on) {
    const r = byKey.get(recordKey(m));
    m.passes[name] = r ? resultOf(name, r) : { id: null, status: 'Missing' };
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
    if (target.gating === null) {
      if (made.length === 0 && !stopped) unmatched.push(...target.patterns);
      continue;
    }
    const lines = codeLines(target.file, linesOf(target.file).join('\n'), target.gating)
      .filter(n => !made.some(m => m.location.start.line <= n && n <= m.location.end.line));
    if (lines.length > 0 && (mutants.length > 0 || !stopped)) noMutant.push({ file: target.file, lines });
  }
  const result = judge({ stamp, scope, emptyScope, skipped, mutants, noMutant, unmatched, report: posix(path.relative(root, reportDir)), stopped });
  fs.writeFileSync(path.join(reportDir, 'mutants.json'), `${JSON.stringify({ scope, skipped, targets, mutants, verdict: result.verdict, stopped }, null, 2)}\n`);
  fs.writeFileSync(path.join(reportDir, 'summary.txt'), `${result.lines.join('\n')}\n`);
  console.log(result.lines.join('\n'));
  process.exit(result.code);
}

try {
  // What to mutate: the explicit patterns (every mutant gates), or the change
  // from the merge-base of --base and HEAD to the working tree.
  if (opts.mutate.length > 0) {
    targets = opts.mutate.map(pattern => ({ file: pattern.replace(/:\d+(:\d+)?-\d+(:\d+)?$/, ''), patterns: [pattern], gating: null }));
  } else {
    const base = git('merge-base', opts.base, 'HEAD').trim();
    const diff = parseDiff(git(...diffArgs(base)));
    const untracked = git('ls-files', '-z', '--others', '--exclude-standard', '--', 'src').split('\0').filter(Boolean);
    const plan = planTargets({ diff, untracked, read: file => linesOf(file).join('\n') });
    targets = plan.targets.map(target => ({ ...target, patterns: patternsOf(target) }));
    skipped = plan.skipped;
    scope = `the change from ${opts.base} (merge-base ${base.slice(0, 7)}) to the working tree`;
    emptyScope = diff.length === 0 && untracked.length === 0;
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
  const resultsA = await pass('a', 'a', targets.flatMap(t => t.patterns), files, {
    checkers: ['typescript'],
    concurrency: opts.concurrency,
    timeoutMS: 10_000,
    timeoutFactor: 2,
  });
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
    await passOn('a2', 'a', confirmA, { checkers: [], concurrency: 1, timeoutMS: 60_000, timeoutFactor: 4 });
  }

  const forB = toPassB(mutants);
  if (forB.length > 0) {
    console.log(`L5: pass B (integration tests that import them, then every child scenario) on ${forB.length} survivor(s)`);
    const b = { buildCommand: 'node test/helpers/build.cjs', checkers: [], dryRunTimeoutMinutes: 15 };
    await passOn('b', 'b', forB, { ...b, concurrency: Math.max(1, Math.floor(opts.concurrency / 2)), timeoutMS: 60_000, timeoutFactor: 2 });
    const confirmB = toConfirm(mutants, 'b');
    if (confirmB.length > 0) {
      console.log(`L5: pass B again, one at a time, on ${confirmB.length} timeout(s)`);
      await passOn('b2', 'b', confirmB, { ...b, concurrency: 1, timeoutMS: 180_000, timeoutFactor: 4 });
    }
  }
  finish();
} catch (error) {
  finish(error instanceof PassError ? error.message.split('\n') : [`the gate stopped: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`]);
}
