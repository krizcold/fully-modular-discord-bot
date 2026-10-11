import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { byKiller, classifyKill, confirmed, judge, outcome, toConfirm, toPassB, type MutantRecord, type PassResult } from '../mutation/verdict.mjs';

// What the L5 gate concludes (mutation/README.md): when a run counts as a
// kill, which mutants go to which pass, and the verdict.

const vitest = path.join(__dirname, '..', 'node_modules', 'vitest', 'vitest.mjs');

// Test files that fail the ways a mutant run can fail, run through vitest 5's
// own json reporter, so the classification is checked against what vitest
// really writes (a nested hook's error, for one, never reaches the file entry).
const FIXTURES: Record<string, string> = {
  'containerStart.test.mjs': "beforeAll(() => { throw new Error('Health check not healthy after 120000ms'); });\nit('reads', () => {});",
  'nestedHook.test.mjs': "describe('store', () => {\n  beforeAll(() => { throw new Error('connect ECONNREFUSED 127.0.0.1:5432'); });\n  it('reads', () => {});\n});",
  'connectionDrop.test.mjs': "it('queries', () => { throw new Error('Connection terminated unexpectedly'); });",
  'assertion.test.mjs': "it('keeps the role', () => { expect('co-worker').toBe('master'); });",
  'hang.test.mjs': "it('answers', () => new Promise(() => {}), 200);",
  'unhandled.test.mjs': "it('passes', () => { Promise.reject(new Error('late')); });",
  'mixed.test.mjs': "it('connects', () => { throw new Error('read ECONNRESET'); });\nit('keeps the role', () => { expect(1).toBe(2); });",
  'hookHang.test.mjs': "beforeEach(() => new Promise(() => {}), 200);\nit('reads', () => {});",
  'notQueryable.test.mjs': "it('queries', () => { throw new Error('Client has encountered a connection error and is not queryable'); });",
  'childFault.test.mjs': "it('survives a full disk', () => { throw new Error('scenario diskFull.cjs step2 exited 1 with no RESULT line\\nError: ENOSPC: no space left on device'); });",
  'assertsOnError.test.mjs': "it('classifies a refusal', () => { expect('connect ECONNREFUSED 10.0.0.2:5432').toBe('unreachable'); });",
  'stepBound.test.mjs': "it('restarts', () => { throw new Error('scenario fleetIdentity.cjs read did not finish in 20000 ms\\nwaiting for the lease'); });",
};

