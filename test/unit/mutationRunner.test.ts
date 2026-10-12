import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { runControl } from '../mutation/control.mjs';

// The command every mutant run executes (mutation/runner.mjs) and the run with
// no mutant after the reruns (mutation/control.mjs), against a stand-in for
// vitest that records how it was called and fails the tiers it is told to.

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
    expect(calls[0].args).toEqual(expect.arrayContaining(['related', path.join(root, 'src', 'a.ts'), '--bail=1']));
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
});

describe('the run with no mutant after the reruns', () => {
  it('runs the reruns\' tests their way with no active mutant, and fails when a tier fails', async () => {
    const failing = fakeVitest(['child']);
    const env = { ...process.env, SMDB_MUTATION_VITEST: failing.script, __STRYKER_ACTIVE_MUTANT__: '7' };
    expect(await runControl({ root, out: failing.out, tier: 'b', files: ['src/a.ts'], only: ['child/fleetIdentity.test.ts'], env }))
      .toEqual({ passed: false, why: 'exit 1' });
    const calls = failing.read();
    expect(calls.map(call => [call.project, call.mutant, call.scale])).toEqual([['child', null, '4']]);
    expect(calls[0].args.slice(0, 2)).toEqual(['run', 'child/fleetIdentity.test.ts']);

    const passing = fakeVitest([]);
    expect(await runControl({ root, out: passing.out, tier: 'a', files: ['src/a.ts'], only: [], env: { ...env, SMDB_MUTATION_VITEST: passing.script } }))
      .toEqual({ passed: true, why: '' });
    expect(passing.read().map(call => [call.project, call.scale])).toEqual([['fast', '4']]);
  });

  it('ends a run past its bound with every process it started', async () => {
    // A stand-in for vitest that starts a process of its own, then hangs.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-hang-'));
    onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
    const pidFile = path.join(dir, 'grandchild.pid');
    const script = path.join(dir, 'vitest.cjs');
    fs.writeFileSync(script, [
      "const { spawn } = require('child_process');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'));
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    const env = { ...process.env, SMDB_MUTATION_VITEST: script };
    const run = await runControl({ root, out, tier: 'a', files: ['src/a.ts'], only: [], env, timeoutMs: 4_000 });
    expect(run).toEqual({ passed: false, why: 'it ran past its bound of 4 s, and was ended with every process it started' });
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let tries = 0; alive() && tries < 50; tries++) await new Promise(resolve => setTimeout(resolve, 100));
    expect(alive()).toBe(false);
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

  it('give every test, hook and child step four times its time in a rerun', async () => {
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
