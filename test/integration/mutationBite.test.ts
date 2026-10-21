import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { beforeAll, describe, expect, it } from 'vitest';
import { pastBudget } from '../mutation/control.mjs';
import { PASSES } from '../mutation/passes.mjs';

// The L5 bite (VERIFY.md L5 and [A2]): one run of the gate on two lines of
// nodeIdentity.ts. consentsToActiveMode's return is in-process code, so the
// fast tier kills its mutants in pass A. The stand-in carry in
// consumeTakeoverFlags only shows across a restart, which no in-process test
// makes, so its mutants survive pass A and must die in pass B through the
// child scenario: proof that the active mutant reaches a child process and
// that the child loads the sandbox's own build. One mutant of the first line is
// equivalent ('' and the replacement both read as "not active"), so the run
// also shows the failing verdict and how a survivor is reported.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TARGET = 'src/bot/internalSetup/fleet/nodeIdentity.ts';

interface Pass { id: string | null; dir?: string; status: string; killedBy?: string; inconclusive?: string; recheck?: string }

// The ids a pass ran tests for (targets.mjs), as runner.mjs read them.
const ranFor = (reportDir: string, dir: string) => (JSON.parse(fs.readFileSync(path.join(root, reportDir, dir, 'run-ids.json'), 'utf8')) as string[]).sort();
interface Mutant { location: { start: { line: number } }; mutator: string; original: string; passes: { a: Pass; b?: Pass; b2?: Pass } }

function lineOf(text: string): number {
  const index = fs.readFileSync(path.join(root, TARGET), 'utf8').split('\n').findIndex(line => line.includes(text));
  if (index < 0) throw new Error(`the bite's target line "${text}" is gone from ${TARGET}; aim the bite at another line of the same kind`);
  return index + 1;
}

/**
 * Removes what a bite run cut short left under `at`'s src and test/mutation: each test removes its own files when it
 * ends, but an interrupt skips that, and a leftover importer of an ignored module would stop every gate run before
 * pass A. Only the names the tests below write: a developer's own clone in src/bot/modulesDev can start with smdb- too.
 * @param at a bot root
 */
function sweepLeftovers(at: string) {
  const src = path.join(at, 'src');
  const dev = path.join(src, 'bot', 'modulesDev');
  const mutation = path.join(at, 'test', 'mutation');
  for (const old of fs.readdirSync(src)) {
    if (/^smdb-(bite-(directive|other|probe|gone)|beyond|glob-\[x\])-\d+\.ts$/.test(old)) fs.rmSync(path.join(src, old), { force: true });
    else if (/^smdb-(ignored|repo)-\d+$/.test(old)) fs.rmSync(path.join(src, old), { recursive: true, force: true });
  }
  if (fs.existsSync(dev)) for (const old of fs.readdirSync(dev).filter(name => /^smdb-(beyond|bite-reader)-\d+\.ts$/.test(name))) fs.rmSync(path.join(dev, old), { force: true });
  if (fs.existsSync(mutation)) for (const old of fs.readdirSync(mutation).filter(name => /^smdb-tree-\d+\.txt$/.test(name))) fs.rmSync(path.join(mutation, old), { force: true });
}

