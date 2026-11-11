import { spawnSync } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { describe, expect, it, onTestFinished } from 'vitest';
import { A2_BOUND, PASSES, RUN_BOUND } from '../mutation/passes.mjs';
import {
  boundFor, boundStartMs, COSTS_FILE, costsOf, COVERAGE_DIR, fileKey, readCosts, readRecordDir, readReach, reachOf, REACH_FILE, RUN_KEYS_FILE, selectFor, TAKEN_FILE,
  TIMER_LIMIT_MS, writeCosts, writeReach,
} from '../mutation/reach.mjs';
import { judge, type MutantRecord, type PassResult } from '../mutation/verdict.mjs';

// Which fast test files a pass A mutant run takes (mutation/README.md): the
// ones that reached the mutant in the run with no mutant, and every file whose
// reach is unknown.

const root = path.resolve(__dirname, '..', '..');
const vitest = path.join(root, 'test', 'node_modules', 'vitest', 'vitest.mjs');
const RECORDER = path.join(root, 'test', 'helpers', 'reachRecorder.cjs');
type Kind = 'node' | 'listed' | 'worker' | 'other';
interface Start { token: string; dir: string }
const recorder = createRequire(__filename)(RECORDER) as {
  fileKey(file: string): string;
  kindOfCommand(command: string): Kind;
  kindOfProgram(file: string, argv: unknown[], shell: unknown): Kind;
  pairsWith(pairs: unknown, start: Start): string[];
  envWith(env: Record<string, unknown> | undefined, start: Start): Record<string, unknown>;
};
const PRELOAD = `--require "${RECORDER.split(path.sep).join('/')}"`;
const win = process.platform === 'win32';

function tempDir(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The env of a run with no mutant, which Stryker gives `none`; here the variable is unset, so no code sets activeMutant.
function dryEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.__STRYKER_ACTIVE_MUTANT__;
  return env;
}

// Two files the gate would mutate: a.ts, which test files import, and b.cjs, which only child processes load.
const SOURCES = {
  'a.ts': 'export const LOADED = 1 + 1;\nexport function sign(n: number) { return n > 0 ? "pos" : "neg"; }\n',
  'b.cjs': 'exports.LOADED = 1 + 1;\nexports.sign = function (n) { return n > 0 ? "pos" : "neg"; };\n',
};
// Runs b.cjs as `pos` or `neg` (and with `hold`, never ends), or as `grand`, starts itself as `neg` and loads none of it.
const RUN = [
  "const mode = process.argv[2];",
  "if (mode === 'grand') {",
  "  const run = require('child_process').spawnSync(process.execPath, [__filename, 'neg'], { stdio: 'inherit' });",
  '  process.exit(run.status);',
  '}',
  "const { sign } = require('./b.cjs');",
  "process.stdout.write(sign(mode === 'pos' ? 1 : -1) + '\\n');",
  "if (process.argv[3] === 'hold') setInterval(() => {}, 1000);",
  '',
].join('\n');

async function instrumentInto(dir: string) {
  const logger = { debug() {}, info() {}, warn() {}, error() {}, trace() {}, fatal() {}, isDebugEnabled: () => false, isTraceEnabled: () => false };
  const { files, mutants } = await new Instrumenter(logger as never).instrument(
    Object.entries(SOURCES).map(([name, content]) => ({ name: path.join(dir, name), mutate: true, content })), { plugins: null, excludedMutations: [], ignorers: [] },
  );
  for (const file of files) fs.writeFileSync(file.name, file.content);
  fs.writeFileSync(path.join(dir, 'run.cjs'), RUN);
  // The last of a file's mutants by a mutator with that replacement, by place: of the two strings, "neg".
  const idOf = (file: string, mutator: string, replacement: string, which: 'first' | 'last' = 'last') => {
    const found = mutants.filter(m => path.basename(m.fileName) === file && m.mutatorName === mutator && m.replacement === replacement)
      .sort((x, y) => x.location.start.column - y.location.start.column);
    return (which === 'first' ? found[0] : found.at(-1))?.id ?? '';
  };
  return { idOf };
}

const run = (dir: string) => JSON.stringify(path.join(dir, 'run.cjs'));
const TESTS = (dir: string): Record<string, string> => ({
  'calls.test.ts': "import { sign } from './a';\nit('is positive', () => { expect(sign(1)).toBe('pos'); });",
  'loads.test.ts': "import { LOADED } from './a';\nit('loads', () => { expect(LOADED).toBe(2); });",
  'mocks.test.ts': "vi.mock('./a', () => ({ sign: () => 'pos' }));\nimport { sign } from './a';\nit('is mocked', () => { expect(sign(1)).toBe('pos'); });",
  // vitest runs no hook for a file whose every test is skipped; the record is on disk from the load on.
  'skipped.test.ts': "import { LOADED } from './a';\nit.skip('never runs', () => { expect(LOADED).toBe(2); });",
  // A vitest a test starts would find no dir to write its records into.
  'env.test.ts': "it('hides the dir', () => { expect(process.env.SMDB_MUTATION_COVERAGE).toBeUndefined(); });",
  'kill.test.ts': [
    "import { spawn } from 'child_process';",
    "it('ends a child that ran the code with SIGKILL', async () => {",
    `  const child = spawn(process.execPath, [${run(dir)}, 'pos', 'hold'], { stdio: ['ignore', 'pipe', 'inherit'] });`,
    "  await new Promise<void>((resolve, reject) => { child.stdout.on('data', d => { if (String(d).includes('pos')) resolve(); }); child.once('exit', () => reject(new Error('exited'))); });",
    "  const ended = new Promise(resolve => child.once('exit', (code, signal) => resolve(signal)));",
    "  child.kill('SIGKILL');",
    "  expect(await ended).toBe('SIGKILL');",
    '});',
  ].join('\n'),
  // An env of its own that keeps DATA_DIR, as helpers/forkGuard.cjs demands.
  'ownenv.test.ts': [
    "import { spawnSync } from 'child_process';",
    "it('starts a child with an env of its own', () => {",
    "  const env: Record<string, string> = { DATA_DIR: 'x' };",
    "  for (const name of ['SYSTEMROOT', 'PATH']) if (process.env[name]) env[name] = process.env[name]!;",
    `  const child = spawnSync(process.execPath, [${run(dir)}, 'neg'], { env, encoding: 'utf8' });`,
    "  expect(child.stdout).toBe('neg\\n');",
    "  expect(env.NODE_OPTIONS).toBeUndefined();",
    '});',
  ].join('\n'),
  'grand.test.ts': [
    "import { execFile } from 'child_process';",
    "import { promisify } from 'util';",
    "it('starts a child that starts a child', async () => {",
    `  expect((await promisify(execFile)(process.execPath, [${run(dir)}, 'grand'])).stdout).toBe('neg\\n');`,
    '});',
  ].join('\n'),
  'shell.test.ts': [
    "import { execSync } from 'child_process';",
    "it('runs node through a shell, one simple command', () => {",
    `  expect(execSync(\`"\${process.execPath}" "\${${run(dir)}}" pos\`, { encoding: 'utf8' })).toBe('pos\\n');`,
    '});',
  ].join('\n'),
  'shellop.test.ts': [
    "import { execSync } from 'child_process';",
    "it('runs a shell command with an operator', () => {",
    "  execSync(`\"${process.execPath}\" -e 0 && \"${process.execPath}\" -e 0`);",
    '});',
  ].join('\n'),
  'git.test.ts': [
    "import { execFileSync } from 'child_process';",
    "it('starts git', () => { expect(execFileSync('git', ['--version'], { encoding: 'utf8' })).toMatch(/^git version/); });",
  ].join('\n'),
  'worker.test.ts': [
    "import { once } from 'events';",
    "import { Worker } from 'worker_threads';",
    "it('starts a worker', async () => { await once(new Worker('0', { eval: true }), 'exit'); });",
  ].join('\n'),
});