describe('a run Stryker counted as a kill', () => {
  it('is a kill only when a test itself failed for a reason other than the machine', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-verdict-'));
    onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
    for (const [name, body] of Object.entries(FIXTURES)) fs.writeFileSync(path.join(dir, name), `${body}\n`);
    const out = path.join(dir, 'report.json');
    spawnSync(process.execPath, [vitest, 'run', '--root', dir, '--globals', '--reporter=json', `--outputFile=${out}`], { cwd: dir, stdio: 'ignore', timeout: 120_000 });
    const report = JSON.parse(fs.readFileSync(out, 'utf8')) as { testResults: { name: string }[] };
    const of = (name: string) => classifyKill([{ testResults: report.testResults.filter(file => file.name.endsWith(name)) as never }]);

    expect(of('containerStart.test.mjs')).toEqual({ inconclusive: expect.stringMatching(/^no test failed.*Health check not healthy/) });
    expect(of('nestedHook.test.mjs')).toEqual({ inconclusive: expect.stringMatching(/^no test failed/) });
    expect(of('connectionDrop.test.mjs')).toEqual({ inconclusive: 'only the machine failed: Error: Connection terminated unexpectedly' });
    expect(of('assertion.test.mjs')).toEqual({ killedBy: expect.stringMatching(/assertion\.test\.mjs > keeps the role$/) });
    expect(of('hang.test.mjs')).toEqual({ timeout: expect.stringMatching(/hang\.test\.mjs > answers$/) });
    expect(of('unhandled.test.mjs')).toEqual({ inconclusive: expect.stringMatching(/^no test failed/) });
    expect(of('mixed.test.mjs')).toEqual({ killedBy: expect.stringMatching(/mixed\.test\.mjs > keeps the role$/) });
    expect(of('hookHang.test.mjs')).toEqual({ timeout: expect.stringMatching(/hookHang\.test\.mjs > reads$/) });
    expect(of('notQueryable.test.mjs')).toEqual({ inconclusive: expect.stringMatching(/^only the machine failed: .*not queryable/) });
    // A child that fails for the mutant names the injected fault in its stderr,
    // and an assertion may name an error as the value under test: both are kills.
    expect(of('childFault.test.mjs')).toEqual({ killedBy: expect.stringMatching(/childFault\.test\.mjs > survives a full disk$/) });
    expect(of('assertsOnError.test.mjs')).toEqual({ killedBy: expect.stringMatching(/assertsOnError\.test\.mjs > classifies a refusal$/) });
    // A child step's own bound is the test's assertion that the step ends.
    expect(of('stepBound.test.mjs')).toEqual({ killedBy: expect.stringMatching(/stepBound\.test\.mjs > restarts$/) });
    // A run is a timeout only when every failure timed out: a machine failure
    // beside a timeout, in another tier's report or at file level, proves nothing.
    const ofAll = (...names: string[]) => classifyKill(names.map(name => ({ testResults: report.testResults.filter(file => file.name.endsWith(name)) as never })));
    expect(ofAll('hang.test.mjs', 'hookHang.test.mjs')).toEqual({ timeout: expect.stringMatching(/hang\.test\.mjs > answers$/) });
    expect(ofAll('connectionDrop.test.mjs', 'hang.test.mjs')).toEqual({ inconclusive: 'a test timed out while the machine failed: Error: Connection terminated unexpectedly' });
    expect(ofAll('containerStart.test.mjs', 'hang.test.mjs')).toEqual({ inconclusive: expect.stringMatching(/^a test timed out while the machine failed: .*Health check not healthy/) });
    expect(classifyKill([])).toEqual({ inconclusive: 'no vitest report was written' });
  });
});

const at = (line: number) => ({ start: { line, column: 3 }, end: { line, column: 9 } });
const mutant = (line: number, gating: boolean, passes: MutantRecord['passes']): MutantRecord =>
  ({ file: 'src/a.ts', location: at(line), mutator: 'EqualityOperator', original: 'a > 0', replacement: 'a >= 0', gating, passes });
const pass = (status: string, extra: Partial<PassResult> = {}): PassResult => ({ id: '1', status, ...extra });
const run = (mutants: MutantRecord[], extra: Partial<Parameters<typeof judge>[0]> = {}) =>
  judge({ stamp: 't', scope: 's', emptyScope: false, skipped: [], mutants, noMutant: [], unmatched: [], report: 'r', ...extra });

