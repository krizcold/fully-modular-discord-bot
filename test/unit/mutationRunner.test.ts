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

function runner(fake: { script: string; out: string }, confirm: string) {
  return spawnSync(process.execPath, [path.join(root, 'test', 'mutation', 'runner.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, SMDB_MUTATION_VITEST: fake.script, SMDB_MUTATION_PASS: 'b', SMDB_MUTATION_FILES: '["src/a.ts"]', SMDB_MUTATION_OUT: fake.out, SMDB_MUTATION_CONFIRM: confirm, __STRYKER_ACTIVE_MUTANT__: '7' },
  });
}

describe('a mutant run', () => {
  it('stops at the first failing test and tier, at vitest\'s own time limits', () => {
    const fake = fakeVitest(['integration']);
    expect(runner(fake, '').status).toBe(1);
    const calls = fake.read();
    expect(calls.map(call => call.project)).toEqual(['integration']);
    expect(calls[0]).toMatchObject({ scale: '1', mutant: '7' });
    expect(calls[0].args).toContain('--bail=1');
  });

  it('runs every test of both tiers, with four times the time, when it reruns a mutant alone', () => {
    const fake = fakeVitest(['integration']);
    expect(runner(fake, '1').status).toBe(1);
    const calls = fake.read();
    expect(calls.map(call => call.project)).toEqual(['integration', 'child']);
    for (const call of calls) {
      expect(call).toMatchObject({ scale: '4', mutant: '7' });
      expect(call.args.some(arg => arg.startsWith('--bail'))).toBe(false);
    }
  });
});

describe('the run with no mutant after the reruns', () => {
  it('runs in the reruns\' way with no active mutant, and fails when a tier fails', () => {
    const failing = fakeVitest(['child']);
    const env = { ...process.env, SMDB_MUTATION_VITEST: failing.script, __STRYKER_ACTIVE_MUTANT__: '7' };
    expect(runControl({ root, out: failing.out, tier: 'b', files: ['src/a.ts'], env })).toEqual({ passed: false, why: 'exit 1' });
    expect(failing.read().map(call => [call.project, call.mutant, call.scale])).toEqual([['integration', null, '4'], ['child', null, '4']]);

    const passing = fakeVitest([]);
    expect(runControl({ root, out: passing.out, tier: 'a', files: ['src/a.ts'], env: { ...env, SMDB_MUTATION_VITEST: passing.script } }))
      .toEqual({ passed: true, why: '' });
    expect(passing.read().map(call => call.project)).toEqual(['fast']);
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
    expect((await import('../helpers/child')).STEP_MS).toBe(80_000);
  });
});
