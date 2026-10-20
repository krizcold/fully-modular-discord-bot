import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { pastBudget } from '../mutation/control.mjs';

// The command every mutant run executes (mutation/runner.mjs), against a
// stand-in for vitest that records how it was called and fails the tiers it is
// told to; and the time check of the run with no mutant after the reruns.

const root = path.resolve(__dirname, '..', '..');

interface Call { project: string; args: string[]; scale: string | null; mutant: string | null }

function fakeVitest(fail: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-runner-'));
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = path.join(dir, 'calls.jsonl');
  const script = path.join(dir, 'vitest.cjs');
  fs.writeFileSync(script, [
    "const fs = require('fs');",
    'const args = process.argv.slice(2);',
    "const project = args[args.indexOf('--project') + 1];",
    `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ project, args, scale: process.env.SMDB_TEST_TIME_SCALE ?? null, mutant: process.env.__STRYKER_ACTIVE_MUTANT__ ?? null }) + '\\n');`,
    `process.exit(${JSON.stringify(fail)}.includes(project) ? 1 : 0);`,
    '',
  ].join('\n'));
  const out = path.join(dir, 'out');
  fs.mkdirSync(out);
  const read = (): Call[] => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Call) : []);
  return { script, out, read };
}

function runner(fake: { script: string; out: string }, pass: string, confirm: string, only: string[] = [], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [path.join(root, 'test', 'mutation', 'runner.mjs')], {
    encoding: 'utf8',
    env: {
      ...process.env, SMDB_MUTATION_VITEST: fake.script, SMDB_MUTATION_PASS: pass, SMDB_MUTATION_FILES: '["src/a.ts"]', SMDB_MUTATION_OUT: fake.out,
      SMDB_MUTATION_CONFIRM: confirm, SMDB_MUTATION_ONLY: JSON.stringify(only), SMDB_MUTATION_RUN: '', __STRYKER_ACTIVE_MUTANT__: '7', ...env,
    },
  });
}