describe('the run with no mutant', () => {
  it("records each test file's reach and its processes' through Stryker's own instrumented code", { timeout: 240_000 }, async () => {
    const dir = tempDir('smdb-reach-');
    const { idOf } = await instrumentInto(dir);
    const tests = TESTS(dir);
    for (const [name, body] of Object.entries(tests)) fs.writeFileSync(path.join(dir, name), `${body}\n`);
    // The pool and isolation of test/vitest.config.ts, which runs every test file in a process of its own.
    const setup = path.join(root, 'test', 'helpers', 'mutationCoverage.ts');
    fs.writeFileSync(path.join(dir, 'vitest.config.mjs'), `export default ${JSON.stringify({ test: { globals: true, pool: 'forks', setupFiles: [setup] } })};\n`);
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    const begun = performance.now();
    const result = spawnSync(process.execPath, [vitest, 'run', '--root', dir, '--maxWorkers=2', '--reporter=json', `--outputFile=${path.join(out, 'dry-fast.json')}`], {
      cwd: dir, env: dryEnv({ SMDB_MUTATION_COVERAGE: path.join(out, COVERAGE_DIR) }), encoding: 'utf8', timeout: 200_000,
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    writeReach(out, dir, ['fast'], Date.now(), performance.now() - begun);
    const reach = readReach(out);
    expect(reach?.files.slice().sort()).toEqual(Object.keys(tests).sort());
    const unsure = ['shellop.test.ts', 'worker.test.ts'];
    expect(reach?.unsure.map(index => reach.files[index]).sort()).toEqual(unsure);

    const sorted = (list: string[] | null) => list?.slice().sort() ?? null;
    const taking = (...files: string[]) => [...files, ...unsure].sort();
    // a.ts at load: every file that imported it, the mocked one aside, the skipped one included.
    expect(sorted(selectFor(reach, idOf('a.ts', 'ArithmeticOperator', '1 - 1')))).toEqual(taking('calls.test.ts', 'loads.test.ts', 'skipped.test.ts'));
    expect(sorted(selectFor(reach, idOf('a.ts', 'EqualityOperator', 'n >= 0')))).toEqual(taking('calls.test.ts'));
    // b.cjs only in children: the one ended by SIGKILL, the one with an env of its own, the grandchild, the shell's.
    expect(sorted(selectFor(reach, idOf('b.cjs', 'ArithmeticOperator', '1 - 1')))).toEqual(taking('grand.test.ts', 'kill.test.ts', 'ownenv.test.ts', 'shell.test.ts'));
    expect(sorted(selectFor(reach, idOf('b.cjs', 'StringLiteral', '""', 'first')))).toEqual(taking('kill.test.ts', 'shell.test.ts'));
    expect(sorted(selectFor(reach, idOf('b.cjs', 'StringLiteral', '""')))).toEqual(taking('grand.test.ts', 'ownenv.test.ts'));

    const dirs = fs.readdirSync(path.join(out, COVERAGE_DIR));
    expect(dirs).toHaveLength(Object.keys(tests).length);
    const records = dirs.map(name => ({ name, record: readRecordDir(path.join(out, COVERAGE_DIR, name)) }));
    const byName = Object.fromEntries(records.map(({ record }) => [path.basename(record.file ?? ''), record]));
    const dirOf = Object.fromEntries(records.map(({ name, record }) => [path.basename(record.file ?? ''), name]));
    expect(byName['shellop.test.ts'].unsure).toBe("it started a program that may run the tree's code where no record follows it");
    expect(byName['worker.test.ts'].unsure).toBe('it started a worker');
    expect(byName['mocks.test.ts']).toEqual({ file: expect.any(String), ids: [] });
    expect(byName['env.test.ts']).toEqual({ file: expect.any(String), ids: [] });
    expect(byName['git.test.ts']).toEqual({ file: expect.any(String), ids: [] });
    // Each Node child left a record of its own beside the test file's.
    expect(fs.readdirSync(path.join(out, COVERAGE_DIR, dirOf['grand.test.ts']))).toHaveLength(3);
    expect(dirOf['grand.test.ts'].startsWith(`${fileKey(byName['grand.test.ts'].file ?? '')}-`)).toBe(true);
  });

  it('gives every Node process started in every form the three variables, and leaves the caller\'s options and env as they were', { timeout: 120_000 }, () => {
    const dir = tempDir('smdb-shapes-');
    const coverage = path.join(dir, 'coverage');
    const out = path.join(dir, 'probes.jsonl');
    const probe = path.join(dir, 'probe.cjs');
    fs.writeFileSync(probe, "require('fs').appendFileSync(process.argv[2], JSON.stringify({ shape: process.argv[3], options: process.env.NODE_OPTIONS ?? null, reach: process.env.SMDB_MUTATION_REACH ?? null, token: process.env.SMDB_MUTATION_REACH_TOKEN ?? null }) + '\\n');\n");
    const script = path.join(dir, 'shapes.cjs');
    fs.writeFileSync(script, [
      `require(${JSON.stringify(RECORDER)}).openTestFile(${JSON.stringify(coverage)}, __filename);`,
      "const cp = require('child_process');",
      "const { promisify } = require('util');",
      'const exe = process.execPath;',
      `const probe = ${JSON.stringify(probe)};`,
      `const out = ${JSON.stringify(out)};`,
      'const q = text => `"${text}"`;',
      'const line = shape => `${q(exe)} ${q(probe)} ${q(out)} ${shape}`;',
      "const env = () => ({ ...process.env, DATA_DIR: 'd', NODE_OPTIONS: '--max-old-space-size=200' });",
      'const changed = [];',
      'function keep(name, options, call) {',
      '  const before = JSON.stringify(options);',
      '  const given = options.env;',
      '  const result = call();',
      '  if (JSON.stringify(options) !== before || options.env !== given) changed.push(name);',
      '  return result;',
      '}',
      "const done = child => new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => (code === 0 ? resolve() : reject(new Error(`exit ${code}`)))); });",
      'const called = start => new Promise((resolve, reject) => start(error => (error ? reject(error) : resolve())));',
      '(async () => {',
      '  let o;',
      "  o = { env: env() }; await done(keep('spawn', o, () => cp.spawn(exe, [probe, out, 'spawn'], o)));",
      "  await done(cp.spawn(exe, [probe, out, 'spawn-bare']));",
      "  o = { stdio: 'ignore', env: env() }; await done(keep('spawn-no-args', o, () => cp.spawn(exe, o)));",
      "  o = { env: env() }; await called(cb => keep('exec', o, () => cp.exec(line('exec'), o, cb)));",
      "  await called(cb => cp.exec(line('exec-bare'), cb));",
      "  o = { env: env() }; await keep('exec-promisified', o, () => promisify(cp.exec)(line('exec-promisified'), o));",
      "  o = { env: env() }; await called(cb => keep('execFile', o, () => cp.execFile(exe, [probe, out, 'execFile'], o, cb)));",
      "  await called(cb => cp.execFile(exe, [probe, out, 'execFile-bare'], cb));",
      "  o = { env: env() }; await done(keep('fork', o, () => cp.fork(probe, [out, 'fork'], o)));",
      "  await done(cp.fork(probe, [out, 'fork-bare']));",
      "  o = { env: env() }; keep('spawnSync', o, () => cp.spawnSync(exe, [probe, out, 'spawnSync'], o));",
      "  cp.spawnSync(exe, [probe, out, 'spawnSync-bare']);",
      "  o = { stdio: 'ignore', env: env() }; keep('spawnSync-no-args', o, () => cp.spawnSync(exe, o));",
      "  o = { env: env(), shell: true }; keep('spawnSync-shell', o, () => cp.spawnSync(q(exe), [q(probe), q(out), 'spawnSync-shell'], o));",
      "  o = { env: env() }; keep('execSync', o, () => cp.execSync(line('execSync'), o));",
      "  cp.execSync(line('execSync-bare'));",
      "  o = { env: env() }; keep('execFileSync', o, () => cp.execFileSync(exe, [probe, out, 'execFileSync'], o));",
      "  cp.execFileSync(exe, [probe, out, 'execFileSync-bare']);",
      "  o = { stdio: 'ignore', env: env() }; keep('execFileSync-no-args', o, () => cp.execFileSync(exe, o));",
      // Windows names a variable in any case: the child would have had this one as its NODE_OPTIONS.
      "  if (process.platform === 'win32') {",
      "    const lower = { ...process.env, DATA_DIR: 'd', node_options: '--max-old-space-size=200' };",
      '    delete lower.NODE_OPTIONS;',
      "    o = { env: lower }; keep('spawnSync-lower', o, () => cp.spawnSync(exe, [probe, out, 'spawnSync-lower'], o));",
      "    o = { env: { ...lower } }; await done(keep('spawn-lower', o, () => cp.spawn(exe, [probe, out, 'spawn-lower'], o)));",
      '  }',
      "  require('fs').writeFileSync(out + '.changed', JSON.stringify(changed));",
      '})().catch(error => { console.error(error); process.exit(1); });',
      '',
    ].join('\n'));
    const env = dryEnv();
    delete env.NODE_OPTIONS;
    const result = spawnSync(process.execPath, [script], { env, encoding: 'utf8', timeout: 100_000 });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(fs.readFileSync(`${out}.changed`, 'utf8'))).toEqual([]);

    const [recordDir] = fs.readdirSync(coverage);
    const record = readRecordDir(path.join(coverage, recordDir));
    expect(record).toEqual({ file: script, ids: [] });
    const probes = fs.readFileSync(out, 'utf8').trim().split('\n').map(text => JSON.parse(text) as { shape: string; options: string | null; reach: string | null; token: string | null });
    const withEnv = ['spawn', 'exec', 'exec-promisified', 'execFile', 'fork', 'spawnSync', 'spawnSync-shell', 'execSync', 'execFileSync', ...(win ? ['spawnSync-lower', 'spawn-lower'] : [])];
    const bare = ['spawn-bare', 'exec-bare', 'execFile-bare', 'fork-bare', 'spawnSync-bare', 'execSync-bare', 'execFileSync-bare'];
    expect(probes.map(p => p.shape).sort()).toEqual([...withEnv, ...bare].sort());
    for (const p of probes) {
      expect(p.reach, p.shape).toBe(path.join(coverage, recordDir));
      expect(p.options, p.shape).toBe(withEnv.includes(p.shape) ? `--max-old-space-size=200 ${PRELOAD}` : PRELOAD);
    }
    const tokens = probes.map(p => p.token);
    expect(new Set(tokens).size).toBe(tokens.length);
    // Every start, the three with no script too, left a record of a child that carries its token.
    const lines = fs.readdirSync(path.join(coverage, recordDir)).map(name => fs.readFileSync(path.join(coverage, recordDir, name), 'utf8').trim().split('\n').map(text => JSON.parse(text) as Record<string, unknown>));
    const starts = lines.flat().filter(entry => typeof entry.start === 'string');
    expect(starts).toHaveLength(probes.length + 3);
    expect(starts.every(start => start.kind === 'node')).toBe(true);
    const children = lines.map(record => record[0]).filter(header => header.role === 'child').map(header => header.token);
    expect(children.sort()).toEqual(starts.map(start => start.start).sort());
    for (const token of tokens) expect(children).toContain(token);
  });

  it('records every sync start in a shape Node takes beside the common ones, as node with the variables or as other', { timeout: 60_000 }, () => {
    const dir = tempDir('smdb-oddshapes-');
    const run = (name: string, calls: string[]) => {
      const coverage = path.join(dir, name);
      const script = path.join(dir, `${name}.cjs`);
      fs.writeFileSync(script, [
        `require(${JSON.stringify(RECORDER)}).openTestFile(${JSON.stringify(coverage)}, __filename);`,
        "const cp = require('child_process');",
        'const exe = process.execPath;',
        "const env = () => ({ ...process.env, DATA_DIR: 'd' });",
        ...calls,
        '',
      ].join('\n'));
      const result = spawnSync(process.execPath, [script], { env: plainEnv(), encoding: 'utf8', timeout: 30_000 });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      const [recordDir] = fs.readdirSync(coverage);
      const lines = fs.readdirSync(path.join(coverage, recordDir)).flatMap(file => fs.readFileSync(path.join(coverage, recordDir, file), 'utf8').trim().split('\n').map(text => JSON.parse(text) as Record<string, unknown>));
      return { record: readRecordDir(path.join(coverage, recordDir)), kinds: lines.filter(entry => typeof entry.start === 'string').map(entry => entry.kind) };
    };
    const sure = run('sure', [
      "cp.execSync(`\"${exe}\" -e 0`, null);",
      "cp.spawnSync(exe, { env: env(), input: '' }, undefined);",
      "cp.execFileSync(exe, { env: env(), input: '' });",
      "cp.execFileSync(exe, ['-e', '0'], null);",
      "cp.execFileSync(exe, ['-e', '0'], Object.assign(Object.create(null), { env: env() }), undefined);",
    ]);
    expect(sure.kinds).toEqual(['node', 'node', 'node', 'node', 'node']);
    expect(sure.record.unsure).toBeUndefined();
    // Node rejects null options to spawnSync, and must still, under the recorder.
    const rejected = (call: string) => `try { ${call}; process.exit(3); } catch (error) { if (error.code !== 'ERR_INVALID_ARG_TYPE') throw error; }`;
    const odd = [
      "cp.execSync(`\"${exe}\" -e 0`, 5);", "cp.execSync(`\"${exe}\" -e 0`, () => {});", "cp.execFileSync(exe, () => {}, { input: '' });",
      rejected("cp.spawnSync(exe, ['-e', '0'], null)"), rejected('cp.spawnSync(exe, null, null)'),
      "cp.execSync(`\"${exe}\" -e 0`, { shell: process.env.comspec || '/bin/sh' });",
      "cp.execFileSync(`\"${exe}\"`, ['-e', '0'], { shell: process.env.comspec || '/bin/sh' });",
      "cp.spawnSync(`\"${exe}\"`, ['-e', '0'], { shell: process.env.comspec || '/bin/sh' });",
    ];
    for (const [index, call] of odd.entries()) {
      const other = run(`odd-${index}`, [call]);
      expect(other.kinds, call).toEqual(['other']);
      expect(other.record.unsure, call).toBe('it started a program that may run the tree\'s code where no record follows it');
    }
  });

  it('leaves every sync call it cannot reproduce exactly to Node unchanged, as a start of kind other', { timeout: 120_000 }, () => {
    const dir = tempDir('smdb-unread-');
    const outcome = (index: number, call: string, recorded: boolean) => {
      const coverage = path.join(dir, `c-${index}-${recorded}`);
      const script = path.join(dir, `u-${index}-${recorded}.cjs`);
      fs.writeFileSync(script, [
        recorded ? `require(${JSON.stringify(RECORDER)}).openTestFile(${JSON.stringify(coverage)}, __filename);` : '',
        "const cp = require('child_process');",
        'const exe = process.execPath;',
        `const elsewhere = ${JSON.stringify(dir)};`,
        "const cwdOf = ['-e', 'process.stdout.write(process.env.SMDB_MUTATION_REACH_TOKEN ? \"\" : process.cwd())'];",
        'let result;',
        `try { result = String((${call}) ?? '').trim(); } catch (error) { result = \`throws \${error.code}\`; }`,
        'process.stdout.write(JSON.stringify(result));',
        '',
      ].join('\n'));
      const run = spawnSync(process.execPath, [script], { cwd: os.tmpdir(), env: plainEnv(), encoding: 'utf8', timeout: 30_000 });
      expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
      if (!recorded) return { result: JSON.parse(run.stdout) as string, kinds: [] as unknown[] };
      const [recordDir] = fs.readdirSync(coverage);
      const lines = fs.readdirSync(path.join(coverage, recordDir)).flatMap(file => fs.readFileSync(path.join(coverage, recordDir, file), 'utf8').trim().split('\n').map(text => JSON.parse(text) as Record<string, unknown>));
      return { result: JSON.parse(run.stdout) as string, kinds: lines.filter(entry => typeof entry.start === 'string').map(entry => entry.kind) };
    };
    const calls = [
      "cp.execFileSync(exe, { input: '' }, 5)",
      "cp.execFileSync(exe, { input: '' }, 'x')",
      "cp.execFileSync(exe, { input: '' }, () => {})",
      "cp.spawnSync(exe, { input: '' }, 'x').status",
      "cp.execFileSync(exe, ['-e', '0'], {}, 'extra')",
      "cp.execSync(`\"${exe}\" -e 0`, {}, 'extra')",
      'cp.spawnSync(exe, cwdOf, Object.create({ cwd: elsewhere })).stdout',
      'cp.execFileSync(exe, cwdOf, Object.create({ cwd: elsewhere }))',
      "cp.execFileSync(exe, cwdOf, Object.defineProperty({}, 'cwd', { value: elsewhere, enumerable: false }))",
      "cp.execFileSync(exe, cwdOf, { env: Object.create(process.env) })",
      "cp.execFileSync(exe, cwdOf, { [Symbol('s')]: 1 })",
      "cp.execFileSync(exe, cwdOf, Object.defineProperty({}, 'cwd', { get: () => elsewhere, enumerable: true }))",
      "cp.execFileSync(exe, cwdOf, { env: Object.defineProperty({ ...process.env }, 'X', { get: () => '1', enumerable: true }) })",
    ];
    for (const [index, call] of calls.entries()) {
      const plain = outcome(index, call, false);
      const recorded = outcome(index, call, true);
      expect(recorded.result, call).toBe(plain.result);
      expect(recorded.kinds, call).toEqual(['other']);
    }
    expect(outcome(99, "cp.execFileSync(exe, { input: '' }, 5)", false).result).toBe('throws ERR_INVALID_ARG_TYPE');
  });

  it('counts ids under a test id and in objects given to it, under strict mode, and never sets the active mutant', { timeout: 60_000 }, async () => {
    const dir = tempDir('smdb-counts-');
    const { idOf } = await instrumentInto(dir);
    const coverage = path.join(dir, 'coverage');
    const script = path.join(dir, 'counts.cjs');
    fs.writeFileSync(script, [
      "'use strict';",
      `require(${JSON.stringify(RECORDER)}).openTestFile(${JSON.stringify(coverage)}, __filename);`,
      'const ns = globalThis.__stryker__;',
      "ns.mutantCoverage.static.s1 = 1;",
      "ns.currentTestId = 't1';",
      "require('./b.cjs').sign(-1);",
      "const c = ns.mutantCoverage.perTest.t1 = ns.mutantCoverage.perTest.t1 || {};",
      "c.p1 = (c.p1 || 0) + 1;",
      "c.p1 = (c.p1 || 0) + 1;",
      "ns.mutantCoverage.perTest.t2 = { p2: 1 };",
      "ns.mutantCoverage.perTest.t2.p3 = 1;",
      "process.stdout.write(JSON.stringify({ active: 'activeMutant' in ns, p1: c.p1, static: Object.keys(ns.mutantCoverage.static) }));",
      '',
    ].join('\n'));
    const result = spawnSync(process.execPath, [script], { env: dryEnv(), encoding: 'utf8', timeout: 30_000 });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ active: false, p1: 2, static: ['s1'] });
    const [recordDir] = fs.readdirSync(coverage);
    const record = readRecordDir(path.join(coverage, recordDir));
    expect(record.unsure).toBeUndefined();
    expect(record.ids).toEqual(expect.arrayContaining(['s1', 'p1', 'p2', 'p3', idOf('b.cjs', 'ArithmeticOperator', '1 - 1'), idOf('b.cjs', 'StringLiteral', '""')]));
    expect(record.ids).not.toContain(idOf('b.cjs', 'StringLiteral', '""', 'first'));
    expect(new Set(record.ids).size).toBe(record.ids.length);
  });

  it('is unsure of a process whose namespace held a count object before the recorder started', { timeout: 60_000 }, () => {
    const dir = tempDir('smdb-late-');
    const coverage = path.join(dir, 'coverage');
    const pre = path.join(dir, 'pre.cjs');
    fs.writeFileSync(pre, 'globalThis.__stryker__ = { mutantCoverage: { static: { 9: 1 }, perTest: {} } };\n');
    const script = path.join(dir, 'late.cjs');
    fs.writeFileSync(script, `require(${JSON.stringify(RECORDER)}).openTestFile(${JSON.stringify(coverage)}, __filename);\n`);
    const result = spawnSync(process.execPath, ['--require', pre, script], { env: dryEnv(), encoding: 'utf8', timeout: 30_000 });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const [recordDir] = fs.readdirSync(coverage);
    expect(readRecordDir(path.join(coverage, recordDir)).unsure).toBe('a process of it counted mutants before its recorder started');
  });

  // A process with no recorder of its own, whatever run of the gate starts this file.
  const plainEnv = (extra: NodeJS.ProcessEnv = {}) => {
    const env = dryEnv(extra);
    for (const name of ['NODE_OPTIONS', 'SMDB_MUTATION_REACH', 'SMDB_MUTATION_REACH_TOKEN']) if (!(name in extra)) delete env[name];
    return env;
  };

  it('sends, in a test file process that is also a child of another, its starts to its own records and marks them elsewhere in the older', { timeout: 60_000 }, async () => {
    const dir = tempDir('smdb-elsewhere-');
    const { idOf } = await instrumentInto(dir);
    const coverage = path.join(dir, 'coverage');
    const script = path.join(dir, 'inner.cjs');
    fs.writeFileSync(script, [
      `require(${JSON.stringify(RECORDER)}).openTestFile(${JSON.stringify(coverage)}, __filename);`,
      "const cp = require('child_process');",
      `process.stdout.write(cp.spawnSync(process.execPath, [${run(dir)}, 'neg'], { encoding: 'utf8' }).stdout);`,
      "cp.execFileSync('git', ['--version']);",
      '',
    ].join('\n'));
    // A real older test file's process: a recorder in this one (the gate's run with no mutant) would replace variables given by hand.
    const outerCoverage = path.join(dir, 'outer');
    const outerScript = path.join(dir, 'outer.cjs');
    fs.writeFileSync(outerScript, [
      `require(${JSON.stringify(RECORDER)}).openTestFile(${JSON.stringify(outerCoverage)}, ${JSON.stringify(path.join(dir, 'outer.test.ts'))});`,
      `const run = require('child_process').spawnSync(process.execPath, [${JSON.stringify(script)}], { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });`,
      'process.stdout.write(run.stdout);',
      'process.exit(run.status);',
      '',
    ].join('\n'));
    const result = spawnSync(process.execPath, [outerScript], { env: plainEnv(), encoding: 'utf8', timeout: 30_000 });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toBe('neg\n');

    const read = (file: string) => fs.readFileSync(file, 'utf8').trim().split('\n').map(text => JSON.parse(text) as Record<string, unknown>);
    const [outerDir] = fs.readdirSync(outerCoverage);
    const outer = path.join(outerCoverage, outerDir);
    const outerRecords = fs.readdirSync(outer).map(name => read(path.join(outer, name)));
    const outerOwn = outerRecords.filter(record => record[0].role === 'file');
    expect(outerOwn).toHaveLength(1);
    expect(outerOwn[0].slice(1)).toEqual([{ start: expect.any(String), kind: 'node' }]);
    const mine = outerRecords.filter(record => record[0].role !== 'file');
    expect(mine).toHaveLength(1);
    const [header, ...rest] = mine[0];
    expect(header).toMatchObject({ role: 'child', token: outerOwn[0][1].start, ranOther: false, late: false });
    expect(rest).toEqual([{ start: expect.any(String), kind: 'node', elsewhere: true }, { start: expect.any(String), kind: 'listed', elsewhere: true }]);
    expect(readRecordDir(outer).unsure).toBe('a process of it started one whose records go to another test file');

    const [innerDir] = fs.readdirSync(coverage);
    const inner = readRecordDir(path.join(coverage, innerDir));
    expect(inner.unsure).toBeUndefined();
    expect(inner.file).toBe(script);
    expect(inner.ids).toEqual(expect.arrayContaining([idOf('b.cjs', 'ArithmeticOperator', '1 - 1'), idOf('b.cjs', 'StringLiteral', '""')]));
    const innerStarts = fs.readdirSync(path.join(coverage, innerDir)).flatMap(name => read(path.join(coverage, innerDir, name))).filter(entry => typeof entry.start === 'string');
    expect(innerStarts.map(({ start, kind }) => ({ start, kind }))).toEqual(rest.map(({ start, kind }) => ({ start, kind })));
  });

  it('is unsure of a test file its process ran after another', { timeout: 30_000 }, () => {
    const dir = tempDir('smdb-ranother-');
    const coverage = path.join(dir, 'coverage');
    const script = path.join(dir, 'two.cjs');
    const [one, two] = [path.join(dir, 'one.test.ts'), path.join(dir, 'two.test.ts')];
    fs.writeFileSync(script, [
      `const recorder = require(${JSON.stringify(RECORDER)});`,
      `recorder.openTestFile(${JSON.stringify(coverage)}, ${JSON.stringify(one)});`,
      `recorder.openTestFile(${JSON.stringify(coverage)}, ${JSON.stringify(two)});`,
      '',
    ].join('\n'));
    const result = spawnSync(process.execPath, [script], { env: plainEnv(), encoding: 'utf8', timeout: 20_000 });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const records = Object.fromEntries(fs.readdirSync(coverage).map(name => readRecordDir(path.join(coverage, name))).map(record => [record.file, record.unsure ?? null]));
    expect(records).toEqual({ [one]: null, [two]: 'its process ran another test file first' });
  });

  it('marks a write that failed beside the record, and in the record at the next write that works', { timeout: 30_000 }, () => {
    const dir = tempDir('smdb-failed-');
    const coverage = path.join(dir, 'coverage');
    const script = path.join(dir, 'failed.cjs');
    fs.writeFileSync(script, [
      `require(${JSON.stringify(RECORDER)}).openTestFile(${JSON.stringify(coverage)}, __filename);`,
      // The record's own sink: a recorder preloaded through NODE_OPTIONS took fs.writeSync before this file could replace it.
      "const sink = globalThis[Symbol.for('smdb.reachRecorder')].sinks.at(-1);",
      'const fd = sink.fd;',
      'const counts = globalThis.__stryker__.mutantCoverage.static;',
      'sink.fd = 2 ** 30;',
      'counts.f1 = 1;',
      'sink.fd = fd;',
      'counts.f2 = 1;',
      '',
    ].join('\n'));
    const result = spawnSync(process.execPath, [script], { env: plainEnv(), encoding: 'utf8', timeout: 20_000 });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const [recordDir] = fs.readdirSync(coverage);
    const names = fs.readdirSync(path.join(coverage, recordDir)).sort();
    expect(names).toHaveLength(2);
    expect(names[1]).toBe(`${names[0]}.failed`);
    const lines = fs.readFileSync(path.join(coverage, recordDir, names[0]), 'utf8').trim().split('\n').map(text => JSON.parse(text) as Record<string, unknown>);
    expect(lines.slice(1)).toEqual([{ failed: true }, { id: 'f2' }]);
    expect(readRecordDir(path.join(coverage, recordDir)).unsure).toBeTruthy();
  });

  // A test file's process starts a Node child whose record cannot be opened (and, with `marker`, nor the file beside
  // it); that child starts a Node grandchild whose record opens.
  function unopened(marker: boolean) {
    const dir = tempDir('smdb-unopened-');
    const coverage = path.join(dir, 'coverage');
    const fail = path.join(dir, 'fail.cjs');
    fs.writeFileSync(fail, [
      "const fs = require('fs');",
      'const open = fs.openSync;',
      `const ends = ${JSON.stringify(marker ? ['.jsonl', '.failed'] : ['.jsonl'])};`,
      'const write = fs.writeFileSync;',
      "if (process.argv[2] === 'middle') {",
      "  fs.openSync = (file, ...rest) => { if (ends.some(end => String(file).endsWith(end))) throw new Error('EMFILE'); return open(file, ...rest); };",
      "  fs.writeFileSync = (file, ...rest) => { if (ends.some(end => String(file).endsWith(end))) throw new Error('EMFILE'); return write(file, ...rest); };",
      '}',
      '',
    ].join('\n'));
    const middle = path.join(dir, 'middle.cjs');
    fs.writeFileSync(middle, [
      "if (process.argv[2] === 'middle') {",
      "  const run = require('child_process').spawnSync(process.execPath, [__filename, 'leaf'], { stdio: 'inherit' });",
      '  process.exit(run.status);',
      '}',
      '',
    ].join('\n'));
    const script = path.join(dir, 'outer.cjs');
    fs.writeFileSync(script, [
      `require(${JSON.stringify(RECORDER)}).openTestFile(${JSON.stringify(coverage)}, __filename);`,
      `const env = { ...process.env, NODE_OPTIONS: ${JSON.stringify(`--require "${fail.split(path.sep).join('/')}"`)} };`,
      `const run = require('child_process').spawnSync(process.execPath, [${JSON.stringify(middle)}, 'middle'], { stdio: 'inherit', env });`,
      'process.exit(run.status);',
      '',
    ].join('\n'));
    const result = spawnSync(process.execPath, [script], { env: plainEnv(), encoding: 'utf8', timeout: 30_000 });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const [recordDir] = fs.readdirSync(coverage);
    return path.join(coverage, recordDir);
  }

  it('leaves a marker when a child cannot open its record', { timeout: 60_000 }, () => {
    const record = unopened(false);
    const markers = fs.readdirSync(record).filter(name => !name.endsWith('.jsonl'));
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatch(/\.jsonl\.failed$/);
    expect(readRecordDir(record).unsure).toBe(`its record dir holds ${markers[0]}, which is no record (a write failed)`);
  });

  it('lets no process under a child that cannot open its record answer for its start', { timeout: 60_000 }, () => {
    const record = unopened(true);
    const names = fs.readdirSync(record);
    expect(names.every(name => name.endsWith('.jsonl'))).toBe(true);
    const roles = names.map(name => (JSON.parse(fs.readFileSync(path.join(record, name), 'utf8').split('\n')[0]) as { role: string }).role);
    expect(roles).toEqual(['file']);
    expect(readRecordDir(record).unsure).toBe('it started a Node process that left no record');
  });

  it('names a record dir by the same key the reach reads', () => {
    expect(fileKey('D:/a/test/unit/x.test.ts')).toMatch(/^[0-9a-f]{32}$/);
    expect(recorder.fileKey('D:/a/test/unit/x.test.ts')).toBe(fileKey('D:/a/test/unit/x.test.ts'));
    expect(fileKey('D:/a/test/unit/x.test.ts')).not.toBe(fileKey('D:/a/test/unit/y.test.ts'));
  });
});

