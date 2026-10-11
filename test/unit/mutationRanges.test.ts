import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import ts from 'typescript';
import { describe, expect, it, onTestFinished } from 'vitest';
import { codeLines, diffArgs, gates, linesOfTarget, mergeRanges, notMutated, parseDiff, patternsOf, planTargets, untouched } from '../mutation/ranges.mjs';

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

const rangesOf = (text: string, lines: number[]) =>
  planTargets({ diff: [{ file: 'src/a.ts', changed: lines, deletedAfter: [] }], untracked: [], read: () => text }).targets[0]?.ranges;

describe('the diff reader', () => {
  it('takes changed lines and deletions per file, with an omitted count meaning one line', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1..2 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -3 +3 @@ x',
      '-old',
      '+new',
      '@@ -10,2 +10,0 @@',
      '-gone',
      '-gone too',
      '@@ -20,0 +19,3 @@',
      '+++ this added line is content, not a header',
      '+b',
      '+c',
      'diff --git a/src/b.ts b/src/b.ts',
      'deleted file mode 100644',
      '--- a/src/b.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-x',
      '-y',
      // git ends a name holding a space with a tab, and quotes one holding a quote.
      'diff --git a/src/odd name.ts b/src/odd name.ts',
      '--- a/src/odd name.ts\t',
      '+++ b/src/odd name.ts\t',
      '@@ -1 +1,2 @@',
      '-x',
      '+y',
      '+z',
      'diff --git "a/src/quote\\"d.ts" "b/src/quote\\"d.ts"',
      '--- "a/src/quote\\"d.ts"',
      '+++ "b/src/quote\\"d.ts"',
      '@@ -4 +4 @@',
      '-a',
      '+b',
    ].join('\n');
    expect(parseDiff(diff)).toEqual([
      { file: 'src/a.ts', changed: [3, 19, 20, 21], deletedAfter: [10] },
      { file: 'src/odd name.ts', changed: [1, 2], deletedAfter: [] },
      { file: 'src/quote"d.ts', changed: [4], deletedAfter: [] },
    ]);
  });

  it("reads git's own output the same whatever the user's diff config says", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-diff-'));
    onTestFinished(() => fs.rmSync(repo, { recursive: true, force: true }));
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
    git('init', '-q');
    fs.mkdirSync(path.join(repo, 'src'));
    const body = Array.from({ length: 30 }, (_, i) => `export const v${i} = ${i};`);
    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), `${body.join('\n')}\n`);
    fs.writeFileSync(path.join(repo, 'src', 'odd name.ts'), 'export const o = 1;\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    fs.writeFileSync(path.join(repo, 'src', 'odd name.ts'), 'export const o = 2;\n');
    const base = git('rev-parse', 'HEAD').trim();
    // Line 3 and line 6 change; a new file is a near copy of a.ts, staged.
    const changed = body.map((line, i) => (i === 2 || i === 5 ? line.replace('= ', '= 100 + ') : line));
    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), `${changed.join('\n')}\n`);
    fs.writeFileSync(path.join(repo, 'src', 'b.ts'), `${[...body, 'export const extra = 1;'].join('\n')}\n`);
    git('add', 'src/b.ts');
    const hostile = ['-c', 'diff.mnemonicPrefix=true', '-c', 'diff.noprefix=true', '-c', 'diff.renames=copies', '-c', 'diff.interHunkContext=10', '-c', 'diff.relative=true'];
    const plain = parseDiff(git(...diffArgs(base)));
    expect(parseDiff(git(...hostile, ...diffArgs(base)))).toEqual(plain);
    expect(plain.find(f => f.file === 'src/a.ts')?.changed).toEqual([3, 6]);
    expect(plain.find(f => f.file === 'src/b.ts')?.changed.length).toBeGreaterThan(0);
    expect(plain.find(f => f.file === 'src/odd name.ts')?.changed).toEqual([1]);
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
    expect(codeLines('src/a.ts', text, Array.from({ length: 25 }, (_, i) => i + 1))).toEqual([1, 2, 3, 4, 6, 7, 8, 10, 14, 16, 19, 20, 21, 22, 24]);
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
});

describe('the targets', () => {
  const read = (file: string) => (file === 'src/a.ts' ? SAMPLE : 'export const x = 1;\nexport const y = 2;\n');

  it('names every changed file it does not mutate, and why', () => {
    const plan = planTargets({
      diff: [
        { file: 'src/webui/public/app.jsx', changed: [1], deletedAfter: [] },
        { file: 'src/bot/types.d.ts', changed: [1], deletedAfter: [] },
        { file: 'src/bot/modules/x/module.json', changed: [1], deletedAfter: [] },
        { file: 'src/a.ts', changed: [], deletedAfter: [] },
      ],
      untracked: ['src/webui/public/new.js', 'src/new.ts'],
      read,
    });
    expect(plan.skipped.map(s => s.file)).toEqual(['src/webui/public/app.jsx', 'src/bot/types.d.ts', 'src/bot/modules/x/module.json', 'src/a.ts', 'src/webui/public/new.js']);
    expect(plan.skipped.every(s => s.why.length > 0)).toBe(true);
    expect(plan.targets).toEqual([{ file: 'src/new.ts', ranges: null, gating: null }]);
    expect(patternsOf(plan.targets[0])).toEqual(['src/new.ts']);
    expect(notMutated('test/x.ts')).toBe('outside src');
  });

  it('answers for every line a whole file or a pattern covers, and for the changed lines of a diff', () => {
    expect(linesOfTarget({ gating: [3, 7], patterns: ['src/a.ts:2-9'] }, 11)).toEqual([3, 7]);
    expect(linesOfTarget({ gating: null, patterns: ['src/new.ts'] }, 4)).toEqual([1, 2, 3, 4]);
    expect(linesOfTarget({ gating: null, patterns: ['src/a.ts:3-5', 'src/a.ts:5:2-6:9', 'src/a.ts:10-99'] }, 11)).toEqual([3, 4, 5, 6, 10, 11]);
  });

  it('widens a pure deletion to its neighbours as context only', () => {
    const plan = planTargets({ diff: [{ file: 'src/a.ts', changed: [], deletedAfter: [3] }], untracked: [], read });
    expect(plan.targets).toEqual([{ file: 'src/a.ts', ranges: [[2, 4]], gating: [] }]);
  });

  it('gates the mutants that touch a changed line, and calls the rest context', () => {
    const plan = planTargets({ diff: [{ file: 'src/a.ts', changed: [7], deletedAfter: [] }], untracked: [], read });
    const [target] = plan.targets;
    expect(patternsOf(target)).toEqual(['src/a.ts:6-9']);
    const at = (start: number, end: number) => ({ start: { line: start, column: 1 }, end: { line: end, column: 1 } });
    expect(gates(target, at(7, 7))).toBe(true);
    expect(gates(target, at(6, 9))).toBe(true);
    expect(gates(target, at(8, 8))).toBe(false);
    expect(gates({ gating: null }, at(1, 1))).toBe(true);
  });
});
