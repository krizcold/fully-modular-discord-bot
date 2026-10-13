// Which lines a change touched, which files it mutates, and the Stryker mutate
// ranges that cover them (VERIFY.md L5). git only names the files that changed
// and gives their text at the base; the changed lines come from the gate's own
// line diff (lineDiff), so no git setting, attribute or variable moves them.
// The caller runs git.
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import ts from 'typescript';
import { canonicalName } from './keys.mjs';

// Stryker's own copy of minimatch, which it matches mutate patterns with.
const strykerRequire = createRequire(createRequire(import.meta.url).resolve('@stryker-mutator/core/package.json'));
const { Minimatch, minimatch, escape } = strykerRequire('minimatch');

/**
 * @typedef {[number, number]} Range first and last line, 1-based
 * @typedef {{ status: string, file: string, from?: string }} Entry a file git names as changed; from: a rename's old name
 * @typedef {{ file: string, ranges: Range[] | null, gating: number[] | null, patterns: string[], deleted?: number[], own?: Range[] }} Target
 *   ranges null: the whole file; deleted: where lines were taken out with fewer or none put back, each after the line
 *   named (0: the top); own: the ranges the changed lines widen to by themselves, when a deletion's neighbours widen too
 * @typedef {{ start: { line: number, column: number }, end: { line: number, column: number } }} Location
 */

const CODE = /\.(ts|tsx|js|cjs|mjs)$/;
const DECLARATION = /\.d\.ts$/;
const VIEWS = 'src/webui/public/';

/**
 * Why a changed file gets no mutants, or null when it gets them.
 * @param {string} file
 * @returns {string | null}
 */
export function notMutated(file) {
  if (!file.startsWith('src/')) return 'outside src';
  if (file.startsWith(VIEWS)) return 'a browser view: copied into dist, never compiled, and no test loads it';
  if (DECLARATION.test(file) || !CODE.test(file)) return 'not code';
  return null;
}

// Line breaks TypeScript and Stryker's parser count but the line diff does not:
// in a file that holds one, the diff's line numbers and theirs disagree after it.
const EXTRA_BREAK = /\r(?!\n)|[\u2028\u2029]/;
export const EXTRA_BREAK_WHY = 'it holds a line break Stryker counts and the gate does not (a lone CR, U+2028 or U+2029), so its lines cannot be matched to the change; make it a plain line feed or an escape';

/** @param {string} text */
export const holdsExtraBreak = text => EXTRA_BREAK.test(text);

export const DATA_ROUTE_WHY = "it reads DATA_DIR or holds the '/data' fallback, so a mutant of it could send the tests to /data, on a developer's machine a real data root and anywhere else one the run would make";

/**
 * Whether a file's code names the DATA_DIR variable or holds '/data' as a
 * string or a template's head: a mutant of it (a check of DATA_DIR made false,
 * the fallback chosen) could send the tests to '/data', so the gate never
 * mutates it.
 * @param {string} file
 * @param {string} text
 */
export function holdsDataRoute(file, text) {
  let found = false;
  /** @param {ts.Node} node */
  const walk = node => {
    if (ts.isIdentifier(node) && node.text === 'DATA_DIR') found = true;
    else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)) && /^(DATA_DIR|\/data\/?)$/.test(node.text)) found = true;
    else if (!found) ts.forEachChild(node, walk);
  };
  walk(parse(file, text));
  return found;
}

/**
 * A text's lines, split at LF or CRLF, without the empty one after a final break.
 * @param {string} text
 */
