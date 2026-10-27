import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  byKiller, classifyKill, confirmed, INFRASTRUCTURE, judge, onlyUnusedDirective, outcome, toConfirm, toPassB, toUncheck, type MutantRecord, type PassResult,
} from '../mutation/verdict.mjs';

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
  'stepBound.test.mjs': "it('restarts', () => { throw new Error('scenario nodeIdentity.cjs boot did not finish in 20000 ms\\nwaiting for the lease'); });",
  'eachHook.test.mjs': "beforeEach(() => { throw new Error('the hook failed'); });\nit('reads', () => {});",
  'lockedDir.test.mjs': "afterEach(() => { throw new Error(\"EBUSY: resource busy or locked, rmdir 'smdb-x'\"); });\nit('reads', () => {});",
  'ownFileError.test.mjs': "it('saves', () => { const error = new Error(\"EPERM: operation not permitted, rename 'a.tmp' -> 'a'\"); error.code = 'EPERM'; throw error; });",
  'rejectsCode.test.mjs': "it('refuses', async () => { const error = new Error('ENOENT: x'); error.code = 'ENOENT'; await expect(Promise.reject(error)).rejects.toMatchObject({ code: 'EACCES' }); });",
};

describe('a run Stryker counted as a kill', () => {
  it('is a kill when a test failed for the mutant, and reruns alone a run that failed only on the machine\'s texts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-verdict-'));
    onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
    for (const [name, body] of Object.entries(FIXTURES)) fs.writeFileSync(path.join(dir, name), `${body}\n`);
    const out = path.join(dir, 'report.json');
    spawnSync(process.execPath, [vitest, 'run', '--root', dir, '--globals', '--reporter=json', `--outputFile=${out}`], { cwd: dir, stdio: 'ignore', timeout: 120_000 });
    const report = JSON.parse(fs.readFileSync(out, 'utf8')) as { testResults: { name: string }[] };
    const of = (name: string, alone = false) => classifyKill([{ testResults: report.testResults.filter(file => file.name.endsWith(name)) as never }], alone);
    const recheck = (test: RegExp, why: string | RegExp) => ({ recheck: expect.stringMatching(test), inconclusive: typeof why === 'string' ? why : expect.stringMatching(why) });

    expect(of('containerStart.test.mjs')).toEqual({ inconclusive: expect.stringMatching(/^no test failed.*Health check not healthy/) });
    expect(of('nestedHook.test.mjs')).toEqual({ inconclusive: expect.stringMatching(/^no test failed/) });
    expect(of('connectionDrop.test.mjs')).toEqual(recheck(/connectionDrop\.test\.mjs > queries$/, 'only the machine failed: Error: Connection terminated unexpectedly'));
    expect(of('assertion.test.mjs')).toEqual({ killedBy: expect.stringMatching(/assertion\.test\.mjs > keeps the role$/) });
    expect(of('hang.test.mjs')).toEqual({ timeout: expect.stringMatching(/hang\.test\.mjs > answers$/) });
    expect(of('unhandled.test.mjs')).toEqual({ inconclusive: expect.stringMatching(/^no test failed/) });
    expect(of('mixed.test.mjs')).toEqual({ killedBy: expect.stringMatching(/mixed\.test\.mjs > keeps the role$/) });
    expect(of('hookHang.test.mjs')).toEqual({ timeout: expect.stringMatching(/hookHang\.test\.mjs > reads$/) });
    expect(of('notQueryable.test.mjs')).toEqual(recheck(/notQueryable\.test\.mjs > queries$/, /^only the machine failed: .*not queryable/));
    // A child that fails for the mutant names the injected fault in its stderr,
    // and an assertion may name an error as the value under test: both are kills.
    expect(of('childFault.test.mjs')).toEqual({ killedBy: expect.stringMatching(/childFault\.test\.mjs > survives a full disk$/) });
    expect(of('assertsOnError.test.mjs')).toEqual({ killedBy: expect.stringMatching(/assertsOnError\.test\.mjs > classifies a refusal$/) });
    // A child step's own bound is the test's assertion that the step ends.
    expect(of('stepBound.test.mjs')).toEqual({ killedBy: expect.stringMatching(/stepBound\.test\.mjs > restarts$/) });
    // vitest gives a beforeEach failure to its test, so it counts as the test's.
    expect(of('eachHook.test.mjs')).toEqual({ killedBy: expect.stringMatching(/eachHook\.test\.mjs > reads$/) });
    // A file held or refused may be the machine's (a temp dir a run beside it holds) or the
    // mutant's (code that throws it, or an async assertion that names it, which vitest does not
    // mark AssertionError): the run reruns alone, where whatever repeats counts.
    expect(of('lockedDir.test.mjs')).toEqual(recheck(/lockedDir\.test\.mjs > reads$/, "only the machine failed: Error: EBUSY: resource busy or locked, rmdir 'smdb-x'"));
    expect(of('ownFileError.test.mjs')).toEqual(recheck(/ownFileError\.test\.mjs > saves$/, /^only the machine failed: Error: EPERM: operation not permitted, rename/));
    expect(of('rejectsCode.test.mjs')).toEqual(recheck(/rejectsCode\.test\.mjs > refuses$/, /^only the machine failed: .*EACCES/));
    for (const code of ['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES']) expect(INFRASTRUCTURE.test(`Error: ${code}: x`), code).toBe(true);
    for (const name of ['connectionDrop', 'lockedDir', 'ownFileError', 'rejectsCode']) {
      expect(of(`${name}.test.mjs`, true), name).toEqual({ killedBy: expect.stringMatching(new RegExp(`${name}\\.test\\.mjs > `)) });
    }
    // A run is a timeout only when every failure timed out: a machine failure
    // beside a timeout, in another tier's report or at file level, reruns it alone.
    const ofAll = (alone: boolean, ...names: string[]) => classifyKill(names.map(name => ({ testResults: report.testResults.filter(file => file.name.endsWith(name)) as never })), alone);
    expect(ofAll(false, 'hang.test.mjs', 'hookHang.test.mjs')).toEqual({ timeout: expect.stringMatching(/hang\.test\.mjs > answers$/) });
    expect(ofAll(false, 'connectionDrop.test.mjs', 'hang.test.mjs')).toEqual(recheck(/connectionDrop\.test\.mjs > queries$/, 'a test timed out while the machine failed: Error: Connection terminated unexpectedly'));
    expect(ofAll(false, 'containerStart.test.mjs', 'hang.test.mjs')).toEqual(recheck(/hang\.test\.mjs > answers$/, /^a test timed out while the machine failed: .*Health check not healthy/));
    expect(ofAll(true, 'containerStart.test.mjs', 'hang.test.mjs')).toEqual({ timeout: expect.stringMatching(/hang\.test\.mjs > answers$/) });
    expect(of('containerStart.test.mjs', true)).toEqual({ inconclusive: expect.stringMatching(/^no test failed/) });
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
    // A pass B kill whose file passes alone: pass B stopped at it, so its later tests never ran on the mutant.
    const flake = mutant(9, true, { a: pass('Survived'), b: pass('Killed', { killedBy: 'integration/x.test.ts > x' }), b2: pass('Survived') });
    expect(confirmed(flake)).toEqual({
      outcome: 'Inconclusive', why: 'killed in pass B by integration/x.test.ts > x, but not when that file ran alone, and the tests after it in pass B never ran on it',
    });
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

  it("reruns alone a run that failed only on the machine's texts, and counts it when a test fails again", () => {
    const machineOnly = { recheck: 'unit/x.test.ts > saves', inconclusive: 'only the machine failed: Error: EPERM: x' };
    const inA = mutant(1, true, { a: pass('Killed', machineOnly) });
    expect(toConfirm([inA], 'a')).toEqual([inA]);
    expect(confirmed(inA)).toEqual({ outcome: 'Inconclusive', why: 'only the machine failed: Error: EPERM: x, never rerun alone' });
    expect(outcome(mutant(1, true, { a: pass('Killed', machineOnly), a2: pass('Killed', { killedBy: 'unit/x.test.ts > saves' }) }))).toBe('Killed');
    const chance = mutant(1, true, { a: pass('Killed', machineOnly), a2: pass('Survived') });
    expect(toPassB([chance])).toEqual([chance]);
    const inB = mutant(2, true, { a: pass('Survived'), b: pass('Killed', { ...machineOnly, recheck: 'integration/s.test.ts > reads' }) });
    expect(toConfirm([inB], 'b')).toEqual([inB]);
    expect([...byKiller([inB]).keys()]).toEqual(['integration/s.test.ts']);
    expect(outcome({ ...inB, passes: { ...inB.passes, b2: pass('Killed', { killedBy: 'integration/s.test.ts > reads' }) } })).toBe('Killed');
    expect(confirmed({ ...inB, passes: { ...inB.passes, b2: pass('Timeout') } }))
      .toEqual({ outcome: 'Inconclusive', why: "failed in pass B only on the machine's texts (integration/s.test.ts > reads), but hung instead of failing when run alone" });
    expect(confirmed({ ...inB, passes: { ...inB.passes, b2: pass('Survived') } })).toEqual({
      outcome: 'Inconclusive',
      why: "failed in pass B only on the machine's texts (integration/s.test.ts > reads), but not when that file ran alone, and the tests after it in pass B never ran on it",
    });
    // A context mutant is never rerun.
    expect(toConfirm([mutant(3, false, { a: pass('Killed', machineOnly) })], 'a')).toEqual([]);
    // A pass B recheck the gate stopped before rerunning says so, though a2 reran its pass A timeout alone.
    const reranInA = mutant(4, true, { a: pass('Timeout'), a2: pass('Survived'), b: pass('Killed', { recheck: 'integration/s.test.ts > reads', inconclusive: 'only the machine failed: Error: ECONNRESET' }) });
    expect(confirmed(reranInA, true)).toEqual({ outcome: 'Inconclusive', why: 'only the machine failed: Error: ECONNRESET, in pass B, never rerun alone' });
    const onlyInB = mutant(5, true, { a: pass('Survived'), b: pass('Killed', { recheck: 'integration/s.test.ts > reads', inconclusive: 'only the machine failed: Error: ECONNRESET' }) });
    expect(confirmed(onlyInB, true)).toEqual({ outcome: 'Inconclusive', why: 'only the machine failed: Error: ECONNRESET, in pass B, never rerun alone' });
  });

  it('sends a gating mutant whose only type error is an unused @ts-expect-error to pass A again, with no type checker', () => {
    const unused = "src/a.ts(4,3): error TS2578: Unused '@ts-expect-error' directive.\n";
    expect(onlyUnusedDirective(unused)).toBe(true);
    expect(onlyUnusedDirective(`${unused}src/a.ts(5,9): error TS2322: Type 'string' is not assignable to type 'number'.\n`)).toBe(false);
    expect(onlyUnusedDirective('')).toBe(false);
    const directive = { inconclusive: 'a type error only because a @ts-expect-error went unused (TS2578), so no test ran on it' };
    const m = mutant(1, true, { a: pass('CompileError', directive) });
    const typeError = mutant(2, true, { a: pass('CompileError') });
    expect(toUncheck([m, typeError, mutant(3, false, { a: pass('CompileError', directive) })])).toEqual([m]);
    expect(toConfirm([m], 'a')).toEqual([]);
    expect(outcome(typeError)).toBe('CompileError');
    // Until it meets the tests (the gate stopped first, or a context one), it is no kill, and the report says why.
    expect(outcome(m)).toBe('Inconclusive');
    expect(run([m, mutant(4, true, { a: pass('Killed', { killedBy: 'x' }) })], { stopped: ['x'] }).lines.join('\n'))
      .toContain(`src/a.ts:1:3 EqualityOperator: \`a > 0\` -> \`a >= 0\` (${directive.inconclusive})`);
    // That run is its pass A: one that made no mutant there is named.
    expect(confirmed(mutant(1, true, { a: pass('Missing') }))).toEqual({ outcome: 'Inconclusive', why: 'pass A with no checker made no mutant at this place, so it ran no test on it' });
  });

  it('reruns each pass B kill with the test file that killed it', () => {
    const by = (file: string) => mutant(1, true, { a: pass('Survived'), b: pass('Killed', { killedBy: `${file} > the role override > keeps it` }) });
    const [one, two, three] = [by('child/nodeIdentity.test.ts'), by('integration/store.test.ts'), by('child/nodeIdentity.test.ts')];
    expect([...byKiller([one, two, three])]).toEqual([['child/nodeIdentity.test.ts', [one, three]], ['integration/store.test.ts', [two]]]);
  });

  it('counts nothing a rerun found when the run with no mutant after it failed', () => {
    const voided = { voided: 'the run with no mutant after pass b2 failed' };
    expect(confirmed(mutant(1, true, { a: pass('Survived'), b: pass('Killed', { killedBy: 'x' }), b2: pass('Killed', { killedBy: 'y', ...voided }) })))
      .toEqual({ outcome: 'Inconclusive', why: 'the run with no mutant after pass b2 failed' });
    expect(outcome(mutant(1, true, { a: pass('Timeout'), a2: pass('Timeout', { voided: 'x' }) }))).toBe('Inconclusive');
    expect(outcome(mutant(1, true, { a: pass('Survived'), b: pass('Killed', { killedBy: 'x' }), b2: pass('Survived', voided) }))).toBe('Inconclusive');
  });
});