describe('the passes a mutant goes through', () => {
  it('confirms a timeout alone, sends survivors to pass B, and reads the last pass', () => {
    const timedOut = mutant(1, true, { a: pass('Timeout') });
    const testTimedOut = mutant(2, true, { a: pass('Killed', { timeout: 'x > y' }) });
    const survived = mutant(3, true, { a: pass('Survived') });
    const contextTimeout = mutant(4, false, { a: pass('Timeout') });
    const killed = mutant(5, true, { a: pass('Killed', { killedBy: 'x > y' }) });
    expect(toConfirm([timedOut, testTimedOut, survived, contextTimeout, killed], 'a')).toEqual([timedOut, testTimedOut]);
    expect(toPassB([timedOut, survived, killed])).toEqual([survived]);

    const confirmedSurvivor = mutant(6, true, { a: pass('Timeout'), a2: pass('Survived') });
    expect(toPassB([confirmedSurvivor])).toEqual([confirmedSurvivor]);
    const killedInB = mutant(7, true, { a: pass('Survived'), b: pass('Killed', { killedBy: 'child > x' }) });
    // Pass B's kills must repeat alone; pass A's need not; a hang in pass B is never rerun.
    expect(toConfirm([mutant(8, true, { a: pass('Survived'), b: pass('Timeout') })], 'b')).toEqual([]);
    expect(toConfirm([mutant(8, true, { a: pass('Survived'), b: pass('Killed', { timeout: 'child > x' }) })], 'b')).toEqual([]);
    expect(toConfirm([killedInB], 'b')).toEqual([killedInB]);
    expect(toConfirm([killed], 'a')).toEqual([]);
    const flake = mutant(9, true, { a: pass('Survived'), b: pass('Killed', { killedBy: 'x' }), b2: pass('Survived') });
    expect(outcome(flake)).toBe('Survived');
  });

  it('counts a pass B kill only when a test fails for it again alone, and nothing it never reran', () => {
    const b = (b2?: PassResult) => mutant(1, true, { a: pass('Survived'), b: pass('Killed', { killedBy: 'integration/x.test.ts > x' }), ...(b2 ? { b2 } : {}) });
    expect(outcome(b(pass('Killed', { killedBy: 'child/y.test.ts > y' })))).toBe('Killed');
    expect(outcome(b(pass('Killed', { timeout: 'child/y.test.ts > y' })))).toBe('Inconclusive');
    expect(outcome(b(pass('Timeout')))).toBe('Inconclusive');
    expect(outcome(b())).toBe('Inconclusive');
    for (const hang of [pass('Timeout'), pass('Killed', { timeout: 'child/y.test.ts > y' })]) {
      expect(confirmed(mutant(1, true, { a: pass('Survived'), b: hang }))).toEqual({ outcome: 'Inconclusive', why: 'hung in pass B, where a hang is not counted' });
    }
    expect(outcome(mutant(1, true, { a: pass('Timeout') }))).toBe('Inconclusive');
    expect(outcome(mutant(1, false, { a: pass('Timeout') }))).toBe('Timeout');
  });

  it('reruns each pass B kill with the test file that killed it', () => {
    const by = (file: string) => mutant(1, true, { a: pass('Survived'), b: pass('Killed', { killedBy: `${file} > the role override > keeps it` }) });
    const [one, two, three] = [by('child/fleetIdentity.test.ts'), by('integration/store.test.ts'), by('child/fleetIdentity.test.ts')];
    expect([...byKiller([one, two, three])]).toEqual([['child/fleetIdentity.test.ts', [one, three]], ['integration/store.test.ts', [two]]]);
  });

  it('counts nothing a rerun found when the run with no mutant after it failed', () => {
    const voided = { voided: 'the run with no mutant after pass b2 failed' };
    expect(confirmed(mutant(1, true, { a: pass('Survived'), b: pass('Killed', { killedBy: 'x' }), b2: pass('Killed', { killedBy: 'y', ...voided }) })))
      .toEqual({ outcome: 'Inconclusive', why: 'the run with no mutant after pass b2 failed' });
    expect(outcome(mutant(1, true, { a: pass('Timeout'), a2: pass('Timeout', { voided: 'x' }) }))).toBe('Inconclusive');
    expect(outcome(mutant(1, true, { a: pass('Survived'), b: pass('Killed', { killedBy: 'x' }), b2: pass('Survived', voided) }))).toBe('Survived');
  });
});

