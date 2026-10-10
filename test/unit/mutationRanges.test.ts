import { describe, expect, it } from 'vitest';
import { blockFreeSpans, gates, mergeRanges, notMutated, parseDiff, patternsOf, planTargets, widen } from '../mutation/ranges.mjs';

// The touched-line ranges of the L5 script (mutation/README.md): which lines a
// change touched, and how far each widens so Stryker makes the mutants that
// touch it.

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

const rangesFor = (lines: number[]) => widen(blockFreeSpans('src/a.ts', SAMPLE), lines);

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
      'diff --git "a/src/odd name.ts" "b/src/odd name.ts"',
      '--- "a/src/odd name.ts"',
      '+++ "b/src/odd name.ts"',
      '@@ -1 +1,2 @@',
      '-x',
      '+y',
      '+z',
    ].join('\n');
    expect(parseDiff(diff)).toEqual([
      { file: 'src/a.ts', changed: [3, 19, 20, 21], deletedAfter: [10] },
      { file: 'src/odd name.ts', changed: [1, 2], deletedAfter: [] },
    ]);
  });
});

describe('the widening', () => {
  it('takes a whole multi-line condition when one of its lines changed, but not the body it guards', () => {
    expect(rangesFor([3])).toEqual([[2, 3]]);
    expect(rangesFor([2])).toEqual([[2, 3]]);
  });

  it('keeps a changed line in a body to its own statement', () => {
    expect(rangesFor([4])).toEqual([[4, 4]]);
    expect(rangesFor([10])).toEqual([[10, 10]]);
  });

  it('takes a whole statement that holds no block, and stops at a function body inside one', () => {
    expect(rangesFor([7])).toEqual([[6, 9]]);
    // An arrow with an expression body holds no block, so the statement is still whole.
    expect(rangesFor([8])).toEqual([[6, 9]]);
  });

  it('keeps a changed signature to the signature, and a closing brace to its line', () => {
    expect(rangesFor([1])).toEqual([[1, 1]]);
    expect(rangesFor([5])).toEqual([[5, 5]]);
  });

  it('joins ranges that meet, since Stryker needs one range to hold a whole mutant', () => {
    expect(rangesFor([3, 4])).toEqual([[2, 4]]);
    expect(mergeRanges([[9, 9], [1, 2], [3, 3], [5, 7], [6, 8]])).toEqual([[1, 3], [5, 9]]);
  });

  it('stops at a block-bodied function inside a statement', () => {
    const text = ['const g = (x: number) => {', '  return x;', '};'].join('\n');
    expect(widen(blockFreeSpans('src/g.ts', text), [1])).toEqual([[1, 1]]);
    expect(widen(blockFreeSpans('src/g.ts', text), [2])).toEqual([[2, 2]]);
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