describe('the touched-line mutation gate', () => {
  beforeAll(() => sweepLeftovers(root));

  it('sweeps only what a run cut short left, never a clone whose name starts the same', () => {
    const at = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-sweep-'));
    try {
      const dev = path.join(at, 'src', 'bot', 'modulesDev');
      fs.mkdirSync(path.join(dev, 'smdb-appstore'), { recursive: true });
      fs.writeFileSync(path.join(dev, 'smdb-appstore', 'index.ts'), 'export const x = 1;\n');
      for (const name of ['smdb-beyond-1.ts', 'smdb-bite-reader-1.ts']) fs.writeFileSync(path.join(dev, name), '');
      fs.mkdirSync(path.join(at, 'src', 'smdb-repo-1', '.git'), { recursive: true });
      for (const name of ['smdb-beyond-1.ts', 'smdb-bite-probe-1.ts', 'smdb-glob-[x]-1.ts', 'smdb-kept.ts']) fs.writeFileSync(path.join(at, 'src', name), '');
      // The tree probe the run after the reruns adds, which git does not ignore.
      const mutation = path.join(at, 'test', 'mutation');
      fs.mkdirSync(mutation, { recursive: true });
      for (const name of ['smdb-tree-1.txt', 'smdb-tree-x.txt']) fs.writeFileSync(path.join(mutation, name), '');
      sweepLeftovers(at);
      expect(fs.readdirSync(dev)).toEqual(['smdb-appstore']);
      expect(fs.readdirSync(path.join(at, 'src')).sort()).toEqual(['bot', 'smdb-kept.ts']);
      expect(fs.readdirSync(mutation)).toEqual(['smdb-tree-x.txt']);
    } finally {
      fs.rmSync(at, { recursive: true, force: true });
    }
  });

  it('kills in-process code in pass A and restart-only code in pass B through a child', { timeout: 900_000 }, () => {
    const fast = lineOf("return (process.env.FLEET_BACKUP_MODE || '').trim().toLowerCase() === 'active';");
    const child = lineOf('...(override.standIn === true ? { standIn: true } : {}),');
    const run = spawnSync(process.execPath, [
      path.join(root, 'test', 'mutation', 'touched.mjs'),
      '--mutate', `${TARGET}:${fast}-${fast}`,
      '--mutate', `${TARGET}:${child}-${child}`,
      '--concurrency', '2',
    ], { cwd: root, encoding: 'utf8', timeout: 850_000 });
    const reportDir = /^Report: (\S+)/m.exec(run.stdout)?.[1];
    expect(reportDir, `${run.stdout}\n${run.stderr}`).toBeDefined();
    const { mutants } = JSON.parse(fs.readFileSync(path.join(root, reportDir!, 'mutants.json'), 'utf8')) as { mutants: Mutant[] };
    const on = (line: number) => mutants.filter(m => m.location.start.line === line && m.passes.a.status !== 'CompileError');

    const equivalent = (m: Mutant) => m.mutator === 'StringLiteral' && m.original === "''";
    expect(on(fast).filter(equivalent)).toHaveLength(1);
    for (const m of on(fast).filter(m => !equivalent(m))) {
      expect(m.passes.a, `${m.mutator} ${m.original}`).toMatchObject({ status: 'Killed', killedBy: expect.stringMatching(/^unit\/backupMode\.test\.ts > /) });
    }
    expect(on(fast).filter(equivalent)[0]).toMatchObject({ passes: { a: { status: 'Survived' }, b: { status: 'Survived' } } });

    expect(on(child).length).toBeGreaterThan(0);
    for (const m of on(child)) {
      const byChild = { status: 'Killed', killedBy: expect.stringMatching(/^child\/fleetIdentity\.test\.ts > /) };
      expect(m.passes.a.status, `${m.mutator} ${m.original}`).toBe('Survived');
      expect(m.passes.b, `${m.mutator} ${m.original}`).toMatchObject(byChild);
      expect(m.passes.b2, `${m.mutator} ${m.original}: pass B's kill rerun alone`).toMatchObject(byChild);
    }

    expect(run.status).toBe(1);
    // One fast-check seed for the whole run, named in the report.
    expect(run.stdout).toMatch(/^Scope: the patterns .*; fast-check seed \d+$/m);
    expect(run.stdout).toMatch(/^Survivors .*\n {2}src\/bot\/internalSetup\/fleet\/nodeIdentity\.ts:\d+:\d+ StringLiteral: `''`/m);
    expect(run.stdout).not.toContain(`nodeIdentity.ts:${child}:`);
    const killedInA = on(fast).filter(m => !equivalent(m)).length;
    expect(run.stdout).toContain(`\n  killed in pass A: ${killedInA}; run in pass B: ${on(child).length + 1}, killed there: ${on(child).length}\n`);
    expect(run.stdout).toMatch(/^Runs with no mutant after the reruns:\n {2}after pass b2: passed /m);
    expect(run.stdout).toMatch(/^Verdict: FAIL$/m);
    // Pass B's kills reran with the one file that killed them, and so did the run with no mutant after them.
    for (const dir of ['b2-1', 'control-b2']) {
      const written = fs.readdirSync(path.join(root, reportDir!, dir)).filter(file => !['targets.json', 'run-ids.json', 'dry-ms.txt', 'dry-timing.json'].includes(file));
      expect(written.some(file => file.endsWith('-child.json')), dir).toBe(true);
      expect(written.filter(file => !file.includes('-child.')), dir).toEqual([]);
    }
    expect(fs.existsSync(path.join(root, reportDir!, 'b2-2'))).toBe(false);
    // Each real pass left Stryker's own time for its run with no mutant (targets.mjs) and runner.mjs's monotonic one,
    // and the two agree, so a sound run's reruns would be judged by their budget, not taken for a clock step.
    for (const dir of ['a', 'b', 'b2-1', 'control-b2']) {
      const at = path.join(root, reportDir!, dir);
      expect(pastBudget(at, at, PASSES.a2), dir).toBe('');
    }
    expect(pastBudget(path.join(root, reportDir!, 'b2-1'), path.join(root, reportDir!, 'control-b2'), PASSES.b2)).toBe('');
    // Pass B and its rerun ran tests for exactly the mutants they were for, matched in Stryker's own plan.
    expect(ranFor(reportDir!, 'b')).toEqual(mutants.filter(m => m.passes.b).map(m => m.passes.b!.id).sort());
    expect(ranFor(reportDir!, 'b2-1')).toEqual(on(child).map(m => m.passes.b2!.id).sort());
    fs.rmSync(path.join(root, reportDir!), { recursive: true, force: true });
  });

  /**
   * A gate run with a stand-in for vitest: the run with no mutant passes and
   * every mutant's test times out. Each run first runs `code`, the stand-in's
   * own JavaScript, with `file` its report's path, `pass` its pass's dir name
   * (`control-a2` for the run with no mutant after the reruns) and `mutant`
   * the active mutant; its `message`, if any, fails it. The gate mutates each
   * of `patterns` (whole files or line ranges), by default one line of the
   * bite's target.
   */
  function standInRun(code: string, patterns?: string[]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-control-'));
    const fake = path.join(dir, 'vitest.cjs');
    // Git-ignored files in the checkout (*.log), which no sandbox may hold: one
    // there from the start, one made during pass A, before pass A2 copies it.
    const canaries = [`smdb-canary-${process.pid}.log`, `smdb-canary-late-${process.pid}.log`];
    fs.writeFileSync(path.join(root, canaries[0]), 'ignored');
    fs.writeFileSync(fake, [
      "const fs = require('fs');",
      "const path = require('path');",
      "const file = process.argv.find(arg => arg.startsWith('--outputFile=')).slice('--outputFile='.length);",
      'const pass = path.basename(path.dirname(file));',
      'const mutant = process.env.__STRYKER_ACTIVE_MUTANT__;',
      "let message = mutant ? 'Error: Test timed out in 30000ms' : '';",
      `if (pass === 'a' && mutant) fs.writeFileSync(${JSON.stringify(path.join(root, canaries[1]))}, 'ignored');`,
      `if (${JSON.stringify(canaries)}.some(name => fs.existsSync(path.join('..', name)))) message = 'Error: the sandbox holds a git-ignored file';`,
      // The run with no mutant after the reruns runs the code they ran: made by Stryker, with no mutant active.
      "const made = name => { try { return fs.readFileSync(path.join('..', name), 'utf8').includes('stryMutAct_'); } catch { return false; } };",
      "if (pass.startsWith('control-') && !JSON.parse(process.env.SMDB_MUTATION_FILES).some(made)) message = 'Error: the run ran code the reruns did not';",
      "if (pass.startsWith('control-') && process.env.SMDB_TEST_TIME_SCALE !== '4') message = 'Error: the run had other time limits than the reruns';",
      code,
      "const test = { status: message ? 'failed' : 'passed', fullName: 'reads', failureMessages: message ? [message] : [] };",
      "fs.writeFileSync(file, JSON.stringify({ testResults: [{ name: 'unit/x.test.ts', status: test.status, assertionResults: [test] }] }));",
      'process.exit(message ? 1 : 0);',
      '',
    ].join('\n'));
    const line = lineOf("return (process.env.FLEET_BACKUP_MODE || '').trim().toLowerCase() === 'active';");
    // A mutant id left in the shell, which the gate must ignore.
    const run = spawnSync(process.execPath, [path.join(root, 'test', 'mutation', 'touched.mjs'), ...(patterns ?? [`${TARGET}:${line}-${line}`]).flatMap(pattern => ['--mutate', pattern]), '--concurrency', '1'],
      { cwd: root, encoding: 'utf8', timeout: 580_000, env: { ...process.env, SMDB_MUTATION_VITEST: fake, __STRYKER_ACTIVE_MUTANT__: '3' } });
    fs.rmSync(dir, { recursive: true, force: true });
    for (const name of canaries) fs.rmSync(path.join(root, name), { force: true });
    expect(run.stdout).not.toContain('the sandbox holds a git-ignored file');
    expect(run.stdout).not.toContain('the run ran code the reruns did not');
    expect(run.stdout).not.toContain('the run had other time limits than the reruns');
    const reportDir = /^Report: (\S+)/m.exec(run.stdout)?.[1];
    expect(reportDir, `${run.stdout}\n${run.stderr}`).toBeDefined();
    // A dir of its own: two runs that start in the same millisecond never share one.
    expect(reportDir!.endsWith(`-${run.pid}`), reportDir).toBe(true);
    const { mutants } = JSON.parse(fs.readFileSync(path.join(root, reportDir!, 'mutants.json'), 'utf8')) as { mutants: (Mutant & { passes: { a2?: Pass & { voided?: string } } })[] };
    const a2Ran = fs.existsSync(path.join(root, reportDir!, 'a2', 'run-ids.json')) ? ranFor(reportDir!, 'a2') : null;
    fs.rmSync(path.join(root, reportDir!), { recursive: true, force: true });
    if (a2Ran) expect(a2Ran).toEqual(mutants.filter(m => m.passes.a2).map(m => m.passes.a2!.id).sort());
    return { run, mutants };
  }

  it('counts nothing its reruns found, and has no result, when the run with no mutant after them fails', { timeout: 600_000 }, () => {
    // The run with no mutant after the reruns fails, after it adds a file to
    // the checkout and, as an install would, stamps the suite's packages'
    // lockfile anew (a file git ignores): the tree changed during the run.
    const added = `test/mutation/smdb-tree-${process.pid}.txt`;
    const lock = 'test/node_modules/.package-lock.json';
    const { run, mutants } = (() => {
      try {
        return standInRun([
          "if (pass === 'control-a2') {",
          `  fs.writeFileSync(${JSON.stringify(path.join(root, added))}, 'changed');`,
          `  fs.utimesSync(${JSON.stringify(path.join(root, lock))}, new Date(), new Date());`,
          "  message = 'Error: the database went away';",
          '}',
        ].join('\n'));
      } finally {
        fs.rmSync(path.join(root, added), { force: true });
      }
    })();

    const reran = mutants.filter(m => m.passes.a2);
    expect(reran.length).toBeGreaterThan(0);
    for (const m of reran) expect(m.passes.a2).toMatchObject({ voided: 'the run with no mutant after pass a2 failed' });
    expect(run.status).toBe(2);
    expect(run.stdout).toMatch(/^Verdict: NO RESULT \(vitest was replaced by a test's stand-in /m);
    expect(run.stdout).toMatch(/^Stopped:\n {2}the run with no mutant after pass a2 failed \(There were failed tests in the initial test run\.\), so what its reruns counted cannot be told from the machine's failures$/m);
    expect(run.stdout).toMatch(/^ {2}the run with no mutant failed in unit\/x\.test\.ts: Error: the database went away$/m);
    expect(run.stdout).toContain(`\nChanged during the run (so no one tree was tested):\n  ${added}, ${lock}\n`);
    expect(run.stdout).toMatch(/^Inconclusive .*\n {2}src\/bot\/internalSetup\/fleet\/nodeIdentity\.ts:\d+:\d+ .*\(the run with no mutant after pass a2 failed\)$/m);
    expect(run.stdout).not.toMatch(/^Timeouts /m);
    expect(run.stdout).not.toMatch(/^Runs with no mutant after the reruns:/m);
  });

  it('counts no timeout its reruns confirmed when the run with no mutant after them passes past their budget', { timeout: 600_000 }, () => {
    // The reruns' own run with no mutant is made to read 14 s shorter than
    // nothing, on Stryker's clock (a2/dry-timing.json) and on runner.mjs's
    // (a2/dry-ms.txt), so their budget is 4 x -14 s + 60 s = 4 s, and the run
    // after them passes in 5 s. A sandbox
    // another Stryker run left behind, with no .gitignore, is no change.
    const leftover = path.join(root, '.stryker-tmp', `smdb-leftover-${process.pid}`);
    fs.rmSync(path.join(root, '.stryker-tmp', '.gitignore'), { force: true });
    fs.mkdirSync(leftover, { recursive: true });
    fs.writeFileSync(path.join(leftover, 'a.ts'), 'export const a = 1;\n');
    const { run, mutants } = (() => {
      try {
        return standInRun([
          "if (pass === 'control-a2') {",
          "  fs.writeFileSync(path.join(path.dirname(path.dirname(file)), 'a2', 'dry-ms.txt'), '-14000');",
          "  fs.writeFileSync(path.join(path.dirname(path.dirname(file)), 'a2', 'dry-timing.json'), JSON.stringify({ net: -14000, overhead: 0 }));",
          '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);',
          '}',
        ].join('\n'));
      } finally {
        fs.rmSync(leftover, { recursive: true, force: true });
      }
    })();
    expect(run.stdout).not.toContain('Changed during the run');
    const reran = mutants.filter(m => m.passes.a2);
    expect(reran.length).toBeGreaterThan(0);
    for (const m of reran) expect(m.passes.a2).toMatchObject({ voided: 'the run with no mutant after pass a2 failed' });
    expect(run.status).toBe(2);
    expect(run.stdout).toMatch(/^Stopped:\n {2}the run with no mutant after pass a2 failed \(it took \d+ s, past the 4 s Stryker gave each rerun, so the machine was too slow then to tell a slow mutant from a slow run\)/m);
    expect(run.stdout).not.toMatch(/^Timeouts /m);
  });

  it("reruns alone a mutant whose run failed only on the machine's texts, and counts the failure when it repeats", { timeout: 600_000 }, () => {
    // Each mutant's code throws a file error, as code that renames onto a directory does on Windows.
    const { run, mutants } = standInRun(`if (mutant) message = "Error: EPERM: operation not permitted, rename 'a.tmp' -> 'a'";`);
    // The ones the type checker did not stop first.
    const ran = mutants.filter(m => m.passes.a.status !== 'CompileError');
    expect(ran.length).toBeGreaterThan(0);
    for (const m of ran) {
      expect(m.passes.a).toMatchObject({ recheck: 'unit/x.test.ts > reads', inconclusive: expect.stringMatching(/^only the machine failed: Error: EPERM/) });
      expect(m.passes.a2).toMatchObject({ killedBy: 'unit/x.test.ts > reads' });
    }
    expect(run.stdout).toMatch(new RegExp(`^L5: pass A again, one at a time, on ${ran.length} mutant\\(s\\) to confirm alone: `, 'm'));
    expect(run.stdout).toMatch(/^Runs with no mutant after the reruns:\n {2}after pass a2: passed/m);
    expect(run.stdout).not.toMatch(/^Inconclusive /m);
  });

  it('type-checks only the tree, and gives a mutant whose only type error is an unused @ts-expect-error pass A again with no checker', { timeout: 600_000 }, () => {
    const src = path.join(root, 'src');
    const ignored = path.join(src, 'bot', 'modulesDev');
    for (const old of fs.readdirSync(src).filter(name => /^smdb-bite-(directive|other)-/.test(name))) fs.rmSync(path.join(src, old), { force: true });
    for (const old of fs.readdirSync(ignored).filter(name => name.startsWith('smdb-bite-reader-'))) fs.rmSync(path.join(ignored, old), { force: true });
    const probe = `src/smdb-bite-directive-${process.pid}.ts`;
    // A second file the job changed, with no mutant of its own: every run must take its related tests too, as pass A does.
    const other = `src/smdb-bite-other-${process.pid}.ts`;
    fs.writeFileSync(path.join(root, other), 'export type SmdbOther = number;\n');
    const reader = path.join(ignored, `smdb-bite-reader-${process.pid}.ts`);
    fs.writeFileSync(path.join(root, probe), [
      'export const SMDB_PROBE = { retries: 3 };',
      'export function smdbDirective(log: (n: number) => void, ready: boolean): void {',
      '  // @ts-expect-error: a boolean has no such field',
      '  if (ready.missing) log(1);',
      '}',
      '',
    ].join('\n'));
    // A module cloned into the git-ignored src/bot/modulesDev that reads the probe: no sandbox holds it.
    fs.writeFileSync(reader, `import { SMDB_PROBE } from '../../smdb-bite-directive-${process.pid}';\nexport const smdbRetries: number = SMDB_PROBE.retries;\n`);
    try {
      // Pass A with no checker, and every rerun alone, fail only on the machine's texts; any run (its run with no
      // mutant too) fails outright unless vitest is given the other file as well.
      const { run, mutants } = standInRun([
        `if (mutant && (pass === 'a-unchecked' || pass === 'a2')) message = "Error: EBUSY: resource busy or locked, rmdir 'x'";`,
        "if (!process.argv.some(arg => arg.includes('smdb-bite-other-'))) message = \"Error: the run lacks the change's files\";",
      ].join('\n'), [probe, other]);
      expect(run.stdout).toContain(`\nPatterns that made no mutant:\n  ${other}`);
      expect(run.stdout).toMatch(/^Runs with no mutant after the reruns:\n {2}after pass a2: passed/m);
      expect(run.stdout).not.toMatch(/^Stopped:/m);
      // Emptying the object is a type error only in the ignored file, so it meets the tests (the stand-in times them
      // out), and its rerun alone counts the failure, whatever it says.
      const emptied = mutants.find(m => m.mutator === 'ObjectLiteral' && m.location.start.line === 1);
      expect(emptied?.passes.a).toMatchObject({ status: 'Killed', dir: 'a' });
      expect(emptied?.passes.a2).toMatchObject({ killedBy: 'unit/x.test.ts > reads', dir: 'a2' });
      // The condition's mutants leave the directive unused: they meet pass A's tests again with no checker, where the
      // machine's texts make a first run's failure a recheck, and go on like any other: their rerun alone counts it.
      const unused = mutants.filter(m => /^only the machine failed: Error: EBUSY/.test(m.passes.a.inconclusive ?? ''));
      expect(unused.length).toBeGreaterThan(0);
      expect(run.stdout).toMatch(new RegExp(`^L5: pass A again, with no type checker, on ${unused.length} mutant\\(s\\) whose only type error is an unused @ts-expect-error$`, 'm'));
      for (const m of unused) {
        // Its pass A id is that run's, in its own dir: Stryker numbers each run's mutants anew.
        expect(m.passes.a, m.mutator).toMatchObject({ status: 'Killed', recheck: 'unit/x.test.ts > reads', dir: 'a-unchecked' });
        expect(m.passes.a2?.killedBy, m.mutator).toBe('unit/x.test.ts > reads');
      }
      expect(mutants.filter(m => m.passes.a.status === 'CompileError' && m.passes.a.inconclusive)).toEqual([]);
      expect(run.stdout).not.toMatch(/^Inconclusive /m);
    } finally {
      fs.rmSync(path.join(root, probe), { force: true });
      fs.rmSync(path.join(root, other), { force: true });
      fs.rmSync(reader, { force: true });
    }
  });

  /**
   * A stand-in gate run on a throwaway untracked file in src (never a tracked
   * one: a run cut short leaves it behind) that gains a way to /data in the
   * checkout during pass `when`'s mutant runs.
   */
  function probeRun(when: 'a' | 'a2') {
    const src = path.join(root, 'src');
    for (const old of fs.readdirSync(src).filter(name => name.startsWith('smdb-bite-probe-'))) fs.rmSync(path.join(src, old), { force: true });
    const probe = `src/smdb-bite-probe-${process.pid}.ts`;
    fs.writeFileSync(path.join(root, probe), 'export function smdbProbe(a: number): number {\n  return a + 1;\n}\n');
    try {
      const { run } = standInRun([
        `const probe = ${JSON.stringify(path.join(root, probe))};`,
        `if (pass === '${when}' && mutant && !fs.readFileSync(probe, 'utf8').includes('smdbRoute')) fs.appendFileSync(probe, "export const smdbRoute = 'DATA_DIR';\\n");`,
      ].join('\n'), [probe]);
      return { run, probe };
    } finally {
      fs.rmSync(path.join(root, probe), { force: true });
    }
  }

  it('refuses a way to /data that a file gains after the plan, before any mutant runs on it', { timeout: 600_000 }, () => {
    // Gained during pass A: pass A2 copies it, and its run with no mutant refuses it.
    const { run, probe } = probeRun('a');
    expect(run.status).toBe(2);
    expect(run.stdout).toMatch(/^Stopped:\n {2}pass a2 could not run: /m);
    expect(run.stdout).toContain(`\n  ${probe}: it reads DATA_DIR or holds a fixed root`);
    expect(run.stdout).not.toContain('a2/dry-*.log');
    expect(run.stdout).toContain(`\nChanged during the run (so no one tree was tested):\n  ${probe}`);
  });

  it('refuses it in the run with no mutant after the reruns, too, and says so', { timeout: 600_000 }, () => {
    // Gained during pass A2's reruns, which ran on the copy without it: the run after them, on a copy made then, refuses it.
    const { run, probe } = probeRun('a2');
    expect(run.status).toBe(2);
    expect(run.stdout).toMatch(/^Stopped:\n {2}the run with no mutant after pass a2 failed: it refused the files the reruns ran on$/m);
    expect(run.stdout).toContain(`\n  ${probe}: it reads DATA_DIR or holds a fixed root`);
    expect(run.stdout).not.toContain('its logs:');
  });

  it('still writes its report, naming the file, when a target that made no mutant is deleted during the run', { timeout: 600_000 }, () => {
    const src = path.join(root, 'src');
    for (const old of fs.readdirSync(src).filter(name => name.startsWith('smdb-bite-gone-'))) fs.rmSync(path.join(src, old), { force: true });
    const gone = `src/smdb-bite-gone-${process.pid}.ts`;
    fs.writeFileSync(path.join(root, gone), 'export type Gone = number;\n');
    try {
      // Taken out of the checkout by pass A's run with no mutant (its copy in the sandbox stays).
      const { run } = standInRun(`if (pass === 'a') fs.rmSync(${JSON.stringify(path.join(root, gone))}, { force: true });`, [`${gone}:1-1`]);
      expect(run.stdout).toContain(`\nChanged during the run (so no one tree was tested):\n  ${gone}`);
      expect(run.stdout).not.toContain('the report could not be written');
    } finally {
      fs.rmSync(path.join(root, gone), { force: true });
    }
  });

  it('has no result, exit 2, when its base is unknown or its patterns make no mutant, and refuses a glob or a missing file', { timeout: 300_000 }, () => {
    const gate = (...args: string[]) => spawnSync(process.execPath, [path.join(root, 'test', 'mutation', 'touched.mjs'), ...args], { cwd: root, encoding: 'utf8', timeout: 280_000 });
    // Each refusal runs with a stand-in for vitest that does not exist, so a
    // refusal that broke would run no test (dataRoot.ts's against /data).
    const refuse = (...args: string[]) => spawnSync(process.execPath, [path.join(root, 'test', 'mutation', 'touched.mjs'), ...args, '--concurrency', '1'],
      { cwd: root, encoding: 'utf8', timeout: 280_000, env: { ...process.env, SMDB_MUTATION_VITEST: path.join(os.tmpdir(), `smdb-no-vitest-${process.pid}.cjs`) } });
    const clean = (stdout: string) => {
      const dir = /^Report: (\S+)/m.exec(stdout)?.[1];
      if (dir) fs.rmSync(path.join(root, dir), { recursive: true, force: true });
    };

    expect(gate('--help').status).toBe(2);
    const outside = path.join(os.tmpdir(), `smdb-outside-${process.pid}.ts`);
    fs.writeFileSync(outside, 'export const x = 1;\n');
    // A file in the bot root (the git-ignored report dir) holding a line break Stryker counts and the gate does not.
    const broken = `test/mutation/reports/smdb-break-${process.pid}.ts`;
    fs.mkdirSync(path.dirname(path.join(root, broken)), { recursive: true });
    fs.writeFileSync(path.join(root, broken), `export const s = 'a${String.fromCharCode(0x2028)}b';\n`);
    // Files in src that git neither tracks nor would add: one it ignores (a logs dir) and one in an untracked repository.
    const unlisted = [`src/smdb-ignored-${process.pid}/logs/x.ts`, `src/smdb-repo-${process.pid}/x.ts`];
    const globbed = `src/smdb-glob-[x]-${process.pid}.ts`;
    // A file in src that imports, by type only, a module in the git-ignored src/bot/modulesDev.
    const importer = `src/smdb-beyond-${process.pid}.ts`;
    const imported = `src/bot/modulesDev/smdb-beyond-${process.pid}.ts`;
    try {
      for (const file of unlisted) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), 'export const x = 1;\n');
      }
      execFileSync('git', ['init', '-q'], { cwd: path.join(root, path.dirname(unlisted[1])) });
      for (const file of unlisted) {
        const refused = refuse('--mutate', file);
        expect(refused.status, file).toBe(2);
        expect(refused.stderr).toContain(`--mutate cannot take ${file}: git neither tracks it nor would add it`);
      }
      for (const pattern of ['src/**/*.ts', 'src/bot/internalSetup/fleet/+(nodeIdentity|takeover).ts', 'src/no/such/file.ts:1-5', `${TARGET}:3:0-3:10`, outside]) {
        const refused = refuse('--mutate', pattern);
        expect(refused.status, pattern).toBe(2);
        expect(refused.stderr).toContain(`--mutate takes a file in the bot root that exists, or such a file and lines, never a glob: ${pattern}`);
      }
      const refused = refuse('--mutate', broken);
      expect(refused.status).toBe(2);
      expect(refused.stderr).toContain(`--mutate cannot take ${broken}: it holds a line break Stryker counts and the gate does not`);
      // The type checker would judge the imported module, which no sandbox holds: the gate stops before pass A.
      fs.writeFileSync(path.join(root, imported), 'export type SmdbBeyond = number;\n');
      fs.writeFileSync(path.join(root, importer), `import type { SmdbBeyond } from './bot/modulesDev/smdb-beyond-${process.pid}';\nexport const smdbBeyond: SmdbBeyond = 1;\n`);
      const beyondRefused = refuse('--mutate', importer);
      clean(beyondRefused.stdout);
      expect(beyondRefused.status, beyondRefused.stdout).toBe(2);
      expect(beyondRefused.stdout).toContain(`\nStopped:\n  the type checker would judge ${imported}, which a file in the tree imports or references but no sandbox holds (`);
      expect(beyondRefused.stdout).toContain("; make the tree's file stop importing or referencing it, add it to the tree if it belongs there, or move a node_modules above the checkout away\n");
      // A file that exists, in the tree, under a name Stryker reads as a glob.
      fs.writeFileSync(path.join(root, globbed), 'export const x = 1;\n');
      const globRefused = refuse('--mutate', globbed);
      expect(globRefused.status).toBe(2);
      expect(globRefused.stderr).toContain(`--mutate cannot take ${globbed}: its name holds characters Stryker reads as a glob`);
      // The suite's own env scrub and config: --mutate takes only what a diff would mutate.
      for (const file of ['test/helpers/env.ts', 'test/vitest.config.ts']) {
        const outsideSrc = refuse('--mutate', file);
        clean(outsideSrc.stdout);
        expect(outsideSrc.status, file).toBe(2);
        expect(outsideSrc.stderr).toContain(`--mutate cannot take ${file}: outside src`);
      }
    } finally {
      fs.rmSync(outside, { force: true });
      fs.rmSync(path.join(root, broken), { force: true });
      fs.rmSync(path.join(root, globbed), { force: true });
      fs.rmSync(path.join(root, importer), { force: true });
      fs.rmSync(path.join(root, imported), { force: true });
      for (const file of unlisted) fs.rmSync(path.join(root, file.split('/').slice(0, 2).join('/')), { recursive: true, force: true });
    }

    const unknown = gate('--base', 'no-such-ref-anywhere');
    clean(unknown.stdout);
    expect(unknown.status, unknown.stderr).toBe(2);
    expect(unknown.stdout).toMatch(/^Stopped:\n {2}the gate stopped: Command failed: git .*merge-base no-such-ref-anywhere HEAD/m);
    expect(unknown.stdout).toMatch(/^Verdict: NO RESULT \(the gate stopped before it finished\)$/m);

    // The file's opening comment and first import: no mutant can be made there.
    // Spelled the way a shell may complete it (on Windows, in another case too),
    // it is taken under the name it has on disk.
    const spelled = process.platform === 'win32' ? `.\\${TARGET.replace(/^src/, 'SRC').split('/').join('\\')}` : `./${TARGET}`;
    const nothing = gate('--mutate', `${spelled}:1-5`, '--concurrency', '1');
    clean(nothing.stdout);
    expect(nothing.status, nothing.stderr).toBe(2);
    expect(nothing.stdout).toMatch(/^Patterns that made no mutant:\n {2}src\/bot\/internalSetup\/fleet\/nodeIdentity\.ts:1-5$/m);
    expect(nothing.stdout).toMatch(/^Changed lines of code no mutant lies wholly on .*\n {2}src\/bot\/internalSetup\/fleet\/nodeIdentity\.ts: 5$/m);
    expect(nothing.stdout).toMatch(/^Verdict: NO RESULT \(no gating mutant was made/m);

    // dataRoot.ts is never mutated.
    const data = refuse('--mutate', 'src/utils/dataRoot.ts:8-8');
    clean(data.stdout);
    expect(data.status, data.stderr).toBe(2);
    expect(data.stderr).toContain("--mutate cannot take src/utils/dataRoot.ts: it reads DATA_DIR or holds a fixed root");
  });
});
