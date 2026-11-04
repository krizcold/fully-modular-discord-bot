import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { describe, expect, it, onTestFinished } from 'vitest';
import { reachedIds, recordName } from '../helpers/mutationCoverage';
import { COVERAGE_DIR, readReach, reachOf, REACH_FILE, RUN_KEYS_FILE, selectFor, TAKEN_FILE, writeReach } from '../mutation/reach.mjs';
import { judge, type MutantRecord, type PassResult } from '../mutation/verdict.mjs';

// Which fast test files a pass A mutant run takes (mutation/README.md): the
// ones that reached the mutant in the run with no mutant, and every file whose
// reach is unknown.

const root = path.resolve(__dirname, '..', '..');
const vitest = path.join(root, 'test', 'node_modules', 'vitest', 'vitest.mjs');

function tempDir(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Two files the gate would mutate: a constant made at load, and a function only one test calls.
const SOURCE = 'export const LOADED = 1 + 1;\nexport function sign(n: number) { return n > 0 ? "pos" : "neg"; }\n';
const TESTS: Record<string, string> = {
  'calls.test.ts': "import { sign } from './a';\nit('is positive', () => { expect(sign(1)).toBe('pos'); });",
  'loads.test.ts': "import { LOADED } from './a';\nit('loads', () => { expect(LOADED).toBe(2); });",
  'mocks.test.ts': "vi.mock('./a', () => ({ sign: () => 'pos' }));\nimport { sign } from './a';\nit('is mocked', () => { expect(sign(1)).toBe('pos'); });",
  'spawns.test.ts': "import { spawnSync } from 'child_process';\nimport './a';\nit('starts a process', () => { expect(spawnSync(process.execPath, ['-e', '0']).status).toBe(0); });",
  'execs.test.ts': "import { execFile } from 'child_process';\nimport { promisify } from 'util';\nit('starts a process', async () => { await promisify(execFile)(process.execPath, ['-e', '0']); });",
  // Code in a beforeAll's cleanup, which vitest runs after every afterAll, still counts.
  'cleanup.test.ts': "import { sign } from './a';\nbeforeAll(() => () => { sign(-1); });\nit('runs', () => { expect(1).toBe(1); });",
  // In another order the record may come before the file's other hooks.
  'parallel.test.ts': "vi.setConfig({ sequence: { hooks: 'parallel' } });\nimport './a';\nit('runs', () => { expect(1).toBe(1); });",
  // A vitest a test starts would find no dir to write its records into.
  'env.test.ts': "it('hides the dir', () => { expect(process.env.SMDB_MUTATION_COVERAGE).toBeUndefined(); });",
};

describe('the run with no mutant', () => {
  it("records each test file's reach through Stryker's own instrumented code, and is unsure of a file that starts a process", { timeout: 180_000 }, async () => {
    const dir = tempDir('smdb-reach-');
    const logger = { debug() {}, info() {}, warn() {}, error() {}, trace() {}, fatal() {}, isDebugEnabled: () => false, isTraceEnabled: () => false };
    const { files, mutants } = await new Instrumenter(logger as never).instrument(
      [{ name: path.join(dir, 'a.ts'), mutate: true, content: SOURCE }], { plugins: null, excludedMutations: [], ignorers: [] },
    );
    fs.writeFileSync(path.join(dir, 'a.ts'), files[0].content);
    for (const [name, body] of Object.entries(TESTS)) fs.writeFileSync(path.join(dir, name), `${body}\n`);
    // The pool and isolation of test/vitest.config.ts, which runs every test file in a process of its own.
    const setup = path.join(root, 'test', 'helpers', 'mutationCoverage.ts');
    fs.writeFileSync(path.join(dir, 'vitest.config.mjs'), `export default ${JSON.stringify({ test: { globals: true, pool: 'forks', setupFiles: [setup] } })};\n`);
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    const env: NodeJS.ProcessEnv = { ...process.env, SMDB_MUTATION_COVERAGE: path.join(out, COVERAGE_DIR) };
    delete env.__STRYKER_ACTIVE_MUTANT__;
    const run = spawnSync(process.execPath, [vitest, 'run', '--root', dir, '--reporter=json', `--outputFile=${path.join(out, 'dry-fast.json')}`], {
      cwd: dir, env, encoding: 'utf8', timeout: 120_000,
    });
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
    writeReach(out, dir);
    const reach = readReach(out);
    expect(reach?.files.slice().sort()).toEqual(Object.keys(TESTS).sort());

    // The last of a mutator's mutants with that replacement, by place: of the two strings, "neg".
    const idOf = (mutator: string, replacement: string) => mutants.filter(m => m.mutatorName === mutator && m.replacement === replacement)
      .sort((x, y) => x.location.start.column - y.location.start.column).at(-1)?.id ?? '';
    const sorted = (list: string[] | null) => list?.slice().sort() ?? null;
    const unsure = ['execs.test.ts', 'parallel.test.ts', 'spawns.test.ts'];
    // A string only a call with a negative number reaches: only the cleanup did.
    expect(sorted(selectFor(reach, idOf('StringLiteral', '""')))).toEqual(['cleanup.test.ts', ...unsure].sort());
    // The constant made at load: every file that loaded the module, the mocked one aside.
    expect(sorted(selectFor(reach, idOf('ArithmeticOperator', '1 - 1')))).toEqual(['calls.test.ts', 'cleanup.test.ts', 'loads.test.ts', ...unsure].sort());
    // The comparison only the calls reach.
    expect(sorted(selectFor(reach, idOf('EqualityOperator', 'n >= 0')))).toEqual(['calls.test.ts', 'cleanup.test.ts', ...unsure].sort());
    const names = fs.readdirSync(path.join(out, COVERAGE_DIR));
    expect(names).toHaveLength(Object.keys(TESTS).length);
    const records = names.map(name => JSON.parse(fs.readFileSync(path.join(out, COVERAGE_DIR, name), 'utf8')));
    expect(records.find(r => r.file.endsWith('mocks.test.ts'))).toEqual({ file: expect.any(String), ids: [] });
    expect(records.find(r => r.file.endsWith('env.test.ts'))).toEqual({ file: expect.any(String), ids: [] });
    expect(records.find(r => r.file.endsWith('spawns.test.ts'))?.unsure).toBe('it started a process');
    expect(records.find(r => r.file.endsWith('execs.test.ts'))?.unsure).toBe('it started a process');
    expect(records.find(r => r.file.endsWith('parallel.test.ts'))?.unsure).toBe("its hooks ran in the parallel order, not 'stack'");
  });

  it('reads every id the namespace counts, at load or under a test id, and names a record by a hash and the process', () => {
    expect(reachedIds(undefined)).toEqual([]);
    expect(reachedIds({ mutantCoverage: { static: { 1: 2 }, perTest: { t1: { 2: 1, 1: 1 }, t2: { 3: 1 } } } }).sort()).toEqual(['1', '2', '3']);
    expect(recordName('D:/a/test/unit/x.test.ts', 12)).toMatch(/^[0-9a-f]{32}-12\.json$/);
    expect(recordName('D:/a/test/unit/x.test.ts', 12)).not.toBe(recordName('D:/a/test/unit/y.test.ts', 12));
    expect(recordName('D:/a/test/unit/x.test.ts', 12)).not.toBe(recordName('D:/a/test/unit/x.test.ts', 13));
  });
});

describe('the reach', () => {
  const testDir = path.resolve('/t/test');
  const at = (name: string) => path.join(testDir, name);

  it('is unsure of a file with no record, an unsure one, or one whose ids cannot be read', () => {
    const reach = reachOf(testDir, [at('unit/a.test.ts'), at('unit/b.test.ts'), at('unit/c.test.ts'), at('unit/d.test.ts'), at('unit/e.test.ts')], [
      { file: at('unit/a.test.ts'), ids: ['1', '2'] },
      { file: at('unit/b.test.ts'), ids: ['2'], unsure: 'it started a process' },
      { file: at('unit/c.test.ts'), ids: [1] },
      { file: at('unit/e.test.ts'), ids: [] },
      { ids: ['3'] },
    ]);
    expect(reach).toEqual({ files: ['unit/a.test.ts', 'unit/b.test.ts', 'unit/c.test.ts', 'unit/d.test.ts', 'unit/e.test.ts'], unsure: [1, 2, 3], reached: { 1: [0], 2: [0] } });
    expect(selectFor(reach, '1')).toEqual(['unit/a.test.ts', 'unit/b.test.ts', 'unit/c.test.ts', 'unit/d.test.ts']);
    expect(selectFor(reach, '3')).toEqual(['unit/b.test.ts', 'unit/c.test.ts', 'unit/d.test.ts']);
  });

  it('takes every related file when there is no reach, or every file reached the mutant, and none when no file did', () => {
    expect(selectFor(null, '1')).toBeNull();
    const reach = reachOf(testDir, [at('unit/a.test.ts'), at('unit/b.test.ts')], [{ file: at('unit/a.test.ts'), ids: ['1', '2'] }, { file: at('unit/b.test.ts'), ids: ['1'] }]);
    expect(selectFor(reach, '1')).toBeNull();
    expect(selectFor(reach, '2')).toEqual(['unit/a.test.ts']);
    expect(selectFor(reach, '9')).toEqual([]);
    // An id named like an object's own property is still only an id.
    expect(selectFor(reach, 'constructor')).toEqual([]);
  });

  it('is left only from a fast report that lists a file, and read back only when whole', () => {
    const out = tempDir('smdb-reach-');
    writeReach(out, testDir);
    expect(fs.existsSync(path.join(out, REACH_FILE))).toBe(false);
    fs.writeFileSync(path.join(out, 'dry-fast.json'), JSON.stringify({ testResults: [] }));
    writeReach(out, testDir);
    expect(readReach(out)).toBeNull();
    fs.writeFileSync(path.join(out, 'dry-fast.json'), JSON.stringify({ testResults: [{ name: at('unit/a.test.ts') }] }));
    writeReach(out, testDir);
    expect(readReach(out)).toEqual({ files: ['unit/a.test.ts'], unsure: [0], reached: {} });
    for (const bad of ['{', '{"files":["a"],"unsure":[1],"reached":{}}', '{"files":["a"],"unsure":[],"reached":{"1":[0.5]}}', '{"files":[1],"unsure":[],"reached":{}}']) {
      fs.writeFileSync(path.join(out, REACH_FILE), bad);
      expect(readReach(out), bad).toBeNull();
    }
  });
});

describe('a pass A mutant run', () => {
  interface Call { args: string[]; coverage: string | null; include: string[] | null }

  // A stand-in for vitest that records its calls and, given a coverage dir, leaves a report of two test files and a
  // record of the first.
  function fake() {
    const dir = tempDir('smdb-select-');
    const calls = path.join(dir, 'calls.jsonl');
    const script = path.join(dir, 'vitest.cjs');
    fs.writeFileSync(script, [
      "const fs = require('fs');",
      "const path = require('path');",
      'const args = process.argv.slice(2);',
      'const coverage = process.env.SMDB_MUTATION_COVERAGE || null;',
      "const include = process.env.SMDB_MUTATION_INCLUDE ? JSON.parse(fs.readFileSync(process.env.SMDB_MUTATION_INCLUDE, 'utf8')) : null;",
      `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, coverage, include }) + '\\n');`,
      'if (coverage) {',
      '  const testDir = process.cwd();',
      "  const report = args.find(arg => arg.startsWith('--outputFile=')).slice('--outputFile='.length);",
      "  fs.writeFileSync(report, JSON.stringify({ testResults: [{ name: path.join(testDir, 'unit', 'a.test.ts') }, { name: path.join(testDir, 'unit', 'b.test.ts') }] }));",
      '  fs.mkdirSync(coverage, { recursive: true });',
      "  fs.writeFileSync(path.join(coverage, 'a.json'), JSON.stringify({ file: path.join(testDir, 'unit', 'a.test.ts'), ids: ['3'] }));",
      '}',
      '',
    ].join('\n'));
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    const read = (): Call[] => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Call) : []);
    return { script, out, read };
  }

  const runner = (stand: { script: string; out: string }, pass: string, mutant: string, confirm = '') => spawnSync(process.execPath, [path.join(root, 'test', 'mutation', 'runner.mjs')], {
    encoding: 'utf8',
    env: {
      ...process.env, SMDB_MUTATION_VITEST: stand.script, SMDB_MUTATION_PASS: pass, SMDB_MUTATION_FILES: '["test/mutation/control.mjs"]', SMDB_MUTATION_OUT: stand.out,
      SMDB_MUTATION_CONFIRM: confirm, SMDB_MUTATION_ONLY: '[]', SMDB_MUTATION_RUN: '', __STRYKER_ACTIVE_MUTANT__: mutant,
      // As a shell may set it: only pass A's run with no mutant gets a dir, its own.
      SMDB_MUTATION_COVERAGE: path.join(stand.out, 'shell'),
    },
  });

  it('as a rerun alone (a2), records nothing and takes every related file, whatever reach is left, with no link to pass A', () => {
    const stand = fake();
    expect(runner(stand, 'a', 'none', '1').status).toBe(0);
    expect(stand.read()[0]).toMatchObject({ coverage: null, args: expect.arrayContaining(['related']) });
    expect(fs.existsSync(path.join(stand.out, REACH_FILE))).toBe(false);
    fs.writeFileSync(path.join(stand.out, REACH_FILE), JSON.stringify({ files: ['unit/a.test.ts', 'unit/b.test.ts'], unsure: [], reached: {} }));
    expect(runner(stand, 'a', '4', '1').status).toBe(0);
    expect(stand.read()[1].args[0]).toBe('related');
    expect(JSON.parse(fs.readFileSync(path.join(stand.out, '4-reach.json'), 'utf8'))).toEqual({ files: 'related' });
  });

  it('as a rerun alone (a2), takes the files its run in pass A took, and every related file when a link to them is missing', () => {
    const stand = fake();
    fs.writeFileSync(path.join(stand.out, RUN_KEYS_FILE), JSON.stringify({ 4: 'k4', 5: 'k5', 6: 'k6' }));
    fs.writeFileSync(path.join(stand.out, TAKEN_FILE), JSON.stringify({ k4: ['unit/b.test.ts'], k5: 'related', k6: [] }));
    expect(runner(stand, 'a', '4', '1').status).toBe(0);
    expect(stand.read()[0]).toMatchObject({ coverage: null, include: ['unit/b.test.ts'], args: expect.arrayContaining(['run', '--bail=1', '--project', 'fast']) });
    expect(JSON.parse(fs.readFileSync(path.join(stand.out, '4-reach.json'), 'utf8'))).toEqual({ files: ['unit/b.test.ts'] });
    // Pass A took every related file, took none (no rerun follows that), or the id has no key: every related file.
    for (const mutant of ['5', '6', '7']) {
      expect(runner(stand, 'a', mutant, '1').status).toBe(0);
      expect(stand.read().at(-1)?.args[0], mutant).toBe('related');
      expect(JSON.parse(fs.readFileSync(path.join(stand.out, `${mutant}-reach.json`), 'utf8')), mutant).toEqual({ files: 'related' });
    }
    // a2's own run with no mutant takes every related file, which its budget is built from.
    expect(runner(stand, 'a', 'none', '1').status).toBe(0);
    expect(stand.read().at(-1)).toMatchObject({ coverage: null, args: expect.arrayContaining(['related']) });
    fs.writeFileSync(path.join(stand.out, TAKEN_FILE), '{');
    expect(runner(stand, 'a', '4', '1').status).toBe(0);
    expect(stand.read().at(-1)?.args[0]).toBe('related');
  });

  it('takes every related file when the reach cannot be written, and runs its files when its own record cannot be', () => {
    const stand = fake();
    fs.mkdirSync(path.join(stand.out, REACH_FILE));
    expect(runner(stand, 'a', 'none').status).toBe(0);
    expect(fs.existsSync(path.join(stand.out, 'dry-ms.txt'))).toBe(true);
    expect(runner(stand, 'a', '4').status).toBe(0);
    expect(stand.read()[1].args[0]).toBe('related');

    fs.rmSync(path.join(stand.out, REACH_FILE), { recursive: true });
    fs.writeFileSync(path.join(stand.out, REACH_FILE), JSON.stringify({ files: ['unit/a.test.ts', 'unit/b.test.ts'], unsure: [], reached: { 3: [0] } }));
    fs.mkdirSync(path.join(stand.out, '3-reach.json'));
    expect(runner(stand, 'a', '3').status).toBe(0);
    expect(stand.read()[2]).toMatchObject({ args: expect.arrayContaining(['run']), include: ['unit/a.test.ts'] });
  });

  it('takes, after the run with no mutant recorded the reach, only the files that reached its mutant or are unsure', () => {
    const stand = fake();
    expect(runner(stand, 'a', 'none').status).toBe(0);
    const [dry] = stand.read();
    expect(dry.coverage).toBe(path.join(stand.out, COVERAGE_DIR));
    expect(dry.args.slice(0, 2)).toEqual(['related', 'mutation/control.mjs']);
    expect(readReach(stand.out)).toEqual({ files: ['unit/a.test.ts', 'unit/b.test.ts'], unsure: [1], reached: { 3: [0] } });

    // b.test.ts left no record, so it runs for every mutant: one a.test.ts reached runs both, the related way.
    expect(runner(stand, 'a', '3').status).toBe(0);
    expect(stand.read()[1]).toMatchObject({ coverage: null, args: expect.arrayContaining(['related', '--bail=1']) });
    expect(JSON.parse(fs.readFileSync(path.join(stand.out, '3-reach.json'), 'utf8'))).toEqual({ files: 'related' });
    expect(runner(stand, 'a', '4').status).toBe(0);
    expect(stand.read()[2]).toMatchObject({ args: expect.arrayContaining(['run']), include: ['unit/b.test.ts'] });
    expect(stand.read()[2].args).toEqual(expect.arrayContaining(['--bail=1', '--project', 'fast']));

    // With b.test.ts sure and reaching nothing, a mutant only a.test.ts reached runs it alone, and one no file reached runs none.
    fs.writeFileSync(path.join(stand.out, REACH_FILE), JSON.stringify({ files: ['unit/a.test.ts', 'unit/b.test.ts'], unsure: [], reached: { 3: [0] } }));
    expect(runner(stand, 'a', '3').status).toBe(0);
    expect(stand.read()[3]).toMatchObject({ args: expect.arrayContaining(['run']), include: ['unit/a.test.ts'] });
    expect(runner(stand, 'a', '4').status).toBe(0);
    expect(stand.read()).toHaveLength(4);
    expect(JSON.parse(fs.readFileSync(path.join(stand.out, '4-reach.json'), 'utf8'))).toEqual({ files: [] });
  });

  it('leaves pass B as it was: every related integration test, then the child tier', () => {
    const stand = fake();
    fs.writeFileSync(path.join(stand.out, REACH_FILE), JSON.stringify({ files: ['unit/a.test.ts', 'unit/b.test.ts'], unsure: [], reached: {} }));
    expect(runner(stand, 'b', '4').status).toBe(0);
    expect(stand.read().map(call => call.args.slice(0, 1))).toEqual([['related'], ['run']]);
    expect(fs.existsSync(path.join(stand.out, '4-reach.json'))).toBe(false);
  });
});

