import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import fc from 'fast-check';
import ts from 'typescript';
import { describe, expect, it, onTestFinished } from 'vitest';
import { canonicalName } from '../mutation/keys.mjs';
import {
  changeTarget, codeLines, commonLines, gates, inPattern, lineDiff, linesOfTarget, mergeRanges, notMutated, parseNameStatus, planChange, planFromGit,
  unmatchedPatterns, untouched, wholeTarget, DATA_ROUTE_WHY, GLOB_NAME_WHY, holdsDataRoute,
} from '../mutation/ranges.mjs';
import { treeChanges, treePrint } from '../mutation/tree.mjs';

// The touched-line ranges of the L5 gate (mutation/README.md): which lines a
// change touched, and how far each widens so that Stryker makes the mutants
// that touch it.

const SAMPLE = [
  'export function f(a: number, b: number) {', // 1
  '  if (a > 0 &&', // 2
  '      b > 0) {', // 3
  '    return a + b;', // 4
  '  }', // 5
  '  const table = {', // 6
  '    x: 1,', // 7
  '    y: () => 2,', // 8
  '  };', // 9
  '  return table.x;', // 10
  '}', // 11
].join('\n');

// Shapes where a changed expression holds a block-bodied callback, and the
// usual statements around them.
const SHAPES: Record<string, string> = {
  sample: SAMPLE,
  returnCompare: [
    'export function f(items: { ok: boolean }[]) {',
    '  return items.filter(i => {',
    '    return i.ok;',
    '  }).length > 0;',
    '}',
  ].join('\n'),
  conditionWithCallback: [
    'export function g(enabled: boolean, items: { ok: boolean }[]) {',
    '  if (enabled || items.some(i => {',
    '    return i.ok;',
    '  })) {',
    '    return 1;',
    '  } else if (items.length > 2) {',
    '    return 2;',
    '  }',
    '  return 0;',
    '}',
  ].join('\n'),
  chainAfterCallback: [
    'export function h(nodes: { up: boolean, ok: boolean }[]) {',
    '  const active = nodes',
    '    .filter(n => {',
    '      return n.up;',
    '    })',
    '    .every(n => n.ok);',
    '  return active;',
    '}',
  ].join('\n'),
  classLoopSwitch: [
    'export class Counter {',
    '  private count = 0;',
    '  bump(by: number): number {',
    '    for (let i = 0; i < by; i++) {',
    '      this.count += i % 2 === 0 ? 1 : 2;',
    '    }',
    '    switch (this.count) {',
    '      case 0:',
    '        return -1;',
    '      default:',
    '        return this.count > 10 ? 10 : this.count;',
    '    }',
    '  }',
    '}',
  ].join('\n'),
  callbacks: [
    'export const routes: Record<string, (x: number) => number> = {',
    '  double: x => {',
    '    const y = x * 2;',
    '    return y + 1;',
    '  },',
    '  half: x => x / 2,',
    '};',
    'export const total = [1, 2, 3].reduce((sum, n) => {',
    '  return sum + n;',
    '}, 0);',
  ].join('\n'),
  tryCatch: [
    'export async function load(read: () => Promise<string>): Promise<string | null> {',
    '  try {',
    '    const text = await read();',
    "    return text.trim() === '' ? null : text;",
    '  } catch (error) {',
    "    return error instanceof Error && error.message.includes('ENOENT') ? null : 'bad';",
    '  }',
    '}',
  ].join('\n'),
};

const rangesOf = (text: string, lines: number[]) => changeTarget('src/a.ts', text, { changed: lines, deletedAfter: [] })?.ranges;