function splitLines(text) {
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Where an optimal path through the edit graph of a[aLo, aHi) and b[bLo, bHi)
 * crosses its middle, as [i, j] (Myers' O(ND) bisection, run from both ends at
 * once, as diff-match-patch does it), or null when the two share no line.
 * @param {string[]} a
 * @param {number} aLo
 * @param {number} aHi
 * @param {string[]} b
 * @param {number} bLo
 * @param {number} bHi
 * @returns {[number, number] | null}
 */
function bisect(a, aLo, aHi, b, bLo, bHi) {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const maxD = Math.ceil((n + m) / 2);
  const size = 2 * maxD;
  const v1 = new Int32Array(size).fill(-1);
  const v2 = new Int32Array(size).fill(-1);
  v1[maxD + 1] = 0;
  v2[maxD + 1] = 0;
  const delta = n - m;
  const front = delta % 2 !== 0;
  let k1start = 0;
  let k1end = 0;
  let k2start = 0;
  let k2end = 0;
  for (let d = 0; d < maxD; d++) {
    for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
      const i1 = maxD + k1;
      let x1 = k1 === -d || (k1 !== d && v1[i1 - 1] < v1[i1 + 1]) ? v1[i1 + 1] : v1[i1 - 1] + 1;
      let y1 = x1 - k1;
      while (x1 < n && y1 < m && a[aLo + x1] === b[bLo + y1]) { x1++; y1++; }
      v1[i1] = x1;
      if (x1 > n) k1end += 2;
      else if (y1 > m) k1start += 2;
      else if (front) {
        const i2 = maxD + delta - k1;
        if (i2 >= 0 && i2 < size && v2[i2] !== -1 && x1 >= n - v2[i2]) return [aLo + x1, bLo + y1];
      }
    }
    for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
      const i2 = maxD + k2;
      let x2 = k2 === -d || (k2 !== d && v2[i2 - 1] < v2[i2 + 1]) ? v2[i2 + 1] : v2[i2 - 1] + 1;
      let y2 = x2 - k2;
      while (x2 < n && y2 < m && a[aHi - 1 - x2] === b[bHi - 1 - y2]) { x2++; y2++; }
      v2[i2] = x2;
      if (x2 > n) k2end += 2;
      else if (y2 > m) k2start += 2;
      else if (!front) {
        const i1 = maxD + delta - k2;
        if (i1 >= 0 && i1 < size && v1[i1] !== -1 && v1[i1] >= n - x2) return [aLo + v1[i1], bLo + v1[i1] - (delta - k2)];
      }
    }
  }
  return null;
}

/**
 * Pairs [i, j] of equal lines a[i] === b[j], rising in both, as many as any
 * such list can hold: a longest common subsequence, so the lines left over are
 * a shortest edit (Myers' algorithm, in linear space).
 * @param {string[]} a
 * @param {string[]} b
 * @returns {[number, number][]}
 */
export function commonLines(a, b) {
  /** @type {[number, number][]} */
  const pairs = [];
  /**
   * @param {number} aLo
   * @param {number} aHi
   * @param {number} bLo
   * @param {number} bHi
   */
  const solve = (aLo, aHi, bLo, bHi) => {
    while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) pairs.push([aLo++, bLo++]);
    /** @type {[number, number][]} */
    const tail = [];
    while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) tail.push([--aHi, --bHi]);
    const split = aLo < aHi && bLo < bHi ? bisect(a, aLo, aHi, b, bLo, bHi) : null;
    if (split) {
      solve(aLo, split[0], bLo, split[1]);
      solve(split[0], aHi, split[1], bHi);
    }
    pairs.push(...tail.reverse());
  };
  solve(0, a.length, 0, b.length);
  return pairs;
}

/**
 * What changed from `before` to `after`, as lines of `after` (from 1): the
 * lines no longest common subsequence of the two keeps, and the lines after
 * which lines of `before` were taken out with fewer or none put back (0:
 * before the first line; a line replaced one for one is only changed). Lines
 * end at LF or CRLF, so line endings alone change nothing. The lines added in
 * one place, or only taken out, count also over each unchanged line beside
 * them that repeats one of them, and on through each further one that does (an
 * `if` block added after an equal one counts in both places): every place
 * their first or last lines, or the whole run, could slide to passes only such
 * lines. The window starts from each piece the diff makes, and another change
 * in the file can split a run into pieces, so then which copy counts is the
 * diff's choice. A line kept counts only where the diff marks it, even when a
 * change moves it into or out of a block (mutation/README.md).
 * @param {string} before
 * @param {string} after
 * @returns {{ changed: number[], deletedAfter: number[] }}
 */