describe('the report', () => {
  const mutant = (line: number, passes: MutantRecord['passes']): MutantRecord =>
    ({ file: 'src/a.ts', location: { start: { line, column: 3 }, end: { line, column: 9 } }, mutator: 'EqualityOperator', original: 'a > 0', replacement: 'a >= 0', gating: true, passes });
  const pass = (status: string, extra: Partial<PassResult> = {}): PassResult => ({ id: '1', status, ...extra });

  it('says of a survivor no fast test reached that none did, and counts them', () => {
    const text = judge({
      stamp: 't', scope: 's', emptyScope: false, skipped: [], noMutant: [], unmatched: [], report: 'r', mutants: [
        mutant(1, { a: pass('Survived', { unreached: true }), b: pass('Survived') }),
        mutant(2, { a: pass('Survived'), b: pass('Survived') }),
        mutant(3, { a: pass('Survived', { unreached: true }), b: pass('Killed', { killedBy: 'child/x.test.ts > x' }), b2: pass('Killed', { killedBy: 'child/x.test.ts > x' }) }),
      ],
    }).lines.join('\n');
    expect(text).toMatch(/^ {2}src\/a\.ts:1:3 .*\(no fast test reached it\)$/m);
    expect(text).toMatch(/^ {2}src\/a\.ts:2:3 EqualityOperator: `a > 0` -> `a >= 0`$/m);
    expect(text).toMatch(/^ {2}survivors no fast test reached \(.*\): 1$/m);
    expect(judge({ stamp: 't', scope: 's', emptyScope: false, skipped: [], noMutant: [], unmatched: [], report: 'r', mutants: [mutant(2, { a: pass('Killed', { killedBy: 'x' }) })] }).lines.join('\n'))
      .not.toMatch(/no fast test reached/);
  });
});