describe('a mutant run', () => {
  it('stops at the first failing test and tier, at vitest\'s own time limits', () => {
    const fake = fakeVitest(['integration']);
    expect(runner(fake, 'b', '').status).toBe(1);
    const calls = fake.read();
    expect(calls.map(call => call.project)).toEqual(['integration']);
    expect(calls[0]).toMatchObject({ scale: '1', mutant: '7' });
    expect(calls[0].args).toEqual(expect.arrayContaining(['related', '../src/a.ts', '--bail=1']));
  });

  it('refuses, before any mutant, a file that holds a way to /data as the pass copied it', () => {
    const fake = fakeVitest([]);
    const run = runner(fake, 'a', '', [], { __STRYKER_ACTIVE_MUTANT__: undefined, SMDB_MUTATION_FILES: '["src/utils/dataRoot.ts"]' });
    expect(run.status).toBe(1);
    expect(fs.readFileSync(path.join(fake.out, 'dry-refused.txt'), 'utf8')).toMatch(/^src\/utils\/dataRoot\.ts: it reads DATA_DIR or holds a fixed root \('\/data' or '\/app', or a path under either\)/);
    expect(fake.read()).toEqual([]);
  });

  it('refuses, before any mutant, a file it cannot read, as it may hold such a way', () => {
    const fake = fakeVitest([]);
    // A dir in a file's place: every platform fails to read it as one.
    const run = runner(fake, 'a', '', [], { __STRYKER_ACTIVE_MUTANT__: undefined, SMDB_MUTATION_FILES: '["src/utils", "src/utils/dataRoot.ts"]' });
    expect(run.status).toBe(1);
    expect(fs.readFileSync(path.join(fake.out, 'dry-refused.txt'), 'utf8'))
      .toMatch(/^src\/utils\/dataRoot\.ts: it reads DATA_DIR .*; src\/utils: it could not be read, so it was not checked for a way to a fixed root\n$/);
    expect(fake.read()).toEqual([]);
  });

  it.runIf(process.platform === 'win32')('names a command line too long to start vitest in the run\'s log', () => {
    const fake = fakeVitest([]);
    const files: string[] = [];
    while (JSON.stringify(files).length < 32_500) files.push(`src/${'x'.repeat(40)}${files.length}.ts`);
    expect(runner(fake, 'a', '', [], { SMDB_MUTATION_FILES: JSON.stringify(files) }).status).toBe(1);
    expect(fs.readFileSync(path.join(fake.out, '7-fast.log'), 'utf8')).toMatch(/^runner\.mjs could not start vitest: /);
    expect(fake.read()).toEqual([]);
  });

  it('reruns pass A\'s tests with four times the time', () => {
    const fake = fakeVitest([]);
    expect(runner(fake, 'a', '1').status).toBe(0);
    const calls = fake.read();
    expect(calls.map(call => call.project)).toEqual(['fast']);
    expect(calls[0]).toMatchObject({ scale: '4', mutant: '7' });
    expect(calls[0].args).toEqual(expect.arrayContaining(['related', '--bail=1']));
  });

  it('reruns only the test files given, each in its tier, stopping at the first failure', () => {
    const only = ['integration/store.test.ts', 'child/fleetIdentity.test.ts', 'child/takeover.test.ts'];
    const failing = fakeVitest(['integration']);
    expect(runner(failing, 'b', '1', only).status).toBe(1);
    expect(failing.read().map(call => call.project)).toEqual(['integration']);

    const passing = fakeVitest([]);
    expect(runner(passing, 'b', '1', only).status).toBe(0);
    const calls = passing.read();
    expect(calls.map(call => [call.project, call.scale])).toEqual([['integration', '4'], ['child', '4']]);
    expect(calls[0].args.slice(0, 2)).toEqual(['run', 'integration/store.test.ts']);
    expect(calls[1].args.slice(0, 3)).toEqual(['run', 'child/fleetIdentity.test.ts', 'child/takeover.test.ts']);
    for (const call of calls) expect(call.args).toContain('--bail=1');
  });

  it('leaves the time of a run with no mutant, which the run after the reruns is held to, and only of one', () => {
    const fake = fakeVitest([]);
    expect(runner(fake, 'a', '1').status).toBe(0);
    expect(fs.existsSync(path.join(fake.out, 'dry-ms.txt'))).toBe(false);
    // A run with no mutant reads its files: one that exists and holds no way to a fixed root.
    expect(runner(fake, 'a', '1', [], { __STRYKER_ACTIVE_MUTANT__: undefined, SMDB_MUTATION_FILES: '["test/mutation/control.mjs"]' }).status).toBe(0);
    // By a monotonic clock.
    expect(fs.readFileSync(path.join(fake.out, 'dry-ms.txt'), 'utf8')).toMatch(/^\d+$/);
  });
});

describe('a pass on some of the mutants Stryker made', () => {
  it('runs no test for a mutant the pass is not for, as its plan says, and every test when the plan is missing', () => {
    const fake = fakeVitest([]);
    const plan = path.join(fake.out, 'run-ids.json');
    fs.writeFileSync(plan, JSON.stringify(['3']));
    expect(runner(fake, 'b', '', [], { SMDB_MUTATION_RUN: plan }).status).toBe(0);
    expect(fake.read()).toEqual([]);
    expect(runner(fake, 'b', '', [], { SMDB_MUTATION_RUN: plan, __STRYKER_ACTIVE_MUTANT__: '3' }).status).toBe(0);
    expect(fake.read().map(call => call.mutant)).toEqual(['3', '3']);
    expect(runner(fake, 'b', '', [], { SMDB_MUTATION_RUN: path.join(fake.out, 'missing.json') }).status).toBe(0);
    expect(fake.read().map(call => call.mutant)).toEqual(['3', '3', '7', '7']);
  });

  it('learns from Stryker\'s plan which mutant ids those are, by file, mutator, replacement and place', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-plan-'));
    onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
    const targets = path.join(dir, 'targets.json');
    const run = path.join(dir, 'run-ids.json');
    fs.writeFileSync(targets, JSON.stringify(['src/a.ts|EqualityOperator|a >= 0|10:3-10:9']));
    vi.stubEnv('SMDB_MUTATION_TARGETS', targets);
    vi.stubEnv('SMDB_MUTATION_RUN', run);
    const { strykerPlugins } = await import('../mutation/targets.mjs');
    const Reporter = strykerPlugins[0].injectableClass as unknown as new () => { onMutationTestingPlanReady(event: unknown): void };
    // Stryker's plan holds 0-based places; its results, and so the targets, 1-based ones.
    const planned = (id: string, replacement: string, line: number) =>
      ({ plan: 'Run', mutant: { id, fileName: path.join(root, 'src', 'a.ts'), mutatorName: 'EqualityOperator', replacement, location: { start: { line, column: 2 }, end: { line, column: 8 } } } });
    new Reporter().onMutationTestingPlanReady({ mutantPlans: [planned('1', 'a >= 0', 9), planned('2', 'a <= 0', 9), planned('3', 'a >= 0', 10)] });
    expect(JSON.parse(fs.readFileSync(run, 'utf8'))).toEqual(['1']);
  });

  it("leaves, in every pass, Stryker's own time for the run with no mutant, which each rerun's budget is built from", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-timing-'));
    onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
    const { strykerPlugins } = await import('../mutation/targets.mjs');
    const Reporter = strykerPlugins[0].injectableClass as unknown as new () => { onDryRunCompleted(event: unknown): void };
    vi.stubEnv('SMDB_MUTATION_OUT', dir);
    new Reporter().onDryRunCompleted({ result: {}, timing: { net: 30_012, overhead: 41 }, capabilities: {} });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'dry-timing.json'), 'utf8'))).toEqual({ net: 30_012, overhead: 41 });
  });
});

