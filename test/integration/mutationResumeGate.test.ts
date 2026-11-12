import { execFileSync, spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { planOf, resultLines, setLines, type PlannedMutant } from '../mutation/resume.mjs';
import { endTree } from '../helpers/endTree.mjs';
import { PACKAGE_LOCKS, treePrint } from '../mutation/tree.mjs';
import { confirmed, judge, type MutantRecord } from '../mutation/verdict.mjs';

// Gate runs (mutation/touched.mjs) on a stand-in for vitest that stop and are resumed (mutation/README.md, "Stopping
// and resuming"). The target is a throwaway untracked file in src, so it is in the tree and nothing imports it.

const root = path.resolve(__dirname, '..', '..');
const gate = path.join(root, 'test', 'mutation', 'touched.mjs');
const reports = path.join(root, 'test', 'mutation', 'reports');
const sandboxes = path.join(root, '.stryker-tmp');
const TEXT = 'export function within(a: number, b: number): boolean {\n  return a > b && b > 0;\n}\n';

interface Call { dir: string; id: string; key: string | null; seed: string | null; include: string[] | null }
type Location = PlannedMutant['location'];

const keyOf = (m: { file: string; mutator: string; replacement: string; location: Location }) =>
  `${m.file}|${m.mutator}|${m.replacement}|${m.location.start.line}:${m.location.start.column}-${m.location.end.line}:${m.location.end.column}`;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const text = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
const results = (report: string, dir: string) => resultLines(text(path.join(report, dir, 'results.jsonl'))).lines;
const sets = (report: string, dir: string) => setLines(text(path.join(report, dir, 'checks.jsonl'))).lines;
const readJson = <T>(file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as T;
// A stage's dirs: its own name and a resume's -r<n> forms.
const inStage = (stage: string) => (dir: string) => new RegExp(`^${stage}(?:-r\\d+)?$`).test(dir);

/** Removes a dir, unlinking each link in it first, so the delete never reaches what a link names. */
function removeTree(dir: string) {
  const walk = (at: string) => {
    for (const name of fs.readdirSync(at)) {
      const full = path.join(at, name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        try { fs.unlinkSync(full); } catch { fs.rmdirSync(full); }
      } else if (stat.isDirectory()) walk(full);
    }
  };
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.isDirectory()) walk(dir);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}

/**
 * The target, a stand-in for vitest and the cleanup (given to `cleanUp`). The stand-in records each call (its pass's
 * dir, the active mutant, its key from the pass's plan.json, the seed, the test files it was given) in the file
 * SMDB_STANDIN_CALLS names; in pass A it fails every mutant but an EqualityOperator one, which survives to pass B,
 * where every run passes. A run with no mutant of a set of files fails only in the stage SMDB_STANDIN_FAIL_ALONE
 * names (its own dir or a resume's -r<n> form of it), and takes SMDB_STANDIN_SET_MS there. In pass A a mutant of the
 * mutator SMDB_STANDIN_HANG_A names times out; with SMDB_STANDIN_KILL_B=1 every mutant fails in pass B; with
 * SMDB_STANDIN_CONFIRM set, a rerun alone (a2, b2) fails exactly when it is 1. With SMDB_STANDIN_REACH=1 pass A's run
 * with no mutant lists two test files and leaves reach in which unit/x.test.ts reaches the even mutant ids and
 * unit/y.test.ts the odd ones, so a mutant's run in pass A and in a2 takes one of them, and the a2 results' sets are
 * checked in alone-a2 one per file. Mutant runs take 500 ms in pass A and 1500 ms in pass B, so a run can be stopped
 * in either.
 */
function setUp(cleanUp: (fn: () => void) => void) {
  const target = `src/smdb-resume-${process.pid}.ts`;
  const added = `src/smdb-resume-added-${process.pid}.ts`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-resume-'));
  const standIn = path.join(dir, 'vitest.cjs');
  const before = new Set(fs.existsSync(sandboxes) ? fs.readdirSync(sandboxes) : []);
  const made: string[] = [];
  cleanUp(() => {
    for (const file of [target, added]) fs.rmSync(path.join(root, file), { force: true });
    for (const report of made) removeTree(report);
    if (fs.existsSync(sandboxes)) for (const name of fs.readdirSync(sandboxes).filter(name => !before.has(name))) removeTree(path.join(sandboxes, name));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.writeFileSync(standIn, [
    "const fs = require('fs');",
    "const path = require('path');",
    "const outputFile = (process.argv.find(arg => arg.startsWith('--outputFile=')) ?? '').slice('--outputFile='.length);",
    'const out = process.env.SMDB_MUTATION_OUT;',
    'const id = process.env.__STRYKER_ACTIVE_MUTANT__;',
    "const mutant = id === 'none' ? null : id;",
    "const stage = path.basename(out).replace(/-r\\d+$/, '');",
    "const include = process.env.SMDB_MUTATION_INCLUDE ? JSON.parse(fs.readFileSync(process.env.SMDB_MUTATION_INCLUDE, 'utf8')) : null;",
    'let entry = null;',
    "if (mutant) { try { entry = JSON.parse(fs.readFileSync(path.join(out, 'plan.json'), 'utf8')).find(m => m.id === mutant) ?? null; } catch {} }",
    "fs.appendFileSync(process.env.SMDB_STANDIN_CALLS, JSON.stringify({ dir: path.basename(out), id, key: entry ? entry.key : null, seed: process.env.SMDB_TEST_SEED ?? null, include }) + '\\n');",
    "const inA = process.env.SMDB_MUTATION_PASS === 'a';",
    "const set = !mutant && include !== null && stage === process.env.SMDB_STANDIN_FAIL_ALONE;",
    "const rerun = Boolean(mutant) && process.env.SMDB_MUTATION_CONFIRM === '1' && process.env.SMDB_STANDIN_CONFIRM !== undefined;",
    "const hang = Boolean(mutant) && inA && !rerun && Boolean(entry) && entry.mutator === process.env.SMDB_STANDIN_HANG_A;",
    "const fail = set || hang || (Boolean(mutant) && (rerun ? process.env.SMDB_STANDIN_CONFIRM === '1'",
    "  : inA ? (!entry || entry.mutator !== 'EqualityOperator') : process.env.SMDB_STANDIN_KILL_B === '1'));",
    'if (mutant) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, inA ? 500 : 1500);',
    "if (set && process.env.SMDB_STANDIN_SET_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.SMDB_STANDIN_SET_MS));",
    "const test = { status: fail ? 'failed' : 'passed', fullName: 'reads', failureMessages: fail ? [hang ? 'Error: Test timed out in 5000ms' : 'AssertionError: expected the mutant to fail'] : [] };",
    'const coverage = process.env.SMDB_MUTATION_COVERAGE;',
    "const reach = !mutant && Boolean(coverage) && process.env.SMDB_STANDIN_REACH === '1';",
    'if (reach) {',
    '  fs.mkdirSync(coverage, { recursive: true });',
    '  const ids = Array.from({ length: 1000 }, (_, i) => String(i));',
    "  fs.writeFileSync(path.join(coverage, 'x.json'), JSON.stringify({ file: 'unit/x.test.ts', ids: ids.filter(i => Number(i) % 2 === 0) }));",
    "  fs.writeFileSync(path.join(coverage, 'y.json'), JSON.stringify({ file: 'unit/y.test.ts', ids: ids.filter(i => Number(i) % 2 === 1) }));",
    '}',
    "const files = include ?? (reach ? ['unit/x.test.ts', 'unit/y.test.ts'] : ['unit/x.test.ts']);",
    'if (outputFile) fs.writeFileSync(outputFile, JSON.stringify({ testResults: files.map(name => ({ name, status: test.status, assertionResults: [test] })) }));',
    'process.exit(fail ? 1 : 0);',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, target), TEXT);
  // A whole second, so a time set back by hand is the same time to the print.
  const time = Math.floor(Date.now() / 1000) - 60;
  fs.utimesSync(path.join(root, target), time, time);
  let runs = 0;

  /**
   * One gate run with `args`. `stopWhen`, given the report dir, says when to kill the gate's process (as a crash or
   * a reboot would end it); the stand-in's calls of this run are returned.
   */
  async function gateRun(args: string[], { env = {}, stopWhen, report }: { env?: NodeJS.ProcessEnv; stopWhen?: (report: string) => boolean; report?: string } = {}) {
    runs += 1;
    const calls = path.join(dir, `calls-${runs}.jsonl`);
    const child = spawn(process.execPath, [gate, ...args], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SMDB_MUTATION_VITEST: standIn, SMDB_STANDIN_CALLS: calls, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    let code: number | null | undefined;
    const exited = new Promise<void>(resolve => child.once('exit', status => { code = status; resolve(); }));
    let at = report;
    let killed = false;
    // The bound on every gate run here, so a check that broke cannot leave one going.
    const deadline = Date.now() + 900_000;
    while (code === undefined && Date.now() < deadline) {
      await sleep(100);
      at ??= (fs.existsSync(reports) ? fs.readdirSync(reports) : []).filter(name => name.endsWith(`-${child.pid}`)).map(name => path.join(reports, name))[0];
      if (at && !made.includes(at)) made.push(at);
      if (stopWhen && at && code === undefined && stopWhen(at)) {
        // The gate first and then every process it started, as a reboot ends them: a test command left going would
        // finish an item after the stop, and one ended before the gate would be saved as a kill.
        const started = child.pid !== undefined ? descendants(child.pid) : [];
        child.kill('SIGKILL');
        await exited;
        for (const pid of started) endTree(pid);
        killed = true;
        break;
      }
    }
    if (code === undefined && Date.now() >= deadline) child.kill();
    await exited;
    // The test commands of a killed gate end on their own; let the last one finish before anything reads its dir.
    if (killed) await sleep(3000);
    const found = /^Report: (\S+)/m.exec(stdout)?.[1];
    if (found && !made.includes(path.join(root, found))) made.push(path.join(root, found));
    const called = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Call) : [];
    return { code, killed, stdout, stderr, calls: called, report: at ?? (found ? path.join(root, found) : undefined) };
  }

  return { target, added, time, dir, standIn, gateRun, made };
}

/** The ids of the processes `pid` started and those they started, while the tree stands. */
function descendants(pid: number) {
  const rows: [number, number][] = process.platform === 'win32'
    ? (JSON.parse(execFileSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })) as { ProcessId: number; ParentProcessId: number }[])
      .map(row => [row.ProcessId, row.ParentProcessId])
    : execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n').map(row => row.trim().split(/\s+/).map(Number) as [number, number]);
  const tree = [pid];
  for (let i = 0; i < tree.length; i++) for (const [one, parent] of rows) if (parent === tree[i] && !tree.includes(one)) tree.push(one);
  return tree.slice(1);
}

/** The tree as the gate lists it: every file git tracks or would add. */
const treeFiles = () => execFileSync('git', ['-c', 'core.quotePath=false', '-c', 'core.fsmonitor=false', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  .split('\0').filter(Boolean);

/** Per mutant key, its outcome as the report judges it, and the verdict the report would give with real tests. */
function judged(report: string) {
  const { mutants, stopped } = readJson<{ mutants: MutantRecord[]; stopped?: string[] }>(path.join(report, 'mutants.json'));
  const outcomes = Object.fromEntries(mutants.map(m => [keyOf(m), confirmed(m, Boolean(stopped)).outcome]));
  const { verdict } = judge({ stamp: '', scope: '', emptyScope: false, skipped: [], mutants, noMutant: [], unmatched: [], report: '', stopped });
  return { outcomes, verdict, mutants };
}

describe('a gate run that stops and is resumed', () => {
  // Every stage runs: pass A kills, the ConditionalExpression mutants time out and their reruns in a2 kill, but each
  // set of files those reruns took fails with no mutant in alone-a2, so they are voided; the EqualityOperator mutants
  // survive pass A, die in pass B and again alone in b2-1.
  const env = {
    SMDB_STANDIN_HANG_A: 'ConditionalExpression', SMDB_STANDIN_CONFIRM: '1', SMDB_STANDIN_KILL_B: '1', SMDB_STANDIN_REACH: '1',
    SMDB_STANDIN_FAIL_ALONE: 'alone-a2', SMDB_STANDIN_SET_MS: '2000', SMDB_TEST_SEED: '4242',
  };
  const cleanups: (() => void)[] = [];
  afterAll(() => { for (const fn of cleanups.reverse()) fn(); });
  let setup: ReturnType<typeof setUp>;
  let whole: ReturnType<typeof judged>;

  beforeAll(async () => {
    setup = setUp(fn => cleanups.push(fn));
    const run = await setup.gateRun(['--mutate', setup.target, '--concurrency', '1'], { env });
    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(2);
    whole = judged(run.report!);
    // The stand-in reaches every stage, so a stop can land in each.
    expect(Object.values(whole.outcomes).sort()).toEqual(expect.arrayContaining(['Killed', 'Inconclusive']));
    for (const dir of ['a', 'alone-a', 'a2', 'control-a2', 'alone-a2', 'b', 'b2-1', 'control-b2']) expect(fs.existsSync(path.join(run.report!, dir, 'done.json')), dir).toBe(true);
    expect(sets(run.report!, 'alone-a2').length).toBeGreaterThan(1);
    expect(results(run.report!, 'b2-1').length).toBeGreaterThan(1);
  }, 1_800_000);

  /**
   * Stops a run once `stopWhen` holds, resumes it to its end, and checks the resume: the same outcome for every
   * mutant and the same verdict as the whole run, no item of a stage the stopped run had finished run again, and no
   * item the stopped stage had saved run again.
   */
  async function stopAndResume(stopWhen: (report: string) => boolean) {
    const first = await setup.gateRun(['--mutate', setup.target, '--concurrency', '1'], { env, stopWhen });
    expect(first.killed, `${first.stdout}\n${first.stderr}`).toBe(true);
    expect(first.stdout).not.toMatch(/^Verdict:/m);
    const report = first.report!;
    // The killed run's lock stays, naming a process that no longer runs.
    const lock = readJson<{ pid: number }>(path.join(report, 'lock.json'));
    expect(Number.isSafeInteger(lock.pid)).toBe(true);
    const finished = fs.readdirSync(report).filter(name => fs.existsSync(path.join(report, name, 'done.json')));
    // What the stopped run saved, per stage: the mutants' keys and the sets' files.
    const saved = new Map<string, Set<string>>();
    for (const name of fs.readdirSync(report).filter(n => fs.statSync(path.join(report, n)).isDirectory())) {
      saved.set(name, new Set([...results(report, name).map(r => r.key), ...sets(report, name).map(s => JSON.stringify(s.files))]));
    }
    const second = await setup.gateRun(['--resume', report, '--concurrency', '1'], { env: { ...env, SMDB_TEST_SEED: '999' }, report });
    expect(second.code, `${second.stdout}\n${second.stderr}`).toBe(2);
    expect(second.stdout).toMatch(/^Verdict: NO RESULT \(vitest was replaced by a test's stand-in /m);
    expect(second.stdout).not.toMatch(/^Stopped:/m);
    expect(second.stdout).toContain(`  lock.json named process ${lock.pid}, `);
    expect(second.stdout).toMatch(/which no longer runs, so this resume took the report dir over$/m);
    for (const call of second.calls) expect(call.seed).toBe('4242');
    const now = judged(report);
    const differ = now.mutants.filter(m => now.outcomes[keyOf(m)] !== whole.outcomes[keyOf(m)]).map(m => [keyOf(m), confirmed(m).why, m.passes]);
    expect(now.outcomes, JSON.stringify(differ)).toEqual(whole.outcomes);
    expect(now.verdict).toBe(whole.verdict);
    // A stage that finished ran nothing again; a stage that had saved an item ran it nowhere again.
    for (const stage of finished) {
      const base = stage.replace(/-r\d+$/, '');
      expect(second.calls.filter(call => inStage(base)(call.dir)), stage).toEqual([]);
      expect(second.stdout).toContain(`  ${base}: finished before this resume (${stage}/)`);
    }
    for (const [dir, items] of saved) {
      const base = dir.replace(/-r\d+$/, '');
      const again = second.calls.filter(call => inStage(base)(call.dir) && (items.has(call.key ?? '') || (call.id === 'none' && items.has(JSON.stringify(call.include)))));
      expect(again, dir).toEqual([]);
    }
    expect(fs.existsSync(path.join(report, 'lock.json'))).toBe(false);
    return { report, saved, finished, second };
  }

  it('in pass A goes on with the mutants pass A has no result for', { timeout: 1_800_000 }, async () => {
    const { report, saved, second } = await stopAndResume(at => results(at, 'a').length >= 3);
    const plan = planOf(text(path.join(report, 'a', 'plan.json')))!.map(m => m.key);
    const kept = saved.get('a')!;
    expect(kept.size).toBeGreaterThanOrEqual(3);
    const forA1 = readJson<string[]>(path.join(report, 'a-r1', 'targets.json'));
    expect(new Set(forA1)).toEqual(new Set(plan.filter(key => !kept.has(key))));
    const ranA1 = second.calls.filter(call => call.dir === 'a-r1' && call.id !== 'none').map(call => call.key!);
    for (const key of ranA1) expect(forA1, key).toContain(key);
    expect(second.stdout).toMatch(new RegExp(`^ {2}a: ${kept.size} result\\(s\\) kept \\(a/\\); the ${forA1.length} with none run now in a-r1/$`, 'm'));
    const { mutants } = judged(report);
    for (const m of mutants) expect(m.passes.a?.dir, keyOf(m)).toBe(kept.has(keyOf(m)) ? 'a' : 'a-r1');
  });

  it('in alone-a2 after a set failed keeps that set\'s failure and runs only the sets with no result', { timeout: 1_800_000 }, async () => {
    const { report, saved, second } = await stopAndResume(at => {
      const done = sets(at, 'alone-a2');
      const planned = text(path.join(at, 'alone-a2', 'checks.json'));
      return done.some(set => set.code !== 0) && planned !== '' && done.length < JSON.parse(planned).length;
    });
    expect([...saved.get('alone-a2')!].length).toBeGreaterThan(0);
    const rest = second.calls.filter(call => call.dir === 'alone-a2-r1' && call.include !== null).map(call => JSON.stringify(call.include));
    expect(rest.length).toBeGreaterThan(0);
    for (const set of rest) expect(saved.get('alone-a2')!.has(set), set).toBe(false);
    expect(second.stdout).toMatch(/^ {2}alone-a2: \d+ result\(s\) kept \(alone-a2\/\); the \d+ with none run now in alone-a2-r1\/$/m);
    // Every a2 result stays voided: the sets failed, before the stop and after it.
    for (const m of judged(report).mutants.filter(one => one.passes.a2)) expect(m.passes.a2?.voided, keyOf(m)).toMatch(/failed together with no mutant \(alone-a2(?:-r1)?\/\)/);
  });

  it('in b2 goes on with the reruns b2 has no result for, then the run with no mutant after them', { timeout: 1_800_000 }, async () => {
    const { report, saved, second } = await stopAndResume(at => {
      const listed = text(path.join(at, 'b2-1', 'targets.json'));
      return listed !== '' && results(at, 'b2-1').length >= 1 && results(at, 'b2-1').length < JSON.parse(listed).length;
    });
    const kept = saved.get('b2-1')!;
    const ran = second.calls.filter(call => call.dir === 'b2-1-r1' && call.id !== 'none').map(call => call.key!);
    expect(ran.length).toBeGreaterThan(0);
    for (const key of ran) expect(kept.has(key), key).toBe(false);
    expect(second.calls.some(call => call.dir === 'control-b2')).toBe(true);
    const { mutants } = judged(report);
    for (const m of mutants.filter(one => one.passes.b2)) expect(m.passes.b2?.dir, keyOf(m)).toBe(kept.has(keyOf(m)) ? 'b2-1' : 'b2-1-r1');
  });
});

describe('a resume', () => {
  it('is refused, exit 2 and no pass run, unless the tree, the packages, the scope, what ran its tests and what each stage saved read as the stopped run left them, and runs pass A whole when it saved no plan', { timeout: 1_800_000 }, async () => {
    const { target, added, time, dir, standIn, gateRun } = setUp(onTestFinished);
    // A run stopped as soon as it saved run.json.
    const stopped = await gateRun(['--mutate', target, '--concurrency', '1'], { stopWhen: report => fs.existsSync(path.join(report, 'run.json')) });
    expect(stopped.killed, `${stopped.stdout}\n${stopped.stderr}`).toBe(true);
    const report = stopped.report!;
    const saved = readJson<{ scope: { mutate: string[] }; packages: [string, string][]; tree: [string, string][]; seed: string; setup: { standIn: string } }>(path.join(report, 'run.json'));
    expect(saved.setup.standIn).toBe(standIn);
    expect(new Map(saved.tree)).toEqual(treePrint(root, treeFiles()));
    expect(saved.tree.find(([file]) => file === target)?.[1]).toMatch(/^\d+:\d+:[0-9a-f]{40}$/);
    expect(new Map(saved.packages)).toEqual(treePrint(root, PACKAGE_LOCKS));
    // The lock a killed run leaves is taken over by each resume and removed when it exits.
    const listing = () => fs.readdirSync(report).filter(name => name !== 'lock.json').sort();
    const before = listing();

    /** A copy of the stopped run's run.json, changed by `change`, in a dir of its own. */
    const copy = (name: string, change?: (run: Record<string, unknown>) => void) => {
      const at = path.join(dir, name);
      fs.mkdirSync(at);
      if (change) {
        const run = readJson<Record<string, unknown>>(path.join(report, 'run.json'));
        change(run);
        fs.writeFileSync(path.join(at, 'run.json'), JSON.stringify(run));
      }
      return at;
    };
    // walked: the refusal comes from what a stage saved, after the resume said what it resumes.
    const refused = async (at: string, why: RegExp, env: NodeJS.ProcessEnv = {}, walked = false) => {
      const r = await gateRun(['--resume', at, '--concurrency', '1'], { env });
      expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(2);
      const verdict = /^Verdict: NO RESULT \(the run in .* cannot be resumed: (.*); no pass ran\)$/m.exec(r.stdout)?.[1];
      expect(verdict, r.stdout).toMatch(why);
      const said = r.stdout.split('\n').filter(text => text.startsWith('L5:'));
      if (walked) expect(said[0]).toMatch(/^L5: resuming the run in /);
      else expect(said).toEqual([]);
      expect(r.calls).toEqual([]);
      expect(fs.existsSync(path.join(at, 'lock.json'))).toBe(false);
      return verdict!;
    };
    const otherScope = copy('scope', run => { run.scope = { mutate: [`${target}:1-1`] }; });
    const plan = /^the plan made now from its scope \(the patterns .*:1-1\) differs from the targets it saved/;
    await refused(otherScope, plan);
    await refused(copy('none'), /^it holds no run\.json, which a run writes before pass A starts/);
    const unread = copy('unread');
    fs.writeFileSync(path.join(unread, 'run.json'), '{"tree":');
    await refused(unread, /^its run\.json cannot be read/);
    const locks = copy('locks', run => { (run.packages as [string, string][])[1][1] = 'changed'; });
    expect(saved.packages[1][0]).toBe('test/node_modules/.package-lock.json');
    expect(await refused(locks, /^the tree or the packages differ from those the stopped run started on/)).toMatch(/: test\/node_modules\/\.package-lock\.json \(1 file\(s\)\)$/);

    const file = path.join(root, target);
    fs.writeFileSync(path.join(root, added), 'export const added = 1;\n');
    expect(await refused(report, /^the tree or the packages differ/)).toMatch(new RegExp(`: ${added.replace(/[.]/g, '\\.')} \\(1 file\\(s\\)\\)$`));
    fs.rmSync(path.join(root, added));
    // The same content at another time: the stopped run never reached its end-of-run check, so an edit made and undone shows only so.
    fs.utimesSync(file, time + 7, time + 7);
    expect(await refused(report, /^the tree or the packages differ/)).toMatch(new RegExp(`: ${target.replace(/[.]/g, '\\.')} \\(1 file\\(s\\)\\)$`));
    fs.utimesSync(file, time, time);
    // Another content of the same size at the same time.
    fs.writeFileSync(file, TEXT.replace('b > 0', 'b < 0'));
    fs.utimesSync(file, time, time);
    expect(await refused(report, /^the tree or the packages differ/)).toMatch(new RegExp(`: ${target.replace(/[.]/g, '\\.')} \\(1 file\\(s\\)\\)$`));
    fs.writeFileSync(file, TEXT);
    fs.utimesSync(file, time, time);
    // The tree as it was again: the resume passes the tree's check and stops only at the scope.
    await refused(otherScope, plan);
    expect(listing()).toEqual(before);
    expect(saved.scope).toEqual({ mutate: [target] });
    // Kills made under another Node, or under another stand-in for vitest, say nothing of a run under this one.
    const setupChanged = /^what ran its tests differs from what runs them now, so its results say nothing of a run here: /;
    const node = copy('node', run => { (run.setup as { version: string }).version = 'v0.0.1'; });
    expect(await refused(node, setupChanged)).toMatch(/: the Node binary \(.*, v0\.0\.1; now .*, v\d+\.\d+\.\d+\)$/);
    const nodePath = copy('node-path', run => { (run.setup as { path: string }).path = '/elsewhere/node'; });
    expect(await refused(nodePath, setupChanged)).toMatch(/: the Node binary \(\/elsewhere\/node, /);
    const otherStandIn = path.join(dir, 'other-vitest.cjs');
    fs.copyFileSync(standIn, otherStandIn);
    expect(await refused(report, setupChanged, { SMDB_MUTATION_VITEST: otherStandIn })).toContain(`: the stand-in for vitest (${standIn}; now ${otherStandIn})`);
    expect(listing()).toEqual(before);

    // The scope comes from run.json only. The stand-in and a bound keep a check that broke from running real tests.
    for (const extra of [['--base', 'main'], ['--mutate', target]]) {
      const r = spawnSync(process.execPath, [gate, '--resume', report, ...extra, '--concurrency', '1'],
        { cwd: root, encoding: 'utf8', timeout: 300_000, env: { ...process.env, SMDB_MUTATION_VITEST: standIn, SMDB_STANDIN_CALLS: path.join(dir, 'calls-usage.jsonl') } });
      expect(r.status, extra.join(' ')).toBe(2);
      expect(r.stderr).toMatch(/^--resume takes the scope from the stopped run's run\.json, so --base and --mutate cannot be given with it$/m);
      expect(r.stdout).toBe('');
    }
    expect(fs.existsSync(path.join(dir, 'calls-usage.jsonl'))).toBe(false);
    expect(listing()).toEqual(before);

    // The stopped run saved no plan of pass A, so the resume runs it whole, and goes on to the end.
    expect(fs.existsSync(path.join(report, 'a', 'plan.json'))).toBe(false);
    const whole = await gateRun(['--resume', report, '--concurrency', '1'], { report });
    expect(whole.code, `${whole.stdout}\n${whole.stderr}`).toBe(2);
    expect(whole.stdout).toMatch(/^Verdict: NO RESULT \(vitest was replaced by a test's stand-in /m);
    const dirA = /^ {2}a: the stopped run saved no plan of pass A, so it runs whole in (a|a-r1)\/$/m.exec(whole.stdout)?.[1];
    expect(dirA, whole.stdout).toBeDefined();
    expect(fs.existsSync(path.join(report, dirA!, 'targets.json'))).toBe(false);
    const planned = planOf(text(path.join(report, dirA!, 'plan.json')))!.map(m => m.key);
    expect(planned.length).toBeGreaterThan(5);
    const done = judged(report);
    expect(done.mutants.map(keyOf).sort()).toEqual([...planned].sort());
    for (const m of done.mutants) expect(m.passes.a?.dir, keyOf(m)).toBe(dirA);
    expect(done.mutants.some(m => m.passes.b)).toBe(true);

    // A resume of the finished run reads every stage back and runs nothing.
    const again = await gateRun(['--resume', report, '--concurrency', '1'], { report });
    expect(again.code, `${again.stdout}\n${again.stderr}`).toBe(2);
    expect(again.stdout).toMatch(/^Verdict: NO RESULT \(vitest was replaced by a test's stand-in /m);
    // A dir a holds no plan in is part of pass A's stage too, an attempt that stopped before it knew its mutants.
    const dirsA = fs.existsSync(path.join(report, 'a')) && dirA !== 'a' ? `a/, ${dirA}/` : `${dirA}/`;
    expect(again.stdout).toContain(`  a: finished before this resume (${dirsA}); its ${planned.length} result(s) are read back, and none runs again\n`);
    expect(again.calls).toEqual([]);
    expect(judged(report).outcomes).toEqual(done.outcomes);
    expect(readJson<{ resume: number }>(path.join(report, 'mutants.json')).resume).toBe(2);

    // What a stage saved must read as a run leaves it: each of these, in a copy of the finished run, is refused.
    const broken = (name: string, change: (at: string) => void) => {
      const at = path.join(dir, name);
      fs.cpSync(report, at, { recursive: true });
      fs.rmSync(path.join(at, 'lock.json'), { force: true });
      change(at);
      return at;
    };
    const twice = broken('twice', at => {
      const first = text(path.join(at, dirA!, 'results.jsonl')).split('\n')[0];
      fs.appendFileSync(path.join(at, dirA!, 'results.jsonl'), `${first}\n`);
    });
    expect(await refused(twice, new RegExp(`^${dirA}/ holds a second result for `), {}, true)).toBeDefined();
    const status = broken('status', at => {
      const lines = text(path.join(at, 'b', 'results.jsonl')).split('\n');
      lines[0] = lines[0].replace(/"status":"[A-Za-z]+"/, '"status":"Survivec"');
      fs.writeFileSync(path.join(at, 'b', 'results.jsonl'), lines.join('\n'));
    });
    expect(await refused(status, /^b\/results\.jsonl: line 1 holds the status "Survivec", which Stryker never reports for a tested mutant$/, {}, true)).toBeDefined();
    const later = broken('later', at => fs.mkdirSync(path.join(at, 'b2-9')));
    expect(await refused(later, /^it holds dirs of stages that come after the first stage that did not finish, or that this run does not reach: b2-9$/, {}, true)).toBeDefined();
    const noPlan = broken('noplan', at => fs.rmSync(path.join(at, dirA!, 'plan.json')));
    expect(await refused(noPlan, new RegExp(`^${dirA}/ holds results but no plan\\.json`), {}, true)).toBeDefined();
    const uncovered = broken('uncovered', at => {
      const lines = text(path.join(at, 'b', 'results.jsonl')).split('\n').filter(Boolean);
      fs.writeFileSync(path.join(at, 'b', 'results.jsonl'), `${lines.slice(1).join('\n')}\n`);
    });
    expect(await refused(uncovered, /^b\/ holds done\.json, but 1 of the \d+ item\(s\) the stage ran for have no result$/, {}, true)).toBeDefined();

    // A saved file that is there but cannot be read, of a Stryker stage and of a check with no mutant.
    expect(fs.existsSync(path.join(report, 'alone-a', 'done.json'))).toBe(true);
    const planDir = broken('plandir', at => { fs.rmSync(path.join(at, dirA!, 'plan.json')); fs.mkdirSync(path.join(at, dirA!, 'plan.json')); });
    expect(await refused(planDir, new RegExp(`^${dirA}/plan\\.json cannot be read \\(EISDIR\\)$`), {}, true)).toBeDefined();
    const planCut = broken('plancut', at => fs.writeFileSync(path.join(at, dirA!, 'plan.json'), '[{'));
    expect(await refused(planCut, new RegExp(`^${dirA}/plan\\.json cannot be read$`), {}, true)).toBeDefined();
    const targetsCut = broken('targetscut', at => fs.writeFileSync(path.join(at, 'b', 'targets.json'), '{'));
    expect(await refused(targetsCut, /^b\/targets\.json cannot be read$/, {}, true)).toBeDefined();
    const doneCut = broken('donecut', at => fs.writeFileSync(path.join(at, 'b', 'done.json'), '{'));
    expect(await refused(doneCut, /^b\/done\.json cannot be read$/, {}, true)).toBeDefined();
    const checksCut = broken('checkscut', at => fs.writeFileSync(path.join(at, 'alone-a', 'checks.json'), '{'));
    expect(await refused(checksCut, /^alone-a\/checks\.json cannot be read$/, {}, true)).toBeDefined();
    const checkDoneCut = broken('checkdonecut', at => fs.writeFileSync(path.join(at, 'alone-a', 'done.json'), '{'));
    expect(await refused(checkDoneCut, /^alone-a\/done\.json cannot be read$/, {}, true)).toBeDefined();
    const linesDir = broken('linesdir', at => { fs.rmSync(path.join(at, 'alone-a', 'checks.jsonl')); fs.mkdirSync(path.join(at, 'alone-a', 'checks.jsonl')); });
    expect(await refused(linesDir, /^alone-a\/checks\.jsonl cannot be read \(EISDIR\)$/, {}, true)).toBeDefined();

    // A run of sets the stopped gate started that still runs could still add a line: the resume waits, then refuses.
    const runnerLine = (pid: number) => `${JSON.stringify({ pid, started: '2026-11-12T00:00:00.000Z' })}\n`;
    const liveRunner = broken('liverunner', at => fs.writeFileSync(path.join(at, 'alone-a', `runner-${process.pid}.json`), runnerLine(process.pid)));
    expect(await refused(liveRunner, new RegExp(`^alone-a/runner-${process.pid}\\.json names process ${process.pid}, started 2026-11-12T00:00:00\\.000Z, a run of sets of test files the stopped gate started, which still runs and could still add a result there; end that process and the processes under it, then resume$`))).toBeDefined();
    const runnerCut = broken('runnercut', at => fs.writeFileSync(path.join(at, 'alone-a', 'runner-1.json'), '{'));
    expect(await refused(runnerCut, /^alone-a\/runner-1\.json cannot be read, so whether a run of sets of test files the stopped gate started still runs there is not known/)).toBeDefined();
    // One that no longer runs is passed over.
    const gone = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
    const deadRunner = broken('deadrunner', at => fs.writeFileSync(path.join(at, 'alone-a', `runner-${gone}.json`), runnerLine(gone)));
    const passed = await gateRun(['--resume', deadRunner, '--concurrency', '1']);
    expect(passed.code, `${passed.stdout}\n${passed.stderr}`).toBe(2);
    expect(passed.stdout).toMatch(/^Verdict: NO RESULT \(vitest was replaced by a test's stand-in /m);
    expect(passed.calls).toEqual([]);
    expect(fs.existsSync(path.join(deadRunner, 'alone-a', `runner-${gone}.json`))).toBe(true);
  });
});
