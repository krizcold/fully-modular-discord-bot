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

function runner(fake: { script: string; out: string }, pass: string, confirm: string, only: string[] = []) {
  return spawnSync(process.execPath, [path.join(root, 'test', 'mutation', 'runner.mjs')], {
    encoding: 'utf8',
    env: {
      ...process.env, SMDB_MUTATION_VITEST: fake.script, SMDB_MUTATION_PASS: pass, SMDB_MUTATION_FILES: '["src/a.ts"]', SMDB_MUTATION_OUT: fake.out,
      SMDB_MUTATION_CONFIRM: confirm, SMDB_MUTATION_ONLY: JSON.stringify(only), __STRYKER_ACTIVE_MUTANT__: '7',
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

describe('the run with no mutant after the reruns', () => {
  it('runs the reruns\' tests their way with no active mutant, and fails when a tier fails', () => {
    const failing = fakeVitest(['child']);
    const env = { ...process.env, SMDB_MUTATION_VITEST: failing.script, __STRYKER_ACTIVE_MUTANT__: '7' };
    expect(runControl({ root, out: failing.out, tier: 'b', files: ['src/a.ts'], only: ['child/fleetIdentity.test.ts'], env }))
      .toEqual({ passed: false, why: 'exit 1' });
    const calls = failing.read();
    expect(calls.map(call => [call.project, call.mutant, call.scale])).toEqual([['child', null, '4']]);
    expect(calls[0].args.slice(0, 2)).toEqual(['run', 'child/fleetIdentity.test.ts']);

    const passing = fakeVitest([]);
    expect(runControl({ root, out: passing.out, tier: 'a', files: ['src/a.ts'], only: [], env: { ...env, SMDB_MUTATION_VITEST: passing.script } }))
      .toEqual({ passed: true, why: '' });
    expect(passing.read().map(call => [call.project, call.scale])).toEqual([['fast', '4']]);
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
});