describe('the run with no mutant after the reruns', () => {
  it('clears the reruns\' timeouts only when it fits in the budget Stryker gave each rerun', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-budget-'));
    onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
    const [reruns, out] = [path.join(dir, 'a2'), path.join(dir, 'control-a2')];
    fs.mkdirSync(reruns);
    fs.mkdirSync(out);
    const time = (where: string, ms: string) => fs.writeFileSync(path.join(where, 'dry-ms.txt'), ms);
    const stryker = (timing: unknown) => fs.writeFileSync(path.join(reruns, 'dry-timing.json'), JSON.stringify(timing));
    const budget = { timeoutFactor: 4, timeoutMS: 60_000 };
    // The budget as Stryker built it, from its own time for the reruns' run: 4 x 10 s + 60 s + its overhead.
    stryker({ net: 10_000, overhead: 0 });
    time(reruns, '10000');
    time(out, '100000');
    expect(pastBudget(reruns, out, budget)).toBe('');
    const past = 'it took 101 s, past the 100 s Stryker gave each rerun, so the machine was too slow then to tell a slow mutant from a slow run';
    time(out, '100600');
    expect(pastBudget(reruns, out, budget)).toBe(past);
    stryker({ net: 10_000, overhead: 700 });
    expect(pastBudget(reruns, out, budget)).toBe('');
    // Stryker's clock and the run's monotonic one a little apart (the shell and Node's start) is no step.
    stryker({ net: 10_400, overhead: 0 });
    time(reruns, '10000');
    time(out, '101500');
    expect(pastBudget(reruns, out, budget)).toBe('');
    // Stryker's process took in a clock step during the reruns' run (forward days, back seconds, or in its overhead).
    const stepped = "Stryker's own time for the reruns' run with no mutant does not match that run's monotonic time, so the clock of Stryker's process stepped and the budget it gave each rerun was not four times what they took";
    time(reruns, '30000');
    time(out, '30400');
    for (const timing of [{ net: 604_830_000, overhead: 0 }, { net: 1000, overhead: 0 }, { net: 30_000, overhead: 604_800_000 }, { net: 30_000, overhead: -5 }]) {
      stryker(timing);
      expect(pastBudget(reruns, out, budget), JSON.stringify(timing)).toBe(stepped);
    }
    const unread = "its time, or the time of the reruns' own run with no mutant, could not be read";
    stryker({ net: 30_000, overhead: 0 });
    for (const text of ['soon', '']) {
      time(out, text);
      expect(pastBudget(reruns, out, budget), text).toBe(unread);
    }
    time(out, '1');
    for (const timing of [{ net: 30_000 }, { net: 'soon', overhead: 0 }, null]) {
      stryker(timing);
      expect(pastBudget(reruns, out, budget), JSON.stringify(timing)).toBe(unread);
    }
    fs.rmSync(path.join(reruns, 'dry-timing.json'));
    expect(pastBudget(reruns, out, budget)).toBe(unread);
  });

});