export function lineDiff(before, after) {
  const a = splitLines(before);
  const b = splitLines(after);
  const pairs = commonLines(a, b);
  const partner = new Int32Array(a.length).fill(-1);
  for (const [i, j] of pairs) partner[i] = j;
  /** @type {Set<number>} */
  const changed = new Set();
  /** @type {Set<number>} */
  const deletedAfter = new Set();
  let pi = -1;
  let pj = -1;
  for (const [i, j] of [...pairs, [a.length, b.length]]) {
    const [i0, i1, j0, j1] = [pi + 1, i, pj + 1, j];
    for (let k = j0; k < j1; k++) changed.add(k + 1);
    // The unchanged lines beside the lines added, up and down, while each
    // repeats one of them.
    const added = new Set(b.slice(j0, j1));
    for (let t = 1; i0 - t >= 0 && partner[i0 - t] === j0 - t && added.has(b[j0 - t]); t++) changed.add(j0 - t + 1);
    for (let t = 0; i1 + t < a.length && partner[i1 + t] === j1 + t && added.has(b[j1 + t]); t++) changed.add(j1 + t + 1);
    if (j1 === j0 && i1 > i0) {
      // Taken out only: the same, for the places in `after` where it could have been.
      deletedAfter.add(j0);
      const taken = new Set(a.slice(i0, i1));
      for (let t = 1; i0 - t >= 0 && partner[i0 - t] === j0 - t && taken.has(a[i0 - t]); t++) deletedAfter.add(j0 - t);
      for (let t = 0; i1 + t < a.length && partner[i1 + t] === j0 + t && taken.has(a[i1 + t]); t++) deletedAfter.add(j0 + t + 1);
    } else if (i1 - i0 > j1 - j0) {
      // More taken out than put back (a line deleted beside an edited one, a block taken away and its body re-indented).
      deletedAfter.add(j0);
    }
    pi = i;
    pj = j;
  }
  /** @param {Set<number>} set */
  const sorted = set => [...set].sort((x, y) => x - y);
  return { changed: sorted(changed), deletedAfter: sorted(deletedAfter) };
}

/**
 * Reads `git diff --name-status -z` output.
 * @param {string} text
 * @returns {Entry[]}
 */
export function parseNameStatus(text) {
  const fields = text.split('\0');
  /** @type {Entry[]} */
  const entries = [];
  for (let i = 0; i < fields.length && fields[i] !== '';) {
    const status = fields[i][0];
    if (status === 'R' || status === 'C') {
      entries.push({ status, from: fields[i + 1], file: fields[i + 2] });
      i += 3;
    } else {
      entries.push({ status, file: fields[i + 1] });
      i += 2;
    }
  }
  return entries;
}

/**
 * Sorted, with overlapping or adjacent ranges joined: Stryker makes a mutant
 * only when one range holds all of it, so two ranges that meet must be one.
 * @param {Range[]} ranges
 * @returns {Range[]}
 */
export function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  /** @type {Range[]} */
  const out = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

// Statement lists in braces: a line wholly inside one widens by the statements in it.
const CONTAINERS = new Set([ts.SyntaxKind.Block, ts.SyntaxKind.ModuleBlock, ts.SyntaxKind.CaseBlock]);
// Statements and declarations whose parts (a condition, the parameters, a
// catch variable) widen apart from the bodies they hold.
const COMPOUND = new Set([
  ts.SyntaxKind.IfStatement, ts.SyntaxKind.DoStatement, ts.SyntaxKind.WhileStatement, ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement, ts.SyntaxKind.ForOfStatement, ts.SyntaxKind.SwitchStatement, ts.SyntaxKind.TryStatement,
  ts.SyntaxKind.CatchClause, ts.SyntaxKind.LabeledStatement, ts.SyntaxKind.WithStatement, ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.ClassDeclaration, ts.SyntaxKind.MethodDeclaration, ts.SyntaxKind.Constructor, ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor, ts.SyntaxKind.ModuleDeclaration, ts.SyntaxKind.ClassStaticBlockDeclaration,
]);

/**
 * @param {string} file
 * @param {string} text
 */