describe('the verdict', () => {
  it('fails on a gating survivor, silenced mutant, inconclusive kill or run that never ran a test, and lists each', () => {
    for (const passes of [
      { a: pass('Survived'), b: pass('Survived') },
      { a: pass('Ignored', { statusReason: 'disabled by a comment' }) },
      { a: pass('Killed', { inconclusive: 'only the machine failed: x' }) },
      { a: pass('RuntimeError', { statusReason: 'spawn EAGAIN' }) },
      { a: pass('Survived'), b: pass('Killed', { inconclusive: 'no vitest report was written' }) },
      { a: pass('Survived'), b: pass('Killed', { killedBy: 'x' }), b2: pass('Killed', { timeout: 'x' }) },
      { a: pass('Survived'), b: pass('Killed', { killedBy: 'x' }) },
    ]) {
      const result = run([mutant(1, true, passes), mutant(2, true, { a: pass('Killed', { killedBy: 'x' }) })]);
      expect(result.verdict, JSON.stringify(passes)).toBe('FAIL');
      expect(result.code).toBe(1);
      expect(result.lines.join('\n')).toMatch(/^ {2}src\/a\.ts:1:3 EqualityOperator: `a > 0` -> `a >= 0`/m);
    }
  });

  it('passes when every gating mutant died to a test, a confirmed timeout or the type checker, whatever the context did', () => {
    const result = run([
      mutant(1, true, { a: pass('Killed', { killedBy: 'x' }) }),
      mutant(2, true, { a: pass('Timeout'), a2: pass('Timeout') }),
      mutant(3, true, { a: pass('CompileError') }),
      mutant(4, true, { a: pass('Survived'), b: pass('Killed', { killedBy: 'child > y' }), b2: pass('Killed', { killedBy: 'child > y' }) }),
      mutant(5, false, { a: pass('Survived') }),
    ], { controls: ['after pass b2: passed'] });
    expect(result).toMatchObject({ verdict: 'PASS', code: 0 });
    expect(result.lines.join('\n')).toMatch(/^Timeouts .*\n {2}src\/a\.ts:2:3 /m);
    expect(result.lines.join('\n')).toMatch(/^Context survivors:\n {2}src\/a\.ts:5:3 /m);
    expect(result.lines.join('\n')).toMatch(/^Runs with no mutant after the reruns:\n {2}after pass b2: passed$/m);
  });

  it('names why a kill or timeout was not counted', () => {
    const text = run([
      mutant(1, true, { a: pass('Survived'), b: pass('Killed', { killedBy: 'child/x.test.ts > x' }), b2: pass('Killed', { timeout: 'child/x.test.ts > x' }) }),
      mutant(2, true, { a: pass('Survived'), b: pass('Killed', { killedBy: 'child/x.test.ts > x' }) }),
      mutant(3, true, { a: pass('Timeout') }),
    ], { stopped: ['pass b2 could not run: x'] }).lines.join('\n');
    expect(text).toMatch(/^Inconclusive .*\n {2}src\/a\.ts:1:3 .*\(killed in pass B by child\/x\.test\.ts > x, but hung instead of failing when run alone\)$/m);
    expect(text).toMatch(/^ {2}src\/a\.ts:2:3 .*\(killed in pass B, never rerun alone\)$/m);
    expect(text).toMatch(/^ {2}src\/a\.ts:3:3 .*\(timed out, never rerun alone\)$/m);
    expect(text).toMatch(/^ {2}killed in pass A: 0; sent to pass B: 2, killed there: 0$/m);
  });

  it('has no result when nothing changed or no gating mutant was made, and names what was not tested', () => {
    expect(run([], { emptyScope: true })).toMatchObject({ verdict: 'NO RESULT', code: 2 });
    expect(run([mutant(1, true, { a: pass('CompileError') }), mutant(2, false, { a: pass('Killed', { killedBy: 'x' }) })]).lines.at(-1))
      .toBe('Verdict: NO RESULT (every gating mutant was a type error, so no test ran against the change)');
    const none = run([mutant(1, false, { a: pass('Killed', { killedBy: 'x' }) })], {
      skipped: [{ file: 'src/webui/public/app.jsx', why: 'a browser view' }],
      unmatched: ['src/missing.ts:1-2'],
      noMutant: [{ file: 'src/a.ts', lines: [4, 9] }],
    });
    expect(none).toMatchObject({ verdict: 'NO RESULT', code: 2 });
    const text = none.lines.join('\n');
    expect(text).toContain('  src/webui/public/app.jsx: a browser view');
    expect(text).toContain('  src/missing.ts:1-2');
    expect(text).toContain('  src/a.ts: 4, 9');
  });

  it('has no result when a test replaced vitest, whatever the mutants did', () => {
    const result = run([mutant(1, true, { a: pass('Killed', { killedBy: 'x' }) })], { standIn: '/tmp/vitest.cjs' });
    expect(result).toMatchObject({ verdict: 'NO RESULT', code: 2 });
    expect(result.lines.at(-1)).toBe("Verdict: NO RESULT (vitest was replaced by a test's stand-in (SMDB_MUTATION_VITEST=/tmp/vitest.cjs))");
  });

  it('has no result when the gate stopped before it finished, and still reports the passes it finished', () => {
    const result = run([mutant(1, true, { a: pass('Killed', { killedBy: 'x' }) })], { stopped: ['pass b could not run: Docker is not running'] });
    expect(result).toMatchObject({ verdict: 'NO RESULT', code: 2 });
    expect(result.lines.join('\n')).toMatch(/^Gating mutants .*: 1: 1 Killed\n[\s\S]*^Stopped:\n {2}pass b could not run: Docker is not running$/m);
  });
});