describe('the tree fingerprint', () => {
  it('ends the gate NO RESULT, exit 2, when git cannot list the tree', () => {
    const run = spawnSync(process.execPath, [path.join(root, 'test', 'mutation', 'touched.mjs'), '--concurrency', '1'],
      { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_DIR: path.join(os.tmpdir(), `smdb-no-git-${process.pid}`) } });
    expect(run.status).toBe(2);
    expect(run.stdout).toMatch(/^Verdict: NO RESULT \(the gate could not read the tree: /m);
  });

  // The gate copied to a root of its own.
  const copyGate = (copy: string) => {
    fs.cpSync(path.join(root, 'test', 'mutation'), path.join(copy, 'test', 'mutation'), { recursive: true, filter: source => path.basename(source) !== 'reports' });
  };

  it('ends the gate NO RESULT, exit 2, when it cannot make .stryker-tmp, and says so', () => {
    // The gate copied to a root of its own, whose .stryker-tmp is a file; its packages are linked, never copied.
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-tmpdir-'));
    const packages = path.join(copy, 'test', 'node_modules');
    onTestFinished(() => {
      fs.unlinkSync(packages);
      fs.rmSync(copy, { recursive: true, force: true });
    });
    copyGate(copy);
    fs.symlinkSync(path.join(root, 'test', 'node_modules'), packages, 'junction');
    fs.writeFileSync(path.join(copy, '.stryker-tmp'), '');
    const run = spawnSync(process.execPath, [path.join(copy, 'test', 'mutation', 'touched.mjs')], { cwd: copy, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(2);
    expect(run.stdout).toMatch(/^Verdict: NO RESULT \(the gate could not make \.stryker-tmp, where Stryker puts its sandboxes: /m);
  });

  it("ends the gate NO RESULT, exit 2, naming the path, in a checkout whose path Stryker reads as a glob", () => {
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-globroot-'));
    const copy = path.join(outer, 'bot [old]');
    const packages = path.join(copy, 'test', 'node_modules');
    onTestFinished(() => {
      fs.unlinkSync(packages);
      fs.rmSync(outer, { recursive: true, force: true });
    });
    copyGate(copy);
    fs.symlinkSync(path.join(root, 'test', 'node_modules'), packages, 'junction');
    const run = spawnSync(process.execPath, [path.join(copy, 'test', 'mutation', 'touched.mjs')], { cwd: copy, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(2);
    expect(run.stdout).toMatch(/^Verdict: NO RESULT \(the checkout's path, .*\/bot \[old\], does not match itself read as a glob, as Stryker reads it: /m);
    expect(fs.existsSync(path.join(copy, '.stryker-tmp'))).toBe(false);
  });

  it('ends the gate NO RESULT, exit 2, on stdout with every other verdict, when the test packages are missing', () => {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-noinstall-'));
    onTestFinished(() => fs.rmSync(copy, { recursive: true, force: true }));
    copyGate(copy);
    const run = spawnSync(process.execPath, [path.join(copy, 'test', 'mutation', 'touched.mjs')], { cwd: copy, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(2);
    expect(run.stdout).toMatch(/^Verdict: NO RESULT \(the gate could not load: .*; run npm run test:install\)$/m);
  });

  it('is taken, in the gate, before it reads a file: the --mutate checks and the plan', () => {
    const gate = fs.readFileSync(path.join(root, 'test', 'mutation', 'touched.mjs'), 'utf8');
    const print = gate.indexOf('planned = treePrint(');
    expect(print).toBeGreaterThan(0);
    expect(print).toBeLessThan(gate.indexOf('opts.mutate = opts.mutate.map('));
    expect(print).toBeLessThan(gate.indexOf('planFromGit({'));
  });

  it('gives pass A every target of a file, gates by any of them, and runs only when one can gate (ranges.mjs)', () => {
    const gate = fs.readFileSync(path.join(root, 'test', 'mutation', 'touched.mjs'), 'utf8');
    expect(gate).toContain('gating: gatesIn(targets, file, r.location)');
    expect(gate).toContain('const canGate = target => target.gating === null || target.gating.length > 0;');
    // One list: Stryker mutates, and every run is given, the files a target can gate in (each with all its targets),
    // never one where code was only taken out, so each run with no mutant checks every file Stryker made code in.
    expect(gate).toContain('const mutated = () => targets.filter(target => targets.some(other => other.file === target.file && canGate(other)));');
    expect(gate).toContain('const changedFiles = () => [...new Set(mutated().map(target => target.file))];');
    expect(gate).toContain('mutate: mutatePatterns(mutated())');
    // The run with no mutant after the reruns makes their spans, with their time limits, bound above their budget.
    expect(gate).toContain("await stryker({ dir, tier, mutate: [...new Set(on.map(spanOf))], only, alone: true, extra: { ...(tier === 'a' ? PASSES.a2 : PASSES.b2), dryRunOnly: true, dryRunTimeoutMinutes: 60 } });");
    expect(gate).toContain('const results = await pass({ dir, tier, mutate: [...new Set(on.map(spanOf))],');
    // ... handed the very mutants the reruns ran on.
    expect(gate).toContain("await passOn('a2', 'a2', 'a', confirmA, PASSES.a2);");
    expect(gate).toContain("if (confirmA.some(credited)) await control('a2', 'a', confirmA, [], confirmA.some(m => outcome(m) === 'Timeout'));");
    expect(gate).toContain('for (const [killer, on] of killers) {');
    expect(gate).toContain("const killers = byKiller(confirmB);");
    expect(gate).toContain("if (confirmB.some(credited)) await control('b2', 'b', confirmB, [...killers.keys()]);");
    // ... and mutated with --mutate only where the tree lists a file under its own name.
    expect(gate).toContain('inTree ??= ownNames(root, planned.keys());');
    const guard = gate.indexOf('if (!targets.some(canGate)) await finish();');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(gate.indexOf("await pass({ dir: 'a'"));
  });
});

describe('the gate under an old node', () => {
  // The node on PATH may be older than 22.12 (the lane's Windows box has 20.16); CI's is not, and skips this.
  // No shell: one would split a checkout path that holds a space.
  const probe = spawnSync('node', ['-p', 'process.versions.node'], { encoding: 'utf8' });
  const version = probe.status === 0 ? probe.stdout.trim() : '';
  const [major, minor] = version.split('.').map(Number);
  it.runIf(version !== '' && (major < 22 || (major === 22 && minor < 12)))('stops, naming the version, when SMDB_TEST_NODE is old too, instead of relaunching again', () => {
    const run = spawnSync('node', [path.join(root, 'test', 'mutation', 'touched.mjs'), '--help'],
      { encoding: 'utf8', timeout: 30_000, env: { ...process.env, SMDB_TEST_NODE: 'node', SMDB_MUTATION_RELAUNCHED: '' } });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(`SMDB_TEST_NODE (node) runs v${version}`);
  });
});

describe('the time limits', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("give the config's test and hook limits and a child step's default bound four times their time in a rerun", async () => {
    vi.stubEnv('SMDB_TEST_TIME_SCALE', '4');
    vi.resetModules();
    const config = (await import('../vitest.config')).default as { test: { testTimeout: number; hookTimeout: number } };
    expect(config.test).toMatchObject({ testTimeout: 120_000, hookTimeout: 720_000 });
    expect((await import('../helpers/time.mjs')).STEP_MS).toBe(80_000);
  });

  it('let a hung child step fail by its own bound, and a one-file rerun that fails always leave its report', async () => {
    for (const scale of ['1', '4']) {
      vi.stubEnv('SMDB_TEST_TIME_SCALE', scale);
      vi.resetModules();
      const config = (await import('../vitest.config')).default as { test: { hookTimeout: number; projects: { test: { name: string; testTimeout?: number } }[] } };
      const { STEP_MS } = await import('../helpers/time.mjs');
      const child = config.test.projects.find(project => project.test.name === 'child')!.test;
      // A child test of up to 14 steps, each within its bound, ends before its own limit.
      expect(child.testTimeout, scale).toBe(15 * STEP_MS);
      if (scale === '4') {
        const { PASSES } = await import('../mutation/passes.mjs');
        expect(PASSES.b2.timeoutMS).toBeGreaterThan(child.testTimeout! + 3 * config.test.hookTimeout);
      }
    }
  });

  // mutation/README.md: a pass A rerun's budget (factor times T, the time pass
  // A's related tests take with no mutant, plus timeoutMS) fires before any
  // test's scaled limit whenever T is under 15 s.
  it('let a pass A rerun run past its whole budget before any one test times out, while those tests take under 15 s', async () => {
    vi.stubEnv('SMDB_TEST_TIME_SCALE', '4');
    vi.resetModules();
    const config = (await import('../vitest.config')).default as { test: { testTimeout: number } };
    const { PASSES } = await import('../mutation/passes.mjs');
    expect((config.test.testTimeout - PASSES.a2.timeoutMS) / PASSES.a2.timeoutFactor).toBe(15_000);
  });

  // mutation/README.md: a pass B run's budget (factor times T, its run with no
  // mutant, plus timeoutMS) fires before vitest's limit on a hook whenever T is
  // under a minute.
  it('let a pass B run past its whole budget before an afterAll times out, while its run with no mutant takes under a minute', async () => {
    vi.stubEnv('SMDB_TEST_TIME_SCALE', '1');
    vi.resetModules();
    const config = (await import('../vitest.config')).default as { test: { hookTimeout: number } };
    const { PASSES } = await import('../mutation/passes.mjs');
    expect((config.test.hookTimeout - PASSES.b.timeoutMS) / PASSES.b.timeoutFactor).toBe(60_000);
  });
});

describe('the Stryker options', () => {
  it('take nothing from a Stryker config file in the bot root, and never mutate in place', async () => {
    const { ConfigReader } = await import('../node_modules/@stryker-mutator/core/dist/src/config/config-reader.js');
    const { COMMON, PASSES } = await import('../mutation/passes.mjs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-config-'));
    const cwd = process.cwd();
    onTestFinished(() => { process.chdir(cwd); fs.rmSync(dir, { recursive: true, force: true }); });
    fs.writeFileSync(path.join(dir, 'stryker.config.json'), JSON.stringify({ inPlace: true, buildCommand: 'npm run build', mutator: { excludedMutations: ['EqualityOperator'] } }));
    process.chdir(dir);
    const quiet = () => {};
    const log = { debug: quiet, info: quiet, warn: quiet, error: quiet, trace: quiet, fatal: quiet, isDebugEnabled: () => false, isTraceEnabled: () => false };
    for (const [name, pass] of Object.entries(PASSES)) {
      const options = await new ConfigReader(log as never, { validate() {} } as never).readConfig({ ...COMMON, ...pass, mutate: ['src/a.ts:1-2'] });
      expect(options.inPlace, name).toBe(false);
      expect(options.mutator?.excludedMutations ?? [], name).toEqual([]);
      expect(options.buildCommand, name).toBe('buildCommand' in pass ? pass.buildCommand : undefined);
    }
  });
});

describe('a property under the gate', () => {
  it('draws from the one seed the gate sets for its run', { timeout: 180_000 }, () => {
    const vitest = path.join(root, 'test', 'node_modules', 'vitest', 'vitest.mjs');
    const run = spawnSync(process.execPath, [vitest, 'run', '--project', 'fast', 'unit/propertySeed.test.ts'], {
      cwd: path.join(root, 'test'), encoding: 'utf8', timeout: 150_000, env: { ...process.env, SMDB_TEST_SEED: '12345' },
    });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toMatch(/1 passed/);
  });

  it('refuses a seed that is no integer, in the gate and in every test file', { timeout: 180_000 }, () => {
    const env = { ...process.env, SMDB_TEST_SEED: '1.5' };
    const gate = spawnSync(process.execPath, [path.join(root, 'test', 'mutation', 'touched.mjs'), '--mutate', 'src/bot/internalSetup/fleet/nodeIdentity.ts:1-1'], { cwd: root, encoding: 'utf8', timeout: 60_000, env });
    expect(gate.status).toBe(2);
    expect(gate.stderr).toContain('SMDB_TEST_SEED must be an integer, not 1.5');
    const vitest = path.join(root, 'test', 'node_modules', 'vitest', 'vitest.mjs');
    const tests = spawnSync(process.execPath, [vitest, 'run', '--project', 'fast', 'unit/propertySeed.test.ts'], { cwd: path.join(root, 'test'), encoding: 'utf8', timeout: 150_000, env });
    expect(tests.status).not.toBe(0);
    expect(`${tests.stdout}${tests.stderr}`).toContain('SMDB_TEST_SEED must be an integer, not 1.5');
  });
});