function parse(file, text) {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

/**
 * The spans one line widens to: the statement it sits in, taken whole even
 * when a block-bodied callback sits inside it, so every mutant of a changed
 * operator, condition or call exists. The header of a compound statement or
 * declaration (a condition, a signature, a catch) widens to that header only,
 * never to its body; any other line holding a callback's start or end (a
 * route's header, a `});`) takes its whole statement, the callback's body
 * included. A line wholly inside a body widens within that body.
 * @param {ts.SourceFile} sf
 * @param {number} line 1-based
 * @returns {Range[]}
 */
function unitsOf(sf, line) {
  const starts = sf.getLineStarts();
  const lineStart = starts[line - 1];
  const code = sf.text.slice(lineStart, line < starts.length ? starts[line] : sf.text.length);
  const first = code.search(/\S/);
  if (first < 0) return [];
  const span = { start: lineStart + first, end: lineStart + code.trimEnd().length };
  /** @param {number} pos */
  const lineOf = pos => sf.getLineAndCharacterOfPosition(pos).line + 1;
  /** @type {Range[]} */
  const units = [];
  /** @param {ts.Node} node */
  const overlaps = node => node.getStart(sf) < span.end && node.getEnd() > span.start;
  /** @param {ts.Node} node */
  const holdsLine = node => CONTAINERS.has(node.kind) && node.getStart(sf) < span.start && span.end < node.getEnd();
  /**
   * The innermost statement list below node whose braces hold the whole line.
   * @param {ts.Node} node
   * @returns {ts.Node | null}
   */
  const innermost = node => {
    /** @type {ts.Node | null} */
    let found = null;
    ts.forEachChild(node, child => {
      if (found || child.getStart(sf) > span.start || child.getEnd() < span.end) return;
      found = innermost(child) ?? (holdsLine(child) ? child : null);
    });
    return found;
  };
  /** @param {ts.Node} node */
  const visit = node => {
    ts.forEachChild(node, child => {
      if (!overlaps(child)) return;
      if (CONTAINERS.has(child.kind) || COMPOUND.has(child.kind)) { visit(child); return; }
      const inner = innermost(child);
      if (inner) visit(inner);
      else units.push([lineOf(child.getStart(sf)), lineOf(child.getEnd())]);
    });
  };
  visit(sf);
  return units;
}

/**
 * The merged ranges for a file's changed lines (each line itself, plus what it widens to).
 * @param {string} file
 * @param {string} text
 * @param {number[]} lines
 * @returns {Range[]}
 */
export function widen(file, text, lines) {
  const sf = parse(file, text);
  /** @type {Range[]} */
  const ranges = [];
  for (const line of lines) ranges.push([line, line], ...unitsOf(sf, line));
  return mergeRanges(ranges);
}

// Tokens that carry no behaviour of their own: brackets and separators.
const STRUCTURE = new Set([
  ts.SyntaxKind.OpenBraceToken, ts.SyntaxKind.CloseBraceToken, ts.SyntaxKind.OpenParenToken, ts.SyntaxKind.CloseParenToken,
  ts.SyntaxKind.OpenBracketToken, ts.SyntaxKind.CloseBracketToken, ts.SyntaxKind.SemicolonToken, ts.SyntaxKind.CommaToken,
  ts.SyntaxKind.EndOfFileToken,
]);

/**
 * The lines that hold code: a token other than a bracket or a separator starts
 * on them or runs across them (a multi-line template). An else, try, finally
 * or do line holds code. Blank and comment-only lines are left out, and so is
 * a line of brackets and separators only, wherever it sits: what was taken out
 * of it (`}, 100);` made `});`), like a pure deletion, cannot be mutated.
 * @param {string} file
 * @param {string} text
 * @param {number[]} lines
 */
export function codeLines(file, text, lines) {
  const sf = parse(file, text);
  /** @param {number} pos */
  const lineOf = pos => sf.getLineAndCharacterOfPosition(pos).line + 1;
  /** @type {Set<number>} */
  const withCode = new Set();
  /** @param {ts.Node} node */
  const walk = node => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = node.getChildren(sf);
    if (children.length > 0) { children.forEach(walk); return; }
    if (STRUCTURE.has(node.kind) || node.getStart(sf) === node.getEnd()) return;
    for (let n = lineOf(node.getStart(sf)); n <= lineOf(node.getEnd() - 1); n++) withCode.add(n);
  };
  walk(sf);
  return lines.filter(line => withCode.has(line));
}

// Keywords that open the next part of a statement: a changed line holding one
// can move the lines beside it from one part to another. A default counts only
// in a switch, never in an export.
const PARTS = new Set([ts.SyntaxKind.ElseKeyword, ts.SyntaxKind.CaseKeyword, ts.SyntaxKind.DefaultKeyword, ts.SyntaxKind.CatchKeyword, ts.SyntaxKind.FinallyKeyword]);

/**
 * Whether a token opens or closes a block of statements or members: a body, a
 * switch's cases, a namespace, a class; never an object or a type.
 * @param {ts.Node} node
 */