describe('the change', () => {
  // A longest common subsequence's length the slow way, to hold commonLines to.
  const lcsLength = (a: string[], b: string[]) => {
    const row = new Array<number>(b.length + 1).fill(0);
    for (const x of a) {
      let diagonal = 0;
      for (let j = 1; j <= b.length; j++) {
        const above = row[j];
        row[j] = x === b[j - 1] ? diagonal + 1 : Math.max(row[j], row[j - 1]);
        diagonal = above;
      }
    }
    return row[b.length];
  };

  it('keeps as many lines as any common subsequence can, each pair equal and in order', () => {
    const lines = fc.array(fc.constantFrom('a', 'b', 'c', '}', ''), { maxLength: 14 });
    fc.assert(fc.property(lines, lines, (a, b) => {
      const pairs = commonLines(a, b);
      pairs.forEach(([i, j], k) => {
        expect(a[i]).toBe(b[j]);
        if (k > 0) expect(i > pairs[k - 1][0] && j > pairs[k - 1][1]).toBe(true);
      });
      expect(pairs.length).toBe(lcsLength(a, b));
    }), { numRuns: 3000 });
  });

  it('names the lines added or changed, and where lines were only taken out', () => {
    const before = ['a', 'b', 'c', 'd', 'e'].join('\n');
    expect(lineDiff(before, ['a', 'B', 'c', 'd', 'e'].join('\n'))).toEqual({ changed: [2], deletedAfter: [] });
    expect(lineDiff(before, ['a', 'b', 'd', 'e'].join('\n'))).toEqual({ changed: [], deletedAfter: [2] });
    expect(lineDiff(before, ['b', 'c', 'd', 'e'].join('\n'))).toEqual({ changed: [], deletedAfter: [0] });
    expect(lineDiff(before, ['a', 'b', 'c', 'd', 'e', 'f'].join('\n'))).toEqual({ changed: [6], deletedAfter: [] });
    // Line endings alone change nothing, nor does the break after the last line.
    expect(lineDiff(`${before}\n`, before.split('\n').join('\r\n'))).toEqual({ changed: [], deletedAfter: [] });
  });

  it('finds the few lines that changed in a long file, and copes with two that share nothing', () => {
    const long = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
    const edited = long.map((line, i) => (i === 10 || i === 2000 ? `${line} edited` : line));
    edited.splice(1500, 0, 'inserted');
    expect(lineDiff(long.join('\n'), edited.join('\n'))).toEqual({ changed: [11, 1501, 2002], deletedAfter: [] });
    const other = Array.from({ length: 3000 }, (_, i) => `other ${i}`);
    expect(lineDiff(long.join('\n'), other.join('\n')).changed).toHaveLength(3000);
  });

  it('counts a run that could sit in more than one place in every place it could sit', () => {
    // An if block added after an equal one: either copy could be the new one.
    const block = ['  if (ready) {', '    count++;', '  }', ''];
    const before = ['export function f(ready: boolean) {', '  let count = 0;', ...block, '  return count;', '}'].join('\n');
    const after = ['export function f(ready: boolean) {', '  let count = 0;', ...block, ...block, '  return count;', '}'].join('\n');
    expect(lineDiff(before, after).changed).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    // A repeated line taken out could have been any of its copies.
    expect(lineDiff(['a', 'x', 'x', 'x', 'b'].join('\n'), ['a', 'x', 'x', 'b'].join('\n'))).toEqual({ changed: [], deletedAfter: [1, 2, 3] });
  });

  it("reads git's names, a rename's two included", () => {
    expect(parseNameStatus(['M', 'src/a.ts', 'R096', 'updaters/u.ts', 'src/u.ts', 'D', 'src/odd name.ts', 'A', 'src/quote"d.ts', ''].join('\0'))).toEqual([
      { status: 'M', file: 'src/a.ts' },
      { status: 'R', from: 'updaters/u.ts', file: 'src/u.ts' },
      { status: 'D', file: 'src/odd name.ts' },
      { status: 'A', file: 'src/quote"d.ts' },
    ]);
  });

  /** A throwaway repo, and the gate's plan of what changed in it from its first commit. */
  function repoWith(files: Record<string, string | Buffer>) {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-change-'));
    onTestFinished(() => fs.rmSync(repo, { recursive: true, force: true }));
    const git = (args: string[], env: NodeJS.ProcessEnv = {}) =>
      execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
    const write = (file: string, text: string | Buffer) => {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), text);
    };
    git(['init', '-q']);
    for (const [file, text] of Object.entries(files)) write(file, text);
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);
    const base = git(['rev-parse', 'HEAD']).trim();
    const plan = (config: string[] = [], env: NodeJS.ProcessEnv = {}) => planFromGit({ git: (...args: string[]) => git([...config, ...args], env), base, root: repo });
    return { repo, git, write, plan };
  }
  const lines = (name: string, n: number) => Array.from({ length: n }, (_, i) => `export const ${name}${i} = ${i};`);
  const text = (list: string[]) => `${list.join('\n')}\n`;

  it('finds the same targets whatever git setting, attribute or variable the user has', () => {
    const fn = (name: string, arg: string) => [`export function ${name}(${arg}: number) {`, `  if (${arg} > 0) {`, '    return 1;', '  }', '  return 0;', '}', ''];
    const block = ['  if (ready) {', '    count++;', '  }', ''];
    const dup = (blocks: number) => text(['export function f(ready: boolean) {', '  let count = 0;', ...Array.from({ length: blocks }, () => block).flat(), '  return count;', '}']);
    const nul = String.fromCharCode(0);
    const { repo, git, write, plan } = repoWith({
      'src/a.ts': text(lines('a', 30)),
      'src/m.ts': [...fn('f', 'a'), ...fn('g', 'b')].join('\n'),
      'src/bin.ts': text(lines('bin', 10)),
      'src/zerobyte.ts': text([`export const z = '${nul}';`, ...lines('zero', 5)]),
      'src/old.ts': text(lines('old', 20)),
      'src/x.ts': text(lines('x', 20)),
      'src/gone.ts': '// gone\n',
      'src/dup.ts': dup(1),
      'src/case.ts': text(lines('kase', 5)),
      'updaters/u.ts': text(lines('u', 30)),
      'safety-check.js': 'module.exports = 1;\n',
      'readmeAssets/img.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]),
    });
    write('src/a.ts', text(lines('a', 30).map((line, i) => (i === 2 || i === 5 ? line.replace('= ', '= 100 + ') : line))));
    write('src/m.ts', [...fn('g', 'b'), ...fn('f', 'a')].join('\n'));
    write('src/bin.ts', text(lines('bin', 10).map((line, i) => (i === 1 ? `${line} // edited` : line))));
    write('src/zerobyte.ts', text([`export const z = '${nul}';`, ...lines('zero', 5).map((line, i) => (i === 1 ? `${line} // edited` : line))]));
    git(['mv', 'src/old.ts', 'src/new.ts']);
    write('src/new.ts', text(lines('old', 20).map((line, i) => (i === 4 ? `${line} // edited` : line))));
    fs.mkdirSync(path.join(repo, 'tools'));
    git(['mv', 'src/x.ts', 'tools/x.ts']);
    fs.rmSync(path.join(repo, 'src', 'gone.ts'));
    write('src/dup.ts', dup(2));
    git(['mv', 'updaters/u.ts', 'src/u.ts']);
    write('src/u.ts', text(lines('u', 30).map((line, i) => (i === 1 ? `${line} // edited` : line))));
    write('safety-check.js', 'module.exports = 2;\n');
    write('readmeAssets/img.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9]));
    write('src/fresh.ts', text(lines('fresh', 3)));
    write('src/mod/index.ts', text(lines('mod', 3)));
    git(['-C', path.join(repo, 'src', 'mod'), 'init', '-q']);
    // A file renamed by case outside git, where the disk does not tell case apart.
    if (process.platform === 'win32') {
      fs.renameSync(path.join(repo, 'src', 'case.ts'), path.join(repo, 'src', 'Case.ts'));
      write('src/Case.ts', text(lines('kase', 5).map((line, i) => (i === 0 ? `${line} // edited` : line))));
    }

    const attributes = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-attributes-')), 'attributes');
    onTestFinished(() => fs.rmSync(path.dirname(attributes), { recursive: true, force: true }));
    fs.writeFileSync(attributes, '*.ts binary\n*.ts -diff\n');
    const hostile = [
      '-c', 'diff.algorithm=histogram', '-c', 'diff.indentHeuristic=false', '-c', 'diff.renameLimit=1', '-c', 'diff.renames=false',
      '-c', 'diff.noprefix=true', '-c', 'diff.mnemonicPrefix=true', '-c', 'diff.relative=true', '-c', 'diff.context=5', '-c', 'diff.interHunkContext=20',
      '-c', 'core.quotePath=true', '-c', 'core.bigFileThreshold=16', '-c', `core.attributesFile=${attributes}`,
    ];
    const plain = plan();
    expect(plan(hostile, { GIT_DIFF_OPTS: '--unified=3' })).toEqual(plain);

    const target = (file: string) => plain.targets.find(t => t.file === file);
    expect(target('src/a.ts')?.gating).toEqual([3, 6]);
    expect(target('src/bin.ts')?.gating).toEqual([2]);
    expect(target('src/zerobyte.ts')?.gating).toEqual([3]);
    // Renamed within src: only its changed line. Moved in from outside src, new, untracked: whole.
    expect(target('src/new.ts')?.gating).toEqual([5]);
    for (const file of ['src/u.ts', 'src/fresh.ts']) expect(target(file), file).toEqual(wholeTarget(file));
    // The copy added could be either one: both gate.
    expect(target('src/dup.ts')?.gating).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    expect(target('src/m.ts')?.gating?.length).toBeGreaterThan(0);
    if (process.platform === 'win32') expect(target('src/Case.ts')?.gating).toEqual([1]);
    expect(plain.skipped).toEqual(expect.arrayContaining([
      { file: 'tools/x.ts', why: 'outside src' },
      { file: 'src/x.ts', why: 'moved to tools/x.ts: nothing is left to mutate' },
      { file: 'src/gone.ts', why: 'deleted: nothing is left to mutate' },
      { file: 'safety-check.js', why: 'outside src' },
      { file: 'readmeAssets/img.png', why: 'outside src' },
      { file: 'src/mod/', why: 'an untracked git repository: git lists none of its files, so none is mutated' },
    ]));
    expect(plain.skipped.map(s => s.file)).not.toContain('src/u.ts');
    expect(plain.emptyScope).toBe(false);
  });

  it('says no src file changed only when none did: a deletion or a move out of src is a change', () => {
    const one = repoWith({ 'src/a.ts': text(lines('a', 3)), 'tools/t.js': 'module.exports = 1;\n' });
    one.write('tools/t.js', 'module.exports = 2;\n');
    expect(one.plan()).toEqual({ targets: [], skipped: [{ file: 'tools/t.js', why: 'outside src' }], emptyScope: true });
    fs.rmSync(path.join(one.repo, 'src', 'a.ts'));
    expect(one.plan().emptyScope).toBe(false);
    const two = repoWith({ 'src/x.ts': text(lines('x', 3)) });
    fs.mkdirSync(path.join(two.repo, 'tools'));
    two.git(['mv', 'src/x.ts', 'tools/x.ts']);
    expect(two.plan().emptyScope).toBe(false);
  });
  it('counts a copy beside an edited line, and a repeated head or tail of the lines added, in every place it could sit', () => {
    const block = ['  if (queue.length > 0) {', '    handle(queue.shift());', '  }'];
    const drain = (first: string, blocks: number) =>
      ['export function drain(queue: number[], note: string) {', first, ...Array.from({ length: blocks }, () => block).flat(), '}'].join('\n');
    // The line before the blocks is edited too: both copies count.
    expect(lineDiff(drain('  console.log(note);', 1), drain('  console.log(`drain ${note}`);', 2)).changed).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(lineDiff(['start();', 'bar();', 'end();'].join('\n'), ['start();', 'foo();', 'bar();', 'bar();', 'end();'].join('\n')).changed).toEqual([2, 3, 4]);
    expect(lineDiff(['start();', 'end();'].join('\n'), ['start();', 'start();', 'foo();', 'end();'].join('\n')).changed).toEqual([1, 2, 3]);
  });

  it('counts a line kept whose place in the code changed: moved into or out of a block, or a block put around it or taken away', () => {
    const into = [
      'export function settle(ready: boolean, log: string[], lease: { release(): void }) {',
      '  if (ready) {',
      "    log.push('ready');",
      '  }',
      '  lease.release();',
      "  log.push('done');",
      '}',
    ];
    const moved = [into[0], into[1], into[2], into[4], into[3], into[5], into[6]];
    // The bracket moved below release(): it now runs only when ready.
    expect(lineDiff(into.join('\n'), moved.join('\n'), 'src/a.ts').changed).toContain(4);
    expect(lineDiff(moved.join('\n'), into.join('\n'), 'src/a.ts').changed).toContain(5);
    // The block's header and bracket taken away: its body runs always.
    expect(lineDiff(into.join('\n'), [into[0], into[2], into[4], into[5], into[6]].join('\n'), 'src/a.ts').changed).toContain(2);
    // An edited condition moves no other line.
    expect(lineDiff(into.join('\n'), [into[0], '  if (ready && log.length > 0) {', ...into.slice(2)].join('\n'), 'src/a.ts').changed).toEqual([2]);
    // A block put around it.
    expect(lineDiff(into.join('\n'), [...into.slice(0, 4), '  if (log.length > 0) {', into[4], '  }', ...into.slice(5)].join('\n'), 'src/a.ts').changed).toEqual([5, 6, 7]);
  });

  it('counts a line kept that a sibling block now holds: across `} else {`, `} finally {`, a case label or `}, () => {`', () => {
    const head = 'export function step(failed: boolean, state: { retries: number, backoff: number }) {';
    const up = ['    state.retries = state.retries + 1;', '    state.backoff = Math.min(state.backoff * 2, 60);'];
    const down = ['    state.retries = Math.max(state.retries - 1, 0);', '    state.backoff = state.backoff / 2;'];
    const ifElse = (then: string[], other: string[]) => [head, '  if (failed) {', ...then, '  } else {', ...other, '  }', '}'].join('\n');
    // The two bodies swapped: every line of both counts.
    expect(lineDiff(ifElse(up, down), ifElse(down, up), 'src/a.ts').changed).toEqual([3, 4, 5, 6, 7]);
    const branches = ['export function f(a: boolean, log: string[]) {', '  if (a) {', "    log.push('x');", '  } else {', "    log.push('y');", "    log.push('z');", '  }', '}'];
    const swap = (lines: string[], k: number) => [...lines.slice(0, k), lines[k + 1], lines[k], ...lines.slice(k + 2)].join('\n');
    // `} else {` moved below log.push('y'): y now runs when a holds.
    expect(lineDiff(branches.join('\n'), swap(branches, 3), 'src/a.ts').changed).toContain(4);
    // The same with the condition edited too: both blocks open on edited lines, and y went from the else to the then.
    expect(lineDiff(branches.join('\n'), swap(branches, 3).replace('if (a) {', 'if (!a) {'), 'src/a.ts').changed).toContain(4);
    const guarded = ['export function g(work: () => void, lease: { release(): void }, log: string[]) {', '  try {', '    work();', "    log.push('ok');", '  } finally {', '    lease.release();', '  }', '}'];
    // `} finally {` moved below release(): it no longer runs when work() throws.
    expect(lineDiff(guarded.join('\n'), swap(guarded, 4), 'src/a.ts').changed).toContain(5);
    const cases = ['export function h(n: number, log: string[]) {', '  switch (n) {', '    case 1:', "      log.push('one');", '      break;', '    case 2:', "      log.push('two');", '      break;', '  }', '}'];
    // `case 2:` moved above case 1's break: case 1 falls through into it.
    expect(lineDiff(cases.join('\n'), swap(cases, 4), 'src/a.ts').changed).toContain(6);
    const callbacks = ['export function k(on: (a: () => void, b: () => void) => void, log: string[]) {', '  on(() => {', "    log.push('a');", '  }, () => {', "    log.push('b');", "    log.push('c');", '  });', '}'];
    // `}, () => {` moved below log.push('b'): b now runs in the first callback.
    expect(lineDiff(callbacks.join('\n'), swap(callbacks, 3), 'src/a.ts').changed).toContain(4);
    const classes = ['export class A {', '  x = 1;', '}', 'export class B {', '  y = 2;', '}'];
    expect(lineDiff(classes.join('\n'), [classes[0], classes[1], classes[4], classes[2], classes[3], classes[5]].join('\n'), 'src/a.ts').changed).toContain(3);
  });

  it('counts no line a change only wraps or renames the holder of, and numbers lines as the diff does', () => {
    const fn = ['export function sum(items: number[]) {', '  let total = 0;', '  for (const n of items) total += n;', '  return total;', '}'];
    expect(lineDiff(fn.join('\n'), ['export const sum = (items: number[]) => {', ...fn.slice(1, 4), '};'].join('\n'), 'src/a.ts').changed).toEqual([1, 5]);
    const call = ['export async function m(send: (a: number, b: number) => Promise<void>) {', '  send(', '    1,', '    2,', '  );', '}'];
    expect(lineDiff(call.join('\n'), [call[0], '  await send(', ...call.slice(2)].join('\n'), 'src/a.ts').changed).toEqual([2]);
    const table = ['export const table = {', '  a: 1,', '  b: 2,', '};'];
    expect(lineDiff(table.join('\n'), ['export const table = Object.freeze({', '  a: 1,', '  b: 2,', '});'].join('\n'), 'src/a.ts').changed).toEqual([1, 4]);
    const cls = ['export class A {', '  x = 1;', '  y() { return 2; }', '}'];
    expect(lineDiff(cls.join('\n'), ['@sealed', ...cls].join('\n'), 'src/a.ts').changed).toEqual([1]);
    // A base that holds U+2028 (TypeScript counts it as a line break, the diff does not).
    const ls = String.fromCharCode(0x2028);
    const base = ['export function q(log: string[]) {', `  const s = 'a${ls}b';`, '  log.push(s);', '  if (s) {', "    log.push('x');", '  }', "  log.push('y');", '}'];
    expect(lineDiff(base.join('\n'), [base[0], "  const s = 'ab';", ...base.slice(2, 6), "  log.push('y!');", base[7]].join('\n'), 'src/a.ts').changed).toEqual([2, 7]);
    // A line that was inside a template and is code now.
    expect(lineDiff(['export const t = `', 'run();', '`;'].join('\n'), ['export const t = 1;', 'run();', ''].join('\n'), 'src/a.ts').changed).toContain(2);
  });

  it('names a submodule, and a file whose name Stryker would read as a glob, with the reason', () => {
    const plan = planChange({
      entries: [{ status: 'M', file: 'src/sub' }, { status: 'M', file: 'src/[id].ts' }],
      untracked: ['src/a{1,2}.ts'],
      read: () => 'export const x = 1;\n',
      readBase: () => '',
      nameOf: file => (/[[{]/.test(file) ? null : file),
      isDir: file => file === 'src/sub',
    });
    expect(plan.targets).toEqual([]);
    expect(plan.skipped).toEqual([
      { file: 'src/sub', why: 'a git submodule: git names only its commit, so none of its files is mutated' },
      { file: 'src/[id].ts', why: GLOB_NAME_WHY },
      { file: 'src/a{1,2}.ts', why: GLOB_NAME_WHY },
    ]);
  });

  it('sees a change git is told not to look at, and names a submodule and a name Stryker would read as a glob', () => {
    const edited = (name: string) => text(lines(name, 3).map((line, i) => (i === 1 ? `${line} // edited` : line)));
    const sub = repoWith({ 'index.ts': text(lines('s', 2)) });
    const { repo, git, write, plan } = repoWith({
      'src/a.ts': text(lines('a', 3)), 'src/b.ts': text(lines('b', 3)), 'src/c.ts': text(lines('c', 3)), 'src/[id].ts': text(lines('id', 3)),
      'src/d.ts': text(lines('d', 3)), 'src/e.ts': text(lines('e', 3)),
    });
    git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.repo.split(path.sep).join('/'), 'src/sub']);
    git(['update-index', '--assume-unchanged', 'src/a.ts', 'src/d.ts']);
    git(['update-index', '--skip-worktree', 'src/b.ts', 'src/e.ts']);
    // Gone: d deleted (named), e left out as a sparse checkout leaves a file out.
    fs.rmSync(path.join(repo, 'src', 'd.ts'));
    fs.rmSync(path.join(repo, 'src', 'e.ts'));
    // core.ignoreStat marks each file git adds after it is set.
    git(['config', 'core.ignoreStat', 'true']);
    git(['add', 'src/c.ts']);
    for (const name of ['a', 'b', 'c', 'id']) write(`src/${name === 'id' ? '[id]' : name}.ts`, edited(name));
    write('src/new[1].ts', text(lines('n', 2)));
    // A config that hides submodules from the diff hides nothing from the gate.
    const result = plan(['-c', 'diff.ignoreSubmodules=all']);
    expect(result.targets.map(t => [t.file, t.gating]).sort()).toEqual([['src/a.ts', [2]], ['src/b.ts', [2]], ['src/c.ts', [2]]]);
    expect(result.skipped).toEqual(expect.arrayContaining([
      { file: 'src/sub', why: 'a git submodule: git names only its commit, so none of its files is mutated' },
      { file: 'src/[id].ts', why: GLOB_NAME_WHY },
      { file: 'src/new[1].ts', why: GLOB_NAME_WHY },
      { file: 'src/d.ts', why: 'deleted: nothing is left to mutate' },
    ]));
    expect(result.skipped.map(s => s.file)).not.toContain('src/e.ts');
  });

  const botRoot = path.resolve(__dirname, '..', '..');

  it('never mutates code on the way to /data, under any name, and names it', () => {
    const dataRoot = fs.readFileSync(path.join(botRoot, 'src', 'utils', 'dataRoot.ts'), 'utf8');
    expect(holdsDataRoute('src/utils/dataRoot.ts', dataRoot)).toBe(true);
    expect(holdsDataRoute('src/a.ts', "export const root = process.env['DATA_DIR'] ?? 'here';\n")).toBe(true);
    expect(holdsDataRoute('src/a.js', 'module.exports = process.env.X || `/data/`;\n')).toBe(true);
    // A name that holds it, a route that starts with it, or a comment is no way there.
    expect(holdsDataRoute('src/a.ts', "// DATA_DIR, '/data'\nconst BASE_DATA_DIR = DATA_ROOT;\napp.get('/data/get', h);\n")).toBe(false);
    const plan = planChange({
      entries: [{ status: 'R', from: 'src/utils/dataRoot.ts', file: 'src/utils/paths/dataRoot.ts' }, { status: 'M', file: 'src/b.ts' }],
      untracked: ['src/c.ts'],
      read: file => (file === 'src/b.ts' ? 'export const b = 1;\n' : dataRoot),
      readBase: () => 'export const b = 0;\n',
      nameOf: file => file,
    });
    expect(plan.targets.map(t => t.file)).toEqual(['src/b.ts']);
    expect(plan.skipped).toEqual([{ file: 'src/utils/paths/dataRoot.ts', why: DATA_ROUTE_WHY }, { file: 'src/c.ts', why: DATA_ROUTE_WHY }]);
  });

  it('fails when a test names botManager, whose fork of the bot is a way to /data the gate does not close yet (mutation/README.md)', () => {
    const named: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (!['node_modules', 'reports', '.stryker-tmp'].includes(entry.name)) walk(full); continue; }
        if (/\.(ts|mjs|cjs|js)$/.test(entry.name) && full !== __filename && fs.readFileSync(full, 'utf8').includes('botManager')) named.push(path.relative(botRoot, full));
      }
    };
    walk(path.join(botRoot, 'test'));
    expect(named).toEqual([]);
  });

  it('fingerprints the tree a run reads, and names what changed in it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-tree-'));
    onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'a.ts'), 'a');
    fs.writeFileSync(path.join(root, 'b.ts'), 'b');
    const before = treePrint(root, ['a.ts', 'b.ts', 'gone.ts']);
    expect(treeChanges(before, treePrint(root, ['a.ts', 'b.ts', 'gone.ts']))).toEqual([]);
    // The same size, and perhaps the same time: the content tells.
    fs.writeFileSync(path.join(root, 'a.ts'), 'A');
    fs.writeFileSync(path.join(root, 'c.ts'), 'c');
    expect(treeChanges(before, treePrint(root, ['a.ts', 'b.ts', 'c.ts', 'gone.ts']))).toEqual(['a.ts', 'c.ts']);
  });

});