describe('the verdict', () => {
  it('fails on a gating survivor, silenced mutant, inconclusive kill or run that never ran a test, and lists each', () => {
    for (const passes of [
      { a: pass('Survived'), b: pass('Survived') },
      { a: pass('Ignored', { statusReason: 'disabled by a comment' }) },
      { a: pass('Killed', { inconclusive: 'no vitest report was written' }) },
      { a: pass('Killed', { recheck: 'x', inconclusive: 'only the machine failed: x' }) },
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
      mutant(6, true, { a: pass('Timeout'), a2: pass('Killed', { timeout: 'unit/x.test.ts > slow' }) }),
    ], { controls: ['after pass b2: passed'] });
    expect(result).toMatchObject({ verdict: 'PASS', code: 0 });
    expect(result.lines.join('\n')).toMatch(/^Timeouts \(each timed out when run alone with four times the config's limit, or past the limit a test or hook sets itself: a test or its beforeEach or afterEach hook, or the whole run past its budget; .*\n {2}src\/a\.ts:2:3 /m);
    // A rerun past Stryker's budget may only have slowed the tests: it is not said to have hung.
    expect(result.lines.join('\n')).toMatch(/^ {2}src\/a\.ts:2:3 .*\(ran past Stryker's budget alone\)$/m);
    expect(result.lines.join('\n')).toMatch(/^ {2}src\/a\.ts:6:3 .*\(timed out alone: unit\/x\.test\.ts > slow\)$/m);
    expect(result.lines.join('\n')).toMatch(/^Context survivors:\n {2}src\/a\.ts:5:3 /m);
    expect(result.lines.join('\n')).toMatch(/^Runs with no mutant after the reruns:\n {2}after pass b2: passed$/m);
  });

  it('names why a kill or timeout was not counted', () => {
    const text = run([
      mutant(1, true, { a: pass('Survived'), b: pass('Killed', { killedBy: 'child/x.test.ts > x' }), b2: pass('Killed', { timeout: 'child/x.test.ts > x' }) }),
      mutant(2, true, { a: pass('Survived'), b: pass('Killed', { killedBy: 'child/x.test.ts > x' }) }),
      mutant(3, true, { a: pass('Timeout') }),
      // A pass that made no mutant where pass A made one (its file changed, say): only a rerun or pass B can.
      mutant(4, true, { a: pass('Timeout'), a2: pass('Missing') }),
      mutant(5, true, { a: pass('Survived'), b: pass('Killed', { killedBy: 'child/x.test.ts > x' }), b2: pass('Missing') }),
      // A pass A survivor the stopped gate never sent through pass B.
      mutant(6, true, { a: pass('Survived') }),
      // A pass B kill that failed again alone in an earlier b2 group, before a later group stopped the gate: the run
      // with no mutant after the reruns never ran.
      mutant(7, true, { a: pass('Survived'), b: pass('Killed', { killedBy: 'child/x.test.ts > x' }), b2: pass('Killed', { killedBy: 'child/x.test.ts > x' }) }),
    ], { stopped: ['pass b2 could not run: x'] }).lines.join('\n');
    expect(text).toMatch(/^ {2}src\/a\.ts:6:3 .*\(pass B never ran on it: the gate stopped first\)$/m);
    expect(text).toMatch(/^ {2}src\/a\.ts:7:3 .*\(killed in pass B by child\/x\.test\.ts > x, and again alone, but the gate stopped before the run with no mutant after the reruns\)$/m);
    expect(text).toMatch(/^ {2}src\/a\.ts:4:3 .*\(pass a2 made no mutant at this place, so it ran no test on it\)$/m);
    expect(text).toMatch(/^ {2}src\/a\.ts:5:3 .*\(pass b2 made no mutant at this place, so it ran no test on it\)$/m);
    expect(text).not.toMatch(/^Survivors /m);
    expect(text).toMatch(/^Inconclusive .*\n {2}src\/a\.ts:1:3 .*\(killed in pass B by child\/x\.test\.ts > x, but hung instead of failing when run alone\)$/m);
    expect(text).toMatch(/^ {2}src\/a\.ts:2:3 .*\(killed in pass B, never rerun alone\)$/m);
    expect(text).toMatch(/^ {2}src\/a\.ts:3:3 .*\(timed out, never rerun alone\)$/m);
    expect(text).toMatch(/^ {2}killed in pass A: 0; run in pass B: 4, killed there: 0$/m);
  });

  it('has no result when nothing changed or no gating mutant was made, and names what was not tested', () => {
    expect(run([], { emptyScope: true })).toMatchObject({ verdict: 'NO RESULT', code: 2 });
    expect(run([mutant(1, true, { a: pass('CompileError') }), mutant(2, false, { a: pass('Killed', { killedBy: 'x' }) })]).lines.at(-1))
      .toBe('Verdict: NO RESULT (every gating mutant was a type error, so no test ran against the change)');
    const none = run([mutant(1, false, { a: pass('Killed', { killedBy: 'x' }) })], {
      skipped: [{ file: 'src/webui/public/app.jsx', why: 'a browser view' }],
      unmatched: ['src/missing.ts:1-2'],
      noMutant: [{ file: 'src/a.ts', lines: [4, 9] }],
      brackets: [{ file: 'src/a.ts', lines: [5] }],
      deleted: [{ file: 'src/b.ts', lines: [0, 2] }],
    });
    expect(none).toMatchObject({ verdict: 'NO RESULT', code: 2 });
    const text = none.lines.join('\n');
    expect(text).toContain('  src/webui/public/app.jsx: a browser view');
    expect(text).toContain('  src/missing.ts:1-2');
    expect(text).toMatch(/^Changed lines of code no mutant lies wholly on \(.*the code lines of a multi-line object, array, arrow body, call or condition with no mutant of their own; a changed line of brackets and separators only, in a diff, is listed apart\):\n {2}src\/a\.ts: 4, 9$/m);
    expect(text).toMatch(/^Changed lines that can move the unchanged lines beside them into or out of a block \(brackets and separators only, a brace of a block, or an else, case, default, catch or finally; the lines they move are not gated, so check them\):\n {2}src\/a\.ts: 5$/m);
    expect(text).toMatch(/^Gating mutants \(they touch a changed line that holds code, not one blank or a comment only\): 0: none$/m);
    expect(text).toMatch(/^Context mutants \(in the widened statements, not gating: they touch no changed line that holds code\): 1: 1 Killed$/m);
    expect(text).toMatch(/^Places where lines of code were taken out with fewer or none put back \(a line made a comment or a blank line included\), so what was taken out is left nowhere to mutate \(each after the line named, as the file is now; 0 is its top\); check the code around each:\n {2}src\/b\.ts: after 0, 2$/m);
    expect(none.lines.at(-1)).toBe('Verdict: NO RESULT (no gating mutant was made, so L5 tested nothing (see what was not mutated, and why, and where lines of code were taken out))');
    expect(run([mutant(1, false, { a: pass('Killed', { killedBy: 'x' }) })], {}).lines.at(-1))
      .toBe('Verdict: NO RESULT (no gating mutant was made, so L5 tested nothing (see what was not mutated, and why))');
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

  it('has no result when the tree changed during a run that finished, and says that, not that it stopped', () => {
    const files = Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`);
    const result = run([mutant(1, true, { a: pass('Killed', { killedBy: 'x' }) })], { treeChanged: files });
    expect(result).toMatchObject({ verdict: 'NO RESULT', code: 2 });
    const text = result.lines.join('\n');
    expect(text).not.toMatch(/^Stopped:/m);
    expect(text).toContain(`\nChanged during the run (so no one tree was tested):\n  ${files.slice(0, 10).join(', ')} and 2 more\n`);
    expect(result.lines.at(-1)).toBe('Verdict: NO RESULT (the tree changed during the run, so no one tree was tested)');
    expect(run([mutant(1, true, { a: pass('Killed', { killedBy: 'x' }) })], { treeChanged: [] })).toMatchObject({ verdict: 'PASS', code: 0 });
  });
});