describe('the kind of a start', () => {
  it('is node for Node by name or path, listed for fsutil, git and sync, other for the rest', () => {
    expect(recorder.kindOfProgram(process.execPath, [], false)).toBe('node');
    expect(recorder.kindOfProgram('node', ['x.js'], false)).toBe('node');
    expect(recorder.kindOfProgram('/usr/local/bin/node', [], false)).toBe('node');
    expect(recorder.kindOfProgram('git', ['--version'], false)).toBe('listed');
    expect(recorder.kindOfProgram('/usr/bin/sync', [], false)).toBe('listed');
    expect(recorder.kindOfProgram('fsutil', [], false)).toBe('listed');
    expect(recorder.kindOfProgram('python', ['x.py'], false)).toBe('other');
    expect(recorder.kindOfProgram('nodejs', [], false)).toBe('other');
    if (win) {
      expect(recorder.kindOfProgram('C:\\Program Files\\nodejs\\NODE.EXE', [], false)).toBe('node');
      expect(recorder.kindOfProgram('C:\\Git\\cmd\\git.exe', [], false)).toBe('listed');
    }
  });

  it('is, for a shell, the kind of its whole command when that is one simple command, and other when not', () => {
    const shell = (command: string) => (win ? recorder.kindOfProgram('cmd.exe', ['/d', '/s', '/c', `"${command}"`], true) : recorder.kindOfProgram('/bin/sh', ['-c', command], true));
    expect(shell('node x.js a b')).toBe('node');
    expect(shell(' "/opt/my node/node" x.js')).toBe('node');
    expect(shell('git clone --depth 1 "https://example.com/r.git" "dir"')).toBe('listed');
    for (const op of ['&&', '&', '|', ';', '<', '>', '(', ')', '`', '$', '%', '^', '\n', '\r']) expect(shell(`node x.js ${op} y`), JSON.stringify(op)).toBe('other');
    expect(shell('"node')).toBe('other');
    expect(shell('"no"de x')).toBe('other');
    expect(shell('FOO=1 node x')).toBe('other');
    expect(shell('python x.py')).toBe('other');
    expect(shell('')).toBe('other');
    // The platform's shell started by name, not through options.shell, in the form child_process gives it.
    expect(win ? recorder.kindOfProgram(process.env.comspec || 'cmd.exe', ['/d', '/s', '/c', '"node x"'], false) : recorder.kindOfProgram('/bin/sh', ['-c', 'node x'], false)).toBe('node');
    // Any other form of a shell's arguments is other.
    expect(win ? recorder.kindOfProgram('cmd.exe', ['/c', 'node x'], true) : recorder.kindOfProgram('/bin/sh', ['-c', 'node x', 'extra'], true)).toBe('other');
    expect(recorder.kindOfProgram('/bin/bash', ['-c', 'node x'], true)).toBe('node');
    // A shell given by name is other, whatever its command.
    expect(recorder.kindOfProgram('/bin/bash', ['-c', 'node x'], '/bin/bash')).toBe('other');
    expect(recorder.kindOfProgram('cmd.exe', ['/d', '/s', '/c', '"node x"'], 'cmd.exe')).toBe('other');
  });

  it('gives a child the three variables after the NODE_OPTIONS it would have had, in new objects only', () => {
    const start = { token: 't1', dir: 'D:/c/k-1' };
    const pairs = ['A=1', 'NODE_OPTIONS=--max-old-space-size=200', 'SMDB_MUTATION_REACH=old', '=C:=C:\\'];
    const given = [...pairs];
    expect(recorder.pairsWith(pairs, start)).toEqual(['A=1', '=C:=C:\\', `NODE_OPTIONS=--max-old-space-size=200 ${PRELOAD}`, 'SMDB_MUTATION_REACH=D:/c/k-1', 'SMDB_MUTATION_REACH_TOKEN=t1']);
    expect(pairs).toEqual(given);
    // One preload, not two, for a child of a child.
    expect(recorder.pairsWith([`NODE_OPTIONS=${PRELOAD}`], start)[0]).toBe(`NODE_OPTIONS=${PRELOAD}`);
    const env = { A: '1', NODE_OPTIONS: '--x', SMDB_MUTATION_REACH_TOKEN: 'old' };
    expect(recorder.envWith(env, start)).toEqual({ A: '1', NODE_OPTIONS: `--x ${PRELOAD}`, SMDB_MUTATION_REACH: 'D:/c/k-1', SMDB_MUTATION_REACH_TOKEN: 't1' });
    expect(env).toEqual({ A: '1', NODE_OPTIONS: '--x', SMDB_MUTATION_REACH_TOKEN: 'old' });
    expect(recorder.envWith({ A: '1' }, start).NODE_OPTIONS).toBe(PRELOAD);
    if (win) {
      // Node keeps the first of a name's case forms in sorted order: NODE_OPTIONS before node_options.
      expect(recorder.envWith({ node_options: '--b', NODE_OPTIONS: '--a' }, start)).toEqual({ NODE_OPTIONS: `--a ${PRELOAD}`, SMDB_MUTATION_REACH: 'D:/c/k-1', SMDB_MUTATION_REACH_TOKEN: 't1' });
      expect(recorder.pairsWith(['node_options=--b', 'Path=x'], start)).toEqual(['Path=x', `NODE_OPTIONS=--b ${PRELOAD}`, 'SMDB_MUTATION_REACH=D:/c/k-1', 'SMDB_MUTATION_REACH_TOKEN=t1']);
    } else {
      expect(recorder.envWith({ node_options: '--b' }, start)).toEqual({ node_options: '--b', NODE_OPTIONS: PRELOAD, SMDB_MUTATION_REACH: 'D:/c/k-1', SMDB_MUTATION_REACH_TOKEN: 't1' });
    }
  });
});

