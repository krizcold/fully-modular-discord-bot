import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { disableTypeChecks, Instrumenter } from '@stryker-mutator/instrumenter';
import { describe, expect, it, onTestFinished } from 'vitest';
import { keyOf } from '../mutation/keys.mjs';
import { describeMutate, finishedAndPassed, gitEnv, LIMITS, parseArgs, planOf, proveFile, refuseOut, relatedOf, stateOf, survivors, TOOL_ROOT } from '../mutation/survivors.mjs';

// mutation/survivors.mjs: pass A's survivors so far, from a run's report dir and
// sandbox, with the id of each mutant proven against the sandbox's text.

const tool = path.join(TOOL_ROOT, 'test', 'mutation', 'survivors.mjs');

function tempDir(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const SANDBOX_TEST = '/x/.stryker-tmp/sandbox-Ab1/test/';

interface Test { status: string }
function report(files: Record<string, string[]>, extra: Record<string, unknown> = {}) {
  const testResults = Object.entries(files).map(([file, statuses]) => ({
    name: `${SANDBOX_TEST}${file}`,
    status: statuses.includes('failed') ? 'failed' : 'passed',
    message: '',
    assertionResults: statuses.map((status): Test => ({ status })),
  }));
  const tests = testResults.flatMap(file => file.assertionResults);
  return {
    numTotalTests: tests.length,
    numPassedTests: tests.filter(t => t.status === 'passed').length,
    numFailedTests: tests.filter(t => t.status === 'failed').length,
    numFailedTestSuites: 0,
    success: tests.every(t => t.status !== 'failed') && testResults.length > 0,
    testResults,
    ...extra,
  };
}

function reportDir(runs: Record<string, { reach?: unknown; fast?: unknown; raw?: string; log?: boolean }>, dry?: string[], dryFast?: unknown) {
  const dir = tempDir('smdb-survivors-a-');
  if (dryFast !== undefined) fs.writeFileSync(path.join(dir, 'dry-fast.json'), JSON.stringify(dryFast));
  for (const [id, run] of Object.entries(runs)) {
    if (run.reach !== undefined) fs.writeFileSync(path.join(dir, `${id}-reach.json`), JSON.stringify({ files: run.reach }));
    if (run.fast !== undefined) fs.writeFileSync(path.join(dir, `${id}-fast.json`), JSON.stringify(run.fast));
    if (run.raw !== undefined) fs.writeFileSync(path.join(dir, `${id}-fast.json`), run.raw);
    if (run.log) fs.writeFileSync(path.join(dir, `${id}-fast.log`), '');
  }
  if (dry) fs.writeFileSync(path.join(dir, 'dry-reach.json'), JSON.stringify({ files: dry, unsure: [], reached: {} }));
  return dir;
}

const present = (dir: string) => new Set(fs.readdirSync(dir).map(name => /^(\d+)-/.exec(name)?.[1]).filter((id): id is string => id !== undefined));
const stateIn = (dir: string, id: string) => stateOf(dir, id, present(dir), () => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'dry-reach.json'), 'utf8')).files; } catch { return null; }
});