const blockBrace = node => (node.kind === ts.SyntaxKind.OpenBraceToken || node.kind === ts.SyntaxKind.CloseBraceToken)
  && (ts.isBlock(node.parent) || ts.isCaseBlock(node.parent) || ts.isModuleBlock(node.parent) || ts.isClassLike(node.parent));

/**
 * The lines among `lines` that hold brackets and separators and nothing else,
 * a brace of a block (a header's `{`, a closer with code: `} while (x);`,
 * `}).catch(log);`), or an else, case, default, catch or finally. Such a line,
 * changed, can move the unchanged lines beside it into or out of a block, which
 * the gate does not gate (mutation/README.md), so the report names it, mutants
 * of its own or not.
 * @param {string} file
 * @param {string} text
 * @param {number[]} lines
 */
export function structureLines(file, text, lines) {
  const sf = parse(file, text);
  /** @param {number} pos */
  const lineOf = pos => sf.getLineAndCharacterOfPosition(pos).line + 1;
  /** @type {Set<number>} */
  const code = new Set();
  /** @type {Set<number>} */
  const brackets = new Set();
  /** @type {Set<number>} */
  const parts = new Set();
  /** @param {ts.Node} node */
  const walk = node => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = node.getChildren(sf);
    if (children.length > 0) { children.forEach(walk); return; }
    if (node.kind === ts.SyntaxKind.EndOfFileToken || node.getStart(sf) === node.getEnd()) return;
    const part = PARTS.has(node.kind) && (node.kind !== ts.SyntaxKind.DefaultKeyword || ts.isDefaultClause(node.parent));
    if (part || blockBrace(node)) parts.add(lineOf(node.getStart(sf)));
    const into = STRUCTURE.has(node.kind) ? brackets : code;
    for (let n = lineOf(node.getStart(sf)); n <= lineOf(node.getEnd() - 1); n++) into.add(n);
  };
  walk(sf);
  return lines.filter(line => parts.has(line) || (brackets.has(line) && !code.has(line)));
}

/**
 * The code lines among `lines` that no mutant lies wholly on. A mutant that
 * spans several lines (emptying a body, an object or an array, flipping a
 * condition split over lines, a chained call) counts for none of them: it says
 * nothing about each line it spans. A mutant on one line counts for that whole
 * line, as Stryker counts it. So the lines of a file taken whole are judged the
 * way the same lines changed alone are, and the list can name a line some
 * mutant reaches, but never leaves out one no mutant lies on.
 * @param {string} file
 * @param {string} text
 * @param {number[]} lines
 * @param {Range[]} spans each mutant's first and last line
 */
export function untouched(file, text, lines, spans) {
  return codeLines(file, text, lines).filter(n => !spans.some(([first, last]) => first === n && last === n));
}

/**
 * git arguments that name every file changed from base to the working tree,
 * over the whole repo (planChange names what it does not mutate): the names as
 * they are (-z), and a rename found by git's own measure with no limit on how
 * many files it compares (-M, -l0, whatever the user's config says). Only the
 * names come from here: the changed lines come from lineDiff.
 * @param {string} base
 */
export const changedArgs = base => ['diff', '--name-status', '-z', '-M', '-l0', '--ignore-submodules=none', '--no-relative', '--no-ext-diff', '--no-textconv', base, '--'];

/**
 * The target for a file's changed lines. `gating` lists them: a mutant that
 * touches one of them must be killed; the others in the widened ranges are
 * context, run and listed but never gating. A place where lines were taken out
 * with fewer or none put back widens its two neighbouring lines as context, and
 * `deleted` names it, for what was taken out is left nowhere to mutate. What
 * only those neighbours bring in (the emptying of a body around the changed
 * lines) stays context: a mutant gates only inside `own`, the ranges the changed
 * lines widen to by themselves. Null when the change leaves no line to mutate.
 * @param {string} file the name to mutate it under
 * @param {string} text
 * @param {{ changed: number[], deletedAfter: number[] }} change
 * @returns {Target | null}
 */