describe('the records of a test file', () => {
  const testDir = path.resolve('/t/test');
  const at = (name: string) => path.join(testDir, name);
  type Line = Record<string, unknown>;
  const own = (file: string, extra: Line = {}): Line => ({ role: 'file', file, ranOther: false, late: false, pid: 1, ...extra });
  const child = (token: string, extra: Line = {}): Line => ({ role: 'child', token, ranOther: false, late: false, pid: 2, ...extra });

  // Leaves, in a pass's dir, a report of `ran` and one record dir per entry (by the file, the pid and its records).
  function pass(ran: string[], dirs: { file: string; pid?: number; records: (Line | string)[][] }[]) {
    const out = tempDir('smdb-records-');
    fs.writeFileSync(path.join(out, 'dry-fast.json'), JSON.stringify({ testResults: ran.map(name => ({ name: at(name) })) }));
    for (const [index, { file, pid = index + 1, records }] of dirs.entries()) {
      const dir = path.join(out, COVERAGE_DIR, `${fileKey(at(file))}-${pid}`);
      fs.mkdirSync(dir, { recursive: true });
      records.forEach((lines, n) => fs.writeFileSync(path.join(dir, `${pid}-${n}.jsonl`), lines.map(line => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n'));
    }
    writeReach(out, testDir);
    return { out, reach: readReach(out) };
  }
  const reasons = (out: string) => Object.fromEntries(fs.readdirSync(path.join(out, COVERAGE_DIR)).map(name => {
    const record = readRecordDir(path.join(out, COVERAGE_DIR, name));
    return [name, record.unsure ?? null];
  }));

  it("is sure with its own record and each Node child's, and holds the ids of all of them", () => {
    const { reach } = pass(['unit/a.test.ts'], [{ file: 'unit/a.test.ts', records: [
      [own(at('unit/a.test.ts')), { id: '1' }, { start: 'n1', kind: 'node' }, { start: 'g1', kind: 'listed' }],
      [child('n1'), { id: '2' }, { start: 'n2', kind: 'node' }],
      [child('n2'), { id: '3' }, { id: '1' }],
      // A Node process git started, which reports with git's start.
      [child('g1'), { id: '4' }],
    ] }]);
    expect(reach).toEqual({ files: ['unit/a.test.ts'], unsure: [], reached: { 1: [0], 2: [0], 3: [0], 4: [0] } });
  });

  it('is unsure for each reason a record gives', () => {
    const file = 'unit/a.test.ts';
    const cases: [string, (Line | string)[][]][] = [
      ['its own process left no record', [[child('n1'), { id: '1' }]]],
      ['more than one record claims to be its own process', [[own(at(file))], [own(at(file))]]],
      ['a line of its record 1-0.jsonl cannot be read', [[own(at(file)), '{"id":"1']]],
      ['a line of its record 1-0.jsonl cannot be read', [[own(at(file)), { start: 'n1', kind: 'shell' }]]],
      ['its record 1-1.jsonl does not start with a header', [[own(at(file)), { start: 'n1', kind: 'node' }], [{ id: '2' }]]],
      ['its process ran another test file first', [[own(at(file), { ranOther: true })]]],
      ['a process of it counted mutants before its recorder started', [[own(at(file)), { start: 'n1', kind: 'node' }], [child('n1', { late: true })]]],
      ['a write to its records failed', [[own(at(file)), { failed: true }, { id: '1' }]]],
      ['it started a worker', [[own(at(file)), { start: 'w1', kind: 'worker' }]]],
      ["it started a program that may run the tree's code where no record follows it", [[own(at(file)), { start: 'o1', kind: 'other' }]]],
      ['it started a Node process that left no record', [[own(at(file)), { start: 'n1', kind: 'node' }, { start: 'n2', kind: 'node' }], [child('n1')]]],
      ['a process of it started one whose records go to another test file', [[own(at(file)), { start: 'g1', kind: 'listed', elsewhere: true }]]],
    ];
    for (const [reason, records] of cases) {
      const { out, reach } = pass([file], [{ file, records }]);
      expect(reach?.unsure, reason).toEqual([0]);
      expect(Object.values(reasons(out)), reason).toEqual([reason]);
    }
  });

  it('is unsure with no record dir, a dir holding a write that failed, or a record naming another file', () => {
    // d's dir holds a record that names e, which left none of its own: neither is sure.
    const { out, reach } = pass(['unit/a.test.ts', 'unit/b.test.ts', 'unit/c.test.ts', 'unit/d.test.ts', 'unit/e.test.ts'], [
      { file: 'unit/b.test.ts', records: [[own(at('unit/b.test.ts')), { id: '1' }]] },
      { file: 'unit/c.test.ts', records: [[own(at('unit/c.test.ts'))]] },
      { file: 'unit/d.test.ts', records: [[own(at('unit/e.test.ts'))]] },
    ]);
    fs.writeFileSync(path.join(out, COVERAGE_DIR, `${fileKey(at('unit/c.test.ts'))}-2`, '2-0.jsonl.failed'), '');
    writeReach(out, testDir);
    expect(readReach(out)?.unsure).toEqual([0, 2, 3, 4]);
    expect(reach?.unsure).toEqual([0, 3, 4]);
    expect(readRecordDir(path.join(out, COVERAGE_DIR, `${fileKey(at('unit/c.test.ts'))}-2`)).unsure).toBe('its record dir holds 2-0.jsonl.failed, which is no record (a write failed)');
  });

  it('is sure, when it ran twice, only when both runs are', () => {
    const sure = (id: string) => [[own(at('unit/a.test.ts')), { id }]];
    expect(pass(['unit/a.test.ts'], [{ file: 'unit/a.test.ts', records: sure('1') }, { file: 'unit/a.test.ts', records: sure('2') }]).reach)
      .toEqual({ files: ['unit/a.test.ts'], unsure: [], reached: { 1: [0], 2: [0] } });
    expect(pass(['unit/a.test.ts'], [{ file: 'unit/a.test.ts', records: sure('1') }, { file: 'unit/a.test.ts', records: [[child('x')]] }]).reach?.unsure).toEqual([0]);
  });
});

describe('the reach', () => {
  const testDir = path.resolve('/t/test');
  const at = (name: string) => path.join(testDir, name);

  it('is unsure of a file with no record, an unsure one, or one whose ids cannot be read', () => {
    const reach = reachOf(testDir, [at('unit/a.test.ts'), at('unit/b.test.ts'), at('unit/c.test.ts'), at('unit/d.test.ts'), at('unit/e.test.ts')], [
      { file: at('unit/a.test.ts'), ids: ['1', '2'] },
      { file: at('unit/b.test.ts'), ids: ['2'], unsure: 'it started a worker' },
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

  it('gives each file what it cost: its span and the gaps on both sides of it, the last one to the end of the run', () => {
    const file = (name: string, startTime: number, endTime: number, durations: (number | undefined)[] = [1]) =>
      ({ name: at(name), startTime, endTime, assertionResults: durations.map(duration => ({ status: duration === undefined ? 'skipped' : 'passed', duration })) });
    // In the order vitest lists them, not the order they ran in. a: 1000 to 1900; b: 1700 to the run's end at 3000.
    const report = { startTime: 1000, testResults: [file('unit/b.test.ts', 1900, 2500), file('unit/a.test.ts', 1400, 1700)] };
    // The run's time by the monotonic clock, from before vitest started.
    const took = 5000;
    expect(costsOf(testDir, report, 3000, took)).toEqual({ 'unit/a.test.ts': 900, 'unit/b.test.ts': 1300 });
    // A file whose tests were all skipped has no times of its own (vitest gives it the report's start): it ran in a gap,
    // the one after the last file included, so it costs the widest gap.
    const skipped = { ...report, testResults: [...report.testResults, file('unit/s.test.ts', 1000, 1000, [undefined, undefined]), file('unit/l.test.ts', 1000, 1000, [])] };
    expect(costsOf(testDir, skipped, 3000, took)).toEqual({ 'unit/a.test.ts': 900, 'unit/b.test.ts': 1300, 'unit/s.test.ts': 500, 'unit/l.test.ts': 500 });
    expect(costsOf(testDir, skipped, 2600, took)).toEqual({ 'unit/a.test.ts': 900, 'unit/b.test.ts': 900, 'unit/s.test.ts': 400, 'unit/l.test.ts': 400 });
    // Times that overlap are not one file after another, so no file has a cost.
    expect(costsOf(testDir, { startTime: 1000, testResults: [file('unit/a.test.ts', 1400, 2000), file('unit/b.test.ts', 1900, 2500)] }, 3000, took)).toBeNull();
    expect(costsOf(testDir, { startTime: 1500, testResults: [file('unit/a.test.ts', 1400, 2000)] }, 3000, took)).toBeNull();
    expect(costsOf(testDir, { startTime: 1000, testResults: [file('unit/a.test.ts', 2000, 1900)] }, 3000, took)).toBeNull();
    // An end of the run before the last file's end, or none.
    for (const end of [2499, NaN, -1]) expect(costsOf(testDir, report, end, took), String(end)).toBeNull();
    // The wall clock stepped forward during the run: the 2 s from the report's start to the end are more than the run
    // took by the monotonic clock plus a second and a hundredth of it (991 ms is the shortest that holds them).
    expect(costsOf(testDir, report, 3000, 991)).toEqual({ 'unit/a.test.ts': 900, 'unit/b.test.ts': 1300 });
    for (const short of [990, 0, NaN, -1]) expect(costsOf(testDir, report, 3000, short), String(short)).toBeNull();
    expect(costsOf(testDir, report, 3000 + 3_600_000, 5000)).toBeNull();
    // No report, no start, a time or a name that cannot be read, or no timed file.
    for (const bad of [null, undefined, {}, { testResults: report.testResults }, { startTime: 'soon', testResults: report.testResults }, { startTime: 1000 },
      { startTime: 1000, testResults: [{ ...file('unit/a.test.ts', 1400, 1700), endTime: null }] }, { startTime: 1000, testResults: [{ startTime: 1400, endTime: 1700 }] },
      { startTime: 1000, testResults: [file('unit/s.test.ts', 1000, 1000, [undefined])] }, { startTime: 1000, testResults: [] }]) {
      expect(costsOf(testDir, bad as never, 3000, took), JSON.stringify(bad)).toBeNull();
    }
  });

  it("gives each file a cost from vitest's own report of a run on one worker, a skipped file and slow hooks included", { timeout: 180_000 }, () => {
    const dir = tempDir('smdb-costs-');
    fs.writeFileSync(path.join(dir, 'quick.test.mjs'), "it('runs', () => {});\n");
    fs.writeFileSync(path.join(dir, 'skipped.test.mjs'), "it.skip('waits', () => {});\n");
    fs.writeFileSync(path.join(dir, 'slowHook.test.mjs'), "beforeAll(() => new Promise(resolve => setTimeout(resolve, 600)));\nit('runs', () => {});\n");
    fs.writeFileSync(path.join(dir, 'slowAfter.test.mjs'), "afterAll(() => new Promise(resolve => setTimeout(resolve, 1500)));\nit('runs', () => {});\n");
    const out = path.join(dir, 'report.json');
    const begun = performance.now();
    const run = spawnSync(process.execPath, [vitest, 'run', '--root', dir, '--globals', '--maxWorkers=1', '--reporter=json', `--outputFile=${out}`], { cwd: dir, encoding: 'utf8', timeout: 120_000 });
    const end = Date.now();
    const took = performance.now() - begun;
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
    const report = JSON.parse(fs.readFileSync(out, 'utf8'));
    // The wall-clock span vitest's report gives fits in the monotonic time of the process around it.
    const costs = costsOf(dir, report, end, took);
    expect(Object.keys(costs ?? {}).sort()).toEqual(['quick.test.mjs', 'skipped.test.mjs', 'slowAfter.test.mjs', 'slowHook.test.mjs']);
    // A beforeAll falls in the gap before the file's tests, an afterAll in the gap after them; both are the file's.
    expect(costs!['slowHook.test.mjs']).toBeGreaterThanOrEqual(600);
    expect(costs!['slowAfter.test.mjs']).toBeGreaterThanOrEqual(1500);
    const timed = (report.testResults as { name: string; startTime: number; endTime: number }[]).filter(f => !f.name.endsWith('skipped.test.mjs')).sort((x, y) => x.startTime - y.startTime);
    const gaps = [timed[0].startTime - report.startTime, ...timed.slice(1).map((f, i) => f.startTime - timed[i].endTime), end - timed[timed.length - 1].endTime];
    expect(costs!['skipped.test.mjs']).toBe(Math.max(...gaps));
  });

  it('is left with each file\'s cost, and read back without costs that cannot be read', () => {
    const out = tempDir('smdb-reachcosts-');
    fs.writeFileSync(path.join(out, 'dry-fast.json'), JSON.stringify({ startTime: 1000, testResults: [
      { name: at('unit/a.test.ts'), startTime: 1400, endTime: 1700, assertionResults: [{ duration: 300 }] }, { name: at('unit/b.test.ts'), startTime: 1900, endTime: 2500, assertionResults: [{ duration: 600 }] },
    ] }));
    writeReach(out, testDir, ['fast'], 3000, 5000);
    expect(readReach(out)).toEqual({ files: ['unit/a.test.ts', 'unit/b.test.ts'], unsure: [0, 1], reached: {}, costs: [900, 1300] });
    // A wall clock that stepped forward during the run leaves the reach with no costs.
    writeReach(out, testDir, ['fast'], 3000, 500);
    expect(readReach(out)).toEqual({ files: ['unit/a.test.ts', 'unit/b.test.ts'], unsure: [0, 1], reached: {} });
    fs.writeFileSync(path.join(out, 'dry-fast.json'), JSON.stringify({ startTime: 1000, testResults: [
      { name: at('unit/a.test.ts'), startTime: 1400, endTime: 2000, assertionResults: [{ duration: 600 }] }, { name: at('unit/b.test.ts'), startTime: 1900, endTime: 2500, assertionResults: [{ duration: 600 }] },
    ] }));
    writeReach(out, testDir, ['fast'], 3000, 5000);
    expect(readReach(out)).toEqual({ files: ['unit/a.test.ts', 'unit/b.test.ts'], unsure: [0, 1], reached: {} });
    for (const costs of [[700], [700, -1], [700, 'soon'], 'soon', [700, null]]) {
      fs.writeFileSync(path.join(out, REACH_FILE), JSON.stringify({ files: ['unit/a.test.ts', 'unit/b.test.ts'], unsure: [], reached: {}, costs }));
      expect(readReach(out), JSON.stringify(costs)).toEqual({ files: ['unit/a.test.ts', 'unit/b.test.ts'], unsure: [], reached: {} });
    }
  });

  it('bounds a run of named files in pass A by three times what they cost plus two minutes, and no other run', () => {
    const reach = { files: ['unit/a.test.ts', 'unit/b.test.ts', 'unit/c.test.ts'], unsure: [], reached: {}, costs: [700, 800, 1500] };
    expect(RUN_BOUND).toEqual({ factor: 3, startMs: 120_000 });
    expect(boundFor(reach, ['unit/a.test.ts', 'unit/c.test.ts'])).toBe(3 * 2200 + 120_000);
    expect(boundFor(reach, ['unit/b.test.ts'], { ...RUN_BOUND, startMs: 1000 })).toBe(3 * 800 + 1000);
    // Every related file, no file, a file with no cost, or no costs at all: Stryker's own limit applies.
    expect(boundFor(reach, null)).toBeNull();
    expect(boundFor(reach, [])).toBeNull();
    expect(boundFor(reach, ['unit/a.test.ts', 'unit/d.test.ts'])).toBeNull();
    expect(boundFor({ ...reach, costs: undefined }, ['unit/a.test.ts'])).toBeNull();
    expect(boundFor(null, ['unit/a.test.ts'])).toBeNull();
    // A shorter start only for a test's stand-in for vitest, whose gate has no result.
    expect(boundStartMs({ SMDB_MUTATION_BOUND_START_MS: '1000' })).toBe(120_000);
    expect(boundStartMs({ SMDB_MUTATION_VITEST: 'x.cjs', SMDB_MUTATION_BOUND_START_MS: '1000' })).toBe(1000);
    for (const ms of ['', 'soon', '-5']) expect(boundStartMs({ SMDB_MUTATION_VITEST: 'x.cjs', SMDB_MUTATION_BOUND_START_MS: ms }), ms).toBe(120_000);
    expect(boundStartMs({ SMDB_MUTATION_BOUND_START_MS: '1000' }, 60_000)).toBe(60_000);
  });

  it("bounds an a2 rerun of named files by Stryker's formula on what they cost in a2's run with no mutant, and no other", () => {
    const costs = { files: ['unit/a.test.ts', 'unit/b.test.ts', 'unit/c.test.ts'], costs: [700, 800, 1500] };
    expect(A2_BOUND).toEqual({ factor: PASSES.a2.timeoutFactor, startMs: PASSES.a2.timeoutMS });
    expect(A2_BOUND).toEqual({ factor: 4, startMs: 60_000 });
    expect(boundFor(costs, ['unit/a.test.ts', 'unit/c.test.ts'], A2_BOUND)).toBe(4 * 2200 + 60_000);
    expect(boundFor(costs, ['unit/b.test.ts'], A2_BOUND)).toBe(4 * 800 + 60_000);
    // Every file of that run (in any order), none, a file with no cost, or no costs: Stryker's own budget applies.
    expect(boundFor(costs, ['unit/c.test.ts', 'unit/a.test.ts', 'unit/b.test.ts'], A2_BOUND)).toBeNull();
    expect(boundFor(costs, null, A2_BOUND)).toBeNull();
    expect(boundFor(costs, [], A2_BOUND)).toBeNull();
    expect(boundFor(costs, ['unit/a.test.ts', 'unit/d.test.ts'], A2_BOUND)).toBeNull();
    expect(boundFor({ files: costs.files }, ['unit/a.test.ts'], A2_BOUND)).toBeNull();
    expect(boundFor(null, ['unit/a.test.ts'], A2_BOUND)).toBeNull();
  });

  it("arms no bound past Node's timer limit, which would fire at once", () => {
    expect(TIMER_LIMIT_MS).toBe(2 ** 31 - 1);
    const at = (cost: number) => ({ files: ['unit/a.test.ts', 'unit/b.test.ts'], costs: [cost, 1] });
    // 4 x cost + 60 s: the largest cost that keeps the bound within the limit, and the smallest past it.
    const largest = Math.floor((TIMER_LIMIT_MS - 60_000) / 4);
    expect(boundFor(at(largest), ['unit/a.test.ts'], A2_BOUND)).toBe(4 * largest + 60_000);
    expect(boundFor(at(largest + 1), ['unit/a.test.ts'], A2_BOUND)).toBeNull();
    expect(boundFor(at(Number.MAX_VALUE), ['unit/a.test.ts'], A2_BOUND)).toBeNull();
    expect(boundFor(at(TIMER_LIMIT_MS), ['unit/a.test.ts'])).toBeNull();
  });

  it("is left by a2's run with no mutant, in a2's dir, and read back only when whole", () => {
    const out = tempDir('smdb-a2costs-');
    fs.writeFileSync(path.join(out, 'dry-fast.json'), JSON.stringify({ startTime: 1000, testResults: [
      { name: at('unit/a.test.ts'), startTime: 1400, endTime: 1700, assertionResults: [{ duration: 300 }] }, { name: at('unit/b.test.ts'), startTime: 1900, endTime: 2500, assertionResults: [{ duration: 600 }] },
    ] }));
    writeCosts(out, testDir, 3000, 5000);
    expect(readCosts(out)).toEqual({ files: ['unit/a.test.ts', 'unit/b.test.ts'], costs: [900, 1300] });
    // A clock that stepped, or a report that cannot be read, leaves none, and takes away what was there.
    writeCosts(out, testDir, 3000, 500);
    expect(fs.existsSync(path.join(out, COSTS_FILE))).toBe(false);
    writeCosts(out, testDir, 3000, 5000);
    fs.writeFileSync(path.join(out, 'dry-fast.json'), '{');
    writeCosts(out, testDir, 3000, 5000);
    expect(readCosts(out)).toBeNull();
    for (const bad of ['{', 'null', '{"files":["a"],"costs":[]}', '{"files":["a"],"costs":[-1]}', '{"files":[1],"costs":[1]}', '{"files":["a"],"costs":["1"]}']) {
      fs.writeFileSync(path.join(out, COSTS_FILE), bad);
      expect(readCosts(out), bad).toBeNull();
    }
  });

  it('is left only from a fast report that lists a file, and read back only when whole', () => {
    const out = tempDir('smdb-reach-');
    writeReach(out, testDir, ['fast'], 3000, 5000);
    expect(fs.existsSync(path.join(out, REACH_FILE))).toBe(false);
    fs.writeFileSync(path.join(out, 'dry-fast.json'), JSON.stringify({ testResults: [] }));
    writeReach(out, testDir, ['fast'], 3000, 5000);
    expect(readReach(out)).toBeNull();
    fs.writeFileSync(path.join(out, 'dry-fast.json'), JSON.stringify({ testResults: [{ name: at('unit/a.test.ts') }] }));
    writeReach(out, testDir, ['fast'], 3000, 5000);
    expect(readReach(out)).toEqual({ files: ['unit/a.test.ts'], unsure: [0], reached: {} });
    for (const bad of ['{', '{"files":["a"],"unsure":[1],"reached":{}}', '{"files":["a"],"unsure":[],"reached":{"1":[0.5]}}', '{"files":[1],"unsure":[],"reached":{}}']) {
      fs.writeFileSync(path.join(out, REACH_FILE), bad);
      expect(readReach(out), bad).toBeNull();
    }
  });

  it("is left, for pass B, from both tiers' reports in the order they ran, and only when each tier left one", () => {
    const tiers = ['integration', 'child'];
    const report = (out: string, tier: string, names: string[]) => fs.writeFileSync(path.join(out, `dry-${tier}.json`), JSON.stringify({ testResults: names.map(name => ({ name: at(name) })) }));
    const out = tempDir('smdb-reachb-');
    report(out, 'child', ['child/c.test.ts']);
    writeReach(out, testDir, tiers);
    expect(fs.existsSync(path.join(out, REACH_FILE))).toBe(false);
    fs.writeFileSync(path.join(out, 'dry-integration.json'), JSON.stringify({}));
    writeReach(out, testDir, tiers);
    expect(fs.existsSync(path.join(out, REACH_FILE))).toBe(false);
    // An integration tier no test file is related to lists none: the child tier's files are the reach.
    report(out, 'integration', []);
    writeReach(out, testDir, tiers);
    expect(readReach(out)).toEqual({ files: ['child/c.test.ts'], unsure: [0], reached: {} });
    report(out, 'integration', ['integration/b.test.ts', 'integration/a.test.ts']);
    writeReach(out, testDir, tiers);
    expect(readReach(out)?.files).toEqual(['integration/b.test.ts', 'integration/a.test.ts', 'child/c.test.ts']);
    fs.rmSync(path.join(out, 'dry-child.json'));
    fs.rmSync(path.join(out, REACH_FILE));
    writeReach(out, testDir, tiers);
    expect(fs.existsSync(path.join(out, REACH_FILE))).toBe(false);
  });
});

describe('a pass A mutant run', () => {
  interface Call { args: string[]; coverage: string | null; include: string[] | null }

  // A stand-in for vitest that records its calls and, given a coverage dir, leaves a report of two test files and a
  // record dir of the first.
  function fake() {
    const dir = tempDir('smdb-select-');
    const calls = path.join(dir, 'calls.jsonl');
    const script = path.join(dir, 'vitest.cjs');
    const first = path.join(root, 'test', 'unit', 'a.test.ts');
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
      `  const dir = path.join(coverage, ${JSON.stringify(`${fileKey(first)}-1`)});`,
      '  fs.mkdirSync(dir, { recursive: true });',
      `  fs.writeFileSync(path.join(dir, '1-a.jsonl'), JSON.stringify({ role: 'file', file: ${JSON.stringify(first)}, ranOther: false, late: false, pid: 1 }) + '\\n' + JSON.stringify({ id: '3' }) + '\\n');`,
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

});

describe('a pass B mutant run', () => {
  interface Call { project: string; args: string[]; coverage: string | null; include: string[] | null; mutant: string | null; scale: string | null }
  // Per tier, the files its run lists in order, each with the ids its own process records and the ids a Node process
  // it starts records (null: the file leaves no record dir).
  type Plan = Record<'integration' | 'child', { file: string; ids: string[] | null; childIds?: string[] }[]>;
  const PLAN: Plan = {
    integration: [{ file: 'integration/z.test.ts', ids: ['7'] }, { file: 'integration/a.test.ts', ids: ['3', '7'] }],
    child: [{ file: 'child/c1.test.ts', ids: [], childIds: ['3', '5'] }, { file: 'child/c2.test.ts', ids: null }],
  };
  const FILES = ['integration/z.test.ts', 'integration/a.test.ts', 'child/c1.test.ts', 'child/c2.test.ts'];

  // A stand-in for vitest that records its calls, fails the tiers or files in `fail`, and, given a coverage dir,
  // leaves the tier's report and the records `plan` names, as reachRecorder.cjs writes them.
  function fake(plan: Plan = PLAN, fail: string[] = []) {
    const dir = tempDir('smdb-selectb-');
    const calls = path.join(dir, 'calls.jsonl');
    const script = path.join(dir, 'vitest.cjs');
    fs.writeFileSync(script, [
      "const fs = require('fs');",
      "const path = require('path');",
      "const { createHash } = require('crypto');",
      'const args = process.argv.slice(2);',
      "const project = args[args.indexOf('--project') + 1];",
      'const coverage = process.env.SMDB_MUTATION_COVERAGE || null;',
      "const include = process.env.SMDB_MUTATION_INCLUDE ? JSON.parse(fs.readFileSync(process.env.SMDB_MUTATION_INCLUDE, 'utf8')) : null;",
      `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ project, args, coverage, include, mutant: process.env.__STRYKER_ACTIVE_MUTANT__ ?? null, scale: process.env.SMDB_TEST_TIME_SCALE ?? null }) + '\\n');`,
      `const plan = ${JSON.stringify(plan)}[project] || [];`,
      'if (coverage) {',
      '  const testDir = process.cwd();',
      "  const report = args.find(arg => arg.startsWith('--outputFile=')).slice('--outputFile='.length);",
      '  fs.writeFileSync(report, JSON.stringify({ testResults: plan.map(entry => ({ name: path.join(testDir, entry.file) })) }));',
      '  plan.forEach((entry, n) => {',
      '    if (!entry.ids) return;',
      '    const file = path.join(testDir, entry.file);',
      "    const dir = path.join(coverage, `${createHash('sha256').update(path.resolve(file)).digest('hex').slice(0, 32)}-${n + 1}`);",
      '    fs.mkdirSync(dir, { recursive: true });',
      "    const own = [{ role: 'file', file, ranOther: false, late: false, pid: n + 1 }, ...entry.ids.map(id => ({ id })), ...(entry.childIds ? [{ start: 't1', kind: 'node' }] : [])];",
      "    fs.writeFileSync(path.join(dir, `${n + 1}-a.jsonl`), own.map(line => JSON.stringify(line) + '\\n').join(''));",
      "    if (entry.childIds) fs.writeFileSync(path.join(dir, '99-b.jsonl'), [{ role: 'child', token: 't1', ranOther: false, late: false, pid: 99 }, ...entry.childIds.map(id => ({ id }))].map(line => JSON.stringify(line) + '\\n').join(''));",
      '  });',
      '}',
      `const fail = ${JSON.stringify(fail)};`,
      'process.exit(fail.includes(project) || (include ?? []).some(file => fail.includes(file)) ? 1 : 0);',
      '',
    ].join('\n'));
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    const read = (): Call[] => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Call) : []);
    return { script, out, read };
  }

  const runner = (stand: { script: string; out: string }, mutant: string, { confirm = '', only = [] as string[], pass = 'b', sets = '' } = {}) => spawnSync(process.execPath, [path.join(root, 'test', 'mutation', 'runner.mjs')], {
    encoding: 'utf8',
    env: {
      ...process.env, SMDB_MUTATION_VITEST: stand.script, SMDB_MUTATION_PASS: pass, SMDB_MUTATION_FILES: '["test/mutation/control.mjs"]', SMDB_MUTATION_OUT: stand.out,
      SMDB_MUTATION_CONFIRM: confirm, SMDB_MUTATION_ONLY: JSON.stringify(only), SMDB_MUTATION_RUN: '', SMDB_MUTATION_SETS: sets, __STRYKER_ACTIVE_MUTANT__: mutant,
      SMDB_MUTATION_COVERAGE: path.join(stand.out, 'shell'),
    },
  });
  const took = (out: string, id: string) => JSON.parse(fs.readFileSync(path.join(out, `${id}-reach.json`), 'utf8')) as { files: string[] | 'related' };

  it("records, in its run with no mutant, both tiers' reach in one dir, and builds the reach from both reports and every record", () => {
    const stand = fake();
    expect(runner(stand, 'none').status).toBe(0);
    const coverage = path.join(stand.out, COVERAGE_DIR);
    expect(stand.read().map(call => [call.project, call.args[0], call.coverage, call.include])).toEqual([['integration', 'related', coverage, null], ['child', 'run', coverage, null]]);
    // c1's own process reached nothing; the Node process it started reached 3 and 5. c2 left no record.
    expect(readReach(stand.out)).toEqual({ files: FILES, unsure: [3], reached: { 3: [1, 2], 5: [2], 7: [0, 1] } });
    expect(fs.existsSync(path.join(stand.out, 'dry-ms.txt'))).toBe(true);
  });

  it('leaves no reach when its run with no mutant fails, or a tier left no report', () => {
    const failed = fake(PLAN, ['integration']);
    expect(runner(failed, 'none').status).toBe(1);
    expect(failed.read().map(call => call.project)).toEqual(['integration']);
    expect(fs.existsSync(path.join(failed.out, REACH_FILE))).toBe(false);
    const childFailed = fake(PLAN, ['child']);
    expect(runner(childFailed, 'none').status).toBe(1);
    expect(fs.existsSync(path.join(childFailed.out, REACH_FILE))).toBe(false);
    // A reach left from before the run is gone with it.
    const stale = fake(PLAN, ['integration']);
    fs.writeFileSync(path.join(stale.out, REACH_FILE), JSON.stringify({ files: ['child/c1.test.ts'], unsure: [], reached: {} }));
    expect(runner(stale, 'none').status).toBe(1);
    expect(fs.existsSync(path.join(stale.out, REACH_FILE))).toBe(false);
  });

  it("takes, tier by tier in the run with no mutant's order, exactly the files that reached its mutant or are unsure", () => {
    const stand = fake();
    expect(runner(stand, 'none').status).toBe(0);
    const runs = (id: string) => {
      const before = stand.read().length;
      expect(runner(stand, id).status, id).toBe(0);
      return stand.read().slice(before).map(call => [call.project, call.args[0], call.include, call.coverage, call.mutant, call.scale]);
    };
    expect(runs('7')).toEqual([['integration', 'run', ['integration/z.test.ts', 'integration/a.test.ts'], null, '7', '1'], ['child', 'run', ['child/c2.test.ts'], null, '7', '1']]);
    expect(took(stand.out, '7')).toEqual({ files: ['integration/z.test.ts', 'integration/a.test.ts', 'child/c2.test.ts'] });
    expect(runs('3')).toEqual([['integration', 'run', ['integration/a.test.ts'], null, '3', '1'], ['child', 'run', ['child/c1.test.ts', 'child/c2.test.ts'], null, '3', '1']]);
    expect(took(stand.out, '3')).toEqual({ files: ['integration/a.test.ts', 'child/c1.test.ts', 'child/c2.test.ts'] });
    // Reached only in children: no integration run.
    expect(runs('5')).toEqual([['child', 'run', ['child/c1.test.ts', 'child/c2.test.ts'], null, '5', '1']]);
    // Reached by none: the unsure file alone.
    expect(runs('9')).toEqual([['child', 'run', ['child/c2.test.ts'], null, '9', '1']]);
    for (const call of stand.read().slice(2)) expect(call.args).toEqual(expect.arrayContaining(['--bail=1', '--no-cache', '--maxWorkers=1']));

    // A failure in the integration tier stops the run before the child tier.
    const failing = fake(PLAN, ['integration/a.test.ts']);
    expect(runner(failing, 'none').status).toBe(0);
    expect(runner(failing, '3').status).toBe(1);
    expect(failing.read().slice(2).map(call => call.project)).toEqual(['integration']);
  });

  it('takes every related integration file and the whole child tier when there is no reach, or it cannot be read, is not of these tiers, or every file reached the mutant', () => {
    const reaches: [string, string | null][] = [
      ['none', null],
      ['unreadable', '{'],
      ['a fast file', JSON.stringify({ files: ['unit/a.test.ts', 'child/c1.test.ts'], unsure: [], reached: {} })],
      ['every file', JSON.stringify({ files: ['integration/a.test.ts', 'child/c1.test.ts'], unsure: [1], reached: { 4: [0] } })],
    ];
    for (const [what, reach] of reaches) {
      const stand = fake();
      if (reach !== null) fs.writeFileSync(path.join(stand.out, REACH_FILE), reach);
      expect(runner(stand, '4').status, what).toBe(0);
      expect(stand.read().map(call => [call.project, call.args[0], call.include, call.coverage]), what).toEqual([['integration', 'related', null, null], ['child', 'run', null, null]]);
      expect(took(stand.out, '4'), what).toEqual({ files: 'related' });
    }
  });

  it('takes no file, and passes, when no file reached its mutant and none is unsure', () => {
    const stand = fake();
    fs.writeFileSync(path.join(stand.out, REACH_FILE), JSON.stringify({ files: ['integration/a.test.ts', 'child/c1.test.ts'], unsure: [], reached: { 3: [0] } }));
    const run = runner(stand, '4');
    expect(run.status).toBe(0);
    expect(stand.read()).toEqual([]);
    expect(took(stand.out, '4')).toEqual({ files: [] });
  });

  it('leaves b2 and the run with no mutant after it as they were: the files they name, no record, no reach', () => {
    const stand = fake();
    fs.writeFileSync(path.join(stand.out, REACH_FILE), JSON.stringify({ files: ['integration/a.test.ts', 'child/c1.test.ts'], unsure: [], reached: {} }));
    const reach = fs.readFileSync(path.join(stand.out, REACH_FILE), 'utf8');
    expect(runner(stand, '4', { confirm: '1', only: ['child/c9.test.ts'] }).status).toBe(0);
    expect(runner(stand, 'none', { confirm: '1', only: ['child/c9.test.ts'] }).status).toBe(0);
    expect(stand.read().map(call => [call.project, call.args[0], call.include, call.coverage, call.scale])).toEqual([['child', 'run', ['child/c9.test.ts'], null, '4'], ['child', 'run', ['child/c9.test.ts'], null, '4']]);
    expect(fs.existsSync(path.join(stand.out, '4-reach.json'))).toBe(false);
    expect(fs.readFileSync(path.join(stand.out, REACH_FILE), 'utf8')).toBe(reach);
    expect(fs.existsSync(path.join(stand.out, COVERAGE_DIR))).toBe(false);
  });

  it("gives the coverage dir to the runs with no mutant of pass A and pass B, both of B's tiers, and to no mutant run, rerun or check", () => {
    const stand = fake();
    const coverage = path.join(stand.out, COVERAGE_DIR);
    const given = (id: string, options: Parameters<typeof runner>[2]) => {
      const before = stand.read().length;
      runner(stand, id, options);
      return stand.read().slice(before).map(call => call.coverage);
    };
    expect(given('none', {})).toEqual([coverage, coverage]);
    expect(given('none', { pass: 'a' })).toEqual([coverage]);
    expect(given('3', {})).toEqual([null, null]);
    expect(given('3', { pass: 'a' })).toEqual([null]);
    expect(given('none', { confirm: '1', pass: 'a' })).toEqual([null]);
    expect(given('3', { confirm: '1', pass: 'a' })).toEqual([null]);
    expect(given('none', { confirm: '1' })).toEqual([null, null]);
    expect(given('3', { confirm: '1' })).toEqual([null, null]);
    expect(given('none', { confirm: '1', only: ['child/c9.test.ts'] })).toEqual([null]);
    expect(given('3', { confirm: '1', only: ['integration/i.test.ts', 'child/c9.test.ts'] })).toEqual([null, null]);
    expect(given('none', { pass: 'a', sets: JSON.stringify([{ files: ['unit/a.test.ts'], ms: 60_000 }]) })).toEqual([null]);
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

  it('says of a survivor no test of pass B reached that none did, and counts them apart', () => {
    const run = judge({
      stamp: 't', scope: 's', emptyScope: false, skipped: [], noMutant: [], unmatched: [], report: 'r', mutants: [
        mutant(1, { a: pass('Survived'), b: pass('Survived', { unreached: true }) }),
        mutant(2, { a: pass('Survived', { unreached: true }), b: pass('Survived', { unreached: true }) }),
        mutant(3, { a: pass('Survived'), b: pass('Survived') }),
        mutant(4, { a: pass('Survived', { unreached: true }), b: pass('Survived') }),
        // Killed in pass B and again alone: no survivor, whatever pass B's reach.
        mutant(5, { a: pass('Survived'), b: pass('Killed', { killedBy: 'child/x.test.ts > x', unreached: true }), b2: pass('Killed', { killedBy: 'child/x.test.ts > x' }) }),
      ],
    });
    const text = run.lines.join('\n');
    expect(run.verdict).toBe('FAIL');
    expect(text).toMatch(/^ {2}src\/a\.ts:1:3 EqualityOperator: `a > 0` -> `a >= 0` \(no test of pass B reached it\)$/m);
    expect(text).toMatch(/^ {2}src\/a\.ts:2:3 EqualityOperator: `a > 0` -> `a >= 0` \(no fast test reached it; no test of pass B reached it\)$/m);
    expect(text).toMatch(/^ {2}src\/a\.ts:3:3 EqualityOperator: `a > 0` -> `a >= 0`$/m);
    expect(text).toMatch(/^ {2}src\/a\.ts:4:3 EqualityOperator: `a > 0` -> `a >= 0` \(no fast test reached it\)$/m);
    expect(text).toMatch(/^ {2}survivors no fast test reached \(.*\): 2$/m);
    expect(text).toMatch(/^ {2}survivors no test of pass B reached \(none ran their code in pass B's run with no mutant, so pass B ran no test on them\): 2$/m);
    expect(text).not.toMatch(/src\/a\.ts:5:3/);
    const none = judge({ stamp: 't', scope: 's', emptyScope: false, skipped: [], noMutant: [], unmatched: [], report: 'r', mutants: [mutant(3, { a: pass('Survived'), b: pass('Survived') })] });
    expect(none.lines.join('\n')).not.toMatch(/no test of pass B reached/);
  });
});
