import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  a2Dir, boundedDir, chainOf, controlLines, keysOf, lockOf, mutantDir, nextDir, planOf, resultLines, resumeNumber, savedRun, setKey, setLines, setupChanges, someOf,
  STAGE_DIR, stageOf,
  type PlannedMutant, type SavedResult, type StageDir,
} from '../mutation/resume.mjs';
import { confirmed, judge, type MutantRecord } from '../mutation/verdict.mjs';

// What a gate run saves as it goes and how a resume walks it (mutation/resume.mjs), the reporter that saves it
// (mutation/targets.mjs) and the lock on a report dir (mutation/touched.mjs). The gate runs that stop and resume are in
// integration/mutationResumeGate.test.ts.

const root = path.resolve(__dirname, '..', '..');
const line = (r: unknown) => `${JSON.stringify(r)}\n`;

describe('the saved results', () => {
  it('are one per line, and a last line cut short is dropped, whole JSON or not', () => {
    const one = { key: 'k1', id: '1', status: 'Killed', statusReason: 'expected 1\nto be 2' };
    const two = { key: 'k2', id: '2', status: 'Survived' };
    expect(resultLines(line(one) + line(two))).toEqual({ lines: [one, two], problem: '' });
    expect(resultLines(`${line(one)}{"key":"k2","id":"2","sta`)).toEqual({ lines: [one], problem: '' });
    expect(resultLines(`${line(one)}${JSON.stringify(two)}`)).toEqual({ lines: [one], problem: '' });
    expect(resultLines('')).toEqual({ lines: [], problem: '' });
  });

  it('cannot be read when a whole line does not read as a result', () => {
    const one = { key: 'k1', id: '1', status: 'Killed' };
    for (const bad of ['nonsense', '{"key":"k","id":2,"status":"Killed"}', '{"key":"k","id":"2"}', 'null', '{"key":"k","id":"2","status":"Killed","statusReason":3}']) {
      expect(resultLines(`${line(one)}${bad}\n${line(one)}`), bad).toEqual({ lines: [], problem: 'line 2 does not read as a result' });
    }
  });

  it('cannot be read when a line holds a status Stryker never reports: the verdict reads any other as no failure', () => {
    for (const status of ['Killed', 'Survived', 'NoCoverage', 'CompileError', 'RuntimeError', 'Timeout', 'Ignored']) {
      expect(resultLines(line({ key: 'k', id: '1', status })).lines, status).toEqual([{ key: 'k', id: '1', status }]);
    }
    for (const status of ['Survivec', 'Pending', 'killed', 'Missing', '']) {
      expect(resultLines(line({ key: 'k', id: '1', status })).problem, status).toBe(`line 1 holds the status ${JSON.stringify(status)}, which Stryker never reports for a tested mutant`);
    }
  });

  it('of a check of sets are a line per finished set, by its files; one with no exit left no result', () => {
    const files = ['unit/a.test.ts', 'unit/b.test.ts'];
    expect(setLines(`${line({ files, code: 1, ms: 30, ended: false })}${line({ files: ['unit/c.test.ts'], code: null, ms: null })}{"files":`)).toEqual({
      lines: [{ key: setKey(files), files, code: 1, ms: 30 }, { key: setKey(['unit/c.test.ts']), files: ['unit/c.test.ts'], code: null, ms: null }], problem: '',
    });
    for (const bad of [{ files: 'unit/a.test.ts', code: 0, ms: 1 }, { files, code: '0', ms: 1 }, { files, ms: 1 }]) {
      expect(setLines(line(bad)).problem, JSON.stringify(bad)).toBe('line 1 does not read as the run of a set of test files');
    }
    expect(controlLines(line({ key: 'control', failed: '' }))).toEqual({ lines: [{ key: 'control', failed: '' }], problem: '' });
    expect(controlLines(line({ key: 'other', failed: '' })).problem).toBe('line 1 does not read as the outcome of a run with no mutant');
  });
});