describe('the state of a mutant from its pass A files', () => {
  const two = ['unit/a.test.ts', 'unit/b.test.ts'];
  it('passed: a finished report in which every test of exactly the reached files passed', () => {
    const dir = reportDir({ 1: { reach: two, fast: report({ 'unit/a.test.ts': ['passed', 'skipped'], 'unit/b.test.ts': ['passed'] }) } });
    expect(stateIn(dir, '1')).toEqual({ state: 'passed', unreached: false });
  });

  it('passed and unreached: a reach that names no file, and no report', () => {
    const dir = reportDir({ 2: { reach: [] } });
    expect(stateIn(dir, '2')).toEqual({ state: 'passed', unreached: true });
  });

  it('unknown: a reach that names no file beside an <id>-fast.json, whole or not', () => {
    const dir = reportDir({ 2: { reach: [], fast: report1() }, 3: { reach: [], raw: '' } });
    expect(stateIn(dir, '2')).toEqual({ state: 'unknown', unreached: false });
    expect(stateIn(dir, '3')).toEqual({ state: 'unknown', unreached: false });
  });

  it("passed through 'related': the files the run with no mutant ran", () => {
    const dir = reportDir({ 3: { reach: 'related', fast: report({ 'unit/a.test.ts': ['passed'], 'unit/b.test.ts': ['passed'] }) } }, two);
    expect(stateIn(dir, '3').state).toBe('passed');
    const short = reportDir({ 3: { reach: 'related', fast: report({ 'unit/a.test.ts': ['passed'] }) } }, two);
    expect(stateIn(short, '3').state).toBe('unknown');
  });

  it('failed: a parsed report that holds a failed test or a failed suite', () => {
    const dir = reportDir({
      4: { reach: two, fast: report({ 'unit/a.test.ts': ['passed'], 'unit/b.test.ts': ['failed'] }) },
      5: { reach: two, fast: report({ 'unit/a.test.ts': ['passed'], 'unit/b.test.ts': ['passed'] }, { success: false, numFailedTestSuites: 1 }) },
    });
    expect(stateIn(dir, '4').state).toBe('failed');
    expect(stateIn(dir, '5').state).toBe('failed');
  });

  it('unknown: a half-written report, a reach alone (a run in flight), a report missing a reached file, no test run', () => {
    const whole = JSON.stringify(report({ 'unit/a.test.ts': ['passed'], 'unit/b.test.ts': ['passed'] }));
    const dir = reportDir({
      6: { reach: two, raw: whole.slice(0, whole.length - 3) },
      7: { reach: two, log: true },
      8: { reach: two, fast: report({ 'unit/a.test.ts': ['passed'] }) },
      9: { reach: ['unit/a.test.ts'], fast: report({ 'unit/a.test.ts': [] }, { success: true }) },
      10: { log: true },
      11: { reach: ['unit/a.test.ts'], fast: report({ 'unit/a.test.ts': ['passed', 'passed'] }, { testResults: [...report({ 'unit/a.test.ts': ['passed'] }).testResults, ...report({ 'unit/a.test.ts': ['passed'] }).testResults] }) },
    });
    for (const id of ['6', '7', '8', '9', '10', '11']) expect([id, stateIn(dir, id).state]).toEqual([id, 'unknown']);
  });

  it('unknown: success true while a test was still running, as vitest writes it when a worker dies (run A, 13 such runs)', () => {
    const dir = reportDir({ 12: { reach: two, fast: report({ 'unit/a.test.ts': ['passed'], 'unit/b.test.ts': ['passed', 'pending'] }, { success: true }) } });
    expect(stateIn(dir, '12').state).toBe('unknown');
  });

  it("'related' means the files of the run with no mutant: its reach, or else its report", () => {
    const dryFast = report({ 'unit/a.test.ts': ['passed'], 'unit/c.test.ts': ['passed'] });
    expect(relatedOf(reportDir({}, two))).toEqual(two);
    expect(relatedOf(reportDir({}, two, dryFast))).toEqual(two);
    expect(relatedOf(reportDir({}, undefined, dryFast))).toEqual(['unit/a.test.ts', 'unit/c.test.ts']);
    expect(relatedOf(reportDir({}, [], dryFast))).toEqual(['unit/a.test.ts', 'unit/c.test.ts']);
    expect(relatedOf(reportDir({}))).toBeNull();
    expect(relatedOf(reportDir({}, undefined, { ...dryFast, testResults: [{ ...dryFast.testResults[0], name: '/elsewhere/test/unit/a.test.ts' }] }))).toBeNull();
  });

  it('no run: no file for the id', () => {
    const dir = reportDir({ 1: { reach: [] } });
    expect(stateIn(dir, '13')).toEqual({ state: 'no run', unreached: false });
  });

  it("finished and passed holds each rule on its own", () => {
    const good = report({ 'unit/a.test.ts': ['passed'] });
    const files = ['unit/a.test.ts'];
    expect(finishedAndPassed(good, files)).toBe(true);
    expect(finishedAndPassed({ ...good, success: false }, files)).toBe(false);
    expect(finishedAndPassed({ ...good, numFailedTests: 1 }, files)).toBe(false);
    expect(finishedAndPassed({ ...good, numFailedTestSuites: 1 }, files)).toBe(false);
    expect(finishedAndPassed({ ...good, testResults: [{ ...good.testResults[0], status: 'failed' }] }, files)).toBe(false);
    expect(finishedAndPassed(report({ 'unit/a.test.ts': ['skipped'] }), files)).toBe(false);
    expect(finishedAndPassed(good, ['unit/a.test.ts', 'unit/b.test.ts'])).toBe(false);
    expect(finishedAndPassed({ ...good, testResults: [good.testResults[0], good.testResults[0]] }, ['unit/a.test.ts', 'unit/b.test.ts'])).toBe(false);
    expect(finishedAndPassed({ ...good, testResults: [{ ...good.testResults[0], name: '/elsewhere/test/unit/a.test.ts' }] }, files)).toBe(false);
  });

  // vitest 5.0.3: its JSON reporter does not read the unhandled errors, and with
  // only that reporter nothing prints them, while vitest exits 1 (checked on a
  // test that leaves a rejection behind, 2026-11-11). The files cannot tell.
  it('an unhandled error with every test passed leaves the files a passing run leaves: listed passed, and the summary says so', () => {
    const dir = reportDir({ 14: { reach: ['unit/a.test.ts'], fast: report({ 'unit/a.test.ts': ['passed'] }), log: true } });
    expect(stateIn(dir, '14').state).toBe('passed');
    expect(LIMITS.join(' ')).toMatch(/unhandled error/);
    expect(LIMITS.join(' ')).toMatch(/timeout Stryker called after the report was complete/);
  });
});

