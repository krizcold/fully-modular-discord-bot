import { spawnSync } from 'child_process';
import fs from 'fs';
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

interface Pass { status: string; killedBy?: string; inconclusive?: string }
interface Mutant { location: { start: { line: number } }; mutator: string; original: string; passes: { a: Pass; b?: Pass } }

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
      expect(m.passes.a.status, `${m.mutator} ${m.original}`).toBe('Survived');
      expect(m.passes.b, `${m.mutator} ${m.original}`).toMatchObject({ status: 'Killed', killedBy: expect.stringMatching(/^child\/fleetIdentity\.test\.ts > /) });
    }

    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/^Survivors .*\n {2}src\/bot\/internalSetup\/fleet\/nodeIdentity\.ts:\d+:\d+ StringLiteral: `''`/m);
    expect(run.stdout).toMatch(/^Verdict: FAIL$/m);
    fs.rmSync(path.join(root, reportDir!), { recursive: true, force: true });
  });

  it('has no result, exit 2, when its base is unknown or its patterns make no mutant', { timeout: 300_000 }, () => {
    const gate = (...args: string[]) => spawnSync(process.execPath, [path.join(root, 'test', 'mutation', 'touched.mjs'), ...args], { cwd: root, encoding: 'utf8', timeout: 280_000 });
    const clean = (stdout: string) => {
      const dir = /^Report: (\S+)/m.exec(stdout)?.[1];
      if (dir) fs.rmSync(path.join(root, dir), { recursive: true, force: true });
    };

    expect(gate('--help').status).toBe(2);

    const unknown = gate('--base', 'no-such-ref-anywhere');
    clean(unknown.stdout);
    expect(unknown.status, unknown.stderr).toBe(2);
    expect(unknown.stdout).toMatch(/^Stopped:\n {2}the gate stopped: Command failed: git .*merge-base no-such-ref-anywhere HEAD/m);
    expect(unknown.stdout).toMatch(/^Verdict: NO RESULT \(the gate stopped before it finished\)$/m);

    const nothing = gate('--mutate', 'src/no/such/file.ts:1-5', '--concurrency', '1');
    clean(nothing.stdout);
    expect(nothing.status, nothing.stderr).toBe(2);
    expect(nothing.stdout).toMatch(/^Patterns that made no mutant:\n {2}src\/no\/such\/file\.ts:1-5$/m);
    expect(nothing.stdout).toMatch(/^Verdict: NO RESULT \(no gating mutant was made/m);
  });
});