describe('the saved plan and run', () => {
  const planned = { id: '3', key: 'src/a.ts|EqualityOperator|a >= 0|10:3-10:9', file: 'src/a.ts', location: { start: { line: 10, column: 3 }, end: { line: 10, column: 9 } }, mutator: 'EqualityOperator', replacement: 'a >= 0' };

  it('read a plan only when every mutant in it reads', () => {
    expect(planOf(JSON.stringify([planned]))).toEqual([planned]);
    expect(planOf(JSON.stringify([planned, { ...planned, location: { start: { line: 1 } } }]))).toBeNull();
    expect(planOf(JSON.stringify([{ ...planned, replacement: undefined }]))).toBeNull();
    expect(planOf('{"id":"3"}')).toBeNull();
    expect(planOf('[{"id":"3"')).toBeNull();
    expect(keysOf('["a","b"]')).toEqual(['a', 'b']);
    for (const bad of ['["a",1]', '{}', '["a"']) expect(keysOf(bad), bad).toBeNull();
  });

  const setup = { path: '/usr/bin/node', version: 'v24.1.0', standIn: '' };
  const run = { tree: [['src/a.ts', '3:1:abc']], packages: [['node_modules/.package-lock.json', 'missing']], scope: { mutate: ['src/a.ts'] }, targets: [{ file: 'src/a.ts', patterns: ['src/a.ts'], gating: null }], seed: '42', setup };

  it('read run.json only when all it holds reads: the prints, the scope, the targets, the seed and what ran the tests', () => {
    expect(savedRun(JSON.stringify(run))).toEqual(run);
    const base = { ...run, scope: { base: 'main', mergeBase: 'abc123' }, targets: [{ file: 'src/a.ts', patterns: ['src/a.ts:1-2'], gating: [1, 2], deleted: [3] }] };
    expect(savedRun(JSON.stringify(base))).toEqual(base);
    for (const bad of [
      { ...run, tree: undefined }, { ...run, tree: [['src/a.ts']] }, { ...run, packages: {} }, { ...run, scope: { base: 'main' } }, { ...run, scope: { mutate: ['x'], base: 'main', mergeBase: 'a' } },
      { ...run, targets: [{ file: 'src/a.ts', patterns: [] }] }, { ...run, seed: 42 }, { ...run, seed: '4.2' }, { ...run, seed: undefined },
      { ...run, setup: undefined }, { ...run, setup: { path: '/usr/bin/node', version: 'v24.1.0' } }, { ...run, setup: { ...setup, version: 24 } }, { ...run, setup: { ...setup, path: null } },
    ]) {
      expect(savedRun(JSON.stringify(bad)), JSON.stringify(bad)).toBeNull();
    }
    expect(savedRun('{"tree":')).toBeNull();
    expect(savedRun('null')).toBeNull();
  });

  it('name what ran the tests when it is not what runs them now: the Node binary, its version, the stand-in for vitest', () => {
    expect(setupChanges(setup, { ...setup })).toEqual([]);
    expect(setupChanges(setup, { ...setup, version: 'v22.12.0' })).toEqual(['the Node binary (/usr/bin/node, v24.1.0; now /usr/bin/node, v22.12.0)']);
    expect(setupChanges(setup, { ...setup, path: '/opt/node' })).toEqual(['the Node binary (/usr/bin/node, v24.1.0; now /opt/node, v24.1.0)']);
    expect(setupChanges({ ...setup, standIn: '/tmp/vitest.cjs' }, setup)).toEqual(['the stand-in for vitest (/tmp/vitest.cjs; now none)']);
    expect(setupChanges(setup, { ...setup, standIn: '/tmp/vitest.cjs' })).toEqual(['the stand-in for vitest (none; now /tmp/vitest.cjs)']);
  });

  it('read a lock only when its process id and start time read', () => {
    expect(lockOf('{"pid":12,"started":"2026-11-11T00:00:00.000Z"}\n')).toEqual({ pid: 12, started: '2026-11-11T00:00:00.000Z' });
    for (const bad of ['', '{"pid":12}', '{"pid":"12","started":"x"}', '{"pid":0,"started":"x"}', '{"pid":1.5,"started":"x"}']) expect(lockOf(bad), bad).toBeNull();
  });
});

