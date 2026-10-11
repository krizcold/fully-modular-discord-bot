import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

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

interface Pass { id: string | null; status: string; killedBy?: string; inconclusive?: string }

// The ids a pass ran tests for (targets.mjs), as runner.mjs read them.
const ranFor = (reportDir: string, dir: string) => (JSON.parse(fs.readFileSync(path.join(root, reportDir, dir, 'run-ids.json'), 'utf8')) as string[]).sort();
interface Mutant { location: { start: { line: number } }; mutator: string; original: string; passes: { a: Pass; b?: Pass; b2?: Pass } }

function lineOf(text: string): number {
  const index = fs.readFileSync(path.join(root, TARGET), 'utf8').split('\n').findIndex(line => line.includes(text));
  if (index < 0) throw new Error(`the bite's target line "${text}" is gone from ${TARGET}; aim the bite at another line of the same kind`);
  return index + 1;
}

describe('the touched-line mutation gate', () => {
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
    expect(run.stdout).toMatch(/^Survivors .*\n {2}src\/bot\/internalSetup\/fleet\/nodeIdentity\.ts:\d+:\d+ StringLiteral: `''`/m);
    expect(run.stdout).not.toContain(`nodeIdentity.ts:${child}:`);
    const killedInA = on(fast).filter(m => !equivalent(m)).length;
    expect(run.stdout).toContain(`\n  killed in pass A: ${killedInA}; sent to pass B: ${on(child).length + 1}, killed there: ${on(child).length}\n`);
    expect(run.stdout).toMatch(/^Runs with no mutant after the reruns:\n {2}after pass b2: passed /m);
    expect(run.stdout).toMatch(/^Verdict: FAIL$/m);
    // Pass B's kills reran with the one file that killed them, and so did the run with no mutant after them.
    for (const dir of ['b2-1', 'control-b2']) {
      const written = fs.readdirSync(path.join(root, reportDir!, dir)).filter(file => file !== 'targets.json' && file !== 'run-ids.json');
      expect(written.some(file => file.endsWith('-child.json')), dir).toBe(true);
      expect(written.filter(file => !file.includes('-child.')), dir).toEqual([]);
    }
    expect(fs.existsSync(path.join(root, reportDir!, 'b2-2'))).toBe(false);
    // Pass B and its rerun ran tests for exactly the mutants they were for, matched in Stryker's own plan.
    expect(ranFor(reportDir!, 'b')).toEqual(mutants.filter(m => m.passes.b).map(m => m.passes.b!.id).sort());
    expect(ranFor(reportDir!, 'b2-1')).toEqual(on(child).map(m => m.passes.b2!.id).sort());
    fs.rmSync(path.join(root, reportDir!), { recursive: true, force: true });
  });

  it('counts nothing its reruns found, and has no result, when the run with no mutant after them fails', { timeout: 600_000 }, () => {
    // A stand-in for vitest: the run with no mutant passes, every mutant's test
    // times out, and the run with no mutant after the reruns fails.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-control-'));
    const fake = path.join(dir, 'vitest.cjs');
    fs.writeFileSync(fake, [
      "const fs = require('fs');",
      "const file = process.argv.find(arg => arg.startsWith('--outputFile=')).slice('--outputFile='.length);",
      'const mutant = process.env.__STRYKER_ACTIVE_MUTANT__;',
      "const control = file.split('\\\\').join('/').includes('/control-');",
      "const message = control ? 'Error: the database went away' : mutant ? 'Error: Test timed out in 30000ms' : '';",
      "const test = { status: message ? 'failed' : 'passed', fullName: 'reads', failureMessages: message ? [message] : [] };",
      "fs.writeFileSync(file, JSON.stringify({ testResults: [{ name: 'unit/x.test.ts', status: test.status, assertionResults: [test] }] }));",
      'process.exit(message ? 1 : 0);',
      '',
    ].join('\n'));
    const line = lineOf("return (process.env.FLEET_BACKUP_MODE || '').trim().toLowerCase() === 'active';");
    const run = spawnSync(process.execPath, [path.join(root, 'test', 'mutation', 'touched.mjs'), '--mutate', `${TARGET}:${line}-${line}`, '--concurrency', '1'],
      { cwd: root, encoding: 'utf8', timeout: 580_000, env: { ...process.env, SMDB_MUTATION_VITEST: fake } });
    fs.rmSync(dir, { recursive: true, force: true });
    const reportDir = /^Report: (\S+)/m.exec(run.stdout)?.[1];
    expect(reportDir, `${run.stdout}\n${run.stderr}`).toBeDefined();
    const { mutants } = JSON.parse(fs.readFileSync(path.join(root, reportDir!, 'mutants.json'), 'utf8')) as { mutants: (Mutant & { passes: { a2?: Pass & { voided?: string } } })[] };
    const a2Ran = ranFor(reportDir!, 'a2');
    fs.rmSync(path.join(root, reportDir!), { recursive: true, force: true });
    expect(a2Ran).toEqual(mutants.filter(m => m.passes.a2).map(m => m.passes.a2!.id).sort());

    const reran = mutants.filter(m => m.passes.a2);
    expect(reran.length).toBeGreaterThan(0);
    for (const m of reran) expect(m.passes.a2).toMatchObject({ voided: 'the run with no mutant after pass a2 failed' });
    expect(run.status).toBe(2);
    expect(run.stdout).toMatch(/^Verdict: NO RESULT \(vitest was replaced by a test's stand-in /m);
    expect(run.stdout).toMatch(/^Stopped:\n {2}the run with no mutant after pass a2 failed \(exit 1\), so what its reruns counted cannot be told from the machine's failures$/m);
    expect(run.stdout).toMatch(/^ {2}the run with no mutant failed in unit\/x\.test\.ts: Error: the database went away$/m);
    expect(run.stdout).toMatch(/^Inconclusive .*\n {2}src\/bot\/internalSetup\/fleet\/nodeIdentity\.ts:\d+:\d+ .*\(the run with no mutant after pass a2 failed\)$/m);
    expect(run.stdout).not.toMatch(/^Timeouts /m);
    expect(run.stdout).not.toMatch(/^Runs with no mutant after the reruns:/m);
  });

  it('has no result, exit 2, when its base is unknown or its patterns make no mutant, and refuses a glob or a missing file', { timeout: 300_000 }, () => {
    const gate = (...args: string[]) => spawnSync(process.execPath, [path.join(root, 'test', 'mutation', 'touched.mjs'), ...args], { cwd: root, encoding: 'utf8', timeout: 280_000 });
    const clean = (stdout: string) => {
      const dir = /^Report: (\S+)/m.exec(stdout)?.[1];
      if (dir) fs.rmSync(path.join(root, dir), { recursive: true, force: true });
    };

    expect(gate('--help').status).toBe(2);
    const outside = path.join(os.tmpdir(), `smdb-outside-${process.pid}.ts`);
    fs.writeFileSync(outside, 'export const x = 1;\n');
    try {
      for (const pattern of ['src/**/*.ts', 'src/bot/internalSetup/fleet/+(nodeIdentity|takeover).ts', 'src/no/such/file.ts:1-5', outside]) {
        const refused = gate('--mutate', pattern);
        expect(refused.status, pattern).toBe(2);
        expect(refused.stderr).toContain(`--mutate takes a file in the bot root that exists, or such a file and lines, never a glob: ${pattern}`);
      }
    } finally {
      fs.rmSync(outside, { force: true });
    }

    const unknown = gate('--base', 'no-such-ref-anywhere');
    clean(unknown.stdout);
    expect(unknown.status, unknown.stderr).toBe(2);
    expect(unknown.stdout).toMatch(/^Stopped:\n {2}the gate stopped: Command failed: git .*merge-base no-such-ref-anywhere HEAD/m);
    expect(unknown.stdout).toMatch(/^Verdict: NO RESULT \(the gate stopped before it finished\)$/m);

    // The file's opening comment and first import: no mutant can be made there.
    // Spelled the way a shell may complete it (on Windows, in another case too),
    // it is taken under the name git gives the file.
    const spelled = process.platform === 'win32' ? `.\\${TARGET.replace(/^src/, 'SRC').split('/').join('\\')}` : `./${TARGET}`;
    const nothing = gate('--mutate', `${spelled}:1-5`, '--concurrency', '1');
    clean(nothing.stdout);
    expect(nothing.status, nothing.stderr).toBe(2);
    expect(nothing.stdout).toMatch(/^Patterns that made no mutant:\n {2}src\/bot\/internalSetup\/fleet\/nodeIdentity\.ts:1-5$/m);
    expect(nothing.stdout).toMatch(/^Changed lines no mutant lies wholly on .*\n {2}src\/bot\/internalSetup\/fleet\/nodeIdentity\.ts: 5$/m);
    expect(nothing.stdout).toMatch(/^Verdict: NO RESULT \(no gating mutant was made/m);
  });
});