export function changeTarget(file, text, { changed, deletedAfter }) {
  const lineCount = text.split('\n').length;
  const neighbours = deletedAfter.flatMap(n => [n, n + 1]).filter(n => n >= 1 && n <= lineCount);
  const lines = [...new Set([...changed, ...neighbours])];
  if (lines.length === 0) return null;
  const ranges = widen(file, text, lines);
  return {
    file, ranges, gating: [...new Set(changed)].sort((a, b) => a - b), patterns: ranges.map(([start, end]) => `${file}:${start}-${end}`),
    ...(deletedAfter.length > 0 ? { deleted: deletedAfter, own: widen(file, text, changed) } : {}),
  };
}

/**
 * A file taken whole: every mutant in it gates.
 * @param {string} file
 * @returns {Target}
 */
export const wholeTarget = file => ({ file, ranges: null, gating: null, patterns: [file] });

/**
 * The mutate targets for a change, and every changed file it does not mutate,
 * with the reason. A file git names as changed gates its changed lines, found
 * against its text at the base (a rename's against its old name's). A file new
 * to the mutated code is taken whole: one added, an untracked one, and one
 * moved in from a name never mutated (outside src, a browser view, a file that
 * is not code). One moved out of the mutated code is named, as a deletion is.
 * A file that holds a line break Stryker counts and the diff does not is named
 * and not mutated (EXTRA_BREAK_WHY), and so is a file on the way to '/data'
 * (DATA_ROUTE_WHY), a git submodule (`isDir`: git
 * names only its commit), a file whose name Stryker would read as a glob
 * (`nameOf` gives null) and one whose name on disk, through a link, is not
 * mutated (a link in src to the suite's env scrub). `nameOf` gives the name a file is mutated under (its
 * name on disk, keys.mjs). emptyScope: nothing in src changed.
 * @param {{ entries: Entry[], untracked: string[], read: (file: string) => string, readBase: (file: string) => string,
 *   nameOf: (file: string) => string | null, isDir?: (file: string) => boolean }} change
 * @returns {{ targets: Target[], skipped: { file: string, why: string }[], emptyScope: boolean }}
 */
export function planChange({ entries, untracked, read, readBase, nameOf, isDir = () => false }) {
  /** @type {Target[]} */
  const targets = [];
  /** @type {{ file: string, why: string }[]} */
  const skipped = [];
  for (const entry of entries) {
    if (entry.status === 'D') { skipped.push({ file: entry.file, why: 'deleted: nothing is left to mutate' }); continue; }
    if (isDir(entry.file)) { skipped.push({ file: entry.file, why: 'a git submodule: git names only its commit, so none of its files is mutated' }); continue; }
    const why = notMutated(entry.file);
    if (why) {
      skipped.push({ file: entry.file, why });
      if (entry.from !== undefined && notMutated(entry.from) === null) skipped.push({ file: entry.from, why: `moved to ${entry.file}: nothing is left to mutate` });
      continue;
    }
    const name = nameOf(entry.file);
    if (name === null) { skipped.push({ file: entry.file, why: GLOB_NAME_WHY }); continue; }
    if (notMutated(name)) { skipped.push({ file: entry.file, why: linkWhy(name) }); continue; }
    const text = read(entry.file);
    if (holdsExtraBreak(text)) { skipped.push({ file: entry.file, why: EXTRA_BREAK_WHY }); continue; }
    if (holdsDataRoute(entry.file, text)) { skipped.push({ file: entry.file, why: DATA_ROUTE_WHY }); continue; }
    const before = entry.status === 'A' || entry.status === 'C' ? null : entry.from ?? entry.file;
    if (before === null || notMutated(before) !== null) { targets.push(wholeTarget(name)); continue; }
    const target = changeTarget(name, text, lineDiff(readBase(before), text));
    if (target) targets.push(target);
    else skipped.push({ file: entry.file, why: 'no changed lines (a rename, a mode change, or line endings only)' });
  }
  for (const file of untracked) {
    if (file.startsWith('src/') && file.endsWith('/')) {
      skipped.push({ file, why: 'an untracked git repository: git lists none of its files, so none is mutated' });
      continue;
    }
    const why = notMutated(file);
    const name = why ? null : nameOf(file);
    if (why) skipped.push({ file, why });
    else if (name === null) skipped.push({ file, why: GLOB_NAME_WHY });
    else if (notMutated(name)) skipped.push({ file, why: linkWhy(name) });
    else if (holdsExtraBreak(read(file))) skipped.push({ file, why: EXTRA_BREAK_WHY });
    else if (holdsDataRoute(file, read(file))) skipped.push({ file, why: DATA_ROUTE_WHY });
    else targets.push(wholeTarget(name));
  }
  /** @param {string | undefined} file */
  const inSrc = file => file !== undefined && file.startsWith('src/');
  return { targets, skipped, emptyScope: !entries.some(entry => inSrc(entry.file) || inSrc(entry.from)) && !untracked.some(inSrc) };
}