describe('the dirs of a stage', () => {
  const names = ['b', 'a-r2', 'a', 'a-r10', 'a-r1', 'a2', 'a-unchecked', 'a2-r1', 'b-r3', 'b2-1', 'b2-1-r1', 'b2-10', 'alone-a', 'alone-a2-r2', 'run.json'];

  it('are its own name and then its -r<n> forms, in the order they were made', () => {
    expect(chainOf(names, 'a')).toEqual(['a', 'a-r1', 'a-r2', 'a-r10']);
    expect(chainOf(names, 'b')).toEqual(['b', 'b-r3']);
    expect(chainOf(names, 'b2-1')).toEqual(['b2-1', 'b2-1-r1']);
    expect(chainOf(names, 'alone-a')).toEqual(['alone-a']);
    expect(chainOf(names, 'alone-a2')).toEqual(['alone-a2-r2']);
    expect(chainOf(['a-unchecked', 'a2'], 'a')).toEqual([]);
  });

  it('are the only dirs a stage of the gate runs in', () => {
    for (const name of ['a', 'a-r3', 'a-unchecked', 'a-unchecked-r1', 'alone-a', 'a2', 'control-a2-r2', 'alone-a2', 'b', 'b2-1', 'b2-12-r3', 'control-b2']) expect(STAGE_DIR.test(name), name).toBe(true);
    for (const name of ['run.json', 'lock.json', 'summary.txt', 'b2', 'b2-x', 'a-rx', 'resume-r1.json', 'mutants-before-r1.json']) expect(STAGE_DIR.test(name), name).toBe(false);
  });

  it('give a resume a number no name in the dir has, so it writes no dir of an earlier run', () => {
    expect(resumeNumber([])).toBe(1);
    expect(resumeNumber(['a', 'b', 'run.json', 'summary.txt'])).toBe(1);
    expect(resumeNumber(['a', 'a-r1', 'alone-a-r3', 'resume-r2.json'])).toBe(4);
    expect(resumeNumber(['summary-before-r6.txt', 'a-r5'])).toBe(7);
    expect(nextDir('alone-a', [], 3)).toBe('alone-a');
    expect(nextDir('b2-1', ['b2-1'], 3)).toBe('b2-1-r3');
  });

  it('read a bound mark in every dir of pass A\'s tests, and as a rerun\'s own budget in a2\'s', () => {
    for (const dir of ['a', 'a-r1', 'a-unchecked', 'a-unchecked-r2', 'a2', 'a2-r12']) expect(boundedDir(dir), dir).toBe(true);
    for (const dir of ['b', 'b-r1', 'b2-1', 'alone-a', 'control-a2', 'a-rx', 'xa']) expect(boundedDir(dir), dir).toBe(false);
    for (const dir of ['a2', 'a2-r3']) expect(a2Dir(dir), dir).toBe(true);
    for (const dir of ['a', 'a-r2', 'a-unchecked']) expect(a2Dir(dir), dir).toBe(false);
  });
});