const quiet = () => {};
const logger = { debug: quiet, info: quiet, warn: quiet, error: quiet, trace: quiet, fatal: quiet, isDebugEnabled: () => false, isTraceEnabled: () => false, isInfoEnabled: () => false, isWarnEnabled: () => false, isErrorEnabled: () => false, isFatalEnabled: () => false };
interface Made { id: string; fileName: string; mutatorName: string; replacement: string; location: { start: { line: number; column: number }; end: { line: number; column: number } } }

// What Stryker 10.0.0 writes into a sandbox: every file instrumented in one
// call (ids run on from file to file), then each through disableTypeChecks.
async function strykerSandbox(tree: string, files: [string, unknown][]) {
  const instrumenter = new Instrumenter(logger as never);
  const result = await instrumenter.instrument(
    files.map(([file, mutate]) => ({ name: path.join(tree, file), content: fs.readFileSync(path.join(tree, file), 'utf8'), mutate }) as never),
    { ignorers: [], plugins: null, excludedMutations: [] } as never,
  );
  const sandbox = path.join(tempDir('smdb-survivors-checkout-'), '.stryker-tmp', 'sandbox-Ab1');
  for (const file of result.files) {
    const { content } = await disableTypeChecks(file, { plugins: null });
    const to = path.join(sandbox, path.relative(tree, file.name));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, content);
  }
  const fromOne = (p: { line: number; column: number }) => ({ line: p.line + 1, column: p.column + 1 });
  const keys = new Map((result.mutants as unknown as Made[]).map(m => [m.id, keyOf(path.relative(tree, m.fileName).split(path.sep).join('/'), m.mutatorName, m.replacement ?? '', { start: fromOne(m.location.start), end: fromOne(m.location.end) })]));
  return { sandbox, keys };
}

const BEFORE = 'export const first = (n: number) => (n > 2 ? n * 3 : -n);\n';
const A_BASE = [
  'export function f(a: number, b: number) {',
  '  const y = [',
  '    a + b,',
  '    a * b,',
  '  ];',
  "  return y[0] > 1 ? 'big' : 'small';",
  '}',
  '',
].join('\n');
const A_NOW = A_BASE.replace('    a + b,', '    a - b,');