export const GLOB_NAME_WHY = 'its name holds characters Stryker reads as a glob, so it cannot be given to Stryker; rename it';

/**
 * Why a file in src is not mutated when its name leads, through a link, to a
 * file that is not (the suite's own env scrub, say).
 * @param {string} name the name on disk
 */
const linkWhy = name => `a link to ${name}, which is not mutated: ${notMutated(name)}`;

/**
 * planChange on what git says changed from base to the working tree of the bot
 * root `root`: `git` runs git there and returns what it printed, and `read`
 * gives a file's text. Each file is mutated under the name it has on disk
 * (keys.mjs), which Stryker matches: a file renamed by case outside git too.
 * git does not look at every file: not at one its index marks assume-unchanged
 * or skip-worktree (core.ignoreStat marks every file it adds), not at one a
 * file-system monitor says is unchanged, and not at one whose cached stat
 * still holds (its size and whole-second mtime, and its ctime, which on
 * Windows is when the file was made), so a same-size edit whose time was set
 * back shows in no diff. So every tracked file git did not name is checked by
 * its content: one gone is deleted, unless skip-worktree left it out (a sparse
 * checkout), and one hashed as git add would that differs from its index blob
 * (for a file git did not name, the base's) is changed.
 * @param {{ git: (...args: string[]) => string, base: string, root: string, read?: (file: string) => string }} io
 */
export function planFromGit({ git: run, base, root, read = file => fs.readFileSync(path.join(root, file), 'utf8') }) {
  /** @param {string[]} args */
  const git = (...args) => run('-c', 'core.fsmonitor=false', ...args);
  /** @param {string} file */
  const readBase = file => git('cat-file', 'blob', `${base}:${file}`);
  /** @param {string} file */
  const isFile = file => { try { return fs.statSync(path.join(root, file)).isFile(); } catch { return false; } };
  const entries = parseNameStatus(git(...changedArgs(base)));
  const listed = new Set(entries.flatMap(entry => [entry.file, entry.from]));
  const sparse = new Set(git('ls-files', '-v', '-z').split('\0').filter(line => /^[sS] /.test(line)).map(line => line.slice(2)));
  /** @type {{ blob: string, file: string }[]} */
  const staged = [];
  for (const line of git('ls-files', '-s', '-z').split('\0')) {
    const m = /^10(?:0644|0755) ([0-9a-f]+) 0\t(.+)$/s.exec(line);
    if (!m || listed.has(m[2])) continue;
    if (isFile(m[2])) staged.push({ blob: m[1], file: m[2] });
    else if (!fs.existsSync(path.join(root, m[2])) && !sparse.has(m[2])) entries.push({ status: 'D', file: m[2] });
  }
  // In batches, as a command line has a length limit (32767 characters on Windows).
  for (let start = 0; start < staged.length;) {
    let end = start;
    for (let length = 0; end < staged.length && (end === start || length + staged[end].file.length < 8000); end++) length += staged[end].file.length + 1;
    const batch = staged.slice(start, end);
    const blobs = git('hash-object', '--', ...batch.map(s => s.file)).split('\n');
    batch.forEach((s, i) => { if (blobs[i] !== s.blob) entries.push({ status: 'M', file: s.file }); });
    start = end;
  }
  return planChange({
    entries,
    untracked: git('ls-files', '-z', '--others', '--exclude-standard').split('\0').filter(Boolean),
    read,
    readBase,
    nameOf: file => canonicalName(root, file) ?? (globFree(root, file) ? file : null),
    isDir: file => { try { return fs.statSync(path.join(root, file)).isDirectory(); } catch { return false; } },
  });
}