describe('a dir of a Stryker stage', () => {
  const at = { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } };
  const planned = (key: string, id: string): PlannedMutant => ({ id, key, file: 'src/a.ts', location: at, mutator: 'm', replacement: 'r' });
  const result = (key: string, id: string, status = 'Survived'): SavedResult => ({ key, id, status });

  it('ran for its targets, or with none for every mutant its plan holds, and settles with no result a target its plan lacks', () => {
    const plan = [planned('k1', '1'), planned('k2', '2')];
    expect(mutantDir({ dir: 'a', targets: null, plan, results: [result('k1', '1')], done: false }))
      .toEqual({ dir: 'a', forKeys: ['k1', 'k2'], lines: [result('k1', '1')], missing: [], done: false });
    expect(mutantDir({ dir: 'a2', targets: ['k2', 'k9'], plan, results: [], done: true })).toEqual({ dir: 'a2', forKeys: ['k2', 'k9'], lines: [], missing: ['k9'], done: true });
    // Stopped before its plan: it knows its targets, and none is settled.
    expect(mutantDir({ dir: 'b', targets: ['k1'], plan: null, results: [], done: false })).toEqual({ dir: 'b', forKeys: ['k1'], lines: [], missing: [], done: false });
    expect(mutantDir({ dir: 'a', targets: null, plan: null, results: [], done: false })).toEqual({ dir: 'a', forKeys: null, lines: [], missing: [], done: false });
  });

  it('cannot be read with results but no plan, a plan with a mutant twice, or a result whose id is not its key\'s in the plan', () => {
    expect(mutantDir({ dir: 'a', targets: null, plan: null, results: [result('k1', '1')], done: false })).toEqual({ problem: 'a/ holds results but no plan.json, so what their ids name is not known' });
    expect(mutantDir({ dir: 'a', targets: null, plan: [planned('k1', '1'), planned('k1', '2')], results: [], done: false })).toEqual({ problem: 'a/plan.json holds the mutant k1 twice' });
    expect(mutantDir({ dir: 'a2', targets: ['k1'], plan: [planned('k1', '1')], results: [result('k1', '4')], done: false })).toEqual({ problem: 'a2/results.jsonl gives k1 the id 4, but its plan gives it 1' });
  });
});

describe('a stage on a resume', () => {
  const dir = (name: string, forKeys: string[] | null, keys: string[], done = false, missing: string[] = []): StageDir => ({ dir: name, forKeys, lines: keys.map(key => ({ key })), missing, done });
  const walk = (dirs: StageDir[], want: string[] | null) => {
    const s = stageOf(dirs, want);
    return 'problem' in s ? s : { ...s, settled: [...s.settled].map(([key, v]) => [key, v.dir, v.line === null ? null : 'line']) };
  };

  it('that finished is read back whole, and nothing of it runs again', () => {
    expect(walk([dir('a2', ['k1', 'k2', 'k3'], ['k1', 'k3'], false, []), dir('a2-r1', ['k2'], ['k2'], true)], ['k1', 'k2', 'k3'])).toEqual({
      targets: ['k1', 'k2', 'k3'], settled: [['k1', 'a2', 'line'], ['k3', 'a2', 'line'], ['k2', 'a2-r1', 'line']], missing: [], done: true, used: ['a2', 'a2-r1'],
    });
    // Pass A on every mutant takes its items from its first dir that knew them.
    expect(walk([dir('a', null, []), dir('a-r1', ['k1', 'k2'], ['k1', 'k2'], true)], null)).toMatchObject({ targets: ['k1', 'k2'], missing: [], done: true, used: ['a', 'a-r1'] });
  });

  it('that stopped runs only the items it has no result for; one its plan lacks has its result', () => {
    expect(walk([dir('b', ['k1', 'k2', 'k3', 'k4'], ['k2'], false, ['k4'])], ['k1', 'k2', 'k3', 'k4'])).toEqual({
      targets: ['k1', 'k2', 'k3', 'k4'], settled: [['k2', 'b', 'line'], ['k4', 'b', null]], missing: ['k1', 'k3'], done: false, used: ['b'],
    });
    expect(walk([dir('b', ['k1', 'k2'], ['k2']), dir('b-r1', ['k1'], [])], ['k1', 'k2'])).toMatchObject({ missing: ['k1'], done: false });
    // One that never started, or stopped before it knew its items, runs them all.
    expect(walk([], ['k1'])).toEqual({ targets: ['k1'], settled: [], missing: ['k1'], done: false, used: [] });
    expect(walk([dir('a', null, [])], null)).toEqual({ targets: null, settled: [], missing: [], done: false, used: ['a'] });
  });

  it('cannot be resumed from a line for an item its dir did not run for, an item settled twice, or done.json that does not cover its items', () => {
    expect(walk([dir('a2', ['k1'], ['k1', 'k9'])], ['k1'])).toEqual({ problem: 'a2/ holds a result for k9, which it did not run for' });
    expect(walk([dir('a2', ['k1', 'k2'], ['k1', 'k1'])], ['k1', 'k2'])).toEqual({ problem: 'a2/ holds a second result for k1' });
    expect(walk([dir('a2', ['k1', 'k2'], ['k1'], false, ['k1'])], ['k1', 'k2'])).toEqual({ problem: 'a2/ holds a second result for k1' });
    expect(walk([dir('a2', ['k1', 'k2'], ['k1']), dir('a2-r1', ['k2'], ['k2', 'k1'])], ['k1', 'k2'])).toEqual({ problem: 'a2-r1/ holds a result for k1, which it did not run for' });
    expect(walk([dir('a2', ['k1', 'k2'], ['k1'], true)], ['k1', 'k2'])).toEqual({ problem: 'a2/ holds done.json, but 1 of the 2 item(s) the stage ran for have no result' });
  });

  it('cannot be resumed from dirs that ran for other items than the stage is for now, or had left, or from a dir after the one that finished', () => {
    expect(walk([dir('b', ['k1', 'k2'], [])], ['k1', 'k3'])).toEqual({ problem: 'b/ ran for 2 item(s), not the 2 the stage is for now' });
    expect(walk([dir('b', ['k1', 'k2'], ['k1']), dir('b-r1', ['k1', 'k2'], [])], ['k1', 'k2'])).toEqual({ problem: 'b-r1/ ran for 2 item(s), not the 1 the stage had left' });
    expect(walk([dir('b', ['k1'], ['k1'], true), dir('b-r1', [], [], true)], ['k1'])).toEqual({ problem: 'b-r1/ comes after b/, where the stage finished' });
    expect(walk([dir('b', ['k1', 'k1'], [])], ['k1'])).toEqual({ problem: 'b/ names an item it ran for twice' });
    expect(walk([dir('a', null, ['k1'])], null)).toEqual({ problem: 'a/ holds results but does not say what it ran for' });
    expect(walk([dir('a', null, [], true)], null)).toEqual({ problem: 'a/ holds done.json but does not say what it ran for' });
  });
});