describe('the widening', () => {
  it('takes a whole multi-line condition when one of its lines changed, but not the body it guards', () => {
    expect(rangesOf(SAMPLE, [3])).toEqual([[2, 3]]);
    expect(rangesOf(SAMPLE, [2])).toEqual([[2, 3]]);
    expect(rangesOf(SHAPES.conditionWithCallback, [2])).toEqual([[2, 4]]);
  });

  it('takes the whole expression when a block-bodied callback sits inside it', () => {
    expect(rangesOf(SHAPES.returnCompare, [4])).toEqual([[2, 4]]);
    expect(rangesOf(SHAPES.chainAfterCallback, [6])).toEqual([[2, 6]]);
  });

  it('keeps a changed line in a body, a callback body included, to its own statement', () => {
    expect(rangesOf(SAMPLE, [4])).toEqual([[4, 4]]);
    expect(rangesOf(SAMPLE, [10])).toEqual([[10, 10]]);
    expect(rangesOf(SHAPES.returnCompare, [3])).toEqual([[3, 3]]);
    expect(rangesOf(SHAPES.callbacks, [3])).toEqual([[3, 3]]);
  });

  it('takes a whole statement that holds no block', () => {
    expect(rangesOf(SAMPLE, [7])).toEqual([[6, 9]]);
    expect(rangesOf(SAMPLE, [8])).toEqual([[6, 9]]);
  });

  it('keeps a changed signature to the signature, and a closing brace or else line to its own line', () => {
    expect(rangesOf(SAMPLE, [1])).toEqual([[1, 1]]);
    expect(rangesOf(SAMPLE, [5])).toEqual([[5, 5]]);
    expect(rangesOf(SHAPES.conditionWithCallback, [6])).toEqual([[6, 6]]);
  });

  it('tells lines that hold code from blank, comment-only and brace-only ones, inside a statement too', () => {
    const text = [
      SAMPLE, // 1 to 11
      '// a comment', // 12
      '', // 13
      'export interface Role {', // 14
      '  /** a doc */', // 15
      '  name?: string;', // 16
      '  // a note', // 17
      '}', // 18
      'export const t = `a', // 19
      'b`;', // 20
      'if (t) {', // 21
      '  f(1, 2);', // 22
      '} else {', // 23
      '  f(2, 1);', // 24
      '}', // 25
    ].join('\n');
    expect(codeLines('src/a.ts', text, Array.from({ length: 25 }, (_, i) => i + 1))).toEqual([1, 2, 3, 4, 6, 7, 8, 10, 14, 16, 19, 20, 21, 22, 23, 24]);
  });

  it('joins ranges that meet, since Stryker needs one range to hold a whole mutant', () => {
    expect(rangesOf(SAMPLE, [3, 4])).toEqual([[2, 4]]);
    expect(mergeRanges([[9, 9], [1, 2], [3, 3], [5, 7], [6, 8]])).toEqual([[1, 3], [5, 9]]);
  });
});