/**
 * What Stryker copies into a sandbox, as its ignorePatterns: everything left
 * out, then each of `files` let back in, so a sandbox holds those files and
 * nothing else (node_modules aside, which Stryker links, so a file git tracks
 * inside one is never let in over the link). Given the files the
 * gate fingerprints (tracked, or untracked and not ignored), no file git
 * ignores (.env, data dirs, dist), none of an untracked repository or a
 * submodule (git lists the dir only, and a dir lets nothing in), and none made
 * after the list is ever copied. Each name is escaped as Stryker's matcher
 * reads a pattern; one whose pattern still does not match it (on POSIX, a name
 * holding a backslash and a brace) is `unkept`, and the gate stops rather than
 * run without it.
 * @param {string[]} files from the bot root, with forward slashes; a dir ends in '/'
 * @returns {{ patterns: string[], unkept: string[] }}
 */
export function sandboxPatterns(files) {
  const options = { dot: true, flipNegate: true, nocase: true };
  const patterns = ['/**'];
  /** @type {string[]} */
  const unkept = [];
  for (const file of files) {
    if (file.endsWith('/') || file.split('/').includes('node_modules')) continue;
    const pattern = `!/${escape(file, { magicalBraces: true })}`;
    if (new Minimatch(pattern, options).match(`/${file}`)) patterns.push(pattern);
    else unkept.push(file);
  }
  return { patterns, unkept };
}

/**
 * Whether Stryker can be given a file under this name: it reads a mutate
 * pattern as a glob, refuses one with lines when it holds a glob, and matches
 * files to it with minimatch, so the name must hold no glob and match itself.
 * @param {string} root
 * @param {string} file
 */
function globFree(root, file) {
  const name = path.resolve(root, file).split(path.sep).join('/');
  return !new Minimatch(name).hasMagic() && minimatch(name, name, { dot: true });
}

/**
 * Whether Stryker can match any file under the bot root, read as it reads one:
 * it resolves each mutate pattern against the root, turns backslashes into
 * slashes and matches the whole path, read as a glob, with minimatch. A root
 * that does not match itself so (a [ ] class, a { } with a comma or a range,
 * an extglob such as +( ), or a pattern minimatch cannot read and throws on)
 * matches no file, and nothing is mutated.
 * @param {string} root
 */
export function rootGlobFree(root) {
  const name = path.resolve(root, 'package.json').replace(/\\/g, '/');
  try {
    return minimatch(name, name, { dot: false });
  } catch {
    return false;
  }
}

/**
 * The lines a target answers for: its changed lines, or for a whole file or a
 * --mutate pattern, every line it covers.
 * @param {{ gating: number[] | null, patterns: string[] }} target
 * @param {number} lineCount
 * @returns {number[]}
 */
export function linesOfTarget(target, lineCount) {
  if (target.gating !== null) return target.gating;
  const lines = new Set();
  for (const pattern of target.patterns) {
    const range = /:(\d+)-(\d+)$/.exec(pattern);
    const [from, to] = range ? [Number(range[1]), Math.min(Number(range[2]), lineCount)] : [1, lineCount];
    for (let n = from; n <= to; n++) lines.add(n);
  }
  return [...lines].sort((a, b) => a - b);
}

/**
 * Whether a mutant (1-based lines, as Stryker reports them) lies within the
 * lines a --mutate pattern names (anywhere, when it names the whole file), as
 * Stryker decides it for a pattern of lines.
 * @param {string} pattern
 * @param {Location} location
 */
export function inPattern(pattern, location) {
  const range = /:(\d+)-(\d+)$/.exec(pattern);
  return !range || (Number(range[1]) <= location.start.line && location.end.line <= Number(range[2]));
}

/**
 * The --mutate patterns that made no mutant, each judged on its own lines, so
 * one beside another pattern on the same file is still named.
 * @param {{ file: string, patterns: string[], gating: number[] | null }[]} targets
 * @param {{ file: string, location: Location }[]} mutants
 */
export const unmatchedPatterns = (targets, mutants) => targets
  .filter(target => target.gating === null)
  .flatMap(target => target.patterns.filter(pattern => !mutants.some(m => m.file === target.file && inPattern(pattern, m.location))));

/**
 * Whether a mutant (1-based lines, as Stryker reports them) touches a gating
 * line and, for a target that holds `own`, lies inside one of those ranges.
 * @param {{ gating: number[] | null, own?: Range[] }} target
 * @param {Location} location
 */
export function gates(target, location) {
  if (target.gating === null) return true;
  const own = target.own;
  return target.gating.some(n => location.start.line <= n && n <= location.end.line)
    && (!own || own.some(([start, end]) => start <= location.start.line && location.end.line <= end));
}