describe('the reporter', () => {
  afterEach(() => vi.unstubAllEnvs());

  const reporter = async () => {
    const { strykerPlugins } = await import('../mutation/targets.mjs');
    const Reporter = strykerPlugins[0].injectableClass as unknown as new () => { onMutationTestingPlanReady(event: unknown): unknown; onMutantTested(result: unknown): unknown };
    return new Reporter();
  };
  const outDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-saved-'));
    onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
    vi.stubEnv('SMDB_MUTATION_OUT', dir);
    vi.stubEnv('SMDB_MUTATION_TARGETS', '');
    vi.stubEnv('SMDB_MUTATION_RUN', '');
    return dir;
  };
  const place = (line: number) => ({ start: { line, column: 2 }, end: { line, column: 8 } });
  const tested = (id: string, status: string, line = 4, statusReason?: string) =>
    ({ id, fileName: path.join(root, 'src', 'a.ts'), mutatorName: 'BlockStatement', replacement: '{}', location: place(line), status, ...(statusReason ? { statusReason } : {}) });

  it('writes plan.json when the plan is ready, before the call returns: each mutant with its key and places from 1', async () => {
    const dir = outDir();
    const planned = (id: string, replacement: string | undefined, line: number) =>
      ({ plan: 'Run', mutant: { id, fileName: path.join(root, 'src', 'a.ts'), mutatorName: 'EqualityOperator', replacement, location: place(line) } });
    expect((await reporter()).onMutationTestingPlanReady({ mutantPlans: [planned('1', 'a >= 0', 9), planned('2', undefined, 0)] })).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'))).toEqual([
      { id: '1', key: 'src/a.ts|EqualityOperator|a >= 0|10:3-10:9', file: 'src/a.ts', location: { start: { line: 10, column: 3 }, end: { line: 10, column: 9 } }, mutator: 'EqualityOperator', replacement: 'a >= 0' },
      { id: '2', key: 'src/a.ts|EqualityOperator||1:3-1:9', file: 'src/a.ts', location: { start: { line: 1, column: 3 }, end: { line: 1, column: 9 } }, mutator: 'EqualityOperator', replacement: '' },
    ]);
  });

  it('appends a line per result as Stryker reports it, CompileError and Ignored included, before the call returns', async () => {
    const dir = outDir();
    const r = await reporter();
    const file = path.join(dir, 'results.jsonl');
    const reason = 'src/a.ts(4,3): error TS2578: Unused \'@ts-expect-error\' directive.\nsrc/a.ts(5,1): error TS2355: x';
    expect(r.onMutantTested(tested('1', 'CompileError', 4, reason))).toBeUndefined();
    expect(resultLines(fs.readFileSync(file, 'utf8')).lines).toEqual([{ key: 'src/a.ts|BlockStatement|{}|4:2-4:8', id: '1', status: 'CompileError', statusReason: reason }]);
    r.onMutantTested(tested('2', 'Ignored', 4, 'disabled'));
    r.onMutantTested(tested('3', 'Survived'));
    const text = fs.readFileSync(file, 'utf8');
    expect(text.split('\n')).toHaveLength(4);
    expect(resultLines(text).lines.map(saved => [saved.id, saved.status, saved.statusReason])).toEqual([['1', 'CompileError', reason], ['2', 'Ignored', 'disabled'], ['3', 'Survived', undefined]]);
  });

  it('in a pass on some of the mutants, writes a line only for those it is for: Stryker reports the others Survived with no test run', async () => {
    const dir = outDir();
    const targets = path.join(dir, 'targets.json');
    fs.writeFileSync(targets, JSON.stringify(['src/a.ts|BlockStatement|{}|4:2-4:8']));
    vi.stubEnv('SMDB_MUTATION_TARGETS', targets);
    vi.stubEnv('SMDB_MUTATION_RUN', path.join(dir, 'run-ids.json'));
    const r = await reporter();
    const planned = (id: string, line: number) => ({ plan: 'Run', mutant: { id, fileName: path.join(root, 'src', 'a.ts'), mutatorName: 'BlockStatement', replacement: '{}', location: place(line - 1) } });
    r.onMutationTestingPlanReady({ mutantPlans: [planned('1', 4), planned('2', 5)] });
    r.onMutantTested(tested('1', 'Killed', 4));
    r.onMutantTested(tested('2', 'Survived', 5));
    expect(resultLines(fs.readFileSync(path.join(dir, 'results.jsonl'), 'utf8')).lines).toEqual([{ key: 'src/a.ts|BlockStatement|{}|4:2-4:8', id: '1', status: 'Killed' }]);
  });

  it('writes nothing where no pass dir is named', async () => {
    const dir = outDir();
    vi.stubEnv('SMDB_MUTATION_OUT', '');
    const r = await reporter();
    r.onMutationTestingPlanReady({ mutantPlans: [] });
    r.onMutantTested({ id: '1', fileName: 'src/a.ts', mutatorName: 'x', location: place(1), status: 'Survived' });
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('the lock on a report dir', () => {
  const gate = path.join(root, 'test', 'mutation', 'touched.mjs');
  // A resume of `dir` that ends before any pass: a stand-in for vitest that records each call, and a bound, so a check
  // that broke and let it go on runs no real test.
  const resume = (dir: string) => {
    const calls = path.join(dir, '..', `calls-${path.basename(dir)}.jsonl`);
    const standIn = path.join(dir, '..', 'vitest.cjs');
    fs.writeFileSync(standIn, `require('fs').appendFileSync(${JSON.stringify(calls)}, 'called\\n');\nprocess.exit(1);\n`);
    const run = spawnSync(process.execPath, [gate, '--resume', dir, '--concurrency', '1'],
      { cwd: root, encoding: 'utf8', timeout: 300_000, env: { ...process.env, SMDB_MUTATION_VITEST: standIn, SMDB_STANDIN_CALLS: calls } });
    expect(fs.existsSync(calls)).toBe(false);
    return run;
  };
  const report = () => {
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-lock-'));
    onTestFinished(() => fs.rmSync(outer, { recursive: true, force: true }));
    const dir = path.join(outer, 'report');
    fs.mkdirSync(dir);
    return dir;
  };
  const verdict = (stdout: string) => /^Verdict: NO RESULT \(the run in .* cannot be resumed: (.*); no pass ran\)$/m.exec(stdout)?.[1];

  it('refuses a resume while the process it names still runs, and leaves it as it was', { timeout: 300_000 }, () => {
    const dir = report();
    const lock = `${JSON.stringify({ pid: process.pid, started: '2026-11-11T00:00:00.000Z' })}\n`;
    fs.writeFileSync(path.join(dir, 'lock.json'), lock);
    const run = resume(dir);
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(2);
    expect(verdict(run.stdout)).toBe(`its lock.json names process ${process.pid}, started 2026-11-11T00:00:00.000Z, which still runs, so another gate run may be using the dir; if that process is no gate run, remove lock.json`);
    expect(fs.readFileSync(path.join(dir, 'lock.json'), 'utf8')).toBe(lock);
  });

  it('is taken over from a process that no longer runs, and a resume removes its own at exit', { timeout: 300_000 }, () => {
    const dir = report();
    const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    fs.writeFileSync(path.join(dir, 'lock.json'), `${JSON.stringify({ pid: Number(gone.stdout), started: '2026-11-11T00:00:00.000Z' })}\n`);
    const run = resume(dir);
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(2);
    // Past the lock, it stops at the next check: the dir holds no run.json.
    expect(verdict(run.stdout)).toMatch(/^it holds no run\.json, /);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('cannot be read: the resume is refused', { timeout: 300_000 }, () => {
    const dir = report();
    fs.writeFileSync(path.join(dir, 'lock.json'), '{"pid":');
    const run = resume(dir);
    expect(run.status).toBe(2);
    expect(verdict(run.stdout)).toMatch(/^its lock\.json cannot be read, /);
  });
});

describe('the report of a resumed run', () => {
  const at = { start: { line: 4, column: 3 }, end: { line: 4, column: 9 } };
  const m = (passes: MutantRecord['passes']): MutantRecord => ({ file: 'src/a.ts', location: at, mutator: 'x', original: 'a', replacement: 'b', gating: true, passes });

  it('says it resumed, and what each stage it found saved kept and ran now', () => {
    const resumed = ['a: 3 result(s) kept (a/); the 2 with none run now in a-r1/'];
    const { lines } = judge({ stamp: 't', scope: 's', emptyScope: false, skipped: [], mutants: [m({ a: { id: '1', dir: 'a', status: 'Killed', killedBy: 'unit/x.test.ts > t' } })], noMutant: [], unmatched: [], report: 'r', resumed });
    expect(lines.slice(1, 4)).toEqual(['Scope: s', 'Resumed a stopped run (each stage goes on where it stopped, and no item of it runs twice):', `  ${resumed[0]}`]);
    const fresh = judge({ stamp: 't', scope: 's', emptyScope: false, skipped: [], mutants: [], noMutant: [], unmatched: [], report: 'r' });
    expect(fresh.lines.join('\n')).not.toContain('Resumed');
  });

  it('names the dir of pass A that made no mutant at a place the saved plan holds', () => {
    expect(confirmed(m({ a: { id: null, dir: 'a-r2', status: 'Missing' } }))).toEqual({ outcome: 'Inconclusive', why: 'pass A in a-r2/ made no mutant at this place, so it ran no test on it' });
    expect(confirmed(m({ a: { id: null, dir: 'a-unchecked-r1', status: 'Missing' } })).why).toBe('pass A with no checker made no mutant at this place, so it ran no test on it');
  });
});