function treeWithChange() {
  const tree = tempDir('smdb-survivors-tree-');
  const git = (...args: string[]) => execFileSync('git', ['-C', tree, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  fs.mkdirSync(path.join(tree, 'src'));
  fs.writeFileSync(path.join(tree, 'src', 'a.ts'), A_BASE);
  fs.writeFileSync(path.join(tree, 'src', 'before.ts'), BEFORE);
  git('init', '-q');
  git('config', 'core.safecrlf', 'false');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  fs.writeFileSync(path.join(tree, 'src', 'a.ts'), A_NOW);
  return tree;
}

function listAll(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .map(entry => `${path.relative(dir, path.join(entry.parentPath, entry.name))}|${entry.isFile() ? fs.statSync(path.join(entry.parentPath, entry.name)).mtimeMs : 'dir'}`)
    .sort();
}

describe('the id of each mutant, proven against the sandbox', () => {
  it('maps every id to its mutant when ids run on from another file, takes gating from the plan, and writes only into --out', async () => {
    const tree = treeWithChange();
    const { targets, patterns } = planOf({ tree, base: 'HEAD', mutate: [] });
    expect(targets.map(t => [t.file, t.gating])).toEqual([['src/a.ts', [3]]]);
    const { sandbox, keys } = await strykerSandbox(tree, [['src/before.ts', true], ...describeMutate(patterns)]);
    const aIds = [...keys].filter(([, key]) => key.startsWith('src/a.ts|')).map(([id]) => Number(id));
    expect(Math.min(...aIds)).toBeGreaterThan(0);
    const first = String(Math.min(...aIds));
    const last = String(Math.max(...aIds));
    const middle = String(aIds.sort((x, y) => x - y)[1]);
    const dryFiles = { 'unit/a.test.ts': ['passed'], 'unit/c.test.ts': ['passed'] };
    const runs = reportDir({
      [first]: { reach: [] }, [last]: { reach: ['unit/a.test.ts'], fast: report1() }, [middle]: { reach: 'related', fast: report(dryFiles) }, 0: { reach: [] },
    }, undefined, report(dryFiles));
    const out = path.join(tempDir('smdb-survivors-out-'), 'out');
    const before = [tree, sandbox, runs].map(listAll);
    const { code, summary } = await survivors({ report: runs, sandbox, out, tree, base: 'HEAD', mutate: [] });
    expect(code).toBe(1);
    expect([tree, sandbox, runs].map(listAll)).toEqual(before);
    expect(fs.readdirSync(out).sort()).toEqual(['mutants.json', 'summary.txt', 'survivors-context.json', 'survivors.json']);
    const listed = JSON.parse(fs.readFileSync(path.join(out, 'mutants.json'), 'utf8')) as { id: string; key: string; gating: boolean; location: { start: { line: number }; end: { line: number } }; state: string; original: string }[];
    expect(listed.length).toBe(aIds.length);
    for (const m of listed) expect([m.id, m.key]).toEqual([m.id, keys.get(m.id)]);
    for (const m of listed) expect([m.key, m.gating]).toEqual([m.key, m.location.start.line <= 3 && 3 <= m.location.end.line]);
    expect(listed.some(m => m.gating)).toBe(true);
    expect(listed.some(m => !m.gating)).toBe(true);
    const passed = listed.filter(m => m.state === 'passed');
    expect(passed.map(m => m.id).sort()).toEqual([first, middle, last].sort());
    const survivorsOut = JSON.parse(fs.readFileSync(path.join(out, 'survivors.json'), 'utf8'));
    const contextOut = JSON.parse(fs.readFileSync(path.join(out, 'survivors-context.json'), 'utf8'));
    expect([...survivorsOut, ...contextOut].sort()).toEqual(passed.map(m => m.key).sort());
    expect(survivorsOut).toEqual(passed.filter(m => m.gating).map(m => m.key));
    expect(listed.find(m => m.key.includes('|ArithmeticOperator|a + b|'))?.original).toBe('a - b');
    expect(summary).toMatch(/Ids in the report dir that match no mapped mutant: 1; the plan left out a file the run mutated, so survivors may be missing\n/);
    expect(fs.readFileSync(path.join(out, 'summary.txt'), 'utf8')).toBe(summary);
    const matched = reportDir({ [first]: { reach: [] } }, undefined, report(dryFiles));
    const clean = await survivors({ report: matched, sandbox, out: path.join(tempDir('smdb-survivors-out-'), 'out'), tree, base: 'HEAD', mutate: [] });
    expect(clean.code).toBe(0);
    expect(clean.summary).toMatch(/Ids in the report dir that match no mapped mutant: 0\n/);
  });

  it('starts every git command with GIT_OPTIONAL_LOCKS=0 beside the process env', () => {
    expect(gitEnv()).toEqual({ ...process.env, GIT_OPTIONAL_LOCKS: '0' });
    const source = fs.readFileSync(tool, 'utf8');
    const starts = source.match(/(execFileSync|execSync|spawnSync|spawn|execFile|exec)\(\s*'git'/g) ?? [];
    expect(starts.length).toBeGreaterThan(0);
    expect(source.match(/env: gitEnv\(\)/g)?.length).toBe(starts.length);
  });

  it('leaves a file unproven, with none of its mutants listed, when one character of the sandbox text differs', async () => {
    const tree = treeWithChange();
    const { patterns } = planOf({ tree, base: 'HEAD', mutate: [] });
    const { sandbox } = await strykerSandbox(tree, [['src/before.ts', true], ...describeMutate(patterns)]);
    const copy = path.join(sandbox, 'src', 'a.ts');
    fs.writeFileSync(copy, fs.readFileSync(copy, 'utf8').replace("'big'", "'bog'"));
    const out = path.join(tempDir('smdb-survivors-out-'), 'out');
    const { code, summary } = await survivors({ report: reportDir({}), sandbox, out, tree, base: 'HEAD', mutate: [] });
    expect(code).toBe(1);
    expect(JSON.parse(fs.readFileSync(path.join(out, 'mutants.json'), 'utf8'))).toEqual([]);
    expect(summary).toMatch(/Unproven files \(1\)[^\n]*\n {2}src\/a\.ts: its instrumented text, ids shifted, differs from the sandbox copy/);
  });

  it('proves a file only at the offset its sandbox ids give', async () => {
    const tree = treeWithChange();
    const { sandbox, keys } = await strykerSandbox(tree, [['src/before.ts', true], ['src/a.ts', true]]);
    const sandboxText = fs.readFileSync(path.join(sandbox, 'src', 'a.ts'), 'utf8');
    const proof = await proveFile({ name: path.join(tree, 'src', 'a.ts'), content: A_NOW, mutate: true, sandboxText });
    expect('mutants' in proof).toBe(true);
    const ids = 'mutants' in proof ? proof.mutants.map(m => m.id) : [];
    expect(ids).toEqual([...keys].filter(([, key]) => key.startsWith('src/a.ts|')).map(([id]) => id));
    const moved = sandboxText.replace(/"(\d+)"/, (_, id: string) => `"${Number(id) + 1}"`);
    expect(await proveFile({ name: path.join(tree, 'src', 'a.ts'), content: A_NOW, mutate: true, sandboxText: moved })).toHaveProperty('why');
    expect(await proveFile({ name: path.join(tree, 'src', 'a.ts'), content: A_NOW, mutate: true, sandboxText: null })).toHaveProperty('why');
  });

  it('refuses a sandbox the reports did not run in, and takes a copy under the name given', async () => {
    const tree = treeWithChange();
    const { patterns } = planOf({ tree, base: 'HEAD', mutate: [] });
    const { sandbox, keys } = await strykerSandbox(tree, [['src/before.ts', true], ...describeMutate(patterns)]);
    const aId = [...keys].find(([, key]) => key.startsWith('src/a.ts|'))?.[0] as string;
    const elsewhere = (r: unknown) => JSON.parse(JSON.stringify(r).split('sandbox-Ab1').join('sandbox-Zz9'));
    const options = (runs: string, more: Record<string, string> = {}) => ({ report: runs, sandbox, out: path.join(tempDir('smdb-survivors-out-'), 'out'), tree, base: 'HEAD', mutate: [], ...more });
    const byReport = options(reportDir({ [aId]: { reach: ['unit/a.test.ts'], fast: elsewhere(report1()) } }));
    await expect(survivors(byReport)).rejects.toThrow(/ran in sandbox-Zz9, not in sandbox-Ab1/);
    expect(fs.existsSync(byReport.out)).toBe(false);
    await expect(survivors(options(reportDir({ [aId]: { reach: [] } }, undefined, elsewhere(report1()))))).rejects.toThrow(/ran in sandbox-Zz9/);
    await expect(survivors(options(reportDir({ [aId]: { reach: [] } })))).rejects.toThrow(/no report in the report dir names its sandbox/);
    const copy = path.join(tempDir('smdb-survivors-copy-'), 'sandbox');
    fs.cpSync(sandbox, copy, { recursive: true });
    const runs = reportDir({ [aId]: { reach: ['unit/a.test.ts'], fast: report1() } });
    await expect(survivors({ ...options(runs), sandbox: copy })).rejects.toThrow(/ran in sandbox-Ab1, not in sandbox; give the run's own sandbox, or --sandbox-name/);
    expect((await survivors({ ...options(runs), sandbox: copy, sandboxName: 'sandbox-Ab1' })).code).toBe(0);
    expect(parseArgs(['--report', 'r', '--sandbox', 's', '--sandbox-name', 'sandbox-Ab1', '--out', 'o']).sandboxName).toBe('sandbox-Ab1');
  });

  it("reads a range pattern as Stryker does: lines from 1 made from 0, a whole file taken whole", () => {
    expect(describeMutate(['src/a.ts:2-5', 'src/a.ts:8-8', 'src/b.ts', 'src/b.ts:1-2'])).toEqual(new Map<string, unknown>([
      ['src/a.ts', [{ start: { line: 1, column: 0 }, end: { line: 4, column: Number.MAX_SAFE_INTEGER } }, { start: { line: 7, column: 0 }, end: { line: 7, column: Number.MAX_SAFE_INTEGER } }]],
      ['src/b.ts', true],
    ]));
  });
});

function report1() {
  return report({ 'unit/a.test.ts': ['passed'] });
}

describe('--out', () => {
  it('is refused inside the tree, the tool\'s checkout, the sandbox and its checkout, the report dir and its checkout', () => {
    const tree = tempDir('smdb-survivors-tree-');
    const sandboxCheckout = tempDir('smdb-survivors-checkout-');
    fs.mkdirSync(path.join(sandboxCheckout, '.git'));
    const sandbox = path.join(sandboxCheckout, '.stryker-tmp', 'sandbox-Ab1');
    fs.mkdirSync(sandbox, { recursive: true });
    const checkout = tempDir('smdb-survivors-checkout-');
    fs.mkdirSync(path.join(checkout, '.git'));
    const report = path.join(checkout, 'test', 'mutation', 'reports', 'r', 'a');
    fs.mkdirSync(report, { recursive: true });
    const free = tempDir('smdb-survivors-out-');
    const dirs = { tree, sandbox, report };
    expect(refuseOut({ out: path.join(tree, 'o'), ...dirs })).toMatch(/inside the tree/);
    expect(refuseOut({ out: path.join(TOOL_ROOT, 'test', 'o'), ...dirs })).toMatch(/inside the tool's own checkout/);
    expect(refuseOut({ out: path.join(sandbox, 'src', 'o'), ...dirs })).toMatch(/inside the sandbox \(/);
    expect(refuseOut({ out: path.join(sandboxCheckout, 'o'), ...dirs })).toMatch(/inside the sandbox's checkout/);
    expect(refuseOut({ out: path.join(report, 'o'), ...dirs })).toMatch(/inside the report dir/);
    expect(refuseOut({ out: path.join(checkout, 'o'), ...dirs })).toMatch(/inside the report dir's checkout/);
    expect(refuseOut({ out: path.join(free, 'o'), ...dirs })).toBeNull();
  });

  it('a refused --out and a usage error exit 2 and make nothing', () => {
    const tree = tempDir('smdb-survivors-tree-');
    const sandbox = tempDir('smdb-survivors-sandbox-');
    fs.mkdirSync(path.join(sandbox, 'src'));
    const runs = reportDir({});
    const run = (args: string[]) => spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8' });
    const refused = run(['--report', runs, '--sandbox', sandbox, '--tree', tree, '--mutate', 'src/a.ts', '--out', path.join(tree, 'o')]);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/inside the tree/);
    expect(fs.readdirSync(tree)).toEqual([]);
    expect(run(['--report', runs]).status).toBe(2);
    const free = tempDir('smdb-survivors-out-');
    expect(run(['--report', runs, '--sandbox', sandbox, '--out', path.join(free, 'o'), '--bogus', 'x']).status).toBe(2);
    expect(fs.readdirSync(free)).toEqual([]);
  });
});
