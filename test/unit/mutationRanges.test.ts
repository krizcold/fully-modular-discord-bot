import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import fc from 'fast-check';
import ts from 'typescript';
import { pathToFileURL } from 'url';
import { describe, expect, it, onTestFinished } from 'vitest';
import { runScenario } from '../helpers/child';
import { canonicalName } from '../mutation/keys.mjs';
import {
  changeTarget, codeLines, commonLines, gates, inPattern, lineDiff, linesOfTarget, mergeRanges, notMutated, parseNameStatus, planChange, planFromGit,
  unmatchedPatterns, untouched, wholeTarget, structureLines, DATA_ROUTE_WHY, GLOB_NAME_WHY, holdsDataRoute, sandboxPatterns,
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
  forNoCondition: [
    'export function retry(work: () => boolean): number {',
    '  for (let attempt = 0; ; attempt++) {',
    '    if (work()) return attempt;',
    '  }',
    '}',
  ].join('\n'),
  // On one line, the loop's false condition lies on the line, so it is made.
  forNoConditionOneLine: [
    'export async function poll(ready: () => Promise<boolean>): Promise<void> {',
    '  for (;;) if (await ready()) return;',
    '}',
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
  bodiesTakenWhole: [
    'export function pick(n: number, log: string[]): number {',
    '  switch (n) {',
    '    case 1: {',
    "      log.push('one');",
    '      break;',
    '    }',
    '    default: {',
    "      log.push('other');",
    '    }',
    '  }',
    '  const handlers = {',
    '    run(x: number) {',
    '      return x + 1;',
    '    },',
    '    get size() {',
    '      return log.length;',
    '    },',
    '  };',
    '  const K = class {',
    '    twice(x: number) {',
    '      return x * 2;',
    '    }',
    '  };',
    '  return handlers.run(new K().twice(n)) + handlers.size;',
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

  it('names the lines added or changed, and where lines were taken out with fewer or none put back', () => {
    const before = ['a', 'b', 'c', 'd', 'e'].join('\n');
    expect(lineDiff(before, ['a', 'B', 'c', 'd', 'e'].join('\n'))).toEqual({ changed: [2], deletedAfter: [] });
    expect(lineDiff(before, ['a', 'b', 'd', 'e'].join('\n'))).toEqual({ changed: [], deletedAfter: [2] });
    expect(lineDiff(before, ['b', 'c', 'd', 'e'].join('\n'))).toEqual({ changed: [], deletedAfter: [0] });
    // A line taken out beside an edited one, and a block taken away with its body re-indented.
    expect(lineDiff(before, ['a', 'B', 'd', 'e'].join('\n'))).toEqual({ changed: [2], deletedAfter: [1] });
    const guarded = ['export function f(ok: boolean) {', '  if (!ok) {', '    a();', '    b();', '  }', '}'].join('\n');
    expect(lineDiff(guarded, ['export function f(ok: boolean) {', '  a();', '  b();', '}'].join('\n'))).toEqual({ changed: [2, 3], deletedAfter: [1] });
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
    // A head of the run where another placement of it would sit: `a(); c();` of the run at 7-10 slides over line 6.
    const body = ['b();', 'k();', 'c();', 'c();', 'c();', 'a();'];
    const fn = (lines: string[]) => ['export function f() {', ...lines.map(line => `  ${line}`), '}'].join('\n');
    expect(lineDiff(fn(body), fn([...body.slice(0, 5), 'a();', 'c();', 'b();', 'a();', ...body.slice(5)])).changed).toContain(6);
    // And for lines taken out: `c(); b();` taken from b b c b x x could have sat after line 0 too.
    expect(lineDiff(['b', 'b', 'c', 'b', 'x', 'x'].join('\n'), ['b', 'b', 'x', 'x'].join('\n')).deletedAfter).toContain(0);
  });

  it('counts every place a run added or taken out in one place could sit', () => {
    // Small texts over three lines: wherever the one text reads as the other with a run of as many lines added (or
    // taken out) in one place, those lines are counted (or that place named). It can count more: a line beside the
    // run that repeats one of its lines, though no shortest diff changes it (a b gaining b a counts the first a).
    const same = (x: string[], y: string[]) => x.join('\n') === y.join('\n');
    const lines = fc.array(fc.constantFrom('a', 'b', 'c'), { maxLength: 6 });
    const run = fc.array(fc.constantFrom('a', 'b', 'c'), { minLength: 1, maxLength: 4 });
    fc.assert(fc.property(lines, fc.nat(6), run, (a, at, added) => {
      const place = Math.min(at, a.length);
      const b = [...a.slice(0, place), ...added, ...a.slice(place)];
      const { changed, deletedAfter } = lineDiff(a.join('\n'), b.join('\n'));
      const r = added.length;
      for (let p = 0; p <= a.length; p++) {
        if (!same(b.slice(0, p), a.slice(0, p)) || !same(b.slice(p + r), a.slice(p))) continue;
        for (let k = 0; k < r; k++) expect(changed).toContain(p + k + 1);
      }
      // The same change the other way: b's lines taken out leave a.
      const back = lineDiff(b.join('\n'), a.join('\n')).deletedAfter;
      for (let q = 0; q <= a.length; q++) {
        if (!same(b.slice(0, q), a.slice(0, q)) || !same(b.slice(q + r), a.slice(q))) continue;
        expect(back).toContain(q);
      }
      expect(deletedAfter).toEqual([]);
    }), { numRuns: 500 });
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

  it('counts only the lines the diff changes, and names a changed line that can move the lines beside it', () => {
    const into = [
      'export function settle(ready: boolean, log: string[], lease: { release(): void }) {',
      '  if (ready) {',
      "    log.push('ready');",
      '  }',
      '  lease.release();',
      "  log.push('done');",
      '}',
    ];
    // The bracket moved below release(): release() now runs only when ready, and only the bracket line changed.
    const moved = [into[0], into[1], into[2], into[4], into[3], into[5], into[6]].join('\n');
    const { changed } = lineDiff(into.join('\n'), moved);
    expect(changed).toEqual([5]);
    expect(structureLines('src/a.ts', moved, changed)).toEqual([5]);
    // A closer with code of its own moved below report(): report() now runs in the loop, and only the closer changed.
    const loop = ['export function drain(q: { v: boolean }, report: () => void) {', '  do {', '    q.v = false;', '  } while (q.v);', '  report();', '}'];
    const down = [loop[0], loop[1], loop[2], loop[4], loop[3], loop[5]].join('\n');
    expect(lineDiff(loop.join('\n'), down).changed).toEqual([5]);
    expect(structureLines('src/a.ts', down, [5])).toEqual([5]);
    const lines = [
      'export function k(on: (f: () => void, g: () => void) => void, q: { v: boolean }, log: string[]) {', // 1
      '  on(() => {', // 2
      "    log.push('a');", // 3
      '  }, () => {', // 4
      '  });', // 5
      '  do {', // 6
      "    log.push('b');", // 7
      '  } while (q.v);', // 8
      '  Promise.resolve().then(() => {', // 9
      '  }).catch(e => log.push(String(e)));', // 10
      '  const o = {', // 11
      '    x: 1,', // 12
      '  };', // 13
      '  log.push(String(o.x),', // 14
      '  );', // 15
      '}', // 16
    ];
    // Brackets and separators only, or a brace of a block, code of its own or not (a header, a closer with a
    // condition or a call): not an object's brace or a line of code alone.
    expect(structureLines('src/a.ts', lines.join('\n'), lines.map((_, i) => i + 1))).toEqual([1, 2, 4, 5, 6, 8, 9, 10, 13, 15, 16]);
    // A line that opens the next part of a statement, with braces or none, mutants of its own or not: a default
    // only in a switch, never in an export or an object.
    const parts = [
      'export function p(n: string, b: boolean, log: string[]) {', // 1
      "  if (b) log.push('b');", // 2
      "  else log.push('c');", // 3
      '  switch (n) {', // 4
      "    case 'two': log.push('2'); break;", // 5
      "    default: log.push('d');", // 6
      '  }', // 7
      '  const d = { default: 1 };', // 8
      '  return d;', // 9
      '}', // 10
      'export default p;', // 11
    ];
    expect(structureLines('src/a.ts', parts.join('\n'), parts.map((_, i) => i + 1))).toEqual([1, 3, 4, 5, 6, 7, 10]);
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

  it('never mutates, through a link in src, a file that is not mutated: the suite\'s env scrub, say', () => {
    const plan = planChange({
      entries: [{ status: 'A', file: 'src/env.ts' }],
      untracked: ['src/config.ts'],
      read: () => 'export const x = 1;\n',
      readBase: () => '',
      nameOf: file => (file === 'src/env.ts' ? 'test/helpers/env.ts' : 'test/vitest.config.ts'),
    });
    expect(plan.targets).toEqual([]);
    expect(plan.skipped).toEqual([
      { file: 'src/env.ts', why: 'a link to test/helpers/env.ts, which is not mutated: outside src' },
      { file: 'src/config.ts', why: 'a link to test/vitest.config.ts, which is not mutated: outside src' },
    ]);
    // On disk, through git: a link to a dir (a junction on Windows, which git walks into).
    const { repo, plan: fromGit } = repoWith({ 'src/a.ts': text(lines('a', 2)), 'test/helpers/env.ts': text(lines('e', 2)) });
    fs.symlinkSync(path.join(repo, 'test', 'helpers'), path.join(repo, 'src', 'link'), 'junction');
    onTestFinished(() => fs.unlinkSync(path.join(repo, 'src', 'link')));
    expect(fromGit().targets.filter(target => !target.file.startsWith('src/'))).toEqual([]);
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

  it('refuses, in a test and in a child, a fork whose own env lacks DATA_DIR (helpers/forkGuard.cjs)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-fork-'));
    onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
    const script = path.join(dir, 'done.cjs');
    fs.writeFileSync(script, 'process.exit(0);\n');
    // In this test: through require and through an ES import, as src's `import { fork }` reads it.
    const required = createRequire(__filename)('child_process') as typeof import('child_process');
    const imported = await import('child_process');
    for (const cp of [required, imported]) {
      expect(() => cp.fork(script, [], { env: { PATH: process.env.PATH } })).toThrow(/lacks DATA_DIR/);
      expect(() => cp.fork(script, { env: {} })).toThrow(/lacks DATA_DIR/);
    }
    const forked = imported.fork(script, [], { env: { ...process.env }, stdio: 'ignore' });
    expect(await new Promise(resolve => forked.on('exit', resolve))).toBe(0);
    // In a child that preloads it, as helpers/child.ts starts every scenario step.
    const child = path.join(dir, 'child.cjs');
    fs.writeFileSync(child, `require('child_process').fork(${JSON.stringify(script)}, [], { env: {} });\n`);
    const guard = path.join(botRoot, 'test', 'helpers', 'forkGuard.cjs');
    const run = spawnSync(process.execPath, ['--require', guard, child], { encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('lacks DATA_DIR would take /data as its data root');
    // In an ES module that took child_process's exports before the guard loaded.
    const early = path.join(dir, 'early.mjs');
    fs.writeFileSync(early, [
      "import * as cp from 'child_process';",
      "import { createRequire } from 'module';",
      `createRequire(import.meta.url)(${JSON.stringify(guard)});`,
      `cp.fork(${JSON.stringify(script)}, [], { env: {} });`,
      '',
    ].join('\n'));
    const esm = spawnSync(process.execPath, [early], { encoding: 'utf8' });
    expect(esm.status).not.toBe(0);
    expect(esm.stderr).toContain('lacks DATA_DIR would take /data as its data root');
  });

  it('ends a child step past its bound with every process it started (helpers/child.ts)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-bound-'));
    onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
    const pidFile = path.join(dir, 'started.pid');
    await expect(runScenario('startsAndHangs.cjs', [pidFile], dir, 4000)).rejects.toThrow('did not finish in 4000 ms');
    const started = Number(fs.readFileSync(pidFile, 'utf8'));
    const alive = () => { try { process.kill(started, 0); return true; } catch { return false; } };
    onTestFinished(() => { if (alive()) process.kill(started, 'SIGKILL'); });
    for (let i = 0; i < 50 && alive(); i++) await new Promise(resolve => setTimeout(resolve, 100));
    expect(alive()).toBe(false);
  });

  it('looks at every file itself, whatever a file-system monitor says', () => {
    const { repo, git, write, plan } = repoWith({ 'src/a.ts': text(lines('a', 3)), 'src/b.ts': text(lines('b', 3)) });
    // A monitor (protocol 2) that says nothing changed but a.ts.
    const hook = path.join(repo, '.git', 'monitor.sh');
    fs.writeFileSync(hook, "#!/bin/sh\nprintf 'token\\0src/a.ts\\0'\n");
    fs.chmodSync(hook, 0o755);
    git(['config', 'core.fsmonitor', hook.split(path.sep).join('/')]);
    git(['config', 'core.fsmonitorHookVersion', '2']);
    git(['update-index', '--fsmonitor']);
    git(['status', '--porcelain']);
    for (const name of ['a', 'b']) write(`src/${name}.ts`, text(lines(name, 3).map((line, i) => (i === 1 ? `${line} // edited` : line))));
    // git itself misses b.ts here.
    expect(git(['diff', '--name-only'])).not.toContain('src/b.ts');
    expect(plan().targets.map(t => t.file).sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('lets into a sandbox only the files git lists: nothing it ignores, nothing of a repository inside, nothing made later', async () => {
    const sub = repoWith({ '.gitignore': '.env\n', 'index.ts': text(lines('s', 2)) });
    const odd = 'src/[id] {1,2} (x) !y #z +(w) @(v).ts';
    const { repo, git, write } = repoWith({ '.gitignore': '.env\nnode_modules/\nbackup*/\n', 'src/a.ts': text(lines('a', 3)), [odd]: text(lines('o', 1)) });
    git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.repo.split(path.sep).join('/'), 'src/sub']);
    write('.env', 'TOKEN=x\n');
    write('node_modules/x/index.js', '');
    write('backup[1]/.env', 'TOKEN=z\n');
    write('src/fresh/b.ts', text(lines('b', 2)));
    write('src/sub/.env', 'TOKEN=s\n');
    write('src/mod/index.ts', text(lines('m', 2)));
    git(['-C', path.join(repo, 'src', 'mod'), 'init', '-q']);
    // A file git tracks in a node_modules dir, which Stryker links into the sandbox instead.
    write('lib/node_modules/v/index.js', '');
    git(['add', '-f', 'lib/node_modules/v/index.js']);
    // The gate's list (touched.mjs treeFiles): the tracked files, and the untracked ones git does not ignore.
    const listed = git(['-c', 'core.quotePath=false', 'ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
    const { patterns, unkept } = sandboxPatterns(listed);
    expect(unkept).toEqual([]);
    // Made after the list: a .env, a data dir, an untracked file.
    write('src/.env', 'TOKEN=late\n');
    write('data/state.json', '{}');
    write('src/late.ts', text(lines('l', 1)));
    // What Stryker's own crawl copies under these patterns.
    const core = path.dirname(createRequire(__filename).resolve('@stryker-mutator/core/package.json'));
    // Stryker's entry first: its modules need to load in its own order.
    await import(pathToFileURL(path.join(core, 'dist', 'src', 'index.js')).href);
    const { ProjectReader } = await import(pathToFileURL(path.join(core, 'dist', 'src', 'fs', 'project-reader.js')).href);
    const quiet = { warn() {}, info() {}, debug() {} };
    const reader = new ProjectReader(fs.promises, quiet, {
      mutate: [], tempDirName: '.stryker-tmp', ignorePatterns: patterns, incremental: false, incrementalFile: 'reports/stryker-incremental.json', force: false,
      htmlReporter: { fileName: 'reports/mutation/mutation.html' }, jsonReporter: { fileName: 'reports/mutation/mutation.json' }, testFiles: [],
    });
    const cwd = process.cwd();
    process.chdir(repo);
    let copied: string[];
    try {
      copied = ((await reader.resolveInputFileNames()) as string[]).map(file => path.relative(repo, file).split(path.sep).join('/')).sort();
    } finally {
      process.chdir(cwd);
    }
    expect(copied).toEqual(['.gitignore', '.gitmodules', odd, 'src/a.ts', 'src/fresh/b.ts'].sort());
    // Each name escaped as Stryker's matcher reads it, on Linux and on Windows; one it still cannot match is named.
    const BS = String.fromCharCode(92);
    const names = [`a${BS}b.ts`, `m{1}${BS}2.ts`, 'x{a,b}.ts', 'backup[1]/a.ts', 'src/mod/'];
    const ranges = pathToFileURL(path.join(botRoot, 'test', 'mutation', 'ranges.mjs')).href;
    for (const [platform, left] of [['linux', [`m{1}${BS}2.ts`]], ['win32', [`a${BS}b.ts`, `m{1}${BS}2.ts`]]] as const) {
      const run = spawnSync(process.execPath, ['--input-type=module', '-e',
        `import { sandboxPatterns } from ${JSON.stringify(ranges)}; console.log(JSON.stringify(sandboxPatterns(JSON.parse(process.env.SMDB_NAMES))));`],
      { encoding: 'utf8', env: { ...process.env, __MINIMATCH_TESTING_PLATFORM__: platform, SMDB_NAMES: JSON.stringify(names) } });
      const result = JSON.parse(run.stdout) as { patterns: string[], unkept: string[] };
      expect(result.unkept, platform).toEqual(left);
      expect(result.patterns, platform).toContain(`!/backup${BS}[1${BS}]/a.ts`);
      expect(result.patterns.length, platform).toBe(1 + names.length - 1 - left.length);
    }
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
// of its body), and the emptying of the body of a compound statement or
// declaration, or of a bare block, that only begins or ends on the line (a
// changed `if (...) {`, signature or closing brace: making it would bring in
// the whole body), and the false condition of a for with no condition, which
// spans the loop. Every other body's emptying is made (a callback's, a case
// clause's block, a method of an object or a class expression), and what is
// not made is checked not to be.
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
      // The bodies of compound statements and declarations, and bare blocks: never a callback's body, a case
      // clause's block, or the body of a method or accessor of an object or a class expression, each taken whole.
      const bodies = new Set<string>();
      // Each for with no condition, whose false condition Stryker makes over the whole loop.
      const loops = new Set<string>();
      const inExpression = (node: ts.Node) => (ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node) || ts.isConstructorDeclaration(node))
        && (ts.isObjectLiteralExpression(node.parent) || ts.isClassExpression(node.parent));
      const walk = (node: ts.Node) => {
        if (ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseBlock(node)) blocks.push({ start: node.getStart(sf), end: node.getEnd() });
        if (ts.isBlock(node) && !ts.isArrowFunction(node.parent) && !ts.isFunctionExpression(node.parent) && !ts.isCaseClause(node.parent)
          && !ts.isDefaultClause(node.parent) && !inExpression(node.parent)) {
          bodies.add(`${node.getStart(sf)}-${node.getEnd()}`);
        }
        const lineAt = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line;
        if (ts.isForStatement(node) && !node.condition && lineAt(node.getStart(sf)) < lineAt(node.getEnd())) loops.add(`${node.getStart(sf)}-${node.getEnd()}`);
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
        const spanOf = (m: Made) => `${at(m.location.start)}-${at(m.location.end)}`;
        const braceOnly = (m: Made) => m.mutatorName === 'BlockStatement' && m.location.start.line < m.location.end.line && bodies.has(spanOf(m));
        const loopCondition = (m: Made) => m.mutatorName === 'ConditionalExpression' && loops.has(spanOf(m));
        const touching = whole.filter(m => m.location.start.line + 1 <= n && n <= m.location.end.line + 1 && !throughBlock(m));
        const expected = touching.filter(m => !braceOnly(m) && !loopCondition(m));
        const ranges = rangesOf(text, [n]) ?? [];
        const mutate = ranges.map(([s, e]) => ({ start: { line: s - 1, column: 0 }, end: { line: e - 1, column: Number.MAX_SAFE_INTEGER } }));
        const here = await made(text, mutate);
        const got = new Set(here.map(key));
        const missing = expected.filter(m => !got.has(key(m))).map(m => `${m.mutatorName} ${key(m)}`);
        expect(missing, `${name} line ${n}: ${code.trim()}`).toEqual([]);
        // And what the README says is not made, is not.
        const unmade = touching.filter(m => (braceOnly(m) || loopCondition(m)) && got.has(key(m))).map(m => `${m.mutatorName} ${key(m)}`);
        expect(unmade, `${name} line ${n}: ${code.trim()}`).toEqual([]);
        const through = whole.filter(m => m.location.start.line + 1 <= n && n <= m.location.end.line + 1 && throughBlock(m) && got.has(key(m)));
        expect(through.map(m => `${m.mutatorName} ${key(m)}`), `${name} line ${n}: ${code.trim()}`).toEqual([]);
        checked += expected.length;
        // The file taken whole names the line exactly when the line changed alone would.
        expect(untouched(name, text, [n], spansOf(whole)), `${name} line ${n}: ${code.trim()}`).toEqual(untouched(name, text, [n], spansOf(here)));
      }
      expect(checked).toBeGreaterThan(lines.length / 4);
    });
  }

  it("gates only what the changed lines make by themselves: what a deletion's neighbour brings in is context", async () => {
    const base = [
      "import { Router } from 'express';",
      'export const router = Router();',
      "router.get('/x', async (req, res) => {",
      '  const id = String(req.query.id);',
      '  res.json({ ok: true, id });',
      '});',
    ];
    // The handler's first line taken out and the next one edited: one hunk, two lines out and one in.
    const text = [base[0], base[1], base[2], '  res.json({ ok: false });', base[5]].join('\n');
    const change = lineDiff(base.join('\n'), text);
    expect(change).toEqual({ changed: [4], deletedAfter: [3] });
    const target = changeTarget('src/a.ts', text, change)!;
    const here = await made(text, target.ranges!.map(([s, e]) => ({ start: { line: s - 1, column: 0 }, end: { line: e - 1, column: Number.MAX_SAFE_INTEGER } })));
    const loc = (m: Made) => ({ start: { line: m.location.start.line + 1, column: m.location.start.column + 1 }, end: { line: m.location.end.line + 1, column: m.location.end.column + 1 } });
    // The neighbour (the route's header) takes the whole route, so the handler's emptying is made, and is context.
    const body = here.find(m => m.mutatorName === 'BlockStatement' && m.location.start.line + 1 === 3);
    expect(body).toBeDefined();
    expect(gates(target, loc(body!))).toBe(false);
    const gating = here.filter(m => gates(target, loc(m)));
    expect(gating.length).toBeGreaterThan(0);
    expect(gating.every(m => m.location.start.line + 1 === 4 && m.location.end.line + 1 === 4)).toBe(true);
  });

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

  it('widens a pure deletion to its neighbours as context only, and says where it was', () => {
    expect(changeTarget('src/a.ts', SAMPLE, { changed: [], deletedAfter: [3] })).toEqual({ file: 'src/a.ts', ranges: [[2, 4]], gating: [], patterns: ['src/a.ts:2-4'], deleted: [3], own: [] });
    expect(changeTarget('src/a.ts', SAMPLE, { changed: [7], deletedAfter: [] })).not.toHaveProperty('deleted');
    expect(changeTarget('src/a.ts', SAMPLE, { changed: [7], deletedAfter: [] })).not.toHaveProperty('own');
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