// Stryker's own instrumenter, in memory: every mutant that touches a changed
// line must be made by the ranges, except one that touches the line only
// through a block nested inside it (the whole callback around a changed line
// of its body), and the emptying of a block that only begins or ends on the
// line (the body of a changed `if (...) {` or signature: making it would bring
// in the whole body).
describe('the widening, against what Stryker makes', () => {
  const quiet = () => {};
  const logger = { debug: quiet, info: quiet, warn: quiet, error: quiet, trace: quiet, fatal: quiet, isDebugEnabled: () => false, isTraceEnabled: () => false, isInfoEnabled: () => false, isWarnEnabled: () => false, isErrorEnabled: () => false, isFatalEnabled: () => false };
  const instrumenter = new Instrumenter(logger as never);
  const OPTIONS = { plugins: null, excludedMutations: [], ignorers: [], noHeader: true } as never;
  interface Made { mutatorName: string; replacement: string; location: { start: { line: number; column: number }; end: { line: number; column: number } } }
  const made = async (text: string, mutate: unknown): Promise<Made[]> =>
    (await instrumenter.instrument([{ name: 'src/a.ts', content: text, mutate } as never], OPTIONS)).mutants as unknown as Made[];
  const key = (m: Made) => `${m.mutatorName}|${m.replacement}|${m.location.start.line}:${m.location.start.column}-${m.location.end.line}:${m.location.end.column}`;
  const spansOf = (list: Made[]) => list.map((m): [number, number] => [m.location.start.line + 1, m.location.end.line + 1]);

  // The shapes above, and two real files: one with plain statements, one a
  // route file of block-bodied handlers.
  const real = (file: string) => fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
  const corpus: [string, string][] = [
    ...Object.entries(SHAPES),
    ['src/bot/internalSetup/fleet/nodeIdentity.ts', real('src/bot/internalSetup/fleet/nodeIdentity.ts')],
    ['src/webui/routes/control.ts', real('src/webui/routes/control.ts')],
  ];
  for (const [name, text] of corpus) {
    it(`makes every mutant that touches a changed line: ${name}`, { timeout: 120_000 }, async () => {
      const sf = ts.createSourceFile('a.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const at = (p: { line: number; column: number }) => sf.getPositionOfLineAndCharacter(p.line, p.column);
      const blocks: { start: number; end: number }[] = [];
      const walk = (node: ts.Node) => {
        if (ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseBlock(node)) blocks.push({ start: node.getStart(sf), end: node.getEnd() });
        ts.forEachChild(node, walk);
      };
      walk(sf);
      const whole = await made(text, true);
      const lines = text.split('\n');
      let checked = 0;
      for (let n = 1; n <= lines.length; n++) {
        const code = lines[n - 1];
        if (code.trim() === '') continue;
        const lineStart = sf.getPositionOfLineAndCharacter(n - 1, 0);
        const span = { start: lineStart + code.search(/\S/), end: lineStart + code.trimEnd().length };
        const throughBlock = (m: Made) => blocks.some(b => at(m.location.start) <= b.start && b.end <= at(m.location.end) && b.start < span.start && span.end < b.end);
        const braceOnly = (m: Made) => m.mutatorName === 'BlockStatement' && (m.location.start.line + 1 < n || n < m.location.end.line + 1);
        const expected = whole.filter(m => m.location.start.line + 1 <= n && n <= m.location.end.line + 1 && !throughBlock(m) && !braceOnly(m));
        const ranges = rangesOf(text, [n]) ?? [];
        const mutate = ranges.map(([s, e]) => ({ start: { line: s - 1, column: 0 }, end: { line: e - 1, column: Number.MAX_SAFE_INTEGER } }));
        const here = await made(text, mutate);
        const got = new Set(here.map(key));
        const missing = expected.filter(m => !got.has(key(m))).map(m => `${m.mutatorName} ${key(m)}`);
        expect(missing, `${name} line ${n}: ${code.trim()}`).toEqual([]);
        checked += expected.length;
        // The file taken whole names the line exactly when the line changed alone would.
        expect(untouched(name, text, [n], spansOf(whole)), `${name} line ${n}: ${code.trim()}`).toEqual(untouched(name, text, [n], spansOf(here)));
      }
      expect(checked).toBeGreaterThan(lines.length / 4);
    });
  }

  it('names the lines of a file taken whole that only the emptying of their body covers', async () => {
    const text = [
      "import { Pool } from 'pg';",
      'export async function sweep(pool: Pool, a: string, b: string): Promise<void> {',
      '  await pool.query(a);',
      '  await pool.query(b);',
      '  if (a === b) return;',
      '  [a, b].forEach(name => {',
      '    console.log(name);',
      '  });',
      '}',
      '',
    ].join('\n');
    const whole = await made(text, true);
    expect(whole.filter(m => m.mutatorName === 'BlockStatement').map(m => m.location.start.line + 1)).toEqual([2, 6]);
    expect(untouched('src/a.ts', text, Array.from({ length: 10 }, (_, i) => i + 1), spansOf(whole))).toEqual([1, 2, 3, 4]);
  });

  it('names every line no mutant lies wholly on: an emptied object, array or arrow body, a split condition, a chained call', async () => {
    const text = [
      'export function names(items: { id: string; title: string }[]) {',
      '  return items.map(item => ({',
      '    id: item.id,',
      '    name: item.title,',
      '  }));',
      '}',
      'export const handlers = {',
      '  a: makeA(),',
      '  b: makeB(),',
      '};',
      'export const steps = [',
      '  stepA(),',
      '  stepB(),',
      '];',
      'export const ready = isReady() &&',
      '  hasLease();',
      'export function pick(rows: { ok: boolean }[], other: { ok: boolean }[]) {',
      '  const ready = other',
      '    .filter(r => r.ok)',
      '    .sort();',
      '  return ready;',
      '}',
      'export const config = Object.freeze({',
      '  retries: 3,',
      '});',
      '',
    ].join('\n');
    const whole = await made(text, true);
    expect(whole.map(m => `${m.mutatorName} ${m.location.start.line + 1}-${m.location.end.line + 1}`)).toEqual(expect.arrayContaining(
      ['ArrowFunction 2-5', 'ObjectLiteral 2-5', 'ObjectLiteral 7-10', 'ArrayDeclaration 11-14', 'LogicalOperator 15-16', 'MethodExpression 18-20',
        'ArrowFunction 19-19', 'ObjectLiteral 23-25']));
    expect(untouched('src/a.ts', text, Array.from({ length: 26 }, (_, i) => i + 1), spansOf(whole)))
      .toEqual([1, 2, 3, 4, 7, 8, 9, 11, 12, 13, 15, 16, 17, 18, 20, 21, 23, 24]);
  });

  it('names an else, try, finally or do line no mutant lies on: each carries behaviour', async () => {
    const text = [
      'export function f(ok: boolean) {',
      '  if (ok) {',
      '    run();',
      '  } else {',
      '    wait();',
      '  }',
      '  try {',
      '    run();',
      '  } finally {',
      '    done();',
      '  }',
      '  do {',
      '    run();',
      '  } while (ok);',
      '}',
      '',
    ].join('\n');
    const whole = await made(text, true);
    expect(untouched('src/a.ts', text, [4, 7, 9, 12], spansOf(whole))).toEqual([4, 7, 9, 12]);
  });
});

describe('the targets', () => {
  // A plan of the given entries and untracked files: each file's text, and its
  // text at the base where that differs.
  const planOf = (entries: { status: string; file: string; from?: string }[], untracked: string[], texts: Record<string, string>, bases: Record<string, string> = {}) =>
    planChange({ entries, untracked, read: file => texts[file], readBase: file => bases[file] ?? texts[file], nameOf: file => file });
  const changedAt = (text: string, n: number) => text.split('\n').map((line, i) => (i === n - 1 ? `${line} // was` : line)).join('\n');

  it('names every changed file it does not mutate, and why', () => {
    const plan = planOf(
      [
        { status: 'M', file: 'src/webui/public/app.jsx' },
        { status: 'M', file: 'src/bot/types.d.ts' },
        { status: 'M', file: 'src/bot/modules/x/module.json' },
        { status: 'M', file: 'src/a.ts' },
        { status: 'D', file: 'src/gone.ts' },
      ],
      ['src/webui/public/new.js', 'src/new.ts', 'src/mod/', 'tools/mod/'],
      { 'src/a.ts': SAMPLE, 'src/new.ts': 'export const n = 1;\n' },
    );
    expect(plan.skipped.map(s => s.file)).toEqual([
      'src/webui/public/app.jsx', 'src/bot/types.d.ts', 'src/bot/modules/x/module.json', 'src/a.ts', 'src/gone.ts', 'src/webui/public/new.js', 'src/mod/', 'tools/mod/',
    ]);
    expect(plan.skipped.every(s => s.why.length > 0)).toBe(true);
    expect(plan.skipped.find(s => s.file === 'src/a.ts')?.why).toBe('no changed lines (a rename, a mode change, or line endings only)');
    expect(plan.skipped.find(s => s.file === 'src/mod/')?.why).toBe('an untracked git repository: git lists none of its files, so none is mutated');
    expect(plan.skipped.find(s => s.file === 'tools/mod/')?.why).toBe('outside src');
    expect(plan.targets).toEqual([wholeTarget('src/new.ts')]);
    expect(notMutated('test/x.ts')).toBe('outside src');
  });

  it('takes a file new to the mutated code whole, and names one moved out of it', () => {
    const plan = planOf(
      [
        { status: 'R', from: 'updaters/u.ts', file: 'src/u.ts' },
        { status: 'R', from: 'src/webui/public/v.js', file: 'src/v.ts' },
        { status: 'A', file: 'src/added.ts' },
        { status: 'R', from: 'src/old.ts', file: 'src/new.ts' },
        { status: 'R', from: 'src/x.ts', file: 'tools/x.ts' },
      ],
      [],
      { 'src/u.ts': SAMPLE, 'src/v.ts': SAMPLE, 'src/added.ts': SAMPLE, 'src/new.ts': SAMPLE },
      { 'src/old.ts': changedAt(SAMPLE, 7) },
    );
    expect(plan.targets).toEqual([
      wholeTarget('src/u.ts'), wholeTarget('src/v.ts'), wholeTarget('src/added.ts'), changeTarget('src/new.ts', SAMPLE, { changed: [7], deletedAfter: [] }),
    ]);
    expect(plan.skipped).toEqual([{ file: 'tools/x.ts', why: 'outside src' }, { file: 'src/x.ts', why: 'moved to tools/x.ts: nothing is left to mutate' }]);
    expect(plan.emptyScope).toBe(false);
  });

  it('answers for every line a whole file or a pattern covers, and for the changed lines of a diff', () => {
    expect(linesOfTarget({ gating: [3, 7], patterns: ['src/a.ts:2-9'] }, 11)).toEqual([3, 7]);
    expect(linesOfTarget({ gating: null, patterns: ['src/new.ts'] }, 4)).toEqual([1, 2, 3, 4]);
    expect(linesOfTarget({ gating: null, patterns: ['src/a.ts:3-5', 'src/a.ts:5-6', 'src/a.ts:10-99'] }, 11)).toEqual([3, 4, 5, 6, 10, 11]);
  });

  it('does not mutate a file holding a line break the gate does not count, and says why', () => {
    const [ls, ps] = [String.fromCharCode(0x2028), String.fromCharCode(0x2029)];
    const texts: Record<string, string> = {
      'src/sep.ts': `export const s = 'a${ls}b';\nexport const t = 1;\n`,
      'src/cr.ts': 'export const a = 1;\r\rexport const b = 2;\n',
      'src/crlf.ts': 'export const a = 1;\r\nexport const b = 2;\r\n',
      'src/new.ts': `export const n = 'x${ps}y';\n`,
    };
    const plan = planOf(['src/sep.ts', 'src/cr.ts', 'src/crlf.ts'].map(file => ({ status: 'M', file })), ['src/new.ts'], texts,
      { 'src/sep.ts': '', 'src/cr.ts': '', 'src/crlf.ts': 'export const a = 1;\nexport const b = 3;\n' });
    expect(plan.skipped.map(s => s.file)).toEqual(['src/sep.ts', 'src/cr.ts', 'src/new.ts']);
    for (const s of plan.skipped) expect(s.why).toMatch(/^it holds a line break Stryker counts and the gate does not/);
    expect(plan.targets.map(t => [t.file, t.gating])).toEqual([['src/crlf.ts', [2]]]);
  });

  it('takes a file under the name it has on disk, relative to the bot root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-names-'));
    const outside = path.join(os.tmpdir(), `smdb-outside-${process.pid}.ts`);
    onTestFinished(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { force: true }); });
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'Foo.ts'), 'export const x = 1;\n');
    fs.writeFileSync(outside, 'export const y = 1;\n');
    expect(canonicalName(root, 'src/Foo.ts')).toBe('src/Foo.ts');
    expect(canonicalName(root, `.${path.sep}src${path.sep}Foo.ts`)).toBe('src/Foo.ts');
    expect(canonicalName(root, 'src/../src/Foo.ts')).toBe('src/Foo.ts');
    if (process.platform === 'win32') expect(canonicalName(root, 'SRC/foo.TS')).toBe('src/Foo.ts');
    for (const refused of ['src/missing.ts', 'src', 'src/*.ts', 'src/+(Foo|Bar).ts', outside]) expect(canonicalName(root, refused), refused).toBe(null);
  });

  it('tells which mutants a pattern made by its lines', () => {
    const at = (start: number, end: number) => ({ start: { line: start, column: 1 }, end: { line: end, column: 9 } });
    expect(inPattern('src/a.ts', at(3, 4))).toBe(true);
    expect(inPattern('src/a.ts:2-5', at(3, 4))).toBe(true);
    expect(inPattern('src/a.ts:2-5', at(5, 6))).toBe(false);
    expect(inPattern('src/a.ts:2150-2150', at(215, 215))).toBe(false);
    const targets = ['src/a.ts:215-215', 'src/a.ts:2150-2150', 'src/a.ts:1-3', 'src/b.ts'].map(pattern => ({ file: pattern.replace(/:.*$/, ''), patterns: [pattern], gating: null }));
    expect(unmatchedPatterns(targets, [{ file: 'src/a.ts', location: at(215, 215) }])).toEqual(['src/a.ts:2150-2150', 'src/a.ts:1-3', 'src/b.ts']);
    expect(unmatchedPatterns([{ file: 'src/a.ts', patterns: ['src/a.ts:1-3'], gating: [2] }], [])).toEqual([]);
  });

  it('widens a pure deletion to its neighbours as context only', () => {
    expect(changeTarget('src/a.ts', SAMPLE, { changed: [], deletedAfter: [3] })).toEqual({ file: 'src/a.ts', ranges: [[2, 4]], gating: [], patterns: ['src/a.ts:2-4'] });
  });

  it('gates the mutants that touch a changed line, and calls the rest context', () => {
    const target = changeTarget('src/a.ts', SAMPLE, { changed: [7], deletedAfter: [] });
    expect(target?.patterns).toEqual(['src/a.ts:6-9']);
    const at = (start: number, end: number) => ({ start: { line: start, column: 1 }, end: { line: end, column: 1 } });
    expect(gates({ gating: target?.gating ?? null }, at(7, 7))).toBe(true);
    expect(gates({ gating: target?.gating ?? null }, at(6, 9))).toBe(true);
    expect(gates({ gating: target?.gating ?? null }, at(8, 8))).toBe(false);
    expect(gates({ gating: null }, at(1, 1))).toBe(true);
  });
});
